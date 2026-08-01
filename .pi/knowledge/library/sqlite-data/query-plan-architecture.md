---
type: concept
title: 查询计划：架构视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。从 EXPLAIN、索引选择和扫描行数定位慢查询
resource: .pi/knowledge/library/sqlite-data/query-plan-architecture.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, query-plan, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: query-plan
variant: architecture
---

# SQLite 查询计划：从 EXPLAIN 与扫描行数定位慢查询的架构方法

## 摘要与问题边界

SQLite 作为进程内嵌入式数据库，其查询优化器不具备独立服务层的网络开销，却直接把计划质量绑定到应用进程的 CPU 与 I/O 路径上。在本地文件知识库、Electron/TypeScript 桌面应用、浏览器 IndexedDB 后端封装等场景里，慢查询不会表现为远程连接超时，而会以主线程阻塞、文件句柄抖动、启动耗时激增的形式反馈。本文把问题边界限定在“单进程、单文件、B-tree 页面级”的 SQLite 实例，重点讨论如何借助 EXPLAIN 与 EXPLAIN QUERY PLAN 区分全表扫描与索引扫描，并通过估算扫描行数（rows examined）定位真正需要重构的查询。我们不覆盖 WAL 模式下的并发调度、虚拟表扩展、 nor FTS5 的全文检索计划，这三者与通用查询计划属于相邻但独立的设计域。

## 核心概念与数据模型

1. **查询计划是优化器对关系代数树的一次物理实现承诺**：SQLite 使用基于成本（cost-based）的优化器，把 SQL 解析成 opcode 序列（vdbe）后再执行；EXPLAIN 输出这些 opcode，EXPLAIN QUERY PLAN 输出算子层级。

2. **B-tree 页面是成本估算的原子单位**：无论是表还是索引，SQLite 都统一使用 B-tree 存储。优化器估算成本时以“读取一个 4 KiB 页面”为基本代价，而非行数本身。

3. **索引覆盖扫描（covering index）可避免回表**：当索引列包含查询所需全部字段时，计划仅访问索引 B-tree，不需要再回到主表 B-tree 拉取数据。

4. **rowid 是表 B-tree 的隐式聚集键**：普通表按 rowid 组织；WITHOUT ROWID 表则按显式主键聚集。索引叶节点存储的是指向 rowid 或主键的引用，这是判断回表开销的关键。

5. **sqlite3_stat 系列表存放优化器统计信息**：运行 ANALYZE 后，sqlite_stat1 记录每个索引的列值分布采样，sqlite_stat4 记录更细粒度的直方图。优化器依赖这些统计量选择索引。

6. **扫描行数与结果行数必须分开计数**：EXPLAIN QUERY PLAN 的“扫描行数”指执行过程中需要读取并评估谓词的输入行数，最终返回给客户端的行数可能因 WHERE 过滤而显著 smaller。

7. **SQLite 不会自动重新收集统计信息**：当表数据发生大幅变化后，旧统计会导致优化器低估全表扫描成本或选择错误索引，必须由应用层触发 ANALYZE 或重新采样。

## 设计决策与取舍

### 把 EXPLAIN 调用纳入 CI 而非仅手动调试
架构上应将 EXPLAIN QUERY PLAN 输出纳入自动测试：在提交 SQL 变更时断言关键查询不会出现 SCAN TABLE。其代价是 schema 演进后需要同步更新 golden plan，但可防止慢查询随版本泄漏。

### 索引数量与写放大之间的平衡
每新增一个索引，INSERT/UPDATE/DELETE 就需要维护额外的 B-tree。对于本地知识库这类写少读多的场景，索引收益高；但对于频繁同步的日志型表，应优先保留覆盖查询的最小索引集。

### 复合索引列顺序由选择性最高的谓词决定
复合索引 `(a, b, c)` 只能服务从 a 开始的等值谓词前缀。把高选择性列放在最前可显著降低扫描行数；把低选择性列放前则会导致索引扫描区间过大。

### 强制索引（INDEXED BY）是逃生通道而非默认策略
INDEXED BY 可锁定计划，但会丧失优化器未来自动改进的能力。应仅在已验证存在优化器 bug 或直方图失真的特殊查询上使用，并通过注释说明恢复条件。

### 统计信息采样与启动时延的权衡
ANALYZE 在大型数据库上可能耗时数秒。对于桌面应用，应在首次安装或检测到行数变化超过阈值（如 20%）后后台执行，而不是每次启动都阻塞采样。

## 可执行的实施流程

1. 在应用启动或 schema 迁移完成后，校验目标数据库存在并确认 SQLite 版本不低于 3.35.0，以使用现代 EXPLAIN QUERY PLAN 输出格式。
2. 对慢查询原型执行 `EXPLAIN QUERY PLAN <query>`，记录每个算子的 `detail` 字段。
3. 识别 `SCAN` 与 `SEARCH` 算子：前者表示全表扫描或全索引扫描，后者表示利用索引范围定位。
4. 在 `SEARCH` 算子中检查索引名称是否命中预期索引；未命中则检查是否存在选择性更高的候选索引。
5. 对疑似慢查询执行 `EXPLAIN <query>`，读取 `opcode` 列中的 `SeekGE`、`SeekLT`、`Column`、`ResultRow` 等指令，确认实际访问路径。
6. 在开发构建中启用 `PRAGMA count_changes = 0` 后，用 `sqlite3_stmt_status(SQLITE_STMTSTATUS_VM_STEP)` 统计实际步数，与估算行数对比。
7. 当估算偏离实际超过 5 倍时，对受影响表运行 `ANALYZE [table_name]`，或设置 `PRAGMA analysis_limit = 1000` 做增量采样。
8. 在回归测试中添加计划断言：例如断言 `EXPLAIN QUERY PLAN` 结果集中不包含 `SCAN TABLE documents`。
9. 对修复后的查询重新执行 EXPLAIN，确认扫描行数估算下降且 opcode 序列不再出现全表扫描指令。
10. 将优化后计划、索引 DDL 与测试断言一并提交，并在变更日志中记录慢查询症状与触发版本。

## 示例：本地文件知识库中的查询计划诊断

```yaml
# 输入：应用配置文件片段
db:
  path: "./knowledge.db"
  schema_version: 7
queries:
  recent_notes:
    sql: |
      SELECT id, title, updated_at
      FROM notes
      WHERE user_id = ? AND updated_at > ?
      ORDER BY updated_at DESC
      LIMIT 50
    expected_index: "idx_notes_user_updated"

# 处理：TypeScript 端在调试构建中自动捕获计划
function assertQueryPlan(
  db: Database,
  sql: string,
  forbidden: string[]
) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{detail: string}>;
  const bad = plan.filter(p => forbidden.some(f => p.detail.includes(f)));
  if (bad.length > 0) throw new Error(`Unexpected scan: ${JSON.stringify(bad)}`);
}

# 输出：检测全表扫描时抛出异常
assertQueryPlan(db, sql, ["SCAN TABLE notes"]);
```

该示例的输入是 YAML 中声明的查询与预期索引；处理层由 SQLite 返回 EXPLAIN QUERY PLAN 文本，TypeScript 做断言解析；输出是开发期即时失败，阻止慢查询进入发布版本。

## 性能、质量和可观测性指标

1. **扫描行数估算准确率**：计算 `abs(estimated_rows - actual_rows) / actual_rows`，目标小于 2。测量方法为在执行前后分别读取 EXPLAIN 估算值与 `sqlite3_stmt_status` 实际步数。
2. **计划稳定率**：同一查询在相同数据分布下连续 10 次 EXPLAIN 输出一致的比例。低于 100% 说明优化器依赖非确定性统计或阈值。
3. **索引命中率**：监控周期内使用索引 SEARCH 的查询占比。对于读密集型知识库，应高于 90%。
4. **慢查询阈值触发次数**：单查询执行时间超过 16 ms 的计数。通过 `performance.now()` 或 SQLite 的 `sqlite3_trace_v2` 收集。
5. **ANALYZE 滞后时间**：上次 ANALYZE 至今的数据行变化比例。超过 20% 时标记为需重新采样。
6. **回归测试计划断言覆盖率**：包含 EXPLAIN 断言的查询数量占总慢查询候选集的比例。目标不低于 80%。

## 失败模式、诊断证据与恢复动作

1. **全表扫描未被索引消除**
   - 证据：EXPLAIN QUERY PLAN 出现 `SCAN TABLE notes`，且估算行数接近表总行数。
   - 恢复：检查 WHERE 列是否左函数化（如 `LOWER(title)`），或索引缺失；创建函数索引等价表达式或新增单列/复合索引。

2. **优化器选择错误索引**
   - 证据：SEARCH 使用了非预期索引，实际执行时间比强制使用目标索引慢 5 倍以上。
   - 恢复：运行 ANALYZE 更新统计；若仍错误，用 INDEXED BY 临时锁定，并跟踪 SQLite 版本升级计划。

3. **统计失真导致估算行数严重偏低**
   - 证据：EXPLAIN 估算 10 行，实际执行 10000 行。
   - 恢复：增大采样直方图槽数 `PRAGMA analysis_limit`，分表执行 ANALYZE，或重写查询谓词以匹配现有统计区间。

4. **复合索引前缀失效**
   - 证据：WHERE 使用 `updated_at > ?` 但复合索引为 `(user_id, updated_at)`，缺少 `user_id` 谓词导致 SCAN。
   - 恢复：将查询拆分为 `user_id IN (...)` 子集，或添加针对 updated_at 的独立索引。

5. **ORDER BY 导致隐式全表排序**
   - 证据：EXPLAIN 出现 `USE TEMP B-TREE FOR ORDER BY`，大结果集排序耗时显著。
   - 恢复：创建覆盖 ORDER BY 列的索引，使优化器采用 `SCAN INDEX` 避免物化排序。

## 问答测试样例

1. **正向**：EXPLAIN QUERY PLAN 输出中的 `SCAN TABLE` 代表什么？答：优化器决定按顺序读取整个表 B-tree 的所有页面，不利用索引范围定位。
2. **正向**：为什么 ANALYZE 后查询会变快？答：sqlite_stat1 和 sqlite_stat4 中的统计信息让优化器更准确地估算不同索引的扫描成本，从而选择更优计划。
3. **边界**：是否所有 SEARCH 都优于 SCAN？答：否。如果索引选择性极低，SEARCH 索引后回表的大量随机 I/O 可能不如全表顺序扫描。
4. **边界**：LIMIT 能否改变计划选择？答：能。LIMIT 常与 ORDER BY 结合，优化器可能选择覆盖索引以避免排序，即使扫描行数略高。
5. **边界**：复合索引 `(a, b)` 能否加速 `WHERE b = ?`？答：不能单独利用，除非同时存在 `a = ?` 谓词或改为 `(b, ...)` 索引。
6. **无证据拒答**：当前 SQLite 实例是否使用磁盘加密？答：无法从 EXPLAIN 输出推断，需查询 PRAGMA 或检查文件系统层配置。

## 维护、版本、来源与相邻主题

查询计划相关代码与 schema 应遵循同一版本号。每次 schema 迁移（CREATE INDEX、ALTER TABLE 等）都应在 `migrations/` 目录中附带一个 `*.plan` 文件，记录该版本下关键查询的 EXPLAIN 输出。CI 通过 `pnpm typecheck` 与 `pnpm test` 运行计划断言。来源以 SQLite 官方文档（Query Planner、EXPLAIN、ANALYZE）和 installed SQLite 版本为准，避免假设未来版本行为。

相邻主题包括：事务与 WAL 并发控制（影响计划可见性与读视图）、FTS5 全文检索计划（使用不同算子模型）、参数化查询与绑定（影响计划缓存）、Schema 迁移策略（索引创建顺序决定数据分布）。这些主题与查询计划共享同一数据库文件，但各自有独立优化目标和可观测接口。

## 结论

**事实**：EXPLAIN 输出由 SQLite 优化器依据 schema、统计与 PRAGMA 生成；B-tree 页面读取是成本估算的基本单位；ANALYZE 生成统计但不自动刷新。

**推论**：在本地文件知识库中，把 EXPLAIN 断言嵌入 CI 比依赖用户报告慢查询更具成本效益；扫描行数估算与实测偏差大于 2 倍时应优先重新采样统计而非立即加索引。

**未知**：具体业务数据分布下每个索引的真实选择性收益、未来 SQLite 版本对成本模型的调整、以及极端碎片化页面下的实际 I/O 延迟，均需在生产或准生产环境中通过 `sqlite3_stmt_status` 和真实文件测量验证。
