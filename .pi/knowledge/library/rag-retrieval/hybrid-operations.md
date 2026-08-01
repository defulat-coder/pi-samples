---
type: concept
title: 混合检索：验证与运维视角
description: 从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。将字面命中与语义命中融合，避免单一检索方式的盲区
resource: .pi/knowledge/library/rag-retrieval/hybrid-operations.md
tags: [Pi, Agent, Kimi, 知识库, rag-retrieval, hybrid, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: rag-retrieval
topic: hybrid
variant: operations
---

# 混合检索：在字面命中与语义命中之间建立可验证的融合层

## 摘要与问题边界

混合检索（Hybrid Retrieval）在 RAG 召回层同时调用稀疏字面检索与稠密向量检索，将两路结果经归一化与融合函数重排后输出候选文档块。它解决的是“召回盲区”问题：当用户用口语化、同义改写或描述性语句查询时，BM25 可能因词形不匹配而漏报；当查询包含精确版本号、包名、文件路径或代码标识符时，向量嵌入可能因语义粒度偏粗而漏报。本视角以本项目本地文件知识库为边界，主要覆盖 Markdown 文档、TypeScript 源码与配置文件；Web 层通过 SSE 向浏览器返回流式结果，但检索逻辑运行在 API 进程内，不暴露任何密钥或嵌入模型细节。混合检索不保证答案正确，也不处理模型生成阶段的幻觉；对于未纳入索引的目录（如 node_modules、dist、外部链接）以及超出知识库时间范围的内容，系统应明确标记为无证据。

## 核心概念与数据模型

1. 查询对象（Query）：包含原始文本、经规范化分词后的 token 列表、可选的域过滤标签（如 `apps/api`、`packages/pi-agent`、`.pi/knowledge`），以及查询标识 `queryId`，用于整条证据链追溯。
2. 稀疏索引（Sparse Index）：基于子词分词构建倒排表，覆盖 Markdown 正文、代码标识符（类名、函数名、导入路径）和包名；记录 `term → 文档列表` 及位置信息，支持驼峰拆分与同义词映射。
3. 稠密索引（Dense Index）：由本地嵌入模型将文档块编码为 `float[]` 向量，每个向量附原文件路径、起始行号、块序号和模型版本 `model_version`；块大小默认 384 个 token，重叠 64 个 token。
4. 检索候选（Candidate）：BM25 输出 `{docId, rawScore, matchedTerms, positions}`；向量输出 `{docId, chunkIndex, rawScore, vector}`；两者均携带来源标签 `source`。
5. 归一化层（Normalization）：对每路分别计算 min-max 或排序倒数（RRF），将 `rawScore` 映射到 `[0,1]` 区间；同一查询内独立归一化，避免跨查询分数漂移。
6. 融合排名（Fusion）：采用加权求和 `score_fused = w_s × score_sparse + w_v × score_dense`，或 RRF 公式；输出列表保留两路原始分数与来源，便于后续审计。
7. 证据日志（Evidence Log）：记录每一路的 top-k、归一化参数、权重、最终排序、是否触发降级，以及查询耗时；是性能、质量与故障恢复的唯一可验证来源。

## 设计决策与取舍

### 稀疏索引：子词分词与 posting 体积的权衡
选择子词分词处理 TypeScript 驼峰标识符，例如 `SessionManager` 拆为 `Session`、`Manager`、`sessionManager`，提升代码检索召回率。代价是倒排表 posting 数量增加，重建索引耗时上升；在普通 Markdown 文本中，标准空格分词已足够，无需启用子词拆分。

### 稠密索引：块大小与上下文完整性的权衡
384 token 的块上限在多数 Markdown 段落内可保留完整语义，但对长函数或类定义可能出现截断。设置 64 token 重叠可降低边界语义损失，却使向量存储量上升约 15%。若代码块被截断，向量命中可能只返回半段逻辑，需要运维时检查切分边界。

### 分数归一化：min-max 与 RRF 的分布敏感性
min-max 对极端分数敏感，若某一路返回的 top-1 分数远高于其他候选，则归一化后次要候选会被压缩。RRF 对绝对分数不敏感，但无法表达“高置信命中”与“勉强命中”之间的差异；运维中应同时记录 `rawScore` 分布，而不是只看归一化后的值。

### 融合权重：默认 0.4/0.6 但不可凭单次请求调优
默认 BM25 权重 0.4、向量权重 0.6，适用于本仓库以自然语言提问为主的场景。权重调整必须依赖离线评估集（≥30 条标注查询），不能因一次在线请求失败就临时改权重，否则无法复现结果。

### 重排序：可选的延迟换精度
交叉编码器重排可进一步提升 top-5 精度，但通常增加 50–200 ms 延迟。在 SSE 实时交互中默认关闭；仅离线批量评估或异步任务中启用，启用后必须单独监控 P99 延迟。

### 降级策略：超时或失败时回归单路
任一索引文件损坏、embedding 服务超时或内存不足，系统应降级为另一路独立返回，并标记 `fallback=true`。降级期间不融合，避免用不完整结果做虚假重排。

## 可执行的实施流程

1. 建立文件扫描器：递归读取项目内 `.md`、`.ts`、`.json` 等文件，排除 `node_modules`、`dist`、`.git`、`.pi/skills` 的第三方技能文件。
2. 文档切分：Markdown 按二级标题切分，TypeScript 按函数或类边界切分；超过 384 token 的块再按句子边界二次切分。
3. 构建稀疏索引：生成分词、停用词、同义词映射，写入倒排表与 term 字典，并记录 checksum。
4. 构建稠密索引：加载本地嵌入模型，批量编码文档块，输出 float32 向量数组与元数据文件，标注 `model_version`。
5. 实现查询分词：对查询做子词分词、小写、同义词扩展，生成 BM25 检索输入。
6. 实现向量检索：将查询编码为向量，执行近似最近邻搜索，返回 top-k 候选。
7. 实现融合与日志：对两路结果归一化、加权求和，输出最终候选并写入 evidence log。
8. 灰度与回滚：对同一批查询同时跑旧版与新版索引，对比 recall@5、来源占比、P99 延迟；异常时切回旧版索引。

## 本地文件知识库示例

    输入
      query: "pnpm typecheck 报类型错误"
      filter: ["packages/pi-agent"]
      sparse_top_k: 20
      dense_top_k: 20
      weights: {bm25: 0.4, vector: 0.6}
    处理
      BM25 命中：packages/pi-agent/src/session.ts，匹配词 typecheck、type
      向量命中：docs/pi-agent-learning.md，语义接近 "type error"
      归一化：BM25 rawScore 0.80 -> 0.80；vector rawScore 0.72 -> 0.72
      融合：0.4 * 0.80 + 0.6 * 0.72 = 0.752
    输出
      candidate 1: {id: session.ts, path: packages/pi-agent/src/session.ts, sources: [bm25, vector], fusedScore: 0.752}
      candidate 2: {id: docs-pi-agent-learning, path: docs/pi-agent-learning.md, sources: [vector], fusedScore: 0.72}
      evidence: {queryId: q-1001, sparseCandidates: 20, denseCandidates: 20, normalization: min-max, fallback: false, latencyMs: 142}

该示例的输入来自 Web 前端通过 SSE 发送的检索请求；处理在 API 进程内完成，浏览器只拿到候选列表与 evidence 元数据；输出可用于 Agent 的上下文拼接，也可单独用于调试命中来源。

## 性能、质量与可观测性指标

1. 双路 P99 检索延迟：从请求进入 API 到融合完成返回的时间；目标 < 200 ms；使用 histogram 按路径分桶，便于定位是哪一路变慢。
2. 每路空结果率：分别统计 sparse 和 dense 返回 0 条或 < 5 条的查询占比；任一指标连续 1 小时 > 10% 即触发告警。
3. 离线召回指标：使用 ≥30 条人工标注的查询集，计算 recall@5 与 MRR；每两周运行一次，并在版本升级前后强制跑测。
4. 融合来源占比：最终 top-5 中仅 BM25、仅向量、两路共同命中的数量占比；若“仅向量”占比连续 > 80%，应检查 BM25 是否被停用词或分词问题削弱。
5. 分数分布漂移：记录归一化后 dense 分数的均值与方差；相对前一周漂移 > 20% 时，提示模型版本或文档分布发生变化。
6. 降级与失败率：记录 fallback、超时、索引文件缺失、embedding 失败的比例；目标 < 1%，超过 5% 时启动回滚。

## 失败模式、诊断证据与恢复动作

1. 向量索引漂移：证据为 dense 分数均值连续下降、同一查询返回结果明显不同；恢复动作是触发全量重编码，并临时将权重偏向 BM25 直至验证通过。
2. BM25 倒排表损坏：证据为索引文件大小异常、查询任意常见词返回空或结果顺序错乱；恢复动作是停止服务写入，重建索引并校验 checksum，重建完成前切换为纯向量检索。
3. 查询分词后全为停用词：证据为日志 `sparseCandidates=0`；恢复动作是保留 dense 结果，此时 BM25 权重视为 0，不强制融合。
4. Embedding 服务超时或 OOM：证据为 P99 dense 延迟陡增、出现错误码或内存告警；恢复动作是限流、减小 batch size，必要时 fallback 到 BM25，并排查模型版本或 GPU/CPU 资源。
5. 融合权重失衡：证据为 top-5 全部来自单一来源；恢复动作是回查离线评估指标，若 BM25 recall 严重下降则修复分词或权重，而非临时调整。
6. 文档切分边界错误：证据为用户反馈命中段落上下文不连贯、代码片段被截断；恢复动作是调整切分正则与 overlap，重新建索引并对比评估集。
7. 模型版本与索引不一致：证据为 `model_version` 字段不匹配；恢复动作是拒绝启动检索，强制重编码对应版本。

## 问答测试样例

1. 正向：问 “`pnpm dev` 如何同时启动 Web 和 API？” 应命中 `apps/api` 与 `apps/web` 相关文档，并给出 `pnpm dev` 命令与职责边界。
2. 正向：问 “AgentSession 的订阅与 prompt 调用顺序是什么？” 应命中 `packages/pi-agent` 源码与 `AGENTS.md` 中 “Subscribe before calling `session.prompt()`” 的具体描述。
3. 边界：问 “`@earendil-works/pi-coding-agent` 0.83.0 的官方示例路径？” 若 `node_modules` 未纳入索引，应回答该目录不在本地知识库范围内，不返回猜测路径。
4. 边界：问 “`thinking_level` 的默认值是多少？” 若配置中未明确写入，应回答 “当前可观察的默认行为是……”，并在无证据处标注不确定。
5. 拒答：问 “Node.js 22 的发布日期是哪天？” 本地知识库无此信息，应回答未检索到相关证据，不杜撰日期。
6. 拒答：问 “如何让 Pi 直接调用 shell 执行命令？” 项目中仅暴露 `read` 与 `search_knowledge`，应回答当前工具集不包含 shell 调用能力，并引用 `AGENTS.md` 的能力边界说明。
7. 边界：问 “`pnpm-lock.yaml` 是否必须提交？” 应基于 `AGENTS.md` “keep pnpm-lock.yaml in sync” 的条款回答，不得引入其他包管理器的规范。
8. 正向：问 “`search_knowledge` 与 `read` 工具的区别是什么？” 应命中 `.pi/knowledge` 与 `AGENTS.md` 中关于 read-only 与 custom tool 的说明。

## 维护、版本、来源与相邻主题

- 索引版本管理：稀疏索引采用 schema 版本号（如 `v1`），稠密索引采用 `model_version` 与 `chunk_size` 联合标识；升级 embedding 模型时必须全量重编码，旧版本保留 30 天以便快速回滚。
- 重建窗口：稀疏索引重建通常在 5 分钟内完成，稠密索引重建时间取决于模型与文档量，应在低峰期执行并通过灰度查询验证 recall 不衰减。
- 来源说明：本文设计基于本项目的本地知识库（`docs`、`apps`、`packages`、`.pi/knowledge`、`AGENTS.md`）以及 `@earendil-works/pi-coding-agent` 的 SDK 边界，未访问任何外部系统或实时网络资源。
- 与相邻主题的关系：混合检索依赖 “稀疏检索” 的倒排表与 “稠密检索” 的向量索引；可与 “重排序” 组合使用；其输出通常进入 “上下文注入” 或 “Agent 工具定义” 阶段；与 “提示工程” 互不替代，只决定哪些段落进入上下文。
- 配置审计：所有权重、top-k、chunk_size、overlap 应在版本控制中记录，任何变更需附带离线评估指标对比。

## 结论

**事实**：本项目是 pnpm 管理的 TypeScript monorepo；混合检索由 BM25 稀疏字面检索与稠密向量检索两路组成；API 仅暴露 `read` 与 `search_knowledge` 两个只读工具，`AGENTS.md` 明确要求保持 `pnpm-lock.yaml` 同步。

**推论**：在本仓库的 Markdown 与 TypeScript 混合场景中，BM25 更擅长召回精确的符号、版本号与文件路径，向量更擅长召回自然语言描述与概念同义改写；默认权重 0.4/0.6 可在常见查询模式下降低单路盲区，但需通过离线评估确认。

**未知**：混合检索能在多大程度上降低下游生成模型的幻觉率，必须通过标注测试集与 A/B 对比量化；未来 embedding 模型升级后对本仓库中英文混合查询的归一化影响尚未实测；Rerank 引入后的延迟与精度 trade-off 也需在真实 SSE 流量中验证。
