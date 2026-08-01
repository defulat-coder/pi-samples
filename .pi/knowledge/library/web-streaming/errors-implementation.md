---
type: concept
title: 错误事件：实现视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。保留可诊断错误，同时避免把内部凭据和堆栈泄露给浏览器
resource: .pi/knowledge/library/web-streaming/errors-implementation.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, errors, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: errors
variant: implementation
---

# 在 Web 流式交互中保留诊断错误并阻止内部凭据泄露的实现方案

## 摘要与问题边界

Web 流式交互通常通过 SSE 或 JSON Lines 将服务器端生成的消息增量推送到浏览器。一旦流中发生异常，错误事件必须在两个互相冲突的目标之间取得平衡：一方面，客户端需要足够信息判断是否需要重试、终止或降级；另一方面，服务器内部的凭证、路径、模型调用细节和堆栈不能随错误事件泄露。本方案面向使用 TypeScript 实现浏览器到 API 的流式会话系统，重点解决错误事件的结构、分类、脱敏、生命周期和可验证输出，而不是泛泛地讨论错误处理的重要性。

问题边界限定在：服务器到浏览器的单向流；错误发生在连接建立、握手、协议解析、模型运行、工具执行或客户端解析阶段；方案不涉及第三方网络中间件自身的 TLS 或 DNS 故障，但涉及这些故障在应用层的映射。

## 核心概念与数据模型

1. **错误事件 envelope**：这是唯一被允许发送到浏览器的对象。必须包含 `streamId`、`requestId`、`eventType: "error"`、`category`、`safeMessage`（已由脱敏层处理）、`retryable`（布尔值）、`timestamp`（ISO 字符串）、`sequenceNumber`（流内序号）、`logReference`（服务端日志定位标识）。不允许包含 `stack`、`rawError`、`args`、`toolResults`、`modelProvider` 等内部字段。

2. **错误分类枚举**：`TRANSPORT`（连接层）、`PROTOCOL`（消息格式或序列错误）、`AUTHN`（身份验证）、`AUTHZ`（权限）、`RATE`（限流）、`MODEL`（模型运行或 provider 返回异常）、`TOOL`（工具执行失败）、`CLIENT`（浏览器解析错误）、`UNKNOWN`（兜底）。分类决定脱敏策略和客户端响应方式。

3. **严重程度与重试语义**：`FATAL` 表示连接必须关闭，客户端不应自动重试；`RETRYABLE` 表示服务器期望客户端按给定退避重新建立流；`WARNING` 表示可在当前流中继续，但部分内容不可用；`INFO` 仅作提示。服务器必须在 `safeMessage` 之外显式声明 `retryable` 和 `backoffMs`。

4. **诊断上下文**：服务器本地日志保存完整记录，字段包括 `correlationId`（贯穿请求、会话、流）、`rawError`（原始 Error 对象）、`stack`（完整堆栈）、`truncatedArgs`（截断后的调用参数，凭证字段已标记为 `<redacted>`）、`toolExecutionId`、`modelProviderName`、`hasCredential`（布尔）、`hasFilesystemPath`（布尔）。该记录只写入日志系统，不进入 SSE。

5. **脱敏管道**：由 denylist（正则与字面量敏感词）、allowlist（安全字段白名单）、路径 scrubber、token detector 组成。denylist 覆盖 provider API key、数据库连接串、本地绝对路径、JWT 签名段、环境变量名；allowlist 保证 envelope 内只保留上述八个字段；token detector 对任意疑似凭证的子串做一致性哈希替换。

6. **错误生命周期状态机**：`idle -> connecting -> open -> streaming -> erroring -> closed`；另外有 `retrying` 作为客户端本地状态。每个状态只能由特定事件触发，例如 `PROTOCOL` 错误只能在 `streaming` 阶段发生，而 `AUTHN` 错误通常在 `open` 之前即被写出并直接关闭。

## 设计决策与取舍

### 1. 连接层错误与载荷层错误必须分层
连接层错误（如 TCP 断开、SSE 头失败）通常由浏览器 `EventSource.onerror` 捕获，应用层无法附加详细信息。设计中将这类错误映射为 `category: TRANSPORT`、无 `safeMessage` 具体文本、只提供 `logReference`，避免在不可靠的连接层暴露应用上下文。载荷层错误（如模型返回非法 JSON）则通过 `data:` 字段中的 envelope 发送，可被客户端精确解析。

### 2. 诊断能力与隐私的边界在服务端日志
客户端只能拿到 `logReference` 和 `category`。完整堆栈和参数由服务器写入日志。取舍在于：运维排障需要主动去日志系统按 `correlationId` 搜索，无法像本地开发那样直接让前端复制堆栈。这是为了阻断通过浏览器网络面板或用户截图泄露内部信息。

### 3. 重试语义由服务器声明，客户端执行
服务器决定错误是否 `retryable` 以及退避时间。客户端不应对 `FATAL` 或 `category: AUTHN` 的响应自动重试。取舍是：客户端代码必须内建分类拒重试表，避免 401 或 403 触发无限重连。这是安全与可用性的关键折中。

### 4. 同步校验必须在首字节之前完成
schema、auth、rate limit 等校验应在流式响应开始前完成。如果校验失败，直接返回 HTTP 响应（或 SSE 建立后立即关闭），不要在流中间发送 `safeMessage` 为“校验失败”后再混合业务数据。这样可防止浏览器把不完整流当作成功结果。

### 5. 工具错误只能暴露工具执行标识
当 `tool_execution_end` 失败时，浏览器侧只能看到 `toolExecutionId` 和 `category: TOOL`。工具返回的真实异常、文件路径、命令输出全部进入服务端诊断上下文。取舍是：用户如果需要定位某次工具失败，必须向运维提供 `requestId` 和 `toolExecutionId`，不能通过 UI 自行查看敏感内容。

## 可执行的实施流程

1. 在 `packages/contracts` 中定义 `StreamErrorEnvelope` 和 `ErrorCategory` 的 Zod 或 JSON Schema，并声明字段 allowlist；在 `apps/api` 中引用，确保浏览器侧收到的对象可被验证。
2. 在 `packages/pi-agent` 中创建 `StreamErrorService`，职责是：接收任意 `unknown` 异常、执行分类、调用脱敏器、分配 `logReference`、返回供 SSE 写入的 envelope 与供日志写入的诊断记录。
3. 实现 `RedactionEngine`：维护 denylist 正则列表，例如 `/sk-[a-zA-Z0-9]{48}/` 用于 OpenAI 风格 key；`/([A-Z]:\\|\/home\/|\/Users\/)[^\s]+/` 用于路径；对 JSON 对象递归遍历，只保留 allowlist 字段，其余字段替换为 `[REDACTED]`。
4. 在 `apps/api` 中建立日志 sink，将诊断记录以结构化 JSON 写入，包含 `correlationId`、`rawError.name`、`stack`、`truncatedArgs`、`hasCredential`、`hasFilesystemPath`。日志保留策略由运维配置，与浏览器响应完全解耦。
5. 在 SSE writer 中统一 `try/catch`：任何未被捕获的异常交给 `StreamErrorService`，先写出 `event: error` 的 envelope，再 `flush()`，随后根据 `retryable` 决定是继续流还是关闭连接。
6. 浏览器端实现 `StreamErrorParser`：把 `error` 事件解析为 `StreamErrorEnvelope`，更新状态机，调用 `onError` 回调；UI 只渲染 `safeMessage`，将 `logReference` 放在可复制的“报告问题”按钮中。
7. 客户端实现重试策略：读取 `retryable` 和 `backoffMs`，使用指数退避并设置最大尝试次数；维护 `fatalCategories` 表，遇到 `AUTHN`、`AUTHZ`、`PROTOCOL` 中的致命错误时立即进入 `terminated` 状态。
8. 在 `apps/api` 与 `apps/web` 之间编写集成测试：模拟 malformed chunk、provider 异常、包含凭证的工具输出，断言浏览器接收到的数据不含 denylist 匹配项。
9. 引入性能测试：测量从异常发生到 envelope 被写出的 p99 延迟，以及脱敏器对 1KB 异常字符串的处理耗时。
10. 编写运维 runbook：根据 `logReference` 和 `category` 在日志系统中定位原始记录，定义升级路径；每次 schema 更新时同步版本号。

## 输入、处理、输出示例

```typescript
// 输入：服务端捕获的原始异常
const rawError = new Error(
  "model provider failed: request to https://api.example.com/v1/chat failed " +
  "with key [REDACTED_EXAMPLE_KEY]"
);
const toolContext = {
  toolExecutionId: "tool-7",
  args: { filePath: "/Users/xbjt/secret/project.env" },
  provider: "internal-gpt-4"
};

// 处理：StreamErrorService 执行分类与脱敏
const envelope = streamErrorService.map(rawError, {
  streamId: "stream-42",
  requestId: "req-99",
  category: "MODEL",
  toolContext
});

// 输出：仅发送到浏览器
{
  "eventType": "error",
  "streamId": "stream-42",
  "requestId": "req-99",
  "category": "MODEL",
  "safeMessage": "model provider failed: request to <URL> failed with key <REDACTED>",
  "retryable": true,
  "backoffMs": 1000,
  "sequenceNumber": 17,
  "timestamp": "2026-08-11T09:23:47.123Z",
  "logReference": "err-req-99-seq-17"
}

// 同时输出：仅写入服务端日志
{
  "correlationId": "req-99",
  "category": "MODEL",
  "logReference": "err-req-99-seq-17",
  "rawError": "Error: model provider failed...",
  "stack": "...",
  "truncatedArgs": { "toolExecutionId": "tool-7", "args": { "filePath": "<REDACTED>" } },
  "hasCredential": true,
  "hasFilesystemPath": true,
  "providerName": "internal-gpt-4"
}
```

输入是服务端捕获的未处理异常及其执行上下文；处理层首先判断 `category` 为 `MODEL`，再递归扫描字符串和参数，将 URL 和 key 替换为占位符；输出到浏览器的是精简且安全的 envelope，输出到日志系统的是保留完整诊断信息的记录。

## 性能、质量和可观测性指标

1. **clientVisibleErrorRate**：单位时间内浏览器收到的 `error` 事件数除以总流数。在 SSE writer 中计数，通过 `/metrics` 暴露。
2. **credentialLeakFalseNegativeRate**：CI 中向测试流注入已知敏感字符串，扫描浏览器侧捕获的 SSE 报文，统计未命中 denylist 的占比。目标为 0%。
3. **logCorrelationCoverage**：对前端“报告问题”携带的 `logReference`，在服务端日志中能否在 5 秒内找到完整记录。通过抽样查询测量。
4. **redactionLatency**：从异常抛出到 `StreamErrorService` 返回 envelope 的 p99 耗时。可在单元测试和运行时 histogram 中测量。
5. **retryableResolutionTime**：从 `retryable` 错误事件发出到客户端成功重建流并收到第一条业务数据的时间。通过浏览器性能标记和服务器日志联合计算。

## 失败模式与恢复动作

1. **堆栈或路径随 safeMessage 泄露**。诊断证据：在浏览器 DevTools 的 EventStream 中能看到文件路径、行号或模块名。恢复动作：收紧 `RedactionEngine` 中的路径正则，并在 CI 中增加对真实项目路径的 fuzz 测试。
2. **客户端对致命错误无限重试**。诊断证据：同一 `requestId` 在短时间内反复出现相同 `category` 的错误事件。恢复动作：客户端把 `AUTHN`、`AUTHZ`、`PROTOCOL` 加入 fatal 表，并引入 circuit breaker，服务端在 fatal 情况下关闭连接后不再接受同一 token 的重连。
3. **correlationId 丢失导致无法排障**。诊断证据：日志中找不到对应 `logReference` 的记录。恢复动作：在 `StreamErrorService` 输出前强制校验 envelope schema，若缺少 `requestId` 或 `logReference` 则抛出内部错误，阻止流继续。
4. **SSE 事件在中途丢失，浏览器挂起**。诊断证据：客户端在 `streaming` 状态超过预期超时时间未收到 `message_update` 或 `heartbeat`。恢复动作：服务端每 15 秒发送 `event: heartbeat`，客户端超时未收到则按 `retryable` 重建连接。
5. **工具返回的 JSON 中携带凭证**。诊断证据：工具执行结果在服务端日志中 `hasCredential` 为 true，而浏览器侧的 `tool_execution_end` 事件却已包含未脱敏字段。恢复动作：工具事件序列化也走 `RedactionEngine`，而不是仅在错误路径脱敏。

## 问答测试样例

1. 正向问题：浏览器收到的错误事件必须包含哪些字段？
   回答：必须包含 `streamId`、`requestId`、`eventType`、`category`、`safeMessage`、`retryable`、`timestamp`、`sequenceNumber`、`logReference`，共九个字段，且不包含堆栈或凭证。

2. 边界问题：如果 `safeMessage` 原始内容中已经包含 `/Users/xbjt/secret` 这样的路径，脱敏器会怎么做？
   回答：路径正则会匹配该字符串并替换为 `<REDACTED>`，同时日志记录中 `hasFilesystemPath` 置为 true。

3. 边界问题：一个 `RETRYABLE` 的 `MODEL` 错误发生在第一条数据已经写出之后，服务器应如何处理？
   回答：服务器应写出 `error` 事件并关闭当前流，客户端根据 `backoffMs` 重新建立新流，而不是在同一条流中继续发送错误后的业务数据。

4. 无证据拒答：这个方案使用了哪些具体模型 provider 的 API key 格式？
   回答：文档未提供真实 key 格式；方案只声明 denylist 正则应由项目维护，不推断未给出的 provider 细节。

5. 正向问题：如何验证错误事件没有泄露内部凭证？
   回答：在 CI 中构造包含已知敏感字符串的异常，启动测试流，抓取浏览器侧收到的所有 SSE 数据，使用与生产相同的 denylist 扫描，确保命中率为 100%。

6. 边界问题：客户端是否可以忽略 `retryable: false` 而自行重试？
   回答：不可以。客户端必须严格按服务器声明执行，否则会导致无限重试并扩大故障面；实现中应通过状态机把 fatal 错误锁定为 `terminated`。

## 维护、版本、来源与相邻主题关系

错误事件 schema 应跟随 `packages/contracts` 的版本号发布。每次新增字段必须保持向后兼容：旧字段不得删除，新字段可缺省。主要来源文件包括 `packages/contracts/src/stream-error.ts`、`packages/pi-agent/src/stream-error-service.ts`、`apps/api/src/sse-writer.ts` 和 `apps/web/src/stream-error-parser.ts`。

与本主题相邻的主题包括：流式消息增量协议（`message_update`、`thinking_delta`、`toolcall_*`）、会话生命周期（连接、订阅、关闭、重连）、工具执行事件序列化、认证与限流中间件、客户端状态机。错误事件不应替代认证层的 401 响应，也不应重复包含 `message_update` 的 payload。

## 结论

事实：Web 流式交互中的错误事件必须被建模为结构化 envelope，并且浏览器侧只能包含 `safeMessage` 和 `logReference` 等安全字段；服务端日志保留完整堆栈和上下文，脱敏由 `RedactionEngine` 执行。

推论：只要 `StreamErrorService` 在写入 SSE 前统一拦截所有异常，并让客户端在收到 `retryable: false` 时终止重试，就能同时满足诊断性与保密性；路径与凭证泄露的风险可在 CI 中通过扫描敏感字符串覆盖。

未知：具体业务中哪些字段应进入 allowlist 取决于实际工具签名与模型响应格式，需在项目内通过代码审计和运行测试确定；不同浏览器对 SSE 重连行为的默认差异可能影响 `retryable` 策略的实际效果，应通过集成测试收集数据。
