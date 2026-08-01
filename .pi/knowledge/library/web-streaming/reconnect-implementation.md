---
type: concept
title: 断线重连：实现视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。区分可恢复的连接断开、已完成 turn 和不可重放的流
resource: .pi/knowledge/library/web-streaming/reconnect-implementation.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, reconnect, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: reconnect
variant: implementation
---

# Web 流式交互的断线重连：可恢复连接、已完成 Turn 与不可重放流的区分

## 摘要与问题边界

断线重连不是“连接断了再连一次”的同义反复。在 Web 流式交互中，它要解决三个互不相同的问题：第一，传输层在 turn 进行过程中断开，但业务状态仍可在服务器端恢复；第二，turn 已经在服务器端完成，客户端需要拿到结果，却不必重演整段流；第三，流本身依赖外部一次性资源，无法重放。本文档从 TypeScript 实现视角出发，先明确输入、输出、错误、生命周期和验证步骤，再给出可执行代码。

范围限定在浏览器-服务器-模型提供者的三方架构，传输层以 SSE 为主、WebSocket 为辅，状态持久化假设使用服务器端内存或短周期 KV 存储。不涉及浏览器原生 WebRTC 或 MQTT 的传输细节。

## 核心概念与数据模型

1. **Session**：一次用户登录后的逻辑对话容器，由 `sessionId` 唯一标识。同一 Session 可以包含多个 Turn，但断线重连只关心当前未完成或最近完成的 Turn。

2. **Turn**：一次请求-响应循环。在流式场景中，一个 Turn 起始于客户端发送 `prompt` 事件，终止于服务器发送 `turn_end` 事件。Turn 一旦结束，服务器将其标记为 `completed`，后续重连不应再按流式重放。

3. **Connection**：传输层对象，具有生命周期 `connecting`、`open`、`closing`、`closed`。断线重连只处理 `open` 到 `closed` 的迁移，不处理初始连接失败。

4. **Event**：服务器向客户端发送的最小数据单元，结构为 `{ id, turnId, type, payload, retryable }`。`id` 是单调递增的序列号，`type` 包括 `text_delta`、`tool_execution_start`、`tool_execution_end`、`turn_end`。

5. **Checkpoint**：客户端在本地记录的最大已确认 `event.id`。重连请求携带 `lastEventId`，服务器从该 id 的下一个事件开始推送。

6. **ResumeToken**：客户端生成的 JWT 或加密字符串，包含 `sessionId` 和过期时间，用于重新建立连接时定位 Session。它不是业务凭证，仅用于连接恢复。

7. **Replayable**：一个布尔属性，表示某段流是否可以在不触发副作用的前提下重演。`tool_execution_start/end` 这类事件本身只报告状态，因此可重放；但触发外部支付、写入数据库等工具调用本身不可重放，重连时只能重放其事件信封，不能重新执行。

## 设计决策与取舍

### 1. 状态由服务器持有，客户端只保留 Checkpoint

客户端在本地 IndexedDB 或 `sessionStorage` 中只保留 `sessionId`、`lastEventId`、`resumeToken` 和未渲染的文本缓冲区。事件全序、工具执行结果、外部 LLM 的原始流由服务器维护。取舍：客户端离线超过 TTL 后必须接受状态丢失，不能要求浏览器无限缓存。

### 2. 强制 Event ID 与幂等键

每个客户端发送的 `prompt` 必须携带 `idempotencyKey`（UUID v4）。服务器在事件日志中按 `idempotencyKey` 去重。重连时，如果服务器已经见过该 key，则返回已缓存结果，而不是再次调用模型。副作用：需要在服务器端维护一个短期去重表，TTL 建议与 Session TTL 一致。

### 3. 已完成 Turn 走摘要通道

当服务器发现 `turn_end` 已经发出，且当前请求是 resume，则返回 `turn_summary` 事件而不是逐条重放 `text_delta`。摘要包含最终文本、工具调用列表、token 用量。如果业务要求保留完整流，则提供 `replay_log` 接口，但默认不自动重放，以节省带宽和延迟。

### 4. 不可重放流直接降级

如果外部模型提供者不提供流回放能力，且服务器端未做缓存，则重连请求返回 `426 Upgrade Required` 或自定义错误码 `NON_REPLAYABLE_STREAM`，客户端必须进入“重新发起 prompt”的降级路径。这里不假装能恢复。

### 5. 连接层与业务层错误分离

`EventSource` 或 `WebSocket` 的 `onerror` 只代表传输层断开。业务层错误，例如模型返回 429、工具执行失败，仍然通过 SSE 的 `error` 事件正常下推，并在重连时从断点恢复。不要把 HTTP 500 与连接断开混为一谈。

### 6. 重试策略在客户端，退避上限在服务器

客户端使用指数退避加抖动，但服务器在 `resumeToken` 或 `Retry-After` 头部中给出最大等待窗口，防止客户端在维护期间无限重试。

## 可执行的实施流程

1. 在 `packages/contracts` 中定义 `StreamEvent` 和 `ResumeRequest` DTO，明确 `id`、`turnId`、`type`、`retryable`、`idempotencyKey` 字段。

2. 在 `apps/api` 中建立 `SessionStore` 接口，至少实现 `getTurn(sessionId, turnId)`、`appendEvent(turnId, event)`、`getEventsSince(turnId, lastEventId)`。

3. 客户端在发起首次 prompt 前生成 `idempotencyKey` 和 `resumeToken`，将 `resumeToken` 写入 `sessionStorage`，以便刷新页面后仍可恢复。

4. 服务器在收到 `prompt` 时，先检查 `idempotencyKey` 是否已存在。存在则直接返回缓存；不存在则创建新 Turn 并记录起始事件。

5. 客户端在 SSE `onMessage` 中维护 `lastEventId`，每收到 5 个事件或遇到 `turn_end` 时向服务器发送一次轻量 ack。ack 通过独立的 `POST /ack` 完成，避免 SSE 单向通信的确认问题。

6. 当检测到 `onError` 或 `readyState === CLOSED` 时，客户端停止渲染，显示“恢复中”状态，携带 `resumeToken` 和 `lastEventId` 向 `POST /resume` 发起重连请求。

7. 服务器在 `/resume` 中执行以下分支：
   - 如果 Turn 状态为 `in_progress` 且事件存在，则从 `lastEventId + 1` 开始重放；
   - 如果 Turn 状态为 `completed`，则返回 `turn_summary`；
   - 如果事件已被 GC 或外部流不可重放，则返回 `NON_REPLAYABLE_STREAM` 错误；
   - 如果 `resumeToken` 过期或 `sessionId` 不匹配，则返回 `401` 并删除客户端本地 token。

8. 客户端收到重放事件后，与本地缓冲区做 id 去重，只追加 `id > lastEventId` 的事件，并更新 `lastEventId`。

9. 如果收到 `turn_summary`，则渲染最终内容，清理本地缓冲区，保留会话历史。

10. 如果收到 `NON_REPLAYABLE_STREAM`，则提示用户“当前回答无法续传，是否重新提问”，并复用原 `idempotencyKey` 防止重复扣费。

11. Turn 结束后，服务器将事件日志归档到持久存储，内存中的可重放缓冲区在 TTL 后清除。

12. 在单元测试中覆盖三种分支：连接中断后恢复、已完成 turn 返回摘要、不可重放流触发降级。

## 配置与状态示例

以下示例说明 `/resume` 的输入、处理、输出格式。

输入 `POST /resume` 的 JSON 体：

```json
{
  "resumeToken": "eyJhbGciOiJIUzI1NiIs...",
  "sessionId": "sess_7c9a2b",
  "turnId": "turn_3f1e",
  "lastEventId": 12,
  "idempotencyKey": "idemp_a1b2c3d4"
}
```

处理：服务器解码 `resumeToken`，校验 `sessionId` 与 `turnId` 是否匹配；查询 Turn 状态。若状态为 `in_progress` 且事件 13 到 20 存在，则打开 SSE 连接并推送这些事件。

输出 SSE 流：

```json
{
  "id": 13,
  "turnId": "turn_3f1e",
  "type": "text_delta",
  "payload": { "text": "后续内容..." },
  "retryable": true
}
```

若 Turn 已完成，则输出：

```json
{
  "id": 21,
  "turnId": "turn_3f1e",
  "type": "turn_summary",
  "payload": {
    "finalText": "完整回答。",
    "toolCalls": [],
    "usage": { "promptTokens": 120, "completionTokens": 400 }
  },
  "retryable": true
}
```

## 性能、质量和可观测性指标

1. **重连成功率**：`resume_success / resume_attempts * 100%`。要求大于 95%，其中失败主要应来自 token 过期，而非代码缺陷。

2. **断点精度**：重放时重复发送的事件数占总事件数的比例，目标低于 1%。通过比较 `lastEventId` 与服务器实际发送的最小 id 测量。

3. **重连延迟**：从 `onError` 到收到第一个恢复事件的中位时间，目标低于 300ms，P99 低于 2s。

4. **已完成 Turn 的带宽节省**：摘要大小与完整流大小的比值，目标低于 10%。

5. **不可重放流比例**：`NON_REPLAYABLE_STREAM` 次数占总重连次数比例，需持续监控，若超过 5% 应评估服务端缓存策略。

6. **客户端状态漂移**：客户端 `lastEventId` 与服务器实际事件总数的最大差值，超过 50 时触发告警。

## 失败模式、诊断证据与恢复动作

1. **浏览器冻结导致 resumeToken 过期**
   - 证据：`/resume` 返回 `401`，`resumeToken` 中 `exp` 已过期。
   - 恢复：删除本地 token，提示用户重新输入 prompt，复用原 `idempotencyKey` 避免重复调用。

2. **服务器事件日志被 GC 截断**
   - 证据：`/resume` 返回 `NON_REPLAYABLE_STREAM`，日志中 `lastEventId` 早于缓冲区最小 id。
   - 恢复：客户端降级，服务器端调整 TTL 或扩大缓冲区。

3. **Turn 已完成但客户端仍请求重放**
   - 证据：Turn 状态为 `completed`，但客户端 `lastEventId < finalEventId`。
   - 恢复：返回 `turn_summary`，客户端结束加载状态。

4. **重复事件导致文本重复渲染**
   - 证据：客户端渲染出现连续两段相同内容，`event.id` 重复。
   - 恢复：客户端在渲染前按 `id` 去重；服务器检查 ack 与重放逻辑。

5. **外部 LLM 流不可重放**
   - 证据：外部提供者返回 `Not supported` 或连接关闭后无事件缓存。
   - 恢复：服务端缓存完整流；若无法缓存，则返回 `NON_REPLAYABLE_STREAM`。

6. **idempotencyKey 冲突导致旧结果被误返**
   - 证据：用户重新输入了不同问题，却得到旧答案。
   - 恢复：`idempotencyKey` 必须由客户端与 prompt 内容一起哈希生成，确保同一问题同一 key。

## 问答测试样例

1. **正向问题**：客户端如何知道可以从断点恢复？
   - 回答：断开前的最后一个事件带有 `id`，且本地保存了未过期的 `resumeToken`，向 `/resume` 发送 `lastEventId` 即可。

2. **正向问题**：已完成 Turn 在重连时返回什么？
   - 回答：返回 `turn_summary` 事件，包含最终文本和元数据，不再逐条推送 `text_delta`。

3. **边界问题**：如果客户端 `lastEventId` 等于服务器最新事件 id，服务器应做什么？
   - 回答：立即返回 `turn_summary` 或等待下一个事件，不应发送空流。

4. **边界问题**：刷新页面后 `resumeToken` 存在但 `lastEventId` 丢失怎么办？
   - 回答：若 `lastEventId` 缺失，服务器默认从 Turn 起始事件重放；若 Turn 已完成，则返回摘要。

5. **无证据问题**：能否保证所有外部模型流都可重连？
   - 回答：不能。只有当服务器缓存了事件或外部提供者支持回放时才能恢复，否则必须降级。

6. **无证据问题**：断线是否会导致同一工具被多次执行？
   - 回答：工具执行事件本身可重放，但工具执行动作必须由服务器端幂等控制，重连只重放事件报告，不重新触发动作。

## 维护、版本、来源和与相邻主题的关系

本设计随 `@earendil-works/pi-coding-agent` SDK 的 `AgentSession` 事件协议演化。事件类型命名与 SDK 的 `message_update`、`tool_execution_*`、`turn_end` 保持一致。相关主题包括：流式事件协议、会话生命周期管理、SSE 与 WebSocket 传输选择、幂等性设计、外部模型提供者缓存策略。

版本建议：每次修改 `StreamEvent` 结构或 `resumeToken` 格式时，在 `packages/contracts` 中增加类型版本号，并在 API 中保留至少一个向后兼容版本。

## 结论

事实：断线重连必须区分 in-progress Turn、completed Turn 和 non-replayable stream；事件 ID 和 resumeToken 是实现恢复的最小字段集；客户端状态只保留 Checkpoint，权威状态在服务器端。

推论：已完成 Turn 的默认恢复路径应返回摘要而非重放全流；不可重放的外部流必须显式降级而不是静默失败；`idempotencyKey` 与 prompt 内容绑定可以减少误返旧结果。

未知：不同浏览器在后台冻结时的断开时机差异；外部模型提供者是否支持断点续传的官方契约细节；长会话下事件日志存储成本的最优 TTL。
