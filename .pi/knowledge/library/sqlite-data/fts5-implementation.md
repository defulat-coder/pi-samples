---
type: concept
title: SQLite FTS5：实现视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。用全文索引减少重复扫描，并保留可解释的匹配字段
resource: .pi/knowledge/library/sqlite-data/fts5-implementation.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, fts5, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: fts5
variant: implementation
---

# SQLite FTS5 实现视角：本地全文索引与可解释匹配字段

## 摘要与问题边界

本文面向需要把本地搜索落成 TypeScript 代码的开发者。要解决的问题是：在 SQLite 中存储文档、笔记或日志时，如何用 FTS5 全文索引替代 `LIKE '%term%'` 的重复全表扫描，并在结果中保留可解释的匹配字段（高亮片段、匹配列、排名）。范围限定在本地文件型数据库、单进程或少量并发、无需远程搜索引擎。不包含向量相似度、分布式分片、自然语言分词模型训练；相邻主题将在末尾列出。

## 核心概念与数据模型

1. **FTS5 是虚拟表模块**：通过 `CREATE VIRTUAL TABLE ... USING fts5(...)` 声明，不是普通表。对调用方仍然使用 `INSERT/UPDATE/DELETE` 写入，使用 `SELECT ... WHERE table MATCH 'query'` 查询。
2. **行与文档的映射**：FTS5 表必须有一个 `rowid`，一行对应一篇文档。文档被拆成若干列，写入时按配置的分词器切词并建立倒排索引。
3. **分词器决定最小语义单元**：常用分词器有 `unicode61`（默认，按 Unicode 空白与标点）、`ascii`（仅 ASCII 空白）、`porter`（词干还原）、`trigram`（三字符子串）。可组合使用，例如 `tokenize='porter unicode61'` 表示先 Unicode 分词再词干还原。
4. **前缀索引与通配查询**：`prefix='2 3'` 选项预先建立长度为 2 和 3 的前缀索引；没有前缀索引时，`term*` 仍能返回结果，但会扫描整个词表，延迟随词表规模增长。
5. **辅助函数负责可解释输出**：`snippet(table, col, prefix, suffix, ellipsis, n)` 生成命中片段，`highlight(table, col, prefix, suffix)` 高亮整列，`bm25()` 计算排名。这些函数只在匹配行上有效。
6. **外部内容表与无内容表**：`content='source_table'` 让 FTS5 只保留索引，正文由外部表存储，可省空间但需触发器或应用层同步；`content=''` 表示无内容表，只能返回 `rowid`，无法调用 `snippet` 和 `highlight`。
7. **detail 选项控制位置精度**：`detail=full` 保存词偏移，支持片段与高亮；`detail=column` 只保存列级命中；`detail=none` 只保存文档级布尔命中。detail 越粗，索引越小，但 snippet 会失效。
8. **rank 列与可替换排序**：FTS5 默认把 `rank` 隐藏列解析为 `bm25()`。开发者可通过 `rank='bm25(...)'` 指定参数，也可写自定义排名表达式。

## 设计决策与取舍

### 是否使用外部内容表
文档字段很大且结果页只需要标题和摘要时，把正文放在外部普通表、FTS5 只索引标题与摘要，可降低索引体积。代价是写路径需同时维护两张表，或用 insert/update/delete 触发器。

### 选择哪种分词器
中文、英文、代码混合的本地知识库，`unicode61` 是最稳妥的起点。需要词干匹配时叠加 `porter`。不要对需要精确标识符的代码片段单独使用 `porter`，否则 `C++` 和 `C` 的区分度可能下降。

### 是否启用前缀索引
`prefix='2 3'` 提升 `data*` 类查询延迟，但增大写放大和索引体积。离线应用若用户极少输入前缀可关闭；实时搜索框建议开启，并在导入后执行 `INSERT INTO fts(fts) VALUES('optimize')`。

### 是否保留 snippet 字段
`snippet` 是结果页最可解释的部分。若结果只需跳转原文，`content=''` 无内容表即可。若要告诉用户“为什么命中”，必须保留 `detail=full` 并使用 `snippet` 或 `highlight`。

### 写模式：触发器还是应用层双写
触发器在 SQLite 内部完成，一致性最强，但迁移复杂。应用层双写简单，但事务失败时可能漂移。建议用事务包裹外部表写入和 FTS 表写入，并周期运行 `integrity-check`。

### 查询语法与转义策略
`MATCH` 支持 `AND`、`OR`、`NOT`、列限定 `title:sqlite`、前缀 `data*`、`NEAR(term1, term2, 5)`。用户输入若含保留字符，必须先用双引号包裹，否则会出现 `fts5: syntax error`。

## 可执行的实施流程

1. **验证编译选项**：打开数据库后执行 `SELECT sqlite_compileoption_used('ENABLE_FTS5')`，确认返回 1。若为 0，需重新编译或加载 `fts5` 扩展。
2. **设置本地运行环境**：开启 `PRAGMA journal_mode = WAL;` 与 `PRAGMA busy_timeout = 5000;`，读不阻塞写；同时开启 `foreign_keys = ON`。
3. **创建源表与 FTS 虚拟表**：先建普通表 `notes`，再建 `CREATE VIRTUAL TABLE notes_fts USING fts5(title, summary, content=notes, content_rowid=id, tokenize='unicode61', prefix='2 3', detail='full');`。
4. **建立同步触发器**：为 `notes` 建 `AFTER INSERT/UPDATE/DELETE` 触发器，对 `notes_fts` 执行对应 `INSERT/DELETE` 操作。若走应用层双写，则跳过。
5. **批量导入历史数据**：按 `rowid` 顺序分批写入，每批一个事务。先插入 `notes`，再插入 `notes_fts`，避免中间状态。
6. **执行优化命令**：导入后执行 `INSERT INTO notes_fts(notes_fts) VALUES('optimize');` 合并索引段。
7. **封装查询函数**：TypeScript 层接收 `{ q, limit, offset }`，执行 `SELECT id, title, snippet(notes_fts, 0, '<mark>', '</mark>', '...', 32), bm25(notes_fts) FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?`。
8. **输入验证与错误处理**：对查询字符串去空白；长度小于 2 或全为停用词返回空结果；含未转义特殊字符时双引号包裹或拒绝执行。捕获 `SQLITE_ERROR` 并记录。
9. **编写回归测试**：至少包含命中测试、未命中测试、片段测试，用事务回滚保证可重复。
10. **部署前检查**：确认数据库大小、索引大小、WAL 大小、FTS5 完整性检查通过、查询 p95 延迟低于阈值。

## 示例配置与输入处理说明

下面是一个 TypeScript 本地知识库项目的配置对象、查询 SQL 和输出结构。

配置对象语义：
- `dbPath`: `"./kb.sqlite"`
- `journalMode`: `"WAL"`
- `ftsTable`: `"notes_fts"`
- `contentTable`: `"notes"`
- `contentRowId`: `"id"`
- `tokenizer`: `"unicode61"`
- `prefixIndex`: `"2 3"`
- `detail`: `"full"`
- `rankFunction`: `"bm25(1.0, 0.5)"`

输入：用户输入字符串 `q` 经转义后替换参数化查询占位符。处理：SQL 层使用 `MATCH` 在 `notes_fts` 倒排索引中查找，并调用 `snippet` 和 `bm25`。输出：包含 `id`（整数）、`titleHighlighted`（标题高亮片段）、`summarySnippet`（正文命中上下文）、`score`（bm25 分数）的数组。所有数据都在本地 SQLite 文件中，不依赖外部搜索引擎。

## 性能、质量和可观测性指标

1. **索引体积比**：测量 `notes_fts` 页数与 `notes` 页数之比。预期在 0.3 到 1.5 之间，取决于分词器和前缀索引。
2. **查询延迟 p95**：用 `performance.now()` 包裹 100 次典型查询，目标本地 SSD 低于 50 ms。
3. **插入吞吐量**：事务中批量写入 1000 行，记录耗时。FTS5 写入成本高于普通表，通常低于 5000 行/秒。
4. **结果相关性**：对 20 个已知查询，检查前 5 条是否包含人工标注的期望结果，通过 `score` 和 `snippet` 验证。
5. **完整性检查成功率**：周期执行 `INSERT INTO notes_fts(notes_fts) VALUES('integrity-check');`。抛错表示索引结构损坏。
6. **漂移率**：外部内容表场景下，定期比较 `SELECT count(*) FROM notes` 与 `SELECT count(*) FROM notes_fts`。差异为 0 表示同步正常。

## 失败模式、诊断证据与恢复动作

1. **模块未启用**
   - 证据：`CREATE VIRTUAL TABLE ... USING fts5` 返回 `no such module: fts5`。
   - 恢复：检查 `sqlite_compileoption_used('ENABLE_FTS5')`；若为 0，重新编译或加载扩展文件。

2. **MATCH 语法错误**
   - 证据：返回 `fts5: syntax error`。
   - 恢复：检查输入是否含未转义的 `AND`、`OR`、`NOT`、`*`、双引号或括号；用双引号包裹或改用 `LIKE` 兜底。

3. **词干还原导致精确匹配丢失**
   - 证据：查询 `running` 命中 `run`，但 `runner` 未返回 `run` 的文档。
   - 恢复：对精确字段使用 `tokenize='unicode61'`，不叠加 `porter`。

4. **外部内容表漂移**
   - 证据：两表行数不一致，或按 `id` 查询时 FTS 无结果。
   - 恢复：停止写入，执行 `INSERT INTO notes_fts(notes_fts) VALUES('rebuild')`，然后检查触发器。

5. **snippet 返回空**
   - 证据：`snippet(...)` 列全为 NULL，但 `rowid` 正常返回。
   - 恢复：确认 `detail` 不是 `none`；若是 `content=''` 无内容表，则必须改为外部内容表或内容表。

6. **数据库锁定**
   - 证据：批量写入报 `database is locked`，或读取被长写入阻塞。
   - 恢复：启用 WAL 模式，设置 `busy_timeout`，将批量写入合并到事务，避免多进程并发写。

## 问答测试样例

1. **正向问题**：如何只搜索标题列？
   - 期望答案：`WHERE notes_fts MATCH 'title:sqlite'`，`title` 是 FTS 表列名。

2. **正向问题**：如何按相关度排序？
   - 期望答案：`ORDER BY rank`，FTS5 默认把 `rank` 解析为 `bm25()`。

3. **边界问题**：查询空字符串会怎样？
   - 期望答案：`MATCH ''` 不报错，返回空结果集，因为没有任何词项可匹配。

4. **边界问题**：前缀查询 `data*` 是否总是走前缀索引？
   - 期望答案：只有建表时配置 `prefix='...'` 才会使用；否则扫描词表。

5. **无证据拒答**：FTS5 能否做向量相似度搜索？
   - 期望答案：否。本文方案未涉及向量索引；向量相似度属于相邻主题，需要专用扩展或引擎。

6. **无证据拒答**：FTS5 是否支持中文语义分词？
   - 期望答案：否。`unicode61` 只按空白与标点切分；中文语义分词需要外部预处理或自定义分词器。

## 维护、版本、来源与相邻主题

- **版本**：FTS5 从 SQLite 3.9.0 可用，`trigram` 分词器从 3.34.0 可用。TypeScript 绑定层应以运行时 `sqlite_version()` 为准。
- **来源**：SQLite 官方 FTS5 文档是分词器、辅助函数和查询语法的事实来源；TypeScript 绑定只调用 SQLite C API，不自行实现分词。
- **备份**：WAL 模式下至少备份主文件、`-wal` 和 `-shm` 文件；只复制主文件会丢数据。备份前执行 `PRAGMA wal_checkpoint(RESTART);` 可减小 WAL。
- **重建与优化**：`INSERT INTO notes_fts(notes_fts) VALUES('rebuild')` 重建索引；`VALUES('optimize')` 合并段文件。两者不删除数据。
- **迁移**：从 FTS3/4 迁移不能 `ALTER TABLE`；应新建 FTS5 表，导入数据后删除旧表。
- **相邻主题**：FTS3/FTS4 是更早的全文模块，API 不兼容；SQLite R*Tree 用于空间索引；向量近似搜索需要 `sqlite-vec` 等扩展；`LIKE` 与 `GLOB` 适合模式匹配但不做排名；普通 B-Tree 索引适合前缀搜索但无法全文匹配。

## 结论

以下区分三类陈述：

- **事实**：FTS5 是 SQLite 的虚拟表模块；`MATCH` 表达式使用倒排索引而非逐行扫描；`snippet`、`highlight`、`bm25` 是内置辅助函数；`detail` 与 `content` 选项会限制这些函数的可用性。
- **推论**：在本地 TypeScript 应用中，使用兼容 SQLite 绑定、WAL 模式、参数化查询和 `unicode61` 分词器，能够满足数万到数十万文档的可解释全文搜索；更大规模或复杂排名需要外部内容表和批量导入策略。
- **未知**：具体平台预编译的 SQLite 是否启用 FTS5；不同 Unicode 版本对特殊标点的断词差异；`porter` 词干还原在特定业务词表上的精确召回率，这些都需要在目标设备和目标数据集上实测验证。
