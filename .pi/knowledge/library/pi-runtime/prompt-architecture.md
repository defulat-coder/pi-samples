---
type: concept
title: Prompt 与 turn：架构视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。一次 prompt 如何进入模型回合，以及排队、跟随和中止语义
resource: .pi/knowledge/library/pi-runtime/prompt-architecture.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, prompt, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: prompt
variant: architecture
---

# Pi Agent 运行时中的 Prompt 与 Turn：排队、跟随与中止语义

## 摘要与问题边界

本文描述 Pi Agent 运行时中，一条用户 Prompt 如何从应用层进入模型回合（Turn），以及在进入过程中由运行时负责的排队策略、跟随（follow）与中断（interrupt）语义、客户端中止传播和状态一致性。讨论范围限定在 `packages/pi-agent` 的会话生命周期、`apps/api` 的请求与 SSE 转发层、`packages/contracts` 的 DTO，以及 `AgentSession.prompt()` 的调用边界。不展开 provider 内部的 token 采样、不讨论 UI 渲染、不涉及具体 tool 的业务实现，也不覆盖模型安全审核策略。

## 核心概念与数据模型

1. **PromptRequest**：进入运行时的最小请求单元，包含 `text`、`attachments`、`correlationId`、`requestedTurnMode` 和 `capabilitiesHint`。它只声明“用户想发起一次交互”，并不保证立即占用模型上下文。
2. **Turn**：一次模型回合，由“输入上下文构建 → 模型流式输出 → 可选的 tool 调用循环 → 终止或失败”组成。每个 Turn 拥有全局唯一的 `turnId`，由运行时生成，与 provider 的 response ID 解耦。
3. **TurnQueue**：会话级单端队列，保存处于 `queued`、`running`、`paused` 状态的 Turn。队列的核心职责是维护“同一 Session 内的调用全序”，并提供 `append`、`replaceTail`、`interruptHead` 三种操作。
4. **SessionContext**：每次调用时由运行时组装的上文对象，包含历史 Turn 的摘要、已注入的只读工具声明（`read`、`search_knowledge`）和当前 `thinkingLevel`。Prompt 文本对 API 层不透明，API 禁止按关键字预路由。
5. **AbortController per Turn**：每个 Turn 绑定一个独立的 `AbortController`。客户端断开或主动取消时，信号沿调用链传递：API SSE → `AgentSession` → `TurnController` → `ModelRuntime`。中止是尽力而为的，provider 仍可能继续产生已计费 token。
6. **NormalizedEvent**：统一事件模型，所有 provider 输出被归一化为 `text_delta`、`thinking_delta`、`toolcall_*`、`tool_execution_*`、`turn_lifecycle`。事件必须携带 `turnId` 和单调递增的 `seq`，用于客户端重排与去重。
7. **TurnHandle**：`session.prompt()` 返回的句柄，包含 `turnId`、异步事件迭代器或 emitter，以及 `cancel()` 方法。调用方必须先订阅事件再触发 prompt，否则可能丢失首条 delta。
8. **Capability Injection Snapshot**：工具集合在 Turn 启动瞬间被快照，运行期间不允许新增或移除工具。Prompt 本身不能修改 allowlist，防止模型输出通过伪造请求扩大权限。

## 设计决策与取舍

### 1. 队列化而非同步 RPC
`AgentSession.prompt()` 不返回完整响应，而是返回 TurnHandle。原因是模型输出是流式的，且可能触发多轮 tool 循环，持续时间远超单个 HTTP 请求。将 Prompt 放入队列后，SSE 连接只是事件传输通道，断开不会直接终止会话。

### 2. 跟随、替换与中断三种模式
默认模式为 `follow`：新 Prompt 追加到队列尾部。Web 聊天场景下允许 `replacePending`：若队尾 Turn 尚未开始执行，则丢弃队尾并替换为最新 Prompt，避免用户连续输入导致旧请求堆积。`interruptRunning` 仅用于显式取消当前流式 Turn 并立即启动新 Turn，但会丢弃当前 tool 循环的中间状态，必须在 UX 中明确提示。

### 3. 客户端中止与服务器端取消分离
客户端 `AbortSignal` 只影响当前 SSE 连接对应的 Turn；服务器端的 `SessionManager` 持有会话进程，`cancel()` 不会销毁 Session。这样浏览器刷新后可重新订阅，但同一 Turn 不可恢复，因为运行时不保留完整 token 流用于重放。

### 4. 运行时生成 TurnId，客户端提供 CorrelationId
`turnId` 由 `packages/pi-agent` 在入队时分配，保证全序和唯一性。客户端可传入 `correlationId` 用于幂等去重：若同一 `correlationId` 已存在处于 `queued` 或 `running` 的 Turn，运行时返回现有 TurnHandle 而不是新建 Turn。

### 5. 只读工具与无关键字路由
根据项目边界，`apps/api` 仅注入 `read` 与 `search_knowledge` 两个只读工具。API 不得解析 Prompt 文本进行 intent 路由；是否调用工具完全由模型输出决定。这降低了 API 层的攻击面，也让新工具接入时只需修改运行时注入点。

### 6. 幂等重试与事件重放边界
当客户端因网络抖动重发同一 `correlationId` 时，运行时不重新调用模型，而是将已订阅的 Turn 事件流重新推送给新 SSE 连接。已完成或已取消的 Turn 只返回最终状态，不重放历史 delta，避免客户端状态复杂化。

## 可执行的实施流程

1. 在 `packages/contracts` 定义 `PromptRequest`、`Turn`、`TurnHandle`、`NormalizedEvent` 的 Zod/TypeScript 模式，明确 `turnId`、`correlationId`、`seq` 的不可空约束。
2. 在 `packages/pi-agent` 实现 `TurnQueue` 类，暴露 `enqueue`、`replaceTail`、`interruptHead`、`peek`、`abort(turnId)`，并保证操作原子性。
3. 实现 `TurnController`，为每个 Turn 创建独立 `AbortController`，维护 `queued → running → streaming → toolLoop → completed/cancelled/failed` 状态机。
4. 在 `AgentSession.prompt()` 中：生成 `turnId`，解析 `requestedTurnMode`，根据队列状态决定追加、替换或中断，返回 `TurnHandle`。
5. 在 `AgentSession` 中组装 `SessionContext`，注入工具快照与 `thinkingLevel`，调用 `ModelRuntime.generateStream()`。
6. 实现 `ModelRuntime` 事件适配器，将 provider 原始事件转换为 `NormalizedEvent`，打上 `turnId` 和 `seq`，并转发 `tool_execution_start/update/end`。
7. 在 `apps/api` 创建 POST `/sessions/{id}/prompt` 与 SSE `/sessions/{id}/events`：验证请求、注入 session 与 capabilities、先订阅事件流再调用 `session.prompt()`。
8. 在 API 层监听请求 `AbortSignal`，断开时调用 `turnController.abort(turnId)`，但保持 Session 对象存活；同时记录 `client_disconnect` 指标。
9. 在 `apps/web` 实现只消费 SSE 的 Inspector：不接触 Pi SDK 与 provider key，仅按 `turnId` 分组展示 deltas 与 tool 事件。
10. 补充单元测试覆盖队列状态转换、集成测试覆盖中止传播、端到端测试覆盖 follow/replace/interrupt 三种模式。

## 端到端示例：一次本地文件知识库调用

以下 JSON 展示一次进入运行时的 Prompt 及其事件序列。输入是用户请求检索本地 Markdown 知识库；处理由运行时完成排队、上下文注入、模型流式输出和 tool 调用；输出是一组归一化事件与最终回答。

    {
      "input": {
        "correlationId": "req-7a8b",
        "text": "解释 Pi Agent 的 SessionManager 与 AgentSession 的职责边界",
        "requestedTurnMode": "follow",
        "thinkingLevel": "auto"
      },
      "processing": [
        { "turnId": "t-42", "seq": 1, "type": "turn_lifecycle", "state": "queued" },
        { "turnId": "t-42", "seq": 2, "type": "turn_lifecycle", "state": "running" },
        { "turnId": "t-42", "seq": 3, "type": "toolcall_start", "name": "search_knowledge" },
        { "turnId": "t-42", "seq": 4, "type": "tool_execution_start", "tool": "search_knowledge" },
        { "turnId": "t-42", "seq": 5, "type": "tool_execution_end", "tool": "search_knowledge", "status": "ok" },
        { "turnId": "t-42", "seq": 6, "type": "text_delta", "delta": "SessionManager..." }
      ],
      "output": {
        "turnId": "t-42",
        "finalState": "completed",
        "text": "SessionManager 负责会话注册与生命周期...",
        "toolCalls": ["search_knowledge"]
      }
    }

输入中 `requestedTurnMode` 指定跟随策略，运行时发现队列空，于是将 `t-42` 立即置为 `running`。处理阶段先调用 `search_knowledge` 检索 `.pi/knowledge` 中的 Markdown，模型拿到检索结果后再生成文本 delta。输出中的 `toolCalls` 仅作审计，不暴露原始文件路径给浏览器。

## 性能、质量与可观测性指标

1. **Turn 端到端延迟**：从 `PromptRequest` 入队到 `turn_lifecycle` 为 `completed` 或 `failed` 的耗时，使用 `performance.now()` 在 `AgentSession.prompt()` 入口与最终事件处采样。
2. **队列等待时间**：`queued` 到 `running` 的时间差。通过直方图观察是否出现 head-of-line 阻塞，阈值建议为 500 ms。
3. **首 token 延迟**：`running` 到第一个 `text_delta` 或 `thinking_delta` 的时间。反映 provider 与上下文注入效率。
4. **事件序列正确性**：每 Turn 的 `seq` 必须严格单调；工具事件必须成对出现。通过集成测试断言，生产环境可用结构化日志抽查。
5. **取消成功率**：发起 `abort(turnId)` 后 1 秒内是否仍收到新的 delta。高于 5% 的持续漏出视为 provider 未正确响应取消信号。
6. **阶段错误率**：按 `validation`、`queue`、`provider`、`tool_execution`、`sse_forward` 分类统计异常，帮助定位是请求参数、运行时、模型还是传输层问题。

## 典型失败模式、诊断证据与恢复动作

1. **客户端刷新导致 SSE 断连**
   - 证据：API 日志出现 `client_disconnect`，对应 Turn 的最终事件未发出。
   - 恢复：调用 `abort(turnId)` 标记为 `cancelled`，不销毁 Session；用户重新连接后若 `correlationId` 仍在运行则继续订阅，否则收到最终状态。

2. **长 tool 循环阻塞后续 Prompt**
   - 证据：`queued` 状态 Turn 数量持续增长，队列等待时间 P95 超过阈值。
   - 恢复：默认模式保持 FIFO；在聊天场景可启用 `replacePending` 或允许用户显式 `interruptRunning`，但会丢失当前工具状态。

3. **取消信号被 provider 忽略**
   - 证据：`abort(turnId)` 后仍持续收到 delta 超过 1 秒，模型账单出现预期外 token。
   - 恢复：在 `TurnController` 中强制进入 `discarding` 状态，丢弃后续事件；向客户端发送 `turn_lifecycle:cancelled` 后关闭该 Turn 的 emitter。

4. **重试产生重复 Turn**
   - 证据：同一 `correlationId` 对应多个 `turnId`，客户端收到两份最终文本。
   - 恢复：在 `AgentSession.prompt()` 入口维护 `correlationId → turnId` 映射；命中已存在 Turn 时复用句柄，不新建模型调用。

5. **事件串扰到错误 Turn**
   - 证据：`turnId` 切换时 `seq` 不重置，或出现不属于当前 running Turn 的 delta。
   - 恢复：在事件适配层对每条消息断言 `turnId`；发现异常时关闭整个 Session 的事件流并记录错误，防止状态污染。

6. **replacePending 误删已启动 tool 调用**
   - 证据：`tool_execution_start` 后没有对应 `tool_execution_end`，最终状态为 `cancelled` 但业务未重试。
   - 恢复：将 `replaceTail` 限制为仅对 `queued` 状态生效；若队尾已进入 `running`，必须走 `interruptRunning` 并显式确认。

## 问答测试样例

1. **正向问题**：用户发送一条 Prompt，当前 Session 无运行中 Turn，会发生什么？
   - 答案：立即分配 `turnId`，状态从 `queued` 到 `running`，上下文快照后进入模型流式输出阶段。

2. **正向问题**：`replacePending` 模式在什么条件下才会替换队尾？
   - 答案：仅当队尾 Turn 仍处于 `queued` 且尚未开始执行时。

3. **边界问题**：用户在模型生成第一个 token 之前断开 SSE，该 Turn 会被取消吗？
   - 答案：API 会触发 `abort()`，但 provider 可能已生成未到达运行时的 token；Turn 状态最终标记为 `cancelled`，但可能产生计费。

4. **边界问题**：两个 Prompt 使用相同 `correlationId` 同时到达，运行时如何处理？
   - 答案：第二请求返回已有 `TurnHandle`，不创建新 Turn；事件流可共享给多个 SSE 订阅者。

5. **无证据拒答条件**：Prompt 中是否包含“请删除文件”会触发只读限制吗？
   - 答案：运行时不会解析文本关键字，API 只注入 `read` 与 `search_knowledge`；即便模型输出删除意图，也没有对应工具可调用，请求会被忽略或模型自行回答不可行。

6. **无证据拒答条件**：能否通过 Prompt 内容动态增加工具权限？
   - 答案：不能。工具集合在 Turn 启动时由 `AgentSession` 快照注入，Prompt 文本和模型输出均不可修改 allowlist。

## 维护、版本、来源与相邻主题

来源代码主要位于 `packages/pi-agent` 的 `AgentSession`、`TurnQueue`、`TurnController` 与 `ModelRuntime` 适配器；`apps/api` 负责请求验证、SSE 传输和 `AbortSignal` 桥接；`packages/contracts` 承载 DTO 与事件模式。版本管理应将这些 DTO 视为公共契约：对 `turnId` 格式、`NormalizedEvent` 字段、`requestedTurnMode` 枚举的修改属于破坏性变更，需同步提升主版本号并更新 `AGENTS.md` 中的集成契约。

相邻主题包括：模型运行时与 provider 适配（不在本文范围）、工具注册与 `defineTool()` 实现、`SessionManager.inMemory()` 的会话注册策略、SSE 与 JSONL 传输协议、`search_knowledge` 对 `.pi/knowledge` 的检索方式。本文假设这些组件已按项目边界正确实现，只关注 Prompt 如何被编排成 Turn。

## 结论

**事实**：`AgentSession.prompt()` 将 Prompt 转换为带 `turnId` 的 Turn；每个 Turn 经过排队、上下文注入、模型流式输出和可选 tool 循环；队列支持 follow、replacePending 与 interruptRunning 三种语义；API 只暴露只读工具并且不解析 Prompt 文本做关键字路由；客户端 `AbortSignal` 会尽力取消当前 Turn。

**推论**：在 Web 聊天场景下，`replacePending` 能显著降低队列积压，但前提是运行时准确区分 `queued` 与 `running`；`correlationId` 幂等机制可把网络重试转化为事件重订阅，而不是重复调用模型；事件序列号 `seq` 与 `turnId` 的强制标记是防止跨 Turn 状态污染的最小约束。

**未知**：不同 provider 对取消信号的实现细节尚未统一，实际取消成功率需通过生产指标测量；`interruptRunning` 后部分 provider 是否仍会对已发送的上下文计费，需要接入账单数据后才能给出量化结论；长期演进中，多模态附件是否应作为独立 mini-turn 排队还是嵌入当前 Turn，还需更多用例验证。
