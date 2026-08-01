---
type: concept
title: 规范校验：验证与运维视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。在发布前检查 frontmatter、路径、链接和必填字段
resource: .pi/knowledge/library/okf-governance/schema-operations.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, schema, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: schema
variant: operations
---

# OKF 知识库发布前规范校验：验证与运维视角

## 摘要与问题边界

规范校验是在知识条目进入公开索引或 Agent 召回路径之前，对其 frontmatter、文件路径、内部链接与必填字段进行结构化检查的过程。它的目标不是审校内容语义，而是保证每一条知识都能被稳定解析、唯一寻址、可靠引用。本视角聚焦验证系统的性能、稳定性与故障恢复：工程师需要看到的不是“某次提交通过了”，而是成功与失败的比例、校验延迟分布、容量上限，以及出现故障后如何回到可用状态。边界上，规范校验不处理自然语言质量、权限审批或运行时搜索结果排序；它只判定条目是否符合发布所需的机械性约束。

## 核心概念与数据模型

1. **知识条目（Knowledge Entry）**：一个 Markdown 文件，由 YAML frontmatter 与正文组成。frontmatter 描述元数据，正文承载可被检索器召回的文本内容。
2. **frontmatter 模式（Schema）**：用类型系统或 JSON Schema 定义必填字段，例如 `id`、`title`、`version`、`status`、`tags`、`updated_at`。字段必须类型正确，`status` 只能从 `draft`、`review`、`published` 枚举值中取值。
3. **规范路径（Canonical Path）**：条目的相对文件路径必须与其主题域一致，形如 `domain/topic/<slug>.md`。`slug` 由 `id` 经小写、连字符化得到，确保 URL 稳定且与文件名对齐。
4. **内部链接图（Internal Link Graph）**：所有指向库内其他条目的链接，无论是 Markdown 行内链接 `[text](/domain/topic/slug)` 还是 wiki 风格 `[[slug]]`，都会被解析为边；目标是图中节点，不存在的目标记为死链。
5. **发布批次（Publish Batch）**：一次提交或一次 CI 构建可能涉及多个条目。校验器以批次为单位运行，但报告按条目拆分，便于定位问题。
6. **校验报告（Validation Report）**：结构化 JSON 输出，包含条目标识、检查项、结果状态、严重级别、证据位置与修复建议。报告是故障恢复的第一手材料。

## 设计决策与取舍

### 本地快速校验与 CI 全量校验分离

本地 pre-commit 只做轻量检查：frontmatter YAML 语法、必填字段存在性、路径与 `id` 一致性。CI 负责全量死链扫描、跨条目重复 `id` 检测和索引一致性。取舍是本地速度优先，CI 正确性优先。

### 严格模式与扩展字段并存

核心字段采用 closed schema，未知核心字段直接报错；但允许以 `x_` 为前缀的扩展字段存在，避免不同业务线引入的自定义元数据破坏通用校验。取舍是在一致性与可扩展性之间保留隔离带。

### 链接检查使用本地索引而非实时网络请求

内部链接通过构建阶段生成的本地索引解析，而不是对目标路径发起运行时 HEAD 请求。这样消除网络抖动，降低延迟，但也意味着重定向或外部链接无法通过本地索引验证，需要单独降级为警告。

### 路径由 `id` 推导而非人工维护

文件名与目录由 `id` 自动生成规则确定，减少人为拼写差异；如果必须人工调整，需要显式提供 `canonical_path` 覆盖字段并附带理由。取舍是牺牲一定灵活性，换取链接长期稳定。

### 全量报告替代快速失败

校验器遇到第一个错误不会立即退出，而是继续收集同批次所有错误。这延长了单次运行时间，但让修复者一次看到全部问题，降低反复提交次数。

## 可执行的实施流程

1. 在仓库根目录创建 `.pi/schema/entry-schema.json`，定义字段类型、必填项与枚举值。
2. 实现 `parseEntry(filePath)`，读取文件后分割 frontmatter 与正文，捕获 YAML 解析异常并附带行号。
3. 实现 `deriveCanonicalPath(id, domain, topic)`，输出预期路径，并与实际路径比对。
4. 扫描整个知识库生成 `link-index.json`，记录每个 `id` 到 `slug` 与文件路径的映射。
5. 编写 `validateEntry(entry, index)`，依次执行 schema、路径、必填字段、内部链接四项检查，返回诊断数组。
6. 在 CI 中实现变更检测：取 git diff 得到直接修改文件，再通过链接图反向查找到被引用但未被修改的依赖条目，组成受影响集合。
7. 在受影响集合上运行校验，输出 `validation-report.json` 作为构建产物；若存在 `error` 级别诊断，CI 退出码非零。
8. 配置监控告警：校验运行时间、失败条目数、死链数超过阈值时通知运维，并关联运行手册。

## 输入、处理与输出示例

以下是一个条目在修复前后的简要示例。

输入条目（问题版本）：

    id: "api-rate-limit"
    title: "API 速率限制"
    status: "published"
    tags: ["api", "reliability"]

    # API 速率限制

    参见 [配额模型](/domain/unknown/quota)。

处理动作：

- frontmatter 检查：`updated_at` 必填缺失；`tags` 类型正确。
- 路径检查：`id` 推导路径为 `okf/api/api-rate-limit.md`，实际路径若是 `okf/api/rate-limit.md`，记录路径不一致。
- 链接检查：目标 slug `domain/unknown/quota` 不在本地索引中，记录死链及所在行号。

输出报告片段：

    {
      "entry_id": "api-rate-limit",
      "file": "okf/api/rate-limit.md",
      "status": "error",
      "diagnostics": [
        {
          "check": "required_field",
          "field": "updated_at",
          "severity": "error",
          "message": "必填字段缺失"
        },
        {
          "check": "canonical_path",
          "expected": "okf/api/api-rate-limit.md",
          "actual": "okf/api/rate-limit.md",
          "severity": "error"
        },
        {
          "check": "internal_link",
          "target": "domain/unknown/quota",
          "line": 5,
          "severity": "error"
        }
      ]
    }

## 性能、质量与可观测性指标

1. **单条目校验延迟**：从文件读入到报告生成的时间，按 p50、p99 统计，可通过 CI 日志中 `duration_ms` 字段测量。
2. **批次吞吐量**：单位时间内可校验的条目数，用压测批次除以总耗时得到，用于评估 CI 扩容需求。
3. **frontmatter 违规率**：被判定为 `error` 的条目数除以提交总条目数，每日聚合观察模式退化。
4. **死链率**：死链数量除以内部链接总数，按域分组，帮助发现主题结构腐烂。
5. **缓存命中率**：本地链接索引复用比例，衡量增量构建效果；低命中率说明变更范围过大或缓存策略失效。
6. **平均恢复时间（MTTR）**：从 CI 失败告警到下一次 green build 的时间间隔，由告警系统与 CI 状态联合计算。

## 失败模式、诊断证据与恢复动作

1. **YAML 语法错误**：证据为解析器抛出的行号与列号，或 `YAMLException` 堆栈。恢复动作是在指定行修复缩进、引号或列表符号后重新提交。
2. **必填字段缺失或类型错误**：证据是报告中列出的字段名、期望类型与实际值。恢复动作是补充字段或修正类型，例如将字符串形式的 `version` 改为语义版本字符串。
3. **`id` 或 slug 冲突**：证据是两个不同路径映射到同一 slug。恢复动作是合并重复概念，或给其中一条目分配新 `id`，必要时添加旧 `id` 到重定向别名表。
4. **死链**：证据是报告中目标 slug、引用文件与行号。恢复动作是创建缺失目标、修正链接指向，或在 frontmatter 中添加 `redirects` 条目记录旧 slug。
5. **CI 超时或内存溢出**：证据是构建日志中的 `timeout after 600s` 或 `JavaScript heap out of memory`。恢复动作是开启增量校验、按主题域分片、扩大资源配额，或临时跳过非变更依赖项。

## 问答测试样例

1. **正向**：发布前会做哪些检查？答：frontmatter 模式、必填字段、规范路径、内部链接完整性、重复 `id`。
2. **正向**：死链如何定位？答：通过 `link-index.json` 查找目标 slug 是否存在，报告会给出引用文件与行号。
3. **边界**：扩展字段 `x_owner` 未在 schema 中定义会失败吗？答：不会，只要前缀为 `x_` 且值可序列化。
4. **边界**：外部 HTTPS 链接返回 404 会阻断发布吗？答：默认不会，仅标记为警告；若配置 `strict_external_links=true` 则升级为错误。
5. **边界**：同一 `id` 移动到新路径是否算冲突？答：若旧路径保留 `redirects` 声明则算合法迁移；否则视为重复。
6. **拒答条件**：上周的校验 p99 延迟是多少？答：若无 CI 指标或日志，无法回答；应去监控面板查询 `validation_duration_ms` 指标。

## 维护、版本、来源与相邻主题

schema 版本遵循语义化版本，破坏性变更需通过迁移脚本更新旧条目。所有规则文件存放在 `.pi/schema` 与 `.pi/rules`，与条目内容分离。来源包括仓库提交历史、CI 构建产物和本地链接索引。相邻主题包括知识建模（定义主题域与 `id` 空间）、版本控制（迁移与重命名）、发布流水线（校验通过后进入索引构建）以及搜索召回（依赖规范路径与 frontmatter 标签）。

## 结论

**事实**：规范校验在发布前执行；检查项包括 frontmatter 语法、必填字段类型、规范路径一致性、内部链接可达性和 `id` 唯一性；输出为结构化报告。

**推论**：将链接检查下沉到本地索引可显著降低网络抖动带来的不稳定；全量报告模式能减少反复提交，但会提高单次运行资源占用。

**未知**：在条目数量超过十万量级时，全量索引构建的内存与时间曲线尚未在真实生产环境中验证；外部链接严格策略对发布频率的实际影响也缺少长期数据。这些需要通过压测与持续观测补齐。
