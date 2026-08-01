---
type: concept
title: 新鲜度：实现视角
description: 从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。用更新时间、过期时间和发布状态避免旧资料覆盖新事实
resource: .pi/knowledge/library/rag-retrieval/freshness-implementation.md
tags: [Pi, Agent, Kimi, 知识库, rag-retrieval, freshness, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: rag-retrieval
topic: freshness
variant: implementation
---

# RAG 检索中的新鲜度控制：用更新时间、过期时间与发布状态防止旧事实覆盖新事实

## 摘要与问题边界

在 RAG 流水线中，检索器按语义相似度召回 chunks 时，一份措辞保守的旧文档往往比最新文档更贴近 query，从而把过时事实塞进生成上下文。本文按 OKF 概念条目格式编写，只处理“时间维度正确性”，用 `updated_at`、`valid_until` 和 `publish_status` 三个字段决定哪些资料可进入答案，并把它们纳入过滤与重排。范围限定在本地文件或 Web 同步型知识库的单租户构建流程，便于检索器按标题、标签与正文召回，也便于 Agent 在引用时直接定位判断依据。不涉及实时增量索引、并发写入控制或用户权限。

## 核心概念与数据模型

一条可被检索的知识条目至少包含以下字段与规则：

1. `updated_at`：UTC 时间戳，表示“本条内容所描述事实的最后变更时刻”，由构建器根据元数据或手动变更记录写入，不能直接使用文件系统 `mtime`。
2. `valid_until`：可选过期时间，未声明表示持续有效；一旦声明且当前时间超过它，条目默认被排除，仅在 `include_history` 模式下可见。
3. `publish_status`：枚举值为 `published`、`draft`、`archived`、`superseded`，默认只让 `published` 进入生成上下文；`superseded` 必须附带 `superseded_by` 指向替代版本。
4. `effective_at`：用于描述未来生效的规则，缺省等于 `updated_at`；检索时只保留 `effective_at <= now` 的条目。
5. `freshness_score`：归一化分数，例如 `max(0, 1 - (now - updated_at) / recency_window)`，与语义分数加权后决定最终顺序。
6. `canonical_source`：包含文件路径、版本号与构建批次，用于答案引用和去重，防止同一内容的不同副本被当作多个独立来源。

## 设计决策与取舍

1. 时间来源由构建器决定，而不是文件系统
   文件系统 `mtime` 会在 git pull、容器重建或复制时改变，因此 `updated_at` 必须来自内容 YAML 头或构建器配置。代价是：作者忘记更新时，系统会持续信任旧时间戳。

2. `valid_until` 是硬过滤，不是软折扣
   过期条目直接排除，防止模型把它当作“也许可用”的上下文。例外：用户明确要求“列出已废弃的 API”时，绕过过滤并附加 `expired=true` 标记。

3. `publish_status` 与 `valid_until` 并行生效
   一篇 `draft` 即使 `updated_at` 最新也不会进入检索；`published` 但已过期的条目同样被排除。两者交集才是真正的可用集合。

4. 新鲜度分数仅用于重排，不用于召回
   先用向量或关键词召回候选，再用新鲜度分数重排。这样语义不会完全让位给时间，但新资料会获得更高优先级。

5. 缺失时间字段时的降级策略
   若 `updated_at` 缺失，设置为默认最小时间戳并标记 `freshness_unknown`，使其排在有明确时间的文档之后，而不是当作当前时间。

## 可执行的实施流程

1. 接收 query 与请求上下文，校验 `knowledge_base` 名称和版本号。
2. 从索引读取候选 chunks，提取 `updated_at`、`valid_until`、`publish_status`、`effective_at`、`canonical_source`。
3. 校验时间戳格式为 ISO 8601 UTC；无法解析的条目进入 `invalid_time` 队列并上报。
4. 使用服务器当前 UTC 时间 `now`，过滤掉 `publish_status` 非 `published` 的条目，除非请求开启 `include_history`。
5. 过滤掉 `valid_until < now` 和 `effective_at > now` 的条目。
6. 对剩余条目计算 `freshness_score`：`max(0, 1 - (now - updated_at) / config.recency_window_ms)`。
7. 将语义分数与 `freshness_score` 按配置权重合并，得到 `final_score`，降序截断至 `top_k`。
8. 在返回上下文中为每个 chunk 附加 `citation`，包含 `canonical_source`、`updated_at`、`publish_status` 和 `freshness_score`。

## 本地文件知识库示例

以下 YAML 片段描述同一 API 的两个版本，旧版本被显式取代：

    - canonical_source: docs/api/v2/payment.md
      chunk_id: payment-001
      updated_at: "2024-06-10T08:00:00Z"
      valid_until: "2024-12-31T23:59:59Z"
      publish_status: superseded
      superseded_by: docs/api/v3/payment.md
      content: POST /v2/payment 使用旧签名算法。
    - canonical_source: docs/api/v3/payment.md
      chunk_id: payment-002
      updated_at: "2024-09-20T10:00:00Z"
      valid_until: null
      publish_status: published
      effective_at: "2024-09-20T10:00:00Z"
      content: POST /v3/payment 使用 HMAC-SHA256 签名。

输入为用户 query“现在创建支付请求应该用什么签名算法”。处理时系统过滤掉 `superseded` 的 v2，保留 v3 并计算其 `freshness_score` 接近 1.0。输出为生成器仅基于 v3 内容回答，并在引用中给出 `docs/api/v3/payment.md` 与 `updated_at: 2024-09-20T10:00:00Z`。

## 性能、质量与可观测性指标

1. 时间过滤命中率：被 `valid_until` 或 `effective_at` 过滤的候选比例，通过检索日志中的 `filtered_by_time` 计数器测量。
2. top-5 时间正确率：前 5 结果中 `updated_at` 最大的条目是否排名第一，用 100 条“最新版本”类 query 人工标注评估。
3. 平均新鲜度延迟：返回结果中 `now - updated_at` 的中位数，目标小于 30 天。
4. 未知时间字段比例：候选中 `updated_at` 缺失的百分比，应低于 1%。
5. 过期召回率：针对已过期但仍被错误召回的 query 集合，计算漏召回比例。

## 失败模式、诊断证据与恢复动作

1. 旧版本因相似度高而排在前面
   证据：top-1 的 `updated_at` 小于 top-3 的 `updated_at`，且语义分高于新鲜度加权后的阈值。恢复：提高 `freshness_score` 权重，或对同一 `canonical_source` 只取最新版本。

2. 过期文档未被过滤
   证据：返回结果中出现 `valid_until < now`。恢复：检查时区统一，确保过滤前 `valid_until` 已被正确解析。

3. `draft` 内容泄露到生产答案
   证据：引用中 `publish_status` 为 `draft`。恢复：在召回阶段增加 `status_filter` 中间件，而非仅前端隐藏。

4. 时钟 skew 导致 `updated_at` 是未来时间
   证据：日志中出现 `updated_at > now` 的条目。恢复：构建器拒绝未来时间戳，检索时把未来时间条目视为异常并降级。

5. 缺失 `updated_at` 的条目被当作最新
   证据：`freshness_unknown` 标记的条目出现在 top-k。恢复：统一为缺失字段设置默认最小时间戳，并持续告警直到补齐。

## 问答测试样例

1. 正向：query “当前支付 API 的签名算法” → 应返回 v3 条目，拒绝 v2。
2. 正向：query “2024 年 6 月的 API 文档” → 在 `include_history=true` 时应返回 v2，并标明已过期。
3. 边界：同一 `canonical_source` 在一天内更新两次 → 只返回 `updated_at` 最大的那一条，另一条标记为 `superseded`。
4. 边界：query 命中一篇文章，但 `effective_at` 是未来 → 返回“该规则尚未生效，无可用证据”。
5. 无证据拒答：query 关于已删除且未留存的文档 → 返回“未找到已发布且未过期的资料”，不臆测。
6. 无证据拒答：query 时间窗口内只有 `draft` 条目 → 返回“当前没有已发布版本，无法回答”。

## 维护、版本、来源与相邻主题关系

维护：每次构建索引时，构建器读取 `.pi/knowledge/*.md` 的 YAML 头，并把上述字段写入索引 payload。CI 中增加 `time_fields_present` 校验。版本：索引批次号跟随 `pnpm build` 的 git commit hash，回滚时同时回滚索引，避免新索引与旧代码混用。来源：答案末尾输出 `canonical_source` 列表，而不是模糊的“根据知识库”。相邻主题：与“分块策略”相关，过小的 chunk 可能丢失时间字段上下文；与“引用溯源”相关，citation 需与时间字段一起返回；与权限控制无关，本文不讨论。

## 结论

- 事实：在 RAG 检索中，旧资料确实可能因语义相似度更高而覆盖新事实。
- 推论：把 `updated_at`、`valid_until`、`publish_status` 同时作为过滤与重排信号，可以显著降低旧事实进入生成上下文的概率。
- 未知：不同领域对“旧”的容忍度差异很大，最佳时间窗与加权系数需通过业务 query 的 A/B 测试确定，而非通用常数。
