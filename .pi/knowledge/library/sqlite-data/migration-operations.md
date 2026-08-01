---
type: concept
title: 迁移脚本：验证与运维视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。在本地数据库迭代时兼顾旧数据、回滚和开发环境重建
resource: .pi/knowledge/library/sqlite-data/migration-operations.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, migration, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: migration
variant: operations
---

# SQLite 本地数据迁移脚本：旧数据兼容、回滚与开发环境重建的验证与运维方法

## 摘要与问题边界

本地 SQLite 数据库以单文件承载应用状态，迁移脚本必须在不依赖服务端的情况下完成 schema 迭代。本视角把迁移当作一次可观测的运维事件：每次运行都要记录是否成功、失败、延迟、容量占用以及恢复路径，不能仅验证一次成功请求就结束。问题边界限定在同一文件内的版本演进；不包含远程同步、多设备并发写、也不把 ORM 自动迁移当作唯一来源。

## 核心概念与数据模型

1. `schema_version` 表：记录已执行迁移的 id、脚本 checksum、执行时间、执行结果、回滚标记。它是故障定位时的第一证据，不是辅助日志。
2. 迁移脚本单元：每个脚本对应单一版本跃迁，文件名或编号必须全序不可变；脚本内容视为只读，修改后 checksum 必须变化。
3. 旧数据兼容契约：新增非空列必须有默认值，删除列前要先确认没有任何查询引用，重命名列视为“删旧+增新”两步。
4. 基线快照：在重大迁移前对 `.sqlite` 文件做完整副本，包含 `-wal` 与 `-shm` 文件，否则无法恢复未 checkpoint 的数据。
5. 回滚/补偿脚本：与正向脚本一一对应，但只允许回滚到上一个已验证状态，不能任意跳跃；回滚脚本同样要经过 dry-run。
6. 验证断言：每条迁移脚本附带前置条件与后置条件查询，例如“执行后表 A 行数不少于执行前”，结果写入 `migration_log` 表。

## 设计决策与取舍

### 前向迁移与回退脚本
采用“小步快跑”的线性迁移，拒绝分支版本号。每个版本只保存到前一版本的回退脚本，降低状态空间爆炸风险。代价是跨多版本回滚需要顺序执行，耗时随版本数量线性增长。

### 事务边界与文件锁
SQLite 在单连接内支持 `BEGIN EXCLUSIVE` 事务，但迁移期间不能允许其他连接写数据库。代价是迁移窗口会阻塞应用；收益是失败时整体回滚，避免半完成 schema。

### 快照基线与开发环境重建
开发环境不直接基于生产文件，而是基于命名好的基线快照。重建时先复制基线，再按版本表执行到目标版本。这保证了“开发—测试—预发布”使用同一套脚本，而非手工改库。

### 破坏性变更与数据拷贝
对删表、删列、改类型等破坏性操作，先创建新结构并把旧数据迁移到新结构，再延迟删除旧对象。代价是磁盘临时翻倍；收益是保留回滚所需数据。

### 验证时机与运行方式
前置断言在事务开始前执行，后置断言在事务提交前执行。迁移脚本既支持命令行运行，也支持被测试框架调用；但生产环境必须命令行运行，便于审计日志与进程隔离。

## 可执行的实施流程

1. 盘点当前数据库对象：用 `sqlite_master` 与 `PRAGMA table_info` 导出 schema 清单，作为基线。
2. 建立 `schema_version` 表与 `migration_log` 表，定义命名约定，例如 `YYYYMMDD_NN_description.sql`。
3. 对当前数据库文件做完整快照，包含 `.sqlite`、`.sqlite-wal`、`.sqlite-shm`。
4. 编写正向迁移脚本，内含前置条件与后置条件 SQL，并标注破坏性变更等级。
5. 编写对应回滚脚本，回滚脚本必须声明适用版本与不可回滚数据范围。
6. 在开发副本执行 dry-run：复制快照后运行迁移，不提交事务，验证断言与执行时间。
7. 提交事务前采集行数、校验和、WAL 大小；提交后再次采集，形成差异记录。
8. 正式执行迁移，使用独立进程与独占事务，禁止应用连接并发写。
9. 执行回滚演练：从提交后的状态回滚到上一个版本，确认数据一致性与脚本有效。
10. 将本次脚本、校验和、执行结果写入版本控制，并更新开发环境重建文档。
11. 当 schema 再次演进时，重复步骤 3-10，旧基线最多保留最近三次以控制磁盘。

## 示例：本地迁移清单与验证记录

以下示例说明输入、处理、输出，适用于 TypeScript/Web 项目配合本地文件知识库。

    migrations/
      20250901_01_add_note_title.sql
        -- up
        ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT '';
        -- postcondition
        SELECT COUNT(*) FROM notes WHERE title IS NULL;
        -- expected 0
      20250901_01_add_note_title_rollback.sql
        -- down
        ALTER TABLE notes DROP COLUMN title;
        -- precondition
        SELECT COUNT(*) FROM notes WHERE title IS NOT NULL;
        -- expected 0 或允许保留旧值
    schema_version 记录：
      id: 20250901_01
      checksum: sha256:abc...
      applied_at: 2025-09-01T12:00:00Z
      result: success
      rollback_script: 20250901_01_add_note_title_rollback.sql

输入是旧数据库文件与脚本目录；处理是迁移运行器按版本顺序执行脚本并记录校验和；输出是升级后的数据库文件、更新后的 `schema_version` 表、以及包含断言结果的 `migration_log` 表。

## 性能、质量与可观测性指标

1. 迁移耗时：使用 `performance.now()` 或进程级计时，从启动到提交完成，按秒记录；超过基线两倍时告警。
2. 锁等待时间：在脚本执行前后查询 `PRAGMA lock_status` 或连接事件，记录应用连接被阻塞的秒数。
3. WAL 文件增长：执行前后测量 `-wal` 文件大小，异常膨胀说明事务过大或 checkpoint 不足。
4. 行数漂移：对受影响表执行 `COUNT(*)` 并写入日志，前后差异应等于预期新增/删除行数。
5. 校验和一致性：对数据库文件与每个脚本分别计算 sha256，迁移后校验和变化必须在预期范围内。
6. 验证查询延迟：每条后置断言执行时间单独记录，超过 100 ms 需检查索引。
7. 失败/重试次数：记录事务回滚次数与重试次数，任何非零值都要写入事件日志。

## 失败模式、诊断证据与恢复动作

1. 迁移中断导致版本表不一致：证据是 `schema_version` 中某条记录 `result` 为 `pending` 或 `failed`。恢复动作：回滚到上一个成功版本，修复脚本后重跑，禁止直接修改 `result` 字段。
2. 旧数据违反新约束：证据是后置断言返回非零，或 `ALTER TABLE` 报 `CHECK constraint failed`。恢复动作：先写数据清洗脚本，再重跑迁移；不可在迁移脚本中静默修正数据。
3. 回滚脚本失效：证据是回滚时报 `no such column` 或 `table already exists`。恢复动作：从基线快照恢复，并标记该迁移对为不可回滚，需重新设计。
4. 并发写造成锁或数据库损坏：证据是应用日志出现 `database is locked` 或 `database disk image is malformed`。恢复动作：先修复或替换文件，再强制所有迁移在独占事务中运行。
5. 磁盘或 WAL 容量耗尽：证据是写入报错 `database or disk is full`，或 `-wal` 文件超过数据库本体。恢复动作：扩容、执行 `PRAGMA wal_checkpoint(TRUNCATE)`，并拆分大事务。
6. 校验和漂移：证据是 `schema_version` 记录的 checksum 与脚本当前文件不一致。恢复动作：拒绝运行，重新审计脚本来源，禁止直接覆盖 checksum。

## 问答测试样例

1. 问：如何保留旧数据并完成 schema 升级？
   答：先创建基线快照，再使用带默认值的非空列添加策略，并通过后置断言确认旧行数据完整。证据：迁移前后行数一致。

2. 问：没有 down 脚本时如何回滚？
   答：优先使用基线快照恢复；若必须保留中间数据，则编写补偿脚本，但该脚本需要独立验证。边界：不能回滚到未记录版本。

3. 问：迁移被中断后怎么办？
   答：检查 `schema_version` 的 `result` 字段与 WAL 文件；若事务未提交则回滚，已提交但数据异常则使用快照恢复。证据：执行日志与行数校验。

4. 问：生产数据库当前多大？
   拒答：本地数据库大小不在本知识库中，需查看运行环境文件系统监控。

5. 问：迁移后查询变慢是否一定与迁移有关？
   拒答：无后置断言与性能基线时无法确认，需补充查询计划与执行时间记录。

6. 问：开发环境如何重建到任意版本？
   答：复制基线快照，按 `schema_version` 目标版本顺序执行脚本，并用校验和验证每一步。边界：缺少 WAL 文件时重建结果可能不完整。

## 维护、版本、来源与相邻主题关系

迁移脚本与业务代码同仓管理，版本号与发布号解耦，避免发布日期与 schema 版本强绑定。来源包括：当前 `schema_version` 表、脚本文件、`migration_log` 表、基线快照文件。相邻主题包括：SQLite WAL 与 checkpoint、备份与恢复、ORM 迁移抽象、本地文件存储与版本控制。本文不覆盖网络同步、加密数据库、以及多写者并发场景。

## 结论

事实：SQLite 迁移必须以单文件、单事务、线性版本的方式执行，且必须有 `schema_version` 与 `migration_log` 作为可审计证据。推论：只要保持脚本不可变、断言完整、快照可恢复，旧数据兼容、回滚与开发环境重建可以在本地稳定实现。未知：具体业务数据清洗规则、目标磁盘容量上限、以及未来 SQLite 版本对并发事务行为的调整，需要项目自身补充测量与记录。
