---
type: concept
title: Frontmatter：实现视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。用稳定字段描述 concept 类型、标题、资源、标签和状态
resource: .pi/knowledge/library/okf-governance/frontmatter-implementation.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, frontmatter, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: frontmatter
variant: implementation
---

# OKF 概念 Frontmatter：实现视角下的稳定字段设计与验证

## 摘要与问题边界

在基于 Markdown 的 OKF 知识库中，每个概念（concept）都必须通过文件顶部的 YAML Frontmatter 暴露机器可读的元数据。本文讨论的不是“如何写好一篇文档”，而是“在 TypeScript 实现中，如何把这些元数据解析、验证、索引、供 Agent 召回”。问题边界被限定为：单一仓库内的本地 Markdown 文件（例如 `.pi/knowledge`、`docs/` 或 `apps/*/docs/`），不依赖外部 CMS 或远程数据库；字段范围限定在概念类型、标题、资源、标签和状态这五类核心描述；目标是让搜索器、Agent 工具链和类型系统都能一致地消费这些字段。

## 核心概念与数据模型

1. `concept_type`：枚举字段，当前项目限定为 `adr`、`skill`、`pattern`、`term`、`reference`、`guide` 六个值。任何不在枚举内的值都会在验证阶段被标记为错误，而不是静默降级为字符串。
2. `id`：全局稳定的机器标识符，使用 kebab-case，只能包含小写字母、数字和连字符，最大长度 64 个字符。`id` 必须与文件路径无关，因为文件重命名或目录迁移不应改变概念的同一性。
3. `title`：人类可读标题，纯字符串，长度 1–120 个字符，允许 Unicode 但不允许首尾空白。标题不用于生成 URL，因此可以包含空格和标点。
4. `version`：逻辑版本号，遵循 `x.y.z` 语义化格式。它不代表 Git 提交号，而是概念内容的协议版本，用于 Agent 判断引用是否过期。
5. `status`：生命周期状态，枚举为 `draft`、`stable`、`deprecated`、`archived`。状态转换是单向的，除 `draft` 可以反复进入 `stable` 外，`stable → deprecated → archived` 不可逆。
6. `tags`：标签数组，元素必须是小写、无空格、长度不超过 32 的字符串。系统会执行 `tag.trim().toLowerCase().replace(/\s+/g, '-')` 的规范化，但不会自动纠正语义错误。
7. `resources`：资源引用数组，每个元素包含 `href` 和 `rel`。`href` 可以是仓库相对路径（如 `./adr-0001-monorepo.md`）或 HTTPS URL；`rel` 枚举为 `self`、`related`、`source`、`example`。
8. `source`：来源字段，记录该概念的知识来源或归属文件，可以是仓库内相对路径或外部链接。它用于追踪内容溯源，但不参与索引主键。
9. `depends_on`：可选的依赖数组，元素为其他概念的 `id`。系统会在索引阶段进行引用完整性检查。
10. `created_at` / `updated_at`：ISO 8601 日期字符串，用于版本排序和失效检测。`updated_at` 不等于 Git 提交时间，而是内容作者主动声明的修改时间。
11. `extra`：保留给项目自定义扩展的字段。默认严格模式下未知字段会触发警告；若开启 `allowExtra` 模式，则仅记录而不报错。

## 设计决策与取舍

### 1. YAML 优先，而非 JSON 或 TOML
YAML Frontmatter 是 Markdown 生态的事实标准，作者无需离开 Markdown 编辑器即可维护元数据。代价是解析器必须处理引号、多行字符串和缩进错误。项目选择 `js-yaml` 并开启严格模式，禁止隐式类型转换。

### 2. 字段严格，但扩展可控
核心字段是固定的，这是为了避免不同作者用不同键名描述同一含义。但允许通过 `extra` 字典注入项目专属字段，避免每次业务变更都修改全局模式。

### 3. `id` 与文件路径解耦
早期方案曾用相对路径作为主键，但目录重构会导致概念 URL 变化。最终采用显式 `id`，文件路径仅作为 `source` 的默认值；`id` 一旦写入就不应更改。

### 4. 状态机保护生命周期
状态字段不是自由文本，而是受控枚举。这是为了在前端、Agent 和搜索排序中统一判断“能否引用”。例如 `archived` 的概念不应出现在推荐结果中，但不应被物理删除。

### 5. 资源引用不强制可达性
验证阶段只检查 `href` 格式（相对路径或 HTTPS），不执行网络请求或文件存在性检查。因为 CI 环境可能缺失部分外部资源。可达性检查由单独的链接检查任务在构建阶段完成。

### 6. 标签不做强制词表
项目没有维护全局受控词表，因为知识领域会不断扩展。系统只负责规范化大小写和空格，语义一致性由作者评审和代码审查保证。

### 7. 版本号与 Git 提交分离
`version` 是概念内容的协议版本，不是 Git 版本。这样同一 Git 提交中可以批量升级多个概念的版本，也可以让单个概念保持旧版本号。

## 可执行的实施流程

1. 使用 `pnpm add js-yaml zod` 引入解析与校验依赖。
2. 在 `packages/pi-agent` 中定义 `ConceptFrontmatter` Zod 模式。
3. 实现 `scanConceptFiles(rootGlob: string): string[]`，扫描所有 `.md` 文件。
4. 实现 `extractFrontmatter(content: string): unknown`，用 `js-yaml.load` 解析 `---` 之间的内容。
5. 用 Zod 模式进行结构验证，收集错误列表。
6. 对 `id` 做唯一性检查：构建 `Map<id, filePath>`，发现重复立即报错。
7. 对 `depends_on` 做引用完整性检查：确保每个依赖的 `id` 在索引中存在。
8. 将验证通过的对象转换为 `ConceptRecord` DTO，包含原始文件路径和解析后的元数据。
9. 写入内存索引（`Map<id, ConceptRecord>`），供 `search_knowledge` 工具使用。
10. 在 `apps/api` 暴露 SSE 端点，将索引注册到 Agent 会话中。
11. 在 CI 中运行 `pnpm typecheck && pnpm tsx scripts/validate-concepts.ts`，失败即阻止合并。

## TypeScript 实现示例

```ts
import { z } from 'zod';
import { load } from 'js-yaml';
import { readFileSync } from 'fs';

const ConceptStatus = z.enum(['draft', 'stable', 'deprecated', 'archived']);
const ResourceRel = z.enum(['self', 'related', 'source', 'example']);

const ConceptFrontmatter = z.object({
  concept_type: z.enum(['adr', 'skill', 'pattern', 'term', 'reference', 'guide']),
  id: z.string().max(64).regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: ConceptStatus,
  tags: z.array(
    z.string().max(32).regex(/^[^\s]+$/).transform(t => t.toLowerCase())
  ).max(16),
  resources: z.array(
    z.object({
      href: z.string().min(1),
      rel: ResourceRel
    })
  ).max(32),
  source: z.string().optional(),
  depends_on: z.array(z.string()).max(64).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
  extra: z.record(z.unknown()).optional()
});

// 输入：本地 Markdown 文件
const raw = readFileSync('docs/adr/0001-monorepo.md', 'utf8');
const yamlBlock = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';

// 处理：解析 + 验证
const parsed = load(yamlBlock);
const record = ConceptFrontmatter.parse(parsed); // 失败时抛出 ZodError

// 输出：可被 Agent 召回的结构化记录
const conceptRecord: z.infer<typeof ConceptFrontmatter> = {
  ...record,
  tags: record.tags.map(t => t.replace(/\s+/g, '-'))
};
```

**输入**是仓库中的 Markdown 文件，顶部包含 YAML 块；**处理**是正则提取 YAML、解析、模式校验与规范化；**输出**是类型安全的 `conceptRecord`，可直接进入索引并参与 Agent 工具调用。

## 性能、质量与可观测性指标

1. **索引构建耗时**：扫描 1000 个 Markdown 文件并完成解析+验证的 Wall Time，目标 < 2 秒。测量方式：CI 中打印 `Date.now()` 差值。
2. **验证通过率**：通过文件数 / 总文件数。目标 ≥ 98%；未通过的必须产生可定位的 `file:line` 错误。
3. **重复 `id` 数量**：索引构建后检查，目标为 0。测量方式：统计 `Map<id, string[]>` 中长度 > 1 的键。
4. **悬垂依赖比例**：`depends_on` 中指向不存在的 `id` 的数量 / 总依赖数。目标为 0，测量在引用完整性检查阶段完成。
5. **标签熵值**：不同标签的数量与总标签数的比值，用于评估标签是否过度集中。可通过简单集合统计计算。
6. **Agent 召回准确率**：在固定问答测试集上，Agent 是否返回了与预期 `id` 一致的概念。通过 `pnpm test` 中的快照测试测量。

## 失败模式

1. **YAML 语法错误**：未闭合的引号或多行缩进错误。诊断证据：`js-yaml` 抛出 `YAMLException` 并带行列号。恢复动作：人工修复 Frontmatter 语法。
2. **`id` 重复**：两个文件声明相同 `id`。诊断证据：索引 Map 中同一键对应多个路径。恢复动作：保留权威文件，另一文件修改 `id` 并更新引用。
3. **缺少必填字段**：例如 `concept_type` 缺失。诊断证据：Zod 错误报告 `required`。恢复动作：补充字段或降级文件为草稿附件（不进入概念索引）。
4. **资源 `href` 为空字符串**：模式校验通过但内容无意义。诊断证据：资源数组中存在 `href.length === 0`。恢复动作：删除该资源对象或补充有效链接。
5. **非法状态转换**：例如把 `archived` 改回 `stable`。诊断证据：生命周期状态机检查失败。恢复动作：新建版本号并重新发布，而非直接回退旧概念。
6. **标签含空格**：如 `tags: ["web app"]`。诊断证据：正则 `^[^\s]+$` 不匹配。恢复动作：自动替换为空格为连字符，并记录警告。
7. **`depends_on` 指向已删除概念**：诊断证据：索引中找不到目标 `id`。恢复动作：移除依赖、更新依赖指向新 `id`，或恢复被删除概念。

## 问答测试样例

1. **正向**：`id` 字段是否必须？
   答：是。`id` 是概念的全局主键，缺失时 Zod 校验会在具体文件抛出 `Required` 错误。

2. **边界**：`title` 是否允许为空字符串？
   答：不允许。`min(1)` 校验会拒绝，且 Agent 无法为空标题生成可引用的摘要。

3. **边界**：`resources` 中的相对路径是否指向仓库根目录？
   答：相对路径从 Markdown 文件所在目录解析，而不是仓库根目录。这是为了兼容 `docs/` 子目录结构。

4. **无证据**：OKF 规范是否要求 `created_at` 必填？
   答：项目中 `created_at` 是可选字段；如果没有明确配置，不能断言它为必填。

5. **正向**：`status` 为 `deprecated` 的概念是否还能被索引？
   答：能。索引包含它，但搜索排序和 Agent 推荐应降低其权重，或显式过滤。

6. **边界**：标签可以包含中文字符吗？
   答：可以，只要不包含空格且长度不超过 32 个字符。规范化仅涉及大小写和空格转换。

7. **无证据**：能否用 `version: 2025.08` 这样的版本？
   答：不能。项目模式要求 `x.y.z` 三段整数，否则校验失败。这是已实现的约束，不是外部规范。

8. **正向**：`extra` 字段中的自定义键会被删除吗？
   答：不会。在默认严格模式下会被记录为警告；开启 `allowExtra` 后原样保留。

## 维护、版本、来源与相邻主题

维护工作分为三个层面：模式层由 `packages/pi-agent` 的 Zod 模式定义；内容层由仓库内的 `.pi/knowledge` 和 `docs/` 文件承载；运行层由 `apps/api` 在启动时加载索引。模式变更必须同步修改 `pnpm test` 中的快照测试。

`version` 字段是概念级版本，与 `package.json` 版本、Git 提交号三者独立。建议每次概念状态变更或重大内容更新时手动递增 `version`，而 Git 负责保留历史记录。

来源字段 `source` 应优先填写原始文件路径，外部参考则填写 HTTPS URL。当概念被迁移到新的目录时，应更新 `source`，但保留 `id` 不变。

相邻主题包括：概念检索（负责如何按标签和术语召回）、Skills 管理（负责 `.pi/skills/` 的元数据）、Prompt 模板（负责 `.pi/prompts/` 的模板变量）。Frontmatter 是这些主题的共同输入：检索依赖 `tags` 和 `concept_type`，Skills 依赖 `status` 判断是否可用，Prompt 模板可能引用 `resources` 作为上下文来源。

## 结论

**事实**：OKF 概念 Frontmatter 必须使用 `concept_type`、`id`、`title`、`version`、`status`、`tags`、`resources` 等字段，并由 Zod 模式执行严格验证；`id` 全局唯一且与文件路径解耦；`status` 受单向生命周期状态机约束。

**推论**：如果实现时先完成解析、验证、索引和生命周期检查，再编写 Agent 工具代码，可以显著降低运行时幻觉风险，因为 Agent 只能消费已验证的元数据。

**未知**：具体仓库中是否允许 `extra` 字典覆盖核心字段语义，以及外部 HTTPS 资源是否需要定期的可达性验证，这取决于项目未来的治理规则，当前实现仅记录格式错误，尚未执行网络探测。
