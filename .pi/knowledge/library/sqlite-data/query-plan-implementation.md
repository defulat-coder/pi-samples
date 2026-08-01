---
type: concept
title: 查询计划：实现视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。从 EXPLAIN、索引选择和扫描行数定位慢查询
resource: .pi/knowledge/library/sqlite-data/query-plan-implementation.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, query-plan, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: query-plan
variant: implementation
---

# SQLite 查询计划解析与慢查询定位：从 EXPLAIN 到索引选择的实现视角

## 摘要与问题边界

本方案面向需要将 SQLite 慢查询诊断能力落地为 TypeScript 代码的开发者。输入为本地 `.db` 文件副本、待诊断 SQL 文本以及可选的参数绑定；输出为结构化诊断对象，包含算子类型、扫描行数、索引使用状态与可疑项。问题边界限定在 SQLite 3.40 及以上的本地单文件场景，宿主环境为 Node.js、Electron 或 Deno，使用 `better-sqlite3` 或 `node-sqlite3` 等绑定库。不涉及分布式事务、WAL 高并发吞吐优化、FTS5 全文检索、R-Tree 空间索引或虚拟表扩展。诊断目标不是自动改写 SQL，而是输出可验证的观察证据，供开发者据此判断优化方向。

## 核心概念与数据模型

1. **计划行 `plan_row`**：`EXPLAIN QUERY PLAN <sql>` 返回的每一行包含 `id`、`parent`、`notused`、`detail` 四个字段。其中 `detail` 是解析核心，其字段顺序和措辞在 SQLite 3.40+ 中基本稳定，但解析器应使用关键词正则而非硬编码列索引。
2. **算子分类**：扫描类包括 `SCAN TABLE`（全表扫描）、`SEARCH TABLE`（条件查找，通常使用索引）、`SCAN INDEX`（索引全扫描）、`SEARCH INDEX`（索引内查找）。辅助类包括 `USE TEMP B-TREE FOR ORDER BY` 与 `GROUP BY`，表示需要内存排序聚合。
3. **索引使用证据**：只有当 `detail` 中出现 `USING INDEX <name>` 或 `USING COVERING INDEX <name>` 时，才认为该索引被选中。`USING COVERING INDEX` 表示索引覆盖全部查询列，可避免回表。
4. **rowid 高效路径**：`SEARCH TABLE ... USING INTEGER PRIMARY KEY` 是 SQLite 的 rowid 直接查找，属于最高效访问方式，不应被误报为索引缺失。
5. **统计信息来源**：代价估算依赖 `sqlite_stat1`（ANALYZE 后生成）和可选的 `sqlite_stat4`。这些统计表不是实时更新的，VACUUM 或 ANALYZE 后才会刷新。
6. **隐式类型转换**：SQLite 存储弱类型，但查询优化器对比较语义有严格类型要求。若索引列为 `INTEGER` 而查询传入 `TEXT` 字面量，或 `LIKE` 模式以 `%` 开头，优化器通常会放弃索引，导致 `SCAN TABLE`。

## 设计决策与取舍

**选择 EXPLAIN QUERY PLAN 作为默认输入**
`EXPLAIN` 输出虚拟机字节码（opcode、P1/P2/P3/P4/P5），格式随版本变化，解析成本高。`EXPLAIN QUERY PLAN` 是结构化自然语言，更适合正则稳定提取。例外：当需要定位指令级热点（如大量 `Column` 或 `IdxRowid` 反复执行）时，才退回到 `EXPLAIN`。

**输出只读诊断对象，不自动改写 SQL**
自动添加索引或重写 SQL 可能破坏语义，例如将 `LIKE '%foo'` 改为 `MATCH` 会引入 FTS 依赖。工具只输出 `recommendations` 列表，由开发者在副本库上验证。边界：如果 SQL 包含子查询或窗口函数，优化建议必须限制为统计信息更新与索引检查，避免语义变化。

**行数估算优先使用 COUNT\***
`sqlite_stat1` 在 ANALYZE 后生成，可能过期。对于 `SCAN TABLE`，直接执行 `SELECT COUNT(*) FROM table` 给出准确行数。边界：若表行数超过 100 万，计数本身可能耗时，此时改为采样或使用 `sqlite_stat1`，并在诊断中标记估算来源。

**参数绑定必须显式提供**
`EXPLAIN QUERY PLAN` 可以不带参数运行，但缺少参数类型时优化器会选择通用计划。若调用方未提供参数，诊断对象应标记 `param_unknown`，并说明该计划可能偏离生产。例外：纯静态条件（如 `WHERE id = 1`）可省略参数。

**工具生命周期与 Agent 集成**
在 Pi 会话中，查询计划解析应作为只读工具执行。事件顺序为：订阅 `message_update` → 调用诊断工具 → 返回 `tool_execution_end` → 将结果注入系统提示。不能由前端关键字路由触发，必须由模型根据上下文决定调用。该工具只能读取，不能写入生产数据库。

## 可执行的实施流程

1. 以只读模式打开本地 SQLite 副本：`new Database(file, { readonly: true })`，避免污染生产数据。
2. 验证版本：`SELECT sqlite_version()` 与 `PRAGMA compile_options`，确认版本不低于 3.40。
3. 构建 Schema 缓存：读取 `PRAGMA table_list`、每个表的 `PRAGMA table_info`、每个索引的 `PRAGMA index_list` 与 `PRAGMA index_info`。
4. 校验参数绑定：若 SQL 包含占位符，要求调用方提供参数数组与类型说明；缺失时标记 `param_unknown`。
5. 执行 `EXPLAIN QUERY PLAN`：在事务外拼接前缀并运行，捕获 `id`、`parent`、`notused`、`detail`。
6. 解析算子：使用正则匹配 `SCAN TABLE`、`SEARCH TABLE`、`USING INDEX`、`USING COVERING INDEX`、`USE TEMP B-TREE`。
7. 量化扫描行数：对每个 `SCAN TABLE` 算子执行 `COUNT(*)`；对 `SEARCH TABLE` 算子，尝试估算选择率，无法估算时记录 `null`。
8. 索引有效性检查：若存在与查询条件前缀匹配的索引但计划显示 `SCAN TABLE`，生成 `suspicious` 项。
9. 生成诊断对象：合并算子、行数、可疑项、索引使用率与建议。
10. 写入可观测日志：记录 SQL 指纹、计划摘要、扫描行数、执行耗时与版本号。
11. 回归验证：在副本库上执行候选优化（如 `CREATE INDEX` 或 `ANALYZE`），重跑计划并对比前后算子变化。

## 示例：TypeScript 诊断函数

```typescript
import Database from 'better-sqlite3';

type PlanRow = { id: number; parent: number; notused: number; detail: string };

function diagnose(dbPath: string, sql: string, params: unknown[] = []) {
  const db = new Database(dbPath, { readonly: true });
  const version = db.prepare('SELECT sqlite_version()').pluck().get() as string;
  if (version.localeCompare('3.40.0') < 0) throw new Error(`unsupported sqlite ${version}`);

  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as PlanRow[];
  const operators = rows.map(r => parseOperator(r.detail));

  for (const op of operators) {
    if (op.op === 'SCAN TABLE') {
      op.rows = db.prepare(`SELECT COUNT(*) FROM ${op.target}`).pluck().get() as number;
    }
  }

  const suspicious = operators
    .filter(o => o.op === 'SCAN TABLE' && hasIndexFor(db, o.target, sql))
    .map(o => `SCAN TABLE ${o.target} while index exists; check implicit conversion`);

  return { sql, operators, suspicious, recommendations: [] };
}
```

输入为本地数据库路径、SQL 文本与可选参数；处理包括只读连接、版本校验、计划获取、算子解析、行数计数与索引存在性比对；输出为包含算子、扫描行数和可疑项的结构化对象。

## 性能、质量与可观测性指标

1. **扫描行数**：对 `SCAN TABLE` 算子计算 `COUNT(*)`，1000 行标记为 warning，10000 行标记为 critical。直接执行计数语句测量。
2. **计划解析耗时**：从执行 `EXPLAIN QUERY PLAN` 到返回 JSON 的耗时，目标小于 50ms。使用 `performance.now()` 测量。
3. **索引覆盖率**：schema 中所有索引在最近 N 次诊断中被使用的比例。将每次计划中的 `USING INDEX` 与 `USING COVERING INDEX` 索引名写入日志后聚合去重。
4. **隐式转换检测率**：通过正则扫描 `WHERE` 条件中字符串字面量与整数列的比较，或 `LIKE '%...'` 模式。统计命中次数。
5. **优化回归通过率**：对同一 SQL 在优化前后两次运行计划解析，计算 `SCAN TABLE` 算子减少或 `SEARCH TABLE` 增加的比例。目标大于 80%。

## 失败模式

1. **语法错误**：输入 SQL 不合法，SQLite 抛出 `SQLITE_ERROR: near "..."`。诊断证据为异常码 1 与错误消息中的 `near` 关键字。恢复：返回错误对象，拒绝生成计划，提示检查 SQL 文本。
2. **表或索引不存在**：异常消息包含 `no such table` 或 `no such index`。恢复：对照 schema 缓存校验表名大小写与索引名，提示确认 schema 版本。
3. **参数未绑定**：SQL 含占位符但未提供参数，导致报错或计划偏离。诊断证据为参数数组长度与占位符数量不匹配。恢复：标记 `param_unknown`，要求调用方提供参数示例。
4. **索引失效（隐式转换）**：`detail` 显示 `SCAN TABLE users`，但 schema 缓存显示存在 `idx_users_email` 且 `WHERE email = ?` 条件匹配。恢复：检查参数类型是否与列声明一致，必要时使用 `CAST` 或统一 schema 类型。
5. **统计信息过期**：`sqlite_stat1` 中某索引估算行数与 `COUNT(*)` 偏差超过 50%。恢复：在副本库执行 `ANALYZE table_name`，重跑计划并对比。

## 问答测试样例

1. **正向**：为什么查询用了索引但响应仍慢？回答：检查 `detail` 是 `USING INDEX` 还是 `USING COVERING INDEX`；前者每次命中后需回表，大量命中时回表成本会超过索引收益。
2. **正向**：如何确认某个索引被使用？回答：在 `EXPLAIN QUERY PLAN` 输出中检查 `detail` 是否包含 `USING INDEX <name>` 或 `USING COVERING INDEX <name>`。
3. **边界**：参数绑定为字符串但列为整数，索引是否有效？回答：通常无效，类型不匹配会触发隐式转换导致 `SCAN TABLE`；例外是值可无损解析为整数时可能仍走索引。
4. **边界**：空表时 `COUNT(*)` 为 0，是否说明没有慢查询？回答：否。空表不会暴露慢查询，但计划仍可能是 `SCAN TABLE`；数据增长后同样计划会退化。
5. **无证据拒答**：用户只描述“查询很慢”，未提供 SQL 和计划输出。回答：无法定位原因，需要至少提供 SQL 文本、SQLite 版本、表结构和 `EXPLAIN QUERY PLAN` 输出。
6. **无证据拒答**：用户询问特定索引是否最优，但未提供 `ANALYZE` 时间和数据分布。回答：无法给出最优性结论，只能给出“在当前统计下计划是否使用该索引”这一可验证事实。

## 维护、版本、来源与相邻主题

维护时，每次升级 `better-sqlite3` 或 SQLite 后，需运行一组固定 SQL 的回归计划，验证 `EXPLAIN QUERY PLAN` 输出格式是否变化；若变化则更新正则解析器。版本基线为 SQLite 3.40，`better-sqlite3` 的预编译二进制与 Node ABI 绑定，升级 Node 时需重新编译。诊断逻辑来源于 SQLite 官方文档的 `EXPLAIN QUERY PLAN`、`PRAGMA` 系列命令以及 `sqlite_stat1`/`sqlite_stat4` 统计表，不依赖外部数据库监控服务。与相邻主题的关系：向上连接 SQLite 参数绑定与类型系统、Schema 迁移与索引管理；向下连接本地文件系统并发访问、WAL 与事务隔离、TypeScript 运行时验证，以及 Pi Agent 的只读工具协议。

## 结论

事实：`EXPLAIN QUERY PLAN` 返回结构化计划行；`SCAN TABLE` 表示全表扫描；`USING INDEX` 与 `USING COVERING INDEX` 表示索引被使用；SQLite 3.40+ 的输出格式稳定；`better-sqlite3` 可只读打开本地副本。推论：当可用索引存在但计划为 `SCAN TABLE` 时，常见原因是隐式类型转换或统计信息过期；`COUNT(*)` 比 `sqlite_stat1` 估算值更可靠，但大表计数本身有成本。未知：具体业务 SQL 的真实生产耗时、数据分布细节、用户是否按推荐执行优化，均不在本文可验证范围内，需通过回归测试与日志持续观察。
