---
type: concept
title: 多语言内容：实现视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。保持术语映射、数字和条件一致，而不是逐句机械翻译
resource: .pi/knowledge/library/markdown-knowledge/translation-implementation.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, translation, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: translation
variant: implementation
---

# 多语言 Markdown 知识库：在 TypeScript 实现中保持术语、数字与条件一致性

## 摘要与问题边界

当本地 Markdown 知识库（例如 `.pi/knowledge` 或 `docs/` 下的文档树）需要同时面向中文、英文、日文读者时，最危险的实践是先把源语言逐句翻译成目标语言，再直接发布。逐句翻译会让同一领域概念在两种语言中失去唯一映射，例如 `shard` 在日文里被分别写成「シャード」「分割片」「データ片」；会把数字四舍五入或单位改写，例如把 `1,234.56 ms` 译成 `1.2 秒`，导致阈值失效；会把条件语句 `user.plan === 'pro'` 译成「如果用户计划等于专业版」，结果运行时无法匹配变量值。

因此，本方案的边界是：只处理**静态 Markdown 知识内容**的多语言视图，不处理运行时 UI 字符串，也不引入机器翻译流水线。输入是源语言 Markdown、术语表、语言清单和本地化覆盖层；输出是每门语言的 Markdown 视图、一致性校验报告和版本同步令牌；在编码之前必须先完成输入校验、错误边界定义、生命周期约定和验证步骤。

## 核心概念与数据模型

1. **LocaleTag**：采用 BCP-47 格式，例如 `zh-Hans`、`en`、`ja`，并允许项目变体 `zh-Hans@proj`。所有目录名、校验键、排序规则都以该标签为准，避免用 `cn` 或 `jp` 这种非标准简写。
2. **CanonicalChunk**：把源 Markdown 按标题层级切分为原子块。每个块拥有稳定的 `chunkId`，例如 `c-arch-overview`，内容包含原始文本、条件表达式、数字字面量和术语引用。块是增量更新、缺失检测和回退的最小单位。
3. **TermEntry**：术语表条目以 `conceptId`（例如 `concept:shard`）为主键，记录源语言术语、目标语言术语、词性、生效范围（scope）和译者注释。术语表不是普通词典，而是领域词汇，同一 `conceptId` 在任何语言中只能对应一个术语。
4. **NumericLiteral**：记录数值的规范字符串（例如 `"1234.56"`）、单位（`ms`/`GiB`）和每门语言的显示格式模板。规范值不参与本地化，只用于一致性校验；显示层可以按语言换成全角数字或千分位，但值不可变。
5. **ConditionalExpression**：条件节点在源语言中定义，例如 `user.plan === 'pro'`。本地化文件只提供条件别名映射（`pro → 专业版`），不重新实现逻辑。运行时求值始终使用源语言表达式。
6. **ValidationReport**：每门语言生成一份报告，列出缺失的 chunk、术语缺失、数值不一致、未解析条件别名、chunk ID 漂移和回退触发次数。报告是 CI 阻塞发布还是仅告警的依据。
7. **SyncToken**：由源文件 git 哈希、修改时间、术语表校验和、语言清单校验和组合而成的字符串。任何输出文件都必须携带该令牌，供 Web 端判断缓存是否过期。
8. **OverlayFile**：每门语言只存储与源语言有差异的 chunk 文件。文件名与 canonical `chunkId` 一致，内容只包含需要覆盖的文本段。overlay 不是独立文档，而是差异层。

## 设计决策与取舍

### 1. 源语言优先于各语言平行
源语言 Markdown 是 canonical；其他语言只存储差异。取舍是译者不能重新组织结构，但 chunk ID、数字、条件和术语引用不会在不同语言间发散。例外：如果源语言本身需要重构，则所有 overlay 必须同步重新对齐。

### 2. 术语表优先于机器翻译
每句话不自动翻译，而是通过 `conceptId` 替换术语。取舍是初始化成本更高，需要维护者显式维护 `terms.yaml`，但 Agent 检索时可以按 `conceptId` 召回跨语言同义内容，且校验器可以精确检测术语缺失。

### 3. 条件在源语言中单一求值
运行时只解析源语言条件表达式；本地化只替换展示标签。取舍是某些语言的条件语序无法完全贴合，例如中文习惯先说结果再说条件，但逻辑不会出错。例外：当条件变量本身是语言相关字符串（如枚举显示名）时，必须由代码层映射，不能交给 Markdown 层。

### 4. 数值以字符串保存，Decimal 对象运算
JSON 中只存规范字符串；计算时转换为 `Decimal` 或任意精度库。取舍是序列化简单，但校验器必须能识别不同语言数字字符，如阿拉伯数字、全角数字、印度-阿拉伯数字。例外：科学计数法、百分比和区间必须显式标注，不能依赖解析器推断。

### 5. chunk 级差异而非全文差异
按 chunk 对比，便于定位缺失和增量更新。取舍是元数据增多，需要稳定的 chunk ID 生成规则，但维护者能精确知道哪一段被删除或新增。例外：如果 chunk 内部结构调整（拆分合并），ID 生成规则必须重新运行并生成迁移报告。

### 6. 严格回退到源语言
若目标语言缺少某个 chunk，直接回退到源语言并标记警告。取舍是读者可能看到混合语言，但避免内容静默丢失。例外：如果语言清单声明该语言为「完整」且不允许回退，则缺失 chunk 应直接阻塞发布。

### 7. 校验报告驱动 CI 阻塞
存在 error 级别问题时构建失败。取舍是发布节奏变慢，但发布产物始终可验证。例外：在本地开发或预览分支可以降级为 warning，正式上线前必须清零。

## 可执行的实施流程

1. **初始化语言清单**：创建 `locales.json`，声明 `canonical: "en"`，列出所有允许的语言标签。该文件同时作为 Web 端语言下拉框和 CI 校验的白名单。
2. **定义术语表**：编写 `terms.yaml`，为每个 `conceptId` 提供多语言条目。初始化时必须校验同一 `conceptId` 在项目内唯一，且不存在同义词多键映射。
3. **切分 canonical chunk**：使用稳定规则把源 Markdown 拆成 chunk。每个 `#` 标题下的段落作为一个 chunk，直到下一个同级或更高级标题；`chunkId` 由相对路径 + 标题 slug 生成，确保重排后 ID 不变。
4. **创建本地化覆盖层**：为每个目标语言建立 `overlays/<locale>/` 目录。只把需要翻译的 chunk 放入其中，文件名与 canonical `chunkId` 一致；不需要翻译的数学公式、代码片段可留白并走回退。
5. **构建 canonical AST**：在 TypeScript 中把 Markdown 解析为节点，识别 `TermNode`、`NumberNode`、`ConditionalNode`。AST 只保留语义节点，不保留原始空白格式。
6. **实现本地化转换器**：遇到 `TermNode` 时查 `terms.yaml`；遇到 `NumberNode` 时用规范值和该语言格式模板生成显示文本；遇到 `ConditionalNode` 时只替换别名，不改动变量名和运算符。
7. **实现一致性校验器**：比较源 AST 与本地化 AST 的 chunk 集合、数字规范值、条件变量名、术语引用数量。任何差异都写入 `ValidationReport`。
8. **生成输出产物**：把本地化 AST 序列化为 Markdown 到 `dist/<locale>/`，同时把源语言版本输出到 `dist/canonical/`。序列化后必须再次与源 AST 做 round-trip 校验。
9. **生成校验报告与 CI 决策**：生成 `ValidationReport` 并写入 `reports/<locale>.json`；如果存在 error 级别问题，CI 构建失败。warning 级别可接受但需计入指标。
10. **计算并注入 SyncToken**：计算 `SyncToken` 并注入每个输出文件的 HTML/Markdown 注释中。Web 端读取该令牌判断缓存是否失效；如果源文件或术语表更新，令牌必须重新生成。

## 贴近 TypeScript 的示例

下面的示例展示一个 `NumberNode` 从输入到输出的完整生命周期：

<pre>
type LocaleTag = "en" | "zh-Hans" | "ja";

interface NumberNode {
  type: "NumberNode";
  id: "n-latency-p99";
  // 输入：源 AST 中的数字节点
  // 规范字符串，不随语言变化
  value: "1234.56";
  unit: "ms";
  format: {
    en: "#,##0.00 ms";
    "zh-Hans": "#,##0.00 毫秒";
    ja: "#,##0.00 ms";
  };
}

function renderNumber(node: NumberNode, locale: LocaleTag): string {
  // 处理：使用规范值格式化，不重新解析本地化文本
  const d = new Decimal(node.value);
  const fmt = node.format[locale] ?? node.format["en"];
  return formatWithUnit(d, fmt);
}

// 输出：en 为 "1,234.56 ms"
// 输出：zh-Hans 为 "1,234.56 毫秒"
// 输出：ja 为 "1,234.56 ms"
</pre>

输入是规范字符串与格式模板；处理时始终从规范值出发，使用任意精度运算；输出是目标语言的显示字符串，但底层值不变。校验器会反向解析显示文本，确认其数值等于 `node.value`。

## 性能、质量和可观测性指标

1. **Chunk 覆盖率**：每门语言已翻译的 chunk 数量除以 canonical chunk 总数。从 `locales.json` 和 `overlays/` 清单直接统计，低于 95% 时触发补充翻译任务。
2. **术语表命中率**：chunk 中引用的术语被 `terms.yaml` 命中的比例。低于 80% 时说明领域词汇不准确或不完善，需要维护者补充。
3. **数值一致通过率**：`1 - numericMismatchCount / totalNumberNodes`。校验报告按 AST 节点统计，目标是 100%，任何失败都视为 error。
4. **条件别名解析率**：`resolvedAliasCount / totalAliasSlots`。未解析别名必须为零才能发布；否则运行时会出现逻辑与显示不一致。
5. **校验耗时**：生成 `ValidationReport` 的平均时间，使用 `process.hrtime` 或 `performance.now` 记录。应随 chunk 数量线性增长，若出现超线性增长说明 AST 遍历存在重复计算。
6. **回退触发次数**：发布文件中带有 `fallback` 标记的 chunk 数量。数量高说明本地化不完整；长期非零需要重新评估语言清单或翻译计划。

## 失败模式与诊断

1. **未知 chunk ID**：overlay 目录中出现 canonical 中不存在的 `chunkId`。诊断证据是 `ValidationReport.unknownChunkIds` 非空。恢复动作：删除该 overlay 文件或将其标记为 `deprecated`，并重新运行校验。
2. **数值不一致**：本地化文本中的数字与规范值不同，例如把 `1234.56` 误写成 `1234.5`。诊断证据：反向解析本地化文本后的数值与 `node.value` 不相等。恢复动作：用规范值重新格式化，禁止手工编辑本地化数字。
3. **术语键冲突**：两个 `TermEntry` 使用同一个 `conceptId` 但指向不同翻译。诊断证据：构建 `terms.yaml` 时 Map 键重复。恢复动作：按 scope 拆分，例如 `db:shard` 与 `ui:shard`。
4. **条件变量缺失**：本地化别名映射引用了 canonical 中不存在的变量。诊断证据：AST 比较时 `conditionalVariables` 集合不相等。恢复动作：只保留 canonical 已声明的变量别名，删除多余别名。
5. **语言清单漂移**：源文件已修改但 `SyncToken` 未更新。诊断证据：文件 mtime 与 manifest 中记录不一致。恢复动作：重新运行完整校验与发布流程，并刷新 Web 缓存。
6. **回退导致混合语言**：发布产物中同时出现源语言与目标语言。诊断证据：`fallback` 标记数量大于 0。恢复动作：补充缺失 chunk 翻译，或在语言清单中明确允许该降级。

## 问答测试样例

1. **正向问题**：在日语版本中，“1,234.56 ms” 的底层规范值是什么？**答案**：规范值为 `"1234.56"`，显示格式由 `ja` 模板决定。
2. **正向问题**：如何将 `pro` 计划显示为中文？**答案**：术语表 `conceptId: plan-pro` 映射为“专业版”，条件求值仍使用变量 `pro`。
3. **边界问题**：某个 chunk 没有中文 overlay 时如何显示？**答案**：回退到源语言，并在 `ValidationReport` 中记录缺失警告。
4. **边界问题**：术语表未覆盖 `shard` 时怎么办？**答案**：保留源语言术语 `shard`，校验报告标记 `missingTerm: shard`。
5. **无证据拒答**：本系统是否使用机器翻译？**答案**：没有证据表明启用机器翻译；默认实现仅读取人工 overlay 和术语表。
6. **无证据拒答**：法语版本是否存在？**答案**：若 `locales.json` 未包含 `fr` 且 `overlays/fr/` 不存在，则无法确认其存在，应拒绝回答。

## 维护、版本、来源和与相邻主题的关系

维护工作集中在三个文件：`locales.json` 管理语言清单，`terms.yaml` 管理术语表，`overlays/` 目录管理本地化覆盖。版本控制使用 Git 管理这些源文件；运行时通过 `SyncToken` 判断缓存是否失效，而不是通过文件时间戳。来源的真相是源语言 Markdown 与术语表，任何发布产物都应在 CI 中重新生成，不能手工修改 `dist/`。

与本主题相邻但不同的主题包括：运行时 UI 国际化（例如 `react-i18next` 或 Vue I18n，处理动态字符串和界面文案）、翻译记忆库（管理句子片段复用，偏向译者工具）、Markdown 静态站点生成（负责渲染、导航、主题，不负责多语言语义一致性）。本方案位于它们之间，专注于知识内容的语义一致性，尤其强调术语映射、数字不变和条件逻辑在跨语言视图中的一致性。

## 结论

**事实**：源语言 Markdown 是唯一的真相源；术语表、数字规范值、条件节点都以源语言为准；本地化文件只是 overlay；校验报告通过 `ValidationReport` 与 `SyncToken` 保证可观测性。

**推论**：以 chunk 为粒度、以术语为锚点的实现方式，能够显著降低数字与条件在多语言视图之间的漂移；强制回退到源语言比静默缺页更安全，因为缺失内容至少是可被观察到的。

**未知**：对于任意复杂 Markdown 的 chunk 切分规则是否在所有项目中都保持稳定；长期人工维护术语表的成本是否可接受；在 Web 端缓存 `SyncToken` 时真实用户的刷新频率与缓存失效策略之间的平衡。
