---
type: concept
title: 证据回答：架构视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。回答必须能回到实际使用的文件、数据库记录或工具结果
resource: .pi/knowledge/library/agent-design/evidence-architecture.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, evidence, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: evidence
variant: architecture
---

# 证据回答：架构视角

证据回答：基于可追溯来源的 Agent 输出架构

## 摘要与问题边界

证据回答要求 Agent 的每一条实质性输出都能映射到实际使用的文件、数据库记录或工具结果，而不是仅由模型参数中的统计模式生成。它的核心问题不是“模型能不能答对”，而是“这条答案能否被审计者复核到原始来源”。适用范围限定在需要事实核查、合规追溯、工程决策支持的对话场景；不适用于创意生成、情感表达或用户明确要求模型进行假设推演的开放式任务。边界判定标准：当用户问题涉及代码库结构、配置文件、历史记录、技能文档或运行时状态时，系统必须提供证据引用；当问题要求头脑风暴、命名建议或风格评价时，可降级为弱证据或免责声明。

## 核心概念与数据模型

1. **Evidence Unit（证据单元）**：一次可独立验证的最小信息块，包含来源标识符、内容片段、读取时间戳、工具或读取器名称、以及置信度标记。例如从本地 Markdown 文件读取的段落、从数据库查询返回的行、从 Git 日志解析的提交记录。

2. **Source Anchor（来源锚点）**：指向原始位置的持久引用，形式为 `file://path/to/file.md#L12-L18` 或 `db://table_name/row_id/column`。它必须解析到具体版本，不能只写文件名；行号或主键缺失的引用视为无效。

3. **Answer Chain（回答链）**：从用户问题到最终答案的推导路径，保存每一步使用的证据单元编号、推理操作（检索、比较、聚合、排除）以及中间结论。链式结构允许审计者反向验证。

4. **Evidence Store（证据存储）**：只读缓存区，存放本次会话中读取过的原始内容副本。存储键由来源锚点哈希生成，防止模型在后续轮次中引用已被外部修改的内容。生命周期与会话绑定，会话结束时可归档或丢弃。

5. **Grounding Contract（接地契约）**：Agent 与工具层之间的接口协议，规定任何返回结构化数据的工具必须同时返回 Source Anchor；纯文本工具必须返回来源路径和片段范围。契约不约束工具内部实现，但约束返回格式。

6. **Confidence Tier（置信度层级）**：A 级表示直接证据原文支持；B 级表示多源证据聚合后的合理推断；C 级表示证据不足但模型可给出方向性提示，必须附带“证据不足”声明。不允许在无证据时输出 A 级结论。

## 设计决策与取舍

### 证据优先于流畅性
当完整证据引用会导致回答冗长时，优先保留引用，允许将解释性语句压缩。例外：用户明确请求“只给我结论”时，可折叠引用为可展开块，但不可删除。

### 只读边界高于完整性
如果写入工具可能污染证据来源，宁可返回“无法验证”也不允许在读取阶段触发写操作。边界例外：版本控制下的显式提交日志可以引用，因为提交记录本身不可变。

### 来源锚点版本化
所有文件引用必须绑定 Git commit hash 或文件内容哈希；数据库引用必须包含查询时间戳或事务 ID。取舍：这会增加引用长度，但消除了“外部已修改”导致的证据失效争议。

### 工具返回格式标准化
强制所有知识检索工具返回 JSON Lines 或结构化对象，禁止纯散文。代价是工具实现者需要多写一个序列化层；收益是下游模型可以精确引用片段，而不是模糊概括。

### 模型自由度分层
对 A 级证据，模型只能做同义转述和结构化重组；对 B 级证据，模型可进行比较和推断，但需标注推断步骤；对 C 级证据，模型可给出建议，但必须声明建议不来自已验证来源。

## 可执行的实施流程

1. 定义 Grounding Contract 接口，规定任何工具返回必须包含 `source_anchor`、`content_hash`、`retrieved_at` 和 `confidence` 字段。
2. 在 Agent 层注册所有只读工具，确保工具签名与契约一致；对不符合契约的工具拒绝接入。
3. 建立 Evidence Store 会话缓存，读取工具返回时立即写入缓存，键为 `source_anchor` 的 SHA-256 前缀。
4. 在提示模板中注入证据引用指令，要求模型在每次输出事实性陈述时附带 Evidence Unit 编号。
5. 实现 Answer Chain 中间表示，将用户问题、检索计划、工具调用、证据单元、推理步骤和最终答案序列化为可追溯的日志。
6. 添加引用校验器，检查模型回答中的引用是否存在于当前 Evidence Store；不存在的引用触发重写或警告。
7. 构建可观测性面板，展示每次回答的证据覆盖率、引用有效率和置信度分布。
8. 部署测试集，覆盖正向引用、边界缺失和无证据拒答三种场景，每次构建自动运行。
9. 设置来源失效监控，当原始文件在会话期间被修改时，将相关证据单元标记为 stale。
10. 建立人工审计通道，允许审核员从最终答案直接跳转到 Evidence Store 中的原始片段。

## TypeScript/Web/本地文件知识库示例

示例：本地知识库查询 `.pi/knowledge/architecture.md` 后回答“会话如何创建”。

输入：用户问题“Pi 会话如何创建”；检索工具 `search_knowledge` 接收查询词 `session creation` 和项目路径 `/Users/xbjt/Documents/myself/pi-samples`。

处理：工具读取 `.pi/knowledge/architecture.md` 第 45 至 52 行，返回 Evidence Unit `{id: E-202, source_anchor: 'file://.pi/knowledge/architecture.md#L45-L52', content_hash: 'a3f7...', retrieved_at: '2026-08-01T12:34:56Z', content: '使用 createAgentSession() 与配置好的 ModelRuntime 建立会话；SessionManager.inMemory() 用于当前 Web 会话注册表。'}`。

输出：Agent 回答“Pi 会话通过 `createAgentSession()` 创建，并配合已配置的 `ModelRuntime`；Web 会话注册表使用 `SessionManager.inMemory()`（E-202）。该结论来自项目本地知识库文件 `.pi/knowledge/architecture.md` 第 45 至 52 行，读取时间为 2026-08-01 12:34:56 UTC。”

## 性能、质量和可观测性指标

1. **Evidence Coverage（证据覆盖率）**：回答中事实性陈述附带有效引用的比例。测量方式：解析最终答案，统计带 Evidence Unit 编号的陈述数除以总事实陈述数。
2. **Citation Validity（引用有效率）**：模型引用的 Evidence Unit 确实存在于当前 Evidence Store 的比例。通过校验器自动核对。
3. **Source Latency（来源读取延迟）**：从发起工具调用到 Evidence Unit 写入缓存的 P95 时间。在服务端日志中记录。
4. **Stale Evidence Rate（过期证据率）**：会话期间原始来源被修改，导致已引用证据单元标记为 stale 的比例。由文件监控事件触发统计。
5. **拒答准确率**：面对无证据问题，系统正确返回“证据不足”而非编造答案的比例。通过人工标注的测试集测量。
6. **Audit Path Length（审计路径长度）**：从最终答案跳转到原始证据所需的中间步骤数。目标为 2 步以内：答案 → Evidence Unit → Source Anchor。

## 失败模式

1. **幻觉引用**：模型生成看似合理的引用编号，但 Evidence Store 中不存在。诊断证据：校验器报 `missing_evidence_id`；恢复动作：触发重写，要求模型仅使用已缓存单元，并记录到质量看板。
2. **来源漂移**：原始文件在会话中被修改，导致引用内容与当前文件不一致。诊断证据：`content_hash` 不匹配或收到文件系统修改事件；恢复动作：标记该单元为 stale，提示用户“引用内容可能已过期”，并重新检索。
3. **工具返回格式不一致**：某工具未返回 `source_anchor`。诊断证据：Grounding Contract 校验报 `schema_violation`；恢复动作：拒绝接入该工具，要求开发者补全字段。
4. **过度聚合**：模型将多个低置信度证据合并为 A 级结论。诊断证据：Answer Chain 中推断步骤缺失或置信度字段被覆盖；恢复动作：强制降级为 B 级并补充推断说明。
5. **遗漏引用**：模型正确使用了证据但未标注编号。诊断证据：Evidence Coverage 指标低于阈值；恢复动作：后处理阶段扫描答案，将未标注的原文片段自动补回引用。
6. **循环自证**：模型引用自己上一轮的输出作为证据。诊断证据：Source Anchor 指向会话输出而非原始文件；恢复动作：禁止引用任何非工具来源的缓存，除非明确标记为“模型生成的中间结论”。

## 问答测试样例

1. 正向问题：`.pi/knowledge` 中如何定义知识库读取方式？预期回答引用 `file://.pi/knowledge/architecture.md` 或 AGENTS.md 中关于 `search_knowledge` 的段落，并给出 Evidence Unit。
2. 正向问题：`SessionManager.inMemory()` 的用途是什么？预期回答引用本地知识库中关于会话注册表的具体行，并说明读取时间。
3. 边界问题：当前项目的 `pnpm` 版本是多少？预期回答引用 `package.json` 中的 `packageManager` 字段，或声明无法从已接入工具获取。
4. 边界问题：`apps/api` 是否允许直接调用 Pi SDK？预期回答引用 AGENTS.md 中“`apps/api`：请求验证、会话身份、能力注入；无 Pi SDK 或 provider key”并给出边界判断。
5. 无证据拒答：请告诉我 2027 年的 Node.js LTS 版本计划是什么？预期回答：项目未接入外部网络或版本发布数据库，无法提供证据，拒绝回答。
6. 无证据拒答：这个仓库的 API 密钥存储在哪里？预期回答：真实密钥不会通过只读工具暴露；系统应拒绝回答或声明无证据。

## 维护、版本、来源和与相邻主题的关系

维护策略：Grounding Contract 与 Evidence Store 属于 `packages/pi-agent` 或 Agent 中间层，版本号与 SDK 版本对齐；工具接口变更必须通过向后兼容的 schema 演进。来源管理：项目级文件来源由 `.pi/knowledge`、`AGENTS.md` 和 `.pi/skills` 组成；技能文件由 Skills CLI 管理，不可手工修改。与相邻主题的关系：证据回答依赖于“检索增强”和“工具调用”基础设施，但比二者更严格——它不仅要求检索和调用发生，还要求输出与来源可审计地绑定。与“提示工程”相邻，但证据回答将部分约束固化在契约和校验器中，而非仅依赖提示词。与“Agent 信任边界”相交，因为只读证据策略是防止模型越权写入的第一道防线。

## 结论

事实：Agent 回答中的事实性陈述必须能够追溯到本次会话中通过工具读取的原始文件、数据库记录或工具结果；Source Anchor 必须包含足够定位具体版本的标识；系统通过 Grounding Contract、Evidence Store 和校验器实现这一约束。推论：当检索工具覆盖完整、来源保持稳定、模型遵守引用格式时，证据回答可以显著降低幻觉和不可审计决策的风险。未知：人类可读的解释与严格引用之间的最佳平衡点尚未确定；多轮对话中模型引用自身中间结论是否应被允许，仍需根据具体合规要求进一步验证。
