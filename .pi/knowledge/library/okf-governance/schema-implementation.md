---
type: concept
title: 规范校验：实现视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。在发布前检查 frontmatter、路径、链接和必填字段
resource: .pi/knowledge/library/okf-governance/schema-implementation.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, schema, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: schema
variant: implementation
---

# OKF-compatible 知识发布规范校验器实现指南

## 摘要与问题边界

规范校验器在知识发布流程中充当最后一道机械闸门。它的职责是在构建或部署启动前，对 frontmatter 元数据、物理与逻辑路径、内部与外部链接以及所有声明为必填的字段执行可重复检查。任何未通过校验的内容对象都不应进入发布产物，否则会导致索引失效、404、元数据缺失或被下游消费者解析失败。

本指南的问题边界限定在“本地文件系统 + 静态/半静态知识库”场景，覆盖 Markdown、MDX 以及附带 YAML/JSON 描述文件的知识条目。它不负责检查自然语言质量、业务语义正确性、版权合规或运行时数据库状态。外部链接的可用性仅作为可选扩展校验，因为网络抖动可能引入非确定性阻塞。

## 核心概念与数据模型

1. **文档节点（DocumentNode）**
   每个待发布文件映射为一个节点，包含物理路径 `filePath`、逻辑路径 `slug`、解析后的 frontmatter 对象、正文 AST 或原始字符串以及节点类型（`article`、`topic`、`snippet`、`attachment`）。逻辑路径与物理路径允许不一致，但必须在 Schema 中显式声明映射规则。

2. **规范声明（SchemaDeclaration）**
   项目级配置，定义字段名称、类型、是否必填、是否唯一、允许取值范围、正则约束以及字段间依赖。例如 `date` 必须是 ISO 8601 字符串，`tags` 必须是字符串数组且不能为空字符串，`draft` 为布尔值默认 `false`。

3. **资源图（ResourceGraph）**
   由所有节点和边构成的有向图。边来源包括：frontmatter 中 `related`、`parent`、`series` 字段；正文中的相对链接与图片；附件引用。图用于检测缺失目标、重复 slug 和循环依赖。

4. **校验结果（ValidationResult）**
   每个节点产生一个结果对象，包含 `status`（`ok`、`warn`、`error`）、错误码、发生位置（文件、行号、字段名）、修复建议以及严重等级。结果必须稳定排序，便于 diff 比较。

5. **发布门（ReleaseGate）**
   由校验阶段和阈值构成的合并条件。例如：阶段一（结构校验）不允许任何 `error`；阶段二（链接可用性）允许最多 3 个 `warn`；阶段三（自定义规则）必须全绿。阈值可配置，但缺省阈值对 `error` 零容忍。

6. **上下文对象（ValidationContext）**
   一次校验运行的全局参数，包括 `cwd`、`baseUrl`、`allowedExtensions`、`excludedGlobs`、`strictPathCasing`、`dateLocale` 和 `schemaVersion`。所有相对路径和链接都基于 `baseUrl` 解析。

7. **校验器管道（ValidatorPipeline）**
   按固定顺序执行的前置校验器集合：文件存在性 → 扩展名检查 → frontmatter 解析 → 字段校验 → 路径规范化 → 链接解析 → 图完整性 → 自定义规则。管道支持阶段熔断，即任一阶段出现致命错误时跳过后续依赖阶段。

## 设计决策与取舍

### 解析策略：解析器优先，正则辅助
frontmatter 使用成熟库（如 `gray-matter`）解析，避免手写 `---` 边界检测带来的多行字符串和注释误判。正文中的链接与图片使用 Markdown AST 遍历，捕获 `[]()`、`<>`、HTML `<a>` 和 MDX 组件。对于非标准语法（如 wiki-link `[[...]]`），通过正则插件补充，但默认不启用。取舍：解析器增加依赖，但误报率显著低于纯正则。

### 错误等级：保守的致命等级
错误分为 `fatal`、`error`、`warn`、`info`。`fatal` 仅用于解析失败或 Schema 版本不匹配；`error` 用于必填字段缺失、slug 重复、目标文件不存在；`warn` 用于外部链接 404、弃用字段；`info` 用于建议。默认 `fatal` 和 `error` 都会阻塞发布，但可通过配置将部分 `error` 降级为 `warn`。边界：空数组和空字符串视为无效必填字段，但全空白字符串经 `trim` 后判断。

### 路径规范化：URL 为中心，文件路径为锚
所有内部链接统一按 URL 语义规范化：移除多余斜杠、解析 `.` 和 `..`、按 `baseUrl` 拼接，再映射回文件系统。文件路径比较时区分大小写，但可在 Windows 环境下配置 `caseInsensitive` 模式。例外：锚点 `#section` 在文件存在性检查中剥离，但在锚点存在性检查中保留，后者默认关闭，因为不同渲染器对标题 ID 生成规则不同。

### 必填字段与继承规则
Schema 允许按节点类型定义必填字段，并支持“目录级默认值继承”。例如 `articles` 目录下所有条目继承 `category` 默认值。继承会降低重复，但引入循环依赖风险：若目录配置本身也是知识文件，需先校验目录配置再校验子项。实现时采用拓扑排序，目录节点优先。

### 全量校验与增量校验
CI 环境执行全量校验，确保全局一致性。本地开发支持增量：基于文件内容哈希和修改时间，只重新校验变更文件及其下游引用。取舍：增量提升速度，但遗漏被删除文件导致的 dangling link，因此每日或发布前必须回退到全量。

### 格式覆盖范围
核心仅支持 `.md`、`.mdx`、`.yaml`、`.json`。二进制资源（图片、PDF、视频）仅检查存在性、命名规范和引用关系，不解析内容。若项目使用其他格式（如 `.rst`、`.asciidoc`），通过插件接口扩展，插件需实现 `Parser` 和 `LinkExtractor` 接口。

## 可执行的实施流程

1. **初始化项目依赖**
   在 `packages/validator` 中安装 `zod`、`gray-matter`、`unified`、`remark-parse`、`remark-mdx`、`globby`、`fast-glob` 等库。将 `validator.ts` 作为入口。

2. **定义 Schema 与类型**
   用 Zod 编写 `schema.ts`，定义 `FrontmatterSchema`、`NodeType`、`FieldRule`。Schema 必须声明版本字段，例如 `schemaVersion: z.literal('1.2.0')`。

3. **加载文件并解析 frontmatter**
   遍历 `contentDir`，根据 `excludedGlobs` 过滤。对每个文件调用 `matter(fileContent)`，捕获 `empty` 或 `malformed` 异常，并记录行号。

4. **解析正文中的链接与引用**
   使用 `unified().use(remarkParse).use(remarkMdx)` 构建 AST，遍历节点提取 `link.url`、`image.url`、`mdxJsxAttribute` 中的路径值。收集到 `rawLinks` 列表。

5. **路径规范化与存在性检查**
   将 `rawLinks` 按 `baseUrl` 解析为绝对路径，检查目标文件是否存在。对目录引用补全 `index.md` 规则。记录 `PATH_NOT_FOUND`、`PATH_CASE_MISMATCH`、`PATH_TRAVERSAL_DENIED`。

6. **必填字段与类型校验**
   按节点类型取对应的 Zod Schema 执行 `safeParse`。缺字段时产出 `MISSING_REQUIRED_FIELD`，类型错误时产出 `TYPE_MISMATCH`，数组含空字符串时产出 `ARRAY_CONTAINS_EMPTY`。

7. **构建资源图与全局检查**
   将所有节点插入图，检查 `slug` 唯一性、related/parent 循环依赖、孤立必填引用。循环依赖检测使用 DFS，记录 `CIRCULAR_REFERENCE`。

8. **生成报告与错误分级**
   汇总所有 `ValidationResult`，按文件和严重等级排序。输出 JSON 报告、`pretty-print` 文本和 SARIF 可选格式。报告包含 `summary` 和 `details` 两层。

9. **集成发布门**
   在 GitHub Actions / GitLab CI 中增加 `validate` job，执行 `pnpm validate-content`。设置 `fail-on-error` 为 true。本地通过 `lint-staged` 仅校验提交文件。

10. **缓存与增量加速**
    使用 `.cache/validator` 目录存储文件哈希与结果。增量模式下先读取缓存，仅对变更文件及依赖图下游重新校验。每日夜间全量清理缓存。

## 示例：输入、处理与输出

以下示例展示一个基于 Next.js 内容目录的校验片段。输入是一份带 frontmatter 的 Markdown 文件和项目配置，处理阶段由校验器执行，输出是结构化的校验报告。

输入文件 `content/blog/typescript-frontmatter.md`：

    ---
    title: "规范校验实践"
    slug: "typescript-validation"
    date: "2024-11-09"
    category: "engineering"
    draft: false
    tags: ["okf", "validation", ""]
    related: ["non-existent-article"]
    ---

    本文介绍 [链接目标](/docs/okf/intro)。

    ![架构图](../../assets/arch.png)

处理阶段：

- frontmatter 解析：标题为字符串，slug 为合法 slug，date 可解析。
- 必填字段：author 在 Schema 中标记为 `required`，但此文件缺失。
- 数组字段：tags 包含空字符串，触发 `ARRAY_CONTAINS_EMPTY`。
- 链接解析：`/docs/okf/intro` 映射到 `content/docs/okf/intro.mdx`，文件存在，通过。
- 图片引用：`../../assets/arch.png` 解析为 `content/assets/arch.png`，文件存在，但相对路径中使用 `..` 在项目配置中不允许，触发 `PATH_TRAVERSAL_DENIED`。
- 关联引用：`related` 指向 `non-existent-article`，未找到，触发 `RELATED_TARGET_NOT_FOUND`。
- slug 唯一性：全局范围内无重复。

输出 JSON 报告摘要（节选）：

    {
      "status": "error",
      "schemaVersion": "1.2.0",
      "summary": {
        "totalNodes": 142,
        "error": 3,
        "warn": 0,
        "ok": 139
      },
      "details": [
        {
          "filePath": "content/blog/typescript-frontmatter.md",
          "line": 5,
          "field": "author",
          "code": "MISSING_REQUIRED_FIELD",
          "severity": "error",
          "message": "必填字段 author 缺失"
        },
        {
          "filePath": "content/blog/typescript-frontmatter.md",
          "line": 7,
          "field": "tags",
          "code": "ARRAY_CONTAINS_EMPTY",
          "severity": "error",
          "message": "tags 数组包含空字符串"
        },
        {
          "filePath": "content/blog/typescript-frontmatter.md",
          "line": 12,
          "field": null,
          "code": "PATH_TRAVERSAL_DENIED",
          "severity": "error",
          "message": "图片路径 ../../assets/arch.png 使用父级穿越"
        },
        {
          "filePath": "content/blog/typescript-frontmatter.md",
          "line": 6,
          "field": "related",
          "code": "RELATED_TARGET_NOT_FOUND",
          "severity": "error",
          "message": "related 目标 non-existent-article 不存在"
        }
      ]
    }

## 性能、质量和可观测性指标

1. **全量校验耗时**
   在 1000 个 Markdown 文件（平均 4 KB）的知识库上，目标耗时低于 2 秒。测量方式：CI 日志中 `validate` job 的 wall-clock 时间，排除安装依赖。

2. **缓存命中率**
   增量模式下目标命中率大于 80%。测量方式：统计缓存匹配文件数除以总文件数，输出在 `summary.cacheHitRate`。

3. **错误密度**
   每 1000 个非空白字符中致命或错误等级的数量。用于观察内容质量趋势。测量方式：报告 `summary.errorDensity`。

4. **误报率**
   人工审计每周抽取 50 条 warning/error，计算误报比例。目标低于 5%。测量方式：维护一份 `validator-audit.log` 并由编辑标注。

5. **发布阻塞率**
   因校验失败导致 CI 失败的发布尝试次数占总发布尝试次数的比例。目标低于 3%。测量方式：CI 平台统计。

6. **阶段延迟分解**
   分别记录 frontmatter 解析、AST 遍历、链接存在性、图检查四阶段耗时。测量方式：在报告中输出 `summary.stageTimings`，用于定位瓶颈。

## 失败模式、诊断证据与恢复动作

1. **必填字段缺失**
   诊断证据：报告出现 `MISSING_REQUIRED_FIELD`，`line` 指向文件首行或字段定义行。恢复：在 frontmatter 中补全字段；若该字段确实不适用于此类型，则调整 Schema 或节点类型。

2. **内部链接指向不存在文件**
   诊断证据：`LINK_TARGET_NOT_FOUND` 或 `RELATED_TARGET_NOT_FOUND`，`message` 含规范化后的目标路径。恢复：修正目标路径、移动文件、创建目标文件或删除失效链接。

3. **路径大小写不匹配**
   诊断证据：`PATH_CASE_MISMATCH`，目标文件存在但大小写与链接不一致。在 Linux CI 上更容易暴露。恢复：统一仓库内所有引用大小写，并启用 `strictPathCasing` 规则。

4. **frontmatter 类型错误**
   诊断证据：`TYPE_MISMATCH`，常伴随 Zod 详细错误，如 `Expected date, received string` 或 `Expected array, received object`。恢复：按 Schema 类型重写字段，必要时使用 Zod 预处理函数转换格式。

5. **循环依赖**
   诊断证据：`CIRCULAR_REFERENCE`，报告给出环路径如 `A -> B -> C -> A`。恢复：打破环，移除至少一条 `related`/`parent` 引用，或改用扁平标签替代层级关系。

6. **外部链接不可用**
   诊断证据：`EXTERNAL_LINK_UNAVAILABLE` 或 `EXTERNAL_LINK_TIMEOUT`。恢复：更新 URL、使用存档链接，或将该域名加入 `ignoredExternalDomains` 并在知识库中标注“外部链接状态未验证”。

## 问答测试样例

1. **正向问题**：如何校验 frontmatter 中的 `date` 字段？
   回答：使用 Zod 的 `z.coerce.date()` 或 `z.string().datetime()`，在字段校验阶段调用 `safeParse`，若解析失败则产出 `TYPE_MISMATCH` 并指出具体行号。

2. **边界问题**：文件被 `.gitignore` 排除，校验器是否仍扫描？
   回答：默认不扫描，因为 `excludedGlobs` 通常包含 `[".git", "node_modules", ".cache", "dist"]`。若被忽略文件属于发布产物（如 `dist` 中的生成页面），应单独配置第二套校验上下文。

3. **边界问题**：相对链接使用 `../` 是否允许？
   回答：默认不允许，会触发 `PATH_TRAVERSAL_DENIED`。但可通过 `allowPathTraversal: true` 开启，开启后仍要求目标文件存在，但不允许逃出 `contentDir` 根目录。

4. **无证据拒答**：外部链接检查应设置多长的超时？
   回答：无法从规范校验本身推断，需要结合 CI 网络环境和外部服务 SLA。建议先测量 95 分位响应时间，再设定一个固定阈值，并通过实验调整。

5. **正向问题**：如何检测 slug 重复？
   回答：在校验器构建全局 `ResourceGraph` 后，按 `slug` 分组，若出现多个节点指向同一 slug，则产出 `DUPLICATE_SLUG`，并列出所有冲突文件。

6. **边界问题**：空字符串是否通过必填字段校验？
   回答：不通过。必填字段校验对字符串执行 `trim()`，长度为 0 视为缺失；对数组检查长度且禁止空元素；对布尔值则必须显式为 `true` 或 `false`。

## 维护、版本、来源与相邻主题关系

校验器自身需要版本管理。`SchemaDeclaration` 包含 `schemaVersion`，校验器发布时声明兼容的 schema 版本范围。当 schema 升级时，必须提供迁移脚本：旧 frontmatter 文件可在 CI 中自动重写，或在报告中给出迁移指令。

错误码清单应维护在 `docs/validator-error-codes.md`，每次新增错误码需同步更新文档和测试用例。错误码一经发布，6 个月内不得变更语义，只能弃用并引入新码。

校验规则的来源主要包括：项目 AGENTS.md 中定义的内容约束、站点构建器（如 Next.js）对路径和 frontmatter 的硬性要求、以及团队约定的分类体系。规则变更应通过 Pull Request 进行，并在合并前跑通全量校验。

相邻主题包括：内容建模（定义节点类型和字段）、发布流水线（构建、部署、回滚）、权限控制（谁可以修改 Schema 和核心文档）、搜索索引（校验器发现的问题会影响索引质量）、以及知识生命周期（草稿、归档、删除）。规范校验与这些主题的关系是“守门者”而非“制定者”：它执行由其他主题定义的规则，并向上游反馈违规数据。

## 结论

事实：在 OKF-compatible 知识库中，发布前必须检查 frontmatter 结构、物理与逻辑路径一致性、内部链接可达性以及必填字段完整性；这些检查是可机械化、可重复、可报告的。

推论：将规范校验器嵌入 CI 的发布门前，并结合本地增量校验，可以显著降低因元数据或链接错误导致的构建失败和下游索引异常；Schema 版本化与错误码冻结能维持长期可维护性。

未知：不同平台（GitHub Pages、Vercel、Netlify、私有 Nginx）对 URL 大小写、尾部斜杠、锚点编码和 404 行为的具体处理存在差异，这些差异无法由通用校验器自动推断；项目必须根据自身托管目标配置路径比较规则。同样，外部链接的可用性受网络状态和反爬虫策略影响，无法保证 100% 准确。
