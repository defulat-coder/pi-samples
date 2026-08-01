---
type: concept
title: Session 生命周期：验证与运维视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。从资源加载、创建 session、提交 turn 到关闭的状态变化
resource: .pi/knowledge/library/pi-runtime/session-operations.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, session, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: session
variant: operations
---

# Pi Agent Session 生命周期：从资源加载到关闭的状态演进与运维证据

本文记录 Pi Agent 运行时在 Web 触发场景下，一个 Session 从资源加载、创建、提交 Turn 到关闭的完整状态变化。视角聚焦验证与运维，目标读者为需要观察性能、稳定性和故障恢复的后端工程师。范围限定在本项目可验证的 TypeScript 实现与 Pi SDK 调用契约，不讨论底层模型提供商的内部排队机制或网络基础设施细节。

## 摘要与问题边界

一个 Pi Session 不是简单的请求-响应对象，而是由资源加载器、会话注册表、运行时绑定、事件订阅和生命周期钩子共同维持的有状态上下文。运维视角下，Session 的核心风险集中在三点：初始化时资源加载是否原子、事件订阅与 prompt 提交的时序是否合规、关闭时订阅和底层句柄是否被完全释放。本文的边界是 `apps/api`、`apps/web`、`packages/pi-agent` 和 `packages/contracts` 之间的交互，不涵盖浏览器端状态管理或模型提供商的账单审计。

## 核心概念与数据模型

1. **DefaultResourceLoader**：以项目 `cwd` 为锚点，加载 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`。初始化失败会导致整个 Session 无法创建，属于启动路径上的硬依赖。
2. **SessionManager**：`SessionManager.inMemory()` 维护当前 Web 进程的会话注册表。会话标识在运行时是内存级映射，进程重启后全部丢失，这是容量与恢复设计的关键约束。
3. **AgentSession**：由 `createAgentSession()` 创建，绑定 `ModelRuntime` 和工具集合。Session 对象持有模型连接、工具注册表和事件发射器。
4. **Turn**：一次用户提交对应一次 `session.prompt()` 调用。一个 Turn 内部可能包含多次 `message_update`、零到多次工具调用、以及最终的 `turn_complete` 或 `error` 事件。
5. **事件流契约**：使用 JSONL/SSE 格式输出 `text_delta`、`thinking_delta`、`toolcall_*`、`tool_execution_start/update/end` 和生命周期事件。`packages/contracts` 负责 DTO 定义。
6. **Subscription**：订阅者必须在 `session.prompt()` 调用前注册。事件不缓存，晚订阅会丢失已经发出的 delta，这是可观测性采集必须遵守的前置条件。
7. **工具能力边界**：本项目只暴露 `read` 和 `search_knowledge` 两个只读工具。工具参数和返回结果仅作为诊断输入，不构成授权凭证。

## 设计决策与取舍

### 内存注册表优先于持久化会话

`SessionManager.inMemory()` 选择进程内 Map 作为会话索引。优点是实现简单、延迟低、无需外部存储；缺点是进程重启即丢失全部会话状态，故障恢复依赖客户端重新创建。对于 playground 场景，这是可接受的取舍；若部署到多副本环境，则需要在上层网关维护会话亲和性或外部状态存储。

### SSE 而非 WebSocket

`apps/api` 使用 SSE 推送流事件。SSE 兼容标准 HTTP 代理和负载均衡，调试时可用 curl 直接消费；缺点是单向通信，客户端重连后无法从服务端恢复已发送的事件。因此协议层面需要客户端在连接断开后重新提交 Turn，而不是尝试续流。

### 先订阅后提交

SDK 要求调用方在 `session.prompt()` 之前完成事件订阅。这个顺序约束保证了事件处理回调在模型产生任何输出前已经就绪，避免了首 token 丢失；代价是客户端连接建立和订阅注册必须在一个同步窗口内完成，增加了时序错误的可能性。

### 只读工具集合

出于项目边界和安全考虑，只暴露 `read` 和 `search_knowledge`。模型仍然可能生成写操作意图，但工具层会拒绝执行。取舍是能力受限，但主机边界更简单，不需要对每次工具调用做额外授权审批。

### 工具结果作为诊断而非授权

所有工具返回的结构化内容都标记为 `diagnostic`，不用于扩展运行时权限。这防止了模型通过工具输出诱导后续操作越过能力边界，也要求提示模板和系统指令明确告知模型可用工具范围。

## 可执行的实施流程

1. 在项目根目录确认 `cwd` 正确，验证 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md` 存在且可读。
2. 调用 `DefaultResourceLoader` 构造资源加载器，捕获加载失败的异常并记录具体缺失路径。
3. 使用 `SessionManager.inMemory()` 创建会话注册表，设置最大会话数上限或内存告警阈值。
4. 调用 `createAgentSession()`，传入 `ModelRuntime`、资源加载器和工具集合，获取 Session 实例。
5. 在调用 `session.prompt()` 前注册事件订阅，将 `message_update`、工具事件、生命周期事件转发到 SSE 流。
6. 提交用户 Turn，触发模型推理，同步开启 Turn 计时器和首 token 等待计时器。
7. 在事件流处理中，对 `text_delta` 和 `thinking_delta` 做转义与缓冲；对工具事件记录开始、更新、结束三阶段时间戳。
8. Turn 结束后，根据 `turn_complete` 或 `error` 事件更新会话状态，记录延迟、token 数、错误码。
9. 客户端断开或显式关闭时，先取消订阅，再调用 `session.dispose()`，最后从 `SessionManager` 移除条目。
10. 定期运行 `pnpm typecheck` 和 `pnpm test`，确保 SDK 版本与类型契约一致。

## 示例：一次 Turn 的输入、处理与输出

以下 YAML 描述一个典型 Turn 的观测记录，用于可验证日志和测试样例。

```yaml
session_id: sess_7a8b9c
turn_index: 3
input:
  user_message: "查询 .pi/knowledge 中关于 Pi 事件契约的说明"
  tools: ["read", "search_knowledge"]
  thinking_level: "medium"
processing:
  resource_loader: "DefaultResourceLoader"
  model_runtime: "configured_runtime"
  subscribed_before_prompt: true
  events_observed:
    - tool_execution_start
    - thinking_delta
    - text_delta
    - tool_execution_end
    - turn_complete
output:
  final_text: "根据 .pi/knowledge/pi-events.md，事件流采用 JSONL/SSE 格式..."
  latency_ms: 1240
  first_token_ms: 180
  tools_called: 1
  status: "complete"
```

输入是用户消息和工具配置；处理阶段由 `AgentSession` 驱动模型、触发工具调用、产生事件流；输出是聚合文本、延迟指标和完成状态。该记录可用于断言一次 Turn 是否满足可观测性要求。

## 性能、质量和可观测性指标

1. **首 token 延迟**：从 `session.prompt()` 调用到首个 `text_delta` 或 `thinking_delta` 到达的时间。使用服务端高精度计时器测量，正常阈值建议低于 2 秒，超出则告警。
2. **Turn 总时长**：从提交到 `turn_complete` 或 `error` 的总耗时。需要按工具调用次数和文本长度分桶统计，避免平均数掩盖长尾。
3. **并发会话数**：`SessionManager.inMemory()` 中的活跃条目数。需设置上限，达到 80% 时触发扩容或拒绝新连接。
4. **事件丢失率**：通过客户端确认事件序列号与服务器发出事件数对比。若未实现序列号，则无法直接测量，属于已知盲区。
5. **工具调用失败率**：`tool_execution_end` 中状态为 `error` 的比例，需按工具类型和文件路径细分。
6. **内存占用**：单个 Session 对象及其订阅回调的 retained size。可通过 Node.js heap snapshot 采样，定位未释放会话。

## 失败模式、诊断证据与恢复动作

1. **资源加载失败**：`DefaultResourceLoader` 抛出路径不存在或解析错误。诊断证据是启动日志中的 ENOENT 或 YAML 解析异常。恢复动作是检查 `cwd` 和 `.pi` 目录权限，修复后重启服务。
2. **订阅时序错误**：客户端在 `session.prompt()` 之后注册订阅，导致首 token 或工具事件丢失。诊断证据是日志中事件计数大于客户端收到计数。恢复动作是强制 SDK 调用前检查订阅状态，拒绝不合规调用。
3. **SSE 连接中断**：网络抖动或客户端超时导致连接断开，但服务端仍在继续生成事件。诊断证据是服务端 `turn_complete` 与客户端未收到最终文本同时出现。恢复动作是客户端重新连接并提交新 Turn，不尝试续流。
4. **工具调用异常**：`read` 工具访问不存在的文件或 `search_knowledge` 返回空结果。诊断证据是 `tool_execution_end` 携带错误详情。恢复动作是模型根据错误提示重新生成或告知用户无法完成。
5. **会话泄漏**：`session.dispose()` 未被调用或 `SessionManager` 未移除条目，导致内存持续增长。诊断证据是活跃会话数不随客户端关闭下降。恢复动作是添加 `finally` 清理逻辑，并设置会话最大 TTL。
6. **模型运行时不可用**：`ModelRuntime` 初始化失败或 provider 返回 5xx。诊断证据是 `createAgentSession()` 抛出或 Turn 事件流直接报错。恢复动作是降级到备用运行时或返回明确错误给客户端。

## 问答测试样例

1. **正向**：一个 Session 从创建到关闭需要经历哪些关键阶段？答：资源加载、会话创建、订阅注册、Turn 提交、事件处理、关闭与释放。
2. **正向**：为什么订阅必须在 `session.prompt()` 之前完成？答：因为事件不缓存，晚订阅会丢失已经发出的 delta。
3. **边界**：进程重启后，已创建的 Session 能否恢复？答：不能，因为 `SessionManager.inMemory()` 是进程内注册表，除非额外引入外部状态存储。
4. **边界**：一次 Turn 中是否可能出现零次工具调用？答：可以，当模型判断无需调用工具时，Turn 仅包含文本 delta 和 `turn_complete`。
5. **拒答**：模型提供商的 API 密钥存储在哪里？答：本文档未涉及该实现细节，只说明密钥保留在 API 进程内。
6. **拒答**：Pi SDK 内部如何处理流式解码？答：属于 SDK 内部实现，本项目未提供可验证证据，无法回答。

## 维护、版本、来源与相邻主题

- **维护责任**：`packages/pi-agent` 负责 Session 生命周期与事件封装；`apps/api` 负责 HTTP/SSE 传输和会话身份验证；`apps/web` 负责消费 SSE 流。
- **版本约束**：`packageManager` 锁定为 `pnpm@10.30.3`，依赖版本由 `pnpm-lock.yaml` 保证。升级 `@earendil-works/pi-coding-agent` 后必须重新运行 `pnpm typecheck` 和 `pnpm test`。
- **来源依据**：项目级来源为 `AGENTS.md`、`packages/pi-agent` 源码、`packages/contracts` DTO 定义以及 `.pi` 目录下的资源文件。上游参考为 Pi 官方 SDK 文档，但实现以本地安装版本为准。
- **相邻主题**：与 `Pi 事件流协议` 相邻，涉及 SSE/JSONL 事件格式；与 `Project Trust 与资源加载` 相邻，涉及 `DefaultResourceLoader` 和 `.pi/knowledge` 读取；与 `工具能力边界` 相邻，涉及只读工具的设计。

## 结论

- **事实**：Session 生命周期由 `DefaultResourceLoader` 加载、`SessionManager.inMemory()` 注册、`createAgentSession()` 创建、事件订阅、`session.prompt()` 执行 Turn、最终取消订阅并 `dispose()` 关闭。
- **推论**：在 playground 场景下，内存注册表和 SSE 是合理取舍；若生产环境需要多副本或故障恢复，应在外层增加会话亲和性或持久化。
- **未知**：模型提供商内部的流式解码、重试策略和 token 计费细节未被本项目直接暴露；客户端事件丢失率在没有序列号机制时无法精确测量。

我已按你要求的结构完成了整篇 Markdown 正文。是否还需要对某一部分扩展或补充？
