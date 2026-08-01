---
type: concept
title: 输入状态：实现视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。在回答生成、工具执行和等待重试之间给出准确状态
resource: .pi/knowledge/library/web-streaming/typing-implementation.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, typing, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: typing
variant: implementation
---

# Web 流式交互中的输入状态：在生成、工具执行与重试之间给出准确状态

在浏览器通过 SSE 接收后端 Agent 响应时，用户提交一次消息并不意味着系统立即开始生成文本。实际路径通常依次经过请求校验、会话初始化、模型推理、工具调用、工具执行、结果回注、再推理、错误重试等阶段。若前端只显示“思考中”或“加载中”，用户无法判断是网络延迟、模型慢、外部工具阻塞还是系统在自动恢复。输入状态的核心问题不是动画效果，而是如何在生成、工具执行和等待重试之间建立一套后端驱动的有限状态机，提供可验证、可追踪、可恢复的阶段信息。

## 核心概念与数据模型

1. **请求入口**：API 收到 HTTP POST 后立即写入一条记录，状态置为 `accepted`，并返回 `202 Accepted` 与响应头 `X-Conversation-Id`、`X-Message-Id`。这是状态机的根节点。
2. **输入状态枚举**：`accepted`、`validating`、`model_generating`、`tool_calling`、`tool_executing`、`waiting_retry`、`error`、`completed`、`cancelled`。状态转换由后端事件驱动，前端禁止猜测。
3. **状态事件**：SSE 的特殊事件类型，字段包括 `state`、`transitionId`、`timestamp`、`retryCount`、`estimatedRetryAt`、`toolName`。它必须在对应文本或工具结果增量之前发送。
4. **工具执行令牌**：进入 `tool_executing` 时后端颁发的短期标识，用于将工具结果回注到原始消息。无令牌的结果视为孤立输出，不能写入同一次对话。
5. **重试策略记录**：保存 `maxRetries`、`backoffMs`、`retryableErrorCodes`、`lastErrorCode`、`nextRetryAt`。只有被明确分类为 `retryable` 的错误才能进入 `waiting_retry`。
6. **生命周期边界**：连接状态属于 transient 层，会话与对话状态必须持久化。SSE 断开不重置会话状态，重连后可通过事件标识或时间戳补发。
7. **取消语义**：前端点击停止后发送取消信号，状态转为 `cancelled`。此操作只停止后续生成，不撤销已持久化的状态或已执行的外部工具副作用。
8. **可观测性关联**：每条消息携带 `traceId`、`spanId`、`messageId`，确保日志、SSE 事件、数据库记录和前端行为可横向对齐。

## 设计决策与取舍

1. **状态由后端权威驱动**。前端只负责渲染，不推断当前阶段。代价是 SSE 流量增加约 10% 到 20%，但消除了“网络慢”与“模型慢”之间的歧义。
2. **工具决定与工具执行分离**。`tool_calling` 表示模型已输出工具请求，`tool_executing` 表示后端正在调用外部系统。本地同步工具（如本地文件读取）可合并为 `tool_calling`，因为执行通常低于 50 毫秒。
3. **重试状态显式暴露**。`waiting_retry` 必须附带倒计时和剩余次数。若后端不区分 `retryable` 与 `fatal` 错误，会导致用户看到无限循环。
4. **连接状态与会话状态解耦**。SSE 断开后 `conversation` 状态保留，通过 `Last-Event-ID` 或时间戳补发。后端维护最近 100 条或最近 5 分钟的事件缓冲区。
5. **输入状态不携带业务数据**。状态事件只描述阶段，不暴露工具参数、模型输出或用户隐私。工具参数需通过独立授权接口获取。

## 可执行的实施流程

1. 在 `packages/contracts` 定义联合类型 `type InputState = 'accepted' | 'validating' | ... | 'completed'`，确保 `apps/api` 与 `apps/web` 共享同一份类型。
2. API 收到用户 POST 后写入状态 `accepted`，返回 `202` 与 `X-Message-Id`。
3. 会话管理器订阅 Agent 事件流；订阅失败时直接转为 `error`，不进入后续阶段。
4. 校验输入阶段发送 `validating`；校验失败则状态 `error` 并结束 SSE。
5. Agent 开始生成时发送 `model_generating`，再发送文本增量。两者间隔超过 5 秒触发日志告警。
6. 工具调用时发送 `tool_calling`，确认可执行后发送 `tool_executing` 并颁发工具执行令牌。工具执行结束后先发送状态事件，再发送 `tool_result`。
7. 可重试错误触发 `waiting_retry`，附带 `nextRetryAt`；超过 `maxRetries` 后转为 `error` 并关闭流。
8. 流正常结束时发送 `completed`，前端收到后才解锁输入框。SSE 断开后前端通过 `Last-Event-ID` 请求补发，后端从缓冲区返回后续事件。

## 示例：输入、处理与输出

输入：用户消息“请读取 README 并总结”。

SSE 状态事件序列：

id:1 event:state data:{"state":"accepted"}
id:2 event:state data:{"state":"validating"}
id:3 event:state data:{"state":"model_generating"}
id:4 event:state data:{"state":"tool_calling","toolName":"read_file"}
id:5 event:state data:{"state":"tool_executing","estimatedDurationMs":200}
id:6 event:tool_result data:{"toolCallId":"tc_1","content":"..."}
id:7 event:state data:{"state":"model_generating"}
id:8 event:state data:{"state":"completed"}

处理：前端在 `accepted` 时显示“已提交”并禁用输入；在 `tool_executing` 时显示“读取 README 中……”；在 `completed` 时解锁输入框并渲染最终答案。

输出：用户始终知道当前处于哪一阶段，不会因长时间沉默而重复提交。

## 性能、质量与可观测性指标

1. **状态首包延迟**：从 HTTP 202 到首个 SSE 状态事件的时间，目标 P99 小于 200 毫秒，本地用 curl 测量。
2. **状态覆盖率**：一次对话中实际发生的状态种类数除以预期种类数，通过日志分析，目标 100%。
3. **状态与内容顺序正确率**：文本增量必须出现在对应状态事件之后，通过单元测试断言，目标 100%。
4. **重试时间准确度**：实际等待与声明的 `nextRetryAt` 偏差应小于 50 毫秒，通过测试模拟可重试错误。
5. **断线重连恢复率**：模拟 SSE 断开后正确补发并恢复状态，Playwright 测试，目标大于 99%。
6. **重复提交率**：因状态不明导致用户再次点击发送的次数，通过前端埋点测量，目标小于 1%。

## 失败模式

1. **状态事件丢失**：文本增量已出现但缺少前置状态事件。诊断证据：事件 `id` 序列不连续。恢复：后端通过事件缓冲区补发，前端按差值请求重发。
2. **工具执行后未回注状态**：工具已完成但前端仍显示“执行中”。诊断证据：工具端日志显示完成，但 SSE 无后续状态事件。恢复：设置工具执行超时，超时后强制转为 `error`。
3. **无限重试**：错误分类错误导致非重试性错误被标为 `retryable`。诊断证据：`retryCount` 持续递增并超过 `maxRetries`。恢复：严格限定 `retryableErrorCodes`，达到上限后转为 `fatal`。
4. **状态枚举漂移**：前后端状态定义不一致。诊断证据：前端日志出现“Unknown state: xxx”。恢复：状态枚举放入 `contracts` 包，通过 `pnpm typecheck` 在编译期强制一致。
5. **取消未生效**：用户点击停止后仍收到文本增量。诊断证据：cancel API 返回 200，但 SSE 继续推送。恢复：会话管理器维护 cancellation token，每次生成前检查。
6. **重连后状态丢失**：刷新页面后对话显示为“未开始”。诊断证据：数据库存在会话记录但前端未拉取。恢复：持久化状态快照，重连时通过 `GET /conversations/:id/states` 拉取完整状态机。

## 问答测试样例

1. **正向问题**：用户发送消息后应看到哪些状态？答案：至少依次看到 `accepted`、`validating`、`model_generating`、`completed`；若涉及工具，还会看到 `tool_calling` 和 `tool_executing`。
2. **边界问题**：工具执行超过 5 秒如何显示？答案：显示已执行时间；若超过 `estimatedDurationMs` 的两倍，则提示“执行时间超过预期”。
3. **边界问题**：在 `model_generating` 阶段断开 SSE，重连后能否继续？答案：可以，只要 conversation 状态已持久化且事件缓冲区包含最近事件。
4. **无证据拒答**：输入状态的延迟是多少毫秒？答案：无具体生产数据，目标 P99 为 200 毫秒，需在本地用 curl 测量。
5. **无证据拒答**：输入状态是否保证消息不被重复处理？答案：不保证，幂等性由 `messageId` 去重和会话管理器负责。
6. **边界问题**：`waiting_retry` 时能否发送新消息？答案：可以发送新消息，新消息启动独立状态机；重试本身需通过取消按钮停止。

## 维护、版本、来源与相邻主题

输入状态与“输出状态”“错误状态”“会话生命周期”“工具编排”相邻。输出状态负责文本片段的生成与渲染；输入状态负责用户消息在后端的处理阶段。错误状态被 `error` 和 `waiting_retry` 包含，但严重错误应进入独立的错误恢复工作流。

状态枚举在 `packages/contracts` 中定义，新增状态升级 minor 版本，删除状态升级 major 版本。每次发布前运行 `pnpm typecheck` 确认类型一致，运行 `pnpm test` 验证状态序列，检查事件缓冲区大小和 `retry policy` 中的错误码列表。

本文基于 pi-samples 项目中的 SSE 会话实现、AgentSession 事件订阅和 `contracts` 包定义。未引用外部数据库或实时系统，所有测量方法均可在本地通过 `pnpm dev` 环境复现。

## 结论

事实：输入状态是后端驱动的有限状态机，状态事件必须在内容增量之前发送；工具执行、重试等待、取消和验证失败都应作为独立状态。推论：严格实现状态事件、事件缓冲区和断线重连机制后，用户重复提交率和感知延迟会显著下降，前端代码可简化为纯渲染逻辑。未知：不同模型运行时在 `toolcall_start` 与首 token 之间的真实延迟分布，需要在生产环境收集数据后才能确定重试阈值和超时默认值。
