---
type: concept
title: 一致性：实现视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。区分数据库事实、派生统计和模型生成解释
resource: .pi/knowledge/library/sqlite-data/consistency-implementation.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, consistency, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: consistency
variant: implementation
---

# 在 SQLite 本地知识库中区分事实、派生统计与模型解释的一致性实现

## 摘要与问题边界

在基于 TypeScript 的本地知识库（例如 Electron、Tauri 或 Node 服务）中，SQLite 常被用作无服务器的持久化层。然而，同一数据库中往往混杂三类信息：数据库事实（原始三元组或记录）、派生统计（聚合、计数、排名等）以及模型生成解释（LLM 输出的自然语言答案）。如果混淆三者的信任边界，检索器会把解释当作事实，Agent 会把统计当作来源，最终导致幻觉、不可复现结论和静默污染。

本文的实现视角聚焦于：如何在 SQLite 中显式区分这三类数据，并在输入、输出、错误、生命周期和验证上给出可执行的边界。适用范围限定为单设备本地 SQLite（使用 `better-sqlite3` 或 `node-sqlite3`），开启 WAL、外键和事务；不讨论跨设备同步、向量索引或云端一致性协议。

## 核心概念与数据模型

1. **事实行（Fact Row）**
   事实是知识库中的“原语”，使用 `(subject, predicate, object, source_uri)` 四元组存储。每一行必须附带 `recorded_at`（毫秒时间戳）和 `content_hash`，并按四元组设置唯一约束。事实默认不可变；若需要撤销，应插入一条 `predicate = 'deleted'` 的墓碑行，而不是物理删除。这保证了历史可审计。

2. **来源记录（Source）**
   每条事实必须关联到可验证的来源。来源表保存 `uri`、`retrieved_at`、`checksum`、`media_type` 和 `raw_bytes_hash`。边界例外：同一个来源文档可以解析出多条事实；若来源校验和失败，则该批次事实整体不可入库。

3. **派生统计（Derived Statistic）**
   派生值是从事实中通过 SQL 计算得到的聚合结果，例如 `COUNT(*)`、`SUM`、`AVG`。表中必须存储 `computation_sql`、`depends_on_facts`（JSON 数组，记录依赖的事实 ID）和 `computed_at`。派生统计是“性能缓存”，不是真理来源；任何时刻都可以被重新计算验证。

4. **解释节点（Explanation）**
   解释节点保存模型生成的自然语言答案，字段包括 `question`、`answer`、`supporting_fact_ids`（JSON 数组）、`model`、`generated_at`。它本身不携带事实地位；只有 `supporting_fact_ids` 中指向的事实才构成证据。

5. **世系与版本向量（Provenance & Version）**
   每次生成派生统计或解释时，都要记录“世系”：用了哪些事实、用了哪条 SQL 或哪个模型版本。同时维护 `schema_version` 表，确保迁移按顺序执行。版本向量是本地验证一致性的锚点。

6. **事务与快照（Transaction & Snapshot）**
   写入使用 `BEGIN IMMEDIATE`，读取使用 `BEGIN DEFERRED`。在 WAL 模式下，读事务看到一致的快照，写事务不会阻塞读事务。这是区分事实和解释生命周期的核心机制：事实写入后才允许生成依赖它的解释。

## 设计决策与取舍

### 1. 事实表与派生表物理分离

事实和派生统计放在不同表，派生统计不内联到事实表。代价是查询需要 JOIN 或先查事实再查统计；收益是避免更新派生字段时污染事实行，保证事实表的不可变语义。

### 2. 只追加事实与墓碑删除

不执行 `DELETE FROM facts`，而是插入墓碑行。取舍：存储持续增长，但可回答“某条事实何时被撤回”以及防止派生统计引用已消失行时产生悬空引用。外键约束和墓碑行一起工作，可以在读取时过滤。

### 3. 派生统计显式缓存

派生统计允许预计算并写入表，但每次写入必须附带 `computation_sql` 和 `depends_on_facts`。取舍：用空间换时间，同时保留可验证性。当事实表发生变化时，旧派生统计自动进入“过期”状态，直到下一次重新计算。

### 4. 模型解释必须引用事实 ID

生成解释时，强制要求 `supporting_fact_ids` 非空。如果没有匹配事实，系统拒绝生成答案。取舍：牺牲一部分“自然语言流畅度”，换来可审计性和可证伪性。用户始终可以追溯到“答案是基于哪几行事实”。

### 5. WAL + 严格外键 + 显式事务边界

使用 `PRAGMA journal_mode = WAL` 和 `PRAGMA foreign_keys = ON`。写入事务失败快速抛出 `SQLITE_BUSY`，而不是无限等待。取舍：SQLite 在单文件写模式下只能串行写入，因此写操作必须做重试和队列；但读操作可高并发。

## 可执行的实施流程

1. **Schema 初始化**：创建 `facts`、`sources`、`derived_stats`、`explanations`、`schema_version` 表，设置唯一约束、外键和索引；开启 WAL 和外键。
2. **输入校验**：接收本地文件或 API 负载时，先校验 `source_uri` 和 `checksum`；校验失败立即拒绝整批输入。
3. **来源原子写入**：在 `BEGIN IMMEDIATE` 事务中写入来源记录，避免重复来源导致的部分成功。
4. **事实解析与去重**：将来源内容解析为三元组，使用 `INSERT ... ON CONFLICT(subject, predicate, object, source_uri) DO NOTHING` 去重；记录 `recorded_at` 和 `content_hash`。
5. **墓碑处理**：若解析结果包含撤销声明，插入墓碑行，并将被撤销事实标记为 `superseded_by`。
6. **派生统计计算**：在只读快照中运行 `computation_sql`，将结果写入 `derived_stats`，并记录依赖的事实 ID。
7. **解释生成**：在事实表上检索关键词或 ID；若无命中，返回拒绝；若命中，调用模型生成带引用的答案并持久化。
8. **一致性巡检**：定时或事件触发，重新计算派生统计并与存储值对比，检测漂移；同时扫描解释节点，确认所有 `supporting_fact_ids` 仍然有效。

## 输入、处理与输出示例

以下是一个最小化的 TypeScript 片段，使用 `better-sqlite3` 表达“事实 → 派生统计 → 解释”的流水线。输入是本地 Markdown 文件解析出的三元组；处理包括校验、写入、计算和引用；输出是带事实 ID 的答案。

```typescript
import Database from 'better-sqlite3';

const db = new Database('knowledge.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    source_uri TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    UNIQUE(subject, predicate, object, source_uri)
  );
  CREATE TABLE IF NOT EXISTS derived_stats (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    value REAL NOT NULL,
    computation_sql TEXT NOT NULL,
    depends_on_facts TEXT NOT NULL,
    computed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS explanations (
    id INTEGER PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    supporting_fact_ids TEXT NOT NULL,
    model TEXT NOT NULL,
    generated_at INTEGER NOT NULL
  );
`);

function insertFact(triple: { subject: string; predicate: string; object: string; source_uri: string }) {
  const stmt = db.prepare(`
    INSERT INTO facts (subject, predicate, object, source_uri, recorded_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(subject, predicate, object, source_uri) DO NOTHING
  `);
  const result = stmt.run(triple.subject, triple.predicate, triple.object, triple.source_uri, Date.now());
  if (result.changes === 0) throw new Error('duplicate fact');
}

function computeCount(): number {
  const value = db.prepare(`SELECT COUNT(*) FROM facts WHERE predicate != 'deleted'`).pluck().get() as number;
  const sql = `SELECT COUNT(*) FROM facts WHERE predicate != 'deleted'`;
  const deps = db.prepare(`SELECT id FROM facts WHERE predicate != 'deleted'`).pluck().all() as number[];
  db.prepare(`
    INSERT INTO derived_stats (name, value, computation_sql, depends_on_facts, computed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      value = excluded.value,
      computation_sql = excluded.computation_sql,
      depends_on_facts = excluded.depends_on_facts,
      computed_at = excluded.computed_at
  `).run('active_fact_count', value, sql, JSON.stringify(deps), Date.now());
  return value;
}

function explain(question: string, model: string) {
  const like = `%${question}%`;
  const rows = db.prepare(`
    SELECT id, subject, predicate, object FROM facts
    WHERE (subject LIKE ? OR object LIKE ?) AND predicate != 'deleted'
  `).all(like, like) as Array<{ id: number; subject: string; predicate: string; object: string }>;
  if (rows.length === 0) return { answer: '无证据，无法生成解释。', supporting_fact_ids: [] };
  const ids = rows.map(r => r.id);
  const summary = rows.map(r => `${r.subject} ${r.predicate} ${r.object}`).join('；');
  const answer = `${model}：基于 ${rows.length} 条事实，${summary}`;
  db.prepare(`
    INSERT INTO explanations (question, answer, supporting_fact_ids, model, generated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(question, answer, JSON.stringify(ids), model, Date.now());
  return { answer, supporting_fact_ids: ids };
}
```

在此示例中，输入是经过校验的三元组；处理依次完成去重写入、派生统计刷新、解释生成与引用；输出是带有 `supporting_fact_ids` 的结构化答案，可以直接被 Agent 验证或驳回。

## 性能、质量与可观测性指标

1. **写入延迟 p99**
   在每次 `insertFact` 或批次写入前后调用 `performance.now()`，记录并聚合。目标：单机本地写 < 50 ms p99。

2. **派生统计新鲜度**
   测量 `max(now - computed_at)`。若超过阈值（例如 5 分钟），触发重新计算。可观测字段是 `derived_stats.computed_at`。

3. **解释引用覆盖率**
   统计 `explanations` 中 `supporting_fact_ids` 非空且所有 ID 仍存在于 `facts` 表的记录比例。低于 100% 时应告警。

4. **一致性重算偏差率**
   定期用 `computation_sql` 重新计算派生统计，与 `value` 对比。记录不一致次数 / 总次数。目标偏差率为 0。

5. **无证据拒绝率**
   记录 `explain` 返回“无证据”的比例。过高说明检索策略或来源质量有问题，而非模型问题。

6. **并发写锁等待次数**
   捕获 `SQLITE_BUSY` 错误次数，评估写队列和重试策略是否充分。

## 失败模式、诊断证据与恢复动作

1. **WAL 文件损坏或截断**
   诊断证据：`PRAGMA integrity_check` 返回非 `ok`，或 `better-sqlite3` 抛出 `SQLITE_CORRUPT`。恢复动作：从备份恢复 `.db`、`.db-wal`、`.db-shm`；若备份不可用，删除 `-wal` 和 `-shm` 后以 `PRAGMA wal_checkpoint(RESTART)` 重新打开。

2. **事实重复写入导致唯一冲突**
   诊断证据：`result.changes === 0` 或 `SQLITE_CONSTRAINT_UNIQUE`。恢复动作：在生产代码中视重复为幂等成功；若是误报，用 `content_hash` 区分同一来源不同版本。

3. **派生统计与事实不同步**
   诊断证据：`computed_at` 早于最近的事实写入时间，或重算值与存储值不同。恢复动作：以事实变更事件触发派生统计刷新，并重新生成依赖该统计的解释。

4. **解释引用已删除或不存在的事实**
   诊断证据：巡检发现 `supporting_fact_ids` 中存在未在 `facts` 表中的 ID，或对应事实 predicate 为 `deleted`。恢复动作：将该解释标记为 `stale`，并重新调用 `explain` 生成新答案。

5. **并发写入触发 `SQLITE_BUSY`**
   诊断证据：写操作抛出 `SqliteError: database is locked`。恢复动作：在写入层实现指数退避重试；若持续出现，则引入单线程写队列序列化所有写请求。

6. **来源文件校验和失败**
   诊断证据：解析出的 `raw_bytes_hash` 与本地文件 SHA-256 不一致。恢复动作：整批拒绝入库，提示用户重新拉取来源文件，避免用损坏或过期的文件生成事实。

## 问答测试样例

1. **正向问题**：`project-alpha` 的当前依赖版本是多少？
   期望：返回 `facts` 中 `subject = 'project-alpha'` 且 `predicate = 'dependsOn'` 的 `object` 值，并附带 `source_uri`。

2. **正向问题**：知识库中一共有多少条有效事实？
   期望：返回 `derived_stats.name = 'active_fact_count'` 的 `value`，并确认 `depends_on_facts` 包含所有非墓碑事实 ID。

3. **正向问题**：为什么 `project-alpha` 不能升级到 Node 20？
   期望：解释节点返回模型答案，且 `supporting_fact_ids` 非空，所有 ID 均能在 `facts` 表中找到。

4. **边界问题**：某条事实已被标记为 `deleted`，查询该事实时是否返回？
   期望：默认读取层过滤墓碑行，返回“无此事实”；审计接口可返回墓碑记录。

5. **边界问题**：派生统计依赖的事实集合为空，查询该统计时应返回什么？
   期望：返回 `0` 或语义明确的 `null`，而不是模型生成的“无数据”。

6. **无证据拒答**：查询一个从未收录的主题。
   期望：返回固定拒绝消息，如“无证据，无法生成解释。”，不调用模型，不生成空引用。

## 维护、版本、来源与相邻主题的关系

- **Schema 迁移**：维护 `schema_version` 表，每个迁移文件必须是幂等的，并记录执行时间。迁移顺序不可跳过，避免外键约束不一致。
- **来源版本**：为每个来源文件附加版本标签，例如 `docs/arch/v1.2.0.md`。当来源更新时，重新解析并写入新的事实行；旧版本事实可通过 `source_uri` 区分。
- **与同步的关系**：跨设备同步属于相邻主题，应在 SQLite 之上另建同步层；本文的本地一致性不保证多设备冲突解决。
- **与向量检索的关系**：向量索引用于相似度检索，但检索结果必须映射到事实行的 ID 才能进入解释引用链。
- **与备份的关系**：备份必须同时复制 `.db`、`.db-wal`、`.db-shm` 或在应用 `PRAGMA wal_checkpoint(TRUNCATE)` 后复制单文件，否则恢复可能丢失未提交事实。
- **与缓存的关系**：`derived_stats` 本身是一种缓存，因此过期策略必须明确，不能把它当作持久事实直接使用。

## 结论

在上述实现中，**事实**是 `facts` 表中带有 `source_uri` 和 `recorded_at` 的行，是整栋知识库中唯一被直接信任的数据层；**派生统计**是可通过 `computation_sql` 和 `depends_on_facts` 重新验证的推论，其价值是性能，但真理地位低于事实；**模型解释**是模型生成的语言产物，只有当它携带有效 `supporting_fact_ids` 时才能被引用，否则应被拒绝。

仍然未知的是：来源文档本身的现实正确性（我们只能验证校验和，不能验证业务真伪）、模型在引用事实时的语义忠实度，以及未来 schema 升级对历史解释节点的兼容性。这些不属于 SQLite 一致性范畴，应在来源治理和模型评估流程中单独处理。
