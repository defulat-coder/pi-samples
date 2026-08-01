---
type: concept
title: Frontmatter：架构视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。用稳定字段描述 concept 类型、标题、资源、标签和状态
resource: .pi/knowledge/library/okf-governance/frontmatter-architecture.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, frontmatter, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: frontmatter
variant: architecture
---

# OKF-compatible Concept 的 Frontmatter：架构化知识治理接口

Frontmatter 不是正文，而是知识对象在文件边界上的稳定接口。它负责把“人类可读的一篇文档”转换成“可被检索器和 Agent 路由的 Concept 记录”。本主题只处理描述 concept 类型、标题、资源、标签和状态的字段，不涉及正文渲染、权限控制、工作流审批或知识图谱的推理规则。若一个文件缺少这些字段，或字段不符合受控词表，则在 OKF 边界上应视为不可解析，而不是被默默降级为普通 Markdown。

## 核心概念与数据模型

1. `id`：概念的不变标识符，使用 URN 格式，例如 `urn:okf:concept:<slug>`。它不能由文件路径派生，文件移动、重命名、合并都不允许改变 id。
2. `schema_version`：描述 Frontmatter 自身的模式版本，不是文档版本。升级时必须有对应的迁移脚本，旧版本解析器至少保留 N 个版本的兼容期并输出警告。
3. `concept_type`：必填的分类字段，值必须来自受控词表。它决定下游处理管线，例如 `knowledge-concept`、`adr`、`skill`、`prompt-template`。未知值直接判为无效。
4. `title`：单一非空字符串，作为人类可读的规范名称。唯一性由注册中心保证，Frontmatter 本身不强制去重。
5. `resources`：指向外部资源的结构化引用数组，每个条目包含 `uri`、`media_type` 和 `role`。本地 URI 必须相对于项目根可解析；远程 URI 必须附带 `source_hash`，否则验证失败。
6. `tags`：标签数组，由受控标签和项目本地标签组成。本地标签必须加项目命名空间前缀，防止与受控词表冲突。
7. `status`：生命周期快照，取值限定为 `draft`、`stable`、`deprecated`、`archived`。该字段只反映治理状态机的当前结果，文档作者不能单独将其从 `draft` 改为 `stable`。

## 设计决策与取舍

### 字段稳定性优先于表达力
允许无限扩展字段会提高作者便利，但会破坏检索器和 Agent 的契约。只保留最稳定的字段，扩展通过命名空间本地标签实现，且必须进入注册中心备案。

### 机器可读性优先于人眼舒适
严格的 JSON Schema 和正则校验会增加写作阻力。但既然目标是 Agent 引用和按标签召回，就必须接受这种摩擦，并在 CI 中提供即时反馈。

### 类型字段是路由键而非装饰
`concept_type` 不只是分类标签，它直接决定解析器选择、索引分片和渲染模板。把类型字段当作文档标签使用属于错误用法。

### 资源与内容分离
不在 Frontmatter 中内嵌 Base64 或大块内容。`resources` 只保存引用，使 Frontmatter 保持轻量、可版本化，并让链接检查器独立运行。

### 状态字段是只读快照
`status` 的写入必须经由治理状态机。文档中自声明 `stable` 不被采信，除非注册中心存在对应的审查记录。这样可以防止状态漂移。

## 可执行的实施流程

1. 在 `.pi/schema/frontmatter-v1.2.json` 中定义 JSON Schema，列出所有必填字段、类型和正则约束。
2. 在 `.pi/registry/concept-types.yaml` 中维护受控词表，定义 `concept_type` 和 `tags` 的允许值。
3. 实现一个解析器，能从 Markdown 文件顶部提取 Frontmatter，支持 YAML 和 JSON 两种语法，但输出统一规范对象。
4. 实现校验器，对未知字段报错、对受控词表未命中报错、对资源 URI 格式和可解析性报错。
5. 将校验器接入 Git 钩子与 CI，在每次提交和 Pull Request 时运行，失败即阻塞合并。
6. 建立注册中心索引，将 `id` 映射到文件路径，将 `concept_type` 映射到处理管线。
7. 编写迁移脚本，当 `schema_version` 变化时把旧字段转换到新结构，同时保留原始 `id`。
8. 部署文件监控或 Git 工作流，索引在文件变更后增量重建，每日全量对账一次。
9. 为 Agent 读工具定义只读契约：返回规范化字段，不修改、不推断缺失字段。
10. 在合并前跑边界测试集：包含字段完整、类型越界、缺失必填、资源不可解析、ID 冲突五种场景。

## 输入、处理、输出示例

下面是一个贴近 TypeScript/Web/本地文件知识库的 JSON Frontmatter 示例。

    {
      "id": "urn:okf:concept:frontmatter-schema",
      "schema_version": "okf-frontmatter/1.2",
      "concept_type": "knowledge-concept",
      "title": "Frontmatter 稳定字段接口",
      "resources": [
        {
          "uri": "./schema/frontmatter-v1.2.json",
          "media_type": "application/schema+json",
          "role": "schema"
        },
        {
          "uri": "https://example.org/okf/concepts/frontmatter.md",
          "media_type": "text/markdown",
          "role": "primary",
          "source_hash": "sha256:abc123..."
        }
      ],
      "tags": ["okf-core", "metadata", "governance"],
      "status": "stable"
    }

输入：项目根目录下的一份 Markdown 文件，顶部包含上述对象。处理：解析器提取对象，校验器检查 `concept_type` 是否在注册中心、`resources` 是否可解析或远程链接是否提供哈希、`tags` 是否命中受控词表、`status` 是否在允许集合。输出：注册中心索引中新增一条记录，包含 `id`、`title`、`concept_type` 对应的管线、`status` 和审计日志。

## 性能、质量与可观测性指标

- 字段覆盖率：注册中心扫描中拥有全部必填字段的 Concept 占比，通过全量对账任务测量。
- 受控标签命中率：命中受控词表的标签数量除以总标签数量，由校验报告输出。
- 解析延迟：CI 中解析并校验单个文件的 p95 耗时，可用测试脚本统计。
- 索引一致性：注册中心索引哈希与全量重扫结果是否一致，由每日对账任务报告。
- 资源可解析率：链接检查器验证通过的 `resources` 条目占比，失败项进入待修复队列。
- 状态迁移及时率：从 `deprecated` 到 `archived` 超过 SLA 未处理的 Concept 占比，由治理机器人统计。

## 失败模式、诊断证据与恢复动作

- 字段缺失：校验器报出具体字段名与文件行号。恢复：补齐必填字段，或在未完成前将 `status` 改为 `draft`。
- 未知 `concept_type`：校验器列出注册中心允许值。恢复：把类型改为已注册值，或按流程扩展受控词表。
- 资源 URI 不可解析：链接检查器返回 404 或路径不存在。恢复：修正路径、补全文件，或删除失效引用。
- `id` 冲突：注册中心索引发现两个文件共享同一 URN。恢复：合并重复记录，或为其中一个重新分配 URN 并建立重定向。
- 状态与内容不一致：治理机器人扫描到 `status` 为 `stable` 但正文仍含 `TODO` 或大量待商榷表述。恢复：降级为 `draft` 或清除内容中的未完成标记。

## 问答测试样例

- 正向：Frontmatter 中 `title` 和 `concept_type` 的约束是什么？答：`title` 必须为单一非空字符串；`concept_type` 必须来自注册中心受控词表。
- 边界：旧版 `schema_version` 为 1.0 的文件怎么办？答：迁移脚本将其转换为 1.2；若无迁移脚本，则拒绝索引并标记待处理。
- 无证据：Frontmatter 是否应包含 CSS 或渲染样式字段？答：这超出本主题范围，拒绝回答，因为模式明确不包含展示层字段。
- 正向：远程资源能否出现在 `resources` 中？答：可以，但必须提供 `source_hash`，否则校验失败。
- 边界：本地标签与受控标签同名怎么办？答：本地标签必须加项目命名空间前缀，否则校验器按冲突处理。
- 无证据：一个 `status` 为 `stable` 的文档是否一定经过审查？答：不能仅凭 Frontmatter 字段推断，必须查询治理状态机的审查记录。

## 维护、版本、来源与相邻关系

Frontmatter 模式版本与文档内容版本独立演进。每次模式升级必须提供迁移脚本，并在 `.pi/registry/changelog.md` 中记录字段增删。来源字段 `provenance` 应记录上游提交哈希或 URL，以便重建注册中心。与相邻主题的关系如下：正文内容由 Markdown 主体负责，不在 Frontmatter 中定义；权限控制由访问策略层负责，Frontmatter 不携带权限字段；分类法由注册中心独立管理；知识图谱推理由下游管线消费 Frontmatter 后生成；工作流审批由治理状态机写入 `status` 的变更记录。

## 结论

- 事实：Frontmatter 是知识对象在文件边界上的稳定接口；必填字段包括 `id`、`schema_version`、`concept_type`、`title`、`resources`、`tags`、`status`；`resources` 是外部引用而非内嵌内容；`status` 是治理状态机的快照。
- 推论：在模式层面保持最小、稳定且强制校验，可显著提升长期检索准确性与 Agent 引用可靠性。
- 未知：受控词表的最优规模、严格校验对作者采纳率的影响、远程资源哈希是否应强制要求，均需通过项目级度量和迭代验证。
