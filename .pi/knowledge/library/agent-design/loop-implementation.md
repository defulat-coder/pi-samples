---
type: concept
title: Agent Loop：实现视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。模型观察上下文、选择行动、接收结果并继续回合的闭环
resource: .pi/knowledge/library/agent-design/loop-implementation.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, loop, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: loop
variant: implementation
---

# Agent Loop：模型—行动—观测的 TypeScript 实现闭环

## 摘要与问题边界

Agent Loop 是智能体运行时中“模型读取上下文、选择动作、执行并回收结果、再推进下一回合”的最小控制单元。它不是一次性请求-响应，也不是任意多轮对话；每个回合都必须有明确的输入校验、动作输出、可观测结果与状态推进。本文从 TypeScript 实现视角出发，聚焦单会话、单线程主循环：先确定输入、输出、错误与生命周期，再给出可落地的代码结构与检查清单。不讨论模型训练，不假设底层 provider 的具体实现，也不把安全审批完全交给模型自身。

## 核心概念与数据模型

一个可落地的 Agent Loop 至少需要以下实体：

1. **TurnContext（回合上下文）**：包含 sessionId、消息历史、workingMemory、可用工具清单、tokenBudget、abortSignal 与创建时间戳。它是每个回合开始时的只读快照，模型只能基于它生成动作。
2. **ActionCandidate（动作候选）**：由模型生成，字段包括 actionId、toolName、params、reasoningTrace、costEstimate。该对象必须先通过 schema 校验，再进入执行器。
3. **ToolExecutor（工具执行器）**：签名形如 `(call: ToolCall) => Promise<ToolResult>`。它负责把动作转换为真实副作用，返回结构化结果，并记录耗时与异常。执行器不应直接修改会话状态。
4. **ObservationBuffer（观测缓冲区）**：按顺序收集 ToolResult，包括成功返回值、错误码、token 消耗与截断标记。它是模型下一回合观察世界的唯一来源，必须保证顺序可复现。
5. **LoopState（循环状态）**：记录 currentRound、maxRound、lastAction、finishReason、checkpointId。finishReason 的合法取值包括 done、max_rounds、error、aborted、budget_exceeded。
6. **LoopControlPolicy（循环控制策略）**：定义工具超时、重试次数、确定性工具 ID、输出截断阈值与人工审批列表。策略与业务逻辑分离，便于单元测试与审计。

## 设计决策与取舍

### 单线程回合优先
同一时刻只允许一个模型调用与一个动作执行完成。这样便于保证 ObservationBuffer 的顺序与 LoopState 的原子性；代价是并发工具调用被推迟到下一回合，吞吐量下降。

### 模型层与执行层分离
模型调用封装为 `generateAction(context)`，工具执行封装为 `executeTool(call)`。两者通过 DTO 交换，避免模型输出直接触发系统调用。取舍是增加了序列化开销，但获得了可测试性与安全边界。

### 观测结果截断而非无限追加
当结果过长时，按 token 数截断，并附加 `truncated: true` 标记。完整结果写入外部检查点。取舍是模型可能丢失尾部细节，但防止上下文无限膨胀。

### 错误传播的三级策略
工具错误分为 retryable、degradable、terminal。retryable 在当前动作内重试并计数；degradable 将降级结果放入 ObservationBuffer；terminal 立即设置 finishReason 并终止循环。这样避免单次网络抖动导致失败，也防止无限重试。

### 可观测性作为一等数据
每个回合都生成 TraceEvent，包含 inputHash、outputHash、durationMs、toolCallId 与 policySnapshot。TraceEvent 写入只读存储，供调试与审计，不用于模型推理。

## 可执行的实施流程

在编码前，先完成以下检查清单，再逐步实现：

1. 定义 `TurnContext`、`ActionCandidate`、`ToolResult`、`LoopState` 的 Zod 或 TypeBox schema，确保运行时输入输出可校验。
2. 实现 `LoopControlPolicy` 的默认值与合并逻辑，覆盖超时、最大回合、重试、token 预算。
3. 实现 `generateAction(context)`：构造模型请求，解析输出，映射为 `ActionCandidate`，并执行 schema 校验。
4. 实现 `validateAction(candidate)`：检查工具名是否存在、参数是否满足约束、是否需要人工审批。
5. 实现 `executeTool(call)`：绑定超时、捕获异常、记录 TraceEvent，返回 `ToolResult`。
6. 实现 `ObservationBuffer.append(result)`：维护顺序、截断长结果、计算累计 token。
7. 实现 `updateLoopState(state, action, result)`：推进 currentRound、判断 finishReason、保存 checkpoint。
8. 实现 `runLoop(session)`：按顺序调用 generateAction → validateAction → executeTool → append → updateLoopState，直到 finishReason 非空。
9. 在入口添加 `abortSignal` 监听与全局异常捕获，保证会话可优雅终止。
10. 编写单元测试：覆盖单次完成、maxRound 截断、工具失败、schema 无效、上下文截断。

## 输入、处理与输出示例

以下是一次最小回合的 TypeScript 类型骨架：

    interface TurnContext {
      sessionId: string;
      messages: Array<{role: 'system' | 'user' | 'assistant' | 'tool'; content: string}>;
      tools: ToolRegistry;
      tokenBudget: number;
      round: number;
      abortSignal?: AbortSignal;
    }

    interface ActionCandidate {
      actionId: string;
      toolName: string;
      params: Record<string, unknown>;
      reasoningTrace: string;
    }

    interface ToolResult {
      actionId: string;
      status: 'success' | 'error' | 'truncated';
      payload: unknown;
      durationMs: number;
      tokenCount: number;
    }

    async function runSingleTurn(
      ctx: TurnContext,
      policy: LoopControlPolicy,
    ): Promise<{nextContext: TurnContext; finishReason?: string}> {
      const candidate = await generateAction(ctx);
      const validated = validateAction(candidate, ctx.tools);
      if (!validated.ok) {
        return {nextContext: appendObservation(ctx, validated.error), finishReason: 'validation_error'};
      }
      const result = await executeTool(validated.value, policy.toolTimeoutMs);
      const observed = appendObservation(ctx, result);
      if (observed.tokenBudget < 0) {
        return {nextContext: observed, finishReason: 'budget_exceeded'};
      }
      return {nextContext: observed};
    }

输入是会话上下文与策略；处理是生成、校验、执行、观测；输出是携带新观测的下一回合上下文，以及可选的终止原因。

## 性能、质量与可观测性指标

1. **回合往返延迟**：每次 `generateAction` 到 `executeTool` 完成的时间，记录 p50/p99。
2. **工具成功率**：`ToolResult.status === 'success'` 的占比，按 toolName 分桶，低于阈值时触发告警。
3. **任务完成率**：`finishReason === 'done'` 的会话比例，是最终质量的核心指标。
4. **每会话 token 消耗**：累加 promptTokens 与 completionTokens，与 `tokenBudget` 对比计算利用率。
5. **无效动作率**：`validateAction` 失败次数占总生成次数的比例，过高说明模型输出格式不稳定。
6. **上下文截断次数**：`ObservationBuffer` 触发截断的频率，用于评估工具返回体积与提示设计。

## 失败模式、诊断证据与恢复动作

1. **模型输出不可解析**
   诊断证据：JSON 解析失败或缺少 actionId。恢复动作：将该错误作为 observation 返回，要求模型重新生成；连续三次失败则 finishReason 设为 `error`。

2. **工具执行超时**
   诊断证据：durationMs 大于 policy.toolTimeoutMs。恢复动作：标记为 retryable，最多重试两次；若仍超时，返回超时 observation 并终止该回合。

3. **工具返回异常**
   诊断证据：status === 'error' 且错误码非超时。恢复动作：根据错误分类决定是否降级；若降级失败，则返回降级异常 observation，继续下一回合。

4. **循环无法终止**
   诊断证据：currentRound 达到 maxRound 或 finishReason 为空但 token 预算已耗尽。恢复动作：强制设置 finishReason 为 `max_rounds` 或 `budget_exceeded`，并返回当前 workingMemory 的摘要。

5. **上下文窗口超限**
   诊断证据：estimatedTokens > tokenBudget。恢复动作：触发摘要化策略，将早期消息压缩为 system 摘要，保留最近动作。

6. **安全策略触发**
   诊断证据：validateAction 命中审批列表或敏感参数。恢复动作：暂停循环，返回 `guardrail_triggered` 状态，等待人工审批或明确拒绝。

## 问答测试样例

1. **正向**：Agent Loop 一次完整回合包含哪些阶段？
   答案：生成候选动作、校验、执行、观测、状态推进。

2. **边界**：当工具返回空数组时，循环是否结束？
   答案：不一定。空数组是合法观测，是否结束由模型基于上下文与 finishReason 决定。

3. **边界**：currentRound 等于 maxRound 时还能执行动作吗？
   答案：不能。达到 maxRound 后必须设置 finishReason，禁止再发起新的 generateAction。

4. **边界**：同一回合内生成多个动作候选应如何处理？
   答案：在单线程实现中只接受第一个；其余应被拒绝并作为 observation 提示模型。

5. **无证据拒答**：Agent Loop 是否保证最终答案正确？
   答案：无法保证。正确性取决于模型、工具与数据质量，不能仅靠循环机制证明。

6. **无证据拒答**：某个特定 provider 的 token 计数算法是否与本实现一致？
   答案：无法确认，provider 实现属于未知外部细节，应通过单元测试与 provider 文档验证。

## 维护、版本、来源与相邻主题关系

- **维护**：LoopState 与 ObservationBuffer 的 schema 变更必须升级版本号，并在 `docs/agent-loop-schema-vN.md` 记录破坏性变更。
- **版本**：本实现与 `packages/pi-agent` 的会话生命周期绑定，随 monorepo 版本统一发布。
- **来源**：设计参考项目自身的 `AGENTS.md` 与 `packages/pi-agent` 的接口约定，未引入未经验证的外部规范。
- **相邻主题**：与 `AgentSession` 是“运行时会话”与“循环控制”的包含关系；与 `ToolRegistry` 是“能力注册”与“能力调用”的关系；与 `Reflection/Planning` 是扩展：多步规划时可在 Loop 外层增加 Plan 阶段，但不改变单回合结构。

## 结论

区分三类陈述：

- **事实**：Agent Loop 的核心是模型、动作、观测三要素的循环；LoopState、TurnContext、ObservationBuffer 是本项目实现中的最小状态单元。
- **推论**：单线程回合优先、模型与执行层分离、观测截断等设计能够提升可测试性与安全性，但会牺牲部分吞吐量和信息完整性。
- **未知**：底层模型的推理过程、具体 provider 的 token 计数与输出格式、工具外部系统的完整状态，都不在循环本身的控制范围内，必须通过测试与观测逐步验证。
