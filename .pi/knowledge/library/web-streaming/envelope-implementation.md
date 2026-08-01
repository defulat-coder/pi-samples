---
type: concept
title: 事件信封：实现视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。让每个事件都带 session、turn、序号和时间，便于重建过程
resource: .pi/knowledge/library/web-streaming/envelope-implementation.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, envelope, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: envelope
variant: implementation
---

# Web 流式交互中的事件信封：用 session、turn、序号与时间重建过程

## 摘要与问题边界

Web 流式交互通过 SSE 或 WebSocket 持续向浏览器推送增量内容。若直接发送裸文本，客户端无法判断片段属于哪一次会话、哪一次请求，更无法在连接闪断后准确续接。事件信封把每条业务消息封装成统一结构，强制携带 `sessionId`、`turnId`、`seq` 和 `timestamp`，并保留前一条引用，使完整过程可被重建。本文面向需要把方案落成 TypeScript 代码的开发者，先明确输入、输出、错误、生命周期与验证步骤，再进入编码。

## 核心概念与数据模型

1. **Envelope 是通用容器**：业务事件放入 `EventEnvelope<T>` 泛型结构，容器负责元数据，payload 承载业务语义。

2. **session 标识一次端到端连接上下文**：同一 `sessionId` 在连接存活期间保持恒定。连接重建后应生成新的 `sessionId`，避免把旧事件混入新流。

3. **turn 表示一次请求-响应回合**：用户提交一次 prompt 即开启一个 `turnId`，模型在该 turn 内产生的所有增量事件共享该标识。

4. **seq 是单调递增序号**：每个 turn 内从 `0` 开始递增，精确反映事件顺序。它比到达时间更可靠，因为网络抖动可能导致后发送先到达。

5. **timestamp 记录服务端发送时刻**：使用高精度 UTC 时间，粒度至少到毫秒。客户端时间不可靠，不能参与排序。

6. **previousEnvelopeId 构成隐式链表**：指向同 turn 的上一条 envelope，帮助在序号缺失时快速定位断点。

7. **lifecycle 与 checksum 共同界定阶段与完整性**：`eventType` 包括 `turn_start`、`text_delta`、`thinking_delta`、`tool_execution_start`、`tool_execution_end`、`error`、`turn_end`；`checksum` 覆盖 envelopeId、sessionId、turnId、seq、timestamp 和规范化 payload，防止传输中被篡改或截断。

## 设计决策与取舍

### 信封包装优于裸 payload

裸消息体积更小，但客户端必须为每种事件类型单独维护上下文。统一信封虽然每个消息增加几十字节，却能把索引、校验、重排逻辑集中到一层。

### 单调 seq 优于纯 UUID

UUID 适合全局标识，但不提供顺序。序列号在 turn 内天然有序，易于检测丢包。代价是服务端必须为每个 turn 维护计数器。

### 服务端时间优于客户端时间

浏览器时钟可能偏移或手动调整，因此 `timestamp` 由服务端生成。客户端可记录本地 `receivedAt` 用于测量延迟，但不参与排序。

### 元数据与 payload 分离

`sessionId`、`turnId`、`seq` 放在 envelope 顶层，而不是 payload 内部。过滤、索引、审计可以不解析 payload，减少 CPU 开销。

### 强校验与宽松转发的折中

入站 envelope 必须校验 schema 和 checksum；失败时立即返回 `error` envelope 并关闭当前 turn。出站到浏览器允许客户端降级展示，但不得重新生成服务端序列号。

## 可执行实施流程

1. 在 `packages/contracts` 定义 `EventEnvelope<T>` 接口与 `EnvelopeHeader`，所有字段不可为 `undefined`。
2. 使用 Zod 编写校验模式，要求 `sessionId`、`turnId`、`seq`、`timestamp`、`eventType` 必须存在，且 `seq` 为非负整数。
3. 在 `apps/api` 创建会话注册表，用户建立连接时分配 `sessionId`，并注入到 `SessionContext`。
4. 每次收到用户 prompt 时，生成新的 `turnId`，并在内存或 Redis 中初始化该 turn 的计数器为 `0`。
5. 模型每产生一个增量片段，调用 `nextEnvelope` 生成 `envelopeId`、递增 `seq`、计算 `previousEnvelopeId`，并捕获当前服务端时间。
6. 根据事件语义选择 `eventType`：文本增量为 `text_delta`，思考为 `thinking_delta`，工具开始为 `tool_execution_start`，结束为 `tool_execution_end`，异常为 `error`。
7. 发送前对 envelope 做 JSON 规范化序列化，计算 `checksum`，并再次校验 schema，失败则返回 `error` envelope 并记录日志。
8. 通过 SSE 发送给浏览器，同时把 envelope 写入持久化日志，写入顺序必须等于发送顺序。

## 输入、处理与输出示例

| 环节 | 内容 | 说明 |
|---|---|---|
| 输入 | 用户发送 prompt "总结文档" | 触发新建 turn，分配 `turnId = turn_3` |
| 处理 | 模型生成首段文本，服务端生成 `seq = 0`，`eventType = text_delta`，`payload = { text: "这份文档", chunkIndex: 0 }` | 计算 `previousEnvelopeId` 为 `turn_start` 的 envelopeId |
| 输出 | 浏览器收到完整 envelope，包含 `sessionId`、`turnId`、`seq`、`timestamp`、`prev`、`checksum` | 客户端 reducer 按 `seq` 插入缓冲区，缺失则标记等待 |

一个典型 envelope 如下：`envelopeId` 为 env_t3_002，`sessionId` 为 sess_abc_123，`turnId` 为 turn_3，`seq` 为 2，`timestamp` 为 2026-08-01T12:34:56.789Z，`eventType` 为 text_delta，`payload` 为 `{ text: "主要结论", chunkIndex: 2 }`，`previousEnvelopeId` 为 env_t3_001，`checksum` 为 a3f7...。

## 性能、质量和可观测性指标

1. **envelope-to-wire 延迟**：从模型生成片段到字节离开服务端的时间，应小于 5 毫秒。在构造 envelope 前后打点，用直方图统计。
2. **序列号断层率**：重建过程中发现 seq 不连续的次数占总 envelope 的比例，目标为 0。重建器检查 `seq - prevSeq == 1`。
3. **校验拒绝率**：入站或出站 envelope 被 schema 或 checksum 拒绝的百分比，应低于 0.1%。
4. **重放漂移时间**：从请求重建到浏览器收到第 0 号 envelope 的耗时，决定断线续接体验。
5. **错误归因准确率**：每个 `error` envelope 必须关联到具体 `turnId` 和 `seq`，避免错误归入未知会话。

## 失败模式

1. **序列号断层**：客户端收到 `seq = 3` 后下一次收到 `seq = 5`。证据是 `previousEnvelopeId` 指向不存在的 envelope。恢复：客户端请求 `replay(sessionId, turnId, fromSeq=4)`。
2. **重复信封**：同一 turn 同一 seq 出现多个不同 envelopeId。证据是 duplicate seq。恢复：客户端按 envelopeId 去重，服务端检查序列号生成逻辑的原子性。
3. **时间戳回退**：某条 envelope 的 `timestamp` 早于前一条。证据是时间单调性被破坏。恢复：拒绝该 envelope，使用服务端单调时钟并告警。
4. **turn 不匹配**：`sessionId` 正确但 `turnId` 不在当前会话的活跃 turn 中。证据是 turn 注册表不存在该 `turnId`。恢复：返回 `error` envelope 并关闭旧 turn。
5. **payload schema 校验失败**：`eventType = text_delta` 但 payload 缺少 `text` 字段。证据是 Zod 报告字段缺失。恢复：发送 `error` envelope 并丢弃该业务事件。

## 问答测试样例

1. **正向**：在一个 turn 内，第三条文本增量的 `seq` 是多少？答：从 0 开始计数为 2。
2. **正向**：重建过程如何利用 `prev` 指针？答：按 `seq` 排序后，检查每条 `previousEnvelopeId` 是否等于上一条 `envelopeId`。
3. **边界**：连接断开后重连，服务端 turn 已结束，客户端持有 `lastSeq = 7`，如何处理？答：返回该 turn 的 `turn_end` envelope，并告知客户端开启新 turn。
4. **边界**：同一 session 内两个并发 prompt 是否共用一个 `turnId`？答：不，每个 prompt 独立 `turnId`，服务端需分别维护计数器。
5. **无证据拒答**：事件信封是否必须加密？答：无法确认，加密取决于传输层要求，信封本身只提供 checksum。
6. **无证据拒答**：`checksum` 必须使用 SHA-256 吗？答：无法确认，项目级设计可约定 SHA-256 或 HMAC-SHA-256，并非通用强制。

## 维护、版本、来源与相邻主题

- **版本**：`EventEnvelope` 接口包含 `version` 字段，初始为 `"1"`。升级时通过 `version` 区分旧日志解析策略。
- **来源**：所有 envelope 由 `packages/pi-agent` 的 `nextEnvelope` 工厂生成；消费端为 `apps/web` 的 SSE reducer 和 `apps/api` 的持久化日志。
- **维护**：每月重建测试日志，验证 `rebuildTurn` 在 10 万条 envelope 下的顺序与完整性。
- **相邻关系**：事件信封与传输层相邻，但不负责重连策略；与 session 管理相邻，但不替代认证；与工具调用协议相邻，工具结果是 payload 的一部分。

## 结论

- **事实**：事件信封必须携带 `sessionId`、`turnId`、`seq` 和 `timestamp`，并通过 `prev` 指针与 `checksum` 保证可重建性。
- **推论**：排序应完全依赖服务端生成的单调 `seq`；客户端本地时间只能用于观测延迟，不能参与排序。
- **未知**：跨数据中心分布式生成 `seq` 时，是否需要引入分布式原子计数器或按 turn 一致性哈希，取决于具体部署规模和一致性要求，本文未给出最终方案。
