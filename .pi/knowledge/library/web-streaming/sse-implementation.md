---
type: concept
title: SSE 通道：实现视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。定义 start、thinking、text、tool、done 和 error 的可消费事件
resource: .pi/knowledge/library/web-streaming/sse-implementation.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, sse, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: sse
variant: implementation
---

# SSE 通道：Web 流式交互中的可消费事件设计与 TypeScript 实现

## 摘要与问题边界

SSE（Server-Sent Events）是一种基于 HTTP 的单向服务器推送机制，适用于 Agent、LLM 流式输出、实时通知等场景。本文聚焦于如何在 TypeScript/Web 环境中实现一条可消费的 SSE 通道，并严格定义 `start`、`thinking`、`text`、`tool`、`done`、`error` 六类事件。讨论范围限定在浏览器端 `EventSource` 与服务端 HTTP 响应之间的协议边界，不涉及 WebSocket 的双向协商、HTTP/3 帧细节，也不讨论模型推理本身的训练逻辑。

实现 SSE 通道之前，必须先明确四类输入、三类输出、两类错误和一条生命周期主线。输入包括：客户端请求（含会话 ID、认证凭证、模型参数）、模型运行时产生的增量 token、工具调用的中间结果、以及网络/代理环境带来的延迟与中断。输出包括：结构化 SSE 事件流、连接关闭信号、可重连的会话状态。错误分为协议级错误（如连接断开、格式损坏）和应用级错误（如模型拒绝、工具超时）。生命周期则从 `start` 握手开始，经过 `thinking`、`text`、`tool` 的交错推送，到 `done` 或 `error` 结束，并允许客户端在合理窗口内重连。

## 核心概念与数据模型

1. **SSE 协议帧**：每个事件由 `event:` 类型行、`data:` 载荷行、`id:` 可选标识行和空行组成。`data` 行可以出现多次，浏览器会按换行拼接，因此载荷内部不应包含裸换行，必须做 JSON 转义。

2. **事件类型枚举**：服务端必须发送 `event: <type>\n` 行。客户端按 `type` 字段做一级路由。六类事件分别对应会话启动、推理思考、文本增量、工具调用、会话结束、异常终止。

3. **会话状态机**：`idle` → `starting` → `streaming` → `closing` → `closed`。`streaming` 状态下允许 `thinking`、`text`、`tool` 交错；进入 `closing` 后只发送 `done` 或 `error`，不再产生业务事件。

4. **事件 ID 与 Last-Event-ID**：每条 SSE 消息应携带单调递增的 `id`。客户端重连时通过 `Last-Event-ID` 头部告知服务端已收到的最后一条 ID，服务端据此重放或跳过，保证幂等消费。

5. **工具调用中间表示**：`tool` 事件不是最终答案，而是包含 `toolCallId`、`name`、`arguments` 增量片段的结构。一个工具调用可由多个 `tool` 事件拼接完成，最后以 `tool_result` 子类型或单独的 `text`/`done` 事件返回结果，具体取决于实现约定。

6. **错误分级模型**：`error` 事件分为可恢复错误（网络抖动、模型限流）和不可恢复错误（认证失败、参数非法）。可恢复错误应附带 `retryAfter` 毫秒数；不可恢复错误应明确设置 `terminal: true`，客户端收到后必须关闭连接且不再自动重连。

7. **缓冲与反压**：服务端需维护每个会话的出站缓冲队列。当客户端消费慢于生产时，队列长度超过阈值应触发背压策略，例如丢弃早期 `thinking` 片段或合并相邻 `text` 片段，避免内存无限增长。

## 设计决策与取舍

### SSE 还是 WebSocket
SSE 基于标准 HTTP，天然穿透 most 企业代理和负载均衡，支持自动重连与 `Last-Event-ID`。缺点是只能服务端推送，若客户端需要主动发送消息（如取消生成），必须额外发一条 HTTP POST。WebSocket 全双工但握手更复杂、重连需自行实现、长连接易被中间设备切断。对于 Agent 问答这种“用户提问后单向流式输出”场景，SSE 通常是更轻量的选择。

### 每个 token 一个事件还是批量聚合
每个 token 一个事件延迟最低，但事件头开销大，高频小数据包会提高 CPU 和带宽占用。批量聚合可降低开销，但会引入可感知的卡顿。折中策略是：设置 8–16 ms 的合并窗口，窗口内到达的 `text` 片段合并为一条 SSE 事件；`thinking` 与 `tool` 因语义独立，不合并。

### 通道级错误与应用级错误是否复用同一事件
复用 `error` 事件最简单，但会混淆网络错误和业务错误。推荐做法：`error` 事件专用于应用级异常，网络级错误由浏览器 `EventSource.onerror` 与连接关闭语义表达。两者在客户端日志中应使用不同字段名区分，例如 `appError` 与 `transportError`。

### `thinking` 是否默认暴露给最终用户
`thinking` 事件包含模型内部推理链，对调试有用，但在生产环境中可能泄露提示策略或增加认知负担。设计时应通过配置项 `exposeThinking` 控制；即使不暴露，服务端仍可产生 `thinking` 事件用于日志和审计，只是不向客户端发送。

### 重连由 EventSource 自动处理还是客户端接管
浏览器原生 `EventSource` 会在连接断开时按指数退避自动重连，但无法控制最大重试次数和抖动范围。复杂产品建议封装自定义 SSE 客户端：首次使用原生 `EventSource`，失败超过 3 次后切换为 `fetch` + `ReadableStream` 实现，以便自定义头部、请求体和重连策略。

### 认证凭证放在哪里
`EventSource` 不支持自定义请求头（Fetch API 的 `EventSource` 新规范正在推进，但兼容性不足）。若使用原生 `EventSource`，凭证通常通过 Cookie（`withCredentials: true`）或 URL 查询参数传递。敏感参数不应放在 URL 中，否则会被代理日志、浏览器历史记录保存。推荐在 Cookie 中保存会话令牌，并在服务端校验会话与 SSE URL 中的 `sessionId` 一致性。

## 可执行的实施流程

1. **输入验证与会话初始化**：接收 POST 请求创建会话，校验 `sessionId`、`modelId`、工具列表。生成内部会话句柄，写入 `SessionManager.inMemory()`，返回 SSE 端点 URL。

2. **建立 SSE 响应头**：服务端设置 `Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`Connection: keep-alive`，并视情况添加 `X-Accel-Buffering: no` 防止 Nginx 缓冲。

3. **注册事件发射器**：为每个会话创建一个 `AsyncIterable` 或 Node.js `Readable` 流，订阅模型运行时、工具执行器和生命周期事件。确保订阅在调用 `session.prompt()` 之前完成。

4. **发送 `start` 握手**：模型开始生成前，发送一次 `start` 事件，携带 `sessionId`、`timestamp`、`supportedEventTypes`。客户端收到 `start` 后才把连接状态从“连接中”改为“运行中”。

5. **推送 `thinking` 增量**：若启用思考链输出，将模型 reasoning 内容封装为 `thinking` 事件。每个事件包含 `delta` 字段，客户端按顺序追加。`thinking` 与 `text` 不可合并，避免类型混淆。

6. **推送 `text` 增量**：将模型输出文本切片按合并窗口发送。若窗口内无新内容且缓冲区非空，立即刷新。`text` 事件应包含 `delta`，可选 `index` 用于多段落场景。

7. **发送 `tool` 事件序列**：工具调用开始时发送 `tool:start`，参数片段到达时发送 `tool:delta`，工具执行完成后发送 `tool:result` 或将其结果转写为 `text` 事件。所有子事件共享同一 `toolCallId`。

8. **终止于 `done` 或 `error`**：模型生成正常结束时发送 `done`，包含最终摘要、token 统计和可选的 `finishReason`。异常时发送 `error`，包含 `code`、`message`、`retryAfter` 或 `terminal` 标志。发送后关闭底层响应流。

9. **客户端订阅与重连**：浏览器通过 `new EventSource(url, { withCredentials: true })` 订阅，按 `event` 类型分发。维护 `lastEventId`，在 `onerror` 中根据服务端返回的 HTTP 状态码决定是否继续自动重连。

10. **端到端验证**：使用 `curl -N` 检查原始 SSE 帧；使用 Playwright 或 Vitest 测试事件顺序、重连、错误恢复；运行 `pnpm typecheck` 确保 TypeScript 类型与事件 schema 一致。

## TypeScript 与本地文件知识库示例

以下示例展示事件 schema 与一条典型交互的事件序列。输入为用户问题“总结 docs/pi-agent-learning.md”；处理为 Agent 读取本地文件、思考、生成摘要；输出为 SSE 事件流。

```typescript
// 输入：客户端请求体
interface ChatRequest {
  sessionId: string;
  message: string;
  tools: ['search_knowledge'];
  exposeThinking: boolean;
}

// 输出：统一 SSE 事件载荷
type SseEvent =
  | { type: 'start'; sessionId: string; ts: number }
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; toolCallId: string; name: string; arguments?: string }
  | { type: 'done'; finishReason: string; usage: { prompt: number; completion: number } }
  | { type: 'error'; code: string; message: string; terminal?: boolean; retryAfter?: number };

// 服务端发送函数
function sendEvent(res: ServerResponse, id: number, type: string, payload: unknown) {
  res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
```

典型事件序列：

```
id: 1
event: start
data: {"type":"start","sessionId":"sess_42","ts":1725000000000}

id: 2
event: tool
data: {"type":"tool","toolCallId":"tc_1","name":"search_knowledge","arguments":"{\"query\":\"pi-agent runtime\"}"}

id: 3
event: thinking
data: {"type":"thinking","delta":"用户希望总结本地架构文档，我先定位关键段落。"}

id: 4
event: text
data: {"type":"text","delta":"该文档描述了 Pi Agent 的运行时边界："}

id: 5
event: text
data: {"type":"text","delta":"`apps/api` 负责 SSE 传输，`packages/pi-agent` 负责会话生命周期。"}

id: 6
event: done
data: {"type":"done","finishReason":"stop","usage":{"prompt":120,"completion":89}}
```

输入是用户消息与工具授权；处理是 Agent 调用 `search_knowledge` 读取 `.pi/knowledge` 或 `docs/` 下文件，并在 thinking 中记录推理；输出是客户端按 `event` 字段路由、按 `id` 排序、按 `delta` 追加渲染的流式 UI。

## 性能、质量和可观测性指标

1. **首字节时间（TTFB）**：从客户端发起 SSE 请求到收到 `start` 事件的时间。测量方式：在服务端 middleware 记录请求到达时间，在 `start` 事件生成时记录，两者差值写入 histogram。目标值在本地知识库场景下应低于 300 ms（不含模型排队）。

2. **事件间隔抖动**：连续 `text` 事件到达时间差的 P95。测量方式：客户端为每个事件打本地接收时间戳，计算相邻差值。抖动超过 200 ms 时用户会感知卡顿，应触发聚合窗口或拥塞控制调优。

3. **端到端流式延迟**：从模型产生一个 token 到客户端渲染该 token 的延迟。测量方式：服务端在事件 payload 中写入 `serverEmitAt`，客户端在渲染时对比 `performance.now()`。该指标帮助定位是服务端聚合、网络还是浏览器渲染瓶颈。

4. **错误率与分类**：按 `error` 事件中的 `code` 统计 QPS 与占比，并单独统计 `EventSource` 触发的 `transportError`。测量方式：统一事件总线写入结构化日志，按小时聚合。可恢复错误率应低于 1%，不可恢复错误需立即告警。

5. **重连次数与成功率**：记录每个 `sessionId` 在生命周期内的重连次数，以及重连后成功恢复到 `streaming` 状态的比例。测量方式：服务端在 `Last-Event-ID` 重连时记录会话续接日志。单会话重连超过 5 次应标记为网络质量异常。

6. **客户端缓冲区内存占用**：长时间对话中未消费的 `thinking`/`text` 缓冲字节数。测量方式：服务端暴露会话级指标，或客户端在 `onmessage` 中累加未渲染数据大小。超过 1 MB 时应考虑丢弃早期 thinking 片段或提示用户。

## 失败模式与恢复动作

1. **连接建立失败**。诊断证据：浏览器 `EventSource` 立即触发 `error`，HTTP 状态码为 401/403/500。恢复动作：401/403 表示凭证失效，跳转登录或刷新令牌；500 表示服务端异常，按指数退避重试，最多 3 次后降级为静态提示。

2. **代理/防火墙切断长连接**。诊断证据：连接在 30–60 秒后无错误地静默断开，服务端无 `done`/`error` 事件。恢复动作：设置服务端 `keep-alive` 心跳事件，每 25 秒发送一条 `event: ping\ndata: {}\n\n`；客户端识别心跳缺失后主动重连。

3. **事件格式损坏**。诊断证据：客户端 JSON.parse 抛出异常，或收到 `event` 字段缺失的帧。恢复动作：客户端对单条事件做 try/catch，记录 `lastEventId` 和原始 payload，向服务端发送错误报告 POST；服务端根据 `Last-Event-ID` 从上一个完整事件重放。

4. **服务端背压导致超时**。诊断证据：模型产出速度快，但 `text` 事件间隔逐渐增大，服务端内存占用持续上升。恢复动作：监控缓冲区长度，超过阈值时合并或丢弃低优先级 `thinking` 事件；对超时会话发送 `error` 并带 `retryAfter`，引导客户端稍后重试。

5. **客户端重连风暴**。诊断证据：`Last-Event-ID` 重连请求突增，同一 `sessionId` 每秒重连超过 2 次。恢复动作：服务端对单会话重连做令牌桶限流；客户端在指数退避基础上增加随机抖动，避免齐步走。

6. **工具事件顺序错乱**。诊断证据：`tool_result` 在 `tool:start` 之前到达，或 `toolCallId` 不连续。恢复动作：服务端保证工具事件按生成顺序入队；客户端维护 `toolCallId` 到缓冲区的映射，遇到未知 `toolCallId` 的 `result` 时暂存，等待 `start` 到达后再合并，超时 5 秒则上报异常。

## 问答测试样例

**正向问题**
1. 用户问：“SSE 通道支持哪些事件类型？” 期望回答应列出 `start`、`thinking`、`text`、`tool`、`done`、`error`，并说明 `tool` 事件包含 `toolCallId`、`name`、`arguments`。

2. 用户问：“如何实现重连保证不丢消息？” 期望回答应提到 `id` 单调递增、`Last-Event-ID`、服务端按 ID 重放或跳过，并给出本地阈值（如单会话重连超过 5 次标记异常）。

**边界问题**
3. 用户问：“如果 `thinking` 片段非常多，客户端会卡顿吗？” 期望回答应指出 `thinking` 不合并、可丢弃、可配置 `exposeThinking`，并引用缓冲区内存指标阈值（1 MB）。

4. 用户问：“工具调用过程中网络断开，恢复后会出现重复结果吗？” 期望回答应说明 `toolCallId` 幂等、服务端会话状态机、以及客户端缓冲暂存机制。

**无证据时的拒答条件**
5. 用户问：“SSE 在 HTTP/3 下的帧结构有什么不同？” 若文中未涉及 HTTP/3 帧细节，应回答：“本文仅讨论基于 HTTP/1.1 的 SSE 实现，HTTP/3 帧细节不在当前设计范围内。”

6. 用户问：“这个实现是否需要支持 Safari 的 EventSource 跨域 Cookie？” 若项目未给出明确的浏览器兼容性矩阵，应回答：“当前设计依赖 `withCredentials: true` 与 Cookie，具体 Safari 版本兼容性需补充浏览器矩阵后才能确定。”

## 维护、版本、来源与相邻主题关系

本实现属于 `apps/api` 与 `packages/pi-agent` 的交界区域，协议 schema 应随 API 版本号一起发布，例如 `v1/sse/events`。事件字段新增时，必须保证旧客户端能忽略未知字段，因此所有事件顶层应使用对象而非数组。来源方面，SSE 协议语义遵循 WHATWG Server-Sent Events 规范；事件类型设计参考了 Pi Agent 的 `message_update` 与 `tool_execution_*` 事件族，但做了本地简化。相邻主题包括：WebSocket（双向、状态复杂）、HTTP/2 Server Push（已逐步废弃，不推荐用于 Agent 流式）、WebRTC DataChannel（低延迟但信令复杂，适用于语音/视频协同）。本文讨论的 SSE 通道与这些方案是互补关系，而非替代。

## 结论

**事实**：SSE 是基于 HTTP 的单向推送协议；浏览器通过 `EventSource` 消费事件；每条 SSE 消息可携带 `event`、`data`、`id` 字段；`EventSource` 原生支持自动重连和 `Last-Event-ID`。

**推论**：在本地文件知识库与 Agent 流式输出场景下，使用 `start`、`thinking`、`text`、`tool`、`done`、`error` 六类事件足以表达完整会话生命周期；通过 `id` 与 `Last-Event-ID` 可实现可恢复消费；工具调用拆分为多个子事件能提升前端渲染的确定性。

**未知**：不同浏览器对 Fetch API 版 `EventSource` 的落地时间表、HTTP/3 对 SSE 长连接的实际性能影响、以及极端高并发下 Node.js `Readable` 流背压行为与代理超时之间的精确耦合关系，仍需在具体部署环境中测量验证。
