---
type: concept
title: 事件信封：架构视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。让每个事件都带 session、turn、序号和时间，便于重建过程
resource: .pi/knowledge/library/web-streaming/envelope-architecture.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, envelope, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: envelope
variant: architecture
---

# 事件信封：Web 流式交互中的过程重建机制

## 摘要与问题边界

在 Web 流式交互中，客户端通过 SSE 或 WebSocket 接收的并非单个消息，而是一串可被网络层、代理层、重连层重新排序或拆分的离散帧。事件信封的作用是在每一帧上附加元数据，使接收方能够在不依赖传输层顺序的前提下，重建一次完整对话的因果过程。本文的讨论范围限定在事件标识、过程重建和可替换传输边界，不涉及模型内容生成策略、提示词工程或客户端 UI 渲染。

核心问题是：当一次 `turn` 因为网络抖动被拆成多次推送，或因为客户端重连导致同一事件被重复投递时，系统如何判断该事件属于哪一次会话、处于哪一轮次、排在第几位、发生在什么时刻。如果缺少这些维度，调试日志就只能依赖时间戳近似匹配，审计也无法证明事件之间的因果关系。

## 核心概念与数据模型

事件信封由以下六个维度构成，缺一不可：

1. **会话标识 `session_id`**：一次客户端连接的生命周期标识。在 Web 场景下，它通常由 API 层在连接建立时生成，而不是由模型运行时分配。同一 `session_id` 内的所有事件共享同一上下文窗口，但不同 `session_id` 之间不允许共享。
2. **轮次标识 `turn_id`**：一次用户请求与对应完整回复构成一个 `turn`。`turn_id` 在服务端收到用户消息后生成，所有该轮次的 `message_update`、`tool_execution_start`、`tool_execution_end` 等事件都携带同一 `turn_id`。一轮结束的标志由服务端明确发送 `turn_end` 事件。
3. **序号 `sequence`**：同一 `turn` 内的事件严格递增序号。序号必须是整数，起始值从 0 开始，步长为 1。它不表示全局时间顺序，而表示该轮次内的生成顺序。
4. **事件时间 `event_time`**：事件在服务端产生时的 UTC 时间戳，精确到毫秒。它由事件生成时写入，而非网络发送时写入。重发的事件必须保留原始 `event_time`，不能刷新。
5. **事件类型 `event_type`**：枚举值，例如 `text_delta`、`thinking_delta`、`tool_execution_start`、`tool_execution_end`、`lifecycle_retry`、`turn_end`。类型决定下游解析器应如何消费载荷。
6. **载荷 `payload`**：事件的业务数据。事件信封本身不解释载荷语义，只负责传输和排序。载荷与元数据分离，使 envelope 可以在不修改业务逻辑的情况下被替换。

## 设计决策与取舍

### 边界决策：Envelope 由 API 层生成
事件信封不是由客户端生成，也不是由模型运行时直接生成。API 层在收到模型运行时的原始输出后，为其附加 `session_id`、`turn_id`、`sequence` 和 `event_time`，再向客户端推送。这一决策的理由是：客户端不可信，模型运行时不负责网络传输。但 API 层必须知道模型运行时的输出边界，否则无法正确划分 `turn_id`。

### 替换接口：Envelope 与传输层解耦
Envelope 格式与传输协议独立。同一条事件可以先以 SSE 推送，也可以以 JSONL 写入本地文件，还可以被转发到 WebSocket。实现上应定义一个 `EnvelopeSerializer` 接口，SSE 实现和文件实现分别提供不同的序列化器。这样替换传输方式时不需要改动事件模型。

### 序号策略：每轮次内单调递增，不保证全局连续
`sequence` 只在单个 `turn_id` 内递增。这意味着不同 `turn` 之间可能出现重复的 `sequence`，这是被允许的。全局排序由 `event_time` 和 `session_id` 组合保证。如果要求全局唯一序号，会增加服务端状态负担，但带来的收益有限，因为业务上只需要按轮次重建过程。

### 时间戳不用于排序
`event_time` 用于审计和调试，不用于事件排序。排序由 `sequence` 负责。如果服务端时钟出现跳变，事件顺序仍由 `sequence` 保证。但 `event_time` 跨机器不一致时，会导致日志分析出现偏差，因此建议所有生成事件的服务器使用 NTP 同步，并在关键路径记录单调时钟偏移。

### 重发与幂等
当客户端重连并请求从某个 `sequence` 之后重放时，服务端必须能够返回相同的事件副本。这意味着事件在服务端应至少缓存最近一轮的完整序列。缓存不是无限期的，默认建议保留 5 分钟或最近 3 个 `turn`，以较小者为准。超过缓存窗口后，服务端应返回 `resumption_unavailable` 事件，而不是伪造事件。

## 可执行的实施流程

1. 在 API 层定义 `Envelope` 接口，包含 `session_id`、`turn_id`、`sequence`、`event_time`、`event_type`、`payload` 六个字段。
2. 定义 `EnvelopeSerializer` 接口，至少提供 `serialize` 和 `parse` 两个方法。
3. 实现 SSE 序列化器，将 envelope 序列化为单行 JSON 后放入 `data:` 字段。
4. 实现内存或文件缓存，用于保存最近一轮事件，支持按 `turn_id` 和 `sequence` 重放。
5. 在 `session` 建立时为该连接生成 `session_id`，并记录会话上下文。
6. 在收到用户消息后生成 `turn_id`，并将该 `turn_id` 与该次请求绑定。
7. 在模型运行时产生输出时，由 API 层分配 `sequence`、附加 `event_time` 和 `event_type`，写入 envelope。
8. 推送前将 envelope 写入缓存副本，再发送给客户端。
9. 客户端重连时，根据请求中的 `session_id` 和 `last_sequence` 返回缓存事件。
10. 一轮结束时发送 `turn_end` 事件，并关闭该 `turn_id` 的序列号递增。

## 类型与示例

```typescript
interface Envelope {
  session_id: string;
  turn_id: string;
  sequence: number;
  event_time: string; // ISO 8601
  event_type: 'text_delta' | 'tool_execution_start' | 'tool_execution_end' | 'turn_end';
  payload: Record<string, unknown>;
}

class SSEEnvelopeSerializer implements EnvelopeSerializer {
  serialize(e: Envelope): string {
    return `data: ${JSON.stringify(e)}\n\n`;
  }
  parse(raw: string): Envelope {
    const line = raw.startsWith('data: ') ? raw.slice(6) : raw;
    return JSON.parse(line) as Envelope;
  }
}
```

输入是模型运行时产生的原始文本片段；处理由 API 层附加 envelope 元数据并序列化；输出是 SSE 帧。本地文件知识库可以复用同一 `Envelope` 接口，将事件按 JSONL 写入文件，每行一个 envelope。

## 性能、质量与可观测性指标

1. **Envelope 附加延迟**：从模型运行时输出到客户端收到首帧之间的时间差。应在 API 层采样，目标 P99 小于 10 毫秒。
2. **Sequence 空洞率**：接收方检测到缺失 `sequence` 的比例。通过客户端上报 `expected_sequence` 与 `received_sequence` 的差值计算，目标为 0%。
3. **重发命中率**：客户端重连请求成功命中服务端缓存的比例。低于 80% 时应检查缓存窗口或清理策略。
4. **事件类型分布**：每轮次中各类事件的占比。异常比例如 `tool_execution_end` 缺失可作为故障信号。
5. **Clock skew 影响面**：通过比较 `event_time` 与客户端接收时间，识别服务端时钟偏移超过 1 秒的事件占比。

## 失败模式

1. **Sequence 跳号**：服务端未按顺序发送事件，导致客户端无法重建。诊断证据是客户端日志中 `received_sequence - last_sequence > 1`。恢复动作是断开连接并触发完整重放，若缓存不可用则返回错误。
2. **Turn 未结束**：服务端未发送 `turn_end` 就关闭连接。诊断证据是连接断开前 30 秒内该 `turn` 没有 `turn_end`。恢复动作是客户端标记该 turn 为不完整，禁止在此 turn 上追加新请求。
3. **Session 跨连接复用**：同一 `session_id` 被两个并发连接同时推送。诊断证据是同一 `session_id` 出现两条并活跃连接。恢复动作是拒绝后建立的连接。
4. **Event time 倒序**：同一 turn 内 `event_time` 非单调。诊断证据是 `sequence` 增加但 `event_time` 减小。恢复动作是忽略时间戳用于排序，但触发时钟同步告警。
5. **重发事件不一致**：重发的事件与首次发送内容不同。诊断证据是客户端计算同一 `sequence` 两次收到的载荷哈希不一致。恢复动作是服务端校验缓存副本，防止覆盖。

## 问答测试样例

1. **正向**：一个 `text_delta` 事件必须包含哪些字段？答案：`session_id`、`turn_id`、`sequence`、`event_time`、`event_type`、`payload`。
2. **正向**：`sequence` 在什么时候重置？答案：每个新的 `turn_id` 从 0 开始。
3. **边界**：两个不同 `turn_id` 的 `sequence` 可以相同吗？答案：可以，因为 `sequence` 只在 `turn_id` 内单调递增。
4. **边界**：客户端能否根据 `event_time` 对事件排序？答案：不能，排序应使用 `sequence`，`event_time` 仅用于审计。
5. **无证据**：事件信封是否应包含用户身份字段？答案：项目未作此规定，应由上层认证层处理，不属于 envelope 职责。
6. **无证据**：`payload` 是否应被 envelope 校验结构？答案：不需要，envelope 负责传输和排序，不解释载荷语义。

## 维护、版本、来源与相邻主题

事件信封的版本应独立于业务模型版本。建议通过 `v1` 前缀在 `event_type` 命名中预留空间，或在 envelope 中增加 `envelope_version` 字段。当前项目采用 `v1` 隐含约定。

事件信封与相邻主题的关系：
- 与 **会话管理**：`session_id` 由会话管理生成，但 envelope 只消费该标识。
- 与 **传输协议**：SSE 是默认实现，JSONL 是审计实现，二者共享同一 envelope 模型。
- 与 **模型运行时**：运行时输出原始片段，API 层负责 envelope 化。
- 与 **本地知识库**：文件存储可直接使用 `Envelope` 接口，无需额外转换。

## 结论

**事实**：事件信封必须包含 `session_id`、`turn_id`、`sequence`、`event_time`、`event_type` 和 `payload` 六个字段；`sequence` 在每轮次内从 0 开始递增；API 层负责生成 envelope；重发事件必须保留原始 `event_time`。

**推论**：只要 envelope 正确，客户端就可以在不依赖传输层顺序的情况下重建任意一次 turn 的过程；缓存窗口大小取决于重连频率和可容忍的延迟，5 分钟或 3 轮是一个合理起点。

**未知**：跨数据中心部署时 clock skew 的分布形态；客户端在极端弱网下的重连间隔分布；不同传输协议对 envelope 大小上限的实际约束。这些需要在生产环境中通过埋点和灰度观察确定。
