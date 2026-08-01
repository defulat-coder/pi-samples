---
type: concept
title: Bundle 导航：架构视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。用 index 文件表达目录结构和渐进式披露，而非假装倒排索引
resource: .pi/knowledge/library/okf-governance/bundle-index-architecture.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, bundle-index, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: bundle-index
variant: architecture
---

# OKF Bundle 导航：以 Index 文件为边界的渐进式目录架构

## 摘要与问题边界

Bundle 导航解决的是“知识集合如何被稳定地进入、遍历和逐步展开”，而不是“如何最快地定位一个关键词”。它的核心约束来自项目本身：`.pi/knowledge` 被定义为自定义 Markdown 文件包，Agent 必须通过 `search_knowledge` 工具访问，而不能假设整个仓库会被自动加载进上下文。因此，导航的责任是声明“哪些内容存在、它们如何组织、以及在不同场景下应披露到什么程度”。

问题边界限定如下：本主题只讨论通过 index 文件表达的目录结构与渐进式披露机制，不涉及向量索引的构建、LLM 嵌入策略，也不讨论文件权限或项目信任沙箱的具体实现。它面向负责长期演进和跨模块边界的设计者，要求先确定概念、责任和可替换接口，再选择具体工具。

## 核心概念与数据模型

1. **Bundle（文件包）**：一个自包含的知识单元，由一组 Markdown 文件、一个根 index 文件和可选的局部 index 文件组成。Bundle 的边界通过根 index 的 `bundle_id` 和文件系统根目录共同确定，而不是通过检索结果的相关性分数。
2. **Index 文件（索引文件）**：显式声明目录结构和导航边的人工或半自动化文件。它不同于倒排索引：index 文件描述的是“概念包含关系”和“阅读路径”，而不是“术语到文档的映射”。
3. **导航节点（Node）**：每个 index 文件或 Markdown 正文文件都是导航图中的一个节点。节点拥有稳定标识符 `node_id`，与文件路径解耦，以支持重命名和迁移。
4. **导航边（Edge）**：从 index 指向子 index 或叶文档的带类型链接，类型包括 `contains`（包含）、`extends`（扩展）、`references`（引用）和 `deprecated`（已弃用）。类型决定了遍历行为。
5. **渐进式披露层级（Disclosure Level）**：每个节点标记为 L0（标题与摘要）、L1（问题边界）、L2（设计决策）或 L3（完整实现与操作细节）。消费者根据上下文预算选择展开到哪一层。
6. **来源注解（Provenance）**：每个叶文档头部必须声明 `source`（来源仓库、文档或会议）、`last_verified`（最后验证日期）和 `confidence`（可信度等级）。这是防止虚构事实的第一道防线。
7. **Bundle 快照（Snapshot）**：某一时刻整个 bundle 的内容哈希和节点图签名。快照用于版本回滚、一致性校验和消费者缓存失效。

## 设计决策与取舍

### Index 文件优先于自动生成目录
自动生成目录（TOC）依赖文件路径和标题层级，容易在重命名后失效，且无法表达跨文件的概念关系。Index 文件作为显式契约，虽然需要人工维护，但能提供稳定的入口和语义类型。取舍：维护成本上升，换来导航语义的长期稳定。

### 目录深度受限而非无限嵌套
将 index 嵌套深度限制为 4 层。过深的结构会导致路径脆弱、消费者遍历成本不可控；过平的结构则会失去聚合能力。4 层足以覆盖“根 → 主题域 → 主题 → 子主题 → 叶文档”的常用结构。

### 路径不作为主键，node_id 才是
文件路径仅用于定位和渲染，不用于概念身份识别。node_id 采用 `domain:topic:leaf` 的形式，与路径无关。这样允许文件在 bundle 内迁移而不破坏外部引用。

### 渐进式披露由 index 声明，不由消费者猜测
L0–L3 的层级必须显式写在 index 条目中，而不是让消费者自己判断“这篇文档该读多深”。这避免了上下文浪费和信息过载，但也要求作者在撰写时自觉控制每一层的粒度。

### 人工主编、工具辅助校验
Index 文件由领域作者主笔，自动化工具只负责校验：检查死链、披露层级一致性、循环引用和 orphan 节点。完全自动生成 index 会削弱“边界声明”这一核心职责。

### 版本以 Bundle 快照为单位，不以单文件版本为主
虽然单文件可以保留 `last_verified`，但对外发布和回滚的最小单位是 bundle snapshot。这保证了消费者拿到的是一致的导航图和内容集合。

## 可执行的实施流程

1. **划定 bundle 边界**：确定 bundle 的根目录、目标读者和排除范围，写出根 index 的 `bundle_id`、`purpose` 和 `exclusions`。
2. **定义 node_id 命名空间**：制定 `domain:topic:leaf` 的命名规则，并在根 index 中声明已分配的 domain。
3. **设计顶层主题域**：在根 index 下列出 3 到 7 个一级主题域，避免过早细分。
4. **创建中间层 index 文件**：为每个需要进一步展开的主题域创建子 index，声明其 `contains` 关系和披露层级。
5. **撰写叶文档并绑定 node_id**：每篇叶文档头部写入 `node_id`、`disclosure_level` 和 `provenance`。
6. **建立导航边**：在 index 中用带类型链接指向子 index 或叶文档，避免裸 URL。
7. **配置校验脚本**：引入死链检查、循环引用检测、orphan 文档检测和披露层级一致性校验。
8. **生成 bundle snapshot**：计算文件内容哈希和节点图签名，发布版本号。
9. **部署消费接口**：让 Agent 或 Web 前端通过 bundle 版本号加载根 index，并按需展开节点。
10. **建立漂移监控**：每周扫描新增但未入 index 的文件，以及未被任何导航路径访问的 orphan 节点。

## 本地文件知识库示例

```yaml
# .pi/knowledge/index.yml
bundle_id: "pi-samples:knowledge"
version: "2025.06-14-g3a9c"
purpose: "为 Web-triggered Pi Coding Agent 项目提供可导航的架构与操作知识"
exclusions:
  - "不包含模型提供商的 API 密钥管理细节"
  - "不包含第三方技能的内部实现"

nodes:
  - node_id: "kg:boundaries"
    title: "项目边界与责任划分"
    level: L1
    edge: contains
    target: "./boundaries/index.yml"
    abstract: "界定 apps/api、apps/web、packages/pi-agent 等模块的职责"

  - node_id: "kg:pi-agent:session"
    title: "AgentSession 生命周期"
    level: L2
    edge: contains
    target: "./pi-agent/session-lifecycle.md"
    abstract: "创建、订阅、提示、卸载的完整流程"
```

输入：上述 YAML 作为根 index，以及对应的目标 Markdown 文件。
处理：Agent 调用 `search_knowledge` 时，先读取根 index，根据用户问题的主题域选择 `node_id`，再按 `level` 决定是否继续向下展开。例如，若用户只问“项目边界是什么”，则在 `kg:boundaries` 的 L1 摘要处停止；若追问“Session 如何订阅”，则沿边展开到 L2 叶文档。
输出：按披露层级裁剪后的节点内容列表，以及所经过的导航路径 `kg:root → kg:boundaries → kg:pi-agent:session`，用于后续引用和审计。

## 性能、质量与可观测性指标

1. **导航覆盖率**：可自根 index 到达的叶文档数除以 bundle 中叶文档总数，目标 ≥ 98%。通过遍历节点图并统计 orphan 文档数量来测量。
2. **死链率**：index 中指向不存在的 `target` 的边数除以总边数，目标 = 0%。在 CI 中通过校验脚本测量。
3. **平均导航深度**：从根到叶文档的边数平均值，目标在 2.5 到 3.5 之间。过深提示结构臃肿，过平提示聚合不足。
4. **披露命中准确率**：消费者实际展开的层级与 index 声明层级一致的请求比例，目标 ≥ 90%。通过对比请求日志和 index 标记测量。
5. **Bundle 漂移率**：统计周期内新增文件未进入 index 的比例，目标 < 5%。通过每周扫描文件系统与节点图差异测量。

## 失败模式、诊断证据与恢复动作

1. **Index 腐烂（Index Rot）**：index 指向已删除或移动的文件。
   - 证据：校验脚本报告 `target` 不存在或 `node_id` 无法解析。
   - 恢复：删除或重定向失效边，更新 `bundle snapshot` 版本号。

2. **孤儿文档（Orphan Document）**：叶文档存在，但没有 index 边指向它。
   - 证据：覆盖率低于阈值，文件存在于目录但不在节点图中。
   - 恢复：在合适的父 index 中添加 `contains` 边，或将其移出 bundle。

3. **循环导航（Circular Navigation）**：index 之间通过 `contains` 边形成环。
   - 证据：DFS 遍历检测到重复的 `node_id` 路径。
   - 恢复：打破环，将其中一条边的类型改为 `references`（非遍历型）或重构目录结构。

4. **披露层级错配（Disclosure Mismatch）**：L1 摘要中混入了 L3 的实现细节。
   - 证据：自动校验发现摘要字段长度超过阈值，或包含代码片段、配置参数。
   - 恢复：拆分节点，将细节下沉到 L3 叶文档，并在 index 中显式降级。

5. **主题域泄漏（Domain Leakage）**：某主题域下的叶文档涉及其他 bundle 的核心职责。
   - 证据：跨 bundle 引用频繁、review 时发现边界声明与实际内容冲突。
   - 恢复：将文档迁移到对应 bundle，在原位置保留 `references` 边，并更新 exclusions 说明。

6. **版本偏移（Version Skew）**：消费者缓存了旧的 bundle snapshot，导致读取到已删除节点。
   - 证据：消费者请求日志中出现 404 节点或版本号不一致。
   - 恢复：强制缓存失效，或要求消费者每次请求时携带期望版本号进行协商。

## 问答测试样例

1. **正向**：在 pi-samples 仓库中，`.pi/knowledge` 的导航入口是什么？
   - 期望：根 index 文件 `.pi/knowledge/index.yml`，其中声明了 `bundle_id`、`purpose` 和顶层 `nodes`。

2. **正向**：渐进式披露如何在 bundle 导航中体现？
   - 期望：通过 index 条目中显式的 `level` 字段（L0–L3）控制展开粒度，消费者按问题深度选择层级。

3. **边界**：如果一篇 Markdown 文档未出现在任何 index 的导航边中，它是否属于当前 bundle？
   - 期望：不属于可导航知识；它可能是未整理草稿或应被移出 bundle，直到被显式收录。

4. **边界**：index 文件是否等同于倒排索引？
   - 期望：否。index 文件表达的是目录结构和渐进式披露路径，而不是术语到文档的映射表。

5. **拒答**：OKF 的全称是什么？
   - 条件：若项目文档未提供官方全称定义，则应拒绝回答，说明“OKF 在此项目上下文中指知识治理框架，具体全称不在当前 bundle 来源范围内”。

6. **拒答**：请给出 `.pi/knowledge` 中所有文档的完整实现细节。
   - 条件：若未指定具体 node_id 且上下文预算不足，应拒绝，并提示用户先选择主题域和披露层级。

## 维护、版本、来源与相邻关系

维护责任由内容作者和平台工程师共同承担：作者保证 index 结构和披露层级正确；平台工程师维护校验脚本、snapshot 发布和消费接口。版本策略采用 `YYYY.MM-序号-短哈希` 的日历化版本，便于按时间回滚，同时保留内容哈希用于完整性校验。

来源管理要求每篇叶文档的 YAML 头部包含 `source`、`last_verified` 和 `confidence`。禁止引用未经验证的外部系统状态，例如“某某云服务商的最新文档”。如需引用，必须在 `last_verified` 中给出验证日期，并在 `confidence` 中标记为间接。

与相邻主题的关系：
- **全文检索与向量检索**：它们负责“找到可能相关的内容”，bundle 导航负责“决定如何进入和展开”。两者互补，导航不应伪装成倒排索引。
- **Skill 打包**：Skill 的输出可能产生新的 Markdown 文件，必须由漂移监控及时收入 index。
- **Prompt 模板**：Prompt 模板引用 bundle 节点时应使用 `node_id`，而不是文件路径。
- **项目信任与沙箱**：信任机制决定谁能读写 bundle，导航机制决定读写的语义结构。

## 结论

事实：`.pi/knowledge` 是 pi-samples 项目定义的自定义 Markdown 知识包；Agent 通过 `search_knowledge` 访问它；项目明确区分了 apps/api、apps/web、packages/pi-agent 等模块的职责。

推论：将 bundle 导航建模为“根 index + 中间 index + 叶文档”的显式图结构，并辅以 L0–L3 的渐进式披露层级，可以在不依赖倒排索引的前提下，为 Agent 和人类读者提供稳定的进入路径。`node_id` 与路径解耦、版本以 snapshot 为单位、校验脚本自动化但不替代人工主编，是这一架构能够长期演进的关键设计。

未知：OKF 在其他组织或上游 Pi 项目中的精确定义是否与本项目一致，目前无法通过本仓库验证；不同 LLM 消费者对 L0–L3 层级的实际敏感度差异，也需要在生产流量中进一步测量。
