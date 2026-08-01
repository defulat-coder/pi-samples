---
type: concept
title: Bundle 导航：验证与运维视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。用 index 文件表达目录结构和渐进式披露，而非假装倒排索引
resource: .pi/knowledge/library/okf-governance/bundle-index-operations.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, bundle-index, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: bundle-index
variant: operations
---

# OKF Bundle 导航：用索引文件驱动目录结构与渐进式披露

## 摘要与问题边界

Bundle 导航解决的是“知识库在召回阶段如何被 Agent 定位”的问题，而不是“如何被搜索引擎倒排索引”。它把目录结构和渐进式披露写进显式的 index 文件，让运行时可以按层级解析、按条件展开，而不是把文件系统当作黑盒倒排索引来猜测。

问题边界必须明确：本文只讨论本地或近端文件型知识库（例如 TypeScript monorepo 的 `.pi/knowledge/`、`docs/` 或 Web 打包后的静态 bundle），不涉及远程向量数据库、不涉及跨语言 RPC 协议、也不讨论大模型本身的推理质量。核心风险在于：如果 index 文件与真实目录不一致，导航会在第一层就偏离；如果渐进式披露层级过深，单次请求会膨胀到不可接受的延迟；如果缺少版本指纹，缓存和回滚会把过期结构当成当前结构使用。

## 核心概念与数据模型

1. **Bundle**：一个自包含的目录单元，内部包含若干文档、媒体或子 Bundle，以及一个且仅一个 `index.okf`（或项目约定的 `index.md`、`index.json`）文件。Bundle 不依赖外部注册表即可被解析，但允许通过来源字段声明上游版本。

2. **Index 文件**：不是倒排索引，而是目录的“声明式地图”。它记录本 Bundle 的标题、摘要、子节点列表、披露层级、版本指纹、来源 URI 以及可观测标记。运行时先读 index，再决定是否进入子节点。

3. **渐进式披露（Progressive Disclosure）**：用 `disclosure_level` 字段把信息分成可逐层展开的切片。Level 0 只给出“是什么”，Level 1 给出“为什么重要”，Level 2 给出“具体判断和边界”。Agent 在一次 prompt 中不应默认拉到最高级，而应根据 token 预算和上下文深度逐级申请。

4. **导航边（Nav Edge）**：index 中子节点之间的引用关系。每条边包含目标 ID、关系类型（`contains`、`refines`、`contradicts`、`deprecated`）以及权重建议。权重是提示而非保证，最终排序由运行时策略决定。

5. **来源指纹（Source Fingerprint）**：包含 `git_commit`、`content_hash`、`last_verified_at` 三个字段。用于在缓存命中时验证结构是否仍然有效，也用于故障恢复时判断应该回退到哪个版本。

6. **可观测标记（Observability Tags）**：每个节点可带 `stability`、`latency_hint`、`recovery_priority` 标签。这些标记不是装饰，而是运维侧可过滤、可报警的维度。例如 `latency_hint: high` 意味着该节点下可能包含大表格或长代码片段。

## 设计决策与取舍

### 显式索引优于文件系统扫描
直接扫描目录可以得到“当前有什么”，但无法表达“应该被如何阅读”。显式 index 文件带来维护负担，却也提供可验证性：CI 可以校验 index 中列出的子节点是否真实存在、披露层级是否连续、来源指纹是否与当前 commit 匹配。代价是任何文件重命名都必须同步更新 index。

### 渐进式披露优于一次性全量加载
全量加载在单次请求中信息完整，但容易触达 token 上限并引入不相关上下文。渐进式披露通过 level 控制，使每次展开都有明确代价。边界例外：在故障恢复场景下，运维人员可能需要强制拉取 Level 2 以快速定位根因，此时应通过显式参数 `override_disclosure_level` 跳过默认策略，并在日志中留下审计痕迹。

### 本地文件优先于远程注册表
本地文件路径简单、可离线验证、延迟稳定。远程注册表虽然便于分发，但引入了网络抖动、认证和版本同步问题。取舍规则：远程仅作为来源声明存在，运行时解析必须以本地快照为准。

### 只读导航优于写入型知识库
Bundle 导航只负责“找到并引用知识”，不负责对知识库进行写回或评分。任何需要更新知识库的操作应通过版本控制流程完成，而不是由 Agent 在导航过程中修改 index。这样可以防止运行时错误污染长期存储。

### 结构一致性优于动态重排
index 中的顺序和层级表达的是作者意图，不应由每次请求的语义相似度动态打散。相似度排序应作用于同一节点内部的可选引用列表，而不是跨层级重排。例外：当节点标记为 `deprecated` 时，运行时可以选择将其下沉到底部或完全隐藏，但必须在响应元数据中记录此行为。

## 可执行的实施流程

1. 在知识库根目录创建 `index.okf`（或项目约定文件名），声明根 Bundle 的标题、摘要、版本指纹和顶层子节点列表。

2. 为每个主题域建立独立子目录，每个子目录内再放一个 `index.okf`，形成树状结构。避免嵌套超过四层，超过四层时应拆分为同级子 Bundle 并通过引用边连接。

3. 在每篇具体文档头部添加 `disclosure_level` 和 `observability_tags`，用 YAML 前置元数据（注意：这是文档内部元数据，与全文要求的“不要输出 YAML frontmatter”不冲突，因为此处讨论的是示例文件格式）表达。值必须是枚举，不能是自由文本。

4. 编写 CI 校验脚本，检查：所有 index 中引用的子节点路径存在；每条导航边的目标 ID 唯一；`disclosure_level` 连续；来源指纹与当前 git commit 或计算出的 content hash 一致。

5. 在运行时为 Agent 实现导航器：先读取根 index，根据用户问题选择相关子节点，再读取子 index，如此递归，直到到达叶子文档。

6. 为导航器配置 token 预算和最大展开深度。默认策略是：每层最多展开 3 个相关子节点，每个节点最多取 Level 1 内容，剩余节点以摘要形式保留。

7. 在每次导航调用时生成结构化日志，包括：请求 ID、起始 index、展开路径、读取文件数、总字节数、命中缓存的版本指纹、以及是否触发 disclosure override。

8. 建立缓存层，缓存单元是“index 文件 + 版本指纹”，而不是按请求文本缓存。缓存失效只由文件系统 mtime 或指纹变化触发。

9. 在测试环境中注入已知错误的 index 文件，验证导航器能否在结构不一致时返回明确的错误码，而不是静默返回空结果。

10. 将导航事件接入现有可观测系统，使用统一标签：`okf.bundle.nav.{request|hit|miss|error|recovery}`。

## TypeScript/Web/本地文件知识库示例

输入是一段问题文本，例如“Pi 子进程集成里 Agent 如何选择工具？”；处理逻辑由本地导航器按 index 层级查找；输出是候选文档列表及其披露层级。

示例 index 结构（`docs/index.okf`）：

```json
{
  "id": "docs-root",
  "title": "Pi 知识库",
  "disclosure_level": 0,
  "source_fingerprint": {
    "git_commit": "a1b2c3d",
    "content_hash": "sha256:7f8...",
    "last_verified_at": "2025-08-10T12:00:00Z"
  },
  "observability_tags": {
    "stability": "stable",
    "latency_hint": "medium",
    "recovery_priority": "high"
  },
  "children": [
    {
      "id": "pi-integration",
      "title": "Pi 集成",
      "relation": "contains",
      "level": 1,
      "path": "pi-integration/index.okf"
    },
    {
      "id": "adr",
      "title": "架构决策",
      "relation": "contains",
      "level": 1,
      "path": "adr/index.okf"
    }
  ]
}
```

处理：导航器读取 `docs/index.okf`，匹配问题中的关键词“Pi”“子进程”“Agent”，命中 `pi-integration` 子节点；随后读取 `pi-integration/index.okf`，继续向下匹配；最终到达 `docs/pi-integration/rpc-tool-selection.md`，取得其 Level 1 摘要和 Level 2 详细判断。

输出：

```json
{
  "request_id": "nav-20250810-001",
  "path": ["docs-root", "pi-integration", "rpc", "tool-selection"],
  "documents": [
    {
      "id": "rpc-tool-selection",
      "title": "Agent 如何选择工具",
      "level": 1,
      "summary": "Pi 作为运行时自行决定，API 不应做关键字路由。",
      "source_fingerprint": { "git_commit": "a1b2c3d", "content_hash": "sha256:9e0..." }
    }
  ],
  "metadata": {
    "files_read": 3,
    "bytes_total": 4200,
    "cache_hit": true,
    "cache_fingerprint": "a1b2c3d"
  }
}
```

输入决定检索范围；处理决定层级展开；输出给出可审计的引用链，而不是一段不可追溯的文本。

## 性能、质量与可观测性指标

1. **Index 解析延迟（P50/P95/P99）**：测量从请求开始到根 index 完成解析的时间。应在本地文件系统低于 5ms，网络挂载场景下低于 50ms。测量方式：在导航器入口埋点，记录 `okf.bundle.nav.parse.latency_ms`。

2. **文件读取次数与展开深度**：单次请求不应读取超过 10 个 index 文件，展开深度不超过 4 层。超过阈值应触发 `okf.bundle.nav.depth_warning` 事件。

3. **缓存命中率**：以版本指纹为键的缓存命中率应高于 70%。低命中率说明文件更新频繁或缓存键设计不合理。测量方式：统计 `cache_hit` 为 true 的请求占比。

4. **导航结果与最终答案的相关度**：通过离线评估集对比“导航返回的文档列表”与“人工标注的相关文档集合”，计算召回率和精确率。目标召回率不低于 85%，精确率不低于 70%。

5. **结构一致性错误率**：CI 校验中发现的 index 引用缺失、指纹不匹配、披露层级断裂等错误的数量。理想值为 0，任何非 0 结果都应阻塞部署。

6. **恢复耗时**：从检测到 index 损坏到回退到上一可用版本的时间。应能在 30 秒内完成本地回退，5 分钟内完成上游来源重新同步。

## 失败模式与恢复

1. **Index 文件与目录不同步**
   - 诊断证据：CI 报 `MISSING_CHILD`，运行时报 `ENOENT` 或返回空列表。
   - 恢复动作：禁止依赖运行时猜测，应回退到上一个通过校验的 git commit；修复 index 后重新部署。

2. **Disclosure level 越界**
   - 诊断证据：请求中传入 `level=3`，但文档只声明到 Level 1；日志出现 `DISCLOSURE_LEVEL_EXCEEDED`。
   - 恢复动作：导航器返回该节点当前最高级别内容，并在元数据中标记 `level_capped`；不允许静默降级为摘要。

3. **缓存指纹过期**
   - 诊断证据：`cache_hit=true` 但返回的 `content_hash` 与磁盘文件 hash 不一致；或 mtime 晚于缓存时间。
   - 恢复动作：立即失效该缓存条目，重新读取文件并更新指纹；同时告警，避免后续请求继续使用过期结构。

4. **循环导航边**
   - 诊断证据：递归深度超过阈值，请求 ID 对应的 path 数组中出现重复 ID；日志报 `NAVIGATION_CYCLE_DETECTED`。
   - 恢复动作：终止当前路径，记录循环边，返回已收集的节点；CI 中增加循环检测，防止带环的 index 进入主分支。

5. **Token 预算耗尽**
   - 诊断证据：展开到第 3 层时，预估 token 已接近上限；日志报 `TOKEN_BUDGET_EXHAUSTED`，未展开的节点以 ID 列表形式保留。
   - 恢复动作：截断到当前已展开节点，返回截断标记；用户可发起更具体的后续请求，而不是一次性扩大预算。

6. **来源指纹与 git commit 不一致**
   - 诊断证据：index 中的 `git_commit` 与 `git rev-parse HEAD` 不同，或 `content_hash` 与 `sha256sum` 计算结果不符。
   - 恢复动作：将知识库标记为 dirty，拒绝提供需要高可信来源的引用，直到 CI 重新校验通过。

## 问答测试样例

1. 正向问题：Pi 的 API 是否应该先对消息做关键字路由？
   - 期望回答：否。API 负责请求校验、会话身份和 SSE 传输；Pi 作为运行时决定工具调用。应引用 `docs/pi-integration/api-boundary.md`。

2. 正向问题：本地文件型知识库应该选择什么缓存键？
   - 期望回答：以 index 文件内容 hash 和版本指纹为键，而不是以用户查询文本为键。

3. 边界问题：如果某个子节点在 index 中存在但文件被删除，导航器应该做什么？
   - 期望回答：返回结构错误，不猜测替代文件，并触发回退到上一个有效版本。

4. 边界问题：能否让 Agent 在导航过程中直接修改 index 文件来修正错误？
   - 期望回答：不能。Bundle 导航是只读能力，写回必须通过版本控制流程。

5. 无证据拒答：Bundle 导航是否支持把 PDF 作为一级节点直接解析？
   - 期望回答：本知识库未提供相关证据。根据项目边界，只讨论文件型 index 驱动的目录结构，PDF 解析不在范围内。

6. 无证据拒答：渐进式披露是否保证每次请求都能减少 50% 的 token 消耗？
   - 期望回答：无法保证。渐进式披露减少的是不相关上下文的混入概率，具体 token 节省取决于查询与目录结构的匹配度，没有项目级测量数据支持固定比例。

## 维护、版本、来源与相邻主题

维护节奏：每次文档重命名或新增主题域后，必须同步更新 index；CI 在合并前强制校验。版本管理：index 文件中的 `source_fingerprint` 应与当前 git commit 或内容 hash 保持一致；发布时保存该指纹，便于回滚。

来源声明：对于引用外部文档的节点，使用 `source_uri` 字段，但运行时不依赖该 URI 存活。本地 snapshot 是权威来源。与相邻主题的关系：与“向量召回”相邻但互补——Bundle 导航负责目录结构和层级，向量召回负责同层级内的语义匹配；与“Agent 工具注册”相邻——导航结果通常作为 tool 输入的上下文来源，但导航器本身不是工具注册表。

## 结论

**事实**：Bundle 导航通过显式 index 文件表达目录结构，依赖本地文件系统，运行时按层级读取，并通过版本指纹保证结构一致性。渐进式披露是 controlled expansion，不是自动摘要。

**推论**：在本地 monorepo 或静态 Web bundle 中，如果 index 维护得当，该方案可以稳定地降低不相关上下文进入 prompt 的概率，并给出可审计的引用路径。运维侧可以通过解析延迟、缓存命中率、结构一致性错误率和恢复耗时来验证其健康状态。

**未知**：在多语言、跨仓库或高频动态更新的知识库中，Bundle 导航的维护成本是否会超过收益，目前缺乏项目级测量数据；不同披露层级对最终模型输出质量的量化影响，也尚未在控制实验中得出明确结论。
