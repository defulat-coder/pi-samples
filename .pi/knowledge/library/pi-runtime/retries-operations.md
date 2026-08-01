---
type: concept
title: 中止与重试：验证与运维视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。模型重试、工具失败、客户端断开和最终收敛的处理策略
resource: .pi/knowledge/library/pi-runtime/retries-operations.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, retries, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: retries
variant: operations
---

# Pi Agent 运行时中止与重试策略：验证与运维视角

## 摘要与问题边界

Pi Agent 运行时的中止与重试处理不仅涉及“让请求再试一次”，而是要在模型推理、工具执行、网络传输和客户端生命周期之间建立一套可验证的收敛路径。本文聚焦四个核心场景：模型调用在出现 transient 失败时如何重试，工具调用在超时或异常后如何返回结构化失败，客户端在 SSE 流中途断开时如何安全中止，以及最终如何生成一个可被重新加载或审计的收敛点。讨论范围限定于 `apps/api`、`packages/pi-agent` 与 `apps/web` 的边界内，不包含业务层的语义路由或外部密钥管理。所有判断以可观测事件、状态快照和配置值为准，而非单次成功请求的体感。

## 核心概念与数据模型

1. **AgentSession**：一个会话实例封装了模型运行时的完整生命周期。它持有 prompt 上下文、工具注册表、当前重试计数器和未完成的 token 流。会话状态只能在 `message_update`、`tool_execution_*`、`lifecycle` 或 `retry_event` 中向前推进，不能由外部直接修改。

2. **ModelRuntime**：运行配置对象，包含 `maxRetries`、`baseBackoffMs`、`maxBackoffMs`、`jitter` 和 `thinkingLevel`。它把模型调用错误分类为可重试（如 5xx、ECONNRESET、超时）、客户端错误（如 4xx、无效参数）或内容错误（如格式错误但可重试的解析失败）。

3. **Event Envelope**：所有事件通过统一信封序列化，字段包括 `event_id`、`session_id`、`type`、`payload` 和 `timestamp`。其中 `message_update` 的 payload 必须携带 `delta_type`（`text_delta`、`thinking_delta`、`toolcall_*` 等），`tool_execution_update` 携带 `tool_call_id` 和 `status`。

4. **SessionManager.inMemory()**：当前 Web  playground 使用的内存注册表，保存从 `session_id` 到 `AgentSession` 的引用。它负责在创建时注册、在 dispose 时清理、在连接断开时标记 `pending_disconnect`，并提供 `get()` 用于审计但禁止外部状态写入。

5. **Tool Outcome Taxonomy**：每个工具调用结果必须返回 `{ ok, content, details }` 或 `{ ok, error, recoverable }`。其中 `recoverable` 区分“失败可被模型继续处理”与“必须终止整条会话”。`search_knowledge` 和 `read` 均为只读，因此不会触发副作用回滚。

6. **Convergence Checkpoint**：收敛点包含最后一条完整 assistant 文本、已执行工具调用的列表与结果、未完成的 `tool_call_id` 集合、当前 token 计数以及模型运行时的配置哈希。该快照在 `session_end` 或 `retry_exhausted` 时写入，用于后续重载或故障定位。

## 设计决策与取舍

**订阅先于调用**。`packages/pi-agent` 要求在使用 `session.prompt()` 之前完成所有事件订阅。这确保即使是重试事件也能被观察者捕获，代价是事件顺序的强依赖；如果订阅延迟，会丢失前几条 delta 或重试元数据。

**思考级别与真实 thinking delta 的解耦**。`thinkingLevel` 是配置项，但模型是否真正输出 `thinking_delta` 取决于 provider。因此运行时不能把 `thinkingLevel > 0` 等同于存在思考证据，必须只记录实际收到的 delta 类型。

**内存注册表与无状态横向扩展**。`SessionManager.inMemory()` 满足单进程 playground，但不支持多实例负载均衡。若将来横向扩展，需要把注册表替换为共享存储，并引入会话亲和或持久化快照加载机制。

**只读工具面与能力边界**。项目只暴露 `read` 和 `search_knowledge`，避免写入工具带来的副作用风险。结果是所有工具失败都不需要回滚，但模型也必须依赖现有知识进行自我修正。

**重试策略的延迟与成本权衡**。模型调用采用指数退避加抖动，最多 `maxRetries` 次。这降低瞬态故障率，但会拉高 P99 延迟；超过最大次数后必须标记为失败，而不是无限制重试，以防止容量雪崩。

**能力注入在 API 层完成**。API 进程持有 provider 密钥并构造 `ModelRuntime`，Web 只消费 SSE。这种边界让浏览器不接触凭证，也使重试逻辑可集中在 API 进程内被统一观测和限流。

## 可执行实施流程

1. 在 `packages/pi-agent` 的入口初始化 `DefaultResourceLoader`，传入项目根目录，加载 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`。

2. 使用 `SessionManager.inMemory()` 创建注册表，并设定会话最大存活时间和断开后的 TTL。

3. 根据 `ModelRuntime` 配置创建 `AgentSession`，把 `thinkingLevel` 作为独立可观察字段保存。

4. 在调用 `session.prompt()` 之前，先订阅所有事件通道，包括 `message_update`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`lifecycle`、`retry_event` 和 `error`。

5. 实现 SSE 序列化器，将事件信封转换为 JSON 行，并在每个 chunk 末尾添加换行，确保客户端可以按流解析。

6. 在工具执行层统一设置超时（例如 30 秒）和取消信号，返回结构化结果；对 `search_knowledge` 只读失败，设置 `recoverable=true`。

7. 在模型调用层包装重试逻辑：识别可重试错误、递增重试计数、按指数退避等待，并在每次重试时 emit `retry_event`。

8. 检测客户端断开：监听 `res.on('close')` 或 `AbortSignal`，触发 `session.unsubscribe()` 和 `SessionManager.pendingDisconnect(session_id)`，等待 TTL 后彻底 `dispose()`。

9. 在收敛点生成逻辑中，收集最后完整 assistant 文本、已执行工具调用结果、未完成工具调用集合和 token 计数，输出 `convergence_checkpoint` 事件。

10. 通过重放脚本和单元测试验证：构造 provider 失败、工具超时、客户端断开三种场景，断言事件序列和收敛点字段完整。

## 收敛点快照示例

以下 JSON 示例展示一次会话在中断后的可重载状态。输入是 `AgentSession` 在运行中收集的内部状态；处理逻辑是将其中的文本、工具调用、未决调用和运行时配置哈希化；输出是 `convergence_checkpoint` 事件，可被 `SessionManager` 重新加载。

<pre>
{
  "event_id": "ev_3a9f1c",
  "session_id": "sess_7e2b",
  "type": "convergence_checkpoint",
  "timestamp": "2026-08-12T09:14:22.003Z",
  "payload": {
    "assistant_text": "已根据本地文件知识库回答。",
    "tool_results": [
      {
        "tool_call_id": "call_01",
        "name": "search_knowledge",
        "status": "success",
        "content": { "matches": 2 }
      }
    ],
    "pending_tool_calls": [],
    "token_count": 142,
    "runtime_config_hash": "a3f7e2..."
  }
}
</pre>

该示例输入来自 `AgentSession` 的当前上下文；处理过程由 `packages/pi-agent` 的收敛检查点生成器执行；输出被写入 SSE 流并可供审计或重载。

## 性能、质量与可观测性指标

1. **首 token 延迟**：从 `session.prompt()` 到首个 `message_update` 的时间，按 P50、P99 分位记录。测量方式是在 API 层记录 `prompt_start` 与首个 delta 的时间差。

2. **重试次数分布**：统计每次会话中 `retry_event` 出现次数，按 0、1、2、…、`maxRetries` 分布。高重试次数提示 provider 不稳定或退避参数需要调整。

3. **工具失败率**：按工具名聚合 `tool_execution_end` 中 `status != success` 的比例。对于 `read` 和 `search_knowledge`，只读失败不应导致会话终止。

4. **客户端断开率与清理滞后**：记录 `pending_disconnect` 到 `dispose` 的时间，如果超过 TTL 则告警，防止内存泄漏。

5. **收敛点完整率**：统计 `session_end` 或 `retry_exhausted` 事件中是否包含完整 `convergence_checkpoint`。缺失 assistant_text 或 pending_tool_calls 未清空都应视为不完整。

6. **端到端成功率**：定义为最终交付完整文本且无未决工具调用的会话比例，应区分成功重试收敛与一次通过成功。

## 失败模式、诊断证据与恢复动作

1. **Provider 瞬态错误**。证据：状态码 5xx、ECONNRESET、ETIMEDOUT 或 `retry_event` 计数递增。恢复：指数退避重试，达到 `maxRetries` 后触发 `retry_exhausted`，返回包含收敛点的失败信封。

2. **工具执行超时**。证据：`tool_execution_update` 中 `status=timeout` 且时间戳超过设定阈值。恢复：中止底层请求，返回 `recoverable=true` 的结构化失败，允许模型决定重试或换工具。

3. **客户端中途断开**。证据：SSE 连接关闭或 `AbortSignal` 触发。恢复：标记会话为 `pending_disconnect`，等待 TTL 后 `dispose()`，避免在客户端已离开时继续消耗 token。

4. **模型输出无效 tool call**。证据：`toolcall_invalid` 或 JSON 解析失败，且同一 `tool_call_id` 多次出现。恢复：将错误作为观察项返回给模型，允许最多三次自校正；超过次数则终止并保留收敛点。

5. **重试耗尽**。证据：重试计数达到 `maxRetries` 且仍无成功响应。恢复：不再调用 provider，立即发出最终失败事件，保留已生成内容以便用户重载。

6. **资源加载信任失败**。证据：`DefaultResourceLoader` 返回 trust denied。恢复：降级到最小上下文（只加载 `AGENTS.md`），记录失败，不阻止会话启动。

## 问答测试样例

1. **正向**：模型调用因网络抖动重试一次后成功，如何确认该过程被完整记录？
   期望：必须出现 `retry_event` 计数为 1，随后出现 `message_update` 文本，且最终 `convergence_checkpoint` 包含结果。

2. **边界**：`maxRetries` 为 3，第 3 次重试成功，后续事件是否继续？
   期望：继续，只要未超出计数且未触发断开，重试成功后恢复 delta 流。

3. **边界**：`thinkingLevel=1` 但 provider 未输出 `thinking_delta`，结论是什么？
   期望：不能推断模型没有思考，只能记录未收到 thinking delta。

4. **边界**：`search_knowledge` 在 30 秒内无响应，如何处理？
   期望：工具层超时，返回 `recoverable=true` 的失败结果，并 emit `tool_execution_update`。

5. **无证据**：某次会话延迟很高，但没有任何 `retry_event`，能否断言是模型推理慢？
   拒答条件：不能，缺少 provider 内部推理时间证据，只能归因于“首 token 延迟高”，原因未知。

6. **无证据**：客户端未收到完整响应，是否可以推断服务端已放弃会话？
   拒答条件：不能，必须检查 `pending_disconnect` 与 `dispose` 事件；如果只有 SSE 关闭，只能说明传输层关闭，运行时不一定已终止。

## 维护、版本、来源与相邻主题关系

当前实现依赖 `@earendil-works/pi-coding-agent` SDK 的 `AgentSession`、`DefaultResourceLoader` 和 `defineTool()` 接口。配置来源包括 `AGENTS.md` 与 `.pi/` 下的资源文件。`pnpm-lock.yaml` 锁定 SDK 版本，升级时必须重新运行 `pnpm typecheck` 和 `pnpm test`，因为 SDK 重试事件格式可能在补丁版本间调整。

相邻主题中，“会话生命周期”负责创建、订阅和 dispose；“工具安全”负责只读能力限制；“模型运行时”负责 provider 选择与 thinking 配置；“SSE 传输”负责事件序列化和客户端连接状态。本文的中止与重试策略位于这些主题的交汇点，修改重试参数时必须同步更新 `SessionManager` 的 TTL 和 SSE 序列化器。

## 结论

**事实**：`AgentSession` 提供事件驱动的会话生命周期；`ModelRuntime` 承载 `maxRetries`、`baseBackoffMs` 和 `thinkingLevel`；`SessionManager.inMemory()` 管理当前会话引用；项目只暴露 `read` 和 `search_knowledge` 两个只读工具；收敛点包含 assistant 文本、工具结果、未决调用、token 计数和配置哈希。

**推论**：基于内存注册表和只读工具，当前失败恢复成本较低，因为无需回滚副作用；但内存注册表限制了多实例部署，未来若要横向扩展需要引入持久化收敛点。

**未知**：provider 在 thinking 关闭时的内部延迟分布、网络抖动与真实 provider 5xx 的比例、以及大并发下重试风暴对 token 配额的影响，均未包含在本项目当前可观测范围内，需要通过生产级日志采样和 provider 级别的 metrics 进一步验证。
