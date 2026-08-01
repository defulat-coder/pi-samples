---
type: concept
title: 政策说明：实现视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。明确适用范围、例外、审批人和不允许的解释空间
resource: .pi/knowledge/library/markdown-knowledge/policy-implementation.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, policy, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: policy
variant: implementation
---

# 政策说明在 TypeScript 本地文件知识库中的实现规范

## 摘要与问题边界

政策说明是一种高约束的知识库文档，用于声明某条规则在哪些目录、文件或运行时环境中生效，列出明确例外，记录最终审批人，并禁止执行方在运行过程中自行扩展解释。它的目标读者是负责将方案落成为 TypeScript 代码的开发者，因此本文档不写法律释义，也不写面向终端用户的操作指南。它只解决一个问题：在 `.pi/knowledge` 这类本地文件知识库中，怎样把一条政策表达成机器可校验、Agent 可引用、人类可审计的结构化条目。

适用边界限定在 Web 触发的 Pi 编码助手场景，服务范围覆盖 `apps/api`、`apps/web` 和 `packages/*` 目录。不覆盖外部第三方依赖、用户本地环境配置、运行时密钥分发。任何政策如果未明确声明适用范围，默认视为失效，检索器不得返回，Agent 也不得引用。

## 核心概念与数据模型

1. **PolicyStatement（政策声明）**：每条政策的根对象，包含唯一 `policyId`、语义版本 `version`、生效日期 `effectiveDate` 和当前状态 `state`。`policyId` 必须采用 `domain-NNN` 格式，例如 `security-001`，不允许重复。
2. **ScopeClause（适用范围）**：使用显式路径表达式或 glob 声明适用范围。支持 `include` 和 `exclude` 两个数组，路径前缀必须匹配项目实际目录。未命中范围的文件，即使内容相关，也不得套用该政策。
3. **ExceptionClause（例外）**：每个例外必须包含 `trigger`（触发条件）、`scope`（受影响范围）和 `fallback`（替代方案）。例外不能出现“其他情况另行通知”之类无明确边界的描述。
4. **ApproverRecord（审批人记录）**：记录审批人身份、角色、审批时间戳和签名哈希。至少包含一名负责人和一名技术负责人。缺少审批人记录的政策处于 `draft` 状态，禁止发布。
5. **InterpretationRule（解释规则）**：明确列出允许的解释来源和禁止的解释模式。禁止模式至少包含 `["酌情", "视情况", "自行决定", "原则上", "另行协商"]`。
6. **EnforcementState（执行状态）**：枚举为 `draft`、`approved`、`deprecated`、`revoked`。`approved` 才可被检索；`deprecated` 仍可返回但附带警告；`revoked` 立即失效，任何引用都应拒绝。

## 设计决策与取舍

**显式范围优于自然语言**
政策说明不使用“主要适用于后端代码”这类模糊表述，而要求 `apps/api/**/*.ts` 这样的精确 glob。代价是维护者必须随目录结构调整版本，但换来了 Agent 在检索时可以直接通过路径匹配做可验证的召回。

**审批链结构化而非扁平化**
不把审批人写成一段 Markdown 文本，而是写成字段数组。好处是校验器可以检查必填字段和签名哈希；代价是发布流程比普通文档更重，但政策类文档本身就应当有更高门槛。

**解释空间采用禁用模式列表**
理论上完全消除解释空间不可能，但可以通过禁用模式列表把高风险表达阻断。所有发布前的 YAML 必须跑一遍禁用词扫描，命中任何一条即拒绝提交。这牺牲了部分自然语言流畅性，但换来了可审计性。

**版本语义化而非线性日期戳**
版本号采用 `MAJOR.MINOR.PATCH`，重大范围或例外变更必须升 MAJOR，修订说明升 MINOR，措辞修正升 PATCH。撤销通过发布新版本的 `revoked` 状态完成，而不是删除旧文件，以保留审计轨迹。

**YAML 为主、JSON 为辅的存储格式**
本地文件知识库使用 YAML 便于人类评审；Web 层通过 API 传输时转换为 JSON。TypeScript 校验层同时接受两种输入，但输出统一为 JSON 对象，避免上层代码处理两套结构。

## 可执行的实施流程

1. 从 issue 或 PR 讨论中识别出需要上升为政策的规则，登记 `policyId` 并检查是否已存在同名或同域政策。
2. 收集适用范围：列出所有目标目录、文件扩展名、运行时边界，明确排除项。
3. 识别例外场景：与相关模块维护者确认哪些情况可以合法偏离，并给出替代方案。
4. 指定审批人：至少一名负责人和一名技术负责人，生成审批记录。
5. 编写政策正文：每条规则使用主谓宾结构，禁止使用条件从句堆叠。
6. 运行禁用词扫描：任何命中禁用模式即返回错误，必须重写。
7. 结构验证：调用校验函数检查字段完整、版本合法、路径有效、状态正确。
8. 发布到 `.pi/knowledge`：文件路径按 `policies/{policyId}-{version}.yaml` 存放。
9. 注册检索索引：把 `policyId`、`scope`、`exception` 关键词写入索引，供检索器召回。
10. 接入 Agent 工具：让 `search_knowledge` 工具仅返回 `approved` 和 `deprecated` 状态的政策。
11. 持续监控：记录政策命中次数、例外触发比例、被引用后引发的后续问题。

## 输入、处理、输出示例

示例文件为 `.pi/knowledge/policies/code-review-001.yaml`。输入是一段 YAML 字符串，其中声明 `policyId` 为 `code-review-001`，版本 `1.0.0`，适用范围 `include` 包含 `apps/api/**/*.ts` 和 `packages/*/src/**/*.ts`，`exclude` 包含 `**/*.test.ts`。例外部分声明 `apps/api/**/*.test.ts` 在仅修改测试数据时无需人工审批，但必须通过 CI 检查。审批人记录包含 `id` 为 `alice@example.com` 的负责人和 `id` 为 `bob@example.com` 的技术负责人，以及对应的签名哈希。解释规则部分 `allowedSources` 仅限该 YAML 文件和关联 issue 链接，`forbiddenPatterns` 包含 “酌情” 和 “自行决定”。

处理流程使用 TypeScript 校验函数：先解析 YAML 为 JSON，检查根对象是否包含全部六个核心字段；再检查 `scope.include` 是否非空；接着用禁用模式正则扫描 `policyText` 和 `exception` 文本；然后验证 `approver` 数组长度和签名哈希；最后确认 `state` 为 `approved` 或 `deprecated` 才允许入库。输出有两种：成功时返回结构化的 `PolicyStatement` 对象，包含索引所需字段；失败时返回 `ValidationError` 对象，包含 `field`、`message` 和 `recoverable` 布尔值，供发布脚本决定是否重试。

## 性能、质量、可观测性指标

1. **检索延迟**：单次 `search_knowledge` 调用中政策说明返回时间应小于 50 毫秒，使用本地文件索引和内存缓存测量。
2. **覆盖命中率**：每月统计被查询路径命中政策的比例，目标是大于 90%，低命中率说明范围声明过窄。
3. **例外触发比例**：统计 Agent 在实际执行中触发例外的次数占总引用次数的比例，若超过 15%，提示例外过宽。
4. **误解释率**：通过审阅 Agent 引用政策后的输出，检查是否出现禁用模式或超出范围结论，每月抽样不少于 30 条。
5. **版本漂移检测**：检索器发现同一 `policyId` 存在多个 `approved` 版本时立即告警，指标为告警次数。
6. **审批链完整性**：发布脚本记录每次提交中审批人字段缺失次数，目标为零。

## 失败模式、诊断证据与恢复动作

1. **范围遗漏**：诊断证据是某条路径被 Agent 频繁询问却未被任何政策覆盖；恢复动作是补充 `scope.include` 并发布 MINOR 版本。
2. **例外过宽**：诊断证据是例外触发比例超过阈值；恢复动作是收紧 `trigger` 条件，必要时拆分多条例外。
3. **审批人缺失**：诊断证据是发布脚本返回 `approver` 字段缺失；恢复动作是拒绝提交并要求补录审批记录。
4. **禁用词泄漏**：诊断证据是校验函数命中 `forbiddenPatterns`；恢复动作是重写相关句子，使用明确主谓宾。
5. **版本冲突**：诊断证据是索引中存在两个 `approved` 的同名政策；恢复动作是把旧版本标记为 `deprecated`。
6. **引用已撤销政策**：诊断证据是 Agent 收到 `state: revoked` 的政策并试图执行；恢复动作是检索器过滤 `revoked`，并在 API 层返回 410 风格的知识失效提示。

## 问答测试样例

1. 正向问题：`apps/api/src/routes/session.ts` 是否受代码审查政策约束？期望回答：是，命中 `apps/api/**/*.ts` 范围。
2. 边界问题：`apps/api/src/routes/session.test.ts` 是否受同一政策约束？期望回答：不属于常规范围，但符合“测试数据-only 修改”例外时仍需 CI 通过。
3. 无证据问题：`apps/mobile` 目录是否受本政策约束？期望回答：政策未声明该范围，无法引用，需咨询维护者。
4. 审批人问题：该政策的最终审批人是谁？期望回答：输出 `alice@example.com` 和 `bob@example.com` 及其角色。
5. 解释空间问题：执行时能否“视情况”放宽审查要求？期望回答：政策禁用模式命中“视情况”，不允许自行解释。
6. 失效问题：版本 `1.0.0` 已被 `2.0.0` 撤销后，Agent 是否仍可引用？期望回答：不可，应返回已失效提示。

## 维护、版本、来源与相邻主题关系

来源统一为 `.pi/knowledge` 目录下的政策文件，版本与 Git 提交哈希绑定，发布时通过 `git diff` 校验文件变动。维护频率建议每季度审查一次，范围调整升 MINOR，政策撤销升 MAJOR。与相邻主题的关系：FAQ 回答通用问题，操作手册说明具体步骤，政策说明负责划定“能做什么”和“不能做什么”。政策说明可以引用 ADR 作为背景，但不能被 ADR 替代；Agent 优先使用政策说明处理权限边界问题，再fallback 到操作手册。

## 结论

事实：政策说明在 `.pi/knowledge` 中以结构化 YAML 存储，必须包含 `scope`、`exception`、`approver`、`interpretation` 和 `state` 字段，且只有 `approved` 或 `deprecated` 状态可被 Agent 引用。

推论：当实施流程中的校验函数、检索过滤和监控指标都到位后，可以显著降低 Agent 越权解释或引用过期政策的概率。

未知：在大型 monorepo 中，政策范围与代码目录的同步成本、跨项目共享政策的版本兼容策略、以及人类评审与自动校验的最佳比例，仍需根据实际项目数据进一步验证。
