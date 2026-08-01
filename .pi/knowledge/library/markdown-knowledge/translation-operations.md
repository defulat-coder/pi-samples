---
type: concept
title: 多语言内容：验证与运维视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。保持术语映射、数字和条件一致，而不是逐句机械翻译
resource: .pi/knowledge/library/markdown-knowledge/translation-operations.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, translation, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: translation
variant: operations
---

# 多语言 Markdown 知识库：在运维视角下保持术语、数字与条件一致

## 摘要与问题边界

本文面向负责性能、稳定性与故障恢复的工程师，讨论如何在本地 Markdown 知识库（例如 `.pi/knowledge`）中为同一技术概念维护多语言版本，并保证检索器和 Agent 引用时不会漂移。核心问题不是“把英文逐句译成中文”，而是让术语、数字与条件在跨语言后仍然指向同一语义对象。讨论范围限定为文本型技术知识条目及其辅助索引，不包含运行时机器翻译、UI 文案、音视频字幕或法律合规文本。

## 核心概念与数据模型

1. **概念词条（Concept Entry）**：每个知识单元拥有稳定的 `canonical_id`，所有语言版本共享该标识。文件按 locale 目录存放，例如 `.pi/knowledge/throttle_rate/zh.md` 与 `.pi/knowledge/throttle_rate/en.md`。
2. **术语映射表（Term Index）**：`canonical_id` 到各语言表层词（surface）的映射。例如 `throttle` 在英文为 `throttle`，在中文为 `限流`。每个表层词必须反向指向 `canonical_id`。
3. **不变量段（Invariant Segment）**：数值、正则、版本号、代码片段等在所有语言中保持逐字符一致。它们通常在正文中以行内代码或独立块标记，并在辅助索引中单独注册。
4. **条件单元（Condition Unit）**：描述行为分叉的 `if/then/else`、阈值判断或状态转移。翻译时只替换术语表层，保留运算符与阈值。
5. **语言元数据（Locale Metadata）**：每份 locale 文件记录 `canonical_id`、`locale`、`version`、`source_checksum`、`term_index_version`。用于判断源文件回退时哪些语言未同步。
6. **验证断言集（Validation Suite）**：一组可自动执行的检查，包括术语覆盖率、不变量等价、条件结构等价、链接可达性、元数据一致性。

## 设计决策与取舍

### 文件组织按语言目录而非单文件多语言
选择为每个 `canonical_id` 建立子目录，并在其下存放各语言文件。优点：git diff 可以按语言快速对比，链接检查器也能明确知道不同 locale 的对应关系。例外：如果某概念仅在某地区有效，应单独分配新的 `canonical_id`，而不是塞进同一目录的 locale 变体。

### 术语中心而非句子中心
不追求逐句翻译，而要求每个重要概念都落到术语表。优点：检索器可用 `canonical_id` 召回所有语言版本。边界：解释性文本允许“可接受的表层差异”，但涉及行为描述时必须使用术语表中的 surface。

### 不变量集中注册并禁止翻译
所有数字、常量、阈值必须抽取到辅助索引，并在各 locale 中保持同一来源。判断标准：如果两个语言版本的数值不同，则至少有一个是错误的。例外：货币、地区性法规配额等本就该地区化的值，必须单独标记为地区变量，而非不变量。

### 条件逻辑采用中性表达
避免用自然语言口语化描述条件，而采用伪代码或结构化表格。例如：`if request_count_1s <= max_rps then allow else queue`。优点：不同语言的逻辑结构可被解析器等价比较。代价：非技术读者可读性下降，需要配套示例。

### 版本与来源强耦合
每份 locale 翻译必须记录源文件 checksum 和 term_index 版本。优点：版本回退时能够检测哪些语言未同步。代价：每次更新源文件，所有 locale 的元数据都需要重新校验，CI 时间会增加。

## 可执行的实施流程

1. 定义知识域并输出术语表，为每个核心概念分配 `canonical_id`。
2. 在 `.pi/knowledge` 下建立 `canonical_id` 子目录，并在每个目录下存放 `locale.md` 文件。
3. 在源语言 Markdown 中用行内代码或独立块标记不变量段，并在辅助索引中注册。
4. 将条件单元改写为结构化的中性表达式或表格。
5. 创建或更新 `term_index.yaml`/`term_index.json`，填入所有 locale 的表层映射。
6. 翻译其他语言版本时，只翻译术语表层和解释性文本，不得改动数值与逻辑结构。
7. 运行静态验证：链接可达、术语覆盖、不变量 checksum、条件等价。
8. 将合并后的知识库接入 `search_knowledge` 冒烟测试，采样多语言查询的延迟与召回率。

## 本地文件知识库示例

```yaml
# .pi/knowledge/throttle_rate/throttle_rate.yaml
canonical_id: throttle_rate
version: 1.3.0
locale: zh
source: throttle_rate.en.md
source_checksum: sha256:a1b2...
term_index_version: 2.1.0
invariants:
  - id: max_rps
    value: 1200
    type: integer
    reason: 网关压测得出的硬件上限
conditions:
  - id: burst_rule
    logic: "if request_count_1s <= max_rps then allow else queue"
    locale_surface: "若 1 秒请求数 ≤ 1200 则放行，否则入队"
terms:
  - canonical_id: throttle
    surface: 限流
    pos: noun
  - canonical_id: queue
    surface: 入队
    pos: verb
```

输入：上述 YAML 文件以及对应的 Markdown 正文。处理：验证器读取 Markdown AST，抽取代码块和条件单元；用术语表将表层词替换为 `canonical_id`；对比各 locale 的不变量数值与条件表达式。输出：一份验证报告，列出每个 locale 的术语覆盖率、缺失映射、不变量差异、条件等价判定。

## 性能、质量和可观测性指标

- **验证耗时**：单个概念在所有语言下的校验耗时。在 CI 中测量，目标不超过 200 毫秒。
- **术语覆盖率**：某 locale 中已映射的 `canonical_id` 数量与总数的比值。低于 95% 视为阻塞。
- **不变量一致性率**：所有 locale 中数值完全一致的 invariant 比例。目标为 100%。
- **多语言查询延迟**：`search_knowledge` 在不同语言查询下的 P95 响应时间。可通过对 API 端点注入请求测得。
- **回归恢复时间（MTTR）**：从术语漂移告警到重新绿构建的平均时间。由 CI 和告警系统记录。

## 失败模式、诊断证据与恢复动作

1. **术语漂移**：同一 `canonical_id` 在中文里出现多个同义词，如“限流”“节流”“限速”。诊断证据：`term_index` 中一个 `canonical_id` 对应多个 surface，或检索召回结果分散。恢复：统一 surface，更新 `term_index`，重跑验证。
2. **数字被误译**：中文文件将 1200 写成 12000。诊断证据：invariant 比较报告差异。恢复：修正数值，并将该字段从翻译工作流中锁定。
3. **条件结构破坏**：翻译把 `if/else` 改为自然语言，阈值符号被替换。诊断证据：条件表达式解析失败或等价检查不通过。恢复：改用中性表达式重写，并添加单元测试。
4. **跨语言链接失效**：某 locale 文件引用了不存在的英文锚点。诊断证据：链接检查器报 404。恢复：修正路径或添加重定向条目。
5. **版本回退未同步**：只回滚源语言，其他 locale 仍为新版本。诊断证据：locale 元数据中 `source_checksum` 与当前源文件不一致。恢复：同步回退所有 locale，或显式标记该 locale 为过期。

## 问答测试样例

- **正向**：在中文知识库中，限流的默认 1 秒 RPS 上限是多少？答案：1200，依据 invariant `max_rps`。
- **正向**：英文中 `throttle` 的对应 `canonical_id` 是什么？答案：`throttle`，依据 `term_index`。
- **边界**：德文版本未注册 `queue` 的术语，应如何处理？答案：不应编造，建议 fallback 到英文或标记缺失。
- **边界**：中文把条件写成“若 1 秒请求数 ≥ 1200 则放行，否则入队”，是否正确？答案：不正确，与 `burst_rule` 逻辑相反。
- **无证据拒答**：日语版本的最大连接数是多少？答案：未知，因为当前知识库未提供 `ja` locale。
- **无证据拒答**：限流阈值是否曾经调整为 1500？答案：无法从当前版本推断；如版本记录未提及，回答未知。

## 维护、版本、来源与相邻主题

维护周期：每次 PR 更新知识库时运行验证；每两周运行一次术语漂移扫描。版本管理：`term_index` 使用语义化版本，并生成 lock 文件；知识库发布时打 git tag。来源：本文基于项目 `.pi/knowledge` 自定义 Markdown 知识集合，依据 `AGENTS.md` 通过 `search_knowledge` 工具读取，而非 Pi 运行时自动加载。相邻主题：与 UI 国际化（运行时文案）、法律翻译（合规性文本）、音视频字幕（时间轴对齐）不同；本主题面向可被检索器和 Agent 引用的技术参考知识。

## 结论

**事实**：每个概念共享 `canonical_id`；不变量必须在所有 locale 中保持相同数值；`term_index` 版本控制术语映射；`search_knowledge` 是项目自定义读取机制。

**推论**：提高术语覆盖率与使用中性条件表达，能够降低跨语言召回不一致和解析失败；CI 验证时间会随着语言数量线性增加。

**未知**：当某个 locale 不完整时，对下游模型推理的量化影响；术语漂移扫描的最佳周期；如何处理特定地区法规要求的本地化措辞，而不破坏 `canonical_id` 一致性。
