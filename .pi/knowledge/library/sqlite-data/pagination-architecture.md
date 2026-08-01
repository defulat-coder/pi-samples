---
type: concept
title: 分页与排序：架构视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。稳定地返回大列表，避免 offset 抖动和重复数据
resource: .pi/knowledge/library/sqlite-data/pagination-architecture.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, pagination, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: pagination
variant: architecture
---

# SQLite 本地大列表的稳定分页与排序：游标边界、快照隔离与可替换接口

## 摘要与问题边界

在基于 SQLite 的本地数据系统中，大列表的稳定返回不是“写对 `LIMIT`/`OFFSET`”就能解决的语言细节问题，而是涉及排序契约、并发可见性与接口抽象的架构问题。当用户在浏览长列表的同时，后台写入、同步合并或定时清理正在修改底层表，传统的 `OFFSET` 分页会因为行号整体漂移而出现重复项、遗漏项或顺序跳动。本文的边界限定为：单进程或多进程访问同一本地数据库文件时，如何为前端/Web/本地文件知识库提供稳定、可替换、可演化的分页接口；不涉及全文检索引擎、跨设备同步冲突消解或分布式分片。

## 核心概念与数据模型

1. **逻辑页**：用户请求中的“第 N 页”是业务概念，不应直接映射为 SQL 的 `OFFSET`。逻辑页由一组排序谓词和游标状态共同定义。

2. **稳定排序键**：排序必须依赖一列或多列“稳定键”。若仅按 `updated_at` 排序，当两条记录时间戳相同时，返回顺序将依赖 SQLite 的内部访问路径，导致非确定性。

3. **决胜键**：当排序键无法区分两行时，必须引入全局唯一的决胜键，通常是 `rowid` 或业务主键，并在查询的 `WHERE` 与 `ORDER BY` 中同时使用，使总序严格化。

4. **游标页**：服务端不返回“页码”，而是返回编码后的最后一行稳定键元组。下一页查询用 `WHERE (sort_key, tie_breaker) > (last_sort, last_tie)` 替代 `OFFSET`。

5. **快照边界**：SQLite 的单个读事务在 `BEGIN` 时看到一致的快照。分页接口应当在一次事务内完成本页读取与游标计算，或在应用层引入版本号/数据版本向量，以识别前后页是否跨越了写入窗口。

6. **写入抖动**：在 `OFFSET` 模式下，如果第 0 页读取后、第 1 页读取前插入了排在当前页之前的行，后续页的 `OFFSET` 起点相对于原始数据集已经发生位移，于是同一行可能在两页中重复出现。

7. **可替换驱动**：业务代码只依赖一个分页端口的抽象契约，具体实现可以是 SQLite、LibSQL、DuckDB 或内存数组。契约包括 `PageRequest`、`Cursor`、`PageResult<T>`、`hasMore` 和错误码。

8. **计数契约**： total count 与 `hasMore` 是两个不同的能力。前者需要全表扫描或维护物化计数，后者只需多取一行即可判断，架构上应分别声明。

## 设计决策与取舍

### 1. 生产列表禁用 `OFFSET`，仅保留小范围离线导出

`OFFSET` 在架构上适合一次性脚本、测试 fixture 或小规模管理后台。面向用户的大列表必须采用游标分页，除非能证明总数据量永远低于经验阈值且写入频率极低。

### 2. 稳定键优先于显示字段

不要让 UI 的“按修改时间”直接变成 SQL 排序。应设计一个不可为空的 `sort_key`，通常是整数毫秒时间戳或顺序整数，并与 `rowid` 组合成 `(sort_key, rowid)`。这样即使 `sort_key` 相同，`rowid` 仍保证全序。

### 3. 不强制返回 total count

total count 会破坏“稳定返回”的语义：在两次翻页之间，写入可能使总数变化，导致 UI 的“共 1000 条”与实际浏览结果不一致。架构接口应把 `totalCount` 标记为可选能力，由调用方显式请求；默认只返回 `hasMore`。

### 4. 单次读事务内的页内一致性

游标分页无法阻止两次请求之间发生写入，但可以保证“同一页内部”的行集合不自我矛盾。实现层应在 `BEGIN IMMEDIATE`/`DEFERRED` 事务内执行 `SELECT ... LIMIT N+1`，计算完游标后立即提交或回滚。

### 5. 归一化排序键，避免 locale 排序导致的抖动

如果按文本列排序，不同 SQLite 编译选项或 ICU 扩展可能产生不同的比较结果。架构上应把文本列映射为已归一化的二进制排序键，例如 `sortable_title`，确保任何构建产物下的排序一致。

### 6. 接口版本先于模式迁移

游标是跨越请求的持久化状态，其编码格式属于接口契约。即使数据库模式改变，旧游标仍应能被识别为“不兼容”并优雅降级到首页，而不是被静默误解。

## 可执行的实施流程

1. 在仓库层定义分页端口：`interface PagingRepo<T> { firstPage(req: PageRequest): Promise<PageResult<T>>; nextPage(cursor: Cursor, size: number): Promise<PageResult<T>>; }`。

2. 为每个列表视图选定稳定排序键与决胜键，写入 schema 注释，并在单元测试里断言相同数据、相同请求产生一致的游标。

3. 实现游标编码器：将 `[sort_key, rowid]` 序列化为 URL-safe base64 的 JSON 或固定字段二进制，携带一个版本号字节。

4. 实现 `firstPage`：根据 `PageRequest` 构建 `ORDER BY sort_key, rowid LIMIT size+1`，返回前 `size` 行；若多取到一行，则生成下一页游标。

5. 实现 `nextPage`：先解码游标，校验版本；若版本不匹配则返回“首页”并记录 `cursor_incompatible` 指标。

6. 在 `nextPage` 的 SQL 中使用 `WHERE (sort_key > ?) OR (sort_key = ? AND rowid > ?)`，配合 `ORDER BY sort_key, rowid LIMIT size+1`。

7. 将分页查询封装在只读事务中，确保同一页内读取与游标计算看到同一快照。

8. 为每个列表视图建立覆盖索引 `(sort_key, rowid)` 或 `(sort_key, tie_breaker, 查询列...)`，并定期用 `EXPLAIN QUERY PLAN` 验证没有出现全表扫描或临时排序。

9. 在 CI 中构造抖动测试：写入线程持续插入/删除，读取线程连续翻页并验证无重复、无遗漏、无倒序。

10. 在 API/事件总线中输出指标：`page_latency_ms`、`rows_scanned_per_page`、`duplicate_row_rate`、`cursor_decode_failure`、`version_mismatch_rate`。

## 代码示例：本地文件知识库的目录分页

下面展示一次 TypeScript 驱动的查询请求与响应，数据来自本地 SQLite 文件知识库的 `notes` 表。

    // 输入：PageRequest
    {
      "view": "notes_by_mtime",
      "pageSize": 20,
      "direction": "forward"
    }

    // 处理层生成的 SQL（参数化）
    SELECT id, mtime, title, path
    FROM notes
    WHERE mtime > :last_mtime
       OR (mtime = :last_mtime AND rowid > :last_rowid)
    ORDER BY mtime ASC, rowid ASC
    LIMIT :page_size + 1

    // 输出：PageResult<Note>
    {
      "items": [ /* 20 条记录 */ ],
      "cursor": "eyJ2IjoxLCJzIjoxNzE1NDMyMTAwLCJyIjo0MDk2fQ==",
      "hasMore": true,
      "fetchedAtVersion": 42
    }

输入明确请求一个按修改时间升序的视图。处理层把游标解码为 `{ v: 1, s: 1715432100, r: 4096 }`，其中 `s` 是排序键 `mtime`、`r` 是决胜键 `rowid`。SQL 的 `WHERE` 子句避免 `OFFSET`，直接定位到上一页结束位置；`LIMIT pageSize + 1` 多取一行用于推断 `hasMore`。输出中的 `cursor` 供下一次 `nextPage` 使用，`fetchedAtVersion` 表示读取时的数据库逻辑版本，便于前端检测是否需要刷新。

## 性能、质量和可观测性指标

1. **首页/下一页延迟 p95/p99**：在目标硬件上测量从收到请求到返回首字节的时间。游标分页应保持稳定，不随页深度增长。

2. **每页扫描行数与返回行数之比**：通过 `EXPLAIN` 或 SQLite 的 `sqlite3_trace` 获取扫描计数，目标值接近 1.0。比值显著增大说明缺少覆盖索引或使用了 `OFFSET`。

3. **重复行率**：在测试与生产日志中计算同一分页会话内出现相同主键的次数，目标为零。

4. **游标解码失败率**：监控 `cursor` 无法解析、版本不匹配或字段缺失的比例，用于判断是否需要保留旧解码器。

5. **版本不匹配率**：当 `fetchedAtVersion` 与当前数据库版本差超过阈值时触发“数据可能已变更”提示，统计其出现频率。

6. **查询计划回退告警**：对生产查询计划做快照，若出现 `USE TEMP B-TREE FOR ORDER BY` 或 `SCAN TABLE`，立即告警。

## 失败模式、诊断证据与恢复动作

1. **重复记录**：诊断证据为同一 `id` 出现在相邻两页。通常因排序键相同且缺少决胜键，或游标只记录了 `sort_key`。恢复动作：在 `ORDER BY` 与游标中追加 `rowid`，并重放测试验证抖动场景。

2. **记录遗漏**：诊断证据为按条件筛选的总数在两次翻页间减少且中间行消失。通常因 `OFFSET` 分页遇到前置插入或删除。恢复动作：切换为游标分页，或在关键读取路径使用快照事务。

3. **顺序跳动**：诊断证据为相同请求在不写入时返回不同顺序。通常因文本 collation 或浮点排序键不稳定。恢复动作：将排序键改为整数或规范化二进制键，并统一数据库编译选项。

4. **游标不可解码**：诊断证据为 `nextPage` 抛出版本错误或字段错误。通常因游标格式升级。恢复动作：返回首页并提示用户刷新，保留旧版本解码器作为只读降级。

5. **深页查询变慢**：诊断证据为页码越深延迟越高，扫描行数线性增长。通常因仍使用 `OFFSET`。恢复动作：重构为游标，并新增覆盖索引。

6. **跨会话不一致**：诊断证据为用户返回列表后继续看到旧项或新项突然插入当前页。通常因前后页不在同一快照且写入频繁。恢复动作：在会话中传递 `fetchedAtVersion`，当版本变化时前端主动重取首页。

## 问答测试样例

1. **正向**：为什么游标分页比 `OFFSET` 更稳定？
   答：游标以最后一条记录的有序键为起点，新插入的行只影响后续页，不会使已返回行的位置发生位移。

2. **正向**：游标中必须包含哪些字段？
   答：排序键值、唯一决胜键值、游标格式版本号，以及可选的数据库读取版本。

3. **边界**：如果两条记录 `mtime` 相同，`rowid` 不同，如何确保不重复？
   答：`ORDER BY mtime ASC, rowid ASC`，游标必须同时记录 `mtime` 与 `rowid`，下一页条件为 `(mtime, rowid) > (?, ?)`。

4. **边界**：页大小为 0 时应当如何处理？
   答：接口应拒绝或视为无效请求，返回 `page_size_too_small`，不执行查询。

5. **拒答条件**：游标分页是否能保证用户看到“所有未来写入”？
   答：无法保证。游标分页只保证已返回集合内部的稳定性与顺序；后续写入是否可见取决于请求时机，不能推断实时一致性。

6. **拒答条件**：如果不加事务，SQLite 游标分页是否一定零遗漏？
   答：无法得出“一定”结论。游标分页消除 `OFFSET` 漂移，但单页内部若跨多个查询仍可能看到部分结果；完整快照依赖事务或版本机制。

## 维护、版本、来源与相邻主题

- **维护**：把覆盖索引、游标格式版本、排序键类型纳入 schema 审查清单。每次添加新列表视图时，必须同时提交 `EXPLAIN QUERY PLAN` 输出与抖动测试用例。
- **版本**：游标编码格式应使用显式版本号；升级时保留上一个版本的解码器至少一个发布周期，确保旧会话不崩溃。
- **来源**：SQLite 官方文档的查询规划器说明、事务隔离语义，以及本地优先软件中常见的“游标/seek 分页”实践构成本文设计基础。
- **相邻关系**：本主题依赖于“索引与查询计划”以保障性能，与“模式迁移”共享版本契约，与“全文搜索”在排序键选择上可能冲突，与“同步与 CRDT”在并发写入时需要协调版本向量，与“备份与恢复”共享对 `rowid` 稳定性的假设。

## 结论

- **事实**：在写入并发环境下，`OFFSET` 分页会因为行集合整体位移而产生重复或遗漏；SQLite 的单个读事务提供一致的快照视图；`(sort_key, rowid)` 组合可以构造严格全序。
- **推论**：对于面向用户的大列表，架构上应优先采用游标分页、决胜键、`hasMore` 而非 total count，并把分页逻辑封装为可替换的仓库端口。
- **未知**：具体应用的“可接受不一致窗口”取决于业务场景，无法由通用架构给出；SQLite 在不同编译选项下的 collation 行为、极端碎片化文件中的 `rowid` 复用策略，以及前端缓存与本地数据版本之间的最佳协调协议，都需要针对具体实现进行测量与验证。
