---
type: concept
title: 事务边界：架构视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。让写入、索引更新和状态变化在一个一致性边界内完成
resource: .pi/knowledge/library/sqlite-data/transaction-architecture.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, transaction, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: transaction
variant: architecture
---

# SQLite 本地数据事务边界：把写入、索引更新与状态变化锁进一致性边界

## 摘要与问题边界

本地优先应用把 SQLite 当作事实来源时，一次业务操作往往同时改动行记录、索引页、触发器派生状态、外键约束与内存视图。若这些步骤跨越多个事务，崩溃或并发会让系统陷入“索引指向不存在的行”或“缓存已更新但数据未落盘”的中间态。事务边界的作用，是把相关变化定义为单一责任单元，保证提交时全部可见、回滚时全部撤销。具体实现必须在责任边界清楚之后才能决定：由领域层定义一次业务事务包含哪些表与派生状态，再由仓库层选择 SQLite 原语。

## 核心概念与数据模型

1. 一致性边界作为责任单元
   一个事务边界对应一个聚合一致性单元，封装所有写入、索引维护、派生状态与文件元数据变化，外部只能通过边界入口进入，提交后结果对外可见。

2. SQLite 事务原语
   `BEGIN` 标记起点，`COMMIT` 原子持久化，`ROLLBACK` 恢复到起点。`BEGIN IMMEDIATE` 在开始时获取写锁；`BEGIN DEFERRED` 延迟加锁直到首次写入。

3. 隐式事务与自动提交
   未显式 `BEGIN` 时，每条语句在独立自动提交事务中执行。跨语句的“全部成功或全部失败”无法自动保证，必须由业务层显式包裹。

4. 保存点与子边界
   `SAVEPOINT name` 在事务内部创建嵌套检查点，`ROLLBACK TO name` 可撤销部分步骤而保留外层事务。适合长流程中需要局部回滚的场景。

5. WAL 与提交语义
   WAL 模式下，`COMMIT` 先写日志再择机 checkpoint。`PRAGMA synchronous` 决定崩溃后是否丢失已确认提交；`DELETE` 模式直接在主文件回滚，并发写较低。

6. 索引、约束与触发器的边界内行为
   显式事务中，插入、更新、删除会同时维护 B-tree 索引、执行触发器、校验外键与检查约束。这些副作用回滚时一并撤销，无需在事务外单独处理。

## 设计决策与取舍

### 显式事务封装层优于自动提交
由仓库层统一执行 `BEGIN`/`COMMIT`，业务代码只调用 `unitOfWork.run()`。责任边界清晰，也便于替换后端。例外：纯读取或单次点查可直接走自动提交，不必强包事务。

### 何时使用 `BEGIN IMMEDIATE`
当操作第一步就是写入时，`BEGIN IMMEDIATE` 可尽早声明写意图，防止中途才获取锁失败。例外：若事务先大量读取再决定是否写入，用 `BEGIN DEFERRED` 减少读锁争用，但需捕获锁升级异常。

### WAL 作为默认本地策略
WAL 让读不阻塞写，崩溃恢复通过日志重放。适合单写多读的本地文件场景。例外：只读或严格空间受限设备可用 `DELETE` 模式，避免额外 `-wal` 文件。

### 保存点 vs 扁平事务
扁平事务实现简单，但一次失败必须整体撤销。保存点允许局部回滚，代价是必须维护保存点栈，并确保回滚到保存点后应用状态也回退到对应版本。

### 同步级别与性能
`PRAGMA synchronous = NORMAL` 在 WAL 下是性能与持久性折中；`FULL` 更安全但延迟更高。例外：临时缓存可设为 `OFF`，但不应作为事实来源默认设置。

## 可执行的实施流程

1. 识别领域聚合：列出业务命令会修改的表、索引、触发器和外部状态。
2. 定义 `UnitOfWork` 接口：声明 `start()`、`commit()`、`rollback()`、`savepoint(name)`、`rollbackTo(name)`。
3. 实现 SQLite 适配器：在 `start()` 中执行 `BEGIN IMMEDIATE` 或 `DEFERRED`，保存连接标识。
4. 校验前提：写入前执行 `SELECT` 校验外键、版本号与资源占用。
5. 执行写入：按依赖顺序执行 `INSERT`/`UPDATE`/`DELETE`，让索引和触发器自然更新。
6. 更新派生状态：刷新物化视图或内存快照，仍停留在同一事务内。
7. 提交并捕获异常：执行 `COMMIT`，捕获 `SQLITE_BUSY` 或 `SQLITE_CONSTRAINT`，失败则回滚。
8. 回滚同步：一旦回滚，删除或重置所有已生成但未提交的应用内存对象。
9. 记录可观测：记录事务持续时间、影响行数、是否重试、WAL 大小。
10. 编写边界测试：覆盖提交成功、部分失败回滚、并发冲突、磁盘满与断电模拟。

## 示例：TypeScript 本地文件知识库的更新单元

    unit: knowledge-update
    domain: note
    transaction_mode: IMMEDIATE
    synchronous: NORMAL
    journal_mode: WAL
    inputs:
      - table: notes
        action: UPSERT
        row: { id: n_42, title: 事务边界, body: "..." }
      - table: note_tags
        action: REPLACE
        rows:
          - { note_id: n_42, tag_id: t_07 }
          - { note_id: n_42, tag_id: t_12 }
      - index: idx_note_tags_tag
        owner: sqlite_engine
      - materialized: search_cache
        owner: app
    process:
      - start transaction
      - validate note_id and tag references
      - upsert notes row
      - delete old note_tags then insert new ones
      - engine updates idx_note_tags_tag
      - refresh search_cache in memory snapshot
      - commit; on failure rollback to savepoint pre_note
    outputs:
      - durable: notes and note_tags rows on disk
      - derived: search_cache consistent with committed rows
      - observable: transaction_latency_ms, rows_affected

输入包括主表、关联表、引擎维护的索引以及应用维护的物化缓存。处理阶段在同一事务内完成写入与索引更新，并设置保存点。输出区分持久化数据、派生状态与可观测指标，确保失败时回退到一致起点。

## 性能、质量与可观测性指标

1. 事务端到端延迟：从 `BEGIN` 到 `COMMIT` 的耗时，按 p50、p95、p99 分桶。超过阈值则拆分大事务或改为批量写入。
2. 单次事务影响行数：统计主表与派生表的行变更总量。过大说明一次边界内包含过多聚合。
3. 回滚与冲突率：记录 `ROLLBACK`、`SQLITE_BUSY`、`SQLITE_LOCKED` 次数。高冲突率提示事务过长或锁策略需调整。
4. WAL 文件大小与 checkpoint 间隔：读取 `PRAGMA wal_checkpoint(TRUNCATE)` 前后的页数，或监控 `-wal` 增长。异常增长说明 checkpoint 被长读事务阻塞。
5. 完整性校验通过率：定期运行 `PRAGMA integrity_check`，确认索引页、B-tree 和页面顺序无损坏。

## 常见失败模式、诊断证据与恢复动作

1. 部分写入导致外键约束失败
   证据：`SQLITE_CONSTRAINT_FOREIGNKEY`。
   恢复：立即回滚，修复应用层引用顺序，确保父表先于子表插入。

2. 事务中途进程崩溃
   证据：重启后存在热日志，自动回滚或重放。
   恢复：启动时执行 `PRAGMA integrity_check` 与 `PRAGMA wal_checkpoint(RESTART)`，必要时重新计算派生状态。

3. 写锁超时导致 `SQLITE_BUSY`
   证据：日志出现 `database is locked`。
   恢复：设置 `busy_timeout` 退避，或改为 `BEGIN IMMEDIATE` 并缩短事务。

4. 磁盘满在提交时失败
   证据：COMMIT 抛出 I/O 错误，磁盘空间告警。
   恢复：回滚当前事务，清理日志或扩容，回滚前禁止任何新写入。

5. 应用内存缓存与数据库不一致
   证据：缓存命中但搜索结果缺失。
   恢复：以事务提交为信号刷新缓存；回滚时丢弃缓存增量，或按版本号重载。

## 问答测试样例

1. 正向：一次更新笔记标题和标签应分几个事务？
   答案：应放入同一个显式事务，主表与关联表一起提交，否则标签更新成功而笔记失败会出现孤儿标签。

2. 边界：若只需要撤销标签改动但保留笔记内容，应使用什么机制？
   答案：在外层事务内设置 `SAVEPOINT pre_tags`，失败后 `ROLLBACK TO pre_tags`，外层继续。

3. 边界：在 WAL 模式下，读取操作是否会阻塞提交？
   答案：读取不会阻塞写入提交，但长时间读取会阻止 checkpoint 截断日志。

4. 无证据拒答：事务边界能否保证宿主操作系统不崩溃丢失数据？
   答案：不能仅凭事务边界保证；还取决于 `synchronous`、文件系统 `fsync` 与硬件。无具体配置证据时不能给出绝对承诺。

5. 无证据拒答：使用 `BEGIN DEFERRED` 是否一定比 `BEGIN IMMEDIATE` 并发更好？
   答案：不一定。若事务最终都会写入，延迟加锁只是把冲突后移到写入阶段，可能导致更多重试。需工作负载证据。

6. 正向：仓库层应何时把索引更新纳入事务？
   答案：只要索引对应主表或关联表在事务内被修改，索引更新由 SQLite 引擎在同一事务内自动完成，不应在事务外手动操作。

## 维护、版本、来源与相邻主题

SQLite 的事务行为随版本演进。3.37.0 的 STRICT 表、3.38.0 的 JSON 路径写入、3.39.0 的 WAL 并发调整都可能影响默认边界行为。升级前应在测试库重跑 `busy_timeout`、锁模式与 `PRAGMA` 默认值。

Schema 迁移是特殊事务，DDL 通常需要排他锁。建议采用“新建表—回填—重命名—删除旧表”的在线迁移，或安排在低峰。备份应在 `COMMIT` 完成后执行 `VACUUM INTO` 或文件快照，避免复制到一半的事务。

相邻主题包括：SQLite 并发模型与锁、WAL 模式与 checkpoint 策略、本地文件同步与冲突解决、OPFS/Web Worker 连接管理、以及事务边界对事件溯源和 CQRS 本地投影的影响。事务边界本身不提供跨设备同步，只保证单设备内一致性。

## 结论

事实：SQLite 通过 `BEGIN`/`COMMIT`/`ROLLBACK` 和 `SAVEPOINT` 提供 ACID；索引、触发器、外键在显式事务内生效；WAL 模式把读写分离，但仍受 checkpoint 与锁限制。

推论：设计本地数据系统时，应先定义领域事务边界，再选择 `IMMEDIATE`/`DEFERRED`、WAL 模式、同步级别和保存点策略。仓库层应封装所有写入，避免业务代码绕过事务直接修改索引或状态。

未知：特定宿主文件系统（OPFS、Electron ASAR、加密文件系统）在崩溃时的 `fsync` 语义仍取决于浏览器和操作系统；跨设备冲突合并与事务边界之外的状态同步不在本文范围，需独立分析。
