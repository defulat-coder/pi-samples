---
type: concept
title: Bundle 导航：实现视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。用 index 文件表达目录结构和渐进式披露，而非假装倒排索引
resource: .pi/knowledge/library/okf-governance/bundle-index-implementation.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, bundle-index, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: bundle-index
variant: implementation
---

# Bundle 导航：用 index 文件实现 OKF 知识库的目录结构与渐进式披露

## 摘要与问题边界

OKF-compatible bundle 把知识库存成文件优先的目录树，但文件系统本身并不天然携带“阅读顺序”和“可见层级”。Bundle 导航要解决的是：如何在不用倒排索引假装所有文档平权的前提下，用显式的 index 文件描述“从哪里开始、先读什么、再揭示什么”。本文采用实现视角，面向需要把方案落成 TypeScript 代码的开发者，先明确输入、输出、错误、生命周期和验证步骤，再进入编码。范围限定在本地文件系统或 TypeScript 加载器层；不包含全文检索排序、向量召回、权限认证，也不把导航结构当作访问控制机制。

## 核心概念与数据模型

1. **Bundle root**：每个 bundle 必须有一个根目录，根目录内包含 `okf.json` 或 `manifest.okf.json`。它声明 bundle 的标识符、版本、默认语言和根 index 文件名。根是解析器唯一受信任的入口点，不能通过相对路径逃逸到上级目录。

2. **Index node**：结构由名为 `<name>.index.{md,yaml,json}` 的文件表达。它不是正文内容，而是目录元数据，负责声明该目录下的子条目。一个目录允许同时存在多个 index 文件，但解析器默认只读取按文件名排序后的第一个；若需要合并，必须由根配置显式开启。

3. **Entry record**：index 文件解析后归一化为 entry 对象。关键字段包括：`id`（全局唯一）、`path`（相对当前 index 的文件或目录路径）、`kind`（`node` 表示子目录、`leaf` 表示单篇文档、`link` 表示外部引用）、`label`（展示标题）、`disclose`（`hidden|summary|partial|full`，默认 `summary`）、`requires`（前置 entry id 数组）、`tags`（检索标签数组）、`weight`（整数排序权重）。缺失 `id` 时，解析器使用相对路径生成稳定 slug，并在验证阶段报告 info。

4. **Navigation tree**：解析器把全部 index 节点深度优先展开后生成的内存树。树不是持久化文件，而是由 `NavigationResolver` 按需生成。子节点顺序先按 `weight` 升序，同权再按 `label` 字典序。环状依赖会被当作错误，而不是静默截断。

5. **Progressive disclosure layer**：每个 entry 携带可见层级。渲染管线根据调用者传入的 `layer` 令牌过滤输出：`hidden` 条目被移除；`summary` 只保留标题和一行摘要；`partial` 保留正文前N段；`full` 保留完整内容。如果某个可见 entry 的 `requires` 指向 `hidden` 条目，验证器必须报出 `disclosure_gap` 警告。

6. **Validation report**：验证不通过布尔值概括，而是生成结构化报告。每条消息包含 `severity`（`error|warn|info`）、`code`（可机器处理）、`location`（文件路径与行号）、`message`。`error` 会阻止导航树生成；`warn` 允许生成但会进入日志；`info` 仅用于可追溯性。

7. **Resolver lifecycle**：`scan → parse → validate → materialize → cache → invalidate`。生命周期是严格的：只有验证通过的 index 映射才能进入 materialize；materialize 结果进入只读缓存；文件系统事件或显式 reload 触发缓存失效。

## 设计决策与取舍

### Index 文件作为结构权威来源，而不是目录自然顺序

文件系统 `readdir` 返回的顺序随操作系统和文件创建时间变化，不可作为知识阅读顺序。用 index 文件显式声明顺序，使 bundle 在不同机器上得到一致导航。代价是移动或新增文件后必须更新 index；如果忘记更新，解析器会把该文件视为“未编目”，默认不会出现在导航中，但验证器会报 `orphan_file` 警告，提醒维护者处理。

### 命名约定优于中央注册表

约定 `*.index.{md,yaml,json}` 与目录内容同地存放，使结构与内容一起被版本控制。中央注册表虽然查询快，但容易造成单点冲突，也不便于 fork 和合并。例外是跨 bundle 引用：当 `kind: link` 指向另一个 bundle 时，需要根级别的 `bundleMap` 提供别名解析。

### 渐进式披露是阅读提示，不是权限控制

`disclose` 字段影响的是导航输出中呈现多少内容，并不改变文件是否可读。如果 bundle 托管在公共仓库，任何拿到路径的人都能直接访问完整 Markdown。因此不能把 `hidden` 当作保密机制。边界场景是：若业务需要真正的保密，必须在 Resolver 之外再加一层授权服务。

### 层级解析器优于扁平站点地图

扁平站点地图在条目少时简单，但会丢失上下文；层级解析器能自然生成 breadcrumbs、兄弟节点、父子关系。代价是必须检测环：父子环、`requires` 环、以及混合环都要在验证阶段捕获。检测算法采用 DFS 染色法，时间复杂度 O(V+E)，对常见知识库规模可忽略。

### 惰性验证与缓存失效

解析器只在首次查询或文件变更时验证，日常读取走缓存。缓存键包含 bundle 路径、schema 版本和 `layer` 参数。风险是文件系统监听可能遗漏外部编辑，因此同时设置最大存活时间 TTL，超时后下一次查询强制重新扫描。开发环境 TTL 建议 5 秒，生产环境建议 60 秒以上，取决于发布流程。

## 可执行的实施流程

1. 在根目录定义 `manifest.okf.json`，固定字段 `okfVersion`、`bundleId`、`language`、`rootIndex`，并规定 index 文件命名模式。
2. 实现 `FileScanner`，按命名模式递归收集 index 文件，同时读取 `.okfignore` 或 `.gitignore` 中声明的排除规则。
3. 实现 `IndexParser`，支持 YAML、JSON 和带 frontmatter 的 Markdown 三种格式，统一输出 `Entry[]`，遇到未知字段按 severity 报 `unknown_field`。
4. 实现 `IdAssigner`：显式 `id` 优先；缺失时基于相对路径生成 slug；同一 index 内检查局部唯一，全局再检查一次全局唯一。
5. 实现 `Validator`：必填字段检查、路径存在性检查、`requires` 引用存在性检查、环检测、disclose 一致性检查，输出 `ValidationReport`。
6. 实现 `NavigationResolver.materialize()`：用验证后的 index 映射构建树，应用 weight 排序，计算每个节点的 breadcrumbs、depth、next/prev。
7. 暴露查询 API：`getById(id, layer)`、`subtree(path, layer)`、`breadcrumbs(id)`、`siblings(id)`。所有查询必须先命中缓存，未命中则触发 materialize。
8. 接入文件系统监听或轮询：当任意 `*.index.*` 或 `manifest.okf.json` 变更时，清除整棵缓存树；当普通 Markdown 变更时，只清除对应 leaf 的渲染缓存。
9. 编写集成测试：用 `memfs` 模拟文件系统，覆盖正常加载、环检测、缺失引用、 orphan 文件、layer 过滤五种场景，并对输出做快照回归。
10. 接入可观测性：在 Resolver 内埋点，输出解析耗时、验证错误数、缓存命中率等指标。

## 输入、处理与输出示例

下面的示例假设 bundle 位于 `/data/agent-knowledge`。

    /data/agent-knowledge/manifest.okf.json
    {
      "okfVersion": "1.0.0",
      "bundleId": "agent-knowledge",
      "language": "zh",
      "rootIndex": "index.yaml"
    }

    /data/agent-knowledge/concepts/index.yaml
    version: "1"
    entries:
      - id: getting-started
        kind: leaf
        path: ./getting-started.md
        label: 入门必读
        disclose: full
        weight: 10
      - id: advanced
        kind: node
        path: ./advanced
        label: 进阶主题
        disclose: partial
        weight: 20
        requires: [getting-started]

输入是本地文件系统上的 manifest 和两个 index 文件。处理阶段，Scanner 找到 `manifest.okf.json` 和 `concepts/index.yaml`，Parser 把它们转成 entry 记录，Validator 检查 `advanced` 的 `requires` 存在且没有 disclosure 冲突，Resolver 生成树。输出一次 `subtree('concepts', { layer: 'partial' })` 调用会得到两个节点：`getting-started` 以 `full` 渲染，`advanced` 以 `partial` 渲染，因为 `partial` 层包含 `summary` 和 `partial`，但不包含 `full` 的完整正文。

    const resolver = await BundleNavigation.open('/data/agent-knowledge', {
      defaultDisclose: 'summary',
      watch: process.env.NODE_ENV === 'development'
    });
    const nav = resolver.subtree('concepts', { layer: 'partial' });
    console.log(nav.items.map(i => i.id)); // ['getting-started', 'advanced']

## 性能、质量和可观测性指标

1. **Index 解析延迟**：从文件事件触发到 `ValidationReport` 可用的时间。用 `performance.now()` 在 `scan` 和 `validate` 之间测量，建议 p99 小于 200ms（条目数在 1000 以内）。
2. **验证错误率**：每 100 个 entry 中 `error` 数量。通过聚合 `ValidationReport.severity === 'error'` 计算，CI 中应设为 0。
3. **缓存命中率**：`NavigationResolver` 内部计数器统计命中缓存的查询次数与总查询次数之比。生产环境目标大于 95%。
4. **导航树规模**：`entryCount` 和 `maxDepth` 两个 gauge。超过 5000 个 entry 或最大深度超过 12 时应发出告警，提示拆分 bundle。
5. **查询延迟**：`subtree`、`getById`、`breadcrumbs` 的路由层 p50/p99 延迟。通过 API 中间件记录，目标 p99 小于 20ms。
6. **渐进式披露覆盖率**：带有显式 `disclose` 字段的 entry 占比。由 Validator 在 info 层输出，目标 100%；缺失时回退到 `defaultDisclose`。

## 失败模式、诊断证据与恢复动作

1. **Index 解析失败**：YAML 缩进错误或 JSON 缺少逗号。诊断证据是 Parser 抛出 `ParseError`，包含文件路径和行号。恢复动作是修复语法后保存文件，watcher 会自动重载；若 watcher 失效则调用 `resolver.reload()`。
2. **重复 entry id**：两个 index 文件声明了相同 `id`，或 `id` 与自动生成的 slug 冲突。诊断证据是 Validator 报告 `duplicate_id` 并列出冲突文件。恢复动作是重命名其中一个 `id`，并同步更新所有 `requires` 引用。
3. **缺失引用**：`requires` 或 `path` 指向不存在的 entry 或文件。诊断证据是 `missing_reference` 消息，包含源文件、缺失 id 或路径。恢复动作是创建目标文件、修正路径，或删除无效引用。
4. **环状依赖**：`requires` 或父子关系形成闭环。诊断证据是 `CycleError`，列出参与循环的 id 序列。恢复动作是打断任意一条非关键依赖，或把强依赖改为可选标签。
5. **Disclosure gap**：可见 entry 依赖 `hidden` entry。诊断证据是 `disclosure_gap` 警告，指出父 id 和隐藏的子 id。恢复动作是把被依赖项 disclose 提升为 `summary` 或 `partial`，或在 `requires` 中移除该依赖。
6. **缓存过期**：文件被外部工具修改但 watcher 未收到事件，导致导航返回旧结构。诊断证据是文件 `mtime` 大于缓存 `materializedAt`。恢复动作是调用 `resolver.reload()` 或缩短 TTL。

## 问答测试样例

1. **正向**：问“concepts 目录下有哪些 partial 层级的子条目？”期望返回按 weight 排序后的 `advanced` 等节点，且每个节点包含 `id`、`label`、`kind`。
2. **正向**：问“advanced 的 breadcrumbs 是什么？”期望返回 `['concepts', 'advanced']`，因为 advanced 是 concepts 目录下的 node。
3. **边界**：问“若 entry 没有 disclose 字段，会报错吗？”答案是不会直接报错，解析器回退到 `defaultDisclose`，Validator 会生成 info 提示缺失。
4. **边界**：问“getting-started 依赖 advanced、advanced 又依赖 getting-started 会怎样？”期望 Resolver 抛出 `CycleError`，导航树不会生成。
5. **边界**：问“path 指向不存在的文件会怎样？”期望 Validator 报 `missing_reference`，且 API 返回 422 与报告详情。
6. **无证据拒答**：问“哪个条目最适合初学者？”如果 index 中没有 `audience` 或 `difficulty` 字段，Resolver 不能从正文推断，必须返回空结果并说明“缺少可排序的元数据”。

## 维护、版本、来源与相邻主题关系

index schema 必须独立于 bundle 内容版本管理，建议用语义化版本，例如 `indexSchema: 1.2.0`。升级 schema 时提供迁移脚本，把旧字段映射到新字段，并在 CI 中对所有 bundle 跑一遍校验。index 文件本身随 Markdown 一起纳入 Git，来源与正文同源，便于 diff 审查和回滚。

相邻主题关系如下：全文检索和向量召回是独立层，它们依赖 navigation 提供的 id 和标签，但导航不替它们做排序；知识验证是更大范畴，包含 schema lint、orphan 检测、link 可达性；访问控制是独立安全层，navigation 的 `disclose` 只是 UI 提示；国际化可复用 index 结构，通过 `label.i18n` 或每个语言一份 index 文件实现；发布流水线负责把本地 bundle 打包成只读 artifact，发布时应冻结 Resolver 的缓存快照。

## 结论

事实是：OKF bundle 用显式 index 文件表达目录结构，entry 记录、 Resolver 生命周期和验证报告是落地 Bundle 导航的最小数据模型。推论是：在 1000 个 entry 以内、深度不超过 12 的知识库中，DFS 环检测与按 weight 排序的层级解析器足以提供稳定、可复现的导航输出；把 `disclose` 当阅读提示而不是权限控制，能避免安全错觉。未知是：当 bundle 规模超过单台机器文件系统监听的可靠阈值时，是否需要引入事件日志或分布式索引同步；以及不同自然语言的 index 合并策略是否会导致排序语义冲突，这些需要结合实际部署数据再做判断。
