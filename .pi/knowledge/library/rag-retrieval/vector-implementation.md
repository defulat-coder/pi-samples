---
type: concept
title: 向量检索：实现视角
description: 从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。在需要语义相似时引入 embedding，并记录模型与版本
resource: .pi/knowledge/library/rag-retrieval/vector-implementation.md
tags: [Pi, Agent, Kimi, 知识库, rag-retrieval, vector, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: rag-retrieval
topic: vector
variant: implementation
---

# 向量检索：在 RAG 中按语义相似度召回并强制记录 embedding 模型与版本

## 摘要与问题边界

向量检索解决的是“意思相近但用词不同”的召回问题，而非精确字符串匹配。它把文本映射成稠密向量，在向量空间中计算相似度，返回语义最接近的文档片段。本文聚焦在 TypeScript 项目中落地该能力，范围包括：文档分块、embedding 模型选择与版本锁定、向量索引构建、查询向量化、top-k 召回、元数据过滤、重排序，以及把模型与版本作为可验证字段写入每次检索。不讨论大语言模型生成策略、训练 embedding 模型，也不把纯关键词检索作为同等方案展开。

## 核心概念与数据模型

1. **文档片段（Chunk）**
   最小可召回单元，字段至少包含：`id`（UUID）、`content`（原始文本）、`source`（文件路径与起止行号）、`embedding`（向量与模型签名）、`indexedAt`（时间戳）。`content` 不得超过当前模型的最大 token，否则必须在分块阶段截断并记录。

2. **Embedding 模型签名**
   每个向量必须绑定 `modelId` + `version` + `dimension` + `metric`。例如 `text-embedding-3-small/v2/1536/cosine`。查询时若发现签名与索引不一致，必须拒绝检索而不是静默降级。

3. **索引片段元数据（Index Segment）**
   一个索引文件或表要记录：`segmentId`、`embeddingSignature`、`distanceAlgorithm`、`chunkCount`、`lastBuildAt`、`indexParams`（如 HNSW 的 `M` 和 `efConstruction`）。版本升级时必须重建，不能混用不同签名。

4. **查询向量记录（Query Vector Log）**
   每次查询保存：`rawQuery`、`normalizedQuery`、`embeddingSignature`、`vector`（可选，视隐私要求）、`topK`、`filter`、`latencyMs`。用于事后排查为什么某次召回失败。

5. **召回结果信封（Result Envelope）**
   返回给下游的字段：`chunkId`、`score`、`rank`、`distanceMetric`、`embeddingModelVersion`、`contentExcerpt`。`score` 必须附带 `metric` 说明，否则下游无法判断阈值。

6. **版本兼容性矩阵**
   在配置中维护一张表：哪些 `modelId/version` 可以共存于同一个混合索引；默认策略是“同模型同版本才能互相比较”。不同签名之间禁止做近似搜索。

## 设计决策与取舍

### 索引与查询必须使用同一模型版本
这是向量检索正确性的前提。不同版本的 embedding 模型可能把同义词映射到不同超平面，score 失去意义。取舍：模型升级需要全量重建索引，成本高于关键词索引，但换来语义一致性。

### 距离度量取决于向量是否归一化
如果模型输出已经是单位向量，使用 `cosine` 等价于 `dot product`，且更直观。如果未归一化，优先使用 `dot product` 或 `cosine` 归一化后再计算。`euclidean` 只在“向量长度本身携带语义信息”时才考虑，否则不建议默认使用。

### 向量数据库的选择边界
本地文件知识库（<10 万段）可先用 `brute-force` 或 `hnswlib` 在 Node 进程内加载；超过 50 万段或需要并发写入，再引入 `pgvector`、`LanceDB` 或 `Milvus`。不要为简单 Demo 引入网络依赖。

### 分块策略以 token 为准，而非字符数
中文按字符切分会低估 token 数。应使用与 embedding 模型配套的 tokenizer 计算 token，设定 `maxTokens` 并保留 `overlapTokens`（通常 10%–15%），避免上下文在边界处断裂。

### 元数据过滤放在向量搜索前还是后
精确元数据（如 `project`、`language`）必须先在数据库层过滤，减少候选集；语义阈值过滤（如 `score < 0.3`）放在搜索后。把后过滤的阈值前移到数据库层会导致召回率不可解释。

## 可执行的实施流程

1. **盘点现有文档**
   列出所有需要入库的文件、更新频率、平均长度，确定是否需要增量更新。

2. **定义 Chunk 类型与校验**
   用 Zod 或 TypeScript 接口定义 `ChunkRecord`，要求 `embedding` 字段包含 `modelId`、`version`、`dimension`、`metric`。

3. **锁定模型与版本**
   把模型 ID、版本、维度、距离度量写入 `EMBEDDING_MANIFEST`，并在 CI 中校验该文件是否被手动修改。

4. **实现基于 tokenizer 的分块器**
   根据模型 tokenizer 切分文本，保证每段 `tokens <= maxTokens`，`overlap` 按 token 数设置，而不是按字符数。

5. **生成 embedding 并写入模型签名**
   调用 embedding 服务时，同步返回 `modelId`、`version`；与 `EMBEDDING_MANIFEST` 比对，不一致时立即抛错。

6. **构建向量索引并保存 segment 元数据**
   把向量写入存储，同时写入 `IndexSegment` 元数据；记录构建耗时、chunk 数量、索引参数。

7. **实现查询路径的版本检查**
   查询前用同一 manifest 对查询做 embedding；检索前比较 `queryEmbeddingSignature` 与 `indexSegment.signature`，不一致则返回 `INCOMPATIBLE_MODEL_VERSION` 错误。

8. **增加召回后重排序与可观测性**
   对 top-k 结果做 cross-encoder 或规则重排；记录 `recall@k`、`latency`、`mismatch` 等指标，并运行问答测试样例回归。

## 示例：输入、处理、输出

以下是一个可在 Node 本地文件知识库中使用的类型声明与索引清单示例：

    interface ChunkRecord {
      id: string;
      content: string;
      source: { path: string; lineStart: number; lineEnd: number };
      embedding: {
        modelId: string;
        version: string;
        vector: number[];
        dimension: number;
        metric: "cosine" | "dot" | "euclidean";
      };
      indexedAt: string;
    }

    const EMBEDDING_MANIFEST = {
      indexVersion: "2024-06-v3",
      modelId: "text-embedding-3-small",
      version: "2",
      dimension: 1536,
      metric: "cosine",
      chunker: { maxTokens: 512, overlapTokens: 50 }
    };

输入是一段 Markdown 技术文档。处理阶段先按 tokenizer 切成多段，每段调用模型生成 1536 维向量，并把 `modelId`、`version`、`metric` 写回 `ChunkRecord`。输出是带有签名的向量记录集合，以及一份 `IndexSegment` 元数据，后续查询向量必须与其签名一致。

## 性能、质量和可观测性指标

1. **向量生成延迟 P50/P99**
   测量从原始文本到返回向量所需时间，包括网络/本地推理。目标：P50 < 200 ms，P99 < 1000 ms（取决于模型大小）。

2. **召回率 Recall@k**
   使用人工标注的问答对，检查正确答案是否出现在前 k 个结果中。计算 `命中次数 / 总提问数`，目标 ≥ 80% 后再优化 P@k。

3. **平均倒数排名 MRR**
   取第一个正确结果的倒数排名均值。MRR 对排序质量敏感，比 Recall@k 更能反映头部体验。

4. **模型版本不匹配率**
   统计查询/索引签名不一致的次数。正常值应为 0；任何非 0 都说明构建或部署流程出错。

5. **答案 groundedness 得分**
   对检索结果与生成长度计算“生成内容中有多少 token 能在检索结果中找到依据”。低得分可能意味着检索缺失或生成幻觉。

## 失败模式

1. **模型版本不一致**
   诊断证据：日志出现 `queryEmbeddingSignature` 与 `indexSegment.signature` 不同；或 `ChunkRecord.embedding.version` 与 `EMBEDDING_MANIFEST.version` 不同。恢复：拒绝该查询，重建索引，更新 manifest。

2. **分块 token 超限导致截断**
   诊断证据：向量服务端返回 `input truncated` 或记录中 `contentTokenCount > maxTokens`。恢复：缩小 `maxTokens`、增加重叠、重新切分并重新生成向量。

3. **索引未同步更新**
   诊断证据：查询返回的 chunk 内容已被源文件修改，但 `indexedAt` 早于文件 `mtime`，或 `segment.lastBuildAt` 滞后。恢复：触发增量重建该 segment。

4. **距离度量配置错误**
   诊断证据：score 排序与人工判断明显相反，或 `metric` 字段与向量归一化状态不匹配（例如未归一化却用 cosine）。恢复：统一度量，必要时对向量做 L2 归一化。

5. **查询与语料域偏移**
   诊断证据：top-k 结果 score 均低于阈值，且元数据过滤后无匹配；日志显示查询词汇在语料中几乎无共现。恢复：返回无结果，不编造答案；必要时扩展语料或启用 fallback 检索策略。

## 问答测试样例

1. **正向问题**：如何设置中文技术文档的 chunk overlap？
   期望答案：按 tokenizer 计算，通常取 `maxTokens` 的 10%–15%，本例中为 50 tokens。

2. **正向问题**：查询向量化失败时应该返回什么？
   期望答案：返回 `EMBEDDING_ERROR` 事件，不进入检索阶段。

3. **边界问题**：如果索引使用 `text-embedding-3-small/v2`，查询使用 `text-embedding-3-small/v3` 能否继续？
   期望答案：不能。版本不同视为签名不一致，必须返回 `INCOMPATIBLE_MODEL_VERSION` 错误。

4. **边界问题**：未归一化向量使用 cosine 距离是否安全？
   期望答案：不安全，会丢失长度信息；应先归一化或改用 dot product。

5. **无证据拒答**：当前索引中没有 Java 内容，用户问“如何用 Java 实现？”
   拒答条件：top-k 最低分低于阈值，且无 `language: java` 元数据命中；系统应回答“未在知识库中找到相关依据”。

6. **无证据拒答**：用户问“这个项目的 LLM 选择是什么？”但文档只讨论 embedding 检索。
   拒答条件：检索结果与问题语义距离低，且未命中 `LLM` 相关标签；系统应拒绝推断。

## 维护、版本、来源与相邻主题的关系

维护的首要动作是：任何 embedding 模型或版本变更都视为“破坏性变更”，必须触发全量重建。来源字段（`source.path`、`lineStart`、`lineEnd`、`indexedAt`）必须精确到可验证，方便用户回溯原文。索引文件旁边应保留 `manifest.json` 与 `build.log`，记录构建时间、模型签名、chunk 数量、构建耗时。

向量检索与相邻主题的关系：
- 与 **全文检索**互补，关键词匹配适合精确术语，向量检索适合语义相似；
- 与 **重排序（rerank）** 是上下游，向量检索负责粗排，rerank 负责精排；
- 与 **生成** 是供给关系，检索结果作为上下文输入，本身不保证答案正确；
- 与 **embedding 微调** 无关，本方案默认使用预训练模型，不修改权重。

## 结论

事实：向量检索把文本映射为稠密向量，通过距离度量在索引中召回语义相近片段；同一索引内的所有向量和查询必须使用完全一致的 `modelId`/`version`/`metric`；分块应基于模型 tokenizer 而非字符数；每次检索结果必须记录模型版本和 score 度量。

推论：在 10 万段以下的本地 TypeScript 知识库中，使用内存或 SQLite 扩展即可满足延迟要求；使用元数据预过滤能显著降低候选集，提升召回稳定性；把模型版本作为签名字段写入每次 embedding 是避免静默错误的有效设计。

未知：具体业务场景下最优的 `maxTokens`、重叠比例、top-k 大小和阈值需要依赖真实问答对实验；不同 embedding 模型在垂直领域（法律、医疗、代码）的召回率差异无法仅通过理论推导得出，必须通过标注数据集测量。
