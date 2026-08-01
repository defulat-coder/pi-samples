---
type: concept
title: Schema 设计：架构视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。为实体、状态、时间和来源建立可演进的本地数据模型
resource: .pi/knowledge/library/sqlite-data/schema-architecture.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, schema, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: schema
variant: architecture
---

# SQLite 本地数据 Schema 的演进式设计：实体、状态、时间与来源

## 摘要与问题边界

本地 SQLite 数据库不是远程关系型数据库的简化副本，而是面向离线、可审计、可替换存储边界的独立架构组件。本文讨论为 TypeScript/Web 与本地文件知识库场景设计可演进 Schema 的方法，重点解决四个问题：如何标识同一实体在多次同步、版本迁移与多来源合并中的稳定性；如何记录状态而不覆盖历史；如何表达时间语义而不混淆观察时间与发生时间；如何追踪数据来源以支持回滚与质疑。问题边界限定在单进程或主-渲染双进程架构中的本地 SQLite 设计，不涉及分布式事务、网络协议选型或云端主存储模型。

## 核心概念与数据模型

1.  **实体标识符（Entity ID）**：所有业务实体使用稳定且全局无依赖的标识符，例如 UUIDv7 或基于密钥派生的确定性标识。主键不使用自增整数，以避免合并、备份还原或 Schema 重建时出现身份冲突。
2.  **记录不可变性（Record Immutability）**：业务表默认只插入不更新，通过 `recorded_at` 与 `superseded_by` 字段形成版本链。更新操作转化为追加新行并将旧行标记为失效。
3.  **时间双轴（Bitemporal Time）**：每条事实记录同时携带 `valid_at`（事件发生时间）与 `recorded_at`（写入本地库时间）。查询默认按 `valid_at` 排序，审计按 `recorded_at` 排序。
4.  **来源与谱系（Provenance）**：每个记录必须携带 `source_id` 与 `source_uri` 或 `source_blob_hash`，标识数据来自用户输入、导入文件、同步端还是派生计算。派生记录还需 `derived_from` 数组。
5.  **Schema 版本元层（Schema Version Meta-layer）**：独立的 `schema_migrations` 表记录已应用迁移的编号、校验和、应用时间与应用进程。迁移脚本本身不嵌入业务 Schema，而是作为可回放的文件存储。
6.  **类型护栏（Type Guard）**：SQLite 原生类型较弱，因此在应用层通过 TypeScript branded type 与 Schema 约束结合，确保 `status` 等枚举字段只在允许的集合内取值。
7.  **软边界与隔离域（Isolation Domain）**：同一数据库可按 `domain` 列切分知识库、用户配置与缓存数据，使不同生命周期与保留策略的数据共存而不互相污染。
8.  **事件日志与物化视图（Event Log & Materialized View）**：以事件日志为单一写入源，业务查询表与搜索索引作为派生物化视图，支持重建。

## 设计决策与取舍

### 1. 自然键还是代理键
优先使用代理键，因为本地知识库经常导入外部文件，外部系统的自然键可能重复、缺失或变更。例外：当外部来源提供稳定且可校验的 DID 或 URL 时，可将其作为辅助唯一索引，但主键仍使用代理 UUID。

### 2. 宽表还是窄表
实体属性采用窄表或 JSON 列混合模式。固定、频繁查询、需要索引的字段使用正规列；扩展属性与不确定结构使用 `jsonb` 存储。取舍：避免在 SQLite 中滥用 JSON 列做过滤，因为 JSON 路径索引在大型数据集下性能有限。

### 3. 单文件还是多文件
默认使用单文件 SQLite，以简化备份与迁移。当数据量超过约 2GB 或需要按来源隔离时，拆分为多个附件数据库。风险：多文件增加了事务一致性成本，需要 `ATTACH DATABASE` 或应用层两阶段提交。

### 4. 触发器还是应用层控制
约束与计算优先放在应用层，触发器仅用于审计时间戳与级联标记失效。原因：触发器难以调试、测试与版本控制，且在不同 SQLite 工具中行为可能不一致。

### 5. 提前归一化还是延迟归一化
核心实体与关系立即归一化，但用于全文检索与聚合的派生表可延迟构建。该策略允许在未知查询模式时先记录事件，再逐步添加物化视图。

### 6. 严格模式还是宽松模式
启用 `PRAGMA foreign_keys = ON` 与 `PRAGMA strict_tables = ON`，使 Schema 在边界处拒绝非法写入。开发阶段允许临时关闭严格模式以进行数据修复，但修复脚本必须被记录。

## 可执行的实施流程

1.  **定义领域边界**：列出所有需要持久化的领域，例如文档、片段、标签、会话、配置、同步状态。
2.  **设计事件日志表**：建立 `events` 表，包含 `event_id`、`entity_type`、`entity_id`、`payload_json`、`valid_at`、`recorded_at`、`source_id`。
3.  **设计实体当前视图表**：基于事件日志建立 `documents`、`chunks` 等物化表，包含 `id`、`version`、`is_current`、`status`。
4.  **建立来源注册表**：创建 `sources` 表，记录 `source_id`、`source_type`、`source_uri`、`imported_at`、`checksum`。
5.  **编写迁移脚本**：每个迁移对应一个版本号、正向 SQL、回退 SQL 与校验和。
6.  **在应用层实现类型护栏**：使用 TypeScript 的 branded type 与运行时校验，确保写入前字段合法。
7.  **配置 SQLite 严格模式**：在连接初始化时执行 `PRAGMA foreign_keys = ON` 与 `PRAGMA strict_tables = ON`。
8.  **建立备份与校验机制**：每次迁移前后执行 `VACUUM` 与 `PRAGMA integrity_check`，并记录校验快照。
9.  **添加可观测性探针**：在写入路径中统计事件数、冲突数、迁移耗时。
10. **编写回滚测试**：在 CI 中模拟从旧版本数据库恢复到新版本，并验证数据等价性。

## 示例：本地文件知识库的 Schema 与处理

```yaml
schema:
  entities:
    - name: document
      columns:
        - id: uuid
        - title: text
        - file_hash: text
        - status: enum(draft, indexed, archived)
        - valid_at: datetime
        - recorded_at: datetime
        - source_id: uuid
        - is_current: boolean
    - name: chunk
      columns:
        - id: uuid
        - document_id: uuid
        - content: text
        - embedding_ref: text
        - valid_at: datetime
        - recorded_at: datetime
        - source_id: uuid
        - is_current: boolean
    - name: event_log
      columns:
        - event_id: uuid
        - entity_type: text
        - entity_id: uuid
        - operation: enum(insert, update, delete)
        - payload: json
        - valid_at: datetime
        - recorded_at: datetime
        - source_id: uuid
  migration:
    version: 3
    checksum: sha256:abc123
    dependencies: [1, 2]
```

输入：用户从本地导入一个 Markdown 文件。处理：生成文件哈希，向 `event_log` 插入 `insert` 事件；应用层消费事件，在 `document` 表插入新行，`is_current = true`，`source_id` 指向 `sources` 表中的导入记录。输出：用户查询时返回当前视图，审计时返回完整事件链。

## 性能、质量与可观测性指标

1.  **写放大率**：每次更新产生的新行数除以逻辑更新次数。目标小于 2.0。通过统计 `event_log` 行数与逻辑操作数之比测量。
2.  **查询 p99 延迟**：当前视图按 ID 查询的 p99 延迟应低于 5ms。使用 SQLite `EXPLAIN QUERY PLAN` 与性能测试工具测量。
3.  **迁移耗时**：单版本迁移在 100 万行数据下应完成于 30 秒内。通过迁移脚本计时测量。
4.  **Schema 覆盖率**：所有业务表必须有 `valid_at`、`recorded_at`、`source_id` 与 `is_current` 字段。使用 Schema 元数据查询检查。
5.  **冲突率**：多来源合并时实体冲突数除以总实体数。通过 `conflict_resolution` 表统计。
6.  **数据新鲜度**：物化视图与事件日志的最后同步时间差。目标小于 1 秒。

## 失败模式

1.  **标识冲突**：两个来源声称拥有同一实体。诊断证据：唯一索引冲突或 `source_id` 不同但业务键相同。恢复：引入冲突记录，等待人工或策略裁决。
2.  **迁移脚本失败**：校验和不匹配或 SQL 语法错误。诊断证据：迁移表记录状态为 `failed`。恢复：回退到上一个版本，修复脚本后重放。
3.  **时间顺序倒置**：`recorded_at` 早于 `valid_at` 过多。诊断证据：时间差监控告警。恢复：标记为可疑来源，触发重新导入。
4.  **物化视图滞后**：查询返回旧版本。诊断证据：视图表最大 `recorded_at` 落后于事件日志。恢复：重建视图或修复事件消费者。
5.  **来源不可追溯**：`source_id` 在 `sources` 表中不存在。诊断证据：外键约束触发。恢复：拒绝写入或补充来源记录。
6.  **索引膨胀**：频繁更新导致索引页碎片化。诊断证据：`PRAGMA freelist_count` 持续升高。恢复：执行 `REINDEX` 或 `VACUUM`。

## 问答测试样例

1.  **正向**：本地导入的 Markdown 文件被修改后，如何确保旧版本仍可查询？答：通过事件日志追加 `update` 事件，并将旧版本 `is_current` 置为 false。
2.  **正向**：`valid_at` 与 `recorded_at` 的区别是什么？答：`valid_at` 是业务事件实际发生时间，`recorded_at` 是本地库写入时间。
3.  **边界**：同一文件在断网时多次编辑，同步后会产生冲突吗？答：如果来源相同且实体 ID 一致，不会产生标识冲突，但会生成多条版本记录。
4.  **边界**：SQLite 严格模式关闭时写入非法枚举值，系统如何保证一致性？答：无法保证，应用层校验是最后防线，修复后需重新校验。
5.  **无证据拒答**：为什么不用自增主键？回答需基于实体稳定性需求，不能回答“因为更好”。
6.  **无证据拒答**：物化视图的刷新频率取决于什么？回答需引用事件日志与调度策略，而非泛泛回答“实时”。
7.  **正向**：迁移脚本失败后能否部分回退？答：可以，只要回退 SQL 与正向 SQL 成对记录。
8.  **边界**：当 `sources` 表记录缺失时，为何直接拒绝写入？答：来源不可追溯会破坏审计与回滚能力。

## 维护、版本、来源与相邻主题关系

Schema 版本由迁移脚本编号控制，编号顺序单调递增且不可回退。迁移脚本存放于代码仓库的 `migrations/` 目录，与发布版本号解耦，但发布说明需列出包含的迁移编号。来源信息不仅记录导入文件，也记录派生计算，例如向量化结果应指向原始文档来源。与相邻主题的关系：本主题依赖数据类型设计与编码约定；向上支撑同步策略与冲突解决；向下依赖 SQLite 文件存储与备份机制。与全文检索的边界是：Schema 存储原始事实，倒排索引属于派生视图，不可作为唯一数据源。

## 结论

事实：SQLite 支持严格模式、外键约束与事务；UUIDv7 在本地场景中具有可排序与去中心化的优势；事件日志追加模式天然保留历史。

推论：将事件日志作为单一写入源，物化视图作为查询面，是长期演进最稳定的架构；代理键加来源记录可在多来源合并中降低冲突风险。

未知：在特定读写比例下，窄表与宽表的实际性能拐点；大型 `jsonb` 列在本地 Electron 应用中的内存与序列化开销上限；多来源并发写入时最优冲突裁决策略。这些需通过项目基准测试验证。
