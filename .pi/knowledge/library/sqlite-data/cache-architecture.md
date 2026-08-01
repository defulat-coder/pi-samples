---
type: concept
title: 查询缓存：架构视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。对稳定读取复用结果，但在数据变更时准确失效
resource: .pi/knowledge/library/sqlite-data/cache-architecture.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, cache, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: cache
variant: architecture
---

# SQLite 本地查询缓存：稳定读取与精确失效的架构设计

## 摘要与问题边界

在基于 SQLite 的本地优先应用、桌面工具或离线文件知识库中，读取操作通常占据绝大部分执行路径。反复执行相同的 SELECT 会消耗解析、B-tree 遍历与序列化成本，而这些成本在结果集较大或连接复杂时尤为明显。查询缓存的目标是在**数据未发生变更的时间段内复用稳定读取结果**，同时一旦相关表被写入，就必须**准确失效**，避免返回过期数据。

本文讨论的缓存位于应用层与 SQLite 之间，不是 SQLite 内部的页缓存或查询规划器缓存。它适用于：写操作通过统一数据访问层完成、查询结果可确定性复用、单进程或受控多进程环境。它明确不覆盖：分布式缓存、跨网络共享数据库、直接绕过封装层执行 SQL 的临时脚本，以及依赖非确定性函数（如 `RANDOM()`、`datetime('now')`）的查询。

## 核心概念与数据模型

1. **稳定查询**：仅指 SELECT 语句，结果在相同已提交数据快照下可重复得到；不包含副作用、临时表、非确定性函数或行级锁提示。
2. **缓存键**：由规范化后的 SQL 文本、绑定参数序列化值、schema 版本号与只读隔离标签共同生成。SQL 空格统一，参数顺序固定，以保证相同语义产生相同键。
3. **缓存条目**：包含结果行集合、创建时间、依赖表清单、每个依赖表的脏计数器快照、schema 版本、行数与 CRC32 校验和。
4. **依赖表集合**：从查询的 FROM 与 JOIN 子句提取出的逻辑表名集合。写操作命中其中任一表，即触发该条目失效。
5. **表级脏计数器**：每个业务表维护一个单调递增的整数，在成功提交且确实修改该表的事务后递增。计数器是判断缓存是否过期的核心信号。
6. **快照合约**：缓存命中仅在条目记录的每个依赖表脏计数器与当前计数器一致，且 schema 版本匹配时成立；任一条件失败即视为过期。
7. **可替换缓存存储**：通过 `CacheStore` 接口抽象，底层可替换为内存 Map、IndexedDB、本地文件或 LRU 结构；具体实现不影响上层失效语义。
8. **TTL 安全网**：即使主动失效机制存在缺陷，缓存条目也设置最大存活时间，作为最终一致性兜底，而非主要失效手段。

## 设计决策与取舍

### 1. 失效粒度：表级优先于行级
表级失效实现简单，且天然安全：只要表被修改，所有依赖该表的缓存全部作废。行级失效虽更精细，但需要追踪主键变更、处理子查询与触发器级联，并存在遗漏风险。默认采用表级；只有在命中率严重不足且写操作高度局部化时，才考虑引入行级扩展。

### 2. 缓存键必须包含参数与 schema 版本
仅对 SQL 文本取哈希会忽略参数差异，导致不同输入返回相同结果；忽略 schema 版本则会在迁移后因列布局变化产生旧格式数据。键中必须纳入绑定参数和 schema 版本，这是避免静默错误的最小必要信息。

### 3. 一致性：只读事务可缓存，写事务内绕过缓存
在同一事务中先写入再读取，必须看到自身未提交的变更，因此必须绕过缓存。跨事务读取可复用缓存，但过期窗口受失效延迟上限约束。设计层应明确“写连接”与“读连接”的区分，避免读-your-writes 被破坏。

### 4. 存储介质：热路径用内存，冷启动用持久化
内存缓存访问最快，但随进程退出而丢失。对于 Web/本地文件知识库，可将持久化缓存放在 IndexedDB 或本地 JSON 文件中，以加速冷启动；但持久化引入序列化成本与跨进程失效风险，需要 schema 版本号作为防线。

### 5. 主动失效为主，TTL 为辅
主动失效在写事务提交后立即递增脏计数器并清除相关条目，精确且延迟低。TTL 仅作为异常兜底，例如脏计数器更新失败或缓存键冲突导致未命中失效。TTL 不应被当作常规策略，否则会掩盖一致性问题。

### 6. 并发模型：单写队列 + WAL 多读
SQLite 在 WAL 模式下支持多读者与一个写者。缓存存储本身需要线程安全，但所有写事务与失效通知应通过单一写队列或连接完成，确保脏计数器单调递增与缓存清除之间的顺序可预测。

## 可执行的实施流程

1. 定义稳定查询分类器：明确允许 SELECT、确定性参数、固定 ORDER BY 与 LIMIT；禁止 `RANDOM()`、`TIME()`、CTE 副作用与未绑定参数。
2. 建立依赖表提取器：使用 SQL 解析器或维护的表别名映射，从查询中提取依赖表；解析失败时直接标记为不可缓存。
3. 设计 `CacheStore` 接口，至少包含 `get(key)`、`set(key, entry)`、`delete(predicate)`、`clear()` 与 `size()`。
4. 在数据访问层封装 `query()`：生成缓存键 → 查询缓存 → 验证依赖表脏计数器与 schema 版本 → 命中则返回，否则执行 SQLite。
5. 在写入封装层拦截 `run()` 与事务：记录本次事务修改的表集合，提交成功后递增对应脏计数器，并删除依赖这些表的全部缓存条目。
6. 添加 schema 迁移钩子：迁移脚本完成后递增全局 `schemaVersion`，使旧键自然失效，并可选清空持久化缓存。
7. 设置容量与淘汰策略：限制最大条目数、最大字节数，采用 LRU 淘汰，避免内存无界增长。
8. 引入单飞行请求：对同一缓存键的并发未命中，仅让一个请求访问 SQLite，其余等待结果，防止缓存击穿。
9. 埋入可观测性指标：命中、未命中、主动失效、过期读取、跳过的计数器，按查询模式聚合。
10. 灰度启用：先对报表类只读查询启用，验证命中率与过期读取数为零后，再扩大至高频率列表查询。

## TypeScript 示例：查询缓存接口与失效流程

```typescript
type CacheKey = string;

interface CacheEntry<T> {
  rows: T[];
  createdAt: number;
  schemaVersion: number;
  dependencies: string[];       // 依赖的表名
  tableVersions: Record<string, number>; // 每个表的脏计数器快照
  checksum: number;
}

interface CacheStore {
  get<T>(key: CacheKey): CacheEntry<T> | undefined;
  set<T>(key: CacheKey, entry: CacheEntry<T>): void;
  invalidate(predicate: (entry: CacheEntry<unknown>) => boolean): void;
}

class QueryCache {
  constructor(
    private store: CacheStore,
    private getSchemaVersion: () => number,
    private getTableVersion: (table: string) => number,
  ) {}

  query<T>(sql: string, params: unknown[], dependencies: string[]): T[] {
    const key = this.makeKey(sql, params);
    const entry = this.store.get<T>(key);

    if (entry && this.isValid(entry)) {
      return entry.rows;
    }

    const rows = executeSqliteQuery<T>(sql, params);
    this.store.set(key, {
      rows,
      createdAt: Date.now(),
      schemaVersion: this.getSchemaVersion(),
      dependencies,
      tableVersions: Object.fromEntries(
        dependencies.map(t => [t, this.getTableVersion(t)])
      ),
      checksum: crc32(rows),
    });
    return rows;
  }

  private isValid(entry: CacheEntry<unknown>): boolean {
    if (entry.schemaVersion !== this.getSchemaVersion()) return false;
    return entry.dependencies.every(
      t => entry.tableVersions[t] === this.getTableVersion(t)
    );
  }

  private makeKey(sql: string, params: unknown[]): CacheKey {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return sha256(`${normalized}|${JSON.stringify(params)}|${this.getSchemaVersion()}`);
  }
}

// 写事务提交后调用
function onTablesWritten(store: CacheStore, tables: string[]) {
  incrementTableVersions(tables); // 在 SQLite 中递增脏计数器
  store.invalidate(e => e.dependencies.some(t => tables.includes(t)));
}
```

**输入**：规范化 SQL、绑定参数、schema 版本、依赖表清单。
**处理**：生成缓存键；命中后校验 schema 版本与每个依赖表的脏计数器；未命中则访问 SQLite，并将结果连同元数据写入缓存。
**输出**：稳定查询的结果行，或在数据变更后自动失效的重新查询结果。

## 性能、质量与可观测性指标

1. **缓存命中率**：`hits / (hits + misses)`，按查询模式分组。低于 20% 说明缓存价值有限或失效过于激进。
2. **平均失效延迟**：从事务提交到相关缓存条目被清除的时间。应接近零；若持续大于 10ms，需检查写队列串行化开销。
3. **过期读取计数**：返回后发现校验和或脏计数器不匹配的次数。目标为零，任何非零值都表示失效链路存在缺陷。
4. **缓存项平均存储成本**：序列化后字节数除以行数。用于决定内存缓存与持久化缓存的容量上限。
5. **P99 读取延迟**：对比启用缓存前后的同负载测试。若缓存后反而升高，需排查序列化与键生成开销。
6. **缓存命中率下降率**：版本升级或迁移后是否出现骤降，用于评估 schema 版本策略是否生效。

## 失败模式、诊断证据与恢复动作

1. **未失效导致过期读取**：表现为返回结果与 SQLite 当前内容不一致。证据是校验和匹配失败或脏计数器滞后。恢复：读取路径中后置校验依赖表版本，若发现不一致则立即回退并重新查询。
2. **过度失效引发缓存抖动**：大量读取仍走数据库，命中率持续低于预期。证据是写入表与读取表高度重合但变更行并不重叠。恢复：先排除高频写表对应的查询，再评估是否引入行级失效。
3. **缓存键冲突**：不同参数或不同 schema 下返回相同结果。证据是缓存键未包含参数或 schema 版本。恢复：在键生成中强制加入参数序列化与 schema 版本。
4. **跨版本持久化污染**：迁移后读取缓存出现列缺失或类型错误。证据是 schema 版本不匹配。恢复：在缓存键中嵌入 schema 版本，并在迁移钩子中清空旧缓存。
5. **读写并发竞态**：读操作在失效完成前命中旧条目。证据是读取时脏计数器等于条目值，但读取完成后立即变大。恢复：读取路径采用原子比较并设置读取时间戳，或在返回前重校验一次。
6. **缓存击穿/雪崩**：大量并发请求同时未命中同一键，导致 SQLite 压力骤增。证据是未命中 spikes 与数据库 CPU 同步上升。恢复：引入单飞行请求模式，合并同一键的并发查询。

## 问答测试样例

1. **正向**：哪些查询适合缓存？
   适合：频繁读取、依赖表少、写入频率低、结果在相同快照下可重复的 SELECT。

2. **边界**：`SELECT * FROM notes LIMIT 3` 是否可缓存？
   若存在稳定 `ORDER BY` 且写入不频繁，可缓存；若无 `ORDER BY`，结果顺序不确定，应标记为不可缓存。

3. **边界**：使用 `datetime('now')` 的查询能否缓存？
   不能，因为每次执行结果不同，违反稳定查询定义。

4. **无证据**：当前部署的缓存命中率是多少？
   未提供运行时指标，无法回答。

5. **无证据**：缓存是否一定比直接查询更快？
   否。是否更快取决于命中率、结果集大小与序列化成本；需要实际测量。

6. **边界**：同一事务内先写入 notes 表再读取 notes 表，能否命中缓存？
   不能。必须绕过缓存，以保证读取到自身未提交的变更。

7. **正向**：schema 迁移后如何保证缓存不返回旧数据？
   在缓存键中嵌入 schema 版本，并在迁移脚本完成后递增该版本或清空缓存。

## 维护、版本、来源与相邻主题关系

缓存条目的格式版本应与业务 schema 版本独立管理。每次升级缓存结构时，提升 `cacheStoreVersion`；启动时若发现旧版本，执行全量清空。缓存永远只是 SQLite 的投影，真正的数据源仍是数据库文件。

相邻主题包括：SQLite 内部查询规划器缓存（不可控，不在本文范围）、物化视图（可替代部分缓存职责）、WAL 模式与检查点（决定读取快照边界）、IndexedDB/本地文件持久化（承载缓存存储）、离线同步（远程变更应用后需触发同样的表级失效）。

## 结论

- **事实**：SQLite 在单文件模式下提供强一致的事务语义；表级写事务可以原子性地递增脏计数器；缓存键可由 SQL 文本、参数、schema 版本稳定生成。
- **推论**：对于以稳定读取为主、所有写操作通过统一数据访问层的本地应用，表级失效的查询缓存能够在不牺牲一致性的前提下显著降低重复读取开销。
- **未知**：具体业务查询的真实命中分布、行级失效在本地场景中的收益阈值、跨进程缓存失效所需的信令成本与复杂度。这些需要通过部署后的指标、负载测试与真实用户行为逐步验证。
