---
type: concept
title: 澄清问题：实现视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。信息不足时如何提出最少且有价值的澄清，而不是猜测
resource: .pi/knowledge/library/agent-design/clarify-implementation.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, clarify, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: clarify
variant: implementation
---

# 澄清问题：Agent 在信息不足时的最小有价值询问机制

## 摘要与问题边界

实现视角下，澄清问题机制在任务输入与目标存在可验证缺口时触发，要求用户补充继续执行所必需、且无法通过合理推断补全的约束。边界明确：只处理输入与目标之间的信息缺口，不处理外部事实查询，不替用户做价值判断。触发条件必须可验证：至少存在一个必需参数缺失、歧义或类型不一致，且会改变后续执行路径。

## 核心概念与数据模型

1. **ClarificationGap**：信息缺口，字段包括 `targetParameter`、`reason`（MISSING/AMBIGUOUS/TYPE_MISMATCH/CONFLICT）、`currentEvidence`、`severity`（BLOCKER/WARNING）与 `proposedQuestion`。
2. **QuestionPolicy**：决定问题提出规则。一个问题对应一个会改变执行路径的缺口；同类缺口合并；WARNING 默认不询问，除非启用严格模式。
3. **EvidenceBundle**：用户消息、已解析实体、历史约束以及 `.pi/knowledge`、`AGENTS.md` 只读片段的集合。Agent 只能基于已加载证据判断，不假设未提供知识。
4. **ClarificationRequest**：输出结构，包括 `requestId`、`gaps`、`questions`、`fallbackAction`（REFUSE 或 SAFE_DEGRADE）、`neededBy`（依赖答案的下游步骤）。
5. **AnswerSlot**：用户回答槽位，包括 `questionId`、`normalizedValue`、`confidence`、`sourceMessageId`，未匹配项进入 `unmatchedAnswers`。
6. **ResolutionState**：会话状态机 `PENDING → ASKED → PARTIALLY_ANSWERED → RESOLVED/EXPIRED`，每个转移带时间戳与触发条件。

## 设计决策与取舍

### 最小问题优先
优先提出阻塞性问题，同一参数多重歧义合并为单选或填空。过度合并风险通过 `options` 中的“其他”选项缓解。

### 结构化输出优先
所有澄清请求以 JSON 输出，由 `apps/web` 渲染。`ClarificationRequest` 是严格 Zod 类型，保证 Agent 可验证回答。

### 本地知识库仅作证据
`.pi/knowledge` 与 `AGENTS.md` 只读片段加载为 `EvidenceBundle`，但缺口判断基于当前任务上下文证据。未提供约束不视为缺失，只视为无证据。

### 一轮最多三条
每次 `session.prompt()` 至多一轮澄清，避免用户疲劳。问题数上限为 3，超出进入 backlog。

### BLOCKER 不猜测，WARNING 可假设
BLOCKER 级别必须询问；WARNING 可给出默认值并标记 `assumedValue`，继续执行。

## 可执行的实施流程

1. 在 `packages/pi-agent` 定义 `ClarificationRequest` 和 `ClarificationGap` 的 Zod schema。
2. 实现 `EvidenceLoader`，从会话上下文与只读项目资源生成 `EvidenceBundle`。
3. 实现 `GapAnalyzer`，扫描目标与已解析参数，识别 MISSING、AMBIGUOUS、TYPE_MISMATCH、CONFLICT。
4. 实现 `QuestionPolicy`，按 BLOCKER 优先、同类合并、一轮上限 3 条生成问题。
5. 实现 `ClarificationResponder`，将问题与拒答条件组装为 SSE 事件，经 `apps/api` 发送。
6. 在 `apps/web` 实现澄清表单，收集回答后提交 `answerSlots`。
7. 实现 `AnswerResolver`，匹配 `questionId`，规范化值，更新 `ResolutionState`。
8. 在 `session.prompt()` 入口插入校验：若 `ResolutionState` 未 `RESOLVED`，先触发澄清流程。

## 贴近本地知识库的示例

输入：用户消息“把那个文件改成新的格式”。`EvidenceBundle` 含用户消息、可用文件列表与 `AGENTS.md` 片段。

处理：`GapAnalyzer` 发现 `targetFile` 为 AMBIGUOUS，`targetFormat` 为 MISSING，`operationScope` 为 MISSING。`QuestionPolicy` 将前两者合并为 BLOCKER，后者默认“全文”则降级为 WARNING。

输出（SSE 事件体）：

    {
      "requestId": "clar-001",
      "gaps": [
        {"targetParameter": "targetFile", "reason": "AMBIGUOUS", "severity": "BLOCKER"},
        {"targetParameter": "targetFormat", "reason": "MISSING", "severity": "BLOCKER"}
      ],
      "questions": [
        {
          "id": "q1",
          "text": "需要修改哪个文件，以及目标格式是什么？",
          "options": [
            {"label": "packages/pi-agent/src/index.ts → ES module", "value": "esm"},
            {"label": "docs/pi-agent-learning.md → OKF", "value": "okf"},
            {"label": "以上都不是", "value": "other"}
          ]
        }
      ],
      "fallbackAction": "REFUSE",
      "neededBy": ["file.edit", "format.transform"]
    }

若用户未回答，Agent 执行 `REFUSE`，不猜测文件与格式。

## 性能、质量和可观测性指标

1. **澄清命中率**：用户补充关键信息的澄清次数 / 总澄清次数。通过 `requestId` 与 `sourceMessageId` 关联统计。
2. **误澄清率**：本可直接推断却误问的问题比例。由回归测试集或人工标注判定。
3. **平均澄清轮数**：完成任务的澄清轮数，从 `ResolutionState` 时间戳链计算。
4. **回答匹配准确率**：回答正确映射到 `questionId` 的比例，统计 `matched` 与 `unmatchedAnswers`。
5. **端到端延迟**：从触发到发出澄清请求的毫秒数，记录 `ClarificationResponder` 的 `emitTime - startTime`。

## 失败模式、诊断证据与恢复动作

1. **循环澄清**：同一问题被反复询问。证据：同一 `questionId` 在 `AnswerSlot` 多次出现但状态未 `RESOLVED`。恢复：检查 `AnswerResolver` 写入与 `GapAnalyzer` 读取已回答槽位的逻辑。
2. **过度澄清**：一轮问题超过 3 个。证据：`questions.length > 3`。恢复：收紧 `QuestionPolicy` 合并规则，WARNING 默认不提出。
3. **拒答死锁**：`fallbackAction` 为 `REFUSE` 但下游仍执行工具。证据：未 `RESOLVED` 却出现工具执行事件。恢复：在 `session.prompt()` 入口强制状态校验。
4. **证据污染**：`EvidenceBundle` 出现未加载文件引用。证据：引用超出 `DefaultResourceLoader` 返回列表。恢复：只从已返回文件构建证据，禁止动态推断。
5. **回答类型不匹配**：`normalizedValue` 未通过 Zod 验证或置信度低于 0.5。恢复：问题提供 `options` 或 `schema` 提示，低置信度回答再次询问。

## 问答测试样例

1. 正向：用户输入“把 `packages/pi-agent/src/index.ts` 转成 ES module”。无歧义，Agent 直接执行。
2. 边界：用户输入“改文件”。多文件存在且无格式说明，Agent 返回 BLOCKER 澄清。
3. 边界：用户输入“把 README 改成 OKF”。多个 README 存在，Agent 询问具体路径。
4. 无证据拒答：用户输入“执行那个脚本”。本地未定义脚本，Agent 拒绝执行，不猜测名称。
5. 无证据拒答：用户输入“修复 bug”。无文件、错误信息或复现步骤，Agent 返回澄清要求补充证据。
6. 边界：用户输入“用新的方式重写”。目标未定义，Agent 询问“新方式”的具体约束，否则拒绝。

## 维护、版本、来源与相邻主题关系

本机制版本随 `packages/pi-agent` 包版本管理，schema 变更需同步更新 `apps/web` 渲染逻辑。来源为 `AGENTS.md` 项目边界、`docs/pi-agent-learning.md` 架构说明以及 `.pi/knowledge` 自定义知识。与相邻主题关系：澄清问题是工具调用前的输入完备性校验；与 `search_knowledge` 的区别在于后者是只读检索，前者是主动请求缺失信息；与意图分类的区别在于澄清不改变意图，只补全执行参数。

## 结论

事实：澄清机制要求缺口可验证、输出结构化、未回答时安全降级。推论：通过 Zod schema、状态机与合并规则，可在 TypeScript 实现中降低误澄清率。未知：最优一轮问题数（默认 3 条需 A/B 测试验证），以及自然语言歧义在有限本地知识库下的自动消解上限。
