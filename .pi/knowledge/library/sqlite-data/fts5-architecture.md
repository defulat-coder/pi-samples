---
type: concept
title: SQLite FTS5：架构视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。用全文索引减少重复扫描，并保留可解释的匹配字段
resource: .pi/knowledge/library/sqlite-data/fts5-architecture.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, fts5, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: fts5
variant: architecture
---

# SQLite FTS5：在本地知识库中构建可解释的全文索引层

## 摘要与问题边界

在基于 SQLite 的本地知识库中，全文检索常被实现为“反复对文本字段做 LIKE 扫描”。随着文档数量增长，这种策略会在启动时、列表滚动时或批量导入时形成线性扫描，导致 CPU 与 I/O 在边界处被持续消耗。SQLite FTS5 的职责是把文档拆分为词项（term）并构建倒排索引，从而用索引扫描替代逐行字符串扫描。它适用于：离线本地文件索引、Electron/TypeScript 桌面端、通过 SQLite WASM 在浏览器 Worker 中运行的场景，以及 API 后端与本地缓存之间的检索层。

FTS5 不负责：语义相似度计算、拼写纠错、同义词扩展、PDF/图片等非结构化二进制解析、跨库联合搜索。它的边界是“已写入 SQLite 的文本内容”。如果文本来源是外部文件系统，文件发现、解析、版本同步、权限校验应由上层系统负责，FTS5 只保证其已收到的文本可被检索。本视角以“先建立接口与责任边界，再选择实现”为原则，把 FTS5 视为一个可替换的本地全文索引层，而不是整个搜索系统的同义词。

## 核心概念与数据模型

1. 虚拟表与外部内容表。FTS5 表是一个虚拟表，默认会把全部文档内容重复存储在索引内部。若把主表作为权威数据源，应使用 `CREATE VIRTUAL TABLE ... USING fts5(content='docs', content_rowid='id', title, body)` 形式，让 FTS5 只保留倒排索引，文档正文仍由主表持有。这样 `docid` 与主表主键形成可解释的映射。

2. 词项、列与位置。FTS5 在内部把每个文档切分为词项，并记录 `(term, column_index, offset)` 三元组。`matchinfo()` 可以暴露命中的列、命中次数和文档长度；`snippet()` 可以在命中列中截取上下文。对架构者而言，这些字段是“可解释的匹配证据”。

3. 分词器（tokenizer）。`unicode61` 是通用默认选项，可处理英文和数字；`porter` 在英文场景下做词干提取；`trigram` 把文本切成三字符片段，适合中文、日文、代码片段和无空格语言。分词器决定哪些输入能匹配，也决定索引大小与写入开销。

4. 查询语法。`MATCH` 子句支持短语 `"full text"`、前缀 `prefix*`、邻近 `NEAR(a b, 5)`、布尔组合 `AND`/`OR`/`NOT`。前缀匹配会显著增加读取量，因为需要遍历前缀对应的所有词项。

5. 排名函数。`rank=bm25` 按 BM25 打分；`rank=matchinfo('pcnalx')` 可自定义权重。`bm25` 不默认区分列权重，如需把标题命中比正文命中的权重更高，应在查询层或自定义 rank 函数中实现。

6. 辅助数据与命中高亮。`snippet()` 与 `offsets()` 只返回索引中已有的列。如果主表新增字段，必须重建虚拟表或扩展其列定义，否则新字段不可被检索或高亮。

7. 事务与一致性。FTS5 与主表处于同一个 SQLite 事务中。当使用外部内容表时，若绕过触发器直接修改主表，FTS5 索引会立即不一致。因此触发器或显式写入层是必要依赖。

## 设计决策与取舍

### 外部内容表还是内容自包含

如果主表已有规范化字段，且数据量较大，优先选择外部内容表。它减少一份冗余文本，但会把最终查询变成“FTS 虚拟表 JOIN 主表”，引入一次行查找。如果单次返回结果少于 200 条，JOIN 成本可忽略；如果批量导出或需要高亮大量片段，自包含表可能更快，但会放大存储。

### 默认分词器的边界

`unicode61` 对英文分词精确，但对中文按字符分割，导致索引膨胀且短语匹配失效。对于中文知识库，可选 `trigram` 或 `unicode61 "tokenchars=.-"` 配置。`trigram` 的索引体积大约是 `unicode61` 的 2–3 倍，但前缀搜索与中文短语稳定性更好。如果未来要切换到 `porter` 或自定义 ICU 分词器，应封装为 `TokenizerFactory`，避免 SQL 散落在业务代码中。

### 排名与可解释性的折中

BM25 给出单一分数，但无法告诉用户“为什么命中”。`matchinfo('pcx')` 可返回命中列与次数，用于 UI 标签；`snippet()` 提供文本证据。返回这些字段需要额外的虚拟表访问，建议只在结果列表中保留前 20 条的高亮，其余用纯 BM25 分数排序。

### 写入策略与触发器

外部内容表不会自动跟踪主表变更。必须建立 `AFTER INSERT/UPDATE/DELETE` 触发器，或者在业务层显式把主表写入和 FTS 写入放在同一事务里。触发器简单但隐藏，调试时容易遗漏；显式写入更可见，但要求所有写入路径都经过统一封装。在架构层面，应把所有写入抽象为一个 `KnowledgeStore` 接口。

### 离线重建与版本迁移

FTS5 表 schema 一旦创建，不能 `ALTER TABLE ADD COLUMN`。若新增可检索字段，需要：创建新 FTS 表、迁移数据、删除旧表、重命名。此过程应被版本化为一次“索引迁移”，并在启动时检查 schema 哈希。不要把 FTS 表当作持久化主数据，它随时可被重建。

## 可执行的实施流程

1. 确定主表。设计 `docs(id PRIMARY KEY, title, body, path, updated_at)`，其中 `id` 是稳定主键，`path` 是外部文件的可验证来源。
2. 创建 FTS5 虚拟表。`CREATE VIRTUAL TABLE docs_fts USING fts5(content='docs', content_rowid='id', title, body, tokenize='unicode61')`。
3. 初始化索引。把已有数据通过 `INSERT INTO docs_fts(rowid, title, body) SELECT id, title, body FROM docs` 灌入。注意列顺序与虚拟表定义一致。
4. 建立同步触发器。在主表上定义 `INSERT/UPDATE/DELETE` 触发器，使 `docs_fts` 与 `docs` 同步；或在统一仓储接口中同时写入两张表。
5. 封装查询构建器。对用户输入做 `ESCAPE` 与停用词处理，禁止裸 `*` 开头查询导致全词项扫描，只允许前缀 `term*`。
6. 编写可解释返回结构。查询返回 `id, title, body, path, rank, snippet(docs_fts, 0, '<b>', '</b>', '…', 30) AS title_snippet, snippet(docs_fts, 1, '<b>', '</b>', '…', 30) AS body_snippet`。
7. 添加分页与阈值。使用 `LIMIT ? OFFSET ?` 并按 `rank` 排序；当 `rank` 低于阈值时过滤掉低质量结果。
8. 接入可观测。在 TypeScript 层记录每次搜索的 SQL 耗时、命中数、匹配列分布。
9. 验证一致性。启动时比较 `COUNT(*)` from `docs` 与 `docs_fts`；若不一致触发重建。
10. 文档迁移脚本。把重建脚本版本化，与主表 schema 迁移一起纳入 CI。

## 示例：TypeScript/Web 本地文件知识库的检索契约

以下示例描述一次 Web Worker 与 SQLite WASM 之间的请求、处理与响应。输入是 JSON 消息，处理是 SQL 执行，输出是带命中字段的结构。

    输入
    {
      "type": "search",
      "query": "FTS5 倒排索引",
      "columns": ["title", "body"],
      "limit": 20,
      "offset": 0
    }

    处理 SQL
    SELECT d.id,
           d.path,
           d.title,
           snippet(docs_fts, 0, '<b>', '</b>', '…', 24) AS title_hit,
           snippet(docs_fts, 1, '<b>', '</b>', '…', 40) AS body_hit,
           docs_fts.rank
    FROM docs_fts
    JOIN docs d ON d.id = docs_fts.rowid
    WHERE docs_fts MATCH ?
    ORDER BY docs_fts.rank
    LIMIT ? OFFSET ?;

    输出
    {
      "type": "search_result",
      "total": 7,
      "results": [
        {
          "id": "doc-103",
          "path": "notes/sqlite-ft5.md",
          "title": "SQLite FTS5 设计笔记",
          "title_hit": "SQLite <b>FTS5</b> 设计笔记",
          "body_hit": "…使用 <b>倒排</b> <b>索引</b> 减少重复扫描…",
          "rank": 1.02
        }
      ]
    }

输入中的 `query` 会先被过滤：保留中文、英文、数字，移除首尾 `*` 与纯逻辑符号。处理阶段把 `MATCH` 绑定为 `FTS5 倒排索引`；`snippet()` 的两列参数分别对应虚拟表列 `title`（索引 0）和 `body`（索引 1）。输出保留了 `title_hit` 和 `body_hit` 两个可解释字段，前端据此决定是否显示高亮或来源标签。

## 性能、质量与可观测性指标

1. 查询耗时 P50/P95/P99。在本地 SQLite 上用 `performance.now()` 或 SQLite `timer` 记录从 `MATCH` 到结果返回的毫秒数。P50 应低于 5 毫秒；P99 在 10 万文档级应低于 50 毫秒。
2. 索引大小与主表大小比。通过 `db.size` 或 `PRAGMA page_count` 计算 `(FTS5 表大小)/(主表文本大小)`。unicode61 英文场景约 0.5–1.2 倍；trigram 中文场景约 1.5–3 倍。
3. 有结果查询占比。记录返回非空结果集的用户查询比例。若低于 40%，说明分词器、停用词或查询解析与文档集合失配。
4. 索引新鲜度延迟。对本地文件监听后，记录文件修改到 FTS 可检索的最大延迟。目标取决于事务批量策略，通常单条小于 100 毫秒。
5. 命中列分布。统计 `title` 命中、`body` 命中、两者同时命中的查询次数。若 `title` 命中占比过低，应调整列权重或文档标题结构。
6. 重建耗时。记录 `INSERT INTO docs_fts SELECT ...` 全量重建的时间，用于版本迁移评估。

## 失败模式、诊断证据与恢复动作

1. 查询返回空但文档存在。诊断：检查 `SELECT * FROM docs_fts WHERE docs_fts MATCH ?` 是否为空；用 `PRAGMA table_info(docs_fts)` 确认列名；检查是否用了未索引列。恢复：重新绑定到正确的列，或重建索引。
2. 分词导致中文无法匹配。诊断：对文档片段执行 `SELECT * FROM docs_fts WHERE docs_fts MATCH '倒排索引'` 为空；对 `倒排索引` 做 `SELECT * FROM docs_fts WHERE docs_fts MATCH '倒排'` 有结果。这表明默认分词器把中文按单字处理。恢复：改用 `tokenize='trigram'` 并重建。
3. 索引与主表数量不一致。诊断：`COUNT(*)` from `docs` 与 `docs_fts` 不等，或 `SELECT rowid FROM docs_fts` 出现主表不存在的 docid。恢复：执行 `INSERT INTO docs_fts(docs_fts) VALUES('rebuild')` 或按版本迁移脚本重建。
4. 查询语法错误导致崩溃。诊断：日志出现 `malformed MATCH expression` 或 SQL 异常。恢复：在查询构建层转义双引号、括号、裸 `*`；对非法输入返回空结果而非抛错。
5. 性能随偏移量退化。诊断：大 `OFFSET` 时 P95 超过 100 毫秒。恢复：改用基于上次 `rank` 或 `rowid` 的“游标分页”，或限制最大偏移量。
6. 高并发写入触发锁。诊断：错误 `database is locked`。恢复：启用 WAL 模式，把写入串行化到单队列，缩短事务长度。

## 问答测试样例

1. 正向：用户问“如何查看 FTS5 表用了哪个分词器？”
   可答：`SELECT * FROM sqlite_master WHERE type='table' AND name='docs_fts';` 检查创建语句中的 `tokenize` 子句。

2. 正向：用户问“为什么高亮片段只显示标题或正文？”
   可答：`snippet()` 的参数按虚拟表列索引对应，若只传一个 snippet 就只能看到一列；应分别对每个索引列调用 snippet。

3. 边界：用户问“输入全是空格能返回什么？”
   应拒绝：FTS5 分词后无词项，查询结果为空；系统应在查询构建层拦截并返回空。

4. 边界：用户问“前缀查询 `*` 开头会怎样？”
   应拒绝：裸 `*` 会导致遍历所有词项，必须要求至少一个非通配字符；若未实现，则返回“不支持该查询”。

5. 无证据：用户问“FTS5 能否直接计算文档向量相似度？”
   应拒绝：FTS5 只提供词项匹配；语义向量相似度需要额外扩展或单独存储向量。

6. 无证据：用户问“我的索引突然少了 1000 条，是不是 SQLite 自动清理了？”
   应拒绝：SQLite 不会自动删除 FTS5 内容；请检查触发器或应用层是否有批量删除，并通过 `COUNT` 比较与重建恢复。

## 维护、版本、来源与相邻主题关系

SQLite 3.19.0 起内置 FTS5。若使用 `better-sqlite3` 或 `node-sqlite3`，需确认编译时启用 `-DSQLITE_ENABLE_FTS5`；WASM 发行版通常已包含。来源唯一可信的是运行时的 `sqlite_compileoption_used('ENABLE_FTS5')` 与 `SELECT sqlite_version()`。

版本策略：把 FTS5 表结构版本与主表 schema 版本一起写入 `migrations` 表。当 tokenizer、列、rank 函数变更时，版本号递增，启动时若版本不匹配则执行离线重建。不要把 FTS5 索引提交到版本控制，它可由源文件重建。

与相邻主题关系：FTS5 与 SQLite 的 WAL 模式配合良好；与 `LIKE` 扫描是互补关系，精确模式匹配仍可用 B-tree/主表；与向量检索（如 sqlite-vss）是并列层，一个做词项匹配，一个做语义近似；与本地文件监听层是上下游，文件监听负责“发现—解析—写主表”，FTS5 负责“从主表建立可解释索引”。

## 结论

事实：SQLite FTS5 是内置扩展，通过倒排索引替代逐行 LIKE 扫描，并可通过 `matchinfo`、`snippet`、`offsets` 返回可解释的命中列。FTS5 虚拟表支持外部内容表，与主表共享同一事务。

推论：在本地 TypeScript/Web 知识库中，采用“外部内容表 + 统一写入接口 + 触发器/显式同步”的方案，能够在十万级文档内保持可接受的搜索延迟，同时通过命中列和高亮片段支持可解释 UI。

未知：具体文档集合下的最佳分词器与参数、rank 阈值、分页策略，必须在该项目真实数据上通过测量指标确定；不同 SQLite 编译选项与 WASM 运行时的性能特征也会改变上述推论。
