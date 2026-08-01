---
type: concept
title: SSE 通道：架构视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。定义 start、thinking、text、tool、done 和 error 的可消费事件
resource: .pi/knowledge/library/web-streaming/sse-architecture.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, sse, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: sse
variant: architecture
---

# SSE 通道：可消费事件与边界接口

## 摘要与问题边界

SSE 通道是一种基于 HTTP 的单向服务器推送机制，用于把后端 Agent 运行时的增量输出以事件流形式投递到 Web 客户端。本文讨论的边界不是“用 SSE 替代 WebSocket”的产品选型，而是把 `start`、`thinking`、`text`、`tool`、`done`、`error` 六种事件定义为可消费语义单元，并在传输层与业务层之间划出稳定接口。目标读者需要据此判断：哪些行为属于通道契约，哪些属于具体运行时实现，哪些必须由客户端自己负责。

## 核心概念与数据模型

1. **事件是传输与语义的最小合约单元**。SSE 协议层的字段 `id`、`event`、`data` 只负责投递；业务层在 `data` 内携带 JSON 负载，负载中的 `type` 字段才区分 `start`、`thinking`、`text`、`tool`、`done`、`error`。

2. **六种事件共享同一序列空间**。每个事件必须携带单调递增的 `seq`，客户端据此排序、去重和检测缺口。`start` 的 `seq` 为 0，`done` 或 `error` 必须作为该流中最后一个事件。

3. **`start` 宣布会话上下文，而非运行开始**。它包含 `session_id`、`capabilities` 和 `schema_version`，告诉客户端本流支持哪些工具、是否暴露 thinking 事件、以及后续事件的解析契约。

4. **`thinking` 与 `text` 是同一个推理过程的两个投影**。`thinking` 表示模型内部链或草稿；`text` 表示对外可见的增量。两者可以交错出现，但不能互相替代。若运行时不支持 thinking，则不应发送 `thinking` 事件，而不是发送空 `thinking`。

5. **`tool` 事件具有自己的子生命周期**。一次工具调用至少包含 `tool_execution_start`、`tool_execution_update`、`tool_execution_end` 三种状态。客户端应把工具事件视为独立流，不能假设工具结果一定在最终答案之前完整返回。

6. **`error` 是终态，且必须说明范围**。`error` 携带 `terminal: true` 和 `scope`（`transport`、`runtime`、`tool` 或 `client`），表示该流不再继续。任何非终态异常应使用 `tool_execution_update` 或 `text` 中的内联错误说明，而不是占用 `error` 事件。

7. **`done` 只表示服务器端已完成发送**，不等于客户端渲染完成。客户端收到 `done` 后仍需把缓冲区中的 `text` 或 `tool` 结果提交到 UI，并主动关闭 EventSource。

## 设计决策与取舍

### 1. 传输层使用 SSE 而非 WebSocket
SSE 复用 HTTP 基础设施，天然支持自动重连、`Last-Event-ID` 和单向流，适合服务器到客户端的推送。但 SSE 不支持二进制帧，也不支持客户端通过同一连接发送输入；因此输入仍由独立 POST 端点承担。这一拆分把“控制面”与“数据面”分离，降低了长期演进中替换传输的成本。

### 2. 事件类型放在 SSE `event` 字段，子状态放在 JSON 负载
`event: text` 用于浏览器按类型快速分派；`data` 内部再用 `type: text_delta` 或 `type: text_end` 表达细分状态。这种两层划分让传输层只负责“通道”，业务层负责“语义”，避免把运行时的内部状态泄漏到协议头。

### 3. `thinking` 默认可选，但开启后必须完整透出
`thinking` 事件对用户体验和调试都很重要，但不是所有模型都提供。因此 `start` 中的 `capabilities.thinking` 是契约开关：开启时，运行时必须发送所有 thinking 增量；关闭时，禁止发送 `thinking`，否则客户端会视为非法事件。

### 4. 工具事件与文本事件不允许合并
为了保持可观测性和可重放性，一次工具调用的进度、中间输出和最终结果必须拆成独立 `tool` 事件。合并到 `text` 中会丢失工具生命周期，导致客户端无法展示“执行中”状态，也无法在失败时单独重试。

### 5. 错误事件必须区分“通道错误”与“业务错误”
`error` 的 `scope` 字段把两类失败分开：传输层断开、代理缓存、SSE 解析失败属于 `transport`；模型调用失败、工具超时属于 `runtime`；客户端传入非法参数属于 `client`。这样运维警报可以根据范围路由，而不是把所有错误都视为模型失败。

### 6. 背压由客户端丢弃策略承担，而非服务端阻塞
SSE 没有原生流控。设计约定：服务端保持匀速发送，客户端如果渲染慢，可选择丢弃过时的 `thinking` 事件，但至少要保留每个 `text` 和 `tool` 的终态。这样避免服务端为慢客户端维护大量状态。

## 可执行的实施流程

1. 在服务端为每个事件类型定义 JSON Schema，并写入 `packages/contracts/src/sse-events.ts`；字段必须包含 `seq`、`session_id`、`timestamp` 和 `type`。

2. 服务端实现 `/api/v1/sessions/{id}/stream` 端点，响应头必须返回 `Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`，并允许 CORS 暴露 `Last-Event-ID`。

3. 连接建立后，服务端首先发送 `start` 事件，其中 `capabilities` 列出本会话支持的 `thinking` 和 `tool` 事件，`schema_version` 固定为当前主版本。

4. 当模型开始思考时，运行时间隔发送 `thinking` 事件，每个事件包含 `delta` 字段；不支持时跳过本步骤。

5. 当模型产生文本或运行时产生工具输出时，分别发送 `text` 或 `tool` 事件，并在 `seq` 上保持单调递增；工具事件必须在同一 `tool_call_id` 下完整发送 `start`、`update`、`end`。

6. 客户端在 EventSource 的 `onmessage` 中按 `event` 字段分派处理器；`text` 和 `thinking` 使用 `delta` 追加，`tool` 使用 `tool_call_id` 合并到状态树。

7. 如果 EventSource 触发 `error`，客户端读取 `Last-Event-ID` 头部值，并在重连时通过 `headers['Last-Event-ID']` 发送；服务端从该 `seq` 之后重新发送事件。

8. 服务端在会话结束或异常时发送 `done` 或 `error` 事件，之后关闭底层响应流，不再发送任何数据。

9. 客户端收到 `done` 或 `error` 后，标记会话为关闭，清理缓冲区，并在 `error` 时把错误信息渲染到 UI 的错误区域。

10. 在网关和客户端分别记录事件到达时间、`seq` 缺口、重连次数和解析失败次数，用于可观测性。

## 输入、处理与输出示例

以下是一段贴近 TypeScript/Web 本地文件知识库场景的 SSE 片段，未使用代码围栏，仅展示协议层格式：

event: start
id: 0
data: {"type":"start","seq":0,"session_id":"sess-7a21","capabilities":{"thinking":true,"tool":true},"schema_version":"1.0"}

event: thinking
id: 1
data: {"type":"thinking_delta","seq":1,"session_id":"sess-7a21","delta":"需要读取 .pi/knowledge 中的架构文档"}

event: tool
id: 2
data: {"type":"tool_execution_start","seq":2,"session_id":"sess-7a21","tool_call_id":"tc-01","tool":"search_knowledge","arguments":{"query":"SSE 边界"}}

event: text
id: 5
data: {"type":"text_delta","seq":5,"session_id":"sess-7a21","delta":"根据本地知识库，SSE 通道的边界在于..."}

event: done
id: 6
data: {"type":"done","seq":6,"session_id":"sess-7a21"}

输入是客户端通过 POST 请求建立的会话；处理是服务端把运行时输出按事件类型和顺序切分；输出是六个事件组成的 UTF-8 文本流，客户端按 `id` 排序消费。

## 性能、质量与可观测性指标

1. **首字节时间（TTFB）**：从客户端发送请求到收到 `start` 事件的时间，应在服务端日志中标记 `request_received` 和 `start_sent` 两个时间戳。

2. **首个文本增量时间（TTFT）**：从请求到首个 `text` 事件的 `delta` 到达客户端的时间，用于衡量模型启动延迟。

3. **事件间隔 p50/p99**：在客户端统计相邻事件到达的时间差，p99 超过 1 秒说明存在代理缓冲或网络抖动。

4. **重连率**：`EventSource` 每秒重连次数除以总会话数，超过 0.05 表示传输层不稳定。

5. **事件解析失败率**：客户端无法把 `data` 解析为 JSON 或无法识别 `type` 的次数，除以总事件数。

6. **缓冲区峰值内存**：客户端在渲染前累计未提交的 `thinking` 和 `text` 字节数，可通过 Performance Memory API 或自定义计数器采样。

## 失败模式、诊断证据与恢复动作

1. **代理缓存导致 SSE 流被整体缓冲**。诊断证据：客户端 `start` 与首个 `text` 事件几乎同时到达，且事件间隔不均匀。恢复：服务端强制 `Cache-Control: no-cache, no-transform`；网关禁用响应缓冲。

2. **客户端事件解析失败**。诊断证据：JavaScript 控制台出现 `SyntaxError: Unexpected token`，解析失败率大于 0。恢复：客户端捕获异常并上报 `scope: client` 的 `error`；服务端回退到更严格的 JSON 输出。

3. **重连后收到重复事件**。诊断证据：同一 `seq` 出现两次。恢复：客户端按 `seq` 去重；服务端在重放时从 `Last-Event-ID + 1` 开始。

4. **工具事件缺少 `end` 终态**。诊断证据：`tool_execution_start` 之后只出现 `update`，没有 `end`，超时 30 秒后客户端仍未收到 `done`。恢复：服务端设置工具调用硬超时，并强制补发 `error` 或 `tool_execution_end`（状态为 `timeout`）。

5. **`error` 事件后仍继续发送数据**。诊断证据：服务端在 `error` 之后仍发送 `text` 或 `tool`。恢复：客户端识别后断开连接并上报；服务端在发送 `error` 时立即关闭响应流。

6. **`thinking` 事件与 `text` 事件顺序错乱**。诊断证据：`seq` 不是单调递增。恢复：服务端在序列化层加锁或排队；客户端检测到缺口后触发重连。

## 问答测试样例

1. **正向**：`start` 事件中 `capabilities.thinking` 为 `true` 时，客户端可以期待什么？
   回答：客户端可以期待后续出现 `thinking` 事件；如果未出现，则视为运行时未产生思考内容，而非缺失。

2. **正向**：`tool` 事件必须包含哪几个子状态？
   回答：至少包含 `tool_execution_start`、`tool_execution_update` 和 `tool_execution_end`，用同一 `tool_call_id` 关联。

3. **边界**：`error` 事件是否可能在 `done` 之后出现？
   回答：不可能。`error` 和 `done` 都是终态，一个会话流中只能出现其一，且必须是最后一个事件。

4. **边界**：`thinking` 事件是否可以在 `text` 事件之后出现？
   回答：可以。事件顺序由 `seq` 决定，而非内容阶段；只要 `seq` 单调递增，thinking 与 text 可以交错。

5. **无证据**：SSE 通道的默认超时时间是多少秒？
   回答：本文未规定默认超时；该值由部署的网关、HTTP 客户端和运行时配置共同决定，需要查看具体环境配置。

6. **无证据**：客户端是否可以通过同一个 SSE 连接发送用户输入？
   回答：不可以。SSE 是单向服务器推送；输入必须通过独立 POST 或 REST 端点发送。

## 维护、版本、来源与相邻主题关系

SSE 事件契约的版本通过 `start` 中的 `schema_version` 声明。版本升级时，新增字段必须保持向后兼容，删除字段或改变事件语义必须递增主版本。相邻主题包括：WebSocket 全双工通道、JSONL 行流、Pi RPC 子进程通信。SSE 适合浏览器端单向推送，JSONL 适合服务端日志和文件重放，RPC 适合进程隔离场景。本文内容基于项目内 `packages/contracts`、`packages/pi-agent` 与 `apps/api` 的接口约定，以及与 `@earendil-works/pi-coding-agent` SDK 的事件映射实践。

## 结论

**事实**：SSE 是单向 HTTP 推送协议；`start`、`thinking`、`text`、`tool`、`done`、`error` 是本通道定义的六种可消费事件；`seq` 必须单调递增；`error` 和 `done` 是终态。

**推论**：把事件类型放在 SSE `event` 字段、子状态放在 JSON 负载，可以在不替换传输层的情况下演进业务语义；客户端应承担背压和部分去重责任。

**未知**：不同浏览器对 EventSource 重连策略、最大连接数和 `Last-Event-ID` 的具体实现存在差异；生产环境中需要针对目标浏览器和网关进行实测校准。
