---
type: concept
title: 证据回答：实现视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。回答必须能回到实际使用的文件、数据库记录或工具结果
resource: .pi/knowledge/library/agent-design/evidence-implementation.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, evidence, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: evidence
variant: implementation
---

# 证据回答：让 Agent 答案始终可追溯到文件、数据库记录或工具结果

在 Agent 系统里，用户最担心的不是答案慢，而是答案不知道从哪里来。证据回答把“答案”重新定义为“一组可被第三方复核的断言集合”，每个断言都必须绑定到一个具体的来源：本地文件、数据库记录、工具输出或经过签名的缓存结果。它的边界很清楚：不是要让所有回答都充满引用，而是要求任何被当作事实的陈述都能被还原到可验证的原始数据；如果做不到，就必须明确标记为未知或拒答。

## 摘要与问题边界

证据回答的核心目标是消除“黑盒回答”。它要求 Agent 在生成最终文本之前，先产生一份证据票据，列出答案所依赖的全部来源单元。问题边界分为三层：第一层是“事实性问题”，必须有证据；第二层是“程序性问题”，允许引用工具执行结果；第三层是“观点或未知问题”，如果知识库中没有相关材料，必须拒答或给出置信度极低的回答。它不解决模型创意写作、闲聊、代码生成中审美偏好等场景，这些场景应以“非证据模式”单独处理。

## 核心概念与数据模型

1. **证据单元（Evidence Unit）**：最小可追溯片段，字段至少包括 `content`（原文摘录）、`sourceId`（统一资源标识）、`selector`（行号、段落键、SQL 主键或工具调用 ID）、`checksum`（SHA-256）、`retrievedAt`（时间戳）和 `toolCall`（可选，记录工具名与参数）。
2. **来源注册表（Source Registry）**：维护所有可被引用的来源类型，例如 `file://.pi/knowledge/*.md`、`db://records/{table}/{id}`、`tool://search_knowledge` 和 `cache://snapshot/{version}`。每个来源必须声明读取方式、是否支持强引用、TTL 和版本策略。
3. **证据链（Evidence Chain）**：记录从用户问题到最终答案的推导路径。链上节点包括原始检索结果、去重/排序操作、模型摘要过程和验证结果。链本身不是答案，而是答案的“审计日志”。
4. **证据强度（Evidence Strength）**：枚举为 `direct`（原文直接回答）、`inferred`（需要多段组合推断）、`aggregated`（统计或汇总）、`stale`（来源已过期但缓存可用）和 `missing`（无证据）。强度必须显式写入票据。
5. **证据回答票据（Answer Ticket）**：最终输出对象，包含 `answer`（文本）、`claims`（断言数组，每个断言带 `evidenceRefs` 和 `confidence`）、`missingEvidence`（缺失证据列表）、`sourceFingerprint`（所有来源 checksum 的哈希）和 `ticketVersion`（票据格式版本）。
6. **验证器（Claim Verifier）**：对 `claims` 逐项校验，检查引用是否存在、selector 是否有效、内容是否与来源一致、以及是否有内部矛盾。验证器必须独立运行，不能与模型共享内存。

## 设计决策与取舍

### 强引用还是弱引用
强引用使用文件路径、行号、数据库主键或工具调用 ID，校验成本低，但要求来源支持稳定定位；弱引用只写“根据文档 A”，容易被模型编造。本项目选择强引用，例外是行号：Markdown 文件增删会导致行号漂移，因此要求同时记录最近 120 字符的上下文哈希，作为漂移后的二次定位。

### 实时检索还是预索引缓存
实时检索保证新鲜度，但延迟高；预索引缓存速度快，但可能过期。对本地文件和知识库使用实时 `read` 与 `search_knowledge`，对超过 10 MB 的静态文档使用预索引，并强制记录索引版本号。缓存命中时，票据中必须标记 `stale` 并保留原始快照的 checksum。

### 只读工具还是可写工具
只读工具的结果是可重复验证的证据；写工具会改变环境，其产出一旦状态变化就无法复核。因此证据回答只使用 `read` 和 `search_knowledge` 这类只读工具。如果业务必须使用写工具，应将其结果立即持久化为只读记录，并以数据库记录形式二次引用。

### 结构化票据还是自然文本
结构化票据便于验证和下游审计，但会增加模型协议开销，并可能降低语言流畅度。取舍方案是：模型内部先生成票据草稿，再由一个独立步骤润色为自然语言，但润色后的文本仍被拆分回 `claims` 与 `evidenceRefs`，确保最终输出可还原。

### 同步验证还是异步审计
同步验证在返回用户前拦截错误引用，但会增加响应时间；异步审计可以发现更深层的矛盾，但无法即时保护用户。基础引用存在性与 checksum 校验必须同步执行；跨来源矛盾检测和全文一致性审计可异步完成，结果写入审计队列。

## 可执行的实施流程

1. **请求分类与证据需求判定**：解析用户问题，决定是否需要证据。如果问题属于事实、配置、状态或文档查询，进入证据流程；否则标记为 `non-evidential`。
2. **来源解析与检索计划生成**：根据关键词和来源注册表，生成需要检索的来源列表及优先级，例如先 `search_knowledge`，再 `read` 具体文件。
3. **工具调用与证据采集**：并行调用工具，每个工具返回原始结果，并立即包装为证据单元，计算 checksum 和 retrievedAt。
4. **证据规范化与去重**：将不同来源的相似片段合并，保留最精确或最新的版本，生成统一证据列表。
5. **证据注入与提示构建**：把证据列表按固定模板注入提示，明确要求模型输出票据格式，并禁止引用未出现在证据列表中的来源。
6. **模型生成证据票据**：调用模型，要求其返回 `answer` 和 `claims` 数组，每个 claim 必须关联一个或多个 `evidenceRefs`。
7. **同步验证与补证**：验证器检查每个 claim 的引用是否存在、checksum 是否一致、selector 是否可定位。失败时触发补证，最多两次；仍失败则降级为“部分证据”或拒答。
8. **最终输出与审计记录**：向用户返回答案与票据，后台记录证据链、模型版本、工具参数和 sourceFingerprint。
9. **周期性回归与漂移检测**：对历史票据进行抽样校验，检测文件修改导致的引用漂移，并在知识库更新时自动重新索引。

## 示例：本地文件知识库的回答票据

下面是一份基于本地 Markdown 知识库和 `search_knowledge` 工具产出的票据示例。输入是用户问题；处理步骤是检索、验证、生成；输出是票据。

    ticketVersion: "evidence-answer/v1"
    answer: "本项目通过 packages/pi-agent 创建 AgentSession，并仅暴露 read 与 search_knowledge 两个只读工具。"
    claims:
      - text: "AgentSession 在 packages/pi-agent 中创建。"
        evidenceRefs:
          - sourceId: "file://AGENTS.md"
            selector: "paragraph:Pi Integration Contract"
            checksum: "a1b2c3..."
            strength: direct
        confidence: 0.95
      - text: "只读工具包括 read 和 search_knowledge。"
        evidenceRefs:
          - sourceId: "tool://search_knowledge"
            selector: "toolCallId:tc_20260115_001"
            checksum: "d4e5f6..."
            strength: direct
        confidence: 0.92
    missingEvidence: []
    sourceFingerprint: "sha256:7f8g9h..."
    retrievedAt: "2026-01-15T09:12:00Z"

输入：用户提问“本项目的 AgentSession 在哪里创建，暴露哪些工具？”处理阶段：系统先调用 `search_knowledge` 检索项目上下文，再 `read` 确认 AGENTS.md 中的段落；模型生成断言；验证器校验 checksum 与 selector。输出：答案文本与证据引用，任何下游系统都可以根据 `sourceId` 和 `selector` 重新打开原文核对。

## 性能、质量和可观测性指标

1. **证据覆盖率**：有 `evidenceRefs` 的 claim 数量占总 claim 数量的比例。使用 claim 解析器在返回前自动计算，目标不低于 95%。
2. **来源新鲜度**：`retrievedAt` 与当前时间的中位差值。对实时工具设置告警阈值，例如超过 5 分钟的缓存证据必须标记 `stale`。
3. **同步验证失败率**：验证器拒绝的 claim 数除以总请求数。超过 5% 时应暂停该来源并触发审计。
4. **端到端响应延迟**：从请求进入 Agent 到票据返回的 p95 和 p99 时间。拆分为检索、模型、验证三个阶段分别记录。
5. **用户引用确认率**：用户对答案中引用的“确认/修改/拒绝”比例。通过 UI 反馈按钮收集，用来衡量证据是否真正被用户信任。

## 失败模式、诊断证据与恢复动作

1. **检索为空**：`evidenceRefs` 为空且 `missingEvidence` 列出检索关键词。恢复动作是扩大检索范围一次，若仍无结果则明确拒答，不捏造内容。
2. **引用漂移**：文件被修改后 checksum 或 selector 不匹配。诊断证据是验证器报告 `checksum_mismatch` 或 `selector_not_found`。恢复动作是标记为 `stale` 并重新执行 `read`，如果仍失败则降级为“该来源已不可用”。
3. **模型幻觉引用**：引用的 `sourceId` 在证据列表中不存在。诊断证据是 `missing_evidence` 计数大于 0。恢复动作是剔除该引用，要求模型重新生成，并记录到模型质量看板。
4. **证据冲突**：多个来源对同一断言给出矛盾内容。诊断证据是验证器报告 `conflict` 并列出冲突来源。恢复动作是在答案中保留多方引用并降低 `confidence`，或在无法调和时回答“证据矛盾，无法给出单一结论”。
5. **工具超时或不可用**：`tool_execution_end` 事件携带错误码或超时标志。恢复动作是回退到缓存版本（标注过期时间），或返回“由于工具不可用，当前无法提供证据回答”。

## 问答测试样例

1. **正向问题**：`packages/pi-agent` 中创建会话的函数是什么？
   预期：引用 `AGENTS.md` 中 `createAgentSession()` 段落，并给出文件路径和函数名。

2. **正向问题**：`search_knowledge` 的输入是否包含查询字符串？
   预期：引用 `.pi/knowledge` 中的工具定义或 `AGENTS.md` 中相关段落，说明输入字段。

3. **边界问题**：如果 `npx skills list --json` 返回为空，Agent 是否还能描述项目技能？
   预期：只能引用 `AGENTS.md` 中关于 skills-lock.json 的说明，不能假设当前已安装技能列表。

4. **边界问题**：`.pi/knowledge` 与 `.pi/skills` 的内容来源是否有区别？
   预期：引用 AGENTS.md 中“官方项目上下文”与“自定义 Markdown 知识库”的区分，并指出 `.pi/knowledge` 需通过 `search_knowledge` 读取。

5. **无证据拒答**：当前 API 进程使用的 provider key 明文是什么？
   预期：必须拒答，因为项目明确要求“provider keys 保留在 API 进程中，浏览器不可接收”，任何具体 key 值都不在可读证据内。

6. **无证据拒答**：如果用户问“该 Agent 上线后的用户满意度是多少？”而知识库中没有运行数据，应回答“没有可验证的运行数据，无法给出满意度结论”，并列出缺失证据类型为 `db://metrics` 或 `analytics`。

## 维护、版本、来源和与相邻主题的关系

证据回答的 schema 需要版本化，建议票据版本与项目代码版本同步发布。每次 `.pi/knowledge` 或 `AGENTS.md` 更新时，必须重新计算相关文件的 checksum 并触发回归测试，确保历史票据不会因漂移而误判。证据来源应登记在 `Source Registry` 中，任何新增来源都要经过“是否支持强引用、TTL、是否只读”三审。

它与相邻主题的关系如下：RAG 关注如何把相关内容检索出来，证据回答关注检索结果如何被引用和验证；Grounding 关注模型输出与上下文对齐，证据回答进一步要求对齐点可定位；Citation 关注文本中插标，证据回答要求 citation 可被校验；Truthfulness 关注内容真实性，证据回答把真实性拆解为“来源真实、引用真实、推导不矛盾”三层。

## 结论

事实是：证据回答要求每个事实性断言都绑定到可验证的文件、数据库记录或工具结果；项目中的 `AGENTS.md` 已明确只读工具边界和知识库读取方式。推论是：在 TypeScript 实现中，把票据作为一等对象、验证器独立运行、来源注册表集中管理，可以显著降低幻觉和引用漂移风险。未知的是：不同模型对结构化票据的遵循能力存在差异，具体 prompt 模板和拒答阈值需要根据实际模型与知识库规模通过回归测试不断校准，当前设计尚未证明在所有多跳推理场景下都能保持高证据覆盖率。
