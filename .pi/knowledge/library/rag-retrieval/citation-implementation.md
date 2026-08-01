---
type: concept
title: 引用与证据：实现视角
description: 从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。让每个回答结论都能回指文件、片段和版本信息
resource: .pi/knowledge/library/rag-retrieval/citation-implementation.md
tags: [Pi, Agent, Kimi, 知识库, rag-retrieval, citation, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: rag-retrieval
topic: citation
variant: implementation
---

# RAG 中的引用与证据：让每次生成结论都能回指来源的实现方案

## 摘要与问题边界

在检索增强生成（RAG）系统里，模型输出的结论如果无法回指到具体文件、片段和版本，就会失去可验证性。本文聚焦“引用与证据”的工程实现：从原始文档入库、检索、生成、校验，到最终把可点击引用交给用户。讨论范围覆盖本地 Markdown/TypeScript/Web 技术栈，不涉及模型微调、权限治理或外部付费 API 的内部细节。核心目标是：任何一句回答，都能在保留完整上下文的前提下，被审计到“来自哪份文件、哪个块、哪个版本、哪个检索调用”。

## 核心概念与数据模型

1. **来源记录（SourceRecord）**：`{ docId, version, uri, mime, checksum, ingestTime }`。`checksum` 用 SHA-256 在字节层保证不可变；`version` 与文件系统时间戳或 Git commit hash 解耦，采用内容哈希或显式语义版本，确保后续复现时不会 silent drift。
2. **证据片段（EvidenceChunk）**：`{ chunkId, sourceId, byteRange, tokenRange, text, embeddingId }`。`byteRange` 用于回到原文高亮；`tokenRange` 用于语言模型上下文计费与截断。
3. **检索结果（RetrievedPassage）**：`{ query, chunkId, retrieverId, score, rank, retrievalTimestamp }`。必须保存查询原文与分数，因为同一问题在不同检索策略下可能得到不同证据。
4. **引用跨度（CitationSpan）**：`{ startOffset, endOffset, chunkIds, evidenceType, confidence }`。`evidenceType` 分为 `direct`（直接支持）、`indirect`（背景支撑）、`contradictory`（提示冲突）。置信度来自检索分数与验证器双重评估。
5. **证据包（EvidenceBundle）**：`{ answerId, spans, retrievedPassages, contextWindow, modelId, temperature }`。它是可持久化的审计单元，能完整还原一次回答的证据链。
6. **校验断言（Verdict）**：`{ spanId, method, status, details }`。`method` 包括精确匹配、语义相似度、关键词重叠；`status` 为 `supported`、`unsupported`、`needs_human_review`。
7. **带引用回答（AttributedAnswer）**：`{ text, citations, bundleId, unverifiedClaims, verdicts }`。`unverifiedClaims` 列出模型做出了断言但缺少证据的片段，供前端灰显或折叠。

## 设计决策与取舍

#### 行内引用与尾注列表的取舍

行内 `[c1]` 可读性高，适合短回答；尾注适合长文。实现上建议同时输出：模型侧用紧凑标记降低 token 消耗，前端再做二次渲染为带链接的角标。代价是解析器必须精确映射 `[c1]` 到 `EvidenceBundle` 里的 `chunkId`。

#### 分块粒度：句子、段落还是整页

句子级粒度引用最精确，但存储量与检索噪声大；段落级更稳定，适合 Markdown/Web 文档。推荐策略：按 Markdown 标题+段落分块，块之间保留一句重叠，遇到表格或代码块整体保留。这样每个 `byteRange` 都能对应到文档中的自然边界。

#### 版本固定与最新文档的矛盾

如果始终指向“最新版”，旧回答就会因文档更新而失效。实现上把 `version` 固定在 `SourceRecord` 中，查询时允许用户指定 `latest` 或某个 `version`，但 `EvidenceBundle` 必须记录实际使用的版本。版本不可用时前端应提示“原文已更新，请重新查询”。

#### 引用精度：块级还是文件级

块级引用能定位到具体段落；文件级引用在跨文件概述时更自然。实现上默认块级；当模型把多个同文件块合并成同一结论时，允许降级为文件级引用，但前端要展开显示所有相关块。

#### 自动化校验与人工复核的边界

高敏感场景（如安全规范、医疗、财务）不能全凭模型自评。实现上分两级：自动化校验先过滤明显失配；`needs_human_review` 状态进入待审队列，未审结论不在正式 UI 展示，或以低置信度标红展示。

## 可执行的实施流程

1. **文档解析与分块**：读取本地 Markdown/PDF/HTML，计算 SHA-256，生成 `SourceRecord`；按标题+段落分块，记录每个块的 `byteRange`。
2. **向量化与元数据入库**：调用嵌入模型得到向量，存入向量数据库；同时把原文、元数据写入关系型或文档存储，保证渲染时可脱离向量库取原文。
3. **查询改写与检索**：对用户问题进行扩展/重写，召回 top-k；按 `sourceId` 去重，保留每份来源的最高分块。
4. **上下文组装**：把选中的 `EvidenceChunk` 按 `chunkId` 排序，注入 prompt，并显式告诉模型只能使用提供的上下文，引用格式为 `[c1]`。
5. **生成与标记解析**：模型输出后，用正则提取 `[c\d+]`，映射到真实 chunk；未映射到的标记视为幻觉引用。
6. **引用校验**：对每个 `CitationSpan`，用精确匹配、关键词重叠、语义相似度三种方法判断其是否支持对应论断；生成 `Verdict`。
7. **无证据论断处理**：检测未被任何引用覆盖的句子；若该句含事实性断言，则标记为 `unverifiedClaim`，要求模型补充引用或删除断言。
8. **前端渲染**：把 `[c1]` 替换为可点击角标，右侧或浮层展示证据卡片，包含文件路径、版本、原文片段、得分。
9. **审计持久化**：保存 `EvidenceBundle`、`AttributedAnswer`、用户 query、检索参数，便于后续回溯。
10. **反馈闭环**：收集用户“引用不准”反馈，定位到具体 `chunkId`，触发重新分块、更新验证阈值或补充文档。

## TypeScript/Web/本地文件知识库示例

输入：用户提问 `okr 对齐会议应该多久开一次`，系统已索引本地 `docs/okr-guide.md` 的 v2 版本。

处理：检索器返回两个片段，生成模型输出 `建议每两周举行一次 OKR 对齐会 [c1]，在关键里程碑前可缩短到一周 [c2]。`

输出 JSON：

```json
{
  "text": "建议每两周举行一次 OKR 对齐会 [c1]，在关键里程碑前可缩短到一周 [c2]。",
  "citations": [
    { "id": "c1", "chunkId": "okr-guide#3", "sourceId": "docs/okr-guide.md", "version": "sha256:9f4e...", "byteRange": [420, 512], "evidenceType": "direct" },
    { "id": "c2", "chunkId": "okr-guide#7", "sourceId": "docs/okr-guide.md", "version": "sha256:9f4e...", "byteRange": [980, 1050], "evidenceType": "direct" }
  ],
  "unverifiedClaims": []
}
```

代码层面用 TypeScript 定义：

```typescript
interface Citation {
  id: string;
  chunkId: string;
  sourceId: string;
  version: string;
  byteRange: [number, number];
  evidenceType: 'direct' | 'indirect' | 'contradictory';
}

function renderCitationCard(c: Citation, rawText: string): string {
  return `[${c.id}] ${c.sourceId}@${c.version.slice(0, 12)}\n${rawText.slice(...c.byteRange)}`;
}
```

输入是用户查询与带标记的模型输出；处理是解析标记并关联元数据；输出是结构化引用卡片，可直接渲染到 Web 侧边栏。

## 性能、质量、可观测性指标

1. **引用覆盖率**：含至少一个引用的论断数 / 总论断数。用声明式断言抽取器（如 spaCy/规则）统计，目标 > 90%。
2. **检索 Recall@k**：在标注测试集上，相关文档是否出现在 top-k 中。每周用新增问答对重跑。
3. **引用校验通过率**：`Verdict.status === supported` 的引用比例。低于阈值时触发模型 prompt 或分块策略调整。
4. **端到端延迟**：从收到用户问题到返回带引用答案的 p50/p95 时间。分别埋点检索、生成、校验三阶段。
5. **用户引用争议率**：用户点击“引用不正确”次数 / 总引用展示次数。争议高的 `chunkId` 进入 badcase 队列。
6. **版本漂移告警数**：回答中的 `version` 与当前最新版不一致的比例，用于衡量文档更新后旧回答失效风险。

## 失败模式与恢复动作

1. **引用缺失**：模型下结论但无 `[cX]`。诊断证据为 `CitationSpan` 为空且该句含实体/数字。恢复：prompt 中强制“每个事实后必须跟引用”，并在解析失败时重试一次。
2. **引用指向无关片段**：`Verdict` 语义相似度低于 0.5。诊断证据为低分且关键词缺失。恢复：过滤该引用，若结论失去支撑则标记为未验证或重新检索。
3. **分块切断上下文**：原文被截断导致句意反转，诊断证据是 `byteRange` 起止点落在句子中间。恢复：分块算法优先在句末或段末切分，代码块/表格不拆分。
4. **幻觉引用 ID**：模型输出 `[c9]` 但召回结果只有 5 个块。诊断证据为 id 不在允许集合。恢复：正则校验后拒绝非法引用，必要时让模型重生成。
5. **版本不一致**：`EvidenceBundle.version` 与当前文件 `checksum` 不同。诊断证据为 `version` 字段不匹配。恢复：显示“原文已更新”提示，建议用户重新查询；旧审计记录保留。
6. **数字/时间断言过度推断**：原文写“增长显著”，模型写“增长 30%”。诊断证据为数字在引用片段中不存在。恢复：用规则检测数字偏离，标记 `unsupported` 并要求改写。

## 问答测试样例

1. **正向**：问“okr 对齐会议应该多久开一次”，期望答案引用 `docs/okr-guide.md` 中关于两周一次的段落，并显示版本与字节范围。
2. **边界**：问“okr 对齐会的频率”，召回结果包含 v1 与 v2 两个版本。期望系统优先使用用户指定的版本；未指定时使用最新版，但 `EvidenceBundle` 明确记录版本。
3. **边界**：问“okr 对齐会对远程团队是否适用”，原文仅提到“线下团队”，但语义相近。期望答案标注 `indirect` 证据，置信度中等，不冒充直接证据。
4. **无证据拒答**：问“公司明年战略是什么”，知识库里没有相关文档。期望系统拒绝生成具体结论，仅回复“未找到相关来源，无法回答”。
5. **冲突证据**：问“okr 应该按季度还是按月设定”，两个块分别支持季度和按月。期望答案列出两种说法，分别引用，并提示需要进一步确认。
6. **多步组合**：问“okr 与 kpi 的核心区别是什么”，需要组合 `docs/okr-guide.md` 和 `docs/kpi-guide.md`。期望答案同时引用两个来源，并能在证据面板中切换展示。

## 维护、版本、来源与相邻主题

维护侧要建立文档刷新流水线：监控文件系统或 Git webhook，当 `checksum` 变化时创建新的 `SourceRecord` 与 `version`，旧版本保留到保留期结束。定期重跑历史查询，比较新旧版本的引用差异，生成 drift 报告。版本策略推荐使用内容哈希，因为哈希天然区分任何字节变化；若业务需要语义版本，则在内容哈希之上再维护别名映射。

来源管理需要记录每个 `docId` 的获取时间、解析器版本、嵌入模型版本，因为同一文档在不同解析器下可能产生不同的 `byteRange`。与相邻主题的关系：引用与证据依赖高质量的分块和检索，因此与“文档切分策略”“重排序模型”“查询改写”紧密相关；同时它又是“可解释性”和“信任层”的输入，下游审计、合规、用户反馈都依赖本层输出的 `EvidenceBundle`。

## 结论

**事实**：任何带引用的回答都可以被分解为 `CitationSpan`、`EvidenceChunk`、`SourceRecord` 和 `Verdict` 四层数据结构；`byteRange` 与 `version` 是回指原文的最小必要字段。

**推论**：如果实现中强制要求每个事实性断言后都出现可映射的引用标记，并在后端用多方法校验其支持度，可显著降低无依据回答的流出概率；版本固定虽然会增加存储，却是长期可审计的前提。

**未知**：当前方法对“隐性推断”和“常识性断言”的边界仍依赖启发式规则；多语言混合、扫描版 PDF、高度表格化文档中的精确引用定位，仍需要针对具体数据集调优分块与校验阈值。
