---
type: concept
title: Schema 设计：验证与运维视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。为实体、状态、时间和来源建立可演进的本地数据模型
resource: .pi/knowledge/library/sqlite-data/schema-operations.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, schema, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: schema
variant: operations
---

# SQLite 本地数据模型 Schema 设计：可演进、可观测、可恢复

## 摘要与问题边界

本文面向使用 SQLite 作为本地持久化的 TypeScript/Web 应用，讨论如何在单一数据库文件中为实体、状态、时间和来源建立可演进的 Schema。问题边界明确：不讨论服务端分布式数据库，不讨论多进程并发写入，也不提供跨业务领域的通用模板。核心挑战是：没有 DBA 和独立运维团队，所有验证、容量、故障恢复都必须内建到应用代码和可观测日志中。

## 核心概念与数据模型

1. **实体表（entity）**：存储业务实体的稳定身份，主键使用 `TEXT` 或 `BLOB`，避免自增整数在合并或迁移时产生冲突。例如 `document_id` 使用 UUIDv4，并在应用层保证全局唯一。
2. **状态表（state）**：记录实体在不同时刻的快照或状态机值。必须包含 `entity_id` 外键、`status` 枚举、`changed_at` 时间戳，以及 `source` 来源字段。
3. **时间轴（timeline）**：所有写操作都记录 `created_at` 和 `updated_at`，使用 `INTEGER` 存储毫秒级 Unix 时间戳，避免文本日期解析开销，并便于范围查询。
4. **来源追踪（provenance）**：每个可写表增加 `source` 字段，枚举值为 `user_input`、`sync_import`、`system_generated`、`migration`，用于区分数据产生路径，支撑故障根因分析。
5. **Schema 版本元数据（schema_meta）**：单独维护 `schema_version` 表，记录 `version`、`applied_at`、`migration_name`、`checksum`，迁移前必须读取，不能假设版本一致。
6. **事件日志/审计（audit_log）**：记录高风险操作，包括 `op`、`table_name`、`row_id`、`before_payload`、`after_payload`、`op_at`，不依赖触发器，由应用层显式写入，保证语义完整。

## 设计决策与取舍

### 单文件 vs 多文件
SQLite 天然单文件。如果业务需要区分用户数据、缓存、日志，优先使用同一文件内的不同表，而非多个 `.db` 文件。原因：多文件增加备份原子性难度，且无法通过 BEGIN 事务保证跨文件一致性。例外：大容量附件（如图片、PDF）应存于文件系统，数据库中只保存相对路径和 SHA-256 校验。

### 严格类型 vs 弱类型
启用 `STRICT` 表类型（SQLite 3.37.0+），使 `INTEGER`、`REAL`、`TEXT`、`BLOB`、`ANY` 之外的数据类型写入报错。这能拦截 90% 以上由类型漂移导致的读取失败。但应用如果需支持 3.37 以下版本，应启用运行时类型校验，不能假设引擎约束。

### 规范化 vs 反规范化
核心实体遵循第三范式，避免冗余；但只读视图、搜索索引、统计汇总表可有意反规范化。例如，为全文检索额外维护 `document_search` 表，与主表通过 `document_id` 关联，写入时同步更新。

### WAL 模式 vs 回滚日志
Web 场景下优先使用 WAL（Write-Ahead Logging）。它允许读取和写入并发，崩溃后恢复更快。但 WAL 会产生 `-wal` 和 `-shm` 文件，备份时必须同时捕获主文件和两个伴随文件，或先执行 `PRAGMA wal_checkpoint(FULL)` 再拷贝。

### 外键约束 vs 应用层校验
在 SQLite 中启用 `PRAGMA foreign_keys = ON`，但仅将其作为第二道防线。主校验逻辑仍放在应用层，因为外键错误信息对终端用户不友好，且事务失败时难以区分业务错误与数据库错误。

## 可执行的实施流程

1. 用业务事件风暴列出实体、命令和查询，识别写热区（write-hot spots）。
2. 建立基线 Schema 版本号 1，所有表加入 `created_at`、`updated_at`、`source` 字段。
3. 为每个实体表创建主键，并写入 `schema_meta` 版本记录。
4. 设计索引：主键自动索引；查询字段手动建索引；避免对低频查询过度索引。
5. 编写迁移脚本：每个迁移文件命名规则为 `m_{from}_{to}_{description}.sql`，必须幂等。
6. 在应用启动时读取 `schema_meta`，检测版本，顺序执行迁移，失败则回滚并退出。
7. 插入观测点：记录启动时间、迁移耗时、数据库文件大小、页面数、WAL 文件大小。
8. 制定备份策略：运行时拷贝前先 `PRAGMA wal_checkpoint(FULL)`，或导出为 SQL 文本。
9. 执行故障演练：模拟磁盘满、中途断电、迁移版本跳跃，验证恢复路径。
10. 文档化回滚方案：每个迁移必须提供逆向 SQL 或快照恢复命令。

## 示例：本地知识库片段

```yaml
input:
  event: user_update_document
  document_id: "doc-2024-001"
  title: "SQLite Schema 设计"
  source: "user_input"
  timestamp: 1704067200000

process:
  - 开启事务 BEGIN IMMEDIATE
  - 更新 document 表 title、updated_at
  - 在 document_state 表插入新状态行
  - 写入 audit_log 记录 before/after 差异
  - 提交 COMMIT

output:
  document_row:
    document_id: "doc-2024-001"
    title: "SQLite Schema 设计"
    updated_at: 1704067200000
  state_row:
    state_id: "state-uuid"
    document_id: "doc-2024-001"
    status: "draft"
    changed_at: 1704067200000
  audit_row:
    op: "update"
    table_name: "document"
    row_id: "doc-2024-001"
    source: "user_input"
    op_at: 1704067200000
```

该示例展示输入事件、处理步骤和输出记录。注意：没有触发器，所有写操作由应用层显式完成；`source` 字段为运维排查提供来源线索；`timestamp` 使用整数毫秒，避免字符串解析。

## 性能、质量与可观测性指标

1. **启动迁移耗时**：在应用启动时记录 `migration_elapsed_ms`，若超过 500ms 即告警，超过 2000ms 标记为严重，需拆分迁移。
2. **查询 P99 延迟**：对核心查询使用 `EXPLAIN QUERY PLAN` 和运行时计时，P99 超过 50ms 需检查索引或反规范化视图。
3. **数据库文件增长率**：每周采样 `.db` 文件大小，若周增长率超过 20% 且无大量附件写入，需排查重复数据或日志未清理。
4. **WAL 文件大小**：`PRAGMA wal_checkpoint` 后检查 `-wal` 文件，若超过主文件 50%，说明检查点不足或长事务未提交。
5. **迁移失败率**：统计启动时迁移失败次数，任何非零失败都应阻断启动并触发人工介入。
6. **数据一致性校验**：运行 `PRAGMA integrity_check`，对大型库改为 `PRAGMA quick_check`；每周至少一次，输出必须为 "ok"。

## 失败模式、诊断证据与恢复动作

### 失败模式 1：迁移后版本号不匹配
诊断证据：应用启动日志报 `schema_meta.version = 5`，但代码期望 `4` 或 `6`。恢复动作：禁止降级；若版本超前，说明使用旧代码打开新数据库，必须升级应用。若版本落后，执行缺失迁移。

### 失败模式 2：磁盘满导致写入失败
诊断证据：SQLITE_FULL 错误码，`.db` 文件所在分区使用率 100%。恢复动作：清理 WAL 文件或附件；回滚未完成事务；若已损坏，从备份恢复。

### 失败模式 3：WAL 模式下的文件损坏
诊断证据：`-wal` 文件存在但主文件校验失败，或 `PRAGMA integrity_check` 返回非 "ok"。恢复动作：启动 SQLite 时尝试自动恢复；若失败，删除 `-wal` 和 `-shm` 文件并从最近备份重放。

### 失败模式 4：索引选择错误导致查询变慢
诊断证据：高频查询的 `EXPLAIN QUERY PLAN` 显示 "SCAN" 而非 "SEARCH"。恢复动作：添加复合索引，重新收集统计信息 `ANALYZE`，并回归测试写入性能。

### 失败模式 5：并发写入导致数据库锁定
诊断证据：SQLITE_BUSY 或 SQLITE_LOCKED，日志中出现 "database is locked"。恢复动作：在 Web 应用中使用单写队列或 `BEGIN IMMEDIATE` 抢占锁；多标签页场景使用 SharedWorker 统一写入。

### 失败模式 6：来源字段丢失导致无法审计
诊断证据：`source` 字段为 NULL 或不在枚举范围内。恢复动作：将该批次数据标记为 `unknown`，补充来源规则，后续写入强制校验。

## 问答测试样例

1. 正向：如何为本地文档表选择主键？答案：使用 UUID 文本主键，避免自增整数在多设备同步时冲突。
2. 正向：为什么时间戳用整数毫秒而非 ISO 字符串？答案：整数比较和排序更快，SQLite 无需解析字符串。
3. 边界：何时应该拆分多个 `.db` 文件？答案：仅在附件等大二进制数据需要独立文件系统管理时拆分，业务数据优先单文件。
4. 边界：STRICT 表在哪些场景不可用？答案：当目标 SQLite 版本低于 3.37.0 时不可用，需应用层类型校验替代。
5. 无证据拒答：这个 Schema 在 10 万并发写入下表现如何？答案：本文未提供该场景测试数据，无法回答。
6. 无证据拒答：与 PostgreSQL 相比哪个更好？答案：超出本文问题边界，本文只讨论本地 SQLite 设计。

## 维护、版本、来源与相邻主题

维护：Schema 变更必须通过版本化迁移脚本完成，禁止手动修改线上数据库。版本：迁移脚本遵循语义化版本，但数据库内版本号使用递增整数。来源：本文数据模型来源于 TypeScript/Web 本地数据场景，而非通用 OLTP 设计。相邻主题：与"SQLite 性能优化"共享索引策略，与"SQLite 与本地文件存储"互补，后者处理大文件存储路径。

## 结论

事实：SQLite 是单文件嵌入式数据库，支持 STRICT 表和 WAL 模式，通过 `schema_meta` 表可记录版本。推论：在单进程 Web 应用中，采用 WAL + 严格类型 + 版本化迁移 + 应用层审计，可显著提升本地数据的可观测性和恢复能力。未知：多进程写入、大规模附件、跨设备双向同步的具体上限，需要针对实际硬件和负载另行测试。
