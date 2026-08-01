---
type: concept
title: 一致性：验证与运维视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。区分数据库事实、派生统计和模型生成解释
resource: .pi/knowledge/library/sqlite-data/consistency-operations.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, consistency, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: consistency
variant: operations
---

# SQLite 本地一致性：事实、派生统计与模型解释的运维区分

## 摘要与问题边界

本地 SQLite 的一致性不能简化为“事务提交成功即正确”。运维与验证视角需要把三类信息分开：数据库事实、派生统计、模型生成解释。数据库事实是可复现的原始状态；派生统计有采样窗口和计算口径；模型解释在没有校验链之前只是假设。本文覆盖单节点 SQLite、WAL 模式、本地文件系统快照，以及 Electron/Tauri 等嵌入式 Web 场景的本地数据知识库；不覆盖多主分布式 SQLite、网络分区共识或远程服务监控。核心目标是建立可记录的判据：成功、失败、延迟、容量与恢复证据。

## 核心概念与数据模型

1. 数据库事实：存储在 `.db`、`.db-wal`、`.db-shm` 文件及 PRAGMA 输出中的可验证状态，例如 `PRAGMA integrity_check`、`PRAGMA page_count`、`PRAGMA journal_mode`、`PRAGMA wal_checkpoint` 返回的日志帧数。这些是根因定位和恢复动作的唯一可靠输入。
2. 派生统计：由 SQL 聚合或应用层计算得出的数值，如 TPS、P99 查询延迟、缓存命中率。它们依赖采样窗口与算法口径，改变窗口会得到不同结果。
3. 模型生成解释：对慢查询、死锁或数据库膨胀原因的文本归因。除非每条解释都能追溯到执行计划、I/O 计数或时间戳校验，否则必须标记为低置信度推论。
4. 一致性边界：以 `fsync`、checkpoint、文件系统快照为界的可见性保证。WAL 模式下已提交事务在 checkpoint 前可能只存在于 `-wal` 文件中，崩溃后需要回放。
5. 可观测信号：从 `sqlite3_db_status`、PRAGMA、操作系统文件属性（`mtime`、`size`）和应用程序日志中提取的原始读数。信号本身不是结论。
6. 恢复证据：失败后的 redo 位置、校验和、最近一次成功 `VACUUM` 的时间戳、备份哈希。恢复终止条件必须以这些证据为准，而不是以“看起来正常”为准。

## 设计决策与取舍

**WAL 与同步级别**
WAL 模式提升读并发，但引入 `-wal` 回放风险。`PRAGMA synchronous=FULL` 降低崩溃丢失概率，却增加 `fsync` 延迟；`NORMAL` 在多数桌面场景可接受，但在电池供电设备或 USB 存储上必须实测。选定后需在运行日志中固化配置作为事实基线。

**单文件与附加数据库**
把历史归档 `ATTACH` 到独立数据库可减缓主库膨胀，但附加事务的提交顺序需要额外验证。若发生部分提交，恢复脚本必须逐个 attachment 路径执行 `PRAGMA integrity_check`。

**自动 checkpoint 与手动控制**
让 SQLite 自动 checkpoint 适合低并发，但大事务会导致 `-wal` 膨胀。运维侧通常设置 `wal_autocheckpoint` 阈值，并在业务低峰期显式调用 `wal_checkpoint(TRUNCATE)`，同时记录 checkpoint 前后 `-wal` 大小作为容量证据。

**统计采样窗口**
派生统计必须使用固定或滑动窗口，不能简单取“上线以来的累积平均”。例如 TPS 使用 10 秒滑动窗口，P99 使用 1 分钟分桶近似。窗口选择会改变告警灵敏度，需作为配置事实记录。

**模型解释的可审计性**
禁止把 LLM 解释直接写入事件流作为根因结论。正确做法是在解释后附加校验字段：关联 `query_id`、`EXPLAIN QUERY PLAN` 输出哈希、生成时间戳。只有校验字段全部命中，解释才可被自动化脚本引用。

## 可执行的实施流程

1. 启动时执行 `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;` 并将返回值写入启动日志事实表。
2. 创建可观测性事实表，字段包含 `event_type`、`observed_at`、`page_count`、`wal_size_bytes`、`cache_used`、`last_checkpoint_lsn`。
3. 为每个写事务记录 `begin_time`、`commit_time`、`rows_affected`、`sqlite3_last_insert_rowid()` 边界。
4. 每 10 秒采集一次 `PRAGMA stats` 与 `db_status(SQLITE_DBSTATUS_CACHE_USED)`，插入时序表。
5. 每小时执行一次增量或完整 `PRAGMA integrity_check`；结果存入检查结果表。
6. 配置混合 checkpoint 策略：阈值 1000 页，低峰期 `TRUNCATE`，记录前后 `wal_size_bytes`。
7. 对派生统计设置上下界校验：若 TPS 超过理论单线程上限或延迟低于时钟精度，则标记为脏数据。
8. 建立恢复演练：定期复制 `-wal`、`-shm` 与主库到隔离目录，执行崩溃回放并对比记录数。
9. 对模型解释实施校验链：存储解释文本、来源 `query_plan_hash`、生成时间、置信度等级。
10. 在发布版本中固化 `schema_version`、`PRAGMA user_version` 和工具链版本；升级前做兼容性快照。

## 代码示例：TypeScript 本地事实采集

```
interface DbFact {
  observedAt: number;
  pageCount: number;
  walSizeBytes: number;
  journalMode: 'wal' | 'delete';
  integrityCheck: 'ok' | string;
}

function sampleFacts(db: any): DbFact {
  const pageCount = db.prepare('PRAGMA page_count').pluck().get();
  const walSize = db.prepare("PRAGMA wal_size").pluck().get() || 0;
  const mode = db.prepare('PRAGMA journal_mode').pluck().get();
  const integrity = db.prepare('PRAGMA integrity_check(1)').pluck().get();
  return {
    observedAt: Date.now(),
    pageCount,
    walSizeBytes: walSize * 4096,
    journalMode: mode,
    integrityCheck: integrity,
  };
}
```

输入为已打开的 SQLite 连接；处理阶段只搬运原始读数，不做聚合；输出为结构化事实对象，供后续审计与告警使用。派生统计应在此之上另建 `computeDerivedMetrics`，且不得覆盖事实表。

## 性能、质量与可观测性指标

1. 提交延迟：测量 `BEGIN` 到 `COMMIT` 的 wall-clock 时间，用直方图记录 P50/P99。SSD 通常应低于 5ms，机械硬盘低于 50ms；阈值必须基于硬件基线。
2. WAL 膨胀率：checkpoint 间隔内 `-wal` 文件的增长速度（MB/分钟）。超过容量基线 20% 时触发手动 checkpoint。
3. 缓存命中率：通过 `SQLITE_DBSTATUS_CACHE_HIT` 与 `CACHE_MISS` 计算 `hit/(hit+miss)`。低于 80% 时排查工作集大小或连接池配置。
4. 完整性检查耗时：完整 `PRAGMA integrity_check` 的执行时间，用于评估维护窗口与恢复时间。
5. 恢复点目标：用 WAL 帧号和 LSN 量化最近一次成功 checkpoint 到崩溃点之间允许丢失的事务数，而不是用“最近一次备份”这种模糊表述。

## 失败模式、诊断证据与恢复动作

1. WAL 文件无限增长：证据为 `wal_size_bytes` 持续上升且 `wal_checkpoint` 返回 `BUSY`。恢复动作是降低并发读、在低峰期执行 `wal_checkpoint(TRUNCATE)`，并检查是否有未关闭的长事务。
2. 数据库页损坏：证据为 `integrity_check` 返回具体页号错误，或文件大小不是 `page_size` 整数倍。恢复动作是从最近一次有效备份还原，并回放 `-wal` 中校验和通过的帧。
3. 派生统计跳变：证据为 TPS 或延迟曲线出现阶跃，但数据库事实无对应变化。恢复动作是检查采样窗口和时钟回拨，重算后标记脏数据区间。
4. 模型解释 hallucination：证据为解释引用的 `query_id` 不存在或 `EXPLAIN` 哈希不匹配。恢复动作是拒绝该解释、降级置信度，并触发人工复核。
5. 文件系统元数据不一致：证据为 `mtime` 晚于最新事务时间、文件大小与 `page_count * page_size` 不符。恢复动作是关闭连接、执行 `VACUUM INTO` 到新文件，再原子替换。

## 问答测试样例

1. 正向：当前数据库的 `journal_mode` 是什么？必须引用 `PRAGMA journal_mode` 输出，不得推测。
2. 正向：上个小时完整 `integrity_check` 是否通过？只能引用检查结果表中的最新记录。
3. 边界：WAL 文件 120MB 是否正常？需结合 checkpoint 阈值、业务高峰与最近 checkpoint 时间判断；仅给大小无法结论。
4. 边界：缓存命中率 75% 是否需要优化？需先确认工作集大小、`page_cache` 配置和查询模式；不能仅由单一数值决定。
5. 无证据拒答：为什么某个查询变慢？若无 `EXPLAIN QUERY PLAN`、实际耗时分布和 I/O 计数，应回答“缺乏事实，无法归因”。
6. 无证据拒答：数据库崩溃后是否丢失数据？若无 checkpoint LSN、WAL 帧范围和备份哈希，应回答“无法确认，需执行回放验证”。

## 维护、版本、来源与相邻主题

维护重点是把 SQLite 版本、编译选项、操作系统文件系统类型和 PRAGMA 设置作为运行态事实长期保存。版本升级前应在隔离环境复现数据文件并跑通恢复演练。来源包括 SQLite 官方文档、应用程序 PRAGMA 输出和本地文件系统属性；模型解释必须注明生成模型版本与提示模板版本。相邻主题包括 SQLite 事务隔离级别、本地文件系统持久化语义、嵌入式应用崩溃恢复和可观测性指标设计。本主题不替代它们，而是强调三类信息的区分与校验。

## 结论

**事实层面**：SQLite 文件页、WAL 帧、PRAGMA 返回值和完整性检查结果是可直接验证的客观状态。**推论层面**：派生统计反映系统健康趋势，但受采样窗口和计算口径影响；模型解释通过校验链后可作为排查线索。**未知层面**：崩溃瞬间未 `fsync` 的数据内容、特定硬件上的真实写入顺序保证，以及未来版本编译选项对持久化语义的影响，在未实测前不可视为已知。运维决策应优先以事实为输入，以派生统计为趋势参考，以模型解释为需复核的假设。
