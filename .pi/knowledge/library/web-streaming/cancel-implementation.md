---
type: concept
title: 取消：实现视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。将用户停止、浏览器离开和 API 中止传递到 Agent session
resource: .pi/knowledge/library/web-streaming/cancel-implementation.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, cancel, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: cancel
variant: implementation
---

# Web 流式交互中的取消传播：把用户停止、浏览器离开与 API 中止传递到 Agent Session 的实现

## 摘要与问题边界

在基于 Pi Agent Session 的 Web 流式交互里，取消不是“关掉一个按钮”那么简单，而是要把三类来源的停止意图安全地汇聚到同一条 Agent 执行路径：用户主动点击停止、浏览器生命周期事件导致的连接中断、API 层因超时或运维需要触发的中止。本篇文章讨论的是 `apps/api` 到 `apps/web` 之间、以及 `packages/pi-agent` 内部的取消传播实现，重点在于输入识别、状态机转换、错误边界、资源清理和可验证步骤，最后才进入 TypeScript 编码。

问题边界如下：这里不处理业务补偿或模型已产生 token 的费用核算；不替代身份认证与会话鉴权；不处理浏览器完全崩溃且没有发送任何事件的极端离线场景；也不讨论模型侧是否支持停止生成的策略差异。我们只保证：当取消信号被识别后，`AgentSession` 当前这一轮 prompt 的模型调用、SSE 输出流、工具订阅和本地内存引用都会被按序释放。

## 核心概念与数据模型

1. **`AbortSignal`（中止信号）**：浏览器与 Node 的标准原语。每次用户发起流式请求时，`apps/web` 创建一个 `AbortController`，其 `signal` 既是浏览器 fetch/SSE 的中止依据，也是后续通过 HTTP POST 向 `apps/api` 发送取消请求的触发器。

2. **`UserStopIntent`（用户停止意图）**：结构化对象 `{ sessionId, sequence, reason: 'user_stop' }`。`sequence` 是客户端单调递增的轮次编号，用于区分“停止上一轮”和“停止当前轮”，避免旧取消帧误杀新请求。

3. **`TransportAbortFrame`（传输层取消帧）**：SSE 或 JSONL 流中的控制事件，形如 `{ event: 'control', type: 'cancel', source, phase, timestamp }`。它向浏览器确认服务端已收到取消，并给出当前所处阶段，防止客户端因未收到确认而反复重试。

4. **`AgentAbortState`（Agent 中止状态）**：`packages/pi-agent` 内部维护的原子标志，至少包含 `idle`、`abort_requested`、`aborting`、`aborted` 四个状态。只有状态为 `idle` 或 `abort_requested` 时才允许进入新的 prompt；一旦进入 `aborted`，当前轮次不再产出任何 `text_delta` 或 `toolcall_*` 事件。

5. **`AbortAuditRecord`（取消审计记录）**：持久化到日志的条目，字段包括 `{ sessionId, source, phase, sequence, requestedAt, ackedAt, tokensAfterCancel, disposedAt }`。它是事后排查“为什么模型还在跑”的第一手证据。

6. **`CleanupManifest`（清理清单）**：每轮 prompt 开始时生成的资源登记表，包含 `sseWriter`、`providerRequestHandle`、`messageUpdateSubscription`、`toolExecutionSubscription`、`inMemorySessionRef`、`DefaultResourceLoader` 打开的临时文件句柄。取消时按逆序逐项释放。

## 设计决策与取舍

### 客户端信号仅供参考，服务端拥有最终决定权

浏览器可能因脚本错误、插件拦截或用户刷新而发送混乱的取消请求。`apps/api` 必须校验 `sessionId` 与会话 token 的绑定关系，拒绝未授权或已处置会话的取消帧。这样做增加了网络往返，但能防止恶意或异常的取消被直接透传给模型运行时。

### 使用分层 AbortController，而非单一全局控制器

全局控制器会导致“一次取消、所有会话被杀”。每个 prompt 轮次拥有独立的 `AbortController`，再与会话级控制器通过 `AbortSignal.any`（或兼容环境下的手动事件合并）组合。这样用户停止只影响当前轮次，API 中止则可以在会话级广播。

### SSE 取消以“先发送终止帧、再关闭 writer”为准

直接关闭 TCP 会让浏览器 `EventSource` 进入自动重连，造成 token 持续流出的错觉。正确顺序是：先写入 `TransportAbortFrame`，再写入结束标记（如 `event: done`），最后调用 `writer.close()`。如果 writer 已关闭，则降级为服务端日志记录，不抛异常给浏览器。

### 浏览器离开事件采用“三保险”策略

`beforeunload` 用于提示未保存内容，`pagehide` 用于确认页面真正离开，`visibilitychange` 用于处理切后台/锁屏。三者都向 `/api/sessions/{id}/abort` 发送 `reason: 'browser_leave'` 的 POST。即便如此，仍可能漏报，因此服务端必须设置心跳超时兜底：若 60 秒内未收到任何 SSE 保活或消息帧，即视为浏览器离开。

### 取消不重置会话上下文，只清理本轮缓冲区

`AgentSession` 的聊天历史、`DefaultResourceLoader` 加载的项目上下文、`.pi/knowledge` 检索结果都保留，仅清空当前轮的 `thinking_delta` 缓冲和未完成的工具调用栈。这样用户随后可以继续提问，而不会因为一次取消丢失所有上下文。

## 可执行的实施流程

1. **浏览器侧创建请求级 `AbortController`**：每次点击发送按钮时生成新的控制器；将 `signal` 传给 `fetch('/api/sessions/{id}/prompt', { signal })` 或 `EventSource` 的等效封装。

2. **绑定三类取消源**：“停止”按钮调用 `controller.abort('user_stop')`；`beforeunload`/`pagehide`/`visibilitychange` 监听中调用 `navigator.sendBeacon('/api/sessions/{id}/abort', body)`；API 超时由 `apps/api` 内部 `setTimeout` 触发。

3. **API 接收并校验取消请求**：路由 `POST /api/sessions/:id/abort` 读取 `{ reason, sequence }`，验证 JWT/cookie 中的 `sessionId` 是否匹配，并确认 `SessionManager.inMemory()` 中存在该会话。若不存在，返回 `404`；若已 `disposed`，返回 `410 Gone`。

4. **注册取消意图并阻止新消息**：在会话对象上设置 `abortState = 'abort_requested'`，并检查当前 `sequence` 是否等于活跃轮次。若 `sequence` 过期，返回 `409 Conflict` 表示取消对象已结束。

5. **向 SSE writer 发送控制帧**：写入 `TransportAbortFrame`，字段包括 `source: 'user' | 'browser' | 'api'`、`phase: 'before_request' | 'during_stream' | 'after_close'`。`phase` 由当前是否已开始接收模型 token 决定。

6. **传播信号到 `AgentSession`**：调用 prompt 轮次控制器的 `abort(reason)`，使传给模型运行时的 `AbortSignal` 触发；若模型运行时调用不支持 `signal`，则通过显式检查 `AgentAbortState` 抛出 `AbortError`。

7. **清理资源并解除订阅**：按 `CleanupManifest` 逆序执行：取消 `message_update` 订阅；取消 `tool_execution_start/update/end` 订阅；关闭工具调用可能打开的子进程；关闭 SSE writer；若会话无重连计划，从 `SessionManager.inMemory()` 移除引用。

8. **返回确认与审计**：向浏览器返回 `204 No Content` 或 `202 Accepted`；写入 `AbortAuditRecord`，记录 `requestedAt`、`ackedAt`、取消来源和取消后是否还有 token 到达。服务端在 SSE 上再发送一次 `cancellation_ack` 事件，包含 `elapsedMs`。

## YAML 示例：一次用户停止的完整输入、处理与输出

```yaml
# 1. 浏览器输入：用户点击停止按钮后发送的请求
request:
  method: POST
  path: /api/sessions/s_7f3a/abort
  headers:
    cookie: session=s_7f3a; sig=...
  body:
    reason: user_stop
    sequence: 3

# 2. apps/api 处理：校验、传播、清理
processing:
  validation:
    session_exists: true
    ownership_ok: true
    sequence_matches_active_turn: true
  state_transition:
    from: streaming
    to: abort_requested
  propagation:
    - source: user_stop
    - phase: during_stream
    - signal_forwarded_to_agent_session: true
    - sse_writer_closed_after_control_frame: true

# 3. 浏览器收到的 SSE 输出
sse_events:
  - "event: message_delta\ndata: {text_delta: '基于'} "
  - "event: control\ndata: {type: cancel, source: user_stop, phase: during_stream}"
  - "event: cancellation_ack\ndata: {elapsedMs: 42, tokensAfterCancel: 0}"
  - "event: done\ndata: {}"
```

这个示例的输入是 HTTP POST 取消请求，处理关键是 `sequence_matches_active_turn` 校验和 `during_stream` 阶段判断，输出则是浏览器最终看到的控制帧与确认帧。只要 `cancellation_ack` 到达，就可以认为本次取消传播成功。

## 性能、质量和可观测性指标

1. **取消延迟**：从浏览器触发 `controller.abort()` 到模型运行时真正停止生成之间的时间。测量方法是在 `AbortAuditRecord` 中记录 `requestedAt` 和模型侧最后一个 token 到达时间 `lastTokenAt`，差值应小于 200ms。

2. **取消后脏 token 比例**：取消信号发出后仍然到达的 token 数量占本轮总 token 数量的比例。SSE 解析器在收到 `control` 帧后继续计数，直到 `done`，目标值应低于 1%。

3. **连接泄漏数**：服务端 `SessionManager.inMemory()` 中状态为 `disposed` 但 writer 仍未关闭的会话数量。通过定时任务扫描暴露，目标为零。

4. **误取消率**：因浏览器刷新或导航触发的 `browser_leave` 取消中，用户在 5 秒内重新打开页面并继续同一对话的比例。高比例说明 leave 检测过于敏感，需要调整心跳超时。

5. **端到端确认延迟**：从浏览器发送 POST abort 到收到 `cancellation_ack` 事件的耗时。使用 Performance API 在客户端记录，目标 P99 小于 100ms。

## 失败模式、诊断证据与恢复动作

1. **浏览器离开事件未触发**：诊断证据为 `AbortAuditRecord` 中 source 是 `browser_leave` 的记录缺失，但心跳超时后产生 `idle_timeout` 记录。恢复动作是不要完全依赖 `pagehide`，必须保留服务端心跳超时兜底，并在超时后执行同样的清理清单。

2. **取消帧在流关闭后才到达**：诊断证据是 API 返回 `410 Gone` 或 `404 Not Found`。恢复动作为直接丢弃该帧并记录 `duplicate_cancel`，不向浏览器抛错。

3. **模型运行时忽略 AbortSignal**：诊断证据是取消请求发出后，`lastTokenAt` 与 `requestedAt` 差值持续大于 500ms。恢复动作是强制关闭 SSE writer，将该 provider 调用标记为 `provider_abort_timeout`，并在后续升级 provider 调用封装层以支持更细粒度的取消。

4. **用户快速发送新消息导致旧取消误杀新请求**：诊断证据是 `sequence` 不匹配，`AbortAuditRecord` 出现 `sequence_mismatch`。恢复动作是在 API 层严格校验 `sequence`，旧取消返回 `409 Conflict`，新请求不受影响。

5. **工具调用在取消后继续执行**：诊断证据是 `tool_execution_end` 事件在 `cancellation_ack` 之后到达。恢复动作是在每个自定义工具的 `defineTool()` 实现内部周期性检查 `AbortSignal`，一旦触发即抛出 `AbortError` 并返回 `{ aborted: true }` 结构化结果。

## 问答测试样例

1. **正向问题**：用户点击停止按钮后，浏览器应如何通知 API？
   **答**：创建请求级 `AbortController` 并调用 `abort('user_stop')`，同时通过 POST `/api/sessions/{id}/abort` 发送 `{ reason: 'user_stop', sequence }`，sequence 必须与当前活跃轮次一致。

2. **正向问题**：服务端收到取消请求后，`AgentSession` 的活跃 prompt 会怎样？
   **答**：prompt 轮次的 `AbortSignal` 被触发，模型运行时停止生成，后续 `text_delta` 和 `toolcall_*` 事件被丢弃，SSE writer 在发送控制帧后关闭。

3. **边界问题**：如果浏览器刷新时 `pagehide` 没触发，会话还会被取消吗？
   **答**：会。服务端心跳超时机制会在 60 秒内无帧到达时主动执行取消流程，但审计记录中的 source 为 `idle_timeout` 而非 `browser_leave`。

4. **边界问题**：取消后用户立刻发送新消息，历史记录会丢失吗？
   **答**：不会。取消只清理本轮缓冲区和未完成的工具调用栈，会话级聊天历史与 `DefaultResourceLoader` 加载的项目上下文保留。

5. **无证据拒答**：能否判断模型提供商内部是否在取消后仍计费？
   **答**：无法判断。项目内部只能测量取消后到达的 token 数量，具体计费逻辑由模型服务决定，不在本系统可观测范围内。

6. **无证据拒答**：能否保证所有浏览器插件都不会阻止 `sendBeacon`？
   **答**：不能保证。sendBeacon 丢失时，依赖心跳超时作为兜底；不能仅依据缺少 beacon 记录就断言浏览器仍在线。

## 维护、版本、来源与相邻主题关系

本实现依赖浏览器对 `AbortController` 和 `AbortSignal.any` 的支持，服务端依赖 Node.js 的 `ReadableStream`/`WritableStream` 与 `Response` writer。`packages/pi-agent` 升级时必须确认 `AgentSession` 的取消接口是否变化；`apps/api` 升级时应注意 SSE 事件格式与 `contracts` 包的 DTO 对齐。

相邻主题包括：
- **重试与恢复**：取消后的重连必须携带 `lastEventId` 或轮次号，避免重复消费已取消的 token。
- **限流**：高频取消请求应被限流，防止恶意用户反复触发清理清单。
- **错误处理**：取消是正常生命周期事件，不应被记录为未捕获异常，但 provider 取消超时属于错误。
- **会话持久化**：`SessionManager.inMemory()` 仅适合 Web 会话注册；若未来引入持久化会话，取消状态需要写入存储以避免多实例竞态。

## 结论

**事实**：取消传播链路包括浏览器事件、HTTP POST 取消请求、SSE 控制帧、`AgentSession` 中止信号、资源清理清单和审计记录六个明确阶段。

**推论**：在 `SessionManager.inMemory()` 与会话 token 校验的保护下，只要服务端实施 `sequence` 校验和心跳超时兜底，就能将用户停止、浏览器离开和 API 中止统一为同一套安全取消语义，且不会丢失会话上下文。

**未知**：具体模型提供商是否真正尊重 `AbortSignal` 并停止计费，无法从本系统内部验证；浏览器插件或网络代理对 `sendBeacon` 的拦截行为也无法完全观测。因此生产环境必须保留服务端心跳超时和取消后 token 计数作为事实依据，而不是依赖浏览器事件的完备性。
