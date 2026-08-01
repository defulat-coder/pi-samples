---
type: concept
title: 分块策略：实现视角
description: 从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。在保持上下文完整的同时控制片段大小和上下文成本
resource: .pi/knowledge/library/rag-retrieval/chunking-implementation.md
tags: [Pi, Agent, Kimi, 知识库, rag-retrieval, chunking, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: rag-retrieval
topic: chunking
variant: implementation
---

# 分块策略：在 RAG 中保持上下文完整并控制片段大小与成本（实现视角）

## 摘要与问题边界

在 TypeScript/Web 本地文件知识库中，分块策略决定检索器能否召回完整上下文、嵌入成本是否可控、LLM 答案是否可溯源。本文聚焦文件到 chunk 的输入、输出、错误路径、生命周期与验证，范围限定为 Markdown/文本/HTML 本地文档，由 Node.js 服务端离线切分，Web 客户端仅消费检索结果。

## 核心概念与数据模型

1. 原始文档单元（DocumentUnit）：输入文件或目录项，携带 `sourcePath`、`mimeType`、`contentHash`、`schemaVersion`，用于校验与增量更新。
2. 分块单元（Chunk）：最小检索单元，含 `chunkId`、`parentDocId`、`text`、`tokenCount`、`boundaryType`、`startLine`、`endLine`、`overlapPrevId`。
3. 边界标记（BoundaryMarker）：决定切割位置的结构，如 Markdown 标题、段落、表格、代码块围栏。由解析器显式输出，不依赖纯文本正则。
4. 重叠窗口（OverlapWindow）：相邻 chunk 共享的 token，用于保留跨边界指代。重叠量基于 tokenizer 计算并计入 chunk 大小。
5. 索引映射（IndexMapping）：记录 chunk 与父文档、章节、行号的关联表，用于检索时重组可引用上下文。
6. 成本函数（CostFunction）：以 token 计量 embedding 输入、向量存储、LLM 上下文与检索延迟，新策略上线前需测量 P95。

## 设计决策与取舍

### 大小上限：token 优先

统一使用项目 tokenizer 计量，避免字符与字节差异。设置 `maxChunkTokens` 并预留 10%–20% 余量，防止嵌入模型计数差异导致超支。

### 语义边界与固定窗口

按语义边界切分保留上下文但长度不均；固定窗口均匀却易切断句子。采用分层策略：优先按标题、段落、表格、代码块切分，超限后在语义单元内部二次切分，并标记 `boundaryType` 降级。

### 重叠比例

FAQ/API 文档取 10% 保留跨段指代；长叙事章节取 25% 保留代词与事件链。代价是嵌入成本线性增加，重叠 token 必须计入 chunk 自身大小。

### 上下文回装

命中 chunk 后，若需全局上下文，按相关性分数贪心扩展相邻 chunk 直到 `contextBudget` 耗尽。回装过多会挤占 LLM 上下文，过少则引用缺失。

### 元数据完整性

每个 chunk 必须携带 `sourcePath`、`startLine`、`endLine`、`parentDocId`、`chunkId`。写入前执行 schema 校验，缺失字段进入死信队列，不静默写入。

## 可执行的实施流程

1. 输入校验：接收文件或流，校验 `mimeType` 白名单，拒绝超过 `maxDocTokens` 的输入，记录 `contentHash`。
2. 结构解析：提取标题、段落、表格、代码块并标注行号。
3. 边界排序：按文档顺序生成 `boundaryList`。
4. 初次切分：以边界为锚点生成候选 chunk，不跨越语义边界。
5. 尺寸检查：用 tokenizer 计算 token 数，超 `maxChunkTokens` 者进入二次切分。
6. 重叠处理：复制前一块结尾 token 到当前块开头，更新 `overlapPrevId` 并计入大小。
7. 元数据校验：生成 id、记录行列范围，执行 schema 校验，失败写入死信。
8. 索引写入：同时写入稠密向量与稀疏索引（BM25），并保存 `IndexMapping`。
9. 在线检索：召回 top-k 后按 `contextBudget` 扩展相邻 chunk，装配后返回客户端。
10. 监控更新：记录 token 分布、解析错误、版本哈希，按 `contentHash` 增量更新。

## 本地文件知识库示例：输入、处理与输出

下面给出项目级配置核心字段，无外部系统依赖。

| 字段 | 输入值 | 处理规则 | 输出到索引 |
|---|---|---|---|
| `sourcePath` | `/docs/api.md` | 保留相对路径 | 引用来源 |
| `boundaryType` | `heading` / `paragraph` / `table` / `code-block` | 解析器按文档结构标记 | 元数据与过滤 |
| `text` | 段落或单元格文本 | tokenizer 切分，最大 256 tokens，超出二次切分 | 嵌入与 BM25 字段 |
| `maxChunkTokens` | `256` | 策略参数 | 索引配置 |
| `overlapTokens` | `32` | 前一块结尾复制 32 tokens 到当前块开头并计入大小 | 重叠上下文 |
| `chunkId` | 自动生成 | `parentDocId` + 边界序号 + 二次切分序号 | 主键 |
| `requiredMetadata` | `sourcePath, chunkId, parentDocId` | 写入前校验，缺失则死信 | 校验规则 |

输入为本地 Markdown 文件；处理阶段先解析结构，再 token 化切分并加重叠；输出为带完整元数据的 chunk 列表与索引配置。

## 性能、质量与可观测性指标

1. Chunk token 分布：测量 P50、P95、最大值，目标 P95 不超过 `maxChunkTokens` 的 90%。
2. 边界保留率：计算 `未截断语义边界数 / 总边界数`，目标 > 95%。
3. 嵌入成本：记录每千 token 嵌入耗时与调用次数，换算每百万 token 的 P95 延迟。
4. 检索准确率：在标注问答集上测量 Recall@5、Precision@5 与答案引用正确率。
5. 上下文压缩率：压缩率 = 原始文档 token 数 / 最终 LLM 上下文 token 数，反映成本控制效果。
6. 死信率：记录 schema 失败、解析异常、超上限 chunk 的占比，作为流程健康信号。

## 失败模式、诊断证据与恢复动作

1. 代码/表格被粗暴截断：证据为 `code-block` chunk 出现未闭合围栏；恢复是提升代码块与表格优先级，允许独立 chunk 或内部二次切分。
2. 重叠丢失导致跨边界问题无法回答：证据为 `overlapPrevId` 为空；恢复是检查重叠生成步骤，确保 token 计数正确。
3. 元数据缺失无法溯源：证据为死信队列出现 `missing sourcePath`；恢复是写入前强制 schema 校验。
4. Tokenizer 与嵌入模型口径不一致：证据为 `tokenCount` 与 embedding 服务报错长度不符；恢复是统一 tokenizer 或嵌入前再次截断。
5. 版本更新导致 chunk ID 漂移：证据为同一 `sourcePath` 的 `chunkId` 集合大规模变化；恢复是按 `contentHash` 增量更新，仅删除变更 chunk。
6. 文件编码异常导致解析失败：证据为 `EncodingError` 或 `ParseError`；恢复是前置编码检测，隔离异常文件并告警。

## 问答测试样例

1. 正向：Markdown 表格如何处理？ 回答引用 `boundaryType: table`，说明表格作为独立边界，超限按行二次切分。
2. 正向：每个 chunk 最大多少 token？ 回答给出 `maxChunkTokens: 256`。
3. 边界：段落刚好 257 tokens 怎么办？ 回答说明触发二次切分，`boundaryType` 降级为 `fixed-window`。
4. 边界：空标题会生成 chunk 吗？ 回答说明依据 `skipEmptyHeading` 跳过或合并到下一个段落。
5. 无证据：服务端使用的大模型是什么？ 若配置未记录，拒绝回答，说明不在知识库范围。
6. 无证据：每次查询嵌入成本多少美元？ 若未记录美元单价，拒绝回答，可给出 token 数与延迟，但不给出货币成本。

## 维护、版本、来源与相邻主题的关系

维护中必须版本化策略。配置保存 `schemaVersion` 与 `chunkingHash`（由策略参数和 tokenizer 版本哈希）。重建索引时，比较 `contentHash` 与 `chunkingHash`：仅文档内容变化则增量更新，策略变化则全量重建。

`sourcePath` 使用仓库相对路径，保证不同部署环境稳定。`startLine`/`endLine` 指向原始文件，Web 客户端可生成高亮链接。

与相邻主题关系：分块输出是嵌入模型输入，tokenizer 必须对齐；向量数据库负责存储检索，不保证语义边界；重排器优化顺序，分块质量影响其输入；提示压缩在 LLM 调用前进一步压缩，分块应先提供可控大小；在 Pi 项目中，分块由 API 端执行，Web 端仅消费 SSE 结果。

## 结论

事实：分块策略的输入是本地文件、边界标记与 tokenizer；输出是带 `chunkId`、`sourcePath`、`boundaryType`、`tokenCount` 和重叠关系的 chunk 列表；索引需同时保存稠密向量、稀疏索引与索引映射。

推论：在语义边界优先的前提下，采用“按标题/段落/表格/代码块初次切分、超限固定窗口二次切分、可控重叠”的层次策略，能够在大多数技术文档中实现 P95 token 低于上限 90% 且边界保留率高于 95%。

未知：不同嵌入模型对相同文本的实际 token 计数差异、长章节中 25% 重叠是否在所有语言体裁上优于 10%、以及 LLM 在特定领域对上下文压缩率的敏感阈值，仍需在具体项目数据上通过 A/B 测试与人工评估验证。
