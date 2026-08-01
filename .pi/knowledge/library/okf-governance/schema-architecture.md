---
type: concept
title: 规范校验：架构视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。在发布前检查 frontmatter、路径、链接和必填字段
resource: .pi/knowledge/library/okf-governance/schema-architecture.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, schema, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: schema
variant: architecture
---

# OKF 知识治理中的规范校验：发布前检查 frontmatter、路径、链接与必填字段的架构设计

## 摘要与问题边界

规范校验是 OKF-compatible 概念在发布进入消费侧之前的最后一道静态闸门。它的核心职责是验证知识条目的元数据、定位标识、引用关系与必填字段是否符合项目约定的治理规则，而不是判断内容本身的语义正确性。问题边界可以明确为四类输入：Markdown/MDX 正文、YAML frontmatter、文件系统路径、条目之间的内部链接。边界之外的职责包括运行时检索质量、外部链接的实时可达性、自然语言生成内容的语义审查，这些由相邻主题负责。校验发生在发布前（pre-publish），与 pre-commit 提示和 CI 编译解耦，其目标是保证任何被索引器或 Agent 引用的概念在结构和引用上具备可验证的一致性。

## 核心概念与数据模型

1. **校验单元（Validation Unit）**：单个可被独立校验的知识条目，通常对应一个 Markdown 文件及其 frontmatter。边界是：一个文件只能属于一个主题域，若存在多个主题域声明，则按主 domain 字段归集，其余视为扩展标签。
2. **校验规则（Validation Rule）**：原子化的断言声明，例如 required、pattern、enum、slug、foreign-key、link-integrity。每条规则必须包含 ruleId、severity、appliesTo 三个字段，缺一不可。
3. **校验上下文（Validation Context）**：运行期注入的环境信息，包括 cwd、basePath、locale、schemaVersion、namespace、branchName。上下文不可被 frontmatter 覆盖，只能从调用方或 CI 配置传入。
4. **校验结果（Validation Result）**：统一结构为 `{ ruleId, severity, code, message, location, suggestion, unitId }`。location 必须精确到行与列；若无法定位，则 location 记为 `null` 并在 message 中说明原因。
5. **校验流水线（Validation Pipeline）**：固定阶段为 load → parse → normalize → assert → report。每个阶段都是可替换接口，阶段之间通过不可变上下文对象传递状态。失败策略允许在 assert 阶段选择 fail-fast 或 accumulate-all。
6. **校验策略（Validation Policy）**：按分支、命名空间或角色定义的阈值配置，决定某类规则触发后是 block、warn 还是 ignore。策略文件本身也须通过 schema 校验，否则整个流水线拒绝执行。

## 设计决策与取舍

**校验时机的选择。** 候选方案包括 pre-commit、CI 构建和 pre-publish。pre-commit 反馈最快，但无法保证所有协作者本地安装一致；CI 能统一环境，却往往与内容发布存在时间差；pre-publish 则直接绑定发布闸门，确保被索引的版本必然已校验。本架构选择 pre-publish 作为强制闸门，pre-commit 作为可选加速器，CI 作为兜底报告。取舍的代价是发布脚本必须能访问 schema 与文件系统，不能是纯前端逻辑。

**规则引擎的声明式与可编程混合。** 纯声明式 schema 便于非开发者维护，但无法处理领域特定规则，例如“若 status 为 deprecated，则必须存在 supersededBy 字段”。纯可编程插件灵活，却会导致规则分散、难以审计。本架构采用 schema 覆盖 80% 以上规则，plugin 接口保留给需要读取项目级上下文或跨文件关系的复杂断言。边界是：plugin 必须返回与声明式规则一致的 Validation Result 结构，不能直接向 stdout 打印。

**路径解析的坐标系。** 候选方案包括绝对路径、相对路径和稳定 ID。绝对路径在本地开发可运行，但在不同机器和 CI 环境会失效；稳定 ID 可移植，却对作者不直观；相对路径以 repository root 为原点，兼顾可移植性与可读性。本架构选择相对路径为主，稳定 ID 为可选别名。例外是：当文件被重命名时，ID 保持不变，链接校验优先按 ID 解析，次按路径解析。

**链接校验的范围。** 内部链接必须 100% 可解析到现有概念条目或显式定义的 redirect；外部链接仅校验 URL 格式是否合法，不执行网络请求，以避免 flaky 构建和不必要的隐私暴露。边界是：mailto、anchor-only 链接和外部链接不检查可达性，但会检查格式。

**错误处理的默认策略。** fail-fast 适合快速修复单一错误，但会隐藏后续问题；accumulate-all 能为作者提供完整清单，却可能一次暴露过多噪音。本架构默认采用 accumulate-all，并在 CI 中提供 `--fail-fast` 选项用于紧急修复。策略配置可覆盖默认行为，但 block 级规则在任何策略下都不允许忽略。

## 可执行的实施流程

1. 划定知识条目边界：通过 glob 规则定义哪些文件属于 OKF 概念，例如 `docs/okf/**/*.md` 与 `.pi/knowledge/**/*.md`，排除 `node_modules`、draft 目录和已废弃的版本快照目录。
2. 编制 schema 目录：按 `schemas/<domain>/<topic>.schema.yaml` 组织，每个 schema 声明字段、类型、约束与错误码区间。不同主题域的 schema 不能互相覆盖字段定义。
3. 实现 loader：读取文件内容，识别 frontmatter 分隔符（`---`），将正文与元数据分离，并记录原始行号以便后续定位。
4. 实现 rule registry：注册 required、pattern、enum、slug、path-exists、link-integrity 等内置规则；为每个规则分配错误码区间，避免冲突。
5. 实现 context builder：从环境变量或 CLI 参数注入 cwd、basePath、locale、schemaVersion、namespace、branchName，并验证这些参数自身是否合法。
6. 实现 pipeline runner：按 load → parse → normalize → assert → report 顺序执行，每个阶段抛出结构化异常；assert 阶段支持并发，但并发粒度限定为同一目录内串行、不同目录间并行。
7. 实现 policy evaluator：读取 `.pi/validation-policy.yaml`，根据分支和角色将结果映射为 block、warn 或 ignore。policy 文件缺失时默认所有 error 为 block，所有 warning 为 warn。
8. 输出 report 并集成发布闸门：生成 SARIF 或 JSON 报告，若存在 block 级结果则退出码非零，发布脚本据此阻止索引更新。

## 输入、处理与输出示例

以下是一个贴近 TypeScript/Web/本地文件知识库的配置与运行示例，采用文本缩进格式展示，不引入代码围栏。

输入文件为 `docs/okf/validation.md`，其 frontmatter 如下：

    title: 规范校验
    domain: okf-knowledge-governance
    topic: validation
    status: draft
    required_fields: [title, domain, topic]
    tags: [architecture, validation]

正文中存在一行：

    参见 [[missing-concept]] 的定义。

schema 文件 `schemas/okf-knowledge-governance/validation.schema.yaml` 声明：title、domain、topic 为必填字符串；status 必须是 draft、stable、deprecated 之一；所有内部链接必须解析到存在的概念文件或 redirect 表。

处理过程：loader 提取 frontmatter 与正文，并记录内部链接 `missing-concept` 出现在第 12 行第 5 列。normalize 阶段将 `domain` 与 `topic` 组合为命名空间 `okf-knowledge-governance/validation`。assert 阶段执行 required、enum、link-integrity 三条规则，发现 `missing-concept` 在文件系统与 redirect 表中均不存在。

输出结果为一项错误记录：

    ruleId: link-integrity
    code: E4001
    severity: error
    message: 内部链接目标 "missing-concept" 不存在于当前命名空间，也未在 redirect 表中注册
    location: { line: 12, column: 5 }
    suggestion: 创建 docs/okf/missing-concept.md 或在 redirects.yaml 中添加映射
    unitId: docs/okf/validation.md

## 性能、质量与可观测性指标

1. **端到端校验延迟**：目标为每 100 个文件低于 500 毫秒。测量方式是在 CI 中持续记录 `validation_duration_ms`，并在本地通过固定基准仓库执行 50 次取 p95。
2. **误报率**：每月随机抽样 50 条 warning 及以上级别结果，由维护者人工标注是否为误报，目标误报率低于 5%。
3. **校验覆盖率**：被扫描文件数除以符合 glob 规则的总文件数，目标为 100%。测量方式是在 loader 阶段记录每个文件是否被读取，缺失时发出 `coverage_gap` 事件。
4. **规则修复周期**：从 block 级问题被报告到对应 PR 合并的平均时间。通过 issue tracker 或 PR 关闭时间计算，目标为 3 个工作日内。
5. **规则命中率分布**：统计每条规则在每次发布校验中的触发次数，用于识别废弃规则或schema盲区。 telemetry 以 `rule_id` 为标签上报。

## 失败模式、诊断证据与恢复动作

1. **Frontmatter 解析失败**。诊断证据是 loader 报告 `YAMLException` 并给出起始行号；常见原因是标题含未转义冒号。恢复动作：修复 frontmatter 语法，或在 schema 中为该字段声明更宽松的字符串类型。
2. **相对路径误报**。诊断证据是同一目录下大量 E4001 错误且目标文件实际存在。常见原因是 context builder 注入了错误的 `basePath`。恢复动作：检查 CI 环境变量或 CLI 参数，确保 basePath 与仓库根一致。
3. **规则版本漂移**。诊断证据是旧分支首次触发新规则的大量 block。原因是 schema 版本未与分支绑定。恢复动作：在 schema 中引入 `sinceVersion` 字段，并在 policy 中按分支指定生效版本。
4. **隐性必填字段缺失**。诊断证据是校验通过但下游检索器或 Agent 抛出字段缺失异常。恢复动作：将下游消费侧依赖显式写入 schema，并建立 schema 与消费代码的反向同步机制。
5. **并发扫描导致文件遗漏**。诊断证据是覆盖率低于 100% 且无任何错误日志。原因是文件锁或 glob 竞争。恢复动作：改用目录级串行、跨目录并发的粒度，并在 loader 阶段对缺失文件发出 `coverage_gap` 告警。

## 问答测试样例

1. **正向**：规范校验是否检查 frontmatter 中的必填字段？答：是，schema 中标记为 required 的字段在 assert 阶段会逐条验证缺失、类型与空值。
2. **正向**：内部链接不可达时会怎样？答：会生成 code 为 E4001 的 error，阻止发布，直到目标文件创建或 redirect 表中注册映射。
3. **边界**：一个 Markdown 文件没有 frontmatter 但有正文，是否会被接受？答：默认不接受，因为 OKF 概念条目必须携带 frontmatter 以声明 domain 与 topic；但可通过 policy 对特定临时目录配置为 warn。
4. **边界**：路径或 slug 使用大写字母会怎样？答：slug 规则强制小写字母、数字与连字符，文件系统大小写敏感时，大写路径会被视为不同文件并触发一致性错误。
5. **无证据拒答**：规范校验能否判断文章内容是否符合事实？答：不能。本系统仅做结构与引用校验，不做语义或事实核查，问题超出职责范围。
6. **无证据拒答**：发布后某个内部链接因目标被删除而失效，规范校验能否保证不发生？答：不能。校验保证的是发布快照时刻的链接完整性，无法预测发布后的修改。持续保证需要版本治理与删除审查流程配合。

## 维护、版本、来源与相邻主题关系

维护责任由知识治理小组与主题所有者共同承担：治理小组维护 schema 目录、错误码区间与 policy 默认策略，主题所有者维护具体主题的字段定义与样例。版本策略采用语义化版本管理 schema，schema 的 major 版本变更意味着新增 block 级规则或删除字段，必须伴随 migration 文档。规则与错误码的来源记录在 `docs/adr/` 或 `AGENTS.md` 中，避免“约定仅在代码中”的隐形知识。

相邻主题包括：版本治理负责发布后概念的生命周期与重定向；search_knowledge 负责运行时的向量或关键词检索；prompt templates 负责消费侧的模板渲染；权限与边界主题负责谁能修改 schema 与 policy。规范校验与这些主题的关系是前置依赖：它不负责检索质量，但必须保证进入检索与模板消费的知识条目在结构上可信。

## 结论

事实层面，规范校验是 OKF 知识治理中一道发布前强制闸门，其检查对象明确限定为 frontmatter 字段、文件路径、slug 命名与内部链接完整性。推论层面，采用可替换的流水线接口与声明式-可编程混合规则引擎，能够显著延长系统的演化周期，使治理规则可以随主题域扩张而平滑升级。未知层面，当仓库规模超过十万条目或引入 LLM 自动生成内容后，当前默认的并发粒度与规则缓存策略是否仍保持亚秒级延迟，尚未经过验证；外部链接实时可达性的取舍是否需要在某些封闭内网场景中重新评估，也仍需更多运行数据支持。
