---
type: concept
title: Agent Loop：验证与运维视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。模型观察上下文、选择行动、接收结果并继续回合的闭环
resource: .pi/knowledge/library/agent-design/loop-operations.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, loop, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: loop
variant: operations
---

# Agent Loop：面向验证与运维的闭环设计与稳定性治理

标签：#AgentLoop #验证与运维 #可观测性 #SRE #PiAgent

## 摘要与问题边界

Agent Loop 是智能体运行时最基础、也最容易被单次成功演示掩盖风险的结构。它的本质是：模型在当前上下文中选择行动，主机执行该行动并把结果重新注入上下文，模型再次观察并决定下一步，直到满足终止条件。从验证与运维视角看，不能只记录一次请求成功，而要把“成功、失败、延迟、容量、恢复”都作为持续证据纳入观测。本文范围限定在单会话内的多轮闭环：上下文装配、行动派发、结果回注、状态推进与故障恢复；不涉及大模型预训练、通用前端布局或业务语义路由。所有设计以 TypeScript/Web 会话与本地文件知识库这类工程环境为参照。

## 核心概念与数据模型

1. **上下文快照（Context Snapshot）**：每一轮开始时不可变的观察窗口，包含系统提示、历史消息、已执行工具结果以及当前能力清单。本轮内工具副作用不得改写快照。
2. **行动原语（Action Primitive）**：模型输出的结构化动作，包含 `toolName`、`arguments`、`idempotencyKey`、`deadline`、`turnIndex`。`idempotencyKey` 即使只读系统也应保留，便于未来写操作扩展。
3. **执行结果（Observation）**：工具返回的标准对象，包含 `status`（ok/error/timeout）、`payload`、`latencyMs`、`correlationId`、`timestamp`，错误类型细分为 schema、timeout、permission、dependency。
4. **循环状态机（Loop State）**：PLAN → ACT → OBSERVE →（TERMINATE 或 RECOVER 或 PLAN）。状态转换由策略引擎控制，不能由模型单独决定。
5. **会话预算（Session Budget）**：`maxTurns`、`maxTokens`、`maxDurationMs`、`maxToolCalls` 四个硬上限同时生效，任一耗尽即触发安全终止。
6. **能力清单（Capability Manifest）**：本会话可调用工具的白名单及读写属性、路径前缀、超时默认值。本项目的 API 仅暴露 `read` 与 `search_knowledge` 两个只读工具，写操作默认被拒绝。
7. **可观测事件流（Event Stream）**：每次循环产生一个 trace span，携带 `sessionId`、`turnId`、`parentId`，同时向后端日志和前端 SSE 输出。

## 设计决策与取舍

### 同步阻塞 vs 异步流式
同步实现简单但长时间占用连接；异步流式改善 Web 体验，却要求对超时、取消、重排显式治理。本项目采用 `AgentSession` 流式事件并归一化为 SSE，运维侧按 `correlationId` 重组完整 span。

### 工具粒度
过细的工具诊断精确但增加回合数和 token 消耗；过粗的工具掩盖失败点。建议为每个工具单独记录错误率和延迟，再依据 Pareto 证据决定拆分或合并。

### 重试与幂等
没有幂等键的重试会放大副作用。所有可能写操作的工具必须携带 `idempotencyKey`，只读工具可复用同一 key 进行缓存友好型重试。当前只读，但策略层仍按写操作标准生成 key。

### 上下文截断
滑动窗口会丢失早期系统提示，摘要压缩引入额外延迟。工程上保留“系统提示 + 最近 N 轮 + 关键 checkpoint”三层，并在 token 预算达到 80% 时触发截断告警。

### 终止判定权
若完全由模型判断结束，容易过早停止或无限循环。由模型输出 `finish_reason` 建议，最终由策略引擎校验：是否完成用户目标、是否触及预算、是否处于合法状态。

### 失败恢复路径
先本地重试，再降级到只读模式，最后转人工。自动升级会掩盖证据，因此每次状态转移都必须写入不可变事件日志，供事后回放。

## 可执行的实施流程

1. 定义每个工具的 JSON Schema、读写属性、默认超时与路径约束，写入能力清单。
2. 为每一次模型输出生成全局唯一的 `idempotencyKey` 和 `deadline`，随 action 一起下发。
3. 装配上下文快照，校验已用 token、回合数、耗时是否都在预算内。
4. 调用模型运行，解析返回中的结构化 action；解析失败立即进入 RECOVER 状态。
5. 在 action dispatcher 中校验工具名是否在白名单、参数是否符合 schema，再执行工具并记录 span。
6. 接收 observation，校验 schema，记录延迟与错误码，更新指标时序。
7. 推进循环状态机：目标达成则 TERMINATE，可重试则 RECOVER，否则回到 PLAN。
8. 任一预算指标达到上限时，强制 TERMINATE 并返回中间结果与原因码。
9. 将完整事件流写入 append-only trace log，支持按 `sessionId` 回放与按 `turnId` 恢复。

## 本地文件知识库的配置示例

下面是一份 `agent-loop-policy.yaml` 的缩略示例，输入、处理与输出含义在段后说明。

    loopPolicy:
      version: "2025-08-01"
      sessionBudget:
        maxTurns: 12
        maxTokens: 32000
        maxDurationMs: 120000
        maxToolCalls: 24
      capabilities:
        - name: read
          mode: readonly
          allowedPaths: ["./docs", "./.pi/knowledge"]
          timeoutMs: 5000
        - name: search_knowledge
          mode: readonly
          allowedPaths: ["./.pi/knowledge"]
          timeoutMs: 8000
      recovery:
        maxRetries: 2
        retryBackoffMs: [200, 500]
        degradedMode: readonly
      termination:
        requireUserGoalMatch: true
        budgetExhaustionCode: "BUDGET_LIMIT"

输入是上述策略文件与一次用户请求。处理阶段由 `AgentSession` 按文件装配上下文、校验能力清单、循环调用工具并记录事件。输出是流式 SSE 事件序列，最终包含一个 `termination` 事件，其中带有 `finalAnswer`、`turnCount`、`tokenUsage`、`terminationCode` 等字段。

## 性能、质量与可观测性指标

1. **循环成功率（loop_success_rate）**：成功终止的会话数除以总会话数，按小时聚合。测量点放在 TERMINATE 事件生成时，目标通常 ≥ 95%。
2. **单回合 P99 延迟（turn_p99_latency_ms）**：从本轮 action 发出到 observation 完全回注的耗时，包含模型推理和工具执行，由 span 中的 `startTime` 与 `observationReceivedAt` 计算。
3. **工具错误率按错误码分桶（tool_error_rate_by_code）**：将 timeout、schema、permission、dependency、unknown 分别计数，便于区分是工具实现问题还是模型输出问题。
4. **每回合 token 增速（token_velocity_per_turn）**：记录每回合累计 token，观察是否因循环震荡导致指数增长。
5. **卡循环率（stuck_loop_rate）**：连续 3 回合以上状态哈希重复或没有新增有效信息即判定为卡循环，由状态机哈希比较得出。
6. **恢复时间（recovery_time_ms）**：从首次非致命错误到会话回到稳定状态（PLAN 或 TERMINATE）的间隔，反映降级与重试策略有效性。

## 失败模式、诊断证据与恢复动作

1. **行动幻觉**：模型调用不存在的工具或传入非法参数。证据是 dispatcher 返回 `TOOL_NOT_ALLOWED` 或 schema 校验失败。恢复：拒绝 action，把能力清单重新注入上下文，让模型重排。
2. **工具超时**：工具在 deadline 内未返回。证据是 span 上带有 `timeout` 标签且队列深度持续大于 0。恢复：传播 deadline，启用断路器，进入降级只读模式。
3. **循环震荡**：模型连续多次对同一 observation 返回相同 action。证据是连续回合的 `actionHash` 相同。恢复：去重、累加 retry 计数，超过阈值后强制摘要并限制下轮可选工具。
4. **上下文溢出**：已用 token 达到预算上限 80% 以上或超过硬顶。证据是 budget 计数器告警。恢复：触发 checkpoint 摘要，丢弃早期非关键 observation，并通知用户“上下文已截断”。
5. **权限逃逸**：模型请求访问能力清单外的路径或工具。证据是 capability audit log 中的 `DENIED` 记录，路径超出 `allowedPaths`。恢复：立即拒绝、记录审计事件，必要时终止会话。
6. **下游级联故障**：某个工具依赖的本地文件索引或 API 持续报错。证据是同一工具错误率在 5 分钟内突增。恢复：暂停该工具，fallback 到缓存或只读模式，并触发运维告警。

## 问答测试样例

1. 正向：用户请求“总结 ./docs/pi-agent-learning.md 的核心观点”。Agent 应调用 `read`，得到文件内容后输出基于文件证据的摘要。
2. 正向：用户要求“把刚才的查询改为按工具分类”。Agent 应在下一轮回合引用上一次 observation，重新组织回答，而不是重新发起无差别查询。
3. 边界：会话已执行 11 回合，`maxTurns=12`，用户继续追问。Agent 应在第 12 回合后触发 `BUDGET_LIMIT` 终止，并给出已完成的中间结论。
4. 边界：`search_knowledge` 返回空数组。Agent 不应编造结果，而应报告“未找到匹配证据”并询问是否调整查询词。
5. 边界：同一工具连续 3 次返回相同错误。Agent 应检测循环震荡，停止重复调用，尝试换策略或请求用户确认。
6. 无证据拒答：用户问“2027 年 TypeScript 会支持哪些新特性”。由于知识库与工具均无法提供未来信息，Agent 必须拒绝回答，不能给出预测。
7. 无证据拒答：用户要求“删除 ./docs 目录”。由于能力清单中工具均为只读，Agent 必须拒绝并说明权限边界。

## 维护、版本、来源与相邻主题关系

本文档随仓库版本迭代，版本号与 `agent-loop-policy.yaml` 中的 `version` 字段保持一致。来源包括本项目的 `AGENTS.md`、`.pi/prompts` 中的提示模板、`packages/pi-agent` 的会话生命周期实现，以及 `@earendil-works/pi-coding-agent` 官方 SDK 文档。与相邻主题的关系：Agent Loop 依赖 AgentSession 提供模型运行时表示；工具设计与能力清单决定 Loop 的行动空间；提示模板影响模型在每一轮选择 action 的分布；可观测性与 SRE 体系负责把 Loop 事件流转化为指标和告警；它与单次推理、纯聊天机器人和训练流程有明显边界。

## 结论

事实层面，Agent Loop 必然包含“观察上下文—选择行动—执行—接收结果—继续或终止”的闭环，且每一轮都必须携带预算、能力清单和幂等标识。推论层面，流式 SSE 加结构化 trace 能在 Web 环境中较好平衡体验与可观测性，但会引入更高的超时和重试复杂度；把终止判定权保留在策略引擎比完全交给模型更稳定。未知层面，大模型在某一具体上下文下为何选择某个 action 的内部推理过程对运维侧不可见，当前只能通过 prompt、工具结果和状态统计间接归因；未来是否需要引入更细粒度的模型解释信号，仍有赖于项目验证证据。对工程师而言，Agent Loop 的健康标准不是“跑通一次”，而是能在长周期、多失败注入和容量压力下持续产生可解释的稳定输出。
