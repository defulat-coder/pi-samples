---
type: concept
title: Thinking level：实现视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。不同思考级别对可见事件、成本和回答稳定性的影响
resource: .pi/knowledge/library/pi-runtime/thinking-implementation.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, thinking, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: thinking
variant: implementation
---

# Pi Agent 运行时中的 Thinking Level 配置与实现

## 摘要与问题边界

Thinking level 是 Pi Agent 运行时的控制参数，决定模型在生成最终答案前是否输出、以及输出多少中间推理 token。本文从实现视角描述其输入、输出、错误形态、生命周期和验证步骤，然后再给出可落地的 TypeScript 编码路径。问题边界限定在 `packages/pi-agent` 的运行时配置与 `apps/api` 的 SSE 转发之间，不涉及模型训练、提示工程调优或浏览器端渲染策略。核心约束是：运行时不应为 provider 过滤 thinking 事件；API 层只负责身份验证、能力注入和事件透传；浏览器只消费 SSE 事件，绝不应接触 provider key 或原始模型客户端。

## 核心概念与数据模型

1. `thinkingLevel` 是 Observable 配置项。它被注册在会话管理器中，前端或上层服务可以在不重建会话的情况下切换其值，运行时通过订阅该 Observable 调整下一次 provider 调用参数。
2. 可见事件模型包含 `message_update` 下的 `text_delta` 与 `thinking_delta`，以及 `tool_execution_start`、`tool_execution_update`、`tool_execution_end` 等工具事件，还有 `lifecycle` 与 `retry` 事件。
3. Provider 不保证发送 `thinking_delta`。当 thinking level 被设为 none，或者当前 provider 不支持推理 token 输出时，事件流中不会出现该 delta 类型。
4. 成本模型由输入 token、最终输出 token 和推理 token 三部分组成。推理 token 通常会被 provider 计费，即使运行时没有把它暴露到前端。
5. 回答稳定性与采样温度、重复调用次数、thinking level 共同作用。高 thinking level 可能产生更完整的推理链，但并不必然降低最终答案的方差。
6. 项目自定义的 `search_knowledge` 工具与 thinking level 正交。二者分别控制本地知识库检索和模型推理暴露，可以独立启用或关闭。

## 设计决策与取舍

### 使用 Observable 而非静态配置

静态配置要求切换 thinking level 时重建会话，这会丢失上下文和工具状态。Observable 允许在会话生命周期内动态更新，但开发者必须确保 Observable 的变更被 `ModelRuntime` 在下一轮的 provider 调用中读取，而不是仅被前端状态持有。

### 在 API 层透传所有事件

API 层不应根据 `thinkingLevel` 的值过滤 `thinking_delta`。过滤逻辑属于前端渲染策略。这样做的好处是：同一套 SSE 协议可以支持多种 UI 选择；代价是：前端必须具备区分事件类型的能力，否则会把推理内容错误地混入最终答案。

### Provider key 与客户端隔离

`ModelRuntime` 和 provider 凭据只能存在于 `apps/api` 进程。SSE 负载只包含事件类型、delta 文本、工具结果等安全数据。该决策禁止了浏览器直接实例化 Pi SDK 或任何 provider 客户端，也排除了把 API key 通过 SSE 传输的可能。

### 持久化 thinking level 到会话状态

会话重载时，运行时需要恢复用户之前的 `thinkingLevel`。这通过 `SessionManager.inMemory()` 的会话元数据或外部会话存储实现。持久化增加了状态一致性复杂度：切换后必须确保已订阅的 SSE 连接接收到新级别的行为，而不是旧级别的残留事件。

### 默认级别选择低或关闭

默认关闭 thinking 可以降低首 token 延迟和单次请求成本。对于需要多步推理的复杂查询，用户或系统再显式切换到 medium 或 high。该决策牺牲了开箱即用的推理可视性，换取了大多数简单查询的响应速度和成本可控性。

## 可执行的实施流程

1. 在 `packages/contracts` 定义 `CreateSessionRequest` DTO 和 `ThinkingLevel` 联合类型，取值建议为 `none | low | medium | high`。
2. 在 `packages/pi-agent` 的会话工厂中把 `thinkingLevel` 注册为 `observable`，并在 `createAgentSession()` 时将其与 `ModelRuntime` 一起传入。
3. 在 `DefaultResourceLoader` 初始化时以项目 `cwd` 加载 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`，确保项目级上下文被注入。
4. 在 `session.prompt()` 调用前完成事件订阅，订阅回调必须区分 `thinking_delta` 和 `text_delta` 两种 message_update 事件。
5. 在 `apps/api` 的 SSE 端点中，将运行时事件序列化为 JSON 行，包含 `event`、`payload` 和可选的 `message_id`。
6. 在 `apps/web` 中实现 SSE 消费者，根据 `event` 字段把 delta 追加到对应消息缓冲区，绝不在前端保存或转发 provider key。
7. 编写测试覆盖三个场景：thinking 开启、thinking 关闭、以及 provider 不支持 thinking 时的回退行为。
8. 部署验证：检查 SSE 日志中 `thinking_delta` 出现次数与预期是否一致，并对比成本估算是否随 level 上升而增加。

## 配置示例与输入输出解释

下面给出一份贴近当前 monorepo 的 TypeScript 接口示例。输入为创建会话时的参数对象，处理由运行时会话工厂完成，输出为 SSE 流中的事件类型。

    interface CreateSessionRequest {
      modelRuntime: string;
      thinkingLevel: 'none' | 'low' | 'medium' | 'high';
      skillContext: string[];
    }

    function createAgentSession(config: CreateSessionRequest) {
      const session = runtime.createSession({
        model: config.modelRuntime,
        thinkingLevel: observable(config.thinkingLevel),
        tools: [readTool, searchKnowledgeTool],
        cwd: projectRoot,
      });
      return session;
    }

输入：客户端提供模型运行时标识、thinking 级别、需要注入的技能上下文数组。处理：运行时把 Observable 级别的值映射为 provider 参数，加载项目资源，订阅事件流。输出：SSE 流中可能出现 `thinking_delta` 事件、也可能不出现，取决于级别和 provider 能力；最终答案通过 `text_delta` 事件累积。

## 性能、质量与可观测性指标

1. 首 token 延迟：从 `session.prompt()` 调用到首个 SSE 事件到达的时间。应在不同 thinking level 下分别测量，高 level 通常延迟更高。
2. 完整响应时间：从 prompt 到 `message_end` 事件的时间。用于评估用户感知的端到端耗时。
3. token 生成速率：单位时间内收到的 `text_delta` 数量。结合推理 token 占比可以判断模型是否过度思考。
4. 推理 token 占比：`thinking_delta` 字符数除以全部 delta 字符数。该比例在不同 provider 和任务间差异较大。
5. 单次查询成本：根据输入 token、输出 token 和推理 token 数量乘以 provider 单价计算。必须在 API 层记录，不能依赖前端估算。

## 失败模式、诊断证据与恢复动作

1. 客户端期望 `thinking_delta` 但 provider 未发送。诊断证据：thinkingLevel 非 none，但 SSE 流中仅有 `text_delta` 与工具事件。恢复：将事件流降级为纯文本处理，记录该 provider 不支持 thinking，避免前端报错。
2. 动态切换 thinkingLevel 后未生效。诊断证据：切换后新请求仍按旧级别输出。恢复：检查 Observable 是否被 `ModelRuntime` 重新读取，必要时触发一次新的 provider 参数构建，而非仅更新前端状态。
3. 成本突增。诊断证据：单次请求推理 token 占比超过阈值，或成本日志显著高于历史基线。恢复：限制用户可选择的最高级别，或在 API 层设置单次请求成本上限。
4. SSE 重连导致 delta 重复。诊断证据：同一 `message_id` 与同一 delta 索引出现多次。恢复：前端按 `message_id` 与 delta 序号去重；API 层不重新发送完整历史，只发送后续事件。
5. 前端把 thinking 内容显示为最终答案。诊断证据：用户看到类似“让我先分析”的文本混入回答。恢复：严格按 `thinking_delta` 与 `text_delta` 分开渲染，并为 thinking 内容使用独立视觉层级。

## 问答测试样例

1. 正向问题：当 thinkingLevel 设为 high 时，SSE 流中可能包含哪些事件？预期答案：`text_delta`、`thinking_delta`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end` 以及生命周期事件。
2. 正向问题：如何在不重建会话的情况下切换 thinking level？预期答案：通过更新 Observable 配置项，由运行时在下一次 provider 调用中读取。
3. 边界问题：当 thinkingLevel 为 none 时，是否一定没有 `thinking_delta`？预期答案：是，运行时不请求推理 token，因此不会生成该事件。
4. 边界问题：当 provider 不支持 thinking 时，API 应返回错误吗？预期答案：不应返回错误，应降级为纯文本流并继续正常响应。
5. 无证据时的拒答：模型的内部推理算法具体如何工作？预期答案：项目文档未提供该实现细节，无法回答。
6. 无证据时的拒答：推理 token 的计费单价是否与普通输出 token 相同？预期答案：未在项目中定义，需查阅 provider 官方价格文档。

## 维护、版本、来源与相邻主题

本实现依赖 `@earendil-works/pi-coding-agent` 的 SDK 版本，运行时接口应以该版本为准。项目来源包括 `AGENTS.md`、`.pi/skills` 下的技能定义、`.pi/prompts` 下的提示模板以及 `docs/pi-agent-learning.md` 中的本地架构说明。相邻主题包括：ModelRuntime 配置与 provider 选择、SSE JSON 事件协议、会话生命周期与订阅管理、工具注册与 `defineTool()` 合约、以及资源加载与项目信任边界。升级 SDK 时，应重点检查 `AgentSession` 与 `createAgentSession()` 的签名变化，以及 `thinking_delta` 事件类型是否被重命名。

## 结论

事实：thinking level 控制运行时是否请求以及是否暴露推理 token；事件流通过 SSE 从 API 层透传到前端；provider 对 `thinking_delta` 的支持不是必然的；provider key 和原始模型客户端始终保留在 API 进程。推论：较高的 thinking level 通常会增加首 token 延迟和单次请求成本，并改变事件流形状；它对最终回答稳定性的影响取决于模型能力与具体任务类型，不能简单认为越高越稳定。未知：不同模型在各任务上的推理 token 消耗比例；provider 对推理 token 的具体计费策略；以及在长期会话中频繁切换 thinking level 是否会对上下文连贯性产生累积影响。
