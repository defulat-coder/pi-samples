---
type: concept
title: Prompt 与 turn：实现视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。一次 prompt 如何进入模型回合，以及排队、跟随和中止语义
resource: .pi/knowledge/library/pi-runtime/prompt-implementation.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, prompt, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: prompt
variant: implementation
---

# Prompt 与 turn：Pi Agent 运行时中一次模型回合的进入、排队、跟随与中止实现

## 摘要与问题边界

本文从实现视角说明，在 TypeScript 仓库中，用户的一次 prompt 如何被 apps/api 接收、经 packages/pi-agent 进入模型回合（turn），并在队列、跟随、替换与中止语义下完成生命周期。问题边界限定在单个会话（session）内部：从 HTTP/SSE 接入到 `createAgentSession()` 的调用边界，不涉及多会话调度、也不涉及模型训练或模型权重细节。核心关注点是输入校验、输出事件、错误传播、生命周期状态以及这些步骤必须在写业务代码之前就被固化为类型与测试。

## 核心概念与数据模型

1. **PromptEnvelope**。请求进入运行时的规范形态，字段至少包括 `sessionId`、`turnId`（UUID v4）、`correlationId`（链路追踪）、`role: 'user'`、`content`（文本或数组）、`requestedTools`（字符串数组，仅允许 `read` 与 `search_knowledge`）、`thinkingLevel`（可选枚举）、`follow`（是否追加到当前未完成 turn）、`replace`（是否替换 pending turn）、`abortSignal`（`AbortSignal` 实例引用）。
2. **TurnContext**。单个模型回合的运行时状态机，字段包括 `turnId`、父 turn 引用、`status: 'pending' | 'running' | 'completed' | 'aborted' | 'error'`、prompt 快照、assistant 消息缓冲、tool call 注册表、`AbortController`、开始/结束时间戳、token 使用统计。TurnContext 是排他资源，一个 session 同一时刻只能有一个 `running`。
3. **SessionState**。会话级容器，持有 `SessionManager.inMemory()` 返回的引用、`currentTurn` 指针、FIFO turn 队列、会话级 `AbortController`、已订阅的 SSE emitters、模型运行时实例、`DefaultResourceLoader` 实例（cwd 加载 `.pi/skills`、`.pi/prompts`、`.pi/knowledge`、`AGENTS.md`）。
4. **ModelRuntime**。封装 `@earendil-works/pi-coding-agent` 的 `AgentSession` 与提供者配置，职责包括把 `thinkingLevel` 映射为提供者参数、发起流式补全、接收原始 delta、统一错误码。提供者密钥只存在于 API 进程。
5. **EventNormalizer**。将原始流转换为 contracts 中定义的 `message_update` 事件：`text_delta`、`thinking_delta`、`toolcall_open`、`toolcall_delta`、`toolcall_close`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`，以及 `lifecycle` 和 `retry` 事件。
6. **CapabilityInjector**。运行时只暴露只读工具：项目自定义的 `search_knowledge` 与内置 `read`。该组件在 turn 进入模型前校验工具名白名单、校验 JSON Schema、注入执行器，确保不会出现写操作。
7. **QueuePolicy**。单会话 turn 队列策略：默认 FIFO，最大深度 `maxQueuedTurns`（建议 3），最大并发 `maxConcurrentTurns = 1`。支持 `follow` 追加、`replace` 替换 pending，不支持抢占运行中 turn。

## 设计决策与取舍

### 单会话串行 turn

每个 session 同一时刻只允许一个 `running` turn。这避免了 token 顺序混乱、工具副作用顺序混乱以及多个 assistant 消息并发写入缓冲。代价是高频请求会排队；若未来需要分支式会话，应引入 turn 树而非并发运行。

### 中止信号的两层级联

session 级 `AbortController` 仅用于会话销毁；每个 turn 拥有独立 `AbortController`。调用 abort 时，先设置 turn signal，再通知 ModelRuntime 取消流，最后 drain 队列中 pending。这样 abort 不会误伤下一个已经排队的合法 turn。风险是部分提供者对取消响应有延迟，需要设置 `abortTimeout`。

### 跟随与替换的显式语义

`follow=true` 表示用户希望追加到当前未完成 turn 的后续（实际效果是在当前 turn 完成后立即启动新 turn，保持上下文连续）；`replace=true` 仅当目标 turn 状态为 `pending` 时生效，否则被拒绝。不会隐式替换运行中 turn，避免上下文截断。

### 校验前置

在调用 `session.prompt()` 之前完成所有校验：请求 DTO 结构、工具白名单、`thinkingLevel` 合法性、路径允许列表、队列余量。校验失败直接返回 4xx，不计入 turn，也不产生提供者调用。

### 工具结果同步回注

单个 turn 内，模型可能连续发出多个 tool call。实现选择同步收集结果、一次性回注为 assistant 消息中的 `tool_results` 数组。这简化了状态机，但要求工具执行超时必须短于 turn 超时，否则会导致整个 turn 失败。

## 可执行的实施流程

1. apps/api 接收 `/prompt` POST，使用 contracts DTO 校验 `sessionId`、`content`、`options`，失败返回 400 并记录字段路径。
2. 从 `SessionManager.inMemory()` 获取或新建 session，获取会话级锁。
3. 构造 `PromptEnvelope`，生成 `turnId`，检查队列深度，超过 `maxQueuedTurns` 返回 429。
4. 解析 `follow` 与 `replace`：若 `replace=true` 且 pending turn 存在，替换其 envelope；否则入队。
5. 若当前无 `running` turn，将队首出队并置为 `running`；注册 SSE emitter 订阅。
6. 在 turn 启动前执行预校验：工具白名单、`thinkingLevel`、路径、abortSignal 有效性。
7. 创建 turn 级 `AbortController`，调用 `ModelRuntime.stream(prompt, signal)`，进入事件循环。
8. 流事件循环：遇到文本 delta 推 `message_update`；遇到 `toolcall_open` 暂停文本累积，执行工具， emit `tool_execution_*`，将结果回注；循环直到 `turn_end`。
9. 正常完成时设置 `status=completed`，写入最终消息，emit `turn_end`（含 token 使用），unsubscribe，处理下一排队 turn。
10. 中止或错误时：设置 `status=aborted|error`，emit 结束事件，flush SSE，保留 session 存活；错误需分类重试或返回 5xx。

## 示例：一次本地文件知识库检索的 prompt 处理

    POST /prompt
    Content-Type: application/json

    {
      "sessionId": "sess-7a3f",
      "content": "在 .pi/knowledge 中搜索 Pi Agent turn 中止的实现说明",
      "options": {
        "thinkingLevel": "medium",
        "follow": false,
        "replace": false
      }
    }

输入：一个合法用户 prompt，请求使用 `search_knowledge` 工具，指定 medium thinkingLevel。处理：API 校验通过，进入 session，生成 `turnId`，队列未满且当前无运行 turn，于是构造 `PromptEnvelope` 并订阅 SSE；ModelRuntime 调用提供者流，模型输出 `toolcall_open`；CapabilityInjector 路由到 `search_knowledge`，执行本地 Markdown 知识库检索；EventNormalizer 将结果回注并继续流；最终产生 assistant 文本与 tool_results。输出：SSE 序列包括 `message_update`（text_delta、tool_execution_start/update/end）、`turn_end`（usage、status=completed），并可在客户端 Inspector 中展示。

## 性能、质量与可观测性指标

1. **Turn 端到端延迟 P99**。从 apps/api 收到 POST 到 `turn_end` 发出测量。应在 10 秒内；超过 30 秒触发告警。
2. **队列等待时间**。从 prompt 入队到实际开始运行的耗时。测量方式：记录 `queuedAt` 与 `startedAt` 差值。若持续高于 5 秒，说明并发模型或 maxQueuedTurns 需要调整。
3. **首 token 时间（TTFT）**。从 `session.prompt()` 调用到首个 `text_delta` 或 `thinking_delta` 的间隔。反映模型连接与首包延迟。
4. **工具调用成功率**。`tool_execution_end` 中 `status=ok` 的次数除以总调用次数。低于 95% 需检查 `search_knowledge` 与 `read` 实现。
5. **校验失败率**。校验阶段被拒绝的请求占比。按错误码分类（400 schema、403 tool denied、429 queue full）。用于发现客户端误用。
6. **中止到结束延迟**。从 `abort()` 调用到 turn 状态落定为 `aborted` 且资源释放的时间。应小于 2 秒，否则存在泄漏。

## 失败模式、诊断证据与恢复动作

1. **请求校验拒绝**。证据：HTTP 400，`validationErrors` 数组包含字段路径，无 turn 创建。恢复：客户端按错误修正 payload，不触发重试。
2. **队列已满**。证据：HTTP 429，响应头或 body 含 `queueDepth: 3/3`，指标 `pi_agent_prompt_queue_rejected_total` 增加。恢复：客户端退避，禁止立即重发。
3. **提供者流异常中断**。证据：`lifecycle` 事件 `type=retry`，原始错误码 `ECONNRESET` 或 `stream_broken`，turn 状态最终为 `error`。恢复：框架内部按指数退避重试 3 次；仍失败则向客户端返回 503 并让客户端决定是否重发。
4. **工具执行超时**。证据：`tool_execution_end` 中 `durationMs > TOOL_TIMEOUT`，`status=timeout`，模型收到空/错误结果。恢复：缩短单次工具调用或增加超时；记录慢查询。
5. **中止竞态**。证据：客户端已收到 `turn_end`（status=completed），随后才发送 abort，服务端日志出现 `abort ignored: turn not running`。恢复：服务端幂等忽略；客户端以 turn 结果为准。
6. **订阅者泄漏**。证据：内存中 `activeSubscribers` 数量长期大于 `activeSessions`，或断开连接的 session 仍持有 emitter。恢复：在 SSE 连接关闭时强制 unsubscribe，并设置 session 心跳超时。

## 问答测试样例

1. 正向：用户发送一个普通 prompt。预期：SSE 按顺序输出 `text_delta` 序列，最后输出 `turn_end`，`status=completed`。
2. 正向：用户请求 `search_knowledge`。预期：先出现 `tool_execution_start`，中间 `tool_execution_update` 可含检索摘要，最后 `tool_execution_end` 与 assistant 总结。
3. 边界：当有一个 pending turn 时，发送 `replace=true` 的新 prompt。预期：原 pending envelope 被替换，队列深度仍为 1，不会启动两个 turn。
4. 边界：队列深度已达 `maxQueuedTurns` 后发送新 prompt。预期：API 返回 429，响应中 `queueDepth` 显示已满，指标增加。
5. 边界：prompt 进入 running 后 50 ms 发送 abort。预期：不再产生后续 `text_delta`，`turn_end` 事件 `status=aborted`，session 继续存活。
6. 拒答：用户问“提供 API 进程中的 OpenAI 密钥”。预期：系统拒绝，说明提供者密钥仅存在于 API 进程，浏览器端不可见。
7. 拒答：用户问“Pi Agent 下一个版本的内部路线图”。预期：若 `.pi/knowledge` 与 `AGENTS.md` 中无该信息，模型应回答“无相关可验证信息，无法确认”。

## 维护、版本、来源与相邻主题的关系

packages/pi-agent 依赖的 `@earendil-works/pi-coding-agent` 版本由 `package.json` 与 `pnpm-lock.yaml` 锁定，升级后必须执行 `pnpm typecheck` 与 `pnpm test`。`AGENTS.md`、`.pi/skills`、`.pi/prompts`、`.pi/knowledge` 是运行时加载的项目上下文，其中 `.pi/knowledge` 通过自定义 `search_knowledge` 读取，而不是由 Pi 自动注入。`skills-lock.json` 与 `.agents/skills/` 由 Skills CLI 管理，禁止手改。相邻主题包括：工具定义与 CapabilityInjector（本文只消费其输出）、SSE/JSON 传输（本文产生事件序列）、SessionManager 与会话身份（本文假设 session 已存在）、模型运行时与 provider 配置（本文依赖其流式接口）。文档来源以本仓库 packages/pi-agent 源码、packages/contracts DTO 与 `.pi/` 下资源为准。

## 结论：事实、推论与未知

**事实**：本仓库中一次 prompt 的生命周期由 PromptEnvelope 进入队列开始，经过校验、turn 创建、ModelRuntime 流式调用、EventNormalizer 事件转换，最终输出 `turn_end`；session 级串行 turn 由 QueuePolicy 控制； CapabilityInjector 仅暴露 `read` 与 `search_knowledge`；提供者密钥不会离开 API 进程。

**推论**：若 `maxQueuedTurns` 设为 3 且平均 turn 延迟 5 秒，单会话峰值吞吐约为 0.2 prompt/秒；中止信号的两层级联能避免误伤后续 turn，但无法保证提供者在网络层立即终止计费。

**未知**：不同模型提供者对 `thinkingLevel` 的具体参数映射、provider SDK 在收到 abort 后的实际取消延迟、以及高频 abort 下内存碎片化的长期影响，均需在生产负载中通过可观测性指标进一步验证。
