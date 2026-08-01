---
type: concept
title: 重排序：实现视角
description: 从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。在候选集较小的情况下提高相关性，但控制额外模型延迟
resource: .pi/knowledge/library/rag-retrieval/rerank-implementation.md
tags: [Pi, Agent, Kimi, 知识库, rag-retrieval, rerank, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: rag-retrieval
topic: rerank
variant: implementation
---

# 重排序：在 RAG 检索候选集收紧阶段提升相关性并控制模型延迟

## 摘要与问题边界

重排序是 RAG 检索流程中的二阶段筛选器。第一阶段通过向量或关键词检索返回数量有限的候选文档，重排序器用额外的模型对查询与候选进行逐对或逐点打分，再按分数重新排序并截断输出。本文的实现视角聚焦于：在候选集已经很小的情况下，如何把重排序落成为 TypeScript 服务，同时把额外模型延迟控制在可接受范围内。

范围限定于二阶段排序模块，不包括第一阶段的索引构建、嵌入训练、查询改写，也不包括生成模型的事实校验。适用场景为本地文件知识库或 Web API，候选集大小通常设为 20 到 200 之间，端到端延迟预算通常介于 50 毫秒到 500 毫秒。如果延迟预算低于 50 毫秒，应直接跳过重排序，而不是压缩实现。

## 核心概念与数据模型

1. QueryEnvelope：输入必须包含查询字符串 query、可选 query_id、locale、max_query_len 和请求时间戳。校验规则是 query 非空且长度不超过 max_query_len，否则在调用模型前直接返回 VALIDATION 错误。
2. CandidateItem：每个候选必须包含 doc_id、content、first_stage_score、chunk_index 和 source_path。同一请求内 doc_id 必须唯一，content 必须非空，first_stage_score 必须为有限数值。
3. RerankConfig：包含 top_k_in、top_k_out、model_id、model_version、timeout_ms、max_batch_tokens、batch_size 和 fallback_policy。其中 fallback_policy 只能是 error、first_stage 或 empty 三者之一。
4. RerankResult：输出为有序列表，每个元素包含 doc_id、rank、score、latency_ms 和 tie_broken 标志。当候选数量大于等于 top_k_out 时，输出必须恰好包含 top_k_out 个元素；否则输出全部候选。
5. 生命周期状态：VALIDATE 校验、TOKENIZE 分词、BATCH 分桶、SCORE 打分、CHECK 输出校验、NORMALIZE 归一化、RANK 排序、EMIT 输出。每个状态都要产生带 query_id 和时间戳的事件。
6. ErrorRecord：包含 code、message、recoverable 和 stage 字段。错误码包括 VALIDATION、TIMEOUT、MODEL_ERROR、OUTPUT_MISMATCH 和 EMPTY_CANDIDATE。

## 设计决策与取舍

### 模型选型：交叉编码器与小型点态模型

交叉编码器通常把查询与候选拼接后输入分类模型，相关性更准，但每对都要单独前向传播。若候选集超过 100 或延迟预算低于 150 毫秒，应改用基于词频、BM25 余弦和向量余弦等特征的小型点态模型。本文默认假设本地 CPU 部署，模型参数量控制在 5000 万以内。

### 候选集大小由延迟预算反推

top_k_in 不能写死。实现时应先测量当前模型在目标硬件上的每令牌平均耗时，再用 timeout_ms 除以单次调用开销得到可接受的候选数。例外：如果第一阶段的召回率要求必须保留 300 个候选，而延迟只能容纳 50 个，则要么提高超时预算，要么放弃重排序。

### 分数校准与归一化

重排序器返回的原始分数只在同一次查询内可比。实现中必须按查询做 min-max 归一化，避免下游把不同查询的分数横向比较。只有当你用标注集做了温度缩放或 Platt 缩放后，才能把分数解释为概率；否则应把 score 当作排序值，不赋予概率语义。

### 平局处理必须可复现

当两个候选分数相等时，优先按 first_stage_score 降序，再按 doc_id 字典序。禁止随机或时间戳平局，否则相同查询多次调用结果不一致，缓存也会失效。tie_broken 标志要写入结果，便于审计。

### 失败回退策略显式化

fallback_policy 默认应为 first_stage，即模型失败时返回第一阶段排序，保证 Web 路径可用。error 策略只在需要严格避免脏数据的内部评估中使用。empty 策略返回空列表，仅用于调试或强制召回实验。

## 可执行实施流程

1. 接收请求体，校验 QueryEnvelope 和 RerankConfig：query 非空、候选数组非空、doc_id 无重复、fallback_policy 合法。任何校验失败直接返回 ErrorRecord，错误码 VALIDATION。
2. 检查每个候选 content 长度是否超过 max_input_len，若超过则记录截断计数。若截断后内容为空，则移除该候选并在日志中记录。
3. 计算输入哈希 input_hash，作为缓存键和追踪标识。哈希内容应包含 query、候选 doc_id 列表、model_version 和 schema_version。
4. 按 max_batch_tokens 把候选分桶。若单个候选超过限制，则拆分为更小的文本块或标记为错误。分桶后统计总批次数。
5. 并发调用重排序模型，但每次调用都要带 timeout_ms 和熔断器。记录每个批次的等待时间、执行时间和模型状态。
6. 收集分数后做输出校验：分数数量必须等于候选数量，每个分数必须是有限数值，不能出现 NaN 或 Infinity。若不符，返回错误码 OUTPUT_MISMATCH。
7. 将分数合并到候选记录，按查询做归一化，应用平局规则，按分数降序排序，截取前 top_k_out 个。
8. 构造 RerankResult，填充 rank、score、latency_ms、tie_broken 和 input_hash，同时发送生命周期事件。若任意步骤失败，按 fallback_policy 执行回退。

## 输入、处理与输出示例

POST /rerank 请求体示例：

{
  query: 如何在本地 Markdown 知识库中配置重排序,
  candidates: [
    { doc_id: docs/rag.md#3, content: 第一阶段检索返回小候选集... , first_stage_score: 0.72 },
    { doc_id: docs/rerank.md#1, content: 重排序器对候选逐一打分... , first_stage_score: 0.65 }
  ],
  config: {
    top_k_out: 5,
    model_id: cross-encoder-mini,
    model_version: 1.2.0,
    timeout_ms: 250,
    fallback_policy: first_stage
  }
}

处理过程：先校验 query 长度和候选 doc_id 唯一性，再计算 input_hash，按批次调用 cross-encoder-mini，得到两个候选的分数后归一化，若分数相同则按 first_stage_score 和 doc_id 字典序打破平局，最后截取 top 5。

响应体示例：

{
  results: [
    { doc_id: docs/rerank.md#1, rank: 1, score: 0.94, latency_ms: 42, tie_broken: false }
  ],
  error: null,
  fallback: false,
  input_hash: a1b2c3d4
}

## 性能、质量、可观测性指标

1. 端到端 P95 延迟：从请求接入到响应发出，按 model_id 和 top_k_in 分组。目标是不超过 timeout_ms 的 80%。
2. NDCG@5 与 MRR：在带人工标注的黄金查询集上，对比重排序后的结果与第一阶段基线，测量相对提升。
3. 回退率：每小时统计 fallback 次数，并按 error 码拆分。若回退率超过 1%，应触发告警。
4. 令牌吞吐率：计算模型实际执行时间内处理的输入令牌总数，用于判断 batch_size 是否合理。
5. 分数分布熵：若某次查询所有分数差异小于 1e-4，则标记为分数塌缩，并记录触发回退。

## 失败模式与恢复动作

1. 模型超时：证据为 TIMEOUT 错误码、latency_ms 达到 timeout_ms 且无任何分数返回。恢复动作为按 fallback_policy 回退，并累加熔断器计数；若连续超时率超过阈值，暂时短路重排序路径。
2. 输出数量不匹配：证据为返回分数数量与候选数量不一致。恢复动作为返回 OUTPUT_MISMATCH，并使用第一阶段排序作为回退，避免用零值或均值填充造成错误排序。
3. 分数塌缩：证据为所有分数标准差小于 1e-4。恢复动作为直接返回 first_stage_score 排序，并记录该查询为模型无效输出。
4. 输入包含重复 doc_id：证据为 VALIDATION 错误码并指出重复字段。恢复动作是在调用模型前返回 400，不向模型发送脏数据。
5. 模型版本漂移：证据为 config.model_version 与加载模型版本不一致，或 schema_version 不匹配。恢复动作为 fail-fast，拒绝调用，要求运维人员更新模型或升级 API 版本。

## 问答测试样例

1. 正向：重排序结果应包含哪些字段？答案必须包含 doc_id、rank、score、latency_ms 和 tie_broken。
2. 正向：候选集大小如何确定？答案应基于延迟预算和模型每令牌耗时，通常落在 20 到 200 之间。
3. 边界：候选集为空时应返回什么？答案应为空结果，错误码 EMPTY_CANDIDATE，且不应触发回退。
4. 边界：fallback_policy 为 error 且模型超时时返回什么？答案应为结果为空，ErrorRecord 错误码 TIMEOUT，recoverable 为 true。
5. 无证据：该模型是否支持中文？答案应为无法仅凭实现判断，需要检查 model_id 对应的 tokenizer 和训练语料。
6. 无证据：重排序能否消除生成幻觉？答案应为不能，本模块只改变候选顺序，不验证内容真实性。

## 维护、版本、来源与相邻主题

维护重点包括：model_version 和 schema_version 必须写入输出，便于回放和审计；每次模型升级都要重新运行黄金查询集并校准分数；缓存键必须同时包含 model_version 和 schema_version，防止版本漂移命中脏缓存。

代码来源通常包括四个模块：请求校验模块、候选提供模块、重排序客户端、回退与输出构造模块。相邻主题包括第一阶段检索（向量检索、BM25、混合搜索）、查询改写、结果融合、答案生成。重排序位于检索与生成之间，只负责排序，不生成文本，也不参与索引构建。

## 结论

事实：重排序接收固定大小的候选集，调用模型打分后重新排序并截断输出；额外模型调用必然引入延迟；输入校验和输出校验必须发生在模型调用前后；回退策略决定了失败时的行为。

推论：当候选集不超过 100、延迟预算不低于 150 毫秒且使用轻量交叉编码器时，重排序通常能在 NDCG@5 上取得可测量的提升；批次大小应随候选平均长度动态调整。

未知：某一特定业务场景下重排序是否值得引入，取决于具体查询分布、硬件能力和第一阶段的召回率；多语言或跨模态重排序的效果需要额外的领域验证，不在本文实现范围内。
