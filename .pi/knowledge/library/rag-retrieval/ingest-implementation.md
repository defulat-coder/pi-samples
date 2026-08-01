---
type: concept
title: 语料摄取：实现视角
description: 从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。将 Markdown、结构化记录和来源元数据转换为可检索概念
resource: .pi/knowledge/library/rag-retrieval/ingest-implementation.md
tags: [Pi, Agent, Kimi, 知识库, rag-retrieval, ingest, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: rag-retrieval
topic: ingest
variant: implementation
---

# 语料摄取：从 Markdown、结构化记录与来源元数据生成可检索概念

**摘要与问题边界**

语料摄取不是“把文件读进来并切块”，而是把异构输入转换成一组可验证、可引用、可重算的可检索概念。输入范围限定为：本地 Markdown 文件、结构化记录（JSON、YAML、TSV 等）以及附带的来源元数据（路径、修改时间、仓库版本、frontmatter 标签、许可证）。输出是一组概念记录，每条记录包含稳定标识、来源引用、文本或结构化字段、片段边界、链接关系与版本戳。本方案不解决查询时的重排序、大模型生成策略或微调训练；只解决“如何准确地让语料进入检索层”。核心边界在于：路径不可作为唯一标识，内容哈希不能替代语义标识，frontmatter 缺失不能视为错误。

**核心概念与数据模型**

1. **SourceDocument**：摄取的最小输入单元，通常对应一个文件。字段包括 `canonicalUri`（基于仓库根目录的相对路径，统一正斜杠）、`contentHash`（SHA-256 十六进制）、`mtime`、原始字节长度。`canonicalUri` 不含文件系统临时后缀或扩展名大小写差异。

2. **LogicalConcept**：语义上可独立回答问题的单元。它不一定等于文件或段落。一个 `LogicalConcept` 由 `conceptId`（确定性生成）、`sourceUri`（指向 SourceDocument）、`fragmentRange`（在原始文本中的起始/结束偏移或 AST 节点范围）、`content`（Markdown 渲染后的纯文本或结构化字段）组成。

3. **Fragment**：Markdown 按标题层级切分的连续文本块。边界判定为：一级或二级标题开始，直到下一个同级或更高级标题之前。例外：如果两个标题之间没有正文，则生成空片段，但保留标题本身作为可索引概念；代码块必须完整归属到其所在标题的片段，不允许跨标题切割。

4. **StructuredRecord**：非 Markdown 来源的强类型记录。例如 API 端点、ADR 决策记录、人物词条。每条记录必须映射到 `LogicalConcept` 的一个字段集合，并在摄取时声明 `schemaName` 与 `schemaVersion`，方便检索时按类型过滤。

5. **SourceMetadata**：记录概念的可信边界。包括 `collectionTag`（如 `docs/api`、`research/adr`）、`authors`、许可证、语言、创建时间、过期时间。过期时间存在时，检索器应降级该记录。

6. **LinkEdge**：概念之间的显式引用。`fromConceptId` 与 `toConceptId` 通过 `relType`（如 `see-also`、`parent-of`、`implements`）连接。内部锚点优先解析为标题 slug；未解析的链接作为 `brokenLink` 记录保留，供后续诊断。

7. **Canonicalizer**：负责把输入差异消除到同一语义空间。包括统一换行符为 LF、去除 BOM、把中文全角标点与 Markdown 标记解耦、把相对路径转成 `canonicalUri`、标题 slug 生成使用 GitHub 兼容规则（小写、空格转连字符、移除连续非字母数字）。

**设计决策与取舍**

**按标题层级分片，而非固定 Token 窗口**

标题天然携带文档结构，检索命中时可以直接给出“从属于哪个章节”这一上下文。固定窗口可能把同一段依赖说明切成两段，导致答案丢失条件。例外：当某一段落文本超过设定的最大长度（例如 2000 字符）时，必须在该段内部二次切分，并在元数据中标记 `overSplit: true`，让后续拼接逻辑知道这是同一标题下的连续块。

**ID 采用路径+标题 slug+可选片段序号，不采用纯内容哈希**

纯内容哈希会在标题重命名、错字修正后完全改变标识，导致历史链接与引用失效。使用基于路径和标题层级的 ID 能在内容变化不大的情况下保持稳定性。风险：文件重命名会导致 ID 变化，因此必须额外维护 `canonicalUri` 映射表或记录 `oldUris` 数组。

**结构化记录强制 schema 声明，但允许额外字段**

强制 `schemaName` 和 `schemaVersion` 保证下游可以验证；额外字段 `extra: Record<string, unknown>` 保留，不直接丢弃，因为业务知识库经常出现未在 schema 中定义的临时字段。检索时，未声明的字段只用于全文匹配，不参与强类型过滤。

**链接优先解析为锚点，缺失时记录为断链而非丢弃**

在本地 Markdown 知识库中，相对路径链接很常见。如果链接指向尚未摄取的文件，不能立即判错，而应生成 `unresolvedLink`，并在下一次摄取批次中重试。重试 3 次仍失败才标记为 `brokenLink`。这避免了摄取顺序导致的人为错误。

**增量同步基于内容哈希和版本戳，而非文件时间**

`mtime` 会被 git 检出、压缩包解压或 CI 缓存重置，不能作为可靠变更信号。以 `contentHash` 为是否重建的判据；同时保留 `sourceVersion`（如 git commit SHA 或数据源版本）用于快速跳过整批未变化文件。

**错误策略：解析异常走隔离，逻辑校验异常走阻塞**

解析器抛出的语法错误（YAML 缩进错误、JSON 非法字符）不应导致整批摄取失败，而是写入 `quarantine` 目录，并附带原始字节与错误堆栈。概念级校验（重复 ID、空标题、过期时间早于创建时间）则必须在当前批次阻塞提交，因为这些问题会影响检索结果的一致性。

**可执行的实施流程**

1. **枚举与过滤**：使用 `glob` 或 `fs.walk` 扫描输入目录，按 `.md`、`.mdx`、`.json`、`.yaml` 扩展名过滤，排除 `.git`、`node_modules`、以及 frontmatter 中 `draft: true` 的文件。输出 `SourceCandidate` 列表。

2. **读取原始字节**：以 `Uint8Array` 形式读取，使用 `jschardet` 或 `chardet` 检测编码，统一转换为 UTF-8。若字节序列以 BOM 开头，记录 `bom: true` 并在后续移除。

3. **解析文件类型**：Markdown 用 `unified` + `remark-parse` 生成 AST；JSON 用 `JSON.parse` 并捕获行列号；YAML 用 `yaml` 库启用严格模式。解析失败进入 `parseErrors` 队列。

4. **抽取与合并来源元数据**：从 Markdown frontmatter、结构化记录字段或旁路 `metadata.yaml` 中抽取。合并策略：文件级 frontmatter 优先于目录级 `metadata.yaml`，命令行传入的全局参数优先级最低。最终生成 `SourceMetadata` 对象。

5. **构建 Canonical URI 与稳定 ID**：把路径统一为正斜杠、移除仓库根前缀，生成 `canonicalUri`。稳定 ID 格式：`{collection}:{slug(path)}#{headingSlug}`。如果无标题，使用 `__intro`。`collection` 由目录规则或 frontmatter 决定。

6. **分片与边界标注**：对 Markdown AST 按标题层级分片。每个片段记录 `headingLevel`、`headingText`、`startOffset`、`endOffset`、`parentIds`。代码块不可切分；表格跨段时以表格结束位置为边界。

7. **结构化记录转概念**：根据 schema 把字段映射到 `LogicalConcept.content` 和 `extra`。如果记录包含 `id` 字段，优先用记录自声明的 ID，否则用 `canonicalUri` 作为兜底。所有字段名必须为小写 snake_case，不符合时触发重命名警告。

8. **链接解析与边生成**：收集 Markdown 链接 `[text](url)` 与结构化记录的 `related` 数组。把相对路径转成 `canonicalUri`，把 `#anchor` 转成标题 slug。生成 `LinkEdge` 或 `UnresolvedLink` 记录。

9. **验证与一致性检查**：检查重复 `conceptId`、空内容片段、必填字段缺失、时间逻辑冲突。验证结果写入 `validationReport`；未通过记录不得进入索引，必须阻塞提交。

10. **写入索引与事件发射**：把概念记录、边记录、来源元数据写入持久化队列（如 SQLite、PostgreSQL、向量存储）。发射 `ingestion.completed` 事件，包含批次 ID、文件数量、概念数量、错误分类统计。

11. **断链重试与清理**：在下一批次启动前，检查上一批 `UnresolvedLink`，若目标文件已存在则升级为 `LinkEdge`；若连续 3 次失败则标记 `brokenLink` 并写入诊断报告。

**输入、处理与输出示例**

输入是仓库根目录下的 Markdown 与 YAML 文件，处理时按照 `collectionRules` 分类、分片、抽取 frontmatter、解析链接并校验 schema，输出则是标准化的 `LogicalConcept` 记录，可以进入向量库与图索引。

下面给出摄取配置与类型定义的示例。

    # pipeline/ingest.yaml
    source:
      root: "./knowledge"
      include: ["**/*.md", "**/adr/*.yaml"]
      exclude: ["**/draft/**"]
    collectionRules:
      - pattern: "docs/api/*.md"
        tag: "api-reference"
        schema: "api_endpoint/v2"
      - pattern: "docs/adr/*.md"
        tag: "decision-record"
        schema: "adr/v1"
    metadata:
      defaultAuthor: "platform-team"
      license: "CC-BY-4.0"

    // packages/pi-agent/src/ingestion/types.ts
    interface LogicalConcept {
      conceptId: string;
      sourceUri: string;
      content: string;
      structuredFields?: Record<string, unknown>;
      metadata: {
        collectionTag: string;
        authors: string[];
        license: string;
        createdAt: string;
        expiresAt?: string;
      };
      fragment: {
        headingLevel: number;
        headingText: string;
        startOffset: number;
        endOffset: number;
      };
      links: {
        outgoing: Array<{ toConceptId: string; relType: string } | null>;
        unresolved: string[];
      };
    }

**性能、质量与可观测性指标**

1. **端到端摄取延迟**：从文件扫描到事件发射的总时间。在 10 000 个 Markdown 文件、平均 5 KB 的本地 SSD 上应低于 120 秒；用 `process.hrtime` 或 `performance.now()` 在步骤 1 与步骤 10 之间测量。

2. **每文件概念产出率**：每个 SourceDocument 生成的 LogicalConcept 数量中位数。Markdown 文档通常在 3 到 8 之间；结构化记录每个文件通常 1 到 N。异常低或高都需要人工复核。

3. **分片 token 长度分布**：统计每个 `content` 字段按空格/字符拆分后的长度，P50 在 200 到 600 token 之间，P95 不超过 1200。超过阈值说明分片策略需要调整。

4. **验证错误率**：每批次中 `parseErrors` 与 `validationReport` 条目数除以文件总数。目标低于 0.5%；超过 1% 应触发告警并暂停自动提交。

5. **断链率**：未解析链接数除以总链接数。目标低于 2%；高于 5% 说明文档结构或目录规则有问题。

6. **来源覆盖率**：实际成功摄取的概念数除以预期概念数。预期数由目录规则与文件 frontmatter 估算。覆盖率低于 95% 必须排查 IO 权限或解析器失败。

**失败模式、诊断证据与恢复动作**

1. **解析器异常**：YAML 缩进错误、JSON 尾逗号或 Markdown 表格列数不匹配。诊断证据：堆栈包含行列号、错误类型 `YAMLParseError` 或 `MarkdownSyntaxError`。恢复：将文件移入 `quarantine/{batchId}/`，在日志中记录原始字节偏移，由人工修复后重新摄取。

2. **重复 ID**：两个文件因同名标题或相同路径产生相同 `conceptId`。诊断证据：验证报告出现 `DUPLICATE_CONCEPT_ID` 并列出冲突文件。恢复：检查 `canonicalUri` 与标题 slug 是否唯一，必要时调整 `collectionRules` 或手动添加 `id` 前置。

3. **编码不一致**：文件声明为 UTF-8 但实际为 GBK/Shift-JIS，导致中文乱码。诊断证据：内容哈希与预期不符，或检测置信度低于 0.7。恢复：用 `chardet` 重新检测，若置信度仍低，则把文件标为 `encoding-ambiguous` 并人工指定编码。

4. **断链雪崩**：大量相对链接指向同一目录下的文件因扩展名规则被排除。诊断证据：`brokenLink` 集中指向同一目录。恢复：调整 `exclude` 规则或添加 `include` 模式，然后重跑链接解析步骤。

5. **元数据时间冲突**：`expiresAt` 早于 `createdAt`。诊断证据：校验报告 `TEMPORAL_INVALID`。恢复：拒绝该概念进入索引，通知内容维护者修正 frontmatter；修复后由增量同步重新摄取。

6. **文件重命名导致 ID 漂移**：旧链接全部失效，但内容未变。诊断证据：`brokenLink` 列表中的目标与某 `SourceDocument` 的内容哈希一致但 canonicalUri 不同。恢复：在 `uriMapping` 表中记录旧 URI 到新 URI 的映射，并在下一次摄取时生成别名 ID。

**问答测试样例**

- **正向**：文档 `docs/auth/oauth2.md` 的标题 “授权码流程” 被摄取后，查询 “授权码流程的回调地址是什么？” 应返回 `conceptId` 为 `docs:auth/oauth2#authorization-code-flow` 的概念，并附带 `sourceUri` 与 `headingLevel: 2`。

- **边界**：一个 Markdown 文件只有标题没有正文，查询该标题名称时，系统应返回仅包含标题文本的概念，且 `content` 长度可能为零，但 `headingText` 字段非空。

- **无证据拒答**：如果知识库中没有关于 “GraphQL 订阅” 的任何记录，查询 “GraphQL 订阅的默认超时” 应返回空结果，而不是用通用 LLM 知识虚构答案。

- **结构化记录**：查询 “ADR-0012 为什么弃用 REST 分页？” 应命中 `schemaName: adr/v1` 且 `id: ADR-0012` 的记录，答案中应引用 `decision` 与 `consequences` 字段。

- **过期内容**：若某记录 `expiresAt` 为 2024-12-31，查询发生在 2025-01-01，检索器应跳过该记录，或仅在开启 “包含过期内容” 标志时返回并标注 `expired: true`。

- **链接上下文**：查询 “用户服务如何调用支付服务？” 应优先返回包含 `fromConceptId` 为 `docs:user-service` 且 `relType: calls` 的 `LinkEdge`，并在结果中展示相邻片段摘要。

**维护、版本、来源与相邻主题**

schema 与 `collectionRules` 必须版本化，并在升级时提供迁移脚本。例如从 `api_endpoint/v1` 升级到 `v2` 时，旧字段 `url` 被拆分为 `path` 与 `method`，迁移脚本应扫描历史概念并更新字段。来源元数据中的 `sourceVersion` 应记录 git commit SHA 或数据源版本，保证可重算。概念一旦进入索引，删除只能通过标记 `status: deleted` 实现，而非物理删除，以保留审计链。本主题与 “分块策略” 相邻，但更关注来源与语义结构；与 “嵌入生成” 相邻，但嵌入是摄取后的可选步骤；与 “查询评估” 相邻，后者依赖摄取输出的稳定 ID 来精确判断召回是否命中。

**结论**

事实：语料摄取必须产生带稳定标识、来源引用、片段边界与链接关系的概念记录；Markdown 标题层级是本地知识库最可靠的分片依据；`contentHash` 是判断文件是否需要重建的最可靠信号。推论：结构化记录与 Markdown 统一在 `LogicalConcept` 模型下，可以降低检索层复杂度；按 schema 声明并在 `extra` 中保留未声明字段，可以在严格性与业务灵活性之间取得平衡。未知：不同仓库的标题层级习惯差异可能导致最佳最大分片长度不同；中文标题 slug 是否需要保留拼音索引或仅保留原文对召回率的影响需要在线 A/B 测试；断链应允许几次重试才能判为“真正错误”取决于知识库更新频率，目前按 3 次重试是经验阈值。
