---
type: concept
title: 事务边界：实现视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。让写入、索引更新和状态变化在一个一致性边界内完成
resource: .pi/knowledge/library/sqlite-data/transaction-implementation.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, transaction, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: transaction
variant: implementation
---

# SQLite 本地事务边界：把写入、索引更新与状态变化锁定在单一一致性边界内

## 摘要与问题边界

本地优先或离线优先的 TypeScript 应用常在 Node/Bun/Electron 环境里把 SQLite 当作进程内数据存储。事务边界是这类应用最容易出错的地方：一次用户操作往往要修改若干行、更新全文检索索引、维护聚合计数并同步内存状态树。如果这四类动作不在同一一致性边界内完成，崩溃或重试后就会出现“数据库有、索引无”或“状态有、数据库无”的幽灵数据。

本文只讨论单一进程内的单写者多读者模型，不涉及分布式共识、主从复制或云端同步冲突解决。目标是把事务边界写成可验证的 TypeScript 代码。

## 核心概念与数据模型

1. ACID 边界以 BEGIN 为起点、COMMIT 或 ROLLBACK 为终点。IMMEDIATE 在事务开始时获取写锁；DEFERRED 延迟到首次写；EXCLUSIVE 排斥所有读者。模式选择决定边界与并发的权衡。

2. 写集是事务边界内必须一起生效的变更，包括目标表行、B-tree 索引页、触发器级联、聚合计数表以及全文检索索引表。任何一项失败，整个写集都要回滚。

3. 版本向量判断外部状态与数据库是否一致。每次提交后，聚合根维护单调递增的 version 字段；内存状态树只保存已提交版本，读操作通过版本号拒绝过期快照。

4. 工作单元是封闭函数：输入为已验证的 DTO，输出为成功结果或已分类错误，绝不泄漏半应用状态。它同时管理连接生命周期、保存点、提交与回滚。

5. 保存点是事务内的子边界。批量操作可在事务中设置 SAVEPOINT s1，子步骤失败时执行 ROLLBACK TO SAVEPOINT s1，外层事务仍可继续或最终提交。

6. WAL 模式扩展边界语义。在 WAL 下，读者通过快照读取旧版本，写者追加日志；COMMIT 完成后后续读者才可见。wal_checkpoint 决定何时合并回主库文件。

## 设计决策与取舍

1. 立即锁还是延迟锁？写操作为主时使用 BEGIN IMMEDIATE，可第一时间拿到写锁，避免执行到一半因 SQLITE_BUSY 失败回滚。若先读大量数据再写，可用 DEFERRED，但要在首次写前捕获繁忙异常。

2. 单一写连接还是连接池？SQLite 同一时刻只允许一个写入事务。与其多个连接竞争写锁，不如把写操作统一排队到一个写连接；读操作可另开只读连接，在 WAL 模式下读取稳定快照。

3. 内存状态先更新还是数据库先提交？正确顺序是：验证、开启事务、执行语句、提交，最后更新内存状态树。若先更新内存后崩溃，会出现脏状态；先提交后更新的短暂滞后可通过乐观占位或版本号解决。

4. 验证放在事务内还是事务外？结构合法性在事务前完成；依赖数据库上下文的语义校验（唯一性、外键、版本冲突）在事务内执行。这样锁持有时间最短。

5. 保存点 vs 完整事务？用户级一次点击对应一个完整事务；批量导入或后台同步可在事务内使用多个保存点，让单条失败仅回滚该记录。保存点会占用更多日志，但能减少批量重做成本。

## 可执行的实施流程

1. 定义输入契约：用 Zod 声明 DTO，包含业务字段、期望版本 expectedVersion、幂等键 requestId。无效输入在事务外直接返回 ValidationError。

2. 定义输出契约：成功返回 id、version、affectedRows、requestId；失败返回 kind、code、message、rolledBack。输出必须能被调用方写入日志和事件总线。

3. 建立错误分类：SQLITE_BUSY 为锁竞争，SQLITE_CONSTRAINT 为约束违反，DOMAIN_ERROR 为版本冲突或未找到，STATE_SYNC_ERROR 为提交后状态更新失败。每类都有明确重试或降级策略。

4. 声明生命周期钩子：beforeValidate、beforeBegin、afterCommit、afterRollback、afterRelease、afterStateSync。在钩子里记录耗时，不在这之外执行副作用。

5. 执行语义校验：BEGIN 后先 SELECT 检查目标记录版本和幂等键。若 expectedVersion 不匹配，立即 ROLLBACK 返回 VERSION_CONFLICT；若 requestId 已存在，返回缓存结果。

6. 选择事务模式并开启：写操作调用 BEGIN IMMEDIATE，读操作不需要事务时直接 SELECT。在写连接上维护队列，确保没有两个事务并发。

7. 执行语句并维护索引：主表变更、计数表更新、FTS 索引写入必须在同一事务内完成。任何语句失败，捕获异常并跳转回滚。

8. 提交、释放、同步状态：成功则 COMMIT，释放连接，再更新内存状态树并发布事件；失败则 ROLLBACK 并释放连接。提交后状态同步失败进入后台对账队列，禁止回滚已提交数据。

## TypeScript 实现示例

下面的实现假设封装了 Database 和 Transaction 对象，运行在 Node 或 Bun 进程内。输入为 CreateTaskInput，处理过程验证、开启事务、插入任务、更新项目版本、记录幂等结果，输出为 TaskResult 或分类错误。

    type CreateTaskInput = { title: string; projectId: number; requestId: string };
    type TaskResult = { id: number; title: string; projectVersion: number };

    async function createTask(db: Database, input: CreateTaskInput): Promise<TaskResult> {
      const parsed = taskSchema.parse(input);
      const tx = await db.begin("IMMEDIATE");
      try {
        const cached = await tx.get("SELECT payload FROM idempotency WHERE request_id = ?", parsed.requestId);
        if (cached) { await tx.commit(); return JSON.parse(cached.payload); }
        const project = await tx.get("SELECT version FROM projects WHERE id = ?", parsed.projectId);
        if (!project) throw new DomainError("PROJECT_NOT_FOUND");
        const { lastID } = await tx.run("INSERT INTO tasks (title, project_id) VALUES (?, ?)", parsed.title, parsed.projectId);
        await tx.run("UPDATE projects SET version = version + 1 WHERE id = ?", parsed.projectId);
        await tx.run("INSERT INTO idempotency (request_id, payload) VALUES (?, ?)", parsed.requestId, JSON.stringify({ id: lastID, title: parsed.title }));
        await tx.commit();
        return { id: lastID as number, title: parsed.title, projectVersion: project.version + 1 };
      } catch (err) {
        await tx.rollback();
        throw classifyError(err);
      } finally {
        tx.release();
      }
    }

输入是业务 DTO 和数据库连接；处理过程把验证、幂等检查、版本检查、主表插入、计数更新、幂等缓存写入包在单一事务内；输出是新生任务及项目新版本号。任何步骤失败，事务回滚，数据库不留下增量。

## 性能、质量与可观测性指标

1. 事务端到端耗时：从 beforeBegin 到 afterCommit 或 afterRollback 的时间戳差。目标 p99 低于 50 毫秒，单条写操作 p50 低于 5 毫秒。

2. 忙等待重试率：统计 SQLITE_BUSY 次数除以总事务数。该比率应低于 0.1%；若升高，说明写连接未充分串行化或事务粒度过大。

3. 回滚比例：被回滚事务数除以已开启事务数。异常回滚高于 5% 时，应检查验证逻辑或版本冲突策略。

4. 状态同步滞后：从 afterCommit 到 afterStateSync 的时间。若持续超过 16 毫秒，UI 可能出现可见闪烁，需要异步 reconcile 或乐观更新。

5. WAL 文件膨胀度：监控 -wal 文件大小与主库文件大小的
