---
type: concept
title: 备份恢复：验证与运维视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。验证 WAL、快照、导出和恢复后的数据完整性
resource: .pi/knowledge/library/sqlite-data/backup-operations.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, backup, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: backup
variant: operations
---

# SQLite 本地数据备份与恢复：WAL 一致性、快照、导出及完整性验证

## 摘要与问题边界

SQLite 数据库通常以单个 `.db` 文件承载应用状态，但默认的 rollback journal 与 write-ahead logging（WAL）模式在备份窗口内的行为差异极大。本文讨论在单节点、本地文件系统环境下，如何验证 WAL 残留帧、快照时刻、导出副本与恢复后数据的一致性。重点覆盖 sqlite3 原生工具、文件系统快照（APFS、ZFS、LVM、Btrfs）以及应用级导出的可观测性。范围不包括分布式 SQLite 或网络同步协议；读者应将其视为单进程/多进程并发访问同一本地文件的工程指南。

## 核心概念与数据模型

1. **数据库文件（main db）**：存储所有表、索引、B-tree 页与 freelist 的单一文件；恢复时首先确认其页大小（page size）与文件头魔数一致。
2. **WAL 文件（`-wal`）**：在 WAL 模式下保存已提交但尚未回写至主数据库的帧；每帧包含页号、 Salt-1/Salt-2、校验和以及实际页内容。
3. **WAL 索引（`-shm`）**：内存映射的共享索引，进程崩溃后可重建，因此备份时通常不需要保留它，但恢复时若遗漏 `-wal` 会导致最新提交事务丢失。
4. **检查点（checkpoint）**：将 WAL 帧合并回主数据库的操作；被动 checkpoint 可能被读取阻塞，重启 checkpoint 会截断 WAL。
5. **快照（snapshot）**：文件系统或应用级在某一逻辑时间点生成的只读副本；一致性取决于是否捕获了 `-wal` 的完整状态。
6. **导出（export/backup）**：通过 `VACUUM INTO`、`.backup` 或 `sqlite3_backup_*` API 生成的逻辑/物理副本，可能重新整理页布局。
7. **完整性校验（PRAGMA integrity_check）**：逐页检查 B-tree 引用、空闲页链表、数据库内容是否损坏，通常返回 `ok` 或具体错误列表。
8. **校验和（checksum）**：WAL 帧头与页数据使用 32 位大端和小端组合校验，Salt 用于区分不同世代的 WAL 文件。

## 设计决策与取舍

### WAL 模式是否保留
启用 WAL 可提升并发写入性能，但备份必须同时捕获 `-wal` 文件。若环境无法保证原子复制两个文件，应切回 journal 模式或先执行 checkpoint。

### 快照 vs. 应用级导出
文件系统快照速度快，但只保证块级一致性；若快照时仍有事务未提交，恢复后需依赖 SQLite 自身的崩溃恢复机制。应用级导出通过 SQLite 事务接口生成，逻辑一致性更强，但会阻塞写操作并消耗额外 I/O。

### 热备份是否允许
热备份在 WAL 模式下可行：先执行 `PRAGMA wal_checkpoint(PASSIVE)` 或 `RESTART`，再复制主文件与 `-wal`。然而被动 checkpoint 不一定成功完成，失败时备份仍依赖 `-wal` 文件。

### 是否保留 `-shm` 文件
不需要。恢复时 `-shm` 可由首个连接进程重建。若误将旧 `-shm` 与新 `-wal` 配对，反而可能导致连接异常。

### 导出副本的页版本选择
`VACUUM INTO` 生成的新数据库页大小与源库相同，但页编号已重新组织，无法直接用于增量 WAL 恢复。因此导出副本更适合归档，不适合作为增量备份的基线。

### 自动化验证频率
建议每次备份后立即执行 `PRAGMA quick_check` 作为快速门控，并在周期任务中执行完整 `PRAGMA integrity_check`；二者失败都必须触发告警并保留原始备份文件，避免修复操作覆盖证据。

## 可执行的实施流程

1. 确认运行模式：`PRAGMA journal_mode;` 返回 `wal` 时继续；否则评估是否需切换。
2. 记录当前页大小：`PRAGMA page_size;` 与 `PRAGMA schema_version;` 一并写入备份元数据。
3. 冻结写请求：在应用层短暂进入只读或队列写操作，降低快照窗口内的事务。
4. 执行被动检查点：`PRAGMA wal_checkpoint(PASSIVE);` 记录返回值（已回写页数、待回写页数、日志中总页数）。
5. 原子捕获主文件与 `-wal`：使用文件系统快照或 `cp --preserve=timestamps`；确保二者时间戳差小于备份脚本阈值。
6. 生成校验摘要：计算 `sha256sum main.db main.db-wal` 并写入 `manifest.json`。
7. 副本验证：在隔离目录打开副本，执行 `PRAGMA integrity_check;` 与 `SELECT count(*) FROM sqlite_master;`。
8. 模拟恢复：将副本拷贝至空目录，删除 `-shm`，启动应用并读取关键表，确认无 `SQLITE_CORRUPT` 或 `SQLITE_NOTADB` 错误。
9. 记录延迟：测量从冻结到验证完成的 wall-clock 时间，以及 WAL 截断后数据库文件体积变化。
10. 清理与保留：保留至少两个连续有效快照，旧快照按保留策略删除；删除前再次校验摘要。
11. 回滚只读：恢复应用写请求，并监控首次写入是否产生新的 `-wal` 帧。
12. 告警与审计：将完整性结果、校验和、检查点返回值持久化到独立日志系统。

## 代码示例：TypeScript 本地备份与完整性检查

```typescript
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

interface BackupManifest {
  source: string;
  pageSize: number;
  schemaVersion: number;
  walFrameCount: number;
  checkpointBackfilled: number;
  checksums: Record<string, string>;
  integrityCheck: string;
  durationMs: number;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function backup(dbPath: string, outDir: string): Promise<BackupManifest> {
  const start = Date.now();
  const base = path.basename(dbPath);
  const copy = (ext: string) => fs.copyFile(dbPath + ext, path.join(outDir, base + ext));
  await copy('');          // main.db
  await copy('-wal');      // 必须捕获 WAL 帧
  const pageSize = 4096;   // 应由 PRAGMA page_size 查询获得
  const schemaVersion = 42; // 应由 PRAGMA schema_version 查询获得
  const checksums: Record<string, string> = {
    main: await sha256(path.join(outDir, base)),
    wal: await sha256(path.join(outDir, base + '-wal')),
  };
  const integrityCheck = 'ok'; // 应由 sqlite3 执行 PRAGMA integrity_check 获得
  return {
    source: dbPath,
    pageSize, schemaVersion, walFrameCount: 0, checkpointBackfilled: 0,
    checksums, integrityCheck,
    durationMs: Date.now() - start,
  };
}
```

输入：原始数据库路径 `dbPath`、输出目录 `outDir`。处理：同步复制主文件与 WAL 文件，计算 SHA-256，并记录页大小与 schema 版本。输出：`BackupManifest` 对象，包含完整性校验结果、校验和与耗时；后续应将其与 `PRAGMA integrity_check` 的实际输出进行比对。

## 性能、质量和可观测性指标

1. **备份窗口时长**：从冻结写到验证完成的时间，使用 `performance.now()` 或 `Date.now()` 测量，目标值通常小于 30 秒。
2. **WAL 待回写帧数**：通过 `PRAGMA wal_checkpoint(PASSIVE)` 返回的第二个整数监控；持续大于阈值说明 checkpoint 策略不足。
3. **副本完整性状态**：`PRAGMA integrity_check` 与 `PRAGMA foreign_key_check` 的结果，应记录为布尔或错误字符串。
4. **数据库字节体积与 WAL 比例**：比较 `main.db` 与 `main.db-wal` 大小；WAL 超过主文件 50% 时应触发 checkpoint 或告警。
5. **恢复后首次查询延迟**：在恢复副本上执行代表性读查询，记录 P50/P95，突增可能暗示页损坏或缓存失效。
6. **备份失败率**：统计连续 7 天内完整性检查失败次数，失败率高于 1% 应暂停自动清理。

## 失败模式

1. **WAL 文件被截断**：备份脚本仅复制了部分 `-wal` 帧，恢复时 SQLite 报告 `SQLITE_CORRUPT` 或 `SQLITE_NOTADB`。证据：`-wal` 大小不是帧大小（页大小 + 24 字节）的整数倍。恢复：重新复制完整 `-wal`，或回退到上一个未截断快照。
2. **快照捕获了不一致的块**：文件系统快照在数据库写中间发生，恢复后 `integrity_check` 报告自由页链表错误。证据：备份时存在未完成的写事务，且未使用 SQLite 备份 API。恢复：使用 `sqlite3` 的 `.backup` 或 `VACUUM INTO` 重新生成副本。
3. **`-shm` 被错误保留**：旧快照中的 `-shm` 与新恢复的 `-wal` 时间戳不匹配，导致进程启动时读取异常。证据：日志出现 `mmap` 或共享内存版本不匹配。恢复：删除 `-shm`，让 SQLite 自动重建。
4. **schema 版本漂移**：恢复后应用尝试读取新表，但 `PRAGMA schema_version` 低于预期。证据：应用日志出现 `no such table` 或迁移版本号错误。恢复：暂停启动，使用正确的迁移基线重新导入。
5. **校验和通过但逻辑数据丢失**：导出副本时未捕获最新 `-wal` 帧，`integrity_check` 正常但最近提交的事务消失。证据：校验和一致但业务记录计数低于预期。恢复：从 WAL 残留归档中重新合并，或接受数据丢失并写入事件日志。
6. **checkpoint 阻塞导致备份延迟**：被动 checkpoint 因长时间读事务无法完成，备份窗口超时。证据：检查点返回值显示待回写帧数持续居高。恢复：升级至允许 `wal_checkpoint(RESTART)` 的维护窗口，或优化长读事务。

## 问答测试样例

1. **正向**：如何确认 WAL 模式已启用？应回答：执行 `PRAGMA journal_mode;`，返回 `wal` 即启用。
2. **正向**：备份时为何必须保留 `-wal` 文件？应回答：因为已提交但尚未 checkpoint 的页只存在于 WAL 中。
3. **边界**：`-shm` 文件是否必须备份？应回答：否，可重建；但跨平台恢复时若权限异常可删除后重建。
4. **边界**：`PRAGMA integrity_check` 通过是否代表无数据丢失？应回答：不，仅代表页结构完整，不能证明业务事务未遗漏。
5. **无证据拒答**：哪种文件系统快照最快？若未提供 APFS/ZFS/Btrfs 等具体数据，应回答：无法比较，需测量冻结窗口与块复制耗时。
6. **无证据拒答**：启用 WAL 后性能一定提升吗？应回答：不一定，取决于读写比例、checkpoint 频率与文件系统特性。
7. **正向**：恢复后应检查哪些指标？应回答：完整性检查、schema 版本、WAL 帧计数、首次查询延迟、业务记录计数。
8. **边界**：`VACUUM INTO` 生成的副本能否继续增量 WAL 备份？应回答：不能，因为页编号已重新整理，不再兼容原库的增量 WAL。
9. **正向**：checkpoint 失败时怎么办？应回答：记录检查点返回值，保留 WAL 文件，进入维护窗口执行 `RESTART` 或切换 journal 模式。
10. **无证据拒答**：SQLite 备份是否比 PostgreSQL 备份更简单？应回答：二者问题域不同，无法仅凭架构复杂度直接比较。

## 维护、版本、来源与相邻主题

本文基于 SQLite 3.45+ 的行为与通用文件系统快照语义，不依赖特定商业工具。维护节奏建议：每次升级 SQLite 小版本后重新验证 `integrity_check` 输出格式；当应用引入部分索引、生成列或 FTS5 时，重新评估导出副本的兼容性。相邻主题包括：SQLite 并发控制（busy timeout、WAL 读写锁）、迁移管理（schema 版本与迁移脚本）、加密扩展（SQLCipher 备份需额外处理 salt 文件）以及应用级缓存一致性（恢复后需清除内存缓存）。标签：SQLite、WAL、checkpoint、backup、integrity_check、snapshot、本地文件、运维、故障恢复。

## 结论

事实：SQLite 单文件模型使本地备份在概念上简单；WAL 模式下必须同时捕获主文件与 `-wal`；`PRAGMA integrity_check` 可验证页级结构损坏；`-shm` 可重建。推论：在无法原子复制多文件的环境中，优先使用 `VACUUM INTO` 或 `.backup` 生成单一文件归档，而非直接复制 WAL 对。未知：特定操作系统或文件系统快照实现是否在极端 I/O 压力下产生页内撕裂；不同 SQLite 编译选项（如 `SQLITE_ENABLE_SNAPSHOT`）是否改变长期运行读事务对 checkpoint 的影响。因此，任何备份策略都应以可重复的验证脚本和恢复演练为最终证据。
