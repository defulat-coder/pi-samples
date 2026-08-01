---
type: concept
title: 分页与排序：实现视角
description: 用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。稳定地返回大列表，避免 offset 抖动和重复数据
resource: .pi/knowledge/library/sqlite-data/pagination-implementation.md
tags: [Pi, Agent, Kimi, 知识库, sqlite-data, pagination, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: sqlite-data
topic: pagination
variant: implementation
---

# SQLite 本地大数据集分页与排序：基于键集分页的稳定返回实现

## 摘要与问题边界

当本地 SQLite 文件作为 Web 应用或桌面客户端的数据层时，列表接口常常需要处理万级到百万级记录。传统 `OFFSET`/`LIMIT` 方案在并发写入或排序键重复时会出现两类典型问题：一是同一行在不同页之间重复出现，二是 `OFFSET` 值在翻页期间因前置记录插入或删除而发生抖动，导致客户端看到跳跃或遗漏。本方案面向 TypeScript 实现者，要求在编码前先定义输入契约、输出契约、错误形态、生命周期边界和验证步骤，确保本地文件系统中的分页结果稳定、可验证、可恢复。

## 核心概念与数据模型

1. 逻辑记录：表中的每一行必须携带一个稳定的唯一标识 `pk`， preferably `INTEGER PRIMARY KEY`，它既作为行地址锚点，也作为排序并列时的决胜键。

2. 排序向量：分页依赖一个有序元组 `(s_1, s_2, …, s_n, pk)`，其中 `s_i` 是业务排序键，`pk` 永远置于末尾以消除并列。缺少 `pk` 时，重复排序值会造成记录不可见。

3. 页游标：一个自包含、版本化的不透明字符串，编码当前页最后一条记录的 `(s_1, …, s_n, pk)` 值以及读取方向。客户端不应解析其内部结构。

4. 稳定排序断言：在同一数据库连接或只读事务内，使用 `ORDER BY s_1, pk LIMIT ?` 加键集条件 `WHERE (s_1, pk) > (?, ?)` 时，返回集的顺序和存在性与 `OFFSET` 无关。

5. 本地事务边界：SQLite 在 WAL 模式下允许读取者获得打开事务时的快照，写操作不会阻塞读事务。分页读取应使用 `BEGIN DEFERRED` 或 `BEGIN IMMEDIATE` 只读事务，避免读到不一致的中间状态。

6. 游标编解码器：游标必须经过序列化、签名和 Base64 编码；解码时校验版本号、签名和字段类型，防止客户端篡改或跨版本误用。

## 设计决策与取舍

### 1. 键集分页替代 Offset 分页

`OFFSET` 在语义上是“跳过前 N 行”，每当排序键之前插入新行，后续页的相对位置就会漂移。键集分页把锚点固定在真实数据值上，翻页时不受前面记录增减影响。代价是无法直接跳转到任意页码，只能顺序翻页；如果业务必须支持页码跳转，需要单独维护索引视图或接受偏移抖动。

### 2. 排序键必须唯一化

即使业务排序键在概念上唯一，也应把 `pk` 加入排序向量，作为不可变的决胜键。这一改动不影响业务展示顺序，却能消除 `ORDER BY` 中并列行导致的记录丢失。索引设计应覆盖 `(s_1, …, s_n, pk)`，使 SQLite 可以使用覆盖索引扫描避免回表。

### 3. 游标采用客户端不透明 Token

把游标设计成opaque token，可以隐藏数据库内部键值，也便于未来更换排序策略或加密游标内容。副作用是调试困难，因此服务端日志中应记录解码后的游标摘要，而不是原始 token。

### 4. WAL 模式与只读快照

启用 WAL 后，长时间运行的读取事务不会阻塞写入，也不会被写入阻塞。对于本地文件系统上的单写多读场景，这是稳定分页的前提。如果禁用 WAL，则写操作会短暂持有数据库级锁，读取可能被延迟，但不会因为并发写入看到抖动。

### 5. 最大页大小与内存预算

本地进程虽然有直接访问优势，但无限制地返回大页会一次性占用大量内存。应在 API 层和查询层同时限制 `limit ≤ MAX_PAGE_SIZE`（例如 1000），并在游标中记录客户端请求的原始 limit，避免客户端通过修改 token 扩大页大小。

## 可执行的实施流程

1. 在 schema 中为每张需要分页的表声明稳定的唯一标识 `pk` 和业务排序键 `s`，并创建复合索引 `CREATE INDEX idx_list ON table(s, pk)`。

2. 定义游标结构 `Cursor = { v: number, cols: Array<unknown>, pk: unknown, dir: 'next' | 'prev' }`，并约定版本号与字段类型映射。

3. 实现编码器：将游标序列化为 JSON，使用 HMAC-SHA256 生成签名，再把 `签名 + '.' + Base64(JSON)` 输出给客户端。

4. 实现解码器：拆分 token，校验签名，校验版本号 `v`，校验字段数量与类型与当前 schema 一致；任一失败即返回 `INVALID_CURSOR` 错误。

5. 构造查询语句：使用参数化查询，WHERE 子句写成 `(s, pk) > (?, ?)` 或 `(s, pk) < (?, ?)`，并附加 `ORDER BY s, pk LIMIT ?`。

6. 在只读事务中执行查询，取回 `limit + 1` 条记录；若结果数超过 limit，则丢弃最后一条并设置 `has_next = true`。

7. 将返回的最后一行编码为新游标，连同 `has_next`、`page_size`、`total`（可选）一并返回客户端。

8. 在 API 边界记录日志：解码耗时、查询计划、返回行数、游标版本，用于后续可观测性分析。

## 示例：TypeScript 查询构造与游标解码

以下片段展示了输入游标如何被转换为 SQLite 参数与输出。

    function buildPageQuery(table: string, cursor: string | null, limit: number) {
      const decoded = cursor ? decodeCursor(cursor) : null;
      const params: unknown[] = [];
      let where = '';
      if (decoded) {
        where = `WHERE (sort_key, pk) > (?, ?)`;
        params.push(decoded.sortKey, decoded.pk);
      }
      const sql = `
        SELECT pk, sort_key, payload
        FROM ${escapeIdentifier(table)}
        ${where}
        ORDER BY sort_key, pk
        LIMIT ?
      `;
      params.push(limit + 1);
      return { sql, params, decoded };
    }

输入：客户端传入 `cursor`（可能为 null，表示首页）和 `limit`（受 `MAX_PAGE_SIZE` 限制）。处理：解码器验证签名与版本后，生成参数化 SQL；数据库通过复合索引定位下一页。输出：最多返回 `limit` 条记录，若存在下一条则生成新游标；否则 `has_next` 为 false。

## 性能、质量、可观测性指标

1. 首字节延迟：测量从收到请求到返回首条记录的耗时，p50 目标低于 20 毫秒，p99 低于 100 毫秒；使用 `EXPLAIN QUERY PLAN` 确认未退化为全表扫描。

2. 游标命中率：统计解码成功且命中有序记录的比率；低于 95% 说明排序键频繁更新或游标过期策略需要调整。

3. 索引覆盖比例：通过 `EXPLAIN QUERY PLAN` 检查 `USING INDEX` 与 `USING COVERING INDEX` 的比例，目标覆盖索引比例高于 90%。

4. 重复记录事件数：在返回数据前对 `pk` 做去重校验，记录同一 `pk` 出现在相邻两页的次数；异常值触发告警。

5. 内存峰值：对 `limit + 1` 的临时结果集采样 RSS，确保单页内存占用不超过预设阈值，例如 16 MiB。

## 失败模式、诊断证据与恢复动作

1. 游标指向已删除记录。证据：查询返回非空但条数少于 limit，且 `has_next` 为 true。恢复：正常返回当前结果，客户端使用返回的新游标继续；若结果为空，可降级为重新从首页获取或提示用户刷新。

2. 排序键重复导致行丢失。证据：连续两页之间出现 `pk` 断层，或总行数统计与分页累加不一致。恢复：在排序向量末尾追加 `pk` 作为决胜键，并重建复合索引。

3. 同一行出现在两页。证据：相邻页出现相同 `pk`。恢复：确保读取事务在 WAL 模式下获得快照；若无法使用事务快照，则接受最终一致性并在 API 中声明。

4. 客户端传递篡改游标。证据：签名校验失败或版本号不匹配。恢复：直接返回 400 错误，不尝试容错解码，避免信息泄露。

5. 页大小超限耗尽内存。证据：进程 RSS 突增或查询执行时间随 limit 线性爆炸。恢复：在 API 层和游标解码层双重校验 `limit`，超过 `MAX_PAGE_SIZE` 时强制截断并记录审计日志。

## 问答测试样例

1. 正向：如何在第二页继续查询？答：取第一页最后一条记录的游标 token，作为下一请求的 `cursor` 参数，服务端按 `(sort_key, pk) > (last_sort_key, last_pk)` 定位。

2. 正向：排序键是否需要唯一？答：业务排序键不一定唯一，但排序向量必须唯一，因此必须将 `pk` 作为最终决胜键。

3. 边界：最后一页不足 limit 时怎么办？答：返回实际行数，设置 `has_next = false`，不生成新游标或生成空游标。

4. 边界：删除第一页最后一条记录后继续翻页会怎样？答：由于游标锚定的是具体键值，该记录已不存在，下一页从其后继开始返回，不会回退也不会丢失。

5. 无证据拒答：能否证明键集分页在所有数据库上的性能都优于 offset 分页？答：不能，本方案仅在 SQLite WAL 模式、覆盖索引、顺序翻页场景下得出优势结论，未覆盖所有数据库和负载。

6. 无证据拒答：better-sqlite3 是否默认启用 WAL？答：本方案不能断言默认行为，应查阅当前安装的 better-sqlite3 版本文档或在连接后用 `PRAGMA journal_mode` 验证。

## 维护、版本、来源与相邻主题

本方案随 schema 变化而版本化游标结构；当排序键类型、顺序或 `pk` 类型变更时，必须提升游标版本号，否则旧游标会被解码器拒绝。代码层面建议将游标编解码器与查询构造器放在同一模块，避免多处重复拼接 SQL。相邻主题包括本地 SQLite 并发控制、WAL 检查点策略、schema 迁移、全文检索分页以及离线同步冲突解决。本实现视角不替代这些主题，但要求分页模块在事务和索引设计上与它们保持一致。

## 结论

事实：在 SQLite WAL 模式下，只读事务可以获取稳定快照；复合索引 `(sort_key, pk)` 能让键集分页避免全表扫描；`OFFSET` 会在并发写入时产生位置漂移。推论：键集分页比 `OFFSET` 分页更适合本地大数据集稳定返回，但前提是排序向量唯一且游标经过版本化和签名校验。未知：具体项目的最大可接受页大小、客户端是否支持只有顺序翻页、以及目标表中排序键的更新频率，需要在真实数据上通过性能测试和可观测性指标进一步确定。
