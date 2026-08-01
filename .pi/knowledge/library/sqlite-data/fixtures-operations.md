---
type: concept
title: 测试夹具：验证与运维视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。用确定性样本覆盖边界状态、空集、异常和时间窗口
resource: .pi/knowledge/library/sqlite-data/fixtures-operations.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, fixtures, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: fixtures
variant: operations
---

# SQLite 本地数据测试夹具：边界状态与恢复证据的确定性构造

## 摘要与问题边界

在依赖 SQLite 的本地数据系统中，测试夹具不仅是“造几条假数据”，而是为验证引擎、运维巡检和故障复盘提供可复现的初始状态。由于 SQLite 以单个文件承载 schema、索引、WAL 日志和临时数据，任何边界值、空集、并发锁或时间窗口处理失误都会在同一文件内被放大。本主题聚焦于如何构造确定性样本，使工程师能在隔离环境中观察到成功路径、失败路径、延迟抖动、容量阈值和恢复证据，避免“一次成功请求就通过验收”的盲区。问题边界限定在单进程或多进程访问同一 `.sqlite` 文件的场景，不覆盖远程网络分区或分布式事务。

## 核心概念与数据模型

1. **记录基线（Baseline Record）**：代表正常业务对象的最小完整行，包含所有非空列、合理的长度和正确的类型，用于正向回归测试。
2. **边界元组（Boundary Tuple）**：存储极值、空字符串、零长度 BLOB、`Infinity` 或 `NaN` 等 SQLite 可接受但业务逻辑可能异常的值。
3. **空集锚点（Empty Set Anchor）**：零行表、零字节数据库文件、仅有 schema 无数据的空壳，用于验证聚合查询和分页不会崩溃。
4. **异常注入标记（Exception Tag）**：显式声明某条记录预期触发 `SQLITE_CONSTRAINT`、`SQLITE_BUSY` 或 `SQLITE_CORRUPT`，便于断言层按标记捕获。
5. **时间窗口切片（Time Slice）**：以 UTC 为基准、带时区偏移和保留策略的时间点集合，覆盖闰秒、夏令时切换、毫秒边界和历史归档。
6. **容量阶梯（Capacity Ladder）**：按行数、单页大小、BLOB 体积、索引深度递增的样本层级，用于观测性能拐点而非单点吞吐。

## 设计决策与取舍

### 1. 文件级隔离 versus 内存级速度
使用 `:memory:` 数据库可获得最快 I/O，但无法验证 WAL 文件回滚、文件锁和磁盘 flush 行为。生产等价的夹具应优先使用临时文件，仅在单元级纯逻辑测试中使用内存库。

### 2. 静态样本 versus 动态生成
完全静态的 YAML 夹具可读性高，但难以覆盖随机 ID、时间戳和临时目录路径。推荐静态骨架加确定性生成函数：相同的种子产生相同的值，既保证可复现，又能构造大规模阶梯。

### 3. 真实 schema versus 简化 schema
简化 schema 测试更快，但会遗漏索引、外键和触发器引发的异常。夹具必须与目标 schema 版本保持一致，包括 `PRAGMA` 设置和迁移后的列默认值。

### 4. 单进程断言 versus 多进程并发
单进程测试只能证明代码逻辑正确，无法暴露 `SQLITE_BUSY` 或 `database is locked`。应额外启动辅助进程在同一文件上执行只读或短事务，以收集锁竞争证据。

### 5. 理想环境 versus 资源受限环境
在正常磁盘上测试通过，不代表在慢速 USB 盘或接近满盘时仍能恢复。夹具应能注入 I/O 延迟和剩余空间不足的模拟条件，记录超时与重试结果。

## 可执行的实施流程

1. 从版本控制中读取目标 schema 与迁移脚本，确保夹具 schema 与生产一致。
2. 为每个测试套件创建独立临时目录，目录名包含用例标识和进程 PID，避免并行污染。
3. 加载静态 YAML 骨架，解析出基线记录、边界元组、空集锚点和异常注入标记。
4. 以固定种子生成动态字段，包括主键、UUID、相对时间戳和文件路径，保证跨运行一致。
5. 执行 `PRAGMA journal_mode = WAL` 与 `PRAGMA foreign_keys = ON`，匹配生产默认配置。
6. 按依赖顺序插入样本数据，先基线、后边界、再异常；对预期失败的插入记录错误码与回滚证据。
7. 针对时间窗口样本执行保留策略清理、范围查询和归档边界断言，检查是否误删边界行。
8. 启动辅助进程模拟并发读取，收集 `SQLITE_BUSY` 次数、重试耗时和最终一致性证据。
9. 注入容量阶梯，逐步提升行数与 BLOB 大小，记录查询延迟 P50/P99 和文件体积增长。
10. 在测试收尾阶段调用 `PRAGMA integrity_check`，截断或重命名 WAL，验证恢复后数据完整性。

## 夹具示例与解释

```yaml
fixture_id: local_kb_v2_3
schema_version: 2025.06.01
database_path: "{tmp_dir}/test_kb.sqlite"
pragma:
  journal_mode: WAL
  foreign_keys: ON
  synchronous: NORMAL
records:
  baseline:
    - article_id: "art_1001"
      title: "SQLite 并发模型"
      body_size: 2048
      updated_at: "2025-06-01T12:00:00Z"
      tags: '["sqlite","local"]'
  boundary:
    - article_id: "art_max"
      title: ""
      body_size: 2147483647
      updated_at: "2038-01-19T03:14:07Z"
      tags: null
  empty_set:
    - table: search_index
      rows: 0
  exception:
    - article_id: "art_dup"
      expect_error: "SQLITE_CONSTRAINT_UNIQUE"
  time_slices:
    - label: dst_transition
      timestamps: ["2025-03-09T07:00:00Z", "2025-03-09T07:59:59Z", "2025-03-09T08:00:00Z"]
  capacity_ladder:
    - rows: 1000
      blob_kb: 16
    - rows: 100000
      blob_kb: 1024
```

输入为临时目录、schema 版本和 YAML 骨架；处理阶段将动态字段实例化、执行插入并捕获预期异常；输出为已填充的 SQLite 文件、插入日志、错误码清单和性能采样文件，供后续断言与复盘使用。

## 性能、质量和可观测性指标

1. **夹具加载耗时**：从创建临时文件到所有样本插入完成的时间，应低于目标测试用例总耗时的 10%，在 CI 中设置上限告警。
2. **查询延迟分位值**：对边界时间窗口和最大 BLOB 行执行 `SELECT`，采集 P50、P95、P99 延迟，识别索引失效或全表扫描。
3. **WAL 文件体积与 checkpoint 次数**：测试过程中记录 `wal_size` 和 `checkpoint` 调用次数，判断写模式是否合理。
4. **完整性检查结果**：每次测试收尾执行 `PRAGMA integrity_check`，输出必须为 `ok`，否则标记数据损坏或索引不一致。
5. **并发忙碌率**：辅助进程记录 `SQLITE_BUSY` 发生次数与重试总耗时， busy 率高于阈值说明锁粒度或事务长度过大。
6. **恢复后一致性成功率**：模拟崩溃后重新打开数据库，对比关键行哈希，确认 WAL 回滚或重做未丢失或重复数据。

## 失败模式、诊断证据与恢复动作

1. **schema 漂移导致夹具插入失败**：表现为 `SQLITE_ERROR: table has no column named ...`。恢复动作为同步迁移脚本、更新 YAML 骨架并重新生成夹具快照。
2. **外键约束在批量插入时触发**：错误码 `SQLITE_CONSTRAINT_FOREIGNKEY`。诊断证据是被引用表缺少对应主键；恢复动作为先插入依赖基线、再插入子表，或临时禁用外键但记录风险。
3. **并发写入导致 database is locked**：错误码 `SQLITE_BUSY`。证据包括 WAL 模式和 `busy_timeout` 未设置。恢复动作为增加超时、缩短事务、或将写操作序列化到队列。
4. **时间窗口清理误删边界数据**：表现为保留策略运行后，边界时间戳记录消失。证据是 `DELETE` 条件使用 `<=` 与 `<` 不一致。恢复动作为改用半开区间 `[start, end)` 并补充边界断言。
5. **大 BLOB 插入使文件暴涨但查询超时**：证据是文件体积正常但 `SELECT length(blob_col)` 延迟高于 P99 阈值。恢复动作为拆分 BLOB 到外部文件、使用 `WITHOUT ROWID` 或增加页面缓存。
6. **WAL 损坏导致数据库无法打开**：错误码 `SQLITE_CORRUPT`。证据是 `-wal` 或 `-shm` 文件大小异常。恢复动作为删除 WAL 前备份、用 `PRAGMA integrity_check` 验证，必要时从夹具重新初始化。

## 问答测试样例

1. 正向问题：加载上述 YAML 夹具后，`search_index` 表应有多少行？预期答案为 0，验证空集锚点生效。
2. 正向问题：基线记录 `art_1001` 的 `tags` 字段解析后应包含哪些标签？预期答案为 `sqlite` 和 `local`。
3. 边界问题：插入 `body_size` 为 `2147483647` 的记录时，哪些配置下会成功、哪些会失败？预期区分 64 位构建与 32 位构建、以及 `SQLITE_MAX_LENGTH` 限制。
4. 边界问题：夏令时切换时间窗口的三个时间点，在本地时区 America/New_York 下是否都能唯一排序？预期答案为需要按 UTC 排序，本地时间可能出现重复 01:59。
5. 无证据拒答：能否保证该夹具在 1 百万行时仍低于 100 ms？拒答条件：当前 YAML 只定义到 10 万行，未提供 1 百万行的测量数据。
6. 无证据拒答：如果磁盘已满，`PRAGMA integrity_check` 是否仍能返回 `ok`？拒答条件：该场景未在夹具中注入，无法给出可验证结论。

## 维护、版本、来源与相邻主题

夹具的 schema 版本必须与代码仓库中的迁移脚本绑定，推荐每次发布前运行 `pnpm typecheck` 与 `pnpm test`，并比对夹具输出哈希。版本号采用 `schema_version` 与 `fixture_id` 组合，避免旧测试读取新 schema 导致静默失败。来源包括 SQLite 官方文档、`sqlite3` 或 `better-sqlite3` 的 Node 绑定行为、以及项目自定义的 `AGENTS.md` 中关于本地文件隔离的约束。相邻主题包括“SQLite 迁移策略”“WAL 与并发控制”“本地文件沙箱与备份恢复”。夹具本身不替代备份，而是让备份恢复路径在受控条件下被反复验证。

## 结论

事实：SQLite 单文件架构使得 schema、索引、WAL 与数据共存一处；`PRAGMA integrity_check` 和 `busy_timeout` 是可观测的关键杠杆；确定性种子与临时目录隔离能够避免测试之间的状态泄漏。推论：当夹具同时覆盖空集、边界值、预期异常和时间窗口时，回归测试对生产故障的捕获率会显著高于仅使用正向样本。未知：具体业务在慢速磁盘、接近满盘或自定义 VFS 下的精确性能拐点，需要项目自行在 CI 或本地硬件上采样，不可直接套用通用阈值。
