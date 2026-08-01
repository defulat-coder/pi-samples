---
type: concept
title: Session 状态：实现视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。多轮会话、历史消息、恢复和并发请求之间的状态一致性
resource: .pi/knowledge/library/pi-runtime/state-implementation.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, state, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: state
variant: implementation
---

# Pi Agent 运行时 Session 状态：多轮会话、历史消息、恢复与并发请求的一致性实现

## 摘要与问题边界

本文描述在 `packages/pi-agent` 与 `apps/api` 之间如何维护 Pi Agent 的 Session 状态。核心问题不是“如何存储聊天记录”，而是“在多轮交互、SSE 流式输出、工具调用、客户端重连和并发请求同时发生时，如何让服务端历史、客户端视图与 Pi SDK 内部状态保持可验证的一致”。范围限定在单进程 Web 触发场景：使用 `SessionManager.inMemory()`，不包含外部持久化数据库；工具侧只暴露 `read` 与项目自定义 `search_knowledge`，均为只读。超出范围的是跨进程水平扩展、客户端本地状态持久化、以及非 Pi 兼容的第三方模型运行时。

## 核心概念与数据模型

1. **Session 身份（SessionIdentity）**。字段包括 `sessionId`（UUIDv4）、`clientToken`（会话级签名）、`modelRuntime`（模型运行时标识与版本）、`createdAt`（时间戳）、`cwd`（项目根目录）。`sessionId` 是后续所有消息、事件和恢复请求的主键。
2. **消息信封（MessageEnvelope）**。每条历史记录包含 `role`（`user`、`assistant`、`tool`）、`content`（文本块或工具调用块数组）、`turnIndex`（严格递增的整数，从 0 开始）、`timestamp`（ISO 字符串）、`sourceEventId`（关联到生成该消息的 SSE 事件 ID）。`turnIndex` 是判断乱序和重放的唯一依据。
3. **工具调用记录（ToolCallRecord）**。字段包括 `callId`（Pi SDK 生成的调用标识）、`toolName`、序列化后的 `arguments`、返回的 `result` 或 `error`、以及 `executionEndEventId`。该记录只由 `tool_execution_end` 事件最终确认，中间状态仅允许诊断。
4. **会话注册表（SessionRegistryEntry）**。`SessionManager.inMemory()` 维护的条目包含 `agentSession`（Pi `AgentSession` 实例）、`history`（`MessageEnvelope[]`）、`inFlight`（当前正在执行的 `prompt` Promise 或 `null`）、`lastEventId`（已发送的最新 SSE 事件整数）、`subscribed`（布尔值，表示是否已挂载事件监听器）。
5. **恢复令牌（RecoveryToken）**。客户端重连时携带 `sessionId` 与 `lastAcknowledgedEventId`。服务端据此判断需要重放的事件范围。恢复令牌不携带历史消息正文，只携带游标，避免客户端伪造完整对话。
6. **能力注入视图（CapabilityView）**。每条请求进入时由 `apps/api` 根据身份与配置生成允许的模型参数、thinking 级别、工具白名单。该视图与 `AgentSession` 绑定，并在每次 `session.prompt()` 前重新校验，防止运行中权限漂移。

## 设计决策与取舍

### 1. 单进程内存注册表，不做跨进程共享
取舍：启动快、无外部依赖、实现简单。代价是 API 进程重启后所有 Session 状态丢失，恢复只能回退到“创建新会话”。如果未来需要横向扩展，必须引入外部事件日志与 Session 快照存储，但这不在当前实现路径内。

### 2. 每个 Session 同一时刻最多一个 in-flight prompt
取舍：强制串行化消除了同一 Session 内多线程并发修改 `history` 的风险。客户端若需要并行，应创建多个 Session，而不是向同一个 `sessionId` 并发发送。该决策通过 `inFlight` 锁实现，冲突返回 409。

### 3. 历史记录追加优先于事件重放
取舍：当客户端重连时，先补全服务端 `history` 中缺失的工具结果，再按 `turnIndex` 顺序重放 SSE 事件。这样保证“事件顺序 = 历史顺序”，但要求所有 thinking 与 toolcall 中间增量事件都必须与最终 `message_update` 一一对应。例外：纯流式文本增量允许在重放时合并为完整消息，减少事件数量。

### 4. 工具结果只读且幂等
取舍：由于暴露的工具只有 `read` 与 `search_knowledge`，可安全地对同一 `callId` 重试一次。如果工具未来扩展为写操作，则必须在 `ToolCallRecord` 中引入副作用标记与写前确认，当前设计不允许。

### 5. 客户端永远看不到 Provider Key
取舍：Provider Key 只存在于 API 进程内存，浏览器只消费 SSE 事件。代价是 API 成为单点信任边界，需要额外审计其环境变量访问；收益是杜绝了密钥通过前端泄露或保存在客户端恢复令牌中的风险。

## 可执行的实施流程

1. 请求进入 `apps/api`，先校验 DTO：`sessionId` 必须符合 UUIDv4；`modelRuntime` 必须在允许列表；`thinkingLevel` 必须是 `off`、`low`、`medium`、`high` 之一；`allowedTools` 必须是 `["read", "search_knowledge"]` 的子集。
2. 根据 `sessionId` 从 `SessionManager.inMemory()` 获取或创建 `SessionRegistryEntry`。若新建，则调用 `createAgentSession()` 并绑定配置的 `ModelRuntime`。
3. 使用 `DefaultResourceLoader` 以项目 `cwd` 初始化，加载 `.pi/skills`、`.pi/prompts` 与 `AGENTS.md`。`.pi/knowledge` 不自动加载，仅通过 `search_knowledge` 在需要时读取。
4. 在调用 `session.prompt()` 之前完成事件订阅：监听 `message_update`（`text_delta`、`thinking_delta`、`toolcall_*`）、`tool_execution_start/update/end`、生命周期与重试事件。
5. 检查 `inFlight`：若不为 `null`，立即返回 HTTP 409 与 `x-pi-inflight-turn` 头部；否则将 `prompt` Promise 赋值给 `inFlight`，并设置 `subscribed = true`。
6. 在事件回调中构造 `MessageEnvelope` 与 `ToolCallRecord`：文本增量合并到当前 `assistant` 消息；工具调用完成后追加 `role: tool` 记录；每条持久化操作都更新 `lastEventId`。
7. 通过 SSE 发送事件，每条事件携带 `id`（与 `lastEventId` 一致）、`type` 与 `payload`。客户端必须按 `id` 顺序消费；服务端保留最近 N 条事件的环形缓冲。
8. 请求结束或异常时：将 `inFlight` 置为 `null`，保留 `history` 与 `agentSession`；不要立即 `dispose`，除非客户端断开超过 TTL。`dispose` 前必须先 `unsubscribe` 并释放 Pi 会话资源。

## 示例：恢复请求的处理逻辑

    输入：
    POST /sessions/resume
    {
      "sessionId": "a1b2c3d4",
      "lastAcknowledgedEventId": 42
    }

    处理：
    1. 在 SessionRegistry 中查找 sessionId。
    2. 若不存在，返回 410 Gone（进程已重启，无法恢复）。
    3. 若存在，比较 lastAcknowledgedEventId 与 lastEventId。
       - 若 42 < lastEventId 且在缓冲区内，从 43 开始重放 SSE。
       - 若 42 > lastEventId，返回 400（客户端未来事件不可能存在）。
       - 若 42 == lastEventId，返回 204 No Content。
    4. 重放前再次校验 capabilityView，确认权限未变更。

    输出：
    SSE 流：
    id: 43
    event: message_update
    data: {"turnIndex":7,"role":"assistant","content":"..."}

该示例说明恢复的核心不是“拉取历史文本”，而是“在事件游标基础上补齐状态差异”。

## 性能、质量与可观测性指标

1. **首字节延迟（TTFB）**：从请求进入 API 到第一条 SSE 字节发出的 p99 时间。测量方式：在 `apps/api` 入口处打 `start` 标记，在首个 SSE 推送时打 `firstByte` 标记，差值写入直方图。
2. **历史漂移率**：每百次重连中发生 `historyDigest` 不匹配的次数。测量方式：重连时计算服务端历史哈希与客户端声明哈希的对比，记录不匹配事件。
3. **工具错误率**：按 `toolName` 统计 `tool_execution_end` 中 `error` 的比例。目标：`< 1%` 对于 `read`；`search_knowledge` 允许稍高，因为依赖本地文件索引。
4. **并发冲突率**：返回 409 的请求占比。若持续高于 5%，说明客户端轮询间隔过短，应调整为重连机制或更长的请求间隔。
5. **会话注册表内存占用**：记录条目数与单条历史平均消息长度。设置 TTL 为 30 分钟无心跳后 `dispose`，防止内存泄漏。

## 失败模式、诊断证据与恢复动作

1. **并发请求冲突**。证据：日志中出现 `Conflict: sessionId=a1b2c3d4, inFlightTurn=5`。恢复：客户端收到 409 后等待 `Retry-After` 秒，或改用新 `sessionId` 开启并行会话。
2. **客户端历史与服务端不一致**。证据：重连时 `historyDigest` 不匹配。恢复：服务端返回 409 并携带服务端最新 `lastEventId` 与摘要；客户端可选择重置会话或接受服务端状态。
3. **工具调用超时**。证据：收到 `tool_execution_start` 后 30 秒内未收到 `tool_execution_end`。恢复：API 层取消该调用，向 `history` 写入 `role: tool` 的错误结果，并继续后续流。
4. **SSE 连接中断导致事件丢失**。证据：客户端事件序列出现 `id` 跳跃。恢复：客户端重连时携带最大的已确认 `id`，服务端从缓冲重放；若缓冲区已滚动，返回 410。
5. **Session 内存泄漏**。证据：注册表条目数随时间线性增长，且存在大量 `lastHeartbeat` 早于 TTL。恢复：后台定时任务扫描并 `dispose` 过期会话，确保先 `unsubscribe` 再释放 `agentSession`。

## 问答测试样例

### 正向问题

Q1：如何恢复一个已存在的会话？
A1：客户端发送 `sessionId` 与 `lastAcknowledgedEventId`，服务端在内存注册表中找到对应条目后，从下一个事件开始重放 SSE。

Q2：历史消息中的 `turnIndex` 起什么作用？
A2：`turnIndex` 是严格递增的整数，用于判断消息顺序、检测重放乱序，以及验证客户端历史与服务端历史是否一致。

### 边界问题

Q3：同一个 `sessionId` 能否同时发送两个 prompt？
A3：不能。`inFlight` 锁会阻止第二个请求，返回 409；需要并行时应创建多个 Session。

Q4：如果 `lastAcknowledgedEventId` 大于服务端 `lastEventId`，会怎样？
A4：服务端返回 400，因为客户端不可能确认尚未发生的事件。

### 无证据拒答条件

Q5：Pi SDK 内部是否会把 Provider Key 缓存到磁盘？
A5：无法根据当前项目配置回答；项目仅要求 Provider Key 留在 API 进程内存，具体 SDK 实现细节未在本仓库验证。

Q6：能否把 `search_knowledge` 改为写文件的工具？
A6：不能。根据 AGENTS.md，项目只暴露只读工具；扩展为写操作需要重新设计能力注入与副作用记录，当前无证据支持。

## 维护、版本、来源与相邻主题

- **依赖版本**：使用 `pnpm@10.30.3`，`@earendil-works/pi-coding-agent` 版本以 `pnpm-lock.yaml` 为准。任何 SDK 升级后必须重新运行 `pnpm typecheck` 与 `pnpm test`。
- **Skills 管理**：`.agents/skills/` 与 `skills-lock.json` 由 `npx skills` 系列命令管理，禁止手工修改。
- **来源**：实现参考 `AGENTS.md` 中的 Pi 集成契约，以及 `packages/pi-agent` 的会话生命周期封装。
- **相邻主题**：与“自定义工具定义”相邻，因为工具结果直接影响 `history`；与“SSE 传输协议”相邻，因为事件顺序是恢复一致性的前提；与“ModelRuntime 配置”相邻，因为 `thinkingLevel` 与模型运行时参数必须在每次 prompt 前重新校验。

## 结论：事实、推论与未知

- **事实**：当前实现使用 `SessionManager.inMemory()`；每个 Session 通过 `inFlight` 锁强制串行化；Provider Key 仅存在于 API 进程；暴露的工具只有 `read` 与 `search_knowledge`；`.pi/knowledge` 通过 `search_knowledge` 读取而非自动加载。
- **推论**：由于注册表在内存中，API 进程重启必然导致所有会话状态丢失；强制单线程 prompt 是当前避免历史冲突的最简单手段；将事件游标作为恢复令牌比携带完整历史更安全。
- **未知**：Pi SDK 在 `AgentSession` 内部是否对同一请求做了额外的缓冲或重排序；大规模并发下的 SSE 背压阈值尚未经过生产流量验证；外部持久化层引入后事件重放语义是否需要重新设计。
