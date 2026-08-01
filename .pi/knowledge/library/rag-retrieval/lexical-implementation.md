---
type: concept
title: 字面检索：实现视角
description: 从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。使用标题、标签、正文和中文关键词建立确定性召回
resource: .pi/knowledge/library/rag-retrieval/lexical-implementation.md
tags: [Pi, Agent, Kimi, 知识库, rag-retrieval, lexical, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: rag-retrieval
topic: lexical
variant: implementation
---

# 字面检索：在 TypeScript 本地知识库中构建确定性召回

## 摘要与问题边界

字面检索是一种以精确或近似字面 token 为召回条件的检索方式。它不把语义相似度作为第一优先级，而是要求：只要用户在查询中打出了知识库里真实存在的标题、标签、正文片段或中文关键词，系统就必须把这些片段带回结果集。确定性召回意味着命中条件可枚举、可验证，结果与索引中的 token 存在严格的对应关系。

它的适用边界非常清晰。它适合查找 API 名称、函数签名、错误码、文件路径、版本号、配置键名、CLI 命令等强标识性内容。它不适合处理同义词改写、口语化描述、跨领域抽象或需要深层推理的开放式问题。一个完整的 RAG 系统通常会把字面检索作为召回链路的第一层，再让语义检索和重排序处理剩下的模糊部分。在本实现视角下，我们关注如何把这一层落成一个可测试、可观测、可维护的 TypeScript 模块。

## 核心概念与数据模型

1. 文档片段 DocumentFragment
   它是索引的最小单位。字段包括：id、title、tags 数组、keywords 数组、body 文本、source 文件路径、version 字符串、createdAt 和 updatedAt。id 必须全局稳定，通常用文件路径加锚点生成，例如 `packages/pi-agent/src/session.ts#createAgentSession`。

2. 术语词库 Lexicon
   词库存放所有可检索的归一化 token，包括中文词、英文标识符、数字与符号组合。词库必须记录每个 token 的来源字段，以便后续区分 title、tag、keyword 或 body 的权重。

3. 倒排索引 InvertedIndex
   结构是 `Map<token, Posting[]>`。每个 Posting 记录 fragmentId、字段类型、字段内出现位置、原始形态。Posting 列表按字段权重排序，不预先计算最终得分，只在查询时按规则计算。

4. 查询解析器 QueryPlan
   输入是用户原始字符串，输出是解析后的 token 数组、未知 token 数组、字段过滤条件、布尔模式标志。未知 token 指在词库中完全不存在的 token，必须在结果中标记出来，而不是默默忽略。

5. 匹配结果 Match
   包含 fragmentId、命中 token 列表、命中的字段类型、原始分数、版本号、来源路径。Match 不直接回答用户，它只负责把候选片段交给下游生成器或重排序器。

6. 召回契约 RecallContract
   这是模块的对外承诺：如果 QueryPlan 中的全部 token 都能在索引中找到，则返回的片段必须至少覆盖所有 token；如果存在无法命中的 token，则结果集为空；如果多个片段都满足，按字段权重和版本号排序。该契约是测试用例的设计基准。

## 设计决策与取舍

1. 精确匹配优先，前缀与字串作为受控扩展
   title 和 tags 必须走精确匹配。keywords 允许精确匹配加同义词映射。body 在默认模式下只匹配完整 token；开启 `prefix` 参数时才允许前缀命中。子串匹配默认关闭，因为子串会引入大量误召回，例如查询 `pi` 会命中所有含 `pi` 的英文单词。

2. 分词策略：中文与代码标识符分开处理
   中文正文使用词典分词，并保留 keywords 中的完整中文短语作为独立 token。代码标识符采用下划线、连字符、大小写边界拆分，例如 `createAgentSession` 拆成 `create`、`Agent`、`Session`、`createAgentSession`。这样可以兼顾字面召回和片段召回。

3. 字段权重写入 schema，不隐藏在代码常量里
   title 权重为 5，tag 为 3，keyword 为 3，body 为 1。这些数字写入 `retrieval.schema.json`，在测试和度量中可引用。权重不是魔法数，而是可验证的公开参数。如果业务要求错误码在 body 中也要优先，可以单独为 body 中的错误码模式提升权重。

4. 布尔逻辑：默认 AND，小查询更严格
   当 QueryPlan 中的 token 数量不超过 3 个时，默认使用 AND，所有 token 必须同时出现。超过 3 个时，允许使用 OR，但设置 `minMatch` 为 `ceil(tokenCount * 0.75)`，避免过度召回。这个阈值也写入 schema，便于调整。

5. 索引更新与查询读快照分离
   本地文件知识库在 `watch` 文件变化时异步重建索引。查询线程始终读取上一版本的不可变快照。这样更新延迟通常在 5 秒以内，但不会让查询看到半写状态的索引。重建失败时保留旧快照，并记录错误事件。

## 可执行的实施流程

1. 扫描本地知识库，把 Markdown、TSDoc 注释、Swagger 片段和 README 解析为 DocumentFragment。
2. 对每一篇文档做规范化：全角转半角、统一小写、去除首尾空白、剔除中文停用词、保留代码块中的标识符不被停用词破坏。
3. 构建倒排索引，把每个 token 映射到 Posting 列表，并为 title、tag、keyword、body 分别打标。
4. 实现查询解析器，生成 QueryPlan，识别未知 token，解析字段过滤如 `tag:pi`。
5. 实现匹配算法，先按字段权重计算基础分，再按 token 覆盖率和版本号做二次排序。
6. 封装 HTTP 或 SSE 路由，返回 JSON 数组，包含 Match 对象与未知 token 提示。
7. 编写测试套件，覆盖正向命中、大小写边界、标签过滤、无证据拒答、多 token AND、OR 阈值等场景。
8. 接入可观测性：记录查询延迟、token 覆盖率、索引新鲜度、首条命中率、误召回率。

## 输入、处理与输出示例

下面是一个贴近 TypeScript 本地文件知识库的 JSON 示例。

{
  "fragments": [
    {
      "id": "packages/pi-agent/src/session.ts#createAgentSession",
      "title": "createAgentSession",
      "tags": ["pi", "session", "AgentSession"],
      "keywords": ["创建会话", "会话管理"],
      "body": "使用 createAgentSession() 和 ModelRuntime 创建一次 Agent 会话。",
      "source": "packages/pi-agent/src/session.ts",
      "version": "0.83.0"
    }
  ],
  "query": {
    "text": "创建会话",
    "filters": { "tags": ["pi"] },
    "mode": "literal"
  }
}

输入部分包括 title、tags、keywords 和 body。处理阶段先把 keywords 中的“创建会话”作为完整 token 加入索引，同时把 title 拆成 `createAgentSession`、`create`、`Agent`、`Session`。查询时把“创建会话”作为单一 token 在 keywords 中精确匹配。输出形如：

[
  {
    "fragmentId": "packages/pi-agent/src/session.ts#createAgentSession",
    "matchedTerms": ["创建会话"],
    "matchedFields": ["keyword"],
    "score": 3,
    "version": "0.83.0",
    "source": "packages/pi-agent/src/session.ts"
  }
]

该示例明确展示了字面检索的确定性：输入 token 在索引中存在，输出就命中；如果不存在，输出为空数组。

## 性能、质量和可观测性指标

1. 查询延迟 P50 与 P99
   在路由层用 histogram 记录从接收查询到返回结果的时间。目标 P50 低于 10 毫秒，P99 低于 50 毫秒，因为本地索引通常常驻内存。

2. 索引新鲜度
   计算 `max(file.mtime - index.mtime)`。如果超过 5 秒，则触发告警。该指标直接证明索引是否跟上了文件变更。

3. 术语覆盖率
   对每次查询统计 `queryTokens` 中有多少 token 在词库中存在。目标覆盖率为 100% 时命中；低于 100% 时结果为空，并提示未知 token。

4. 首条命中率
   在测试集上运行固定查询，检查 top1 是否包含预期的 fragmentId。目标高于 95%，余下 5% 留给边界歧义。

5. 误召回率
   随机抽取 100 条查询，人工或自动判断 top-K 中是否包含不相关片段。目标低于 5%，超过阈值时检查 OR 阈值和权重设置。

## 失败模式、诊断证据与恢复动作

1. 关键词未命中
   诊断证据：术语覆盖率显示为 0，但文档中确实存在类似词。常见原因是分词把中文词拆错或全角半角不一致。恢复动作：把目标词加入 keywords 或用户自定义词典，并重新规范化。

2. 版本漂移导致索引陈旧
   诊断证据：索引新鲜度超过阈值，返回的 fragment 版本号与文件头不一致。恢复动作：强制重建索引，并检查文件 watcher 是否遗漏事件。

3. 过度召回
   诊断证据：误召回率高于 5%，top-K 中出现大量只有单个 body token 命中的片段。恢复动作：降低 body 权重、提高 minMatch 阈值、对短 token 加入停用词。

4. 分词切错代码标识符
   诊断证据：查询 `AgentSession` 返回了包含 `Agent` 和 `Session` 但不含 `AgentSession` 的无关片段。恢复动作：在分词前保留完整驼峰标识符作为独立 token，避免被拆分。

5. 并发更新导致索引损坏
   诊断证据：查询抛出异常或返回空数组，日志中显示索引段文件不完整。恢复动作：实现写入快照与查询快照隔离，失败时自动回滚到上一个有效快照。

## 问答测试样例

1. 正向问题：查询“createAgentSession”
   期望：返回 `packages/pi-agent/src/session.ts#createAgentSession`，命中字段为 title。

2. 中文正向问题：查询“创建会话”
   期望：返回同一 fragment，命中字段为 keywords。

3. 标签过滤：查询“session”并附加 `tag:pi`
   期望：返回 pi 相关 session 文档；如果存在其他项目中的 `session` 文档，则不应出现在结果中。

4. 大小写边界：查询“CreateAgentSession”
   期望：在规范化后命中，因为代码标识符统一小写；如果业务要求大小写敏感，则 schema 中需单独声明 `caseSensitive` 字段。

5. 无证据拒答：查询“rocket engine”
   期望：返回空数组，并在响应中标记“rocket”和“engine”为未知 token，不允许生成任何虚构内容。

6. 多 token AND：查询“createAgentSession ModelRuntime”
   期望：返回同时包含这两个 token 的片段；如果 body 中只有其中一个，则不应返回，因为默认 AND 模式下要求两个 token 都出现。

## 维护、版本、来源与相邻主题

维护工作的核心是保证索引与本地文件一致。每次发布新版本时，必须更新 schema 中的版本号，并重新运行全量索引构建。建议把 schema 版本和索引版本分开：schema 版本描述权重和布尔规则，索引版本描述数据生成时间。

来源信息必须保留在 Match 中，这样 Agent 引用时可以给出文件路径和锚点。不要把来源路径丢失，否则结果无法被下游验证。

字面检索与相邻主题的关系需要明确。它不是语义检索的替代品，而是语义检索的前置或并行车道。在混合架构中，字面检索负责高置信度的精确召回，语义检索负责同义词和改写。重排序层再把两路结果合并。如果只有语义检索，API 名称的拼写错误会导致无法召回；如果只有字面检索，用户用口语描述时会失败。

## 结论

事实层面：字面检索通过 title、tags、keywords 和 body 中的精确 token 建立召回；DocumentFragment、InvertedIndex、QueryPlan 和 RecallContract 是构成这一层的基础数据结构；字段权重和布尔规则写入 schema 后可以测试和复现。

推论层面：在 TypeScript 本地知识库场景下，这种方法对代码名称、版本号、错误码和配置键名非常有效；它应当与语义检索组合使用，而不是单独承担全部召回任务。

未知层面：中文长文档的最佳分词策略、停用词集合与领域词典需要持续调优；不同业务下字段权重的最优值无法事先给出，必须依赖测试集上的指标迭代；用户查询中的口语化改写与字面 token 之间的鸿沟，仍然需要语义检索或同义词表来弥合。
