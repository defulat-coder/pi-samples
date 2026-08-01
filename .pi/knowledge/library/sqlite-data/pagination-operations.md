---
type: concept
title: 分页与排序：验证与运维视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。稳定地返回大列表，避免 offset 抖动和重复数据
resource: .pi/knowledge/library/sqlite-data/pagination-operations.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, pagination, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: pagination
variant: operations
---

# SQLite 本地大列表分页与排序的稳定性运维实践

## 摘要与问题边界

在基于 TypeScript/Web 的本地文件知识库中，SQLite 通常作为单一本地文件承载万级到百万级记录。大列表分页若沿用 `OFFSET + LIMIT`，在并发生成、排序字段更新或事务未提交时，会出现“offset 抖动”：同一页重复出现前页记录、漏掉刚插入的行，或因为总行数变化导致页码整体漂移。本文从验证与运维视角出发，不讨论分布式分片、全文检索相关性排序或跨设备同步冲突，而是聚焦于“在单写多读、本地文件约束下，如何稳定地返回大列表”，并给出可重复观测的证据、边界判断与恢复动作。

## 核心概念与数据模型

1. 排序键必须是逻辑唯一组合。仅按 `updated_at` 排序时，多行时间戳相同会产生不确定顺序，翻页时极易重复。必须引入不可变主键 `id` 作为 tie-breaker，形成 `(updated_at, id)` 这样的排序向量。
2. B-tree 索引决定查询顺序。SQLite 的复合索引 `(updated_at DESC, id DESC)` 让引擎按目标顺序直接遍历，避免额外排序；若查询方向与索引方向不一致，则会出现隐式反转或临时排序，增加延迟。
3. 游标分页优于 offset 分页。Keyset pagination 用上一页最后一行的排序键值作为下一页条件，例如 `WHERE (updated_at, id) < (?, ?)`，插入发生在已读区域之外时不会抖动。
4. 事务隔离是 SQLite 的 read committed。默认读取不会锁定写操作，写操作也不会阻塞读，但读取过程中写入提交，下一页可能看到新行；这不等于“重复”，而是“可见性漂移”，必须在运维语义中记录。
5. 重复与漏行主要源于排序键更新。若某行 `updated_at` 在翻页过程中被更新到前页方向，它可能再次出现；若被删除，则下一页条件可能跳过空位，造成“漏行”感。
6. WAL 模式改变 I/O 与可见性。启用 `PRAGMA journal_mode=WAL` 后，读取与写入可以并发，但 checkpoint 会触发 I/O 峰值；长期未 checkpoint 的 WAL 文件增长会导致首次查询耗时突增。
7. 本地文件约束包含文件锁、路径权限和磁盘空间。当多个进程或标签页同时打开同一数据库时，写入方会获取 RESERVED/EXCLUSIVE 锁，读取方可能因 `busy_timeout` 过短而失败。
8. 可验证快照要求记录“页边界证据”。每次返回列表时应附带上一页最后键值、当前查询计划、扫描行数和响应时间，作为后续排查是否“重复/漏行”的审计线索。

## 设计决策与取舍

### 排序键必须覆盖查询过滤条件
如果分页查询还带有 `WHERE tag = 'sqlite'`，而索引只有 `(updated_at, id)`，引擎会先按索引扫描再过滤，导致每页返回行数不稳定。应建立 `(tag, updated_at, id)` 复合索引，或确保过滤条件前缀与索引前缀一致，否则页产出率会不可预测。

### 游标状态不能放在客户端 URL 中
把游标编码为 base64 JSON 放在 URL 中可简化刷新，但存在篡改风险：用户修改游标值后会触发异常扫描。服务端/本地主进程中应维护游标解析与校验逻辑，并在游标失效时返回明确错误码，而不是静默回退。

### 覆盖索引优先于回表
当列表需要展示 `title`、`updated_at`、`id` 时，如果索引包含这三个列，查询可以走 covering index，避免回表读取数据页。覆盖索引的代价是写入稍慢和磁盘稍大，但在大列表高频翻页场景下，I/O 次数的减少比索引写入成本更关键。

### 事务边界应保守
建议分页读取使用 `BEGIN DEFERRED` 只读事务，并在单页内完成。跨多页保持长事务可获得一致性快照，但会阻塞 WAL checkpoint 和写入，不适合 Web 场景。因此接受“页与页之间可见性可能变化”，但保证单页内顺序稳定。

### 重试必须幂等
当查询因 `SQLITE_BUSY` 失败时，简单重试同一条游标查询可能拿到不同结果，因为排序键可能已被更新。重试逻辑应记录“重试次数 + 游标版本”，若版本变化则标记“不一致”并建议客户端刷新首页。

## 可执行的实施流程

1. 在 schema 中选定不可变主键 `id` 和单调排序字段 `updated_at`，明确二者不可单独作为排序键，必须组合为 `(updated_at, id)`。
2. 创建覆盖索引：`CREATE INDEX idx_notes_list ON notes(tag, updated_at DESC, id DESC)`，确保过滤与排序共享前缀。
3. 定义游标结构：包含 `last_updated_at`、`last_id`、`direction`、`sort_vector_hash`，并用 base64url 编码。
4. 生成下一页查询：对 DESC 方向使用 `WHERE (updated_at < ?) OR (updated_at = ? AND id < ?)`，并追加 `LIMIT page_size + 1`。
5. 返回 `page_size` 行，若多取 1 行则判定为 `has_next=true`，同时丢弃额外行。
6. 在每次查询前后记录审计日志：查询计划、扫描行数、实际返回行数、耗时、游标版本。
7. 设置 `PRAGMA busy_timeout = 5000` 与 `PRAGMA journal_mode=WAL`，并监控 `PRAGMA wal_checkpoint(TRUNCATE)` 的触发频率。
8. 注入故障测试：在翻页过程中插入新行、更新排序字段、删除行、VACUUM、文件只读挂载，验证系统是否返回重复、漏行或明确错误。
9. 实现游标失效恢复：当解码失败或首行不匹配游标时，返回 `CURSOR_INVALID` 并让客户端重新请求首页。
10. 在 CI 中运行“连续翻页一致性断言”：将全量数据按分页完整遍历一次，与 `SELECT * ORDER BY` 全表结果对比，验证无重复无漏行。

## 贴近本地文件知识库的分页请求示例

    {
      "query": {
        "table": "notes",
        "select": ["id", "title", "updated_at", "tag"],
        "filter": { "tag": "sqlite" },
        "order_by": ["updated_at DESC", "id DESC"],
        "cursor": {
          "last_updated_at": "2024-05-20T09:12:00Z",
          "last_id": 4213,
          "version": "v2"
        },
        "limit": 50
      },
      "checks": {
        "pre": "BEGIN DEFERRED; EXPLAIN QUERY PLAN ...",
        "post": "assert row_count <= 50; assert last_row matches cursor for next page"
      },
      "expected": {
        "rows": "最多 50 条",
        "has_next": "由第 51 条是否存在决定",
        "next_cursor": "基于第 50 条排序键生成"
      }
    }

输入是本地 SQLite 文件路径、表过滤条件、编码游标与页大小；处理过程按复合索引顺序扫描，应用过滤与游标边界，多取一行判定是否有下一页；输出是列表、下一页游标以及查询计划审计字段。运维侧通过比对 `EXPLAIN QUERY PLAN` 确认是否走了覆盖索引，而不是临时排序。

## 性能、质量与可观测性指标

1. 端到端查询耗时：p50 与 p99，通过 Node.js `performance.now()` 或 Web Worker 的 `Date.now()` 在请求前后采样；若 p99 超过 100ms，应触发索引复核。
2. 索引扫描比例：每次查询记录 `EXPLAIN QUERY PLAN` 中的 `USING INDEX` 或 `USING COVERING INDEX`，低于 90% 覆盖索引率需告警。
3. 重复/漏行率：在完整遍历测试中，用集合去重判断重复，用总行数对比判断漏行；目标为 0，任一非零即视为回归。
4. 页产出率：实际返回行数 / 请求 `limit`，若连续低于 80% 说明过滤条件未纳入索引前缀。
5. 游标失效与恢复次数：统计 `CURSOR_INVALID` 和首页回退次数，异常升高意味着排序字段更新过频或游标编码脆弱。
6. 文件锁等待时间：监控 `SQLITE_BUSY` 发生次数与累计等待，WAL 模式下应显著低于回滚日志模式。

## 失败模式、诊断证据与恢复动作

### 排序键更新导致重复
某行在翻页间隙把 `updated_at` 改得更新，下一页条件会再次满足该行，客户端看到重复。诊断证据：两行记录 `id` 相同但 `updated_at` 不同；恢复动作：在列表 UI 中按 `id` 去重，并记录“更新漂移”事件。

### 非唯一排序键导致顺序不确定
如果排序向量为单一 `updated_at`，同时间戳的行在不同查询中顺序可能不同。诊断证据：相同查询返回的行顺序不一致；恢复动作：强制加上 `id` 作为 tie-breaker，并重新建复合索引。

### 并发写入导致读取超时
写入方长时间持有 EXCLUSIVE 锁，读取方在 `busy_timeout` 内未获得锁。诊断证据：日志出现 `SQLITE_BUSY`，且等待时间接近 `busy_timeout`；恢复动作：增大 `busy_timeout`，将重索引/大批量写入放入单独事务，或引入写入队列。

### 文件损坏或 WAL 异常
断电或异常关闭后，`-wal` 文件残留，首次连接可能触发 `SQLITE_CORRUPT` 或自动恢复。诊断证据：打开数据库时错误码或校验失败；恢复动作：从备份恢复，或运行 `PRAGMA integrity_check`，禁止直接删除 WAL 文件。

### 页大小过大导致 UI 帧延迟
`limit=500` 在数据页未缓存时造成一次性读取大量行，阻塞渲染线程。诊断证据：主线程或 Worker 中任务耗时超过 16ms；恢复动作：根据观测将 `limit` 降至 50 或 100，并把查询放入 Web Worker。

### 游标被篡改或版本不兼容
客户端修改游标中的 `last_id` 后，查询可能返回空集或异常数据。诊断证据：解码游标失败或首行不满足边界条件；恢复动作：服务端校验游标签名/版本，失败后返回 `CURSOR_INVALID`，不尝试猜测。

## 问答测试样例

**Q1：如何验证分页不会抖动？**
A：在持续写入负载下连续翻页，对比完整遍历结果与 `SELECT * ORDER BY updated_at DESC, id DESC` 的全表结果，二者必须完全一致。

**Q2：所有行的 `updated_at` 都相同时怎么办？**
A：必须引入 `id` 作为 tie-breaker，否则同一页结果在不同查询间可能不一致，无法保证稳定排序。

**Q3：游标指向的行被删除后，下一页会漏行吗？**
A：会。keyset 条件跳过已删除行，下一页首行是排序上严格小于游标的下一行，因此缺失一行。应在恢复动作中返回首页并重新定位。

**Q4：WAL 模式是否一定能消除重复？**
A：不能。WAL 解决的是读写并发阻塞问题，而不是排序语义问题；重复仍由排序键更新或游标设计缺陷导致。

**Q5：p99 查询延迟突增，如何定位？**
A：检查 `EXPLAIN QUERY PLAN` 是否从覆盖索引退化为临时排序或全表扫描，同时检查 WAL 文件大小与最近一次 checkpoint 时间。

**Q6：SQLite 是否在所有版本都支持 RETURNING 子句以返回更新后游标？**
A：本文无法提供该版本支持证据；在未确认具体 SQLite 版本与构建配置前，不应依赖该特性作为分页稳定性设计的一部分。

## 维护、版本、来源与相邻主题的关系

- **Schema 迁移**：新增过滤或排序字段时，需同步重建复合索引，否则分页会退化。迁移脚本应包含 `EXPLAIN QUERY PLAN` 回归断言。
- **SQLite 版本差异**：不同 Electron 或 Node.js 环境绑定的 SQLite 版本不同，WAL 行为、`EXPLAIN` 输出格式和默认 busy 处理可能不同；运维记录应写明测试版本。
- **VACUUM 与页碎片化**：长期大量删除后，B-tree 页碎片化会增加 I/O；VACUUM 会重建文件，但会暂时获得写锁，应在低峰期执行。
- **相邻主题**：本主题与“本地文件并发写入”“索引设计”“WAL 与 checkpoint”“变更流/事件日志”直接相关；与“全文检索排序”“跨设备同步冲突”相邻但不在本主题范围内。
- **来源证据**：所有结论应来自可重复的本地测试、查询计划、审计日志和故障注入脚本，而非外部在线文档或假设。

## 结论

- **事实**：在单写多读 SQLite 中，offset 分页在写入或排序字段更新时会产生重复与漏行；`(updated_at, id)` 组合排序键加复合索引可消除顺序抖动；`EXPLAIN QUERY PLAN` 和完整遍历测试是验证稳定性的直接证据。
- **推论**：覆盖索引与 WAL 模式能显著降低大列表延迟和锁冲突，但无法自动修复排序键非唯一或游标篡改导致的问题。
- **未知**：不同 SQLite 编译版本、操作系统文件系统、Electron/Web 容器对 `busy_timeout` 与 WAL checkpoint 的实际行为差异，需要针对具体目标环境进行实测；在未获得实测数据前，不能泛化所有平台的最优页大小与锁超时参数。
