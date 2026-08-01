---
type: concept
title: 上下文预算：实现视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。系统提示、工具说明、检索片段和历史消息如何共同消耗预算
resource: .pi/knowledge/library/agent-design/context-implementation.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, context, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: context
variant: implementation
---

# 上下文预算：在 TypeScript Agent 中把系统提示、工具说明、检索片段与历史消息量化分配到模型窗口

## 摘要与问题边界

上下文预算不是“把提示词写短一点”，而是把模型输入窗口拆成可度量的配额，按优先级喂给系统提示、工具说明、检索片段和历史消息。在 TypeScript 实现里，它的核心问题是：给定一个模型窗口上限 `maxInputTokens`、一次输出预留 `outputReserve` 和若干必要开销后，如何在前端请求到达时，快速决定哪些内容必须进入、哪些可以压缩、哪些必须丢弃，并且让每一次调用都能被审计、复现和回归测试。边界在于：我们只讨论输入侧的静态与动态配额，不讨论输出解码、训练后微调或模型本身的上下文外推理；所有数字都是项目级可配置常量，而非某个固定模型的绝对值。

## 核心概念与数据模型

1. `totalInputBudget`：模型输入窗口减去输出预留和固定安全余量后的可用 token 数。例如 `maxInputTokens = 128000`，`outputReserve = 8000`，`safetyMargin = 0.05`，则 `totalInputBudget = 128000 × (1 − 0.05) − 8000 = 113600`。这是硬性上限，越过它就会被 API 拒绝或导致末位截断。
2. `budgetConsumer`：四类固定消费者——系统提示 `systemPrompt`、工具说明 `toolManifest`、检索片段 `retrievalChunks`、历史消息 `historyMessages`。每个消费者都有权重、最小保留量 `minTokens`、最大占用量 `maxTokens` 和压缩策略。
3. `componentCost`：对每一段文本按本地 tokenizer 进行计数，并乘以语言相关的膨胀系数。中文文本可能按字符或子词计数，代码和 JSON  Schema 通常比自然语言更密，因此必须分别估算。
4. `allocationPolicy`：优先级队列，默认顺序为系统提示优先、工具说明次之、检索片段再次、历史消息最后。例外情况：用户显式要求“基于上一轮对话”时，可把最近若干轮历史提升到工具说明之前。
5. `budgetState`：生命周期状态包括 `planned`（计划分配）、`validated`（通过本地校验）、`dispatched`（已发送）、`actual`（收到 usage 回执）、`adjusted`（根据误差更新下一轮的余量）。
6. `truncationDecision`：当总需求超过预算时，按策略执行裁剪。策略包括：截断最旧历史、压缩长工具说明、丢弃低分检索片段、用摘要替换远期历史。每一种裁剪都必须记录 `reason`、`droppedTokens`、`remainingTokens`。

## 设计决策与取舍

### 固定预算 versus 动态预算

固定预算把每个消费者的配额写死在配置文件里，测试简单，可预期性强；但在长对话或知识密集型请求中，检索片段和历史消息会互相挤压。动态预算根据当前请求的长度、工具数量和检索结果条目实时计算，利用率更高，却难以做端到端断言。推荐混合方案：给系统提示和工具说明固定下限，给检索片段和历史消息动态上限。

### 全局封顶 versus 单类封顶

全局封顶只保证总输入不超过窗口，但容易出现“检索片段把历史消息全部挤掉”或“历史消息淹没系统提示”的零和博弈。单类封顶为每一类消费者设置 `maxTokens`，能防止单一组件垄断预算。代价是：当某类内容特别短时，剩余空间无法被其他组件借用，除非额外实现跨类借贷池。一般至少保留 5% 到 10% 的共享池。

### 截断旧历史 versus 摘要历史

直接截断旧历史实现成本低，不会引入额外延迟，但会丢失跨轮指代和约束。摘要历史通过二次调用把远期对话压缩成要点，保留语义 longer，但消耗一次模型调用或本地摘要服务，且摘要本身也会占预算。决策边界：当历史超过 40% 输入预算时启用摘要，否则直接截断。

### 完整工具 Schema versus 精简工具描述

完整 JSON Schema 能让模型生成更准确的 tool call，减少参数错误；但复杂工具可能一次占去数千 token。精简描述节省空间，却可能导致参数名歧义。取舍原则：核心工具保留完整 schema，边缘工具用“名称 + 一句话描述 + 示例”替代。如果工具被错误调用率超过阈值，则回退到完整 schema。

### 同步 token 估算 versus 异步估算

同步估算在请求进入时就完成，便于立即报错和拒绝；但如果检索片段来自本地文件或向量数据库，token 数需要在 I/O 后才能确定。异步估算把计数推迟到检索完成后，更准确，却会让调用链变长。实现上可把系统提示和工具说明做同步预计算，检索片段和历史消息做异步后计算。

## 可执行的实施流程

1. 输入：从配置读取 `maxInputTokens`、`outputReserve`、`safetyMargin`、`priorityOrder`、`componentCap`。校验这些数字是否为正整数、优先级是否包含全部四类消费者、是否互斥。
2. 输入：读取系统提示和工具说明文件。对系统提示进行静态 token 估算；对工具说明按“完整或精简”策略预计算。如果估算失败，立即返回错误 `BUDGET_ESTIMATE_FAILED`，不进入模型调用。
3. 输入：接收用户请求、会话标识和检索参数。根据会话标识从内存或缓存读取历史消息。
4. 处理：计算 `totalInputBudget`，再依次减去系统提示和工具说明的预留。如果这两项已超过预算的 60%，则标记 `BUDGET_PRESSURE_HIGH`，供后续告警使用。
5. 处理：执行检索，获取候选片段。按相关度分数排序，逐个累加 token 数，直到触及检索片段类上限或剩余预算。得分低于阈值或无法被 budget 容纳的片段直接丢弃，并记录 `RETRIEVAL_TRUNCATED`。
6. 处理：把历史消息按时间倒序放入预算。放入时逐条累加 token，遇到类上限或总预算耗尽时停止。剩余未放入的历史可标记为 `HISTORY_TRUNCATED`，或转交给后台摘要任务。
7. 验证：最终组装后的 payload 必须再次通过本地 tokenizer 计数。比较 `plannedTokens`、`validatedTokens`、`safeBudget`：如果 `validatedTokens > safeBudget`，返回 `BUDGET_OVERFLOW`，并回退到更激进的截断策略。
8. 输出：把 payload 和元数据 `{ sessionId, budgetVersion, plannedTokens, validatedTokens, componentBreakdown, truncationFlags }` 一起发送给模型。如果 API 调用失败，根据 HTTP 状态码区分：400 类多为模型格式错误，413/429 类多为真实 token 超限。
9. 生命周期：模型返回后读取 `usage.prompt_tokens`，与 `validatedTokens` 比较，计算 `estimateError`。如果误差持续超过 3%，则调整膨胀系数或切换 tokenizer。
10. 验证：把本次的 budget 决策、实际 usage、误差、truncationFlags 写入审计日志，用于回归测试和可观测性查询。

## 本地 Markdown 知识库与 Web API 配置示例

下面是一个可在 TypeScript 项目里读取的 JSON 配置，适用于 Web 请求命中本地文件知识库的场景：

    {
      "budgetVersion": "v1.2.0",
      "modelContext": {
        "maxInputTokens": 128000,
        "outputReserve": 8000,
        "safetyMargin": 0.05
      },
      "components": [
        {
          "id": "system_prompt",
          "priority": 1,
          "minTokens": 500,
          "maxTokens": 4000,
          "strategy": "full"
        },
        {
          "id": "tool_manifest",
          "priority": 2,
          "minTokens": 800,
          "maxTokens": 12000,
          "strategy": "auto"
        },
        {
          "id": "retrieval_chunks",
          "priority": 3,
          "minTokens": 0,
          "maxTokens": 24000,
          "strategy": "rerank_then_drop"
        },
        {
          "id": "history_messages",
          "priority": 4,
          "minTokens": 0,
          "maxTokens": 64000,
          "strategy": "truncate_oldest"
        }
      ],
      "sharedPool": 0.08
    }

输入是上述 JSON 和一次具体请求：用户问“如何配置本地 Markdown 知识库的检索上限”，系统提示为 1200 token，两个核心工具说明共 3500 token，检索返回 10 个片段共 18000 token，历史消息共 45000 token。处理过程：先算 `totalInputBudget = 113600`，系统提示和工具说明共 4700，剩余 108900；检索片段按 18000 放入，剩余 90900；历史消息放入 45000，剩余 45900。由于共享池为 8%，上限为 9088，四类消费者都未触及自己的 maxTokens，因此无需截断。输出是完整 payload 和 budget 元数据：`validatedTokens = 61700`，`truncationFlags = []`。如果检索片段变为 60000，则它会在 24000 上限处被截断，剩余历史消息仍可使用 72000 左右，此时 `truncationFlags = ["RETRIEVAL_TRUNCATED"]`。

## 性能、质量和可观测性指标

1. `budgetUtilization = usage.prompt_tokens / totalInputBudget`。测量方法：每次模型响应后取 `usage.prompt_tokens`，除以配置中的预算上限。目标区间 60% 到 85%，过低说明预留过度，过高说明截断风险大。
2. `estimateError = |validatedTokens − usage.prompt_tokens| / usage.prompt_tokens`。测量方法：对比本地估算和 API 返回。目标小于 3%；超过 5% 应触发 tokenizer 校准。
3. `truncationRate = 含 truncationFlags 的请求数 / 总请求数`。测量方法：从审计日志聚合。按组件拆分，观察历史截断是否高于检索截断。
4. `toolSelectionAccuracy = 正确 tool 调用数 / 总 tool 调用数`。测量方法：通过回归测试集或运行时结果校验。当精简策略导致准确率下降时，回退为完整 schema。
5. `retrievalAnswerRelevance = 答案包含检索片段证据的比例`。测量方法：用人工或模型评估，检查是否因 budget 不足丢弃了关键片段。目标是关键片段保留率 95% 以上。
6. `assemblyLatency`：从请求到达完成 budget 组装的时间。测量方法：在 TypeScript 服务中记录 `Date.now()` 差值。本地 tokenizer 和异步检索应控制在 50 毫秒以内。

## 失败模式、诊断证据与恢复动作

1. Tokenizer 不一致导致估算偏低。诊断证据：本地估算显示 110000，API 返回 413 或 429 并指出真实 prompt 为 115000。恢复：使用与模型对齐的 tokenizer 包，或在安全余量上增加 2% 到 5% 的补偿系数。
2. 工具说明垄断预算。诊断证据：`toolManifest` 占用超过 40%，历史消息被截断为零，导致模型无法引用用户前一条指令。恢复：为核心工具保留完整 schema，把非核心工具改为精简描述，并设置 `toolManifest` 的 maxTokens。
3. 检索片段灌满预算。诊断证据：`retrievalChunks` 达到上限，但答案与检索片段无关，或出现大量“根据文件内容……”的空泛表述。恢复：引入重排序并设置每片段 token 上限，把低分片段丢弃。
4. 历史截断丢失关键约束。诊断证据：模型在多轮对话中重复询问已提供过的信息，或违背用户之前设定的偏好。恢复：把用户显式约束单独提取为持久化摘要，而不是依赖完整历史。
5. 隐藏内容泄漏预算。诊断证据：`usage.prompt_tokens` 始终高于所有组件统计之和，且差距稳定。恢复：审计所有中间模板、错误消息、元数据和调试字段，确保它们不随请求进入模型。
6. 异步检索与 budget 组装竞态。诊断证据：检索尚未完成时 budget 已按旧结果截断，导致新请求使用了旧片段。恢复：把检索完成作为 budget 组装的依赖节点，或在检索超时后强制使用固定缓存片段。

## 问答测试样例

1. 正向问题：当前配置 `maxInputTokens=128000`、`outputReserve=8000`、`safetyMargin=5%`，系统提示 1200 token、工具说明 3500 token、历史 20000 token、检索片段 5000 token，是否会触发截断？答案：不会，总估算 29700，远低于 113600 的安全预算。
2. 正向问题：检索片段被截断时，如何保留最相关的内容？答案：先按重排序分数排序，再逐条累加，超过 `retrievalChunks.maxTokens` 即停止。
3. 边界问题：当历史消息刚好达到 `historyMessages.maxTokens` 时，系统提示是否还有空间？答案：有，系统提示优先级更高，已在之前预留。
4. 边界问题：如果某次请求只有一个工具，但工具说明占 15000 token，是否会挤压系统提示？答案：不会，因为系统提示优先级为 1，先分配；但如果工具说明超过其 `maxTokens`，会触发截断策略。
5. 无证据拒答：某个工具是否使用完整 schema 还是精简描述？如果配置中未提供 `strategy` 字段或日志记录，则拒绝回答，应返回“需要查看配置或审计日志”。
6. 无证据拒答：模型为什么在某次请求中拒绝回答？如果仅给出问题文本而没有 `usage.prompt_tokens`、`truncationFlags` 和组件拆分的日志，则拒绝归因，应要求提供 budget 元数据。

## 维护、版本、来源与相邻主题的关系

上下文预算配置应当与模型版本、tokenizer 包版本和提示模板版本一起版本化。例如配置里的 `budgetVersion` 与 `AGENTS.md` 和 `.pi/prompts` 的变更一一对应。每次升级模型或切换上下文窗口时，必须回归测试第 1、3、5 节的数据模型和问答样例。来源上以项目级配置、本地审计日志和 tokenizer 官方文档为准，不假设第三方 API 的隐式行为。相邻主题包括：RAG 检索排序、记忆管理、提示工程、工具调用协议和模型评估；上下文预算处于这些主题的交汇点，它负责在输入窗口内仲裁它们的资源竞争。

## 结论

事实：模型输入窗口是有限整数，系统提示、工具说明、检索片段和历史消息都会消耗 token；本地估算必须预留输出空间和误差余量。推论：通过优先级、单类封顶和共享池，可以在 TypeScript 实现中把上下文预算做成可配置、可审计、可回归的模块，而不依赖模型隐式截断。未知：不同模型对系统提示、工具说明和检索片段的注意力分布并不一致，最优的优先级和余量系数需要结合具体业务场景的持续评估，无法仅靠通用规则一次性确定。
