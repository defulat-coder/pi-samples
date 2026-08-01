---
type: concept
title: 新鲜度：验证与运维视角
description: 从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。用更新时间、过期时间和发布状态避免旧资料覆盖新事实
resource: .pi/knowledge/library/rag-retrieval/freshness-operations.md
tags: [Pi, Agent, Kimi, 知识库, rag-retrieval, freshness, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: rag-retrieval
topic: freshness
variant: operations
---

# RAG 检索结果新鲜度：用时间元数据与发布状态阻止旧事实覆盖新事实

## 摘要与问题边界

在检索增强生成（RAG）系统中，知识库通常由多个批次、多个来源、多个版本的数据构成。如果检索器只按语义相似度排序，而不考虑文档的更新时间、过期时间和发布状态，旧版本的事实可能在召回阶段覆盖新事实，导致模型生成"已失效"的回答。本文从验证与运维视角出发，讨论如何在索引、排序、过滤和监控层面保证检索结果的新鲜度，重点记录成功、失败、延迟、容量和恢复证据，避免仅依赖一次成功请求就判定系统正常。

本问题边界限定在：基于本地文件或 Web 接口构建的知识库，文档以 Markdown、JSON 或 YAML 形式存储，检索器可读取结构化元数据。不考虑外部数据库自动同步、多活副本一致性协议等更底层基础设施问题。

## 核心概念与数据模型

1. **更新时间（updated_at）**：文档内容最后一次被确认发生有效修改的时间戳。有效修改指语义变化，而非单纯的文件系统 touch 或格式重排。此字段必须由内容作者或导入流程显式写入，不能依赖文件 mtime。
2. **过期时间（expires_at）**：文档被认定不再可靠的时间戳。过期文档可以保留在库中，但在检索时应被降级或排除，除非用户明确要求查询历史版本。
3. **发布状态（status）**：如 `draft`、`published`、`deprecated`、`archived`。`published` 才参与默认召回；`deprecated` 仅在用户明确询问旧版时参与；`archived` 不进入在线检索，仅用于审计。
4. **版本标识（version_id）**：与更新时间配对的唯一标识。同一主题在库中允许存在多个版本，但召回默认只返回最新已发布版本。
5. **来源指纹（source_fingerprint）**：记录文档从哪个原始文件或 API 路径导入，以及导入批次编号。用于追踪异常批次和批量回滚。
6. **生效时间窗（effective_window）**：由 `valid_from` 和 `valid_until` 构成，描述事实的时间适用范围。例如 API 行为变更文档，旧版文档在 `valid_until` 之后仍可能具有解释价值，但默认不应与新文档竞争。

## 设计决策与取舍

### 元数据由生产者写入，而非运行时推断
运行时推断文件 mtime 会引入误报：Git 克隆、CI 重打包都会改变 mtime，但内容未变。因此要求文档生产者在上传或提交时写入 `updated_at` 和 `status`。代价是增加发布流程负担，收益是避免不可解释的时间戳漂移。

### 检索器双层排序：先过滤，再重排
第一层用硬过滤（`status == published` 且 `expires_at > now`）排除过期和未发布文档；第二层用语义相似度排序。这样可以保证旧文档即使语义分更高也不会被召回。例外：当用户查询包含"旧版"或"历史版本"时，才放开 `deprecated` 文档。

### 允许同一主题多版本共存，但默认只返回最新
不强制删除旧版本，而是让检索索引包含版本信息，默认排序中把 `updated_at` 作为 tie-breaker。这样运维人员可以在不重建索引的情况下回滚到旧版本，同时在线召回仍以最新版本为准。

### 过期文档保留可读但不可召回
删除过期文档会损失审计能力；保留但可召回又会污染结果。因此选择保留原文件，但在索引阶段标记为 `expired` 并不进入默认检索结果。只有显式带 `include_expired=true` 的调试接口才返回。

### 更新时间优先于语义分
当两篇文档语义分接近（差异小于阈值，如 0.05）时，按 `updated_at` 降序选择。这能避免旧文档因措辞更匹配而胜出。代价是可能牺牲部分语义相关性，但符合"新事实优先"的业务目标。

## 可执行的实施流程

1. 定义元数据Schema：为每份文档要求 `updated_at`、`expires_at`、`status`、`version_id`、`source_fingerprint`、`valid_from`、`valid_until` 字段。
2. 在文档导入流程中强制校验：缺少 `updated_at` 或 `status` 的文档拒绝入索引；`expires_at` 早于 `updated_at` 的文档报错。
3. 构建索引时写入辅助字段：把 `status`、`updated_at`、`expires_at` 与向量一起存入索引，不要只存向量。
4. 实现默认过滤谓词：检索请求默认携带 `status == published && expires_at > now && valid_from <= now && (valid_until == null || valid_until > now)`。
5. 实现时间感知的重排函数：语义分接近时，使用 `updated_at` 降序；语义分差距大时，仍以语义分为主。
6. 部署调试查询接口：支持 `include_deprecated`、`include_expired`、`version_id`、`as_of` 参数，供运维和问题排查使用。
7. 建立导入批次监控：每批次导入后记录文档数量、最大 `updated_at`、最小 `expires_at`、状态分布和来源指纹清单。
8. 配置告警规则：当 `published` 文档中 `updated_at` 超过 30 天未更新，或 `expires_at` 在 7 天内到期的文档占比超过 10% 时触发告警。
9. 定期进行召回测试：每周运行固定 Q&A 用例，检查返回文档是否包含预期版本，记录版本命中率。
10. 制定回滚预案：若发现某批次导入导致旧事实覆盖新事实，可按 `source_fingerprint` 批量降级该批次，或把受影响 `version_id` 标记为 `deprecated`。

## 本地文件知识库示例

以下 JSON 示例描述一个 TypeScript 配置文件接口的知识库片段。

```json
{
  "documents": [
    {
      "id": "tsconfig-strict-2024",
      "title": "TypeScript strict 配置行为",
      "updated_at": "2024-12-10T00:00:00Z",
      "expires_at": "2025-12-10T00:00:00Z",
      "status": "published",
      "version_id": "tsconfig-strict-2024.v2",
      "source_fingerprint": "repo/docs/tsconfig-strict.md:batch-20241210",
      "valid_from": "2024-12-10T00:00:00Z",
      "valid_until": null,
      "content": "从 TypeScript 5.7 起，strict 模式默认启用 noUncheckedIndexedAccess。"
    },
    {
      "id": "tsconfig-strict-2023",
      "title": "TypeScript strict 配置行为（旧版）",
      "updated_at": "2023-11-01T00:00:00Z",
      "expires_at": "2024-12-09T23:59:59Z",
      "status": "deprecated",
      "version_id": "tsconfig-strict-2023.v1",
      "source_fingerprint": "repo/docs/tsconfig-strict.md:batch-20231101",
      "valid_from": "2023-11-01T00:00:00Z",
      "valid_until": "2024-12-09T23:59:59Z",
      "content": "strict 模式包含 alwaysStrict、strictNullChecks 等选项。"
    }
  ]
}
```

输入：运维人员通过 Web 上传或 CI 任务提交新的 Markdown 文档。导入流程解析 frontmatter 中的 `updated_at` 和 `status`，生成 `version_id` 和 `source_fingerprint`。

处理：索引系统把 `tsconfig-strict-2024` 标记为 `published`，把 `tsconfig-strict-2023` 标记为 `deprecated`。默认检索时，过滤谓词排除 `deprecated`，即使旧版文档对"strict 模式包含哪些选项"这个问题的语义分更高，也不会被召回。

输出：用户询问"TypeScript strict 模式现在默认包含什么"时，返回 `tsconfig-strict-2024` 的内容；用户询问"2023 年的 strict 配置说明"时，通过调试接口或显式 `include_deprecated=true` 返回旧版。

## 性能、质量与可观测性指标

1. **默认召回版本命中率**：在固定测试集中，返回结果中最高位文档为最新 `published` 版本的比例。每周运行，目标值大于 95%。
2. **过期文档渗透率**：生产流量中，返回结果里包含 `expires_at` 已到期或 `status` 非 `published` 文档的请求占比。通过检索日志抽样统计，目标值 0%。
3. **检索延迟 P99**：带新鲜度过滤的检索请求延迟。测量方式：在检索服务入口记录耗时，要求 P99 低于 500 毫秒。
4. **索引批次导入时间**：从文件提交到文档可检索的时间差。通过批次日志记录，目标值低于 5 分钟。
5. **元数据缺失率**：导入批次中缺少 `updated_at` 或 `status` 的文档比例。CI 阶段统计，目标值 0%，超过 1% 则阻断发布。
6. **恢复操作成功率**：按 `source_fingerprint` 或 `version_id` 执行降级或撤回后，受影响查询在 10 分钟内恢复正确版本的比例。目标值 100%。

## 失败模式、诊断证据与恢复动作

### 模式一：旧文档因语义分高覆盖新文档
诊断证据：固定测试用例返回的 `version_id` 不是最新；`updated_at` 显示为旧批次；语义分高于新版本。
恢复动作：检查重排函数是否启用了时间 tie-breaker；若未启用，临时把旧 `version_id` 标记为 `deprecated`，然后修复排序逻辑。

### 模式二：过期文档未被过滤
诊断证据：返回文档的 `expires_at` 早于当前时间；过滤谓词未包含 `expires_at` 条件。
恢复动作：立即修复过滤谓词，重新发布索引；同时检查索引字段映射，确认 `expires_at` 被正确存储。

### 模式三：未发布草稿被召回
诊断证据：返回文档的 `status` 为 `draft`。
恢复动作：在默认查询中强制添加 `status == published`；对历史未发布文档进行批量状态修正。

### 模式四：批次导入时间戳全部错误
诊断证据：同一 `source_fingerprint` 下所有文档 `updated_at` 相同，但内容明显属于不同版本；或 `updated_at` 晚于 `expires_at`。
恢复动作：暂停该导入流水线，回滚该批次；修正导入脚本中时间戳解析逻辑；重新导入。

### 模式五：恢复接口未生效导致旧事实持续在线
诊断证据：把文档标记为 `deprecated` 后，默认查询仍返回该文档；缓存未刷新。
恢复动作：检查索引更新链路是否同步；确认检索服务缓存 TTL 是否过长；必要时手动触发缓存失效。

## 问答测试样例

1. **正向问题**：TypeScript strict 模式现在默认包含哪些检查？
   预期：返回 `tsconfig-strict-2024`，内容包含 `noUncheckedIndexedAccess`。

2. **正向问题**：2023 年的 strict 配置文档在哪里？
   预期：通过 `include_deprecated=true` 返回 `tsconfig-strict-2023`，默认查询不返回。

3. **边界问题**：strict 模式的文档有效期到什么时候？
   预期：返回 `tsconfig-strict-2024` 的 `expires_at` 为 `2025-12-10T00:00:00Z`，并说明有效期结束后应重新确认。

4. **边界问题**：如果新旧两个版本语义分相同，系统会返回哪个？
   预期：返回 `updated_at` 更新的版本，即 `tsconfig-strict-2024`，并说明时间 tie-breaker 规则。

5. **无证据拒答**：2026 年的 strict 配置有什么变化？
   预期：知识库中没有 2026 年文档，系统应拒绝回答，提示用户当前最新版本为 2024 年版，无法确认 2026 年的变更。

6. **无证据拒答**：strict 模式是否包含 `noImplicitReturns`？
   预期：如果当前文档未明确提及该选项，系统不应凭旧记忆或外部推断回答，应说明现有文档中未找到直接证据。

## 维护、版本、来源与相邻主题关系

维护工作包括：每月审计 `published` 文档的 `expires_at`，对即将过期文档发起更新；每季度清理 `archived` 文档的离线存储；每次导入后保存批次日志至少 180 天。

版本管理采用不可变版本 ID：文档内容修改必须产生新的 `version_id`，旧版本不删除。这依赖"发布时间窗"与"过期时间"的区分：时间窗描述事实适用范围，过期时间描述文档可信度。

来源追踪通过 `source_fingerprint` 实现，包含文件路径和批次编号。它使运维人员能在发生批次级错误时快速定位并回滚，而不是逐篇修改。

与相邻主题的关系：新鲜度与"相关性"共同决定召回顺序；与"一致性"相邻，但本文不解决分布式副本一致性问题；与"访问控制"相邻，因为 `status` 字段也可用于控制不同角色可见的文档范围。

## 结论

事实是：更新时间、过期时间和发布状态是阻止旧文档覆盖新事实的最小元数据集合；默认过滤必须排除 `draft` 和 `deprecated` 文档；语义分接近时应以 `updated_at` 作为 tie-breaker。

推论是：只要元数据完整、索引字段正确、过滤谓词生效，且运维流程持续验证，RAG 系统就能把旧事实覆盖新事实的风险控制在可观测、可回滚的范围内。

未知是：不同业务对"新事实"的定义存在差异，例如法律条文、医学指南、软件 API 的"新鲜"标准不同；本设计未给出统一的过期时间推荐值，需要各项目根据领域节奏自行标定。
