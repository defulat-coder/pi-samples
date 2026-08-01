---
type: concept
title: Session 状态：架构视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。多轮会话、历史消息、恢复和并发请求之间的状态一致性
resource: .pi/knowledge/library/pi-runtime/state-architecture.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, state, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: state
variant: architecture
---

# Pi Agent 运行时 Session 状态：多轮一致性、恢复与并发边界

## 摘要与问题边界

Session 状态是 Pi Agent 运行时在多轮交互中的核心事实来源，但它不是聊天 UI 的本地记录，也不是浏览器连接状态的同义词。本视角将其限定为：API 进程内由 `AgentSession`、`ModelRuntime`、`SessionManager` 与项目资源共同维护、可被恢复、受并发控制保护的运行时上下文。需要解决的真实问题包括：多轮历史消息的单调追加与顺序保证、同一 Session 上并发 `prompt` 请求的竞态隔离、API 进程崩溃或连接断开后如何恢复到一致边界、以及工具调用副作用与 Session 内部状态之间的责任划分。超出本视角边界的内容有：模型权重内部 KV 缓存的持久化、浏览器端本地存储的离线编辑、以及非只写工具的副作用管理。

## 核心概念与数据模型

1. **Session Identity（会话身份）**：由 `apps/api` 在创建时生成稳定 ID（如 `sess_abc123`），与瞬态 SSE 连接解耦。客户端重连时只需携带该 ID，不必重建运行时上下文。
2. **Message History（历史消息）**：严格追加的有序列表，条目类型限定为 `system`、`user`、`assistant`、`tool_result`。每条消息携带单调递增的 `sequence` 与客户端幂等键 `request_id`，用于重试去重与顺序校验。
3. **Runtime Context（运行时上下文）**：包含 `ModelRuntime` 实例、`DefaultResourceLoader` 快照、可用工具注册表以及当前 `thinkingLevel` 等配置。该上下文在创建 Session 时固化，后续同一 Session 的执行均基于这份快照，保证可复现性。
4. **Execution Window（执行窗口）**：单次 `prompt` 运行期间产生的在途状态，包括 token 流 deltas、thinking deltas、已调度但未完成的 tool call、以及等待确认的中间产物。窗口状态随 SSE 事件同步，但不在持久化 checkpoint 中保留。
5. **Snapshot / Checkpoint（快照与检查点）**：在 assistant 消息完成、且所有 tool result 已落盘后的“静止边界”上生成的轻量快照。它保存历史消息、Runtime Context 元数据与 `checkpoint_epoch`，不保存模型内部缓存。
6. **Single-Writer Lock（单写者控制）**：每个 Session 同一时刻只允许一个活跃 `prompt`。并发请求进入 FIFO 队列，或根据策略直接返回 `423 Locked`/`409 Conflict`。读历史等只读操作可绕过该锁。
7. **Registry Entry（注册表项）**：`SessionManager.inMemory()` 维护的 `id -> {session, subscription, lock, checkpoint}` 映射，负责生命周期、事件订阅取消与垃圾回收。

## 设计决策与取舍

### 单会话单写者与请求队列

决策：强制每个 Session 同一时刻只能运行一个 `prompt`，第二个请求必须排队或被拒绝。理由是大语言模型的上下文上下文是顺序消费资源，交错输出会破坏历史一致性。例外：获取历史消息、检查健康状态等只读操作允许并发执行，但不得修改历史。

### Append-only 历史与 Fork 修正

决策：历史消息一旦落盘不可删除或原地编辑。若用户需要“改写” earlier context，应通过 Fork 创建新 Session，并复制截止到某 `checkpoint_epoch` 的历史前缀。边界：thinking deltas、流式 token 等中间产物不属于历史消息，不会被持久化。

### 内存 Registry 与显式 Checkpoint

当前 Web playground 使用 `SessionManager.inMemory()`，因此 API 进程重启会丢失未快照的执行窗口。恢复依赖显式 checkpoint 与客户端重连，不依赖 provider 保留任何状态。若未来需要跨进程恢复，应替换 Registry 实现，而不是在内存模型中加入隐式持久化。

### API 进程全状态与浏览器无状态

所有 provider key、运行时上下文、工具执行逻辑均保留在 `apps/api` 与 `packages/pi-agent` 中；`apps/web` 只消费 SSE 事件流，永不持有凭证或模型客户端。边界：浏览器端只保留 `session_id` 与已渲染消息，不负责状态恢复。

### 能力快照与只读工具约束

每个 Session 创建时固化一份工具注册表快照。当前项目仅暴露 `read` 与 `search_knowledge` 两个只读工具，避免工具副作用导致状态不可复现。未来新增 skill 时，旧 Session 仍使用旧快照，新 Session 才加载新工具，防止运行中途能力漂移。

## 可执行实施流程

1. 在 `packages/contracts` 中定义 Session DTO、事件 envelope、`checkpoint_epoch` 与 `schema_version`。
2. `apps/api` 的 `POST /sessions` 生成稳定 `session_id`，并在 `SessionManager.inMemory()` 中注册条目。
3. 使用项目 `cwd` 构造 `DefaultResourceLoader`，加载 `.pi/skills`、`.pi/prompts`、`AGENTS.md` 等官方资源；`.pi/knowledge` 通过 `search_knowledge` 在运行时按需读取，不预加载。
4. 调用 `createAgentSession(ModelRuntime, resourceLoader)`，并在任何 `session.prompt()` 之前完成事件订阅。
5. 在 `packages/pi-agent` 中为 Session 加单写者锁：获取成功则执行 `prompt`，否则将请求入队或返回 `423`。
6. 将 Pi SDK 的 `message_update`、`thinking_delta`、`tool_execution_*` 等事件规范化为 API SSE 事件，并注入 `sequence` 与 `checkpoint_epoch`。
7. 每次 assistant 消息完整落盘且 tool result 全部返回后，生成 checkpoint，存入以 `session_id` 为键的临时存储。
8. 连接关闭或 Session 超时时，取消在途执行、取消订阅、释放锁、从 Registry 移除，并记录 dispose 事件。

## 本地文件知识库与 Session 初始化示例

<pre>
# apps/api/sessions/sess_abc123.yaml
session:
  id: sess_abc123
  checkpoint_epoch: 7
  schema_version: "2026-01"
  resource_loader:
    cwd: /Users/xbjt/Documents/myself/pi-samples
    paths:
      - .pi/skills
      - .pi/prompts
      - AGENTS.md
  tools_snapshot:
    - read_file
    - search_knowledge
  history:
    - role: system
      content: "You are a Pi coding agent..."
    - role: user
      content: "解释 Session 状态"
      request_id: req_u1
    - role: assistant
      content: "Session 状态是运行时事实来源..."
</pre>

**输入**：客户端向 `POST /sessions/sess_abc123/prompt` 发送请求，携带 `request_id: req_u1` 与用户消息。
**处理**：API 先检查单写者锁，成功后再调用 `AgentSession.prompt()`；`DefaultResourceLoader` 根据 `cwd` 加载项目资源，`search_knowledge` 按需检索 `.pi/knowledge` 中的 Markdown 片段。
**输出**：服务端推送 SSE 事件流，包含 `message_update` 文本增量、`thinking_delta` 以及 tool 事件，最终完成一次 `checkpoint_epoch` 递增并落盘。

## 性能、质量与可观测性指标

| 指标 | 含义 | 测量方式 |
|---|---|---|
| 首 token 时间（TTFT） | 请求到达至首个 SSE 数据块的时间 | API 路由入口到首事件，Prometheus histogram |
| 历史顺序正确率 | `sequence` 是否单调无重复 | 定时对 `history` 做 checksum 与序列扫描 |
| 并发冲突率 | 被拒绝或排队的请求比例 | 统计 `423`/`409` 响应数除以总 prompt 数 |
| 恢复时间（RTO） | API 重启后到可继续对话的时间 | 注入人为崩溃，测量 checkpoint reload 耗时 |
| 单会话内存占用 | 每个 Session 在 Registry 中的 retained heap | Node.js heap snapshot 采样 |
| 工具调用幂等通过率 | 相同 `request_id` 重复触发时结果一致率 | 压测重放并比对 tool result hash |

## 失败模式、诊断证据与恢复动作

1. **并发覆盖**：服务端日志中在同一 Session 出现两个 `execution_start` 而未对应 `execution_end`；恢复动作是排队或返回 `423`，并记录后入请求。
2. **重试导致重复消息**：`history` 中出现相同 `request_id` 或重复 `sequence`；恢复动作是在追加前按 `request_id` 去重，返回已缓存结果。
3. **Checkpoint 滞后**：恢复后模型再次请求已经执行过的 tool；诊断证据是 tool call 参数与已完成条目完全一致；恢复动作是只从最后一个完整 assistant 消息边界恢复，避免半成 checkpoint。
4. **SSE 断开但执行继续**：Session 状态已为 `completed`，而浏览器仍显示 `pending`；恢复动作是客户端重连后调用 `GET /sessions/{id}/history` 拉取 diff。
5. **能力快照漂移**：新 skill 已安装但旧 Session 的工具列表未更新；诊断证据是 `tools_snapshot` 与 `.pi/skills` 最新内容不一致；恢复动作是为新对话创建新 Session。
6. **资源加载路径失效**：`cwd` 变更后 `DefaultResourceLoader` 找不到 `AGENTS.md`；恢复动作是重新构造 loader 并更新 Registry 中的快照引用。

## 问答测试样例

1. **正向**：Pi Agent 运行时中的 Session 状态由哪些层组成？
   答：身份、历史消息、运行时上下文、执行窗口、单写者锁、注册表项与快照。
2. **边界**：两个客户端同时向同一 Session 发送 prompt 会怎样？
   答：受单写者锁保护，第二个请求进入队列或收到 `423/409`；该行为由 `SessionManager` 与 API 路由共同保证。
3. **边界**：可以删除或修改历史中的某一轮对话吗？
   答：不可以。历史为 append-only；如需修正上下文，应 Fork 新 Session。
4. **无证据**：当前实现是否支持跨浏览器标签页共享同一个 Session？
   答：`SessionManager.inMemory()` 仅在单个 API 进程内有效，不能跨浏览器共享；除非引入外部存储，否则不应声称支持。
5. **无证据**：`SessionManager.inMemory()` 的默认 TTL 是多少？
   答：项目文档未声明该值，无法回答，应视为未定义。
6. **边界**：恢复 Session 时工具的外部副作用是否会被恢复？
   答：不会。Session 只恢复自身状态，工具副作用由外部系统保证幂等；必要时用 `request_id` 重放。

## 维护、版本、来源与相邻主题

- **来源与依据**：本主题直接受 `AGENTS.md`、`packages/pi-agent` 实现、`packages/contracts` DTO、Pi 官方 SDK 文档以及 `.pi/skills`、`.pi/prompts`、`.pi/knowledge` 资源结构约束。
- **版本管理**：Session 状态 schema 应在 `schema_version` 字段中显式声明；事件 envelope 与 checkpoint 结构向后兼容，破坏性变更必须触发迁移逻辑。
- **维护重点**：定期检查 `SessionManager` 内存泄漏、单写者锁死锁、资源加载路径漂移、checkpoint 体积膨胀。
- **相邻主题关系**：向上衔接 `apps/api` 的 Transport/SSE 与身份路由；向下依赖 `ModelRuntime` 与 `DefaultResourceLoader`；横向与 Tool Capabilities、Observability 以及 `.pi/knowledge` 检索共同构成完整 Agent 运行时。

## 结论

- **事实**：本项目通过 `packages/pi-agent` 使用 `createAgentSession` 与 `SessionManager.inMemory()`；`apps/api` 持有完整运行时状态，`apps/web` 仅消费 SSE；只暴露 `read` 与 `search_knowledge` 两个只读工具。
- **推论**：单写者锁与 append-only 历史能在不引入分布式事务的前提下，显著降低多轮、并发场景下的状态不一致风险；将 provider key 与运行时上下文保留在 API 进程，是满足安全边界的合理设计。
- **未知**：Pi 模型 provider 内部 token 缓冲与 KV 缓存的持久化语义未公开；浏览器端重连后拉取历史 diff 的具体分页策略、以及跨进程 Session 共享所需的存储选型，尚未在当前项目中定义，需后续根据真实负载与运维需求决策。
