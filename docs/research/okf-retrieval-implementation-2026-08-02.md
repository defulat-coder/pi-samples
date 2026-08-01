# OKF 作为 Markdown 知识库检索：真实实现与项目建议

> 调研日期：2026-08-02（Asia/Shanghai）\
> 范围：Google Open Knowledge Format（OKF）v0.2、官方参考仓库与 `okfcli/okf`；不把社区宣传当作规范事实。

## 结论

OKF 是 Google Cloud 发布的开放知识**文件格式/规范**，不是正式的检索协议、RAG 引擎或数据库。它规定“目录中的 Markdown 文件 + YAML frontmatter + 目录/链接约定”，而不是 BM25、embedding、chunk、rerank、权限或查询 API。Google 官方明确把 static file server、知识管理 UI、LLM、search index 和 graph viewer 都列为可独立的 consumer；格式本身不绑定 Google、模型或 serving system。[官方 README](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/README.md) · [OKF v0.2 SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)

**因此对本项目的建议是：**把 OKF 当作 `.pi/knowledge` 的可审计、可移植源格式；在 API/`packages/pi-agent` 侧增加一个本地、预编译的只读检索 consumer（首选 SQLite FTS5/BM25 + metadata/link 表），由 `search_knowledge` 一次返回有限的命中片段和来源。不要让每个请求串行执行 CLI 的 `search → show`，也不要把 OKF 的 `index.md` 误当成倒排索引。

## 名称消歧：Google OKF 与 Open Knowledge Foundation

| 名称 | 事实 | 与本项目关系 |
| --- | --- | --- |
| **Open Knowledge Format（OKF）** | Google Cloud Data Analytics 团队在 2026 年发布的开放规范；官方仓库是 `GoogleCloudPlatform/knowledge-catalog/okf`。 | 本文讨论的 Markdown 知识 bundle 格式。 |
| **Open Knowledge Foundation（OKFN/OKF）** | 独立的英国注册非营利组织，推动开放内容、数据和技术；其 Open Definition 讨论“知识是否开放”的法律、技术和社会条件。 | 不是 Google 的 OKF 格式，也不是该格式的维护者。见 [OKFN 官方简介](https://okfn.org/en/) 与 [What is open?](https://okfn.org/en/library/what-is-open/)。 |

这是同一缩写的巧合，不应把 OKFN 的开放知识定义、CKAN 或其项目当成 Google OKF 的 parser/CLI 证据。

## 规范究竟定义了什么

事实（来自 v0.2 SPEC）：

- Bundle 是目录树；每个非保留 `.md` 文件代表一个 Concept，文件路径构成 Concept identity。
- Concept 以 YAML frontmatter 开头；`type` 是必需字段，`title`、`description`、`resource`、`tags` 等用于描述、过滤或索引；正文是普通 Markdown。
- v0.2 增加 `sources`、`generated`、`verified`、`status`、`stale_after` 等 provenance、信任和新鲜度信号。
- `index.md` 用于渐进披露和人工/Agent 导航；它不是 term dictionary、posting list 或在线查询服务。
- 规范的 non-goals 包括规定存储、serving 和 query infrastructure。

推论：OKF 能让检索 consumer 得到稳定的字段、引用和链接，但“哪些结果可信”“是否过滤过期内容”“如何分段和排序”仍由 consumer policy 决定，而不是格式自动保证。

## 可验证的实现选择

### 官方 Google 仓库

官方仓库提供 OKF v0.2 规范、样例 bundle、reference agent（生产/丰富知识）和 static HTML visualizer（消费/浏览）。visualizer 在生成时解析 bundle、把内容嵌入 HTML，并提供标题、concept ID、tags 搜索；它是离线 viewer，不是常驻通用 RAG 服务。[README 的 Visualize 说明](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/README.md) · [Google Cloud 博客](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)

Google Cloud Knowledge Catalog 已支持导入 OKF 并提供给 Google agents；这是 Google 平台的消费路径，不是 OKF 规范要求，也不等于一个可嵌入本地 TypeScript 的开源检索 runtime。[官方博客](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing) · [v0.2 trust signals](https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals/)

### `okfcli/okf`

`okfcli/okf` 是早期开发中的 Go CLI。源码显示它每次命令都重新 WalkDir、读取并解析整个 bundle；`search --text` 是 title/description/body 的大小写不敏感字面子串匹配，`search` 结果只有 id/type/title，正文通常还需另一次 `show`。`index` 生成可读的 `index.md`，不生成持久化倒排索引；项目 README 将 `serve` 和可嵌入库列为 planned。[README](https://github.com/okfcli/okf) · [Bundle loader](https://github.com/okfcli/okf/blob/main/internal/bundle/bundle.go) · [Search](https://github.com/okfcli/okf/blob/main/internal/search/search.go) · [Index](https://github.com/okfcli/okf/blob/main/internal/index/index.go)

推论：它适合 CI 校验、离线导航、调试和小型 bundle 的一次性字面查找，不适合作为本项目高频在线检索服务。即使单次扫描很快，进程启动、全量 YAML/Markdown 解析和 `search → show` 往返仍会重复发生；它也不能减少模型 thinking、工具决策和最终生成的延迟。

### 本地 TypeScript consumer（推荐）

没有必要等待一个“官方 TypeScript OKF RAG SDK”：规范故意保持文件级、语言无关。项目可以用现有 Markdown/YAML 解析库实现一个窄 consumer：启动时扫描并校验 bundle，按文件内容哈希增量编译 SQLite FTS5（title、description、body、tags）和 concept/link/source metadata；查询时直接返回 Top-K 片段、`concept_id`、相对路径、来源与 status。链接图只在需要相关概念时做一跳扩展。

这是一项工程推论，不是 OKF 官方实现承诺。它保持“source Markdown → compiled read-only index”的边界，并可在未来替换 SQLite、Postgres 或托管搜索而不改变 OKF 源文件。

## 对 `pi-samples` 的明确落地建议

1. 保留 `.pi/knowledge` 为 Markdown-first source；若采用 OKF，增加 frontmatter `type`、`title`、`description`、`tags` 和可选 `sources/status/stale_after`，不改变现有知识正文的可读性。
2. 在 API 进程启动或后台刷新时构建内存/SQLite 索引；不要在每次 `search_knowledge` 调用启动 `okf` 子进程。
3. 让 `search_knowledge` 一次返回检索片段和引用，而不是暴露 `search`、`show`、`backlinks` 三个需要模型串行组合的低层命令。
4. 保持现有只读能力边界：检索结果和 frontmatter 是数据，不是授权；权限、路径白名单、SSE 事件和工具 allowlist 仍由 API/`packages/pi-agent` 控制。
5. 用真实 bundle 做 p50/p95 测量，分别记录索引刷新、检索、上下文组装、首个模型 token 和完整回答；不要把 OKF 或 `okfcli` 的存在本身当成延迟 SLO 证据。

## 事实与推论边界

- **事实：** Google v0.2 是 Markdown + YAML frontmatter 的开放格式；规范不规定查询基础设施；官方 consumer 示例是 visualizer/reference agent，Knowledge Catalog 是 Google 平台消费路径。
- **事实：** `okfcli/okf` 当前是 Go CLI，按源码全量加载 bundle，字面搜索且无持久化倒排索引。
- **推论：** 对本项目最稳妥的实现是 OKF 源文件 + 常驻 SQLite FTS5/BM25 consumer；这不是官方唯一方案，而是基于当前 API/SSE 与本地知识规模的工程选择。
- **未知：** Google Knowledge Catalog 内部检索算法、SLO、私有服务实现和未来 OKF 版本兼容策略，公开规范与仓库没有给出；不应据此声称本地 TypeScript 能获得同等能力。
