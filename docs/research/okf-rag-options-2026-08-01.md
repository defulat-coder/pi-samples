# OKF 与 RAG 的组合方式

> 调研日期：2026-08-01

## 结论

有“OKF + RAG”这种架构，但目前更准确的说法是：用 OKF 作为权威知识源和治理层，再把它编译成关键词、向量或图检索索引。OKF 本身不是 RAG 引擎，也没有规定向量数据库、chunking、embedding、reranking、召回 API 或模型调用协议。

Google 官方把 OKF 定义为 Markdown + YAML frontmatter 的知识交换格式，明确说它可以被 LLM 直接加载、被搜索索引消费，或被 agent 读取；官方博客还鼓励第三方编写 search index 和“reason over bundles”的 agent。Google Cloud Knowledge Catalog 已支持导入 OKF 并提供给其 agent，但这不是一个在 OKF 仓库内完整开源的通用 RAG runtime。

来源：

- <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/README.md>
- <https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/>
- <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>

## 已确认的官方边界

OKF v0.2 的目标是让 producer 和 consumer 解耦。规范要求 consumer 能读取 concept、frontmatter、Markdown body、链接和 provenance，但明确不规定 storage、serving 或 query infrastructure。`type`、`title`、`description`、`resource`、`tags` 适合作为过滤和搜索字段；`sources`、`generated`、`verified`、`status`、`stale_after` 可以作为引用、信任、生命周期和新鲜度元数据。

规范还建议使用结构化 Markdown、标题、列表、表格和代码块，因为这些结构有助于 agent retrieval；`index.md` 用于 progressive disclosure，而不是替代在线检索索引。

来源：

- <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md#goals>
- <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md#non-goals>
- <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md#42-body>

## 有没有现成的 OKF-RAG 产品？

目前可以确认的有三类，但成熟度不同：

1. **Google 官方消费路径**：Knowledge Catalog 能导入 OKF 并服务给 Google 的 agents。它是平台级消费路径，底层检索和服务细节不等同于 OKF 规范本身。
2. **OKF 生产和浏览工具**：官方 `knowledge-catalog` reference agent 能从 BigQuery 和网页生成、丰富 OKF bundle，visualizer 能浏览图谱和搜索标题、概念 ID、标签。这些是 producer/visualizer，不是完整的在线 RAG 问答服务。
3. **自建 adapter**：把 OKF bundle 解析成 FTS/BM25、向量、图或混合索引，再接任意 RAG 框架。这是最现实、最容易控制权限和延迟的路线。

因此，如果“现成”指开箱即用的“OKF 文件夹 → Ask AI → 引用回答”开源产品，目前不应把 OKF 官方仓库当成已有答案；更像是一个稳定的知识源契约，RAG consumer 需要自己实现或接 Google/其他检索平台。

## 推荐的 OKF + RAG 数据流

```text
官网 / CMS / Git / S3
        -> 解析、审核、生成 OKF bundle
        -> 按文件哈希增量编译索引
        -> BM25/FTS + 可选向量 + link graph
        -> 权限、版本、语言、status、stale_after 过滤
        -> top-k 证据片段和 source metadata
        -> 一次快速模型生成带引用答案
```

### 索引层

- 每个 concept 可作为一个父文档，同时按 `#` 标题、段落、列表和代码块切成子片段。
- 索引字段建议包括 `concept_id`、`title`、`description`、`body`、`type`、`tags`、`resource`、`source_ids`、`verified_tier`、`status`、`stale_after`、`locale` 和 `version`。
- Markdown 相互链接写入边表，用于回答“相关概念”“上下游”“依赖关系”和多跳问题。
- `sources[].id` 与正文脚注保持关联，回答时可直接回到原始 URL 或 bundle-relative path。
- 未验证、过期或 deprecated 的 concept 默认降权或排除；这属于 consumer policy，不是 OKF 规范强制的权限系统。

### 检索层

- 精确术语、错误码、API 名、版本号：BM25/FTS。
- 同义表达、自然语言问题：embedding search。
- 两者并行后用 RRF 融合，再对少量候选进行 rerank。
- 复杂关系问题再沿 OKF links 展开一跳或两跳；不要让每个普通问题都启动 Agent。

### 生成层

把检索结果作为带有 `concept_id`、标题、URL、版本、信任级别和正文片段的证据块传入模型。模型只负责综合和表达，不负责重新遍历整个 bundle。

## 对你的平台的建议

你的场景可以把 OKF 放在“知识治理”层：

```text
官网内容 / session / cloud.md / 知识库原文
        -> 清洗、审核、生成 OKF
        -> 常驻 Knowledge Index Service
        -> fast path: 直接检索 + 单次生成
        -> slow path: Claude/Codex Agent 多跳检索和工具调用
```

推荐用 OKF 保存：

- 稳定概念和业务定义；
- 原始来源与引用关系；
- 知识版本、生成者、审核者和过期时间；
- 概念之间的链接和上下游关系。

不要让 OKF 文件承担：

- 在线 BM25/向量索引；
- 用户权限判断；
- 租户隔离；
- 实时数据库查询；
- Agent 工具执行协议。

最轻量的实现是 `OKF -> SQLite FTS5 + metadata tables -> MCP/HTTP retrieval service -> LLM`。规模或并发上升后，可以替换成 PostgreSQL FTS + pgvector、OpenSearch/Elasticsearch、Algolia 或 Google 的托管搜索，而不改变 OKF 源文件。

## 最终判断

OKF 和 RAG 是互补关系：

- OKF 解决“知识应该如何组织、关联、审计和交换”；
- RAG 解决“本次问题应该取哪些知识给模型”；
- Agent 解决“是否需要多步检索、工具调用和动作执行”。

最值得落地的不是“用 OKF 代替 RAG”，而是“用 OKF 让 RAG 的输入更干净、更可引用、更可治理”。
