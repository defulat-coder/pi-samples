---
type: concept
title: 取消：验证与运维视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。将用户停止、浏览器离开和 API 中止传递到 Agent session
resource: .pi/knowledge/library/web-streaming/cancel-operations.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, cancel, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: cancel
variant: operations
---

# Web 流式交互中的取消：从用户停止、页面离开到 Agent Session 中止的传递与运维验证

## 摘要与问题边界

取消不是界面按钮的副作用，而是一条必须贯穿客户端、传输层、API 与会话运行时（AgentSession）的生命周期信号。本文聚焦三类触发源：用户主动点击停止、浏览器离开或失活、以及 API 超时或服务器主动中止。可验证边界在于：取消只能阻止后续 delta 的生成与传输，无法撤回已经发送到客户端的字节；它不能保证上游模型立即终止内部推理；并且本项目的工具集仅暴露 `read` 与 `search_knowledge`，取消不触发任何写操作。运维视角的核心是收集延迟、残留 token、会话清理时间、错误率与恢复证据，而不是仅观察一次成功停止。

## 核心概念与数据模型

1. **取消源（Cancel Source）**。用户点击停止按钮、浏览器 `beforeunload`/`pagehide`/`visibilitychange`、网络断开、`fetch` 超时、API 进程超时或容量保护触发，都属于合法取消源。
2. **中止令牌（Abort Token）**。每个请求/每轮对话拥有一个独立的 `AbortController` 与 `AbortSignal`，它是取消在同步与异步边界之间传递的合约。
3. **传输层取消**。客户端通过 `fetch`/`EventSource` abort 关闭读取端；服务端通过 `req.on('close')` 或 `res.on('close')` 检测 HTTP 连接断开。
4. **Session 层取消**。`packages/pi-agent` 中调用 `session.cancel()` 或 `session.dispose()`，将 signal 传入 `session.prompt()`，使事件循环退出。
5. **取消事件边界**。取消事件在内部表示为 `{ type: 'abort', reason, source, scope, turnId, timestamp, idempotencyKey }`，其中 `scope` 可为 `client`、`transport`、`api` 或 `provider`。
6. **在途工具与模型调用**。任何耗时工具（如读取大文件或知识库搜索）必须消费同一个 `AbortSignal`；但模型运行时是否真正终止推理取决于具体 provider 实现。
7. **部分状态残留**。已发送的 `text_delta` 与 `thinking_delta` 无法撤回；未 flush 的缓冲区可能因 abort 而丢失，应计入审计日志。
8. **会话隔离与幂等**。每个 `turnId` 对应独立会话与独立 `AbortController`，取消请求携带 `idempotencyKey` 防止重复提交导致竞态。

## 设计决策与取舍

### 取消是异步信号而非同步状态机
客户端发送取消后，服务端不会立即返回一个“已取消”的最终状态。终端通过 SSE 的 `abort` 事件确认，运维上应关注从触发到事件结束的时间，而非一次 RPC 返回。

### 由 API 持有主 AbortController
浏览器可能崩溃、离线或被系统挂起，因此客户端只负责提交取消意图，服务端负责真正 dispose 会话。这样即使浏览器信号丢失，HTTP 连接断开也能兜底释放资源。

### 显式取消优先，隐式断开兜底
用户主动点击停止时应发送显式 `POST /api/cancel`；`beforeunload` 和 `pagehide` 作为辅助；`req.on('close')` 作为最后防线。三者共享同一个 `AbortController` 以避免重复 dispose。

### 不等待模型 Provider 确认
本地 session 收到 abort 后应立即停止写入 SSE 并关闭流。模型 provider 可能继续产生少量 token，这部分应被标记为 residual 并限制在可接受阈值内。

### 保留已产出结果用于审计
取消后丢弃未完成 tool 的输出，但已经发送到客户端的 delta 和对应 token 计数应保留，用于后续成本、质量与延迟分析。

## 可执行的实施流程

1. Web 客户端为每轮对话创建新的 `AbortController`，并绑定停止按钮、 `beforeunload`、 `pagehide`、 `visibilitychange` 与网络离线事件。
2. 用户点击停止时，先 `controller.abort()` 并 `reader.cancel()` 或 `eventSource.close()`，然后发送 `POST /api/cancel` 携带 `{ turnId, reason: 'stop', idempotencyKey }`。
3. `apps/api` 的 chat route 在收到请求时创建 `AbortController`，并将其与 `sessionManager` 中的当前会话绑定。
4. API 监听 `req.on('close')` 与 `res.on('close')`，任一触发即调用 `abortCtl.abort('http-disconnect')`。
5. 收到显式 cancel 请求时，`sessionManager.get(turnId).abort(reason)` 更新 signal。
6. `packages/pi-agent` 中的 `session.prompt({ signal })` 在 signal 触发时停止迭代 `message_update` 事件，进入 finally 块。
7. finally 块中关闭 SSE writer（`res.end()` 或 `controller.close()`），然后调用 `await session.dispose()` 并记录 `session_cleanup_ms`。
8. 工具执行层（如 `read` 与 `search_knowledge`）将同一个 `AbortSignal` 传入耗时操作，避免继续读取本地文件。
9. 在日志中为每个 SSE 事件添加 `{ turnId, delta_type, aborted_at }` 标签，便于计算取消后的残留 token。
10. 编写集成测试：用 Playwright 在 50 个 token 后触发停止、刷新页面、断开网络，断言服务端会话成功 dispose 且取消后无新 delta。

## 输入、处理与输出示例

```typescript
// apps/api/src/routes/chat.ts
import { createAgentSession } from '@pi-agent';
import { SessionManager } from '@pi-agent/session';

export async function chatStream(req, res) {
  const abortCtl = new AbortController();
  const session = createAgentSession({ cwd: process.cwd() });
  SessionManager.inMemory().set(req.body.turnId, { session, abortCtl });

  req.on('close', () => abortCtl.abort('http-disconnect'));
  res.on('close', () => abortCtl.abort('http-disconnect'));

  try {
    for await (const event of session.prompt({
      prompt: req.body.messages,
      signal: abortCtl.signal,
    })) {
      if (abortCtl.signal.aborted) break;
      res.write(
        `event: message_update\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`
      );
    }
  } finally {
    await session.dispose();
    res.write(`event: abort\ndata: ${JSON.stringify({ reason: abortCtl.signal.reason })}\n\n`);
    res.end();
  }
}
```

输入是用户点击停止或浏览器关闭，浏览器向 API 发送显式 cancel 或 HTTP 连接断开。处理是 `AbortController` 触发，导致 `session.prompt` 的异步迭代终止，工具调用也随 signal 停止。输出是 SSE 发送 `abort` 终止事件，随后连接关闭，服务端日志记录 `reason` 与 `session_cleanup_ms`。

## 性能、质量和可观测性指标

1. **取消延迟（Abort Latency）**。从用户点击停止到服务端 `req.body` 解析出 cancel 的时间，用客户端与服务器 `performance.now()` / `process.hrtime` 差值测量。
2. **残留 token 数（Residual Tokens）**。收到取消后 5 秒内仍然进入 SSE 的 `text_delta` 数量，从日志中按 `turnId` 统计。
3. **会话清理时间（Cleanup Time）**。从 `abort` 触发到 `session.dispose()` resolve 的毫秒数，用于发现会话泄漏或锁竞争。
4. **取消覆盖率（Coverage）**。带有明确 `reason`（stop、unload、disconnect、timeout）的会话占总取消会话的比例。
5. **误取消率（False Abort Rate）**。因浏览器预加载、后退缓存或页面切换触发的非用户显式取消占比，通过 `source` 标签区分。
6. **取消后 API 错误率**。取消后 10 秒内出现 HTTP 5xx 的会话比例，用于检测 dispose 过程中的异常。

## 失败模式、诊断证据与恢复动作

1. **取消未到达 AgentSession**。诊断证据：取消后 `message_update` 仍持续出现，残留 token 数超过阈值。恢复动作：在 `res.on('close')` 中强制调用 `session.dispose()`，并设置最大会话 TTL。
2. **浏览器离开未触发 `beforeunload`**。诊断证据：服务端存在大量 `reason` 为 `http-disconnect` 但无客户端显式 cancel 的会话。恢复动作：同时监听 `pagehide` 与 `visibilitychange`，并在 API 层按心跳超时清理。
3. **Provider 忽略 abort**。诊断证据：本地 SSE 已关闭，但 provider 侧 token 用量仍在增加。恢复动作：关闭 SSE 后给 provider 2 秒宽限期，随后忽略后续事件，仅记录 residual cost。
4. **取消与请求建立竞态**。诊断证据：客户端 `fetch` 在连接建立前被 abort，导致 API 返回 499 或重复 cancel。恢复动作：客户端使用 `idempotencyKey` 重试 cancel，服务端幂等去重。
5. **会话隔离失败**。诊断证据：一个 `turnId` 的取消导致另一个会话的 SSE 中断。恢复动作：确保 `SessionManager` 按 `turnId` 绑定独立 `AbortController`，禁止跨请求共享 session。

## 问答测试样例

1. **正向问题**：用户点击停止后，哪些组件必须收到取消信号？
   回答：客户端 `fetch`、SSE reader、API 路由、session manager、`AgentSession` 以及在途工具都应收到同一个 `AbortSignal` 的传播。证据来自全链路 trace 日志。

2. **边界问题**：页面在模型思考阶段被关闭，已产生的 `thinking_delta` 是否会被保留？
   回答：已 flush 到 SSE 的 `thinking_delta` 会到达客户端；未 flush 的缓冲区可能随 abort 丢失。判断证据是 SSE 事件序列号与 `aborted_at` 时间戳。

3. **边界问题**：HTTP 连接断开但客户端没有发送显式 cancel，会话是否会释放？
   回答：会。API 监听 `req.on('close')` 与 `res.on('close')` 作为兜底。证据是服务端日志中的 `reason: 'http-disconnect'` 与 `session_cleanup_ms`。

4. **边界问题**：取消后是否还会产生费用？
   回答：取决于 provider 是否继续生成 token。本地 SSE 会立即停止，但 provider 可能产生 residual token。证据是 provider 账单或 token usage 日志。

5. **无证据拒答条件**：取消能否保证模型立即停止推理？
   回答：除非 provider 返回明确的停止确认事件，否则不能断言。项目级实现只能保证本地 session 停止输出。

6. **无证据拒答条件**：所有浏览器平台都会触发 `beforeunload` 吗？
   回答：不能断言。移动端 PWA 与后台冻结行为差异较大，需通过覆盖率指标验证，而非依赖单一事件。

## 维护、版本、来源与相邻主题

相关代码位于 `apps/api`、`apps/web` 与 `packages/pi-agent`。SDK 版本为 `@earendil-works/pi-coding-agent@0.83.0`，应以该版本实际 API 为准。项目知识来源包括 `AGENTS.md`、`.pi/knowledge` 与 `docs/pi-agent-learning.md`。相邻主题包括 SSE 流式传输与背压、重试与幂等设计、工具超时与资源隔离、会话注册表生命周期、以及错误分类体系。取消与这些主题的边界是：取消只负责停止后续输出，不替代重试，也不提供事务回滚。

## 结论

**事实**：`AbortController` 与 `AbortSignal` 能够将用户停止、浏览器离开与 API 中止统一传递；服务端 `req.on('close')` 与 `res.on('close')` 是兜底释放机制；`session.dispose()` 是释放本地资源的确定性动作。

**推论**：将取消事件显式发送给服务端，并保留会话级别的 `AbortController`，可以显著降低 orphan session 与资源泄漏概率；Provider 的 residual token 可通过超时阈值进行工程控制。

**未知**：具体模型 provider 在收到 abort 后需要多长时间真正停止推理，不同浏览器对 `beforeunload` 与 `pagehide` 的触发一致性，以及取消在高并发下的长尾延迟分布，都需要通过实际可观测数据验证，不能仅凭单次成功请求推断。
