---
type: concept
title: 迁移脚本：实现视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。在本地数据库迭代时兼顾旧数据、回滚和开发环境重建
resource: .pi/knowledge/library/sqlite-data/migration-implementation.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, migration, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: migration
variant: implementation
---

# SQLite 本地迁移脚本：在旧数据、回滚与重建之间保持可验证状态

## 摘要与问题边界

本地 SQLite 数据库的迭代不是一次性 schema 变更，而是需要反复在旧数据结构、回滚路径和开发环境重建之间切换的长周期过程。本文讨论的场景限定在单文件 SQLite、TypeScript 编写的迁移运行器、离线优先的桌面或 Web 本地存储应用。不包括多节点分布式数据库、服务端多租户 schema 管理，也不讨论纯内存 DB 或浏览器 IndexedDB 的抽象层。核心矛盾是：旧版本应用可能仍在读取旧 schema，而新版本必须在没有 DBA 介入的情况下安全升级；同时开发者需要随时把数据库重置到任意历史点以复现缺陷。

## 核心概念与数据模型

1. **迁移单元（Migration Unit）**：每个迁移必须包含全局唯一标识 `id`、内容校验和 `checksum`、执行时间戳 `applied_at`、顺序权重 `sequence` 以及可选的 `up_sql` 与 `down_sql`。`id` 一旦发布不可复用，即使内容被修正也应以新迁移追加，而非原地修改旧记录。
2. **迁移日志表（Schema Migrations Table）**：由运行器自行维护，字段至少包括 `id`、`checksum`、`execution_time_ms`、`rolled_back_at`、`operator`。它既是状态机，也是审计来源，必须与业务表在同一数据库文件内，避免跨文件一致性风险。
3. **基线快照（Baseline Snapshot）**：某一发布版本的 schema-only 导出，包含 `CREATE TABLE`、`CREATE INDEX`、`PRAGMA foreign_keys`、`PRAGMA user_version`。用于新环境快速重建，也用于校验当前文件是否与预期 schema 一致。
4. **兼容性矩阵（Compatibility Matrix）**：记录应用代码版本与数据库 schema 版本的合法组合。正向允许“新代码读旧 schema 并兼容”，反向则禁止“旧代码读新 schema”，除非显式声明降级窗口。
5. **幂等令牌（Idempotency Token）**：对 `up_sql` 做标准化（去除多余空白与注释）后计算 SHA-256，作为重试时的去重依据。运行器在事务开始前先比对令牌，已存在且一致则跳过，存在但不一致则报错。
6. **影子验证库（Shadow Validation DB）**：在 `:memory:` 或临时文件中按顺序重放迁移脚本，执行 `PRAGMA integrity_check` 与自定义断言，确认外键、触发器、默认值行为符合预期，再对真实文件操作。

## 设计决策与取舍

**序列号 vs 时间戳 vs 语义版本**
序列号（`0001`、`0002`）保证全序，适合 CI 合并冲突检测；语义版本（`v1.2.0`）便于人与发布说明对齐，但无法表达同一版本内的多次 schema 调整。建议以序列号作为运行器排序键，语义版本作为人工分组标签。

**向上/向下脚本对 vs 仅向前**
提供 `down` 脚本可以缩短开发调试周期，但生产环境通常禁止自动降级，因为旧代码可能无法识别新写入的数据。取舍方案是：开发环境允许 `migrate down`，生产环境仅记录 `down_sql` 作为灾难恢复参考，运行器默认拒绝执行。

**校验和严格模式 vs 修复模式**
严格模式要求已执行迁移的源码不可变更；修复模式允许管理员在显式 `--repair` 标志下用新 checksum 覆盖旧记录。默认启用严格模式，仅在自动化测试环境可临时开启修复模式。

**进程内运行器 vs CLI 运行器**
进程内运行器（主进程直接调用）延迟低，适合应用启动时自动迁移；CLI 运行器适合 CI 与脚本化运维。推荐两者共享同一 `MigrationRunner` 类，CLI 仅做参数解析与退出码映射。

**单迁移事务 vs 整批事务**
单迁移事务失败时粒度最细，但跨迁移的引用完整性可能需要在批次末尾才成立；整批事务原子性最强，却会让大型升级长时间持有写锁。折中方案：默认单迁移事务，但允许迁移元数据声明 `batch_group`，同组迁移共享事务。

## 可执行的实施流程

1. **探测并初始化日志表**：连接数据库后执行 `CREATE TABLE IF NOT EXISTS _migrations (...)`；若表已存在但缺少新字段，则先以小型迁移补齐元数据表自身。
2. **加载清单与排序**：从文件系统读取 `migrations/` 目录下所有 `.sql` 与 `.ts` 文件，按文件名前缀序列号排序；同步加载 `migrations/manifest.json` 中的元数据。
3. **计算待执行集合**：对比清单与日志表，得到 pending 列表；同时检查已记录迁移的 checksum，若与本地文件不一致则立即抛出 `ChecksumMismatchError`。
4. **获取写锁**：通过 `BEGIN EXCLUSIVE` 或文件级锁（`better-sqlite3` 的 `database.pragma('locking_mode=EXCLUSIVE')`）确保同一时刻只有一个进程执行迁移。
5. **影子预演**：在临时数据库按 pending 列表重放脚本，执行 `PRAGMA foreign_key_check` 与自定义行数断言；失败则直接退出，不触碰真实文件。
6. **真实执行与保存点**：对每个迁移开启 `SAVEPOINT`，执行 `up_sql`，记录结果；若失败则 `ROLLBACK TO SAVEPOINT` 并中断后续脚本。
7. **后置验证**：运行 `PRAGMA integrity_check`、`PRAGMA foreign_key_check`，并执行应用级断言（例如关键配置表至少保留一条记录）。
8. **记录与通知**：写入迁移日志，释放锁，通过事件总线发送 `migration:completed` 结构化事件，包含耗时与变更摘要。

## TypeScript 实施示例

```typescript
// 输入：migrations/0002_add_status.sql
// ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';

// 输入：清单项
interface Migration {
  id: string;
  sequence: number;
  upPath: string;
  downPath?: string;
  checksum: string;
  assertions?: string[];
}

// 处理：运行器核心
class MigrationRunner {
  constructor(private db: Database, private migrations: Migration[]) {}

  run(target?: string) {
    this.ensureJournal();
    const pending = this.computePending(target);
    for (const m of pending) {
      this.db.prepare('SAVEPOINT pre_migrate').run();
      try {
        const sql = readFileSync(m.upPath, 'utf8');
        if (sha256(sql) !== m.checksum) throw new ChecksumError(m.id);
        this.db.exec(sql);
        for (const a of m.assertions ?? []) this.db.exec(a);
        this.db.prepare(
          'INSERT INTO _migrations (id, checksum, execution_time_ms) VALUES (?, ?, ?)'
        ).run(m.id, m.checksum, Date.now() - start);
        this.db.prepare('RELEASE SAVEPOINT pre_migrate').run();
      } catch (e) {
        this.db.prepare('ROLLBACK TO SAVEPOINT pre_migrate').run();
        throw e;
      }
    }
  }
}

// 输出：迁移日志行
// { id: '0002_add_status', checksum: 'a1b2...', applied_at: '2026-01-09T12:00:00Z', execution_time_ms: 14 }
```

输入是 `migrations/` 目录下的 SQL 文件与 `manifest.json`；处理阶段按序列号顺序在事务保存点内执行并校验；输出是写入 `_migrations` 日志表的状态记录与应用可订阅的完成事件。

## 性能、质量与可观测性指标

1. **单次迁移耗时 P50/P99**：在目标设备上测量从 `BEGIN` 到 `COMMIT` 的 wall time；若 P99 超过 500 ms，需将大表变更拆分为多步或改用 `ALTER TABLE` 而非重建表。
2. **影子预演与真实执行差异率**：统计预演通过但真实执行失败的次数，目标为零；非零说明存在环境特异性（如不同 SQLite 版本默认行为）。
3. **回滚与失败次数**：按版本聚合 `ROLLBACK TO SAVEPOINT` 与 `ChecksumMismatchError` 次数，作为发布质量信号。
4. **Schema 漂移检测频率**：应用启动时对比当前 schema 与基线快照的哈希，漂移次数应接近零；偶发漂移通常来自手动用 GUI 工具改表。
5. **开发环境重建耗时**：从空目录到可运行状态（含迁移与种子数据）的端到端时间，用于评估 onboarding 成本。

## 失败模式、诊断证据与恢复动作

1. **校验和冲突**：日志表中的 `checksum` 与本地文件不一致。诊断证据为 `ChecksumMismatchError` 携带 `expected` 与 `actual` 哈希。恢复动作：确认是否有人手动修改已发布迁移；若是，追加修正迁移而非回改旧文件；仅在测试环境使用 `--repair`。
2. **写锁超时**：第二个进程在迁移期间尝试连接。诊断证据为 `SQLITE_BUSY` 或 `database is locked`。恢复动作：退出并提示用户关闭其他实例；生产环境应实现指数退避重试。
3. **批次中途失败**：部分迁移已提交，后续迁移报错。诊断证据为日志表中存在 `rolled_back_at IS NULL` 的最大序列号，但应用版本要求更高。恢复动作：依赖单迁移保存点回滚当前迁移，已提交的早期迁移由 `down` 脚本或基线重建处理。
4. **缺少向下脚本**：开发者请求降级到旧版本，但某一步 `downPath` 为空。诊断证据为 `MissingDownMigrationError`。恢复动作：提供基线快照重建数据库，或手动编写一次性 down 脚本。
5. **外键约束破坏**：`ALTER TABLE` 或 `DROP COLUMN` 后遗留孤儿行。诊断证据为 `PRAGMA foreign_key_check` 返回非空结果集。恢复动作：在事务内执行修复插入/删除，或回滚后先写数据修复迁移再执行 schema 变更。

## 问答测试样例

1. **正向**：当前数据库处于序列号 5，清单存在 6 与 7，应如何执行？答：按 6、7 顺序执行，每个在保存点内提交，最终日志表包含 7 条记录。
2. **边界**：清单为空且日志表不存在时启动应用会发生什么？答：运行器创建 `_migrations` 表并立即完成，不执行业务变更，应用版本与数据库版本均为基线。
3. **边界**：已应用迁移的本地文件被意外修改，校验和不匹配，运行器如何处理？答：在排序阶段即抛出 `ChecksumMismatchError`，不会进入事务，也不会修改任何业务数据。
4. **拒答**：能否用同一套脚本迁移 PostgreSQL？答：不在本文范围内；SQLite 的 `AUTOINCREMENT`、`TEXT` 与 PostgreSQL 的序列、类型系统差异太大，需要独立实现。
5. **无证据拒答**：如何在不查看清单的情况下判断数据库是否需要迁移？答：无法判断；必须读取清单与日志表进行比对，任何“自动感知”本质上都依赖隐藏的元数据。
6. **负向**：迁移日志表显示某条记录 `rolled_back_at` 非空，是否意味着数据库已回到旧版本？答：不一定；仅表示该迁移被回滚，但后续是否又有新迁移覆盖需查看最大序列号与 checksum。

## 维护、版本、来源与相邻主题的关系

迁移脚本必须与业务代码版本同仓管理，推荐在 `package.json` 的 `version` 与迁移目录之间建立映射表。来源 truth 是 `migrations/manifest.json`，构建时生成并随安装包分发；不应在运行时从网络拉取。与 ORM（如 Drizzle、TypeORM）的关系是互补：ORM 负责类型生成与查询构建，迁移运行器负责离线执行与回滚策略。与种子数据（seeding）的区别在于，迁移只改 schema 与必要数据转换，种子数据用于开发/测试环境初始化，不应进入生产迁移路径。与备份的关系是：迁移前建议自动触发 `VACUUM INTO` 或文件复制，但运行器本身不保证备份策略，仅提供事件钩子供外部系统注册。

## 结论

事实：SQLite 本地迁移可以通过序列号排序、校验和校验、保存点事务与迁移日志表实现可验证的 schema 演进。推论：在离线优先应用中，影子预演与单迁移保存点是平衡安全性与开发效率的最佳折中。未知：不同平台（iOS WKWebView、Android WebView、Electron 主进程）的文件锁行为差异对超大型迁移的具体影响，仍需在每个目标环境做实测并建立基准。
