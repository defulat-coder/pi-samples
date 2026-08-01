---
type: concept
title: 备份恢复：实现视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。验证 WAL、快照、导出和恢复后的数据完整性
resource: .pi/knowledge/library/sqlite-data/backup-implementation.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, backup, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: backup
variant: implementation
---

# SQLite 本地数据备份恢复：WAL 验证、快照、导出与恢复后完整性校验的实现

## 摘要与问题边界

本文讨论在 TypeScript 运行时（Node.js、Electron 主进程、Bun/Deno）中，对本地 SQLite 数据库执行备份与恢复时的完整性保障。核心范围包含：WAL 文件语义、文件系统快照、SQL/二进制导出、恢复后的逐层校验。不覆盖远程对象存储、端到端加密、跨大版本迁移、以及分布式一致性协议。完整性在这里被定义为三层：文件页级校验通过、PRAGMA 检查无错、应用层业务不变量成立。

## 核心概念与数据模型

1. 主数据库页（Pages）：SQLite 把数据库切分为固定大小的页，默认 4096 字节。页 1 包含文件头（magic、页大小、schema cookie、change counter），是快照对齐的最小单位。
2. WAL 帧（Frames）：启用 WAL 后，未提交的修改先追加到 `-wal` 文件。每帧包含页号、帧头盐值、校验和。恢复时必须让 `-wal` 与主文件在帧索引上保持一致，否则会出现“热日志”状态。
3. `-wal-index` / `-shm` 文件：共享内存索引加速 WAL 读取，崩溃后可重建。快照时若遗漏该文件，多数场景仍能恢复，但在并发读取下会触发重建并可能报告短暂不一致。
4. Checkpoint 生命周期：`PASSIVE`、`RESTART`、`TRUNCATE` 三种模式决定 WAL 内容何时写回主文件。备份前建议执行 `PRAGMA wal_checkpoint(TRUNCATE)` 或记录当前帧号，避免快照跨 checkpoint 边界。
5. 快照一致性边界：快照是“主文件 + WAL + 元数据”在某一时刻的只读副本。只复制主文件会丢失已提交但未 checkpoint 的数据；只复制 WAL 则无法独立打开。
6. 完整性检查层：页级用 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`；业务层用行数、校验和、关键表哈希；文件层用 SHA-256 与文件大小。
7. 导出表示：二进制副本保留索引与视图定义，速度快但受 SQLite 版本限制；SQL 导出（`.dump`）可读、可编辑，但大表性能差；JSON/CSV 导出适合单表审计，不保留约束。
8. 备份 API：`sqlite3_backup_step` 支持在线页级复制，能在应用写入时持续同步目标库，适合“热备”；文件系统复制更简单，但需要短时间冻结写入或依赖 WAL 保证只读一致性。

## 设计决策与取舍

### 在线备份还是离线备份
在线备份依赖 WAL 与备份 API，应用无需停机，但实现复杂，需要处理并发事务与 WAL 增长。离线备份直接复制文件，实现简单，但必须关闭所有写连接或获取独占锁。对于桌面/本地工具，离线快照通常足够；对于需要 24 小时写入的服务，应使用在线备份。

### 快照粒度：文件级还是页级
文件级快照一次性复制整个主文件和 WAL，速度快，工具链成熟，但会复制未 checkpoint 的垃圾页。页级备份 API 只复制有效页，节省空间，但引入更多 I/O 与版本依赖。建议本地场景优先文件级快照，并用校验和兜底。

### WAL 是否包含在快照内
必须包含。若备份时跳过 WAL，即使主文件本身一致，也会丢失自上次 checkpoint 以来已提交的数据。例外：执行 `TRUNCATE` checkpoint 并确认 WAL 为空后，可只备份主文件。

### 验证层数与成本
页级检查 `integrity_check` 对大库可能耗时数秒至数分钟。业务层检查更轻量，但无法发现页损坏。推荐三层都做，但在高频备份中可把完整页级检查放到“每日全量”中，增量备份只做业务层校验。

### 恢复策略：原地覆盖还是侧向替换
原地覆盖最简单，但失败时回滚困难。侧向替换先把备份复制到临时目录，验证通过后再原子重命名替换主文件，旧文件保留为 `.old`，能在验证失败时秒级回滚。代价是临时磁盘空间翻倍。

## 可执行的实施流程

1. 记录基线元数据：打开数据库后读取 `PRAGMA page_size`、`PRAGMA user_version`、`PRAGMA application_id`，以及关键表行数，写入备份清单。
2. 启用或确认 WAL 模式：执行 `PRAGMA journal_mode=WAL`；若返回不是 `wal`，则中止并提示文件系统或编译选项不支持。
3. 暂停应用写入：通过消息队列或锁阻止新的写事务；已运行事务等待其提交或超时回滚。超时默认 5 秒，可配置。
4. 执行 checkpoint 决策：若选择“含 WAL 快照”，执行 `PRAGMA wal_checkpoint(PASSIVE)` 并记录返回的已写回帧数；若选择“干净主文件”，执行 `TRUNCATE` 并确认 WAL 大小归零。
5. 文件系统快照：同步复制主文件、`-wal`、`-shm` 到备份目录；复制后立即计算 SHA-256 并记录文件大小。使用 `fs.copyFileSync` 或 `rsync --inplace` 减少副本差异。
6. 离线验证：在快照副本上以只读方式打开，运行 `PRAGMA integrity_check`、`PRAGMA foreign_key_check`、关键表 `SELECT count(*)`，并与基线比对。
7. 导出：生成 SQL dump 或 JSON 导出；重新解析 dump 文件头，确认包含 `BEGIN TRANSACTION;` 与 `COMMIT;`，并用独立只读库执行导出脚本验证其可重放。
8. 恢复前环境检查：确认目标目录可写、旧数据库已关闭、没有残留的 `-wal` 或 `-shm`；若存在，先重命名或删除，避免新旧 WAL 盐值冲突。
9. 侧向恢复与回滚：把备份文件复制到 `db.restored`，打开并运行完整验证；通过则原子重命名为 `db`，旧文件移为 `db.old`；未通过则保留 `db` 不变，返回错误明细。
10. 恢复后验证：重新打开生产库，再次检查 `integrity_check`、`foreign_key_check`、关键表行数、应用层业务不变量，全部通过后才向调用方返回成功。

## 备份清单与验证报告示例

    {
      "backupId": "bk-20250812-001",
      "source": "/data/app.db",
      "sqliteVersion": "3.46.0",
      "pageSize": 4096,
      "journalMode": "wal",
      "files": [
        { "path": "app.db", "sha256": "a1b2...", "size": 16777216 },
        { "path": "app.db-wal", "sha256": "c3d4...", "size": 32768 },
        { "path": "app.db-shm", "sha256": "e5f6...", "size": 32768 }
      ],
      "integrityCheck": "ok",
      "foreignKeyCheck": [],
      "rowCounts": { "users": 1523, "orders": 8941 },
      "exportedDump": "app-20250812.sql",
      "dumpParseable": true
    }

输入：上述 JSON 由备份脚本从文件系统、SQLite PRAGMA 和表查询聚合而成。处理：脚本逐文件计算哈希，打开副本运行检查，对比基线行数。输出：一份可审计、可重放的备份清单；恢复时先校验清单哈希再打开数据库，任一字段失败即拒绝恢复。

## 性能、质量与可观测性指标

1. 备份耗时：分解为文件复制时间、integrity_check 时间、导出时间。可用 `process.hrtime.bigint()` 测量，告警阈值按数据库大小线性设置，例如每 GB 不超过 30 秒。
2. WAL 帧数增长率：每次备份前后记录 `PRAGMA wal_checkpoint` 返回的日志帧数，异常增长说明写入事务过长或 checkpoint 策略不当。
3. 完整性检查失败率：统计每次 `integrity_check` 返回非 `ok` 的次数，按数据库路径和版本分组。
4. 哈希不一致率：比较快照复制后计算的 sha256 与恢复前重新计算的 sha256，发现静默位翻转或传输错误。
5. 恢复后业务不变量违规数：例如“订单总额等于明细之和”“用户主键唯一”。通过独立测试查询在恢复后运行，记录失败条目。
6. 端到端恢复耗时：从发起恢复到“应用可读写”的时间，包括复制、验证、重命名。目标是小于备份耗时的 120%。

## 失败模式、诊断证据与恢复动作

1. WAL 盐值/校验和损坏：诊断证据为打开数据库时 SQLite 报错 “database disk image is malformed” 或 WAL 帧校验失败。恢复动作：丢弃损坏的 `-wal`，从最近一次完整快照恢复；切勿直接删除主文件。
2. 主文件页校验失败：`integrity_check` 报告 “row xxx missing from index yyy” 或 “page xxx is never used”。诊断证据是错误消息中的页号与索引名。恢复动作：使用更早的快照或 SQL dump 重建，重建后再次运行检查。
3. 导出行数与基线不符：诊断证据为 `rowCounts.orders` 偏差或 dump 中 `INSERT` 计数低于预期。恢复动作：中止导出，检查备份时是否有未提交事务，重新执行 checkpoint 后重试。
4. 外键约束违反：`foreign_key_check` 返回非空结果。诊断证据为 `(child_table, rowid, parent_table, fkid)` 元组。恢复动作：在隔离库中修复孤儿行或回滚到上一个一致快照；不能将违反数据直接写回生产库。
5. 恢复目标目录被占用：诊断证据为 `EBUSY` 或 `SQLITE_BUSY` 错误，说明仍有连接未关闭。恢复动作：列出并强制关闭所有数据库句柄，等待锁释放，再执行侧向替换。
6. 快照跨越 checkpoint 边界：诊断证据是备份的 `-wal` 文件非空但主文件已被部分重写，导致恢复后页不一致。恢复动作：备份脚本在复制前显式执行 `wal_checkpoint(RESTART)` 或同时复制主文件与 WAL 并记录帧号；恢复时按帧号校验。

## 问答测试样例

1. 正向：备份 SQLite 时为什么要同时复制 `-wal` 文件？
   答：因为已提交但未 checkpoint 的数据只存在于 WAL 中，跳过它会丢失数据；复制后还需校验其 SHA-256 与帧状态。

2. 正向：恢复后应执行哪些验证步骤？
   答：打开恢复库后依次执行 `PRAGMA integrity_check`、`PRAGMA foreign_key_check`、关键表行数核对、业务不变量查询，全部通过才算成功。

3. 边界：数据库大小超过 10 GB 时，如何控制 `integrity_check` 成本？
   答：可改为按表抽样或每周一次全量检查，日常备份只做文件哈希与行数比对；抽样方案必须记录抽样比例和未检查表清单。

4. 边界：如果 `PRAGMA journal_mode` 返回 `delete` 而非 `wal`，备份策略应如何调整？
   答：必须获取独占锁后才能复制主文件，否则可能备份到正在回滚的日志状态；或者先临时切换到 WAL 模式，确认切换成功再继续。

5. 无证据拒答：本方案能否保证备份文件永远不会损坏？
   答：不能。只能降低并检测损坏风险；绝对保证需要额外冗余校验、异地副本和硬件级检测，这些不在本文范围内。

6. 无证据拒答：SQL dump 是否一定比二进制快照更可靠？
   答：不一定。dump 的可读性有助于人工审计，但大表导出容易超时、截断或丢失索引；可靠性取决于执行环境与验证步骤，而非格式本身。

## 维护、版本、来源与相邻主题

备份清单格式应版本化，例如 `manifestVersion: 2`，以便后续增加字段时旧工具能识别或拒绝。SQLite 文件格式在大版本间通常向后兼容，但 `PRAGMA foreign_keys` 与 `WAL` 行为受编译选项影响，测试必须在目标运行时重复执行。来源以 SQLite 官方文档、`better-sqlite3`/`node-sqlite3` 类型定义以及本项目的 `packages/pi-agent` 数据层约定为准。

相邻主题包括：数据库迁移（schema 升级后旧快照的可用性）、本地文件加密（快照加密与密钥轮换）、以及事件溯源/复制（将 WAL 变更流转发到远端）。本文与这些主题的关系是：它们可以改变备份内容或传输方式，但不改变“快照 + 三层验证”的核心流程。

## 结论

事实：SQLite 主文件与 WAL 共同构成一致性边界；`PRAGMA integrity_check` 和 `PRAGMA foreign_key_check` 是官方提供的页级与约束级验证工具；SHA-256 与文件大小可以检测文件级位翻转。

推论：在 TypeScript 本地应用中，侧向替换加三层验证的恢复策略，能在大多数单点故障下避免数据丢失；含 WAL 的文件级快照是桌面/本地工具中最简单的正确实现路径。

未知：特定硬件或操作系统缓存行为导致的异步写入顺序、SQLite 未来大版本对 WAL 帧格式的变更、以及极端并发下 `-shm` 重建的确切边界条件，需要针对具体运行时再验证。
