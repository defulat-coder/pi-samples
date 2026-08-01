---
type: concept
title: Schema 设计：实现视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。为实体、状态、时间和来源建立可演进的本地数据模型
resource: .pi/knowledge/library/sqlite-data/schema-implementation.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, schema, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: schema
variant: implementation
---

# SQLite 本地可演进 Schema 设计：为实体、状态、时间与来源建模

## 摘要与问题边界

本文讨论在单一 SQLite 文件中，为 TypeScript 客户端应用建立一套可演进的本地数据模型。核心目标是把“实体身份、状态变更、发生时间和数据谱系”四项需求固化为 Schema 与迁移流程，而不是依赖运行时约定。适用场景包括浏览器 OPFS、Electron 主进程、Tauri 本地层或 React Native 文件系统。范围限定在单节点 SQLite 3.45+，不考虑多节点同时写入同一文件的并发协议；也不包括服务端数据库、全文检索插件或加密扩展。

## 核心概念与数据模型

1. **实体主键采用时间有序标识符**：优先使用 ULID 或 UUIDv7，存储为 `TEXT` 或 `BLOB`，避免自增整数。时间有序标识符让本地新行在 B-tree 页中近似顺序插入，减少页分裂，同时保证跨设备生成时不冲突。

2. **每行携带状态版本**：每个业务表必须包含 `state_version INTEGER NOT NULL DEFAULT 1` 和可选 `base_version INTEGER`。更新时要求客户端传入旧 `state_version`，写入前校验；匹配则 `state_version = state_version + 1`，不匹配则返回并发冲突错误。

3. **时间字段拆分物理语义**：保留 `created_at INTEGER NOT NULL` 与 `updated_at INTEGER NOT NULL`，以 Unix 毫秒存储；软删除使用 `deleted_at INTEGER`。不使用 `DATETIME` 字符串，因为 SQLite 不做类型检查，整数比较更稳定。本地时钟不可信，因此 `updated_at` 只用于展示排序，不用于因果判定。

4. **来源与谱系列**：业务表添加 `source_id TEXT`、`device_id TEXT`、`sync_generation INTEGER`。`source_id` 标记首次产生这条记录的上下文，`device_id` 标记最后一次修改的设备，`sync_generation` 记录这条行已经参与过的同步世代。删除或合并时，这些列保留审计痕迹。

5. **公共列模板**：为所有业务表定义 `common_columns` 模板：`id`, `created_at`, `updated_at`, `deleted_at`, `state_version`, `base_version`, `source_id`, `device_id`, `sync_generation`。迁移生成器自动追加到每个 CREATE TABLE 语句，避免手工遗漏。

6. **Schema 元数据表**：维护一张 `schema_migrations` 表，记录 `version INTEGER PRIMARY KEY`, `name TEXT`, `hash TEXT`, `applied_at INTEGER`, `duration_ms INTEGER`, `tool_version TEXT`。同时通过 `PRAGMA user_version` 保存当前迁移版本，作为快速判断依据，但真实来源仍是 `schema_migrations` 的行集合。

## 设计决策与取舍

### 1. 主键用 `TEXT` 还是 `BLOB`
`TEXT` 可读、便于调试和日志输出，但占用约 26 字节；`BLOB` 存储 ULID 原始 16 字节，节省 38% 空间。推荐默认 `TEXT`  unless 表行数预计超过千万且索引内存敏感。无论选哪种，必须在应用层统一生成，不能混用。

### 2. 规范化表与 JSON 列的边界
关系型强约束字段拆成列：外键、状态版本、时间、来源。不稳定或可选的半结构化属性放入 `metadata BLOB` 并使用 SQLite 3.45 的 JSONB 存储。这样既能用 `json_extract` 查询，又能减少列变更频率。不要把嵌套数组或搜索过滤条件频繁使用的字段仅放在 JSON 中。

### 3. 软删除还是归档表
默认采用 `deleted_at` 软删除，因为本地数据常需“撤销删除”。但批量清理任务应把过期软删除行迁移到 `_archive` 表或导出文件后物理删除，否则业务索引会随删除行膨胀。归档表结构与原表一致，但不参与日常查询。

### 4. 乐观锁与最后写入胜出
本地离线场景优先使用乐观锁：`UPDATE ... WHERE state_version = :base_version`。如果应用允许用户离线修改同一实体并在同步时合并，则再叠加一套基于字段级 diff 的合并策略。不要把乐观锁当成同步冲突解决协议。

### 5. 迁移脚本内置还是独立文件
迁移脚本以版本号文件保存在应用包内，例如 `migrations/0003-add-task-project-id.sql`，运行时按顺序执行。内置迁移便于版本锁定，但升级后旧脚本不可修改；若发现 bug，只能通过追加新迁移修复，确保已升级客户端与未升级客户端路径一致。

## 可执行的实施流程

1. 列出所有域实体和它们的生命周期事件，明确哪些事件会触发创建、更新、软删除和归档。
2. 在代码里定义 `commonColumns` 常量，规定所有业务表必须继承的公共列名、类型与默认值。
3. 为每个迁移文件命名 `XXXX-description.sql`，并计算 SHA-256 哈希，写入构建产物清单。
4. 启动数据库连接时，先执行 `PRAGMA foreign_keys = ON`、`PRAGMA journal_mode = WAL`，再进入迁移事务。
5. 按版本号顺序读取迁移文件，使用 `PRAGMA user_version` 判断起始点；每条迁移在显式事务中执行，失败立即回滚。
6. 迁移完成后，把版本号、哈希、耗时写入 `schema_migrations`，并用 `PRAGMA foreign_key_check` 验证完整性。
7. 在 TypeScript 包装层为每个实体定义 Zod schema；写操作先解析输入，再构造参数化 SQL，禁止字符串拼接。
8. 建立 `schema_health` 巡检：对比期望列集合与实际 `PRAGMA table_info` 结果， mismatch 时触发只读模式并上报。

## YAML 迁移与处理示例

    migrations/0002-create-note.yaml
    version: 2
    name: create_note_table
    hash: sha256:7a3f...
    sql: |
      CREATE TABLE IF NOT EXISTS note (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        project_id TEXT REFERENCES project(id) DEFERRABLE INITIALLY DEFERRED,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        state_version INTEGER NOT NULL DEFAULT 1,
        base_version INTEGER,
        source_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        sync_generation INTEGER NOT NULL DEFAULT 0,
        metadata BLOB CHECK(json_valid(metadata))
      );

输入：一段 Zod 校验后的 `NoteInput`，包含 `title`、`body`、`project_id`、`metadata`，由 TypeScript 包装层自动生成 `id`（ULID）、`created_at`、`updated_at`、当前 `device_id` 和 `source_id`。

处理：包装层执行 `INSERT INTO note (...) VALUES (...)`；若 `project_id` 指向不存在的项目，由于外键是 `DEFERRABLE INITIALLY DEFERRED`，在事务提交时才检查，允许同一事务内先插入项目再插入笔记。

输出：返回 `{ id, state_version: 1, created_at, updated_at }`；失败时抛出带 SQL 错误码的 `DatabaseError`，由调用方决定是否重试或提示用户。

## 性能、质量和可观测性指标

1. **迁移耗时**：在 `schema_migrations.duration_ms` 中记录每次迁移耗时。可接受阈值：单条迁移不超过 500 ms；大型表重建应拆成多步并提示用户。
2. **查询延迟 p95**：对关键路径 SQL 使用 `EXPLAIN QUERY PLAN` 确认是否命中索引，并在包装层用 `performance.now()` 记录 p95，目标低于 10 ms。
3. **完整性违规计数**：每次写事务后执行 `PRAGMA foreign_key_check`，返回非空数组即视为违规；目标为零。
4. **模式漂移检测**：启动时计算所有业务表列名的哈希，与构建产物中的期望哈希比较；任何 mismatch 触发告警并进入只读模式。
5. **输入拒绝率**：统计 Zod parse 失败次数占总写请求比例；持续高于 2% 说明 Schema 与 UI 模型不同步。

## 失败模式、诊断证据与恢复动作

1. **迁移重复执行导致 duplicate column**：诊断证据为 `SQLITE_ERROR(1) duplicate column name`。恢复：所有 ALTER TABLE 迁移使用 `IF NOT EXISTS`，并把破坏性变更拆成“新增新列—拷贝数据—删除旧列”三步。
2. **外键级联失败或孤立行**：诊断证据为 `PRAGMA foreign_key_check` 返回行。恢复：先打开 `PRAGMA foreign_keys = OFF` 进行数据修复，或运行预定的调和脚本；修复后必须重新校验。
3. **并发写导致 SQLITE_BUSY**：诊断证据为错误码 5。恢复：包装层实现指数退避重试；重试失败后把操作加入本地队列，按顺序单线程执行。
4. **本地时钟回拨造成 updated_at 小于 created_at**：诊断证据为表中存在 `updated_at < created_at` 的行。恢复：在 BEFORE UPDATE 触发器或包装层中校验 `new_updated_at >= old_updated_at`，否则用单调递增序列替代并标记 `clock_suspect=1`。
5. **升级后模式哈希不匹配**：诊断证据为 `schema_health` 巡检返回列集差异。恢复：立即停止写操作，从备份快照恢复数据库，或应用缺失的迁移；不能在不验证的情况下强制写。

## 问答测试样例

1. **正向**：向 `note` 表插入合法记录后，`state_version` 是否等于 1？期望：是，且 `created_at` 与 `updated_at` 相等。
2. **正向**：更新标题并传入正确 `state_version`，返回值中 `state_version` 是否加 1、`updated_at` 是否增大？期望：是。
3. **边界**：用 `state_version = 1` 更新已被其他进程改为 `state_version = 2` 的行，是否返回并发冲突错误且不修改数据？期望：是。
4. **边界**：插入 `deleted_at` 为非零、`created_at` 为未来的记录，是否被拒绝？期望：包装层 Zod 或触发器拒绝。
5. **无证据拒答**：“如果同步服务器也使用 SQLite，Schema 应该怎么设计？” 应拒绝：项目未提供同步服务端实现，不能推断。
6. **无证据拒答**：“SQLite JSONB 在 3.38 是否可用？” 应拒绝：项目依赖 3.45+，3.38 不在验证范围。

## 维护、版本、来源与相邻主题关系

迁移文件和 `schema_migrations` 表共同构成版本来源。每次发布新应用版本时，新增迁移文件并更新构建产物哈希清单。`schema_migrations.tool_version` 记录生成该次迁移的 CLI 版本。相邻主题包括：本地同步策略（向量时钟、CRDT 或基于版本的合并）、备份与恢复（文件快照与 WAL 文件成对保存）、查询优化（索引、覆盖查询）、安全沙箱（数据库文件权限与加密扩展）。Schema 设计本身不解决同步冲突，但为冲突检测提供 `state_version` 和 `sync_generation` 字段。

## 结论

事实是：SQLite 3.45+ 支持 JSONB、WAL 和延迟外键；`INTEGER` 时间戳比 `TEXT` 更适合比较；ULID/UUIDv7 是跨设备生成主键的可靠方式。推论是：为每行加入 `state_version`、`source_id`、`device_id`、`sync_generation` 后，本地 Schema 可以在不破坏旧客户端的情况下逐步演进，乐观锁也能过滤掉大量简单的并发写冲突。未知是：具体应用的数据规模、设备时钟精度、同步协议选型以及是否需要端到端加密，这些因素会改变索引策略、归档周期和迁移拆分粒度，需要在项目级原型中验证。
