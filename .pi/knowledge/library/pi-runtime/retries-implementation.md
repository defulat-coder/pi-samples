---
type: concept
title: 中止与重试：实现视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。模型重试、工具失败、客户端断开和最终收敛的处理策略
resource: .pi/knowledge/library/pi-runtime/retries-implementation.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, retries, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: retries
variant: implementation
---

# Pi Agent 运行时中止与重试机制：会话层生命周期与收敛策略

## 摘要与问题边界

本文从实现视角描述单个 Web 会话内的中止与重试。优先明确输入、输出、错误、生命周期和验证步骤，再进入编码。输入：用户消息、模型响应流、工具调用结果、SSE 连接状态、重试配置；输出：SSE 事件流、最终会话状态、错误码、已释放资源；错误：模型错误、工具超时、网络异常、客户端断开、验证失败；生命周期：创建、streaming、tool_pending、retrying、completed、aborted、error；验证步骤：状态转换矩阵、错误分类表、事件序列号、收敛边界测试。边界限定为单次 `AgentSession`：处理模型重试、工具失败、客户端断开、最终收敛；不包含跨会话持久化、浏览器重连恢复、模型训练层再对齐。

## 核心概念与数据模型

1. `SessionState`：枚举 `idle`、`streaming`、`tool_pending`、`retrying`、`aborted`、`completed`、`error`。状态转换由事件驱动，`aborted` 不可逆；`completed` 仅在流正常结束且最终答案提取成功后进入。
2. `RetryContext`：含 `attemptNumber`（从 1 开始）、`maxAttempts`、`backoffMs`、`lastError`、`category`（`model`/`tool`/`transport`/`client`）、`retryable`。每次重试前用当前状态重新生成，旧 context 只读。
3. `ToolExecution`：含 `toolCallId`（模型生成）、`name`、`args`（JSON 对象）、`startTime`（Unix ms）、`timeoutMs`、`status`（`pending`/`success`/`error`/`timeout`/`aborted`）、`result` 或 `error`。用于去重、追踪和幂等判断。
4. `StreamEvent`：统一事件类型，包括 `text_delta`、`thinking_delta`、`tool_execution_start`、`tool_execution_end`、`error`、`lifecycle_retry`、`lifecycle_abort`、`lifecycle_complete`。每个事件带 `sequenceNumber` 和 `sessionId`。
5. `AbortSignal`：由客户端 HTTP 断开或显式 cancel 触发，级联取消模型调用 Promise 与工具进程。触发后任何新重试请求都应被拒绝。
6. `ConvergenceGuard`：含 `tokenBudget`、`maxModelRounds`、`duplicateToolCallDetector`、`finalAnswerExtractor`。命中边界时强制终止，并向模型注入系统提示要求总结。

## 设计决策与取舍

1. **重试层放在会话层而非模型客户端**。判断：provider 客户端若内部重试，上层无法观测次数，易引发重试风暴；会话层可统一记录、分类、退避。例外：若底层 SDK 已实现标准化退避，可将其结果视为非重试，但本项目不依赖。
2. **客户端断开默认 abort 级联**。判断：浏览器刷新或关闭 TCP 后，继续占用模型 token 与工具进程无明确消费者。例外：工具在 `defineTool()` 中声明 `continueOnDisconnect: true`，仅适用于无状态或幂等长任务，结果不保证回传。
3. **退避策略按错误类别区分**。模型错误（429、5xx）使用指数退避 `1s, 2s, 4s`；工具网络错误使用线性退避 `2s, 2s`；客户端断线事件永不重试，直接生命周期结束。
4. **收敛判定由代码 guard 做硬边界，模型仅辅助检测**。判断：完全依赖模型自判容易在工具循环中消耗 token。`maxModelRounds` 或 `tokenBudget` 耗尽时强制返回错误，并注入提示要求最终答案。
5. **错误可重试性由错误码表决定**。HTTP 429、408、5xx 以及 `ECONNRESET` 可重试；400（除 408/429）、422 工具 schema 验证失败、客户端主动断开为不可重试。码表必须在单元测试中覆盖。

## 可执行实施流程

1. 在 `packages/pi-agent` 中定义 `SessionState` 类型与状态转换矩阵，并写入单元测试，验证非法转换抛出异常。
2. 实现 `classifyError(error: unknown): RetryDecision`，根据错误码、错误消息、`error.code` 映射到 `model`、`tool`、`client` 三类。
3. 将模型调用包装为 async generator，捕获异常后 yield `lifecycle_retry` 事件，再按退避表等待后重新调用。
4. 将工具调用包装为 `Promise.race([toolPromise, timeoutPromise])`，接受外部 `AbortSignal`，超时状态返回 `ToolExecution`。
5. 在 SSE 路由中监听 `req.on('close')`，触发 `session.abort()` 并发送 `lifecycle_abort`，然后释放资源。
6. 实现 `ConvergenceGuard`：每轮记录 token 增量、工具调用 ID 集合、重复调用检测，并在边界命中时强制终止。
7. 实现事件归一化器：将 Pi SDK 的 `message_update`、`tool_execution_start` 等映射到 `StreamEvent`，再写入 SSE 响应。
8. 编写集成测试桩：模型 429 连续触发、工具超时、客户端断开、重复调用循环、token 预算耗尽、schema 验证失败。

## 配置示例

`apps/api/src/config/retry.json` 示例：

    {
      "retryPolicy": {
        "model": { "maxAttempts": 3, "backoff": "exponential", "baseMs": 1000 },
        "tool": { "maxAttempts": 2, "backoff": "linear", "baseMs": 2000 },
        "clientDisconnect": { "retry": false }
      }
    }

输入：模型或工具抛出的错误；处理：会话层按错误类别查表，计算退避时长，递增 `attemptNumber`，并在 `abort` 信号触发时立即拒绝；输出：要么再次调用模型或工具，要么生成 `lifecycle_error` 事件并终止。`continueOnDisconnect` 在工具元数据中声明，不由请求端随意指定。

## 性能、质量与可观测性指标

1. `retry_latency_ms`：每次重试等待时长，用直方图分位。测量：在退避等待前后记录时间戳。
2. `model_rounds_until_completion`：从用户消息到最终答案的模型轮数。测量：`ConvergenceGuard` 维护计数器。
3. `tool_failure_rate`：失败工具调用数 / 总调用数。测量：按 `ToolExecution.status === 'error' | 'timeout'` 统计。
4. `client_disconnect_rate`：`lifecycle_abort` 中 `reason === 'client_disconnect'` 的会话比例。
5. `session_error_rate`：最终状态为 `error` 的会话 / 总会话。测量：会话关闭时记录状态。

## 失败模式、诊断证据与恢复动作

1. **模型 rate limit 连续触发**。诊断证据：HTTP 429 或 provider 错误消息含 `rate_limit`。恢复：指数退避重试，3 次失败后转 `error` 状态并发送 `lifecycle_error`。
2. **工具超时但结果非幂等**。诊断证据：`ToolExecution.status === 'timeout'` 且工具元数据 `idempotent === false`。恢复：不再重试，向模型返回错误描述，由模型决定下一步。
3. **客户端在工具执行中刷新页面**。诊断证据：`req.on('close')` 触发且 `SessionState` 为 `tool_pending`。恢复：默认 abort 工具进程；若工具声明 `continueOnDisconnect: true`，则保留后台进程，但新会话不继承结果。
4. **重复工具调用导致循环**。诊断证据：`duplicateToolCallDetector` 在 `maxModelRounds` 内命中相同 `toolCallId` 或相同 `(name, args)` 三次。恢复：强制终止并提示模型给出最终答案，否则返回 `error`。
5. **工具结果 schema 验证失败**。诊断证据：Zod parse 失败返回 422。恢复：不可重试，构造验证错误消息返回模型，让其在下一轮修正。

## 问答测试样例

1. 正向：模型第一次返回 429，第二次成功，用户会看到什么？ 答：客户端先收到 `lifecycle_retry` 事件，随后继续正常 `text_delta`。
2. 边界：模型连续三次 429，系统如何处理？ 答：状态转 `error`，发送 `lifecycle_error`，携带最终错误码。
3. 边界：客户端在工具执行时断开，但工具声明 `continueOnDisconnect: true`，结果会回传吗？ 答：不保证回传到新会话，旧会话已关闭。
4. 正向：如何检测并终止工具循环？ 答：`ConvergenceGuard` 的重复调用检测或 `maxModelRounds` 边界触发。
5. 无证据：Pi SDK 内部如何实现重试？ 答：项目未访问 Pi SDK 源码，仅依据 SDK 文档与本项目约定回答。
6. 无证据：浏览器断开后能否恢复同一会话？ 答：超出本文边界，当前项目不实现跨会话持久化。

## 维护、版本、来源与相邻主题

来源依据为项目根目录 `AGENTS.md` 与 `packages/pi-agent` 对 `@earendil-works/pi-coding-agent@0.83.0` 的调用。版本策略：Pi SDK 升级后必须重新验证事件协议和 `AgentSession` 构造签名。相邻主题包括：会话创建与销毁（`createAgentSession`、`SessionManager`）、工具注册（`defineTool`）、SSE 传输契约（`packages/contracts`）、项目知识检索（`search_knowledge`）。

## 结论

事实：本文的实现边界为单 Web 会话；重试策略可通过配置表修改；客户端断开默认 abort；`ConvergenceGuard` 提供硬收敛边界。推论：将重试层置于会话层比下沉到模型客户端更利于观测与资源控制；重复工具调用检测可减少无意义 token 消耗。未知：不同 provider 的 429 细节与错误消息映射是否长期稳定；长任务在断开后允许占用的资源上限需要由运维策略额外定义。
