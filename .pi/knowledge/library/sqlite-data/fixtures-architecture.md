---
type: concept
title: 测试夹具：架构视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。用确定性样本覆盖边界状态、空集、异常和时间窗口
resource: .pi/knowledge/library/sqlite-data/fixtures-architecture.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, fixtures, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: fixtures
variant: architecture
---

# SQLite 本地数据测试夹具：以确定性样本覆盖边界状态与可替换接口

## 摘要与问题边界

测试夹具不是“几条假数据”，而是本地 SQLite 数据层的一组可重复契约。它的核心责任是：在受控条件下，把数据库实例带入一个完全确定的状态，使同一代码在不同机器、不同时间对同一张表产生同一组断言结果。与之相邻但不得混淆的领域包括：数据库迁移正确性验证、文件系统锁与 WAL 并发测试、端到端同步冲突解决、以及加密 VFS 的集成测试。夹具本身不覆盖真实磁盘掉电、并发写锁竞争或 P2P 同步时序；它的边界止步于“单进程、可替换存储后端、可校验的样本集合”。凡是超出这个范围的问题，应交给专门的集成测试或混沌测试，而不是用更大的夹具去凑合。

## 核心概念与数据模型

1. **快照基元（Snapshot Primitive）**。每个夹具由四元组定义：`(schema_version, seed_id, invariant_set, connection_mode)`。`schema_version` 对应迁移脚本版本；`seed_id` 是唯一命名；`invariant_set` 是可机器校验的预期断言集合；`connection_mode` 区分 `:memory:`、临时文件、应用沙盒文件三种后端。
2. **边界状态表（Boundary State Catalog）**。显式枚举被测实体可能处于的边界状态：可空字段为 `NULL`、字符串为 `""`、整数为最大 64 位值、浮点数含舍入边界、外键全为 `NULL`、逻辑删除但尚未 `VACUUM` 的行。
3. **空集契约（Empty-Set Contract）**。存在一种“零行但 Schema 完整”的标准夹具，用于区分“查询返回空结果”与“表不存在导致的运行时错误”。空集夹具必须已执行 `CREATE TABLE`、索引、触发器和 `PRAGMA` 设置。
4. **异常注入点（Anomaly Injection Point）**。允许在受控位置写入非法或畸形数据，例如以 BLOB 保存非 UTF-8 字节、触发 `CHECK` 约束失败、制造部分唯一索引冲突。异常夹具必须有明确的预期错误码或行级标记，而不是让测试“随便报错”。
5. **时间窗口锚（Time-Window Anchor）**。用一个固定 UTC 时间戳作为锚点，所有时间偏移以 `anchor + seconds` 表示，避免使用 `Date.now()`。时间夹具同时覆盖闰秒无关的整秒偏移、负偏移、零长度窗口和跨日边界。
6. **可替换接口（Replaceable Fixture Loader）**。把夹具的“打开—播种—校验—快照—关闭”抽象为接口，使同一套种子在单元测试、CI、本地调试和性能基准中可以使用不同后端实现，而不修改测试断言本身。

## 设计决策与取舍

### 内存夹具与文件夹具
`:memory:` 启动快、回收简单，但无法覆盖 WAL 行为、页缓存、文件锁和 VFS 回调。临时文件夹具更贴近真实运行环境，却需要严格的 teardown 和跨平台临时目录管理。决策原则是：单进程单元测试优先使用内存夹具；凡涉及 `PRAGMA journal_mode=WAL`、多连接或文件系统边界的测试，必须使用临时文件夹具。

### 完全实例化与最小化实例化
完全实例化会创建所有表、索引、视图和触发器，能发现默认值与触发器错误，但加载慢、种子文件大。最小化只创建当前用例所需的表，速度快却可能漏掉跨表约束。推荐按 schema_version 做完全实例化，但允许用例通过标记选择性地禁用非相关触发器。

### 静态种子与程序化生成
静态 YAML/JSON 种子可版本控制、diff 清晰、失败时可回滚到已知状态。程序化生成可覆盖组合爆炸的边界状态，但 reproducing a failure 需要保存随机种子。策略是：80% 的夹具使用静态种子，20% 的边界状态由基于静态种子的确定性生成器派生，生成器的输入种子必须写入 CI 日志。

### 共享夹具与每用例隔离
共享夹具能显著降低大规模测试套件的总耗时，但一旦某个测试修改了数据，后续测试就会出现顺序依赖。默认策略是“每个用例独立加载”；只有在明确标记为只读且通过校验和冻结的基准夹具上，才允许共享。

### 校验前置还是后置
前置校验在加载前检查种子文件格式与约束，失败早、定位快；后置校验在数据库实例化后检查运行时不变量，例如外键、触发器结果和生成的 `rowid`。两者都要：前置校验拦截语法与类型错误，后置校验拦截 SQLite 运行时才暴露的语义错误。

## 可执行的实施流程

1. 在仓库中创建 `fixtures/sqlite/{schema_version}/` 目录，每个夹具以 `{seed_id}.yml` 命名，并随 schema 迁移同步版本化。
2. 定义 `FixtureLoader` 接口，包含 `open(manifest)`、`seed()`、`validate()`、`snapshot()`、`close()` 五个方法。
3. 为当前 schema 版本建立边界状态目录，给每个边界状态分配唯一 ID 和预期断言。
4. 实现空集夹具：执行完整 `CREATE` 与 `PRAGMA foreign_keys=ON`，但不插入任何业务行。
5. 实现异常夹具：以显式 `expected_error` 或 `row_marker` 描述每个异常的预期结果。
6. 实现时间窗口夹具：以 `anchor` 和固定偏移替换所有实时来源，并记录时间字段精度（秒或毫秒）。
7. 在 `validate()` 阶段计算确定性校验和：对固定列按主键排序后做哈希，比较实际结果与 `invariant_set`。
8. 将夹具加载嵌入测试框架的 `beforeEach`/`afterEach`，启用临时文件清理，并在 CI 中并行运行以验证隔离性。

## YAML 示例：边界状态夹具清单

```
fixture_id: notes_boundary_v3
schema_version: 3
connection_mode: file
anchor: "2024-01-15T08:00:00Z"
invariants:
  - query: "SELECT title FROM notes WHERE id='b1'"
    expected: [""]
  - query: "SELECT COUNT(*) FROM notes WHERE updated_at >= anchor AND updated_at < anchor + 3600"
    expected: [[2]]
  - query: "SELECT LENGTH(body) FROM notes WHERE id='c1'"
    expected: [[6]]
seed:
  notes:
    - id: b1
      title: ""
      body: null
      tags: null
      updated_at: anchor
    - id: b2
      title: "边界"
      body: "正常正文"
      tags: null
      updated_at: anchor + 1800
    - id: c1
      title: "异常编码"
      body_bytes: [0xC3, 0x28, 0x00, 0xE2, 0x99, 0xA5]
      tags: null
      updated_at: anchor + 3600
```

**输入**：一份声明式的夹具清单，含 schema 版本、连接模式、锚定时间、预期不变量及种子行。
**处理**：加载器按顺序建表、设置 `PRAGMA`、把 `body_bytes` 作为 BLOB 写入 `c1`，按锚点计算时间字段，再执行 `invariants` 中的查询。
**输出**：如果所有 `invariants` 结果匹配，则该夹具通过校验，测试可在其上进行业务逻辑断言；任一不匹配即中断并输出差异。

## 性能、质量与可观测性指标

1. **夹具加载延迟**：在每个 `beforeEach` 前后计时，目标 P95 低于 50ms（内存）或 200ms（临时文件）。
2. **Schema 实例化失败率**：统计 `open()` 抛出的异常次数除以总加载次数，CI 中应为 0%。
3. **边界断言通过率**：按边界状态 ID 记录通过/失败，要求每个 ID 在每次构建中都被执行。
4. **确定性校验和一致性**：同一夹具连续加载 10 次，校验和必须完全一致；任何差异都表示非确定性来源。
5. **临时文件泄漏数**：teardown 后扫描临时目录， leftover 文件数应为 0。
6. **测试隔离失败率**：通过随机打乱测试顺序运行，统计因夹具污染导致的 flaky 失败，目标为 0%。

## 失败模式、诊断证据与恢复动作

1. **外键悬空**。诊断证据：加载阶段抛出 `FOREIGN KEY constraint failed`。根因通常是种子行插入顺序未按依赖拓扑排序。恢复动作：在 loader 中实现拓扑排序，或在种子文件中显式标注 `depends_on`。
2. **时间窗口漂移**。诊断证据：范围查询返回空集，或边界行刚好落在窗口外。根因是使用了 `Date.now()` 而非 `anchor`。恢复动作：禁止实时时间进入种子；所有时间字段由 loader 从 `anchor + offset` 计算。
3. **空集混淆**。诊断证据：查询抛出 `no such table` 而不是返回零行。根因是测试忘了创建 schema。恢复动作：空集夹具必须强制完成 `CREATE TABLE` 与索引创建后再返回。
4. **共享夹具污染**。诊断证据：测试单独通过但批量运行时失败，或校验和在单次运行中不同。根因是某测试修改了共享数据。恢复动作：默认每用例独立加载；只读共享夹具必须加写保护断言。
5. **异常编码被静默转换**。诊断证据：写入 BLOB 后读取长度与原始字节数不符，或出现 Unicode 替换字符。根因是把字节序列当作 TEXT 插入。恢复动作：在种子格式中区分 `body`（TEXT）与 `body_bytes`（BLOB），loader 按类型绑定参数。
6. **WAL 检查点残留**。诊断证据：临时目录出现 `-wal`、`-shm` 文件，teardown 后未删除。根因是连接未正常关闭或检查点未执行。恢复动作：`close()` 中先 `PRAGMA wal_checkpoint(TRUNCATE)`，再关闭连接，最后删除文件。

## 问答测试样例

1. **正向问题**：`notes` 表中 `id='b1'` 的标题是什么？**答案**：空字符串 `""`。依据是边界状态目录中对该 ID 的显式预期。
2. **边界问题**：`updated_at` 在 `[anchor, anchor + 3600)` 秒范围内的记录有多少条？**答案**：2 条。注意右边界为开区间。
3. **空集问题**：`body IS NOT NULL` 的 `notes` 有多少条？**答案**：2 条。空集夹具下该查询应返回 0，但当前边界夹具含 2 条非空 body。
4. **异常问题**：`id='c1'` 的 `body` 长度是多少？**答案**：6 字节。若返回 4 或其他字符数，说明 loader 把 BLOB 误转为 TEXT。
5. **无证据拒答**：当前没有加载任何夹具元数据时，`notes` 表共有多少条记录？**答案**：无法回答。缺少 `schema_version` 与 `seed_id`，不能推断表是否已创建。
6. **时间窗口排序**：按 `updated_at DESC` 排列的第一条记录 ID 是什么？**答案**：`c1`。验证时间锚点、偏移精度和排序稳定性。

## 维护、版本、来源与相邻主题的关系

夹具文件必须与 schema 迁移脚本同版本号存放；schema 升级时，旧版夹具不得删除，而应迁移到新版并重新校验。种子数据最好从脱敏后的真实 staging 快照导出，但导出脚本必须清洗 PII、固定时间字段、并把浮点值规约到可复现精度。
相邻主题中，**迁移测试**验证从 `schema_version=N` 到 `N+1` 的结构转换；**属性测试**用随机数据探索夹具未覆盖的输入空间；**端到端同步测试**关注多设备间的冲突与合并。夹具为它们提供起点，但不替代它们。如果项目使用加密 VFS，应额外维护一套“已加密文件”夹具，因为内存夹具无法复现页级加密错误。

## 结论

**事实**：SQLite 是单文件数据库；`PRAGMA foreign_keys` 默认关闭；`INTEGER` 可存储 64 位有符号整数；夹具可以把同一份种子加载到内存或临时文件后端。
**推论**：通过可替换 loader 与确定性锚点时间，能够把大量边界状态测试从“运行环境依赖”转化为“版本化契约依赖”，并在 CI 中稳定复现。
**未知**：在 FAT32、Apple Silicon  Rosetta 转译、或加密 VFS 上的精确 I/O 时序与页缓存行为差异；schema 长期演进后旧夹具与新业务逻辑之间可能产生的隐性语义漂移。这些未知项不应由夹具假装覆盖，而应在集成测试与真实设备测试中单独立项。
