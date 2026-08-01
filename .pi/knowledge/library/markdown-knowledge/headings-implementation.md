---
type: concept
title: 标题层级：实现视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。用稳定的 H1 到 H3 结构帮助摘要、分块和导航
resource: .pi/knowledge/library/markdown-knowledge/headings-implementation.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, headings, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: headings
variant: implementation
---

# Markdown 知识库中的标题层级：用稳定 H1–H3 实现摘要、分块与导航

## 摘要与问题边界

在本地文件型 Markdown 知识库中，标题不仅是视觉格式，更是机器理解文档结构的主要入口。实现视角下的核心问题是：如何把不稳定、由作者自由书写的标题层级，约束成可被检索器稳定召回、可被 Agent 引用、可被导航组件消费的 H1–H3 结构。本文讨论的范围只涉及标题行本身的解析、校验、树化与输出，不涉及渲染样式、编辑器 UI、权限控制或向量嵌入算法本身。边界外的内容——例如把 H4 以下折叠为正文、允许 Setext 风格下划线标题——必须显式拒绝或降级，否则 downstream 的摘要、分块和导航都会出现漂移。

## 核心概念与数据模型

1. **文档（Document）**：一篇 Markdown 文件对应一个 Document，输入为原始字节流，必须先统一编码为 UTF-8 并剥离 BOM，输出为带有 `docId`、`title`、`headingTree`、`chunks` 的结构化对象。
2. **标题节点（HeadingNode）**：`{ level: 1|2|3; text: string; slug: string; lineStart: number; lineEnd: number; children: HeadingNode[] }`。`level` 不允许出现 0 或 4 及以上，出现即视为解析错误。
3. **层级（HeadingLevel）**：严格枚举 `H1 | H2 | H3`。H1 是文档主题，H2 是主题下的分块，H3 是具体可执行单元。超过三层的语义应通过列表或段落表达，而不是标题。
4. **锚点（Anchor/Slug）**：由标题文本按固定规则生成的 URL-safe 标识，规则包括小写、去重音、空格与特殊符号替换为连字符、禁止纯数字开头。slug 必须在同文档内唯一。
5. **分块（Chunk）**：以 H2 或 H3 为起点的文本区间，包含自身的标题、正文和子节点引用。Chunk 是向量化与召回的最小单元；H1 不单独成块，而是作为整篇文档的元数据。
6. **校验规则（ValidationRule）**：包括层级连续性规则（不允许 H3 紧跟 H1）、H1 唯一性规则、slug 唯一性规则、空标题规则、前后空白规则。每条规则都有对应的错误码和行号。

## 设计决策与取舍

### 为什么把层级上限固定在 H3

把深度限制为三层，是因为检索器在召回时通常只需要“文档—主题—要点”三级定位。四级及以上会让导航树过深，且作者容易把应该作为列表项的内容误写成标题。例外：如果某些旧文档已经存在 H4，解析器不应崩溃，而是把 H4 及其正文合并到上一级 H3 的 chunk 正文中，并在校验报告中标记 `WARN_LEVEL_CAPPED`。

### H1 唯一性还是允许多个

每个 Document 必须且只能有一个 H1。多个 H1 会导致摘要模型无法判断主主题，也会让导航根节点歧义。边界情况：YAML frontmatter 中的 `title` 字段不算 H1；如果文档完全没有 H1，则使用文件名（去掉扩展名）作为派生 H1，并产生 `WARN_MISSING_H1`。这一决策牺牲了部分作者的自由排版习惯，换取了下游导航和检索的一致性。

### ATX 语法优先，禁用 Setext

实现上只支持 ATX 形式的 `#`、`##`、`###`，不支持 Setext 下划线标题。原因是 Setext 只区分两级，且下划线长度容易与分隔线混淆，增加解析二义性。如果输入中出现 Setext，直接视为普通段落，不解析为标题，避免隐式语义变更。

### slug 稳定性优先于可读性

slug 生成规则必须版本化并写入配置。相同文本在不同版本生成的 slug 必须一致，否则已有链接和引用会断裂。当标题文本变更时，旧 slug 不会自动继承；系统会生成新 slug，同时允许作者在 frontmatter 中声明 `aliases` 来保留旧锚点。这种显式迁移比隐式兼容更安全。

### 严格校验与降级解析的边界

解析阶段采用“严格校验 + 有报告降级”。不可恢复的错误——如 H0、层级跳变超过一级、slug 冲突——必须阻塞 pipeline，返回 `VALIDATION_ERROR`。可恢复的问题——如缺少 H1、H4 越界、标题末尾多余空格——可以生成警告并继续，但必须在输出对象的 `diagnostics` 数组中保留行号和修复建议。

## 可执行的实施流程

1. **输入验收**：接收原始文件字节、相对路径、最后修改时间。检测编码，若不是 UTF-8 则转码；若存在 BOM 则剥离；若文件超过设定大小阈值，则拒绝解析并返回 `ERROR_FILE_TOO_LARGE`。
2. **词法扫描**：逐行扫描，只识别 `^#{1,3}\s+` 模式的 ATX 标题行，记录行号、原始文本、`#` 数量。忽略代码块、YAML frontmatter、HTML 注释中的伪标题。
3. **层级校验**：检查标题层级序列。若出现 `H1 → H3`，返回 `ERROR_SKIPPED_LEVEL`；若出现 `H3 → H1`，返回 `ERROR_LEVEL_REGRESSION`；H1 数量大于 1，返回 `ERROR_MULTIPLE_H1`。
4. **slug 生成与冲突检测**：按固定规则为每个标题生成 slug，若两个不同文本生成相同 slug，返回 `ERROR_DUPLICATE_SLUG`；若 slug 为空或全为数字，返回 `ERROR_INVALID_SLUG`。
5. **构建标题树**：使用栈结构把扁平标题序列转换为嵌套树。输出根节点为派生或真实 H1，H2 挂到 H1 下，H3 挂到最近的 H2 下。若 H3 前无 H2，则返回 `ERROR_ORPHAN_H3`。
6. **分块切割**：以 H2 和 H3 为边界把正文切成 chunk。每个 chunk 的输入是标题行到下一同级或更高级标题行之间的文本；输出包含 `chunkId`、`headingSlug`、`body`、`wordCount`、`lineRange`。
7. **生成导航与摘要**：遍历标题树，输出导航 JSON，包含可折叠层级和锚点链接。摘要模块可基于 H1 和 H2 文本生成一级摘要，基于 H3 生成要点列表。
8. **持久化与索引**：把结构化对象写入知识库存储，更新文档索引、标题反向索引和 chunk 向量索引。写入前再次校验输出 schema，失败则回滚并返回 `ERROR_PERSISTENCE_SCHEMA`。
9. **生命周期收尾**：记录解析耗时、错误数、警告数；关闭文件句柄；触发可观测事件 `document.parsed`，供检索器和 Agent 订阅。

## 贴近本地文件知识库的 TypeScript 示例

```ts
// 输入
const input = {
  path: 'docs/api/auth.md',
  content: '# 认证\n## JWT 令牌\n### 签发\n内容A\n### 校验\n内容B\n',
};

// 处理
const doc = parseMarkdown(input);   // 词法扫描 + 校验
const tree = buildHeadingTree(doc); // 构建 H1->H2->H3 树
const chunks = splitChunks(tree);   // 按 H2/H3 分块

// 输出
const output = {
  docId: 'docs/api/auth.md',
  title: '认证',
  headingTree: tree,
  chunks: [
    { chunkId: 'auth-jwt-issue', headingSlug: '签发', body: '内容A' },
    { chunkId: 'auth-jwt-verify', headingSlug: '校验', body: '内容B' },
  ],
  diagnostics: [],
};
```

输入是文件路径和原始 Markdown 字符串；处理阶段完成解析、校验、树化和分块；输出包含结构化标题树、chunk 列表和诊断信息。`chunkId` 由父级 slug 与自身 slug 组合生成，保证在文档内唯一且可追踪。

## 性能、质量与可观测性指标

1. **端到端解析延迟**：单篇文档从输入到输出对象生成的时间，目标 P99 低于 50ms。可在 `parseMarkdown` 前后打 `performance.now()` 并上报到 metrics。
2. **校验失败率**：被阻塞文档数 / 总文档数，按错误码分组。若 `ERROR_SKIPPED_LEVEL` 超过 5%，应回查作者模板或提示词。
3. **孤儿 chunk 比例**：没有对应 H2/H3 边界的正文占比。通过 chunk 数量与正文行数比值测量，异常高说明标题结构退化。
4. **标题层级熵**：统计 H1:H2:H3 数量分布，理想比例接近 1:n:2n。偏离过大意味着文档结构失衡。
5. **导航链接点击率**：在 Web 前端监听锚点点击事件，评估生成的 slug 是否被用户实际使用，作为 slug 规则可读性的间接指标。
6. **召回命中率**：在 Agent 问答中，检索器依据 heading slug 召回的 chunk 被判定为相关的比例，每两周抽样审计。

## 失败模式、诊断证据与恢复动作

1. **重复 H1**：诊断证据为 `ERROR_MULTIPLE_H1` 和多个行号。恢复动作是保留第一个 H1，把后续 H1 降级为 H2，并提示作者修正源文件。
2. **层级跳变**：诊断证据为 `ERROR_SKIPPED_LEVEL`，例如 H1 后直接 H3。恢复动作是拒绝解析，除非配置开启 `allowAutoPromote`，此时把 H3 临时视为 H2 并发出警告。
3. **slug 冲突**：诊断证据为 `ERROR_DUPLICATE_SLUG`，常见于标题“实现”与“实现细节”。恢复动作是在第二个 slug 后追加 `-2`、`-3`，同时在 frontmatter 记录别名映射。
4. **H4 及以下标题**：诊断证据为 `WARN_LEVEL_CAPPED` 和行号。恢复动作是把 H4 文本加粗为段落，保留在上一级 chunk 内，不进入标题树。
5. **缺失 H1**：诊断证据为 `WARN_MISSING_H1`。恢复动作是用文件名生成派生 H1，同时在输出中标记 `titleDerived: true`，提醒作者补充主题标题。
6. **代码块内伪标题**：诊断证据为标题被识别但行号落在代码块范围内。恢复动作是在扫描阶段维护 `inCodeBlock` 状态，忽略块内 `#` 行，避免把示例代码误判为结构标题。

## 问答测试样例

1. **正向**：文档有 `# 部署`、`## 服务端`、`### 容器化`，问“容器化属于哪个主题？”应返回“属于部署主题下的服务端主题”。
2. **正向**：文档 H1 唯一且 slug 为 `bu-shu`，问“这篇文档的锚点是什么？”应返回 `bu-shu`。
3. **边界**：文档只有 H2 没有 H1，问“文档主题是什么？”应返回派生 H1 即文件名，并说明是派生而非作者显式标题。
4. **边界**：H2 后直接出现 H3 再出现 H2，验证树是否正确挂接，应返回最近父级匹配，无 orphan。
5. **边界**：两个 H3 标题文本相同，问它们的 slug 是否一致，应返回不一致，第二个带有数字后缀。
6. **拒答**：用户问“H4 标题在导航中如何显示？”如果没有配置 `allowLevelCap`，应回答“本文档系统不支持 H4 作为导航节点，H4 会合并到上级 chunk 正文”。
7. **拒答**：用户问“Setext 下划线标题如何解析？”若实现禁用 Setext，应回答“本实现不将 Setext 解析为标题，它会被视为普通段落”。

## 维护、版本、来源与相邻主题

标题解析规则应随项目版本发布。`slugRuleVersion` 写入每个输出对象，便于旧文档在历史 slug 上的兼容。来源信息记录原始文件路径、Git commit hash 和最后修改时间，保证可追溯。相邻主题包括 Markdown 分块策略、YAML frontmatter 解析、向量嵌入与召回排序；本文档的标题树是这些模块的上游输入，但不负责具体的嵌入模型选择或搜索评分。当相邻模块需要更细粒度时，应由 chunk 再拆分，而不是放宽 H1–H3 的层级限制。

## 结论

**事实**：H1–H3 是 Markdown 知识库中足以表达“主题—分块—要点”的最小稳定结构；ATX 语法比 Setext 更易于无歧义解析；slug 在同一文档内必须唯一且规则版本化。

**推论**：把解析器严格限制在 H1–H3、强制 H1 唯一、按固定规则生成 slug，并配合显式降级与诊断报告，可以显著提升检索器召回稳定性和 Agent 引用准确率。

**未知**：不同知识库领域中，作者对“深层嵌套”的实际需求分布尚未量化；H4 以下标题在多大比例上确实承载不可替代的结构语义，需要基于真实语料进一步审计后才能决定是否调整深度上限。
