---
type: concept
title: Prompt 与 turn：验证与运维视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。一次 prompt 如何进入模型回合，以及排队、跟随和中止语义
resource: .pi/knowledge/library/pi-runtime/prompt-operations.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, prompt, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: prompt
variant: operations
---

# Pi Agent 运行时：Prompt 进入 Turn 的排队、跟随与中止语义

## 摘要与问题边界

本文从验证与运维视角记录一次 prompt 在 Pi Agent 运行时中的完整路径：从 `apps/api` 接收请求，到 `packages/pi-agent` 排队、调度为一个模型 turn，再到与前后 turn 建立跟随关系，最后因成功、失败或客户端取消而终止。讨论边界止于 SSE/JSON 事件流关闭；不涉及模型训练、provider 计费、前端 UI 状态或多 agent 编排。

## 核心概念与数据模型

1. **PromptEnvelope**：一次用户提交的语义单元，包含原始文本、`request_id`、`parent_turn_id`、capability 标记和提交时间戳。`request_id` 用于幂等去重，`parent_turn_id` 决定 turn 跟随链。

2. **TurnRecord**：模型回合的运行时对象，状态机为 `pending` → `queued` → `active` → `completed`/`failed`/`aborted`。字段记录入队时间、首 token 时间、结束时间、token 计数、工具调用次数和事件摘要。

3. **SessionQueue**：每个会话维护一条 FIFO 队列，保证同 session 的 turn 按进入顺序执行；队列深度受 `max_pending_turns` 限制。跨会话并发由全局信号量 `max_concurrent_model_turns` 控制。

4. **FollowContext**：维持对话连续性的上下文包。执行新 turn 前，运行时根据 `parent_turn_id` 拉取前序 turn 的完整输出快照，包括 assistant message、tool results 和 thinking trace，而不是依赖客户端再次上传历史。

5. **AbortToken**：由客户端 SSE 连接关闭或 HTTP 取消信号生成的协作式取消令牌。它设置 `is_aborted` 标志，运行时在下一个可取消点检查并停止生成；已发出的 token 和已执行的工具结果不回滚。

6. **EventStream**：将 Pi SDK 事件归一化为 SSE 的通道，类型包括 `message_update`（`text_delta`、`thinking_delta`）、`tool_execution_start/update/end`、`lifecycle`（`turn_start`、`turn_end`）、`retry`（`backoff`、`reason`）。`apps/api` 只转发，不解释语义。

## 设计决策与取舍

### 会话级 FIFO 与全局并发隔离

单 session 内按到达顺序执行 turn，保证状态一致；但一个慢 turn 会导致同 session 后续请求队头阻塞。全局并发槽位跨 session 共享，提升利用率，却引入竞争。取舍方案：保留 FIFO，为每个 session 设置 `max_pending_turns` 上限，并允许配置 `turn_timeout` 防止无限占用。

### 异步流式响应替代同步阻塞

模型生成可能持续数十秒，同步 HTTP 会放大超时误判。采用 SSE 后，客户端可观测首 token 延迟和工具进度；代价是 `apps/api` 必须维护长连接、重连状态与事件顺序。不支持 SSE 的客户端可降级为一次性 JSON，但会丢失中止信号。

### 中止语义为协作式而非回滚

直接 kill 进程会破坏资源锁，因此运行时仅在可取消点读取 AbortToken：模型层在每次 delta 输出后检查，工具层在两个调用之间检查。该设计优先保证稳定性，缺点是客户端取消后仍可能收到少量缓冲事件。

### 跟随关系使用完整快照

为避免增量合并的复杂性，`FollowContext` 拉取 parent turn 的完整最终输出快照。优点是可复现、调试简单；缺点是长对话快照体积线性增长。缓解方式：快照保留引用 ID，正文从 turn store 延迟加载并支持截断。

### 运行内部重试与外部致命错误分离

对于 provider 5xx、超时、空响应等瞬时错误，`packages/pi-agent` 内部使用指数退避重试，最多 `max_retries` 次，并发送 `retry` 事件。对于参数非法、额度耗尽、安全策略拒绝等致命错误，立即标记 `failed`，不重试。

## 可执行实施流程

1. **请求校验**：`apps/api` 校验 DTO，确认 `session_id`、`request_id`、`parent_turn_id` 格式合法；若 `parent_turn_id` 不存在且请求非首 turn，返回 `400`。
2. **身份与能力注入**：将 provider key、可用工具列表（本项目中仅 `read`、`search_knowledge`）绑定到调用上下文；provider key 不返回前端。
3. **项目上下文加载**：使用 `DefaultResourceLoader` 读取项目 `cwd` 下的 `AGENTS.md`、`.pi/skills`、`.pi/prompts`；`.pi/knowledge` 仅在后续显式调用。
4. **会话初始化**：通过 `SessionManager.inMemory()` 获取或创建会话；配置 `ModelRuntime`、`thinkingLevel`，构造 `AgentSession`。
5. **事件订阅**：在调用 `session.prompt()` 之前订阅 `message_update`、`tool_execution_*`、`lifecycle`、`retry` 事件；确保早期事件不丢失。
6. **排队**：创建 `TurnRecord` 置为 `queued`，推入 `SessionQueue`；若队列深度超过阈值，记录等待时间并触发背压告警。
7. **获取并发槽位**：等待全局信号量；支持超时与 AbortToken 提前退出；超时则标记 `failed`，原因 `capacity_timeout`。
8. **执行与转发**：进入 `active`，调用 `session.prompt()`，传入 `PromptEnvelope` 与 `FollowContext`；按顺序转发事件流，工具结果写入当前 turn。
9. **终止与清理**：turn 完成后更新 `TurnRecord` 状态、首 token 时间、完成时间；unsubscribe 并 dispose；释放并发槽位并唤醒下一排队 turn。

## 输入、处理与输出示例

下面是一次 prompt 的简化请求 DTO 与事件流片段，使用 JSON 表示。

    {
      "request_id": "req_2a8f",
      "session_id": "sess_91b4",
      "parent_turn_id": "turn_3c11",
      "prompt": {
        "role": "user",
        "content": "用 search_knowledge 查 .pi/knowledge 中关于 abort 的说明"
      },
      "capabilities": ["read", "search_knowledge"],
      "abort_token": "conn_7d22"
    }

处理时，`apps/api` 校验参数后进入 `packages/pi-agent`；`SessionManager` 按 `session_id` 找到会话，将请求排入 `SessionQueue`；拿到全局并发槽位后调用 `session.prompt()`，模型可能输出 thinking delta，随后调用 `search_knowledge`，最后返回 text delta。输出流片段如下：

    event: lifecycle
    data: {"type":"turn_start","turn_id":"turn_4d09","request_id":"req_2a8f"}

    event: message_update
    data: {"type":"thinking_delta","text":"需要检索..."}

    event: tool_execution_start
    data: {"tool":"search_knowledge","args":{"query":"abort"}}

    event: tool_execution_end
    data: {"tool":"search_knowledge","status":"ok"}

    event: message_update
    data: {"type":"text_delta","text":"在 Pi Agent 运行时中，中止..."}

    event: lifecycle
    data: {"type":"turn_end","turn_id":"turn_4d09","status":"completed"}

输入是请求 DTO 与上下文；处理是排队、模型调用、工具执行、事件转发；输出是 SSE 事件序列和最终的 `TurnRecord`。

## 性能、质量与可观测性指标

1. **Turn 延迟分位值**：测量 `enqueue_time` 到 `first_token_time`（TTFT）以及 `enqueue_time` 到 `turn_end`（TTF）。TTFT 升高提示上下文加载或模型排队问题，TTF 升高常伴随长工具调用。
2. **队列深度与等待时间**：按 `session_id` 记录 `SessionQueue` 长度和每个 turn 等待秒数。持续超过 `max_pending_turns` 的 80% 说明容量不足。
3. **流式事件间隔抖动**：计算相邻 `message_update` 的时间差，检测 provider 卡顿或网络缓冲。抖动超过 5 秒可触发降级或告警。
4. **分类错误率**：将错误标记为 `validation`、`provider_transient`、`provider_fatal`、`tool`、`client_abort`、`capacity`，分别计数并按 `session_id` 下钻。
5. **中止泄漏**：扫描 `turn_end` 中 `status=aborted` 与实际收到 AbortToken 的匹配率。存在 turn 已完成却收到取消信号，说明取消传播存在竞态。

## 失败模式、诊断证据与恢复动作

1. **同会话队头阻塞**：证据是后续 turn 等待时间持续增长，队列前端 turn 长时间 active。恢复：配置 `turn_timeout`，超时后强制置 `failed`，释放槽位并记录原因。
2. **Provider 瞬时错误**：证据是连续 `retry` 事件后最终 `failed`，错误码 5xx/429 且重试次数耗尽。恢复：运行时内部已指数退避；运维侧监控 429 频率并扩容或切换模型。
3. **客户端断开未携带 abort**：证据是 SSE 连接关闭但 `TurnRecord` 继续 active，最终成为 orphan。恢复：连接关闭时立即注入 AbortToken，并设置 `orphan_turn_max_lifetime` 自动中止。
4. **会话队列满载**：证据是 API 返回 429 并带 `Retry-After`，监控中 `session_queue_full` 计数上升。恢复：水平扩容实例，或降低 `max_pending_turns` 使客户端尽早退避，不要简单扩大队列。
5. **跟随指针损坏**：证据是 `parent_turn_id` 不存在或指向 `aborted`/`failed` turn，导致 `FollowContext` 加载失败。恢复：返回 `400` 提示客户端重新对齐；服务端保留最近 N 个 turn 快照用于修复。

## 问答测试样例

1. 正向：一次 prompt 进入队列后的状态迁移是什么？
   答：`pending` → `queued` → `active` → `completed`/`failed`/`aborted`。

2. 边界：全局并发已满但 session 队列未满时 prompt 会怎样？
   答：进入 `SessionQueue` 排队，待槽位释放后调度；除非等待超过 `capacity_timeout`。

3. 边界：首 token 发出后客户端断开，turn 如何结束？
   答：连接关闭触发 AbortToken，运行时在可取消点停止生成，状态为 `aborted`，已发出事件保留。

4. 边界：`parent_turn_id` 指向 failed turn 是否允许创建新 turn？
   答：允许，但 `FollowContext` 会加载该 failed turn 的快照，模型据此决定如何继续。

5. 无证据拒答：当前 turn 的 token 成本是多少？
   答：无法从运行时事件直接得出，本设计不暴露计费字段；只能测量输出字节数，成本需查询 provider 账单。

6. 无证据拒答：一次 prompt 最多支持多少轮工具调用？
   答：项目未规定固定上限，实际受 `turn_timeout` 与模型上下文窗口限制；超过 `turn_timeout` 将被强制结束。

## 维护、版本、来源与相邻主题关系

本文基于项目 `AGENTS.md`、`packages/pi-agent` 实现约定以及 `@earendil-works/pi-coding-agent` SDK 的事件语义编写，版本与 monorepo 当前提交锁定。维护时应与 `apps/api` 的请求校验、`packages/contracts` 的 DTO、`packages/pi-agent` 的会话实现同步更新。相邻主题包括：工具注册与能力注入、SSE/JSON 传输协议、模型运行时与 `thinkingLevel` 配置、会话持久化与 `SessionManager`。本主题不涵盖 provider key 管理、前端状态、模型安全策略。

## 结论

**事实**：一次 prompt 首先被 `apps/api` 校验，随后进入 `SessionManager` 维护的 per-session FIFO 队列；获得全局并发槽位后成为 active turn；`packages/pi-agent` 通过 `AgentSession` 调用模型，事件经归一化后通过 SSE 转发；中止由协作式 AbortToken 实现，已产生状态不回滚；`.pi/knowledge` 仅在被 `search_knowledge` 调用时读取。

**推论**：当 P99 TTFT 或队列等待时间持续升高时，瓶颈大概率在全局并发槽位或单 turn 工具调用时长，而非网络传输；同时收紧 `turn_timeout` 与 `max_pending_turns` 可保护后端，但会提高客户端 429 率。

**未知**：不同 provider 对同一 AbortToken 的响应延迟是否存在显著差异；长时间运行后 `SessionManager.inMemory()` 的内存占用与 turn 历史快照的最佳清理策略；水平扩容对单 session FIFO 顺序保证的影响需要实测验证。
