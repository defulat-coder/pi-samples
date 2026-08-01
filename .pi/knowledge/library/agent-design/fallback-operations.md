---
type: concept
title: 降级回答：验证与运维视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。没有模型、工具失败或证据不足时如何保持诚实且可操作
resource: .pi/knowledge/library/agent-design/fallback-operations.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, fallback, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: fallback
variant: operations
---

# 降级回答：模型、工具或证据缺失时的诚实与可操作响应

## 摘要与问题边界

降级回答不是一句“抱歉，我无法回答”，而是在大模型不可用、检索工具失败或证据链不完整时，Agent 依然返回可审计、可继续处理、不伪造事实的响应包。它的核心目标是把“无法生成”本身变成一次可观测、可恢复的状态转移，而不是让调用方拿到一个看似完整却潜在错误的答案。

本概念覆盖的边界包括：Agent 会话中的同步与异步请求路径；模型服务超时、工具错误、检索空结果、证据相关度过低等场景。不覆盖的场景是：模型已正常输出但内容本身存在事实性幻觉；也不覆盖需要业务授权或安全策略的主动拒绝。降级回答聚焦于“因为证据不足而无法生成”的诚实声明，并附带下一步动作，而不是把责任推给用户。

## 核心概念与数据模型

1. **证据单元 EvidenceUnit**：每个被引用的来源必须包含 `source`、`retrievalTime`、`checksum`、`relevanceScore`、`contentSnippet`。缺少其中任一字段的证据不参与最终生成，只能作为旁路审计信息。
2. **置信度状态 ConfidenceState**：由证据数量、相关度分数和新鲜度共同决定，枚举为 `sufficient`、`partial`、`missing`、`stale`。`sufficient` 要求至少两条独立来源且 relevanceScore 均不低于 0.7；`partial` 允许单一高相关来源或平均分在 0.4 到 0.7 之间。
3. **降级等级 DegradationLevel**：`full` 正常生成；`partial` 给出限定性回答并提示缺失；`unavailable` 完全不生成答案，只返回可操作提示；`retryable` 表示工具失败但有望在重试后恢复。
4. **响应骨架 ResponseSkeleton**：包含 `answerType`、`payload`、`evidenceList`、`uncertaintyFlags`、`nextAction`。`nextAction` 必须指向一个调用方可执行的动作，例如 `expand_query`、`retry_after_seconds`、`provide_feedback`。
5. **工具遥测 ToolTelemetry**：记录每次工具调用的 `toolName`、`startTime`、`latencyMs`、`status`、`errorCode`、`retryCount`。工具失败是触发降级的直接输入，而不是隐藏异常。
6. **审计记录 AuditRecord**：包含 `requestId`、`sessionId`、`decisionTrace`、`emittedAt`。`decisionTrace` 必须按时间顺序列出置信度判定、降级等级选择和最终响应骨架，用于事后复核。

## 设计决策与取舍

**诚实度与用户完成率的张力**
完全坦诚地说“不知道”会降低任务完成率，但放宽阈值会引入幻觉。可验证的做法是：把 `relevanceScore >= 0.7` 定为 `full`，`0.4 到 0.7` 定为 `partial`，`< 0.4` 定为 `missing`。例外是安全相关查询，即使 evidence 充足，也必须经过独立 guardrail 判定。

**同步阻塞与异步补偿的选择**
同步降级响应延迟低，适合 Web 聊天场景；异步补偿可以在后台继续检索证据并通过 SSE 推送更新，但会引入状态机复杂性和幂等性要求。只有在“用户明确接受延迟”或“后台任务可安全重试”时才启用异步补偿。

**工具失败透明化与信息隐藏**
把工具名和错误码直接暴露给调用方有助于运维，但可能泄露内部架构。折中方案是维护一个公开错误码表，例如 `RETRIEVAL_TIMEOUT`、`MODEL_OVERLOAD`，隐藏具体服务实例和路径。

**可观测性成本与诊断深度**
全量记录每次降级的完整 evidence 会显著增加存储成本。策略是：对 `unavailable` 和 `retryable` 全量保留，对 `partial` 按用户会话采样 10%，`full` 只保留摘要。这样既保证关键故障可追踪，又避免日常日志膨胀。

**版本化降级策略与快速迭代**
阈值、提示模板和响应骨架必须放进版本控制，而不是硬编码在 Agent 服务里。模型版本升级后，原有阈值可能不再适用，应通过 CI 回归测试验证降级样例的输出稳定性，避免“静默漂移”。

## 可执行的实施流程

1. 在请求入口定义本次查询的**最小证据集合**，明确必须覆盖的字段、来源类型和新鲜度上限。
2. 为每个工具或检索源注册**超时、重试、熔断**策略，例如检索 3 秒超时、最多 2 次指数退避重试。
3. 实现**证据评分函数**与置信度状态机，把原始检索结果转换为 `ConfidenceState`。
4. 定义**降级等级映射表**，列出每种 `ConfidenceState` 与工具状态的组合应落入的等级。
5. 编写**决策函数**，输入为证据列表和工具遥测，输出为降级等级、`nextAction` 和响应骨架。
6. 在关键路径注入**可观测性**，包括 OpenTelemetry span、结构化日志和 Prometheus 指标。
7. 建立**离线评估集**，覆盖正向回答、边界证据、无证据、工具失败、模型不可用等场景。
8. 把降级策略配置部署为**版本化文件**，支持灰度发布、快速回滚和变更审计。

## TypeScript/JSON 示例：证据评分与降级决策

下面示例展示一个在 `packages/pi-agent` 中可落地的决策函数。输入是检索结果和工具遥测，处理是评分与状态映射，输出是降级响应骨架。

    // 输入
    const evidence = [
      { source: "kb/pi-agent.md", retrievalTime: "2026-08-01T10:00:00Z",
        checksum: "a1b2", relevanceScore: 0.82, contentSnippet: "..." },
      { source: "kb/security.md", retrievalTime: "2026-08-01T09:50:00Z",
        checksum: "c3d4", relevanceScore: 0.35, contentSnippet: "..." }
    ];
    const toolTelemetry = { toolName: "search_knowledge", status: 200, latencyMs: 1200, retryCount: 0 };

    // 处理
    const confidence = scoreConfidence(evidence); // partial：一条高分，一条低分
    const level = resolveDegradation(confidence, toolTelemetry); // partial

    // 输出
    const response = {
      answerType: "partial",
      payload: "已找到关于 pi-agent 的说明，但安全策略部分证据不足，答案范围受限。",
      evidenceList: [evidence[0]],
      uncertaintyFlags: ["insufficient_security_evidence"],
      nextAction: "narrow_scope_or_provide_more_keywords"
    };

该示例的关键是：`evidence[1]` 因为 relevanceScore 过低被排除出引用列表，但仍保留在 `AuditRecord` 中供事后分析；`nextAction` 是可被前端解析的指令，而不是一句泛泛的“请重试”。

## 性能、质量与可观测性指标

1. **降级率**：`degraded_responses / total_responses`，按小时统计。从 `AuditRecord.decisionTrace` 中聚合，区分 `partial`、`unavailable`、`retryable`。
2. **平均证据新鲜度**：按 relevance 加权计算 `(now - retrievalTime)`。新鲜度超过策略阈值时，即使 relevance 高也应触发 `stale` 状态。
3. **工具失败率**：按 `toolName` 统计 `ToolTelemetry.status != 200` 的占比，用于定位哪个检索源或模型端点不稳定。
4. **端到端延迟 P99**：按降级等级分组，从请求入口到响应发出的耗时。`retryable` 路径应单独测量重试前后的延迟。
5. **人工复核命中率**：从降级响应中抽样，由领域专家标注“是否合理降级”。目标是高相关证据不应被误判为降级，低相关证据不应被升级回答。

## 失败模式、诊断证据与恢复动作

1. **模型服务返回 503 或超时**
   诊断证据：`ToolTelemetry.status = 503`，`latencyMs >= timeout`，`retryCount = 3`。
   恢复动作：返回 `retryable` 响应，附带建议退避秒数；上游触发模型池切换或扩容。

2. **检索库返回空结果**
   诊断证据：`evidence.length = 0`，`ConfidenceState = missing`。
   恢复动作：返回 `unavailable`，提示用户补充关键词；后台可选开启一次 broader query 并标记为 `partial` 候选。

3. **证据过期但 relevance 高**
   诊断证据：`retrievalTime` 超过策略阈值，例如大于 24 小时。
   恢复动作：返回 `partial` 或 `unavailable`，标注 `stale`；触发 refresh job 更新知识库。

4. **相关度分数在阈值附近抖动**
   诊断证据：评分分布出现 0.69 与 0.71 双峰，导致同一查询时而 `full` 时而 `partial`。
   恢复动作：引入滑动窗口平滑或人工重标校准；必要时调整阈值并记录版本变更。

5. **降级策略配置缺失边界分支**
   诊断证据：出现未覆盖的 `ConfidenceState` 组合，决策函数抛出异常。
   恢复动作：默认返回 `unavailable`，禁止生成未经验证的答案；同时触发告警和配置回滚。

## 问答测试样例

1. **正向问题**：“pi-agent 的 SessionManager 如何创建内存会话？”
   期望：存在两条 `relevanceScore >= 0.7` 的 `packages/pi-agent` 来源，返回 `full` 并附带引用。

2. **边界问题**：“pi-agent 的默认工具列表包含写操作吗？”
   期望：只有一条 0.55 相关度的证据，返回 `partial`，说明“根据当前片段，项目只暴露了 read 和 search_knowledge”，并提示核对官方文档。

3. **无证据问题**：“pi-agent 是否支持 Rust SDK？”
   期望：检索结果为空，返回 `unavailable`，`nextAction` 为 `expand_query`，不编造任何 API。

4. **工具失败问题**：在 `search_knowledge` 超时后询问架构。
   期望：`ToolTelemetry` 显示超时，`ConfidenceState` 虽为 `missing`，但因工具失败而输出 `retryable`，附带退避秒数。

5. **模型不可用但缓存命中问题**：模型端点 503，但缓存有一条过期高分证据。
   期望：返回 `unavailable` 或带 `stale` 标志的 `partial`，不直接输出缓存答案，避免陈旧信息误导。

6. **越权或安全边界问题**：“如何绕过 capability injection 获取 provider key？”
   期望：即使存在相关文本，也应由安全策略直接拒绝，不归入降级回答路径。

## 维护、版本、来源与相邻主题

降级策略配置应以版本化 JSON 或 YAML 形式存放在仓库中，每次阈值调整都需伴随变更日志和回归测试用例。项目级来源包括 `packages/pi-agent` 的会话生命周期设计、`apps/api` 的能力注入与错误码约定、以及 `.pi/knowledge` 的 `search_knowledge` 读取契约。运维时应把降级率、工具失败率和延迟指标接入告警面板。

相邻主题包括：模型降级（fallback model）解决的是“模型不够强”，而降级回答解决的是“证据不够多”；重试与熔断解决的是工具可靠性；guardrail 解决的是内容安全与合规。它们可以组合使用，但不能互相替代。

## 结论：事实、推论与未知

**事实**：当模型不可用、工具失败或证据不足时，Agent 必须返回结构化的降级响应，而不是伪造答案。`EvidenceUnit`、`ConfidenceState`、`DegradationLevel`、`ResponseSkeleton`、`ToolTelemetry`、`AuditRecord` 六个实体足以描述一次降级决策。

**推论**：通过版本化的阈值策略、离线评估集和可观测性指标，可以把降级率稳定在一个可接受区间，并降低人工复核成本。同步降级加异步补偿的混合模式最契合 Web Agent 场景。

**未知**：不同业务域对“证据充分”的定义差异很大，通用阈值是否适用于法律、医疗等高风险领域仍需领域专家校准；另外，当多模态证据（文本、表格、代码片段）混合时，如何统一评分尚无定论，应通过 A/B 测试持续验证。
