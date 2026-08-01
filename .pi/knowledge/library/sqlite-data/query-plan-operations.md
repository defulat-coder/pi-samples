---
type: concept
title: 查询计划：验证与运维视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。从 EXPLAIN、索引选择和扫描行数定位慢查询
resource: .pi/knowledge/library/sqlite-data/query-plan-operations.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, query-plan, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: query-plan
variant: operations
---

# SQLite 查询计划：从 EXPLAIN 到慢查询定位的验证与运维实践

## 摘要与问题边界

本文面向需要在本地 SQLite 环境中观察性能、稳定性和故障恢复的工程师，聚焦“查询计划”这一可观测对象。不讨论 SQL 语法优化或应用层缓存设计，而是围绕 EXPLAIN 与 EXPLAIN QUERY PLAN 的输出，把索引选择、扫描算子和扫描行数作为可复现的诊断证据。边界是：所有结论必须来自可在同一数据库文件上重复执行的步骤；无法复现的个例只记录现象，不推断根因。

## 核心概念与数据模型

1. **EXPLAIN 与 EXPLAIN QUERY PLAN 的分工**
   EXPLAIN 输出 VDBE 操作码，适合判断执行细节；EXPLAIN QUERY PLAN 输出高层算子，更适合定位索引使用。运维优先使用后者，只在怀疑编译器行为时才深入 VDBE。

2. **SQLite 的成本模型**
   优化器在编译语句时由 BestIndex 机制选择访问路径，成本估算基于 `sqlite_stat1` 中的统计信息。统计信息不会自动刷新，必须通过 ANALYZE 更新。

3. **三类扫描算子**
   `SCAN TABLE` 为全表扫描；`SEARCH TABLE USING INDEX` 为索引定位后顺序扫描；`SEARCH TABLE USING COVERING INDEX` 为覆盖索引，无需回表。这是定位慢查询的第一证据。

4. **索引选择的边界**
   优化器仅在 WHERE、JOIN ON、ORDER BY 或 GROUP BY 中的列满足索引前缀时才考虑该索引。函数、隐式类型转换或 LIKE 前缀通配符会使索引失效。索引存在不等于被使用。

5. **扫描行数的语义**
   EXPLAIN QUERY PLAN 不直接输出预计扫描行数，但可通过 `sqlite3_stmt_status(SQLITE_STMTSTATUS_FULLSCAN_STEP)` 采集实际全表扫描步数。估算行数来自统计表。运维中必须区分估算与实测。

6. **准备语句与计划缓存**
   同一 `sqlite3_stmt` 参数变化时通常复用计划，但 ANALYZE 或 schema 变化会触发重新编译。这解释了某些慢查询在 ANALYZE 后自愈也可能复发。

## 设计决策与取舍

### 1. 统计信息刷新策略
ANALYZE 重写 `sqlite_stat1` 与 `sqlite_stat4`。过于频繁会在写密集型负载中引入锁竞争；过慢则导致优化器基于过期数据选择全表扫描。建议按表变化率阈值触发，而非定时全库刷新。

### 2. 索引数量与写放大
每新增一个索引，INSERT/UPDATE/DELETE 就要维护多一份 B-tree。本地知识库若频繁写入，过多索引会降低写吞吐并增大 WAL。应保留高频读且低写入的索引，移除长期未使用的索引。

### 3. 计划稳定性与最优性
SQLite 默认在每次重新编译时按最新统计选择计划。对需要可预测延迟的本地服务，计划突变本身可能成为故障。可用 `INDEXED BY` 提示换取稳定性，代价是可能错过更优计划。

### 4. 诊断侵入性边界
在生产连接上执行 EXPLAIN QUERY PLAN 会短暂持有 schema 锁，事务竞争激烈时可能阻塞 DDL。建议复制数据库文件到只读副本或使用 `sqlite3_snapshot` 离线诊断。

### 5. 可观测粒度
记录每次查询的 EXPLAIN 输出会产生大量数据。只在延迟超过阈值或扫描步数异常时采样完整计划，日常保留聚合指标。

## 可执行的实施流程

1. **冻结复现环境**：记录 SQLite 版本、`PRAGMA compile_options`、schema、WAL 状态与 `sqlite_stat1` 快照。缺少任一项，后续对比都可能失真。

2. **构造最小查询样本**：去掉应用层参数拼装，直接用 EXPLAIN QUERY PLAN 运行原始 SQL。

3. **识别顶层算子**：查看是否出现 `SCAN TABLE`、`SEARCH TABLE` 或 `USE TEMP B-TREE`。大表出现 `SCAN TABLE` 是首要怀疑对象。

4. **定位索引使用**：对每条 `SEARCH TABLE` 记录，确认使用预期索引。若选择意外索引，检查 WHERE 子句类型是否匹配索引列类型。

5. **估算扫描规模**：结合 `sqlite_stat1` 与查询条件估算 B-tree 节点遍历数。对范围查询可用相似条件下 `COUNT(*)` 作为旁证。

6. **实测运行成本**：在测试副本上执行查询，使用 `sqlite3_trace_v2` 或驱动的 `profile` 回调记录 wall-clock 时间与全表扫描步数。

7. **对比索引效果**：在副本上临时创建候选索引，重新执行 EXPLAIN QUERY PLAN，比较算子是否从 `SCAN` 变为 `SEARCH` 或 `COVERING INDEX`。不在生产库做实验。

8. **固化回归用例**：将修复后的查询、计划输出与阈值指标写入测试集，在 schema 变更或版本升级后重跑。

## TypeScript/Web/本地文件知识库示例

    {
      "query_id": "kb_search_20240815_001",
      "sql": "SELECT id, title, updated_at FROM notes WHERE tag = ? ORDER BY updated_at DESC LIMIT 50",
      "environment": {
        "sqlite_version": "3.46.0",
        "wal_mode": true,
        "page_size": 4096
      },
      "plan": [
        { "detail": "SEARCH notes USING INDEX idx_tag_updated (tag=? AND updated_at<?)" }
      ],
      "metrics": {
        "prepared_cache_hits": 12,
        "fullscan_steps": 0,
        "execution_ms": 2.3
      },
      "tags": ["local-first", "sqlite", "query-plan"]
    }

输入是带参数的查询与数据库上下文；处理阶段通过 `better-sqlite3` 执行并采集耗时；输出是包含计划、环境指纹与运行时指标的 JSON，供检索器按 `tag`、`sqlite_version` 或 `fullscan_steps` 召回。

## 性能、质量和可观测性指标

1. **全表扫描步数占比**：调用 `sqlite3_stmt_status(SQLITE_STMTSTATUS_FULLSCAN_STEP)` 并除以返回行数。比值持续高于 100 表明索引选择或过滤条件存在问题。

2. **查询延迟分位值**：对同一语句模板记录 p50、p95、p99。延迟突增而 CPU 未饱和时，优先检查是否退化为全表扫描。

3. **计划变化率**：每次 ANALYZE 或 schema 变更后对核心语句执行 EXPLAIN QUERY PLAN，与基线做文本差异。变化率超过 5% 的语句加入重点观察列表。

4. **索引覆盖率**：统计过去 24 小时被使用的索引与全量索引之比。未被使用的索引是写放大的候选移除对象。

5. **准备语句命中率**：记录 `prepare()` 调用与真正重新编译次数。命中率低于 80% 说明存在连接池配置或频繁 DDL 问题。

## 失败模式、诊断证据与恢复动作

1. **统计信息过期导致计划突变**：证据为计划从 `SEARCH` 退化为 `SCAN`，且 `sqlite_stat1` 采样行数与真实 `COUNT(*)` 偏差超过一个数量级。恢复动作是执行 `ANALYZE table_name` 并建立基于修改行数的自动触发机制。

2. **隐式类型转换使索引失效**：证据为索引列是 `INTEGER` 但查询传入字符串，计划显示 `SCAN TABLE`。恢复动作是修正参数类型并增加 CI 类型检查。

3. **OR 条件导致索引合并失败**：证据为多个索引列通过 OR 连接，计划出现全表扫描或临时 B-tree。恢复动作是重写为 UNION ALL 或评估复合索引。

4. **大事务阻塞计划复现**：证据为查询在只读副本上快、在生产连接上慢，且 WAL checkpoint 显示大量脏页。恢复动作是缩短写事务，诊断时使用只读快照。

5. **缓存页不足引发 I/O 抖动**：证据为全表扫描延迟不稳定、磁盘读取计数高、`cache_size` 较小。恢复动作是提升 `cache_size` 或启用 memory-mapped I/O（只读场景），并监控页错误数。

## 问答测试样例

1. 输出 `SEARCH TABLE notes USING COVERING INDEX idx_title` 时是否需要回表？
   不需要。覆盖索引已包含查询所需全部列。

2. 如何确认查询实际发生了全表扫描？
   计划中显示 `SCAN TABLE`，且运行时 `FULLSCAN_STEP` 显著大于零。

3. LIMIT 10 是否一定减少扫描行数？
   不一定。若 ORDER BY 无法使用索引，SQLite 可能扫描大量行排序后再取前 10 条。

4. WAL 模式下未 checkpoint 的写入是否影响 EXPLAIN 输出？
   不会。EXPLAIN 基于 schema 和统计信息生成计划，不读取数据行。

5. 仅告知查询在 A 库快、B 库慢，能否判断根因？
   不能。缺少版本、schema、统计信息和执行计划，只能给出排查清单。

6. 加索引是否一定能降低延迟？
   不能无条件保证。索引会增加写放大和选择成本，低区分度索引可能被优化器放弃。

## 维护、版本、来源与相邻主题关系

SQLite 3.16.0 起 EXPLAIN QUERY PLAN 输出格式相对稳定，3.36.0 以后对 `sqlite_stat4` 采样算法有调整，升级后应重跑核心计划基线。`sqlite_stat1` 由 `build.c` 和 `analyze.c` 写入，应用不应直接修改。本文内容来自 SQLite 官方 EXPLAIN 与 Query Planner 文档以及源码中的 `where.c`、`vdbe.c`。相邻主题包括索引设计、WAL 与事务隔离、备份恢复一致性、应用层连接池与会话管理。查询计划既是索引设计的结果，也是容量规划的输入。

## 结论

**事实**：EXPLAIN QUERY PLAN 输出 SEARCH/SCAN/COVERING INDEX 等算子；ANALYZE 更新 `sqlite_stat1`；准备语句在 schema 变化时会重新编译。
**推论**：大表查询出现 `SCAN TABLE` 且 `FULLSCAN_STEP` 远高于返回行数时，优化器很可能未选到合适索引，但这不绝对等价于“必须加索引”，因为统计信息过期、类型不匹配或 OR 条件也可能导致该现象。
**未知**：具体业务负载下最优索引组合只能在真实数据分布和访问模式上通过 A/B 测量得出，不能仅凭理论推断。
