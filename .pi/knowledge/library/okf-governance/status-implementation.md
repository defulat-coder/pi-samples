---
type: concept
title: 生命周期状态：实现视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。区分 active、draft、deprecated 和过期内容的消费策略
resource: .pi/knowledge/library/okf-governance/status-implementation.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, status, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: status
variant: implementation
---

# OKF 知识治理中概念生命周期状态的实现与消费策略

## 摘要与问题边界

在 OKF-compatible 知识库中，每个概念（concept）不是静态文档，而是带有治理意图的实体。生命周期状态字段决定检索器、Web 界面和 Agent 是否应当消费、提示或拒绝该内容。本文只讨论读取侧的消费策略，不涉及写入授权、并发编辑或内容质量评分。边界内的四个状态为：active、draft、deprecated、expired。实现目标是让 TypeScript 代码在加载、查询、返回三个阶段都能给出确定、可验证的决策，而不是在业务层到处写 if-else。

核心输入包括：概念文件本身、状态字段、版本与时间戳、请求上下文（环境、角色、搜索模式、是否审计）。输出是统一的消费决策：include、include-with-warning、exclude、redirect-to-replacement。错误处理比成功路径更重要，因为错误的状态会导致知识污染或合规风险。

## 核心概念或数据模型

1. 概念记录（ConceptRecord）必须包含以下字段：id、slug、title、status、contentHash、sourceUri、version、statusAt、expiresAt、replacedBy、deprecationReason、tags、provenance。缺少其中任意一个字段，加载器应拒绝，而不是用默认值填充。

2. 生命周期枚举 LifecycleStatus 只能是四个字符串之一：active、draft、deprecated、expired。不允许扩展为 "archived" 或 "hidden" 之类的别名，避免策略漂移。

3. 消费策略函数 consume(status, context, record) 返回一个决策对象 {action, reason, replacement, warningLevel}。该函数必须是纯函数，不访问数据库，只读取已解析的记录。

4. active 表示已通过审查、具有稳定 URI、可以被公开检索和 Agent 引用。draft 表示未审查，只能被预览；它不能出现在公开搜索，也不能被 Agent 作为事实引用。

5. deprecated 表示内容仍然有效，但已提供更好的替代内容。消费策略必须同时返回原内容和 replacedBy 链接，并附带 warning。如果缺少 replacedBy 或 sunsetDate，应视为数据错误，强制降级为 expired 或拒绝加载。

6. expired 表示内容在 expiresAt 之后不再被消费。默认查询必须 exclude；只有在审计上下文（audit=true）下才允许返回 archiveUri，且不能作为当前知识使用。

7. 状态转换日志（TransitionLog）是 append-only 的数组，每项包含 from、to、actor、timestamp、reason。加载器需要验证日志顺序：timestamp 必须单调递增，且最终状态与 status 字段一致。

8. 请求上下文（QueryContext）至少包含：environment（production、preview、audit）、role（reader、editor、agent）、searchMode（default、strict、includeDrafts）、requestedVersion、clientTimestamp。消费策略必须依赖这些字段，而不是依赖全局环境变量。

## 设计决策与取舍

### 显式枚举优于布尔标志

用 status 字段比用 isPublic、isDraft、isDeprecated 三个布尔标志更严格。优点是所有分支都在一个枚举上完成；缺点是新增状态需要修改所有 switch 语句和 schema。取舍结果是：在 OKF 范围内只保留四个状态，冻结扩展。

### 过期时间使用硬截止日期

expiresAt 和 sunsetDate 使用 ISO 8601 UTC 时间戳，而不是相对时间（如 "90 天后"）。这样同一请求在不同时间重放会得到相同结果，便于测试和缓存。代价是每次发布都需要重新计算时间戳。

### 草稿默认不可见

默认查询策略 exclude draft；只有在 preview 或 includeDrafts 上下文下才允许 include。这比"默认可见但打标"更安全，因为草稿通常包含未验证信息。例外是内部编辑器查看自己的草稿，此时通过 role 字段放开。

### 弃用内容软重定向

deprecated 不被 exclude，而是 include-with-warning 并附带 replacedBy。这样旧链接不会突然失效，但消费方会收到升级提示。如果 replacedBy 不存在，则不允许软重定向，直接 exclude 或返回错误，防止悬空的弃用链。

### 验证在加载时完成，查询时不做宽松处理

加载器在读取文件后立即执行 schema 和状态校验，任何非法记录直接拒绝入库。查询阶段只读取已规范化的状态，不再重复做复杂的校验。取舍是：入库严格，但运行时更快更确定。如果入库失败，需要人工修复文件，而不是让代码自动修正。

### 状态与内容版本分离

contentVersion 只描述内容变化；schemaVersion 描述治理规则。二者分开，允许旧内容按新规则迁移，而不需要重新撰写内容。

## 可执行的实施流程

1. 定义 JSON Schema 或 Zod 类型，描述 ConceptRecord、LifecycleStatus、QueryContext、ConsumeDecision 和 TransitionLog。

2. 实现文件加载器，递归读取本地知识库目录，把 YAML 或 JSON 文件解析为原始对象，并记录 sourcePath。

3. 实现验证器：枚举校验、必填字段校验、时间戳格式校验、TransitionLog 顺序校验、status 与 expiresAt 一致性校验。

4. 实现状态转换器：给定旧记录和新记录，生成 TransitionLog 条目，并拒绝非法转换（如 expired 不能直接回到 active，除非通过 draft 或人工重置）。

5. 实现消费策略函数 consume()，覆盖所有状态与上下文组合，每个分支返回明确的决策和原因。

6. 实现搜索索引构建器：默认只索引 active 和 deprecated；draft 仅在 includeDrafts 模式下进入索引；expired 永远不进入默认索引。

7. 暴露 API 或模块入口：search(query, context)、getBySlug(slug, context)、auditLookup(slug, context)。每个接口必须返回决策原因字段，方便客户端展示。

8. 在 Web 层用 consume() 的结果决定是否渲染、是否折叠、是否显示警告条。Web 不直接读取状态字段，只读取决策对象。

9. 编写边界测试：覆盖草稿泄露、过期返回、缺 replacedBy、缺版本、状态日志冲突等场景。

10. 部署监控：记录每次查询的决策、状态和原因，并设置告警规则。

## 输入、处理与输出示例

下面是一个本地文件知识库的 JSON 片段，演示一个 deprecated 概念的记录：

    {
      "id": "concept-042",
      "slug": "async-pipeline",
      "title": "异步流水线",
      "status": "deprecated",
      "version": "2.1.0",
      "schemaVersion": "1.0.0",
      "statusAt": "2025-06-01T00:00:00Z",
      "sunsetDate": "2025-12-01T00:00:00Z",
      "expiresAt": "2025-12-01T00:00:00Z",
      "replacedBy": "concept-117",
      "deprecationReason": "已被事件驱动架构取代",
      "sourceUri": "docs/async-pipeline.md",
      "archiveUri": "archive/async-pipeline/v2.1.0.md",
      "tags": ["architecture", "async"]
    }

输入：加载器读取该文件和对应的 TransitionLog，确认最终状态是 deprecated。查询上下文为 production、searchMode=default、role=reader。

处理：验证器检查 schemaVersion 兼容、replacedBy 存在且指向 active 记录、sunsetDate 未过期。consume() 判断：status 为 deprecated，环境 production，因此 action 为 include-with-warning，replacement 为 concept-117，warningLevel 为 deprecated。

输出：API 返回概念内容、警告条、替换链接；索引中保留该 slug，但搜索结果中标记为"已弃用"。

## 性能、质量和可观测性指标

1. 加载验证延迟：统计每个文件从读取到通过验证的时间，p99 应低于 5 毫秒。测量方式：在加载器内记录 startTime 与 endTime，写入 metrics。

2. 查询决策延迟：consume() 单次调用 p99 应低于 1 毫秒。测量方式：在 API 入口计时，只统计决策阶段。

3. 弃用/过期内容误返回率：每小时统计返回结果中 status 为 expired 或缺 replacedBy 的 deprecated 数量，目标为零。测量方式：在响应日志中记录 actualStatus，并比对决策原因。

4. 草稿泄露率：在默认搜索模式下返回 draft 的记录数。目标为零。测量方式：对所有 search 日志按 searchMode 分组，过滤出 status=draft 且 searchMode=default 的条目。

5. 状态转换错误率：加载时发现 TransitionLog 冲突、status 与日志不一致或非法转换的文件比例。目标低于 0.1%。测量方式：验证错误按类型计数。

6. 缓存命中率：对于状态稳定的 active 记录，查询缓存命中率应高于 90%。测量方式：在 search 结果缓存层记录 hit/miss。

## 失败模式、诊断证据与恢复动作

1. 草稿泄露到公开搜索。诊断证据：日志中出现 searchMode=default、status=draft、action=include。恢复动作：在索引构建器强制排除 draft；在 API 层增加二次校验；审计所有历史搜索响应。

2. 过期内容因缓存被继续消费。诊断证据：clientTimestamp 晚于 expiresAt 但 action=include。恢复动作：让缓存 TTL 小于最小状态变化间隔；在 consume() 中始终基于当前时间重新计算；对过期内容主动淘汰缓存。

3. deprecated 缺少 replacedBy。诊断证据：响应中 warningLevel=deprecated 但 replacement=null。恢复动作：schema 校验增加该字段为必填，加载时报错；对已有记录生成占位符或手动迁移。

4. 状态转换日志顺序错乱。诊断证据：TransitionLog 中后一条 timestamp 早于前一条，或最终状态与 status 字段不一致。恢复动作：加载器拒绝该文件；运维人员按 git 历史重新生成 TransitionLog；必要时通过管理员命令强制重置。

5. 策略在 Web 与 API 中不一致。诊断证据：同一 slug 在 API 返回 include-with-warning，而 Web 显示为正常内容。恢复动作：Web 层只使用 consume() 返回的决策对象，不直接读取 status；在 monorepo 中共享同一份策略代码。

6. 未知状态导致加载崩溃。诊断证据：验证器报告 "unknown status: pending-review"。恢复动作：schema 使用 enum 约束；加载器将未知状态视为 fatal error，拒绝整个批次，而不是降级为 draft。

## 问答测试样例

1. 正向问题：active 概念是否应出现在默认公开搜索中？答案：是，返回 include，且无 warning。判断依据：status=active 且 context.searchMode=default。

2. 正向问题：deprecated 概念是否保留在旧链接中？答案：是，返回 include-with-warning，并附带 replacedBy。判断依据：replacedBy 存在且指向有效记录。

3. 边界问题：草稿在 includeDrafts 模式下能否被 Agent 引用？答案：可以返回，但 Agent 必须将引用标记为 provisional，不得作为事实断言。判断依据：role=agent 且 context.includeDrafts=true。

4. 边界问题：sunsetDate 已到达但状态仍是 deprecated 的内容如何处理？答案：视为 expired，action=exclude；若 context.audit=true，则返回 archiveUri。判断依据：clientTimestamp >= sunsetDate。

5. 边界问题：请求同时要求返回 replacement 且 replacement 本身是 draft 怎么办？答案：拒绝返回原内容，原因"替换目标未稳定"，并提示请求者等待 replacement 进入 active。判断依据：consume() 校验 replacedBy 的目标状态。

6. 无证据拒答：如果概念文件缺少 status 字段，代码应返回什么？答案：不推断 active，直接返回 schemaValidationError，文件拒绝加载。判断依据：status 为必填字段。

7. 无证据拒答：当 TransitionLog 显示该记录从 active 直接变为 active，没有实际变化，但 timestamp 更新，应如何处理？答案：这不是错误，但应视为无状态变更，不生成新的治理事件；日志可保留，version 不提升。

## 维护、版本、来源与相邻主题的关系

维护工作应每月执行一次：扫描所有 deprecated 记录，检查 sunsetDate 是否在未来 30 天内；对 expired 记录，评估是否保留 archiveUri 或物理删除本地文件。版本管理上，schemaVersion 升级时必须提供迁移脚本，将旧文件升级到最新字段约束。如果无法自动迁移，应标记为 deprecated 而不是静默修改。

来源追踪要求每个概念记录记录 sourceUri 和 contentHash，并在 TransitionLog 中记录每次修改的 git commit。这样任何消费决策都可以回溯到具体的来源文件。

与相邻主题的关系：本文只处理"生命周期状态"，不处理访问控制（ACL）、内容质量评分、语义相似度排名或分类体系。ACL 在状态决策之后执行，如果 consume() 返回 include，但请求者没有角色权限，仍应拒绝。质量评分影响排名，但不改变状态。语义搜索可能召回 draft，但召回后必须通过 consume() 过滤。分类体系提供 tags，但不影响状态转换。

## 结论

事实：OKF-compatible 知识库应使用 active、draft、deprecated、expired 四个显式状态；过期内容默认不可消费；弃用内容必须携带 replacement；状态字段必须在加载时严格校验；消费策略应由单一纯函数实现。

推论：草稿默认隐藏对生产系统最安全；硬截止日期比相对时间更利于测试；加载阶段严格校验能减少运行时歧义。

未知：不同领域对 sunset 到 expired 的合理时长没有普适标准；人工审查触发策略的最佳频率仍未确定；在超大知识库中全量加载验证是否会成为瓶颈需要实测数据。
