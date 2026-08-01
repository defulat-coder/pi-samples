---
type: concept
title: 来源追踪：实现视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。记录原始来源、生成过程、验证人和证据时间
resource: .pi/knowledge/library/okf-governance/provenance-implementation.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, provenance, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: provenance
variant: implementation
---

# OKF 来源追踪：把来源、生成、验证与证据时间写入 TypeScript 实现层

## 摘要与问题边界

来源追踪不是给每条回答贴一个 URL。它要求：当知识库中的任意可回答内容被召回时，能立即说出原始来源是什么、经过哪些转换生成、由谁在哪一刻验证、以及支持该断言的证据在何时被固定。本文从实现视角出发，只讨论本地文件与 Web 摄入的知识记录，不处理外部付费 API 的真实性担保，也不解决模型幻觉本身的语义正确性；它解决的是“这条答案从哪条证据派生而来”这一可审计问题。

## 核心概念与数据模型

以下六个结构必须显式建模，缺一不可。

1. 来源事件 ProvenanceEvent：原始捕获记录。字段包括 sourceURI（file:// 绝对路径或 https:// 最终 URL）、observedAt（证据时间，取来源本身稳定时间或首次抓取时间）、sha256（按 UTF-8 字节计算的指纹）、mimeType、byteLength、fetcherId。该记录一旦写入不可原地修改。

2. 派生节点 DerivationNode：每一次处理都是新节点。字段包括 parentId（指向来源事件或上游派生节点）、processName（如 markdown-split、chunk-embed、summarize）、paramsHash（处理参数与版本号的哈希）、outputFingerprint（输出内容指纹）、processedAt（处理时间）。一个节点只能有零个或一个父节点，但可以有多个子节点。

3. 证据包 EvidenceBundle：把来源字节、转换后的可引用片段、以及验证声明绑定在一起。它本身不保存向量，只保存指向 blob 或向量文件的 storageKey 与 fingerprint，便于索引重建时核对。

4. 验证声明 VerificationClaim：记录验证人、验证方法、验证时间。字段包括 verifierId（可为人、自动化检查器或 Agent）、method（如 exact-match、human-review、schema-check）、evidenceTime（验证所依据证据被固定的时间，晚于或等于 observedAt）、verdict（accepted、rejected、needs-review）、signature（使用项目本地密钥的离线可验证签名）。

5. 时间锚 TemporalAnchor：区分 observedAt（来源被看到的时间）、processedAt（处理时间）、assertedAt（验证声明时间）、expiresAt（失效策略时间）。任何派生结论必须携带 evidenceTime，且 evidenceTime 不能早于 observedAt；若来源无稳定时间，则使用抓取时间并标记为 inferred。

6. 可查询图谱 QueryableGraph：以节点 id 为键，维护 parentIndex、sourceIndex、verifierIndex、timeRangeIndex。查询接口至少支持 bySource（返回某来源的所有派生）、byFingerprint（按内容指纹查找）、byTimeRange（在证据时间区间内检索）、byVerifier（按验证人过滤）。

## 设计决策与取舍

### 1. 来源记录不可变，错误通过追加修正
任何已写入的 ProvenanceEvent 和 DerivationNode 不更新。发现错误时写入 supersededBy 字段并追加新事件。代价是存储增长，但换取审计链完整。边界：只有 metadata 补正（如补抓 mimeType）可以追加轻量 patch 记录，不能修改原事件。

### 2. 指纹粒度采用文件级与片段级并存
文件级 sha256 用于来源事件，片段级指纹用于派生节点。片段指纹使用父文件字节中该片段对应区间的哈希，而非片段文本的哈希，以便在来源更新后快速定位哪些片段失效。取舍：记录数量增加，但来源更新时不必全量重算。

### 3. 验证声明与内容分离存储
VerificationClaim 不嵌入派生节点，而是独立记录并通过 targetId 指向。这样同一派生节点可被不同验证人多次验证，也不会让内容索引膨胀。例外：对于实时在线查询，可生成临时 verificationClaim，但必须在证据时间字段标记为 online 并设置较短的 expiresAt。

### 4. 使用 JSONL 追加日志加内存索引
持久层用按行追加的 JSONL 文件，启动时构建内存索引。取舍：写入简单、审计友好，但全文检索需要额外构建倒排。项目规模在百万级记录以内时，该方案避免引入重型数据库。

### 5. 证据时间优先于处理时间
observedAt 和 evidenceTime 是回答“这条证据在何时成立”的关键。如果 Web 页面的 Last-Modified 明确，优先使用它；若缺失，使用抓取时间并标注 inferred。处理时间 processedAt 只用于内部调度排序，不用于对外断言。边界： observedAt 不得晚于 processedAt，否则触发时间不变性错误。

### 6. 验证人身份必须本地可离线验证
verifierId 必须对应项目内已注册公钥，signature 使用 ed25519 或项目约定算法。不接受外部无法验证的“可信第三方”声明。取舍：增加密钥管理成本，但保证在离线审计时仍可校验。

## 可执行的实施流程

1. 输入：先确定要接入的来源类型。本地文件使用 file:// 绝对路径与 Git 版本；Web 来源使用最终 URL、HTTP 状态码、ETag 或 Last-Modified。输出：定义 Zod 校验的 ProvenanceEvent、DerivationNode、VerificationClaim 类型。错误：任何缺少 sourceURI 或 observedAt 的记录必须在入口处拒绝。

2. 输入：原始字节流。输出：来源事件。错误：如果字节长度为 0、mimeType 无法推断、或计算 sha256 失败，写入 malformed_source 记录并停止后续处理，而不是继续生成空节点。

3. 输入：来源事件与处理参数。输出：派生节点。生命周期：在处理前先写入 pending 节点，处理完成后更新为 completed；若失败写入 failed 并记录 stderr 指纹。验证：派生节点的 outputFingerprint 必须能重新从父节点与 paramsHash 复现，否则标记为 non-reproducible。

4. 输入：派生节点与验证策略。输出：验证声明。错误：若 evidenceTime 早于 observedAt 或晚于当前 UTC 时间，拒绝声明；verifierId 未在注册表中时拒绝。

5. 输入：所有记录。输出：JSONL 追加日志。生命周期：每条记录写入时附加单调递增的 sequenceNumber，便于检测文件截断或乱序。验证：启动时读取 JSONL，校验每行 JSON 与必填字段，非法行写入 corruption.log 并跳过。

6. 输入：JSONL 日志。输出：内存索引。步骤：建立 parentIndex、sourceIndex、verifierIndex、timeRangeIndex。错误：若发现 parentId 缺失但节点非来源事件，创建 orphan 记录并告警，而不是自动删除。

7. 输入：用户查询。输出：召回片段及其完整来源链。生命周期：先查索引获取片段，再反向遍历 parentIndex 直到来源事件，最后组装 EvidenceBundle。错误：如果任何中间节点缺失，返回 lineage-broken 而不是合成答案。

8. 输入：无证据的问题。输出：拒绝响应。实现：在 Agent 输出层设置 refusal middleware，当答案中未引用任何 verificationClaim 时，强制返回 no_evidence 结构，并提示用户补充来源。

9. 输入：索引运行状态。输出：审计报告。步骤：每日运行，比较 physical blob 与 manifest fingerprint、检测 expired claims、统计 orphan 节点。错误：发现不一致时写入 audit_failure 记录并触发只读告警。

10. 输入：回归测试集。输出：通过/失败报告。测试集必须覆盖正向可回答、边界需要标注、以及无证据必须拒绝三类。

## 示例：本地 Markdown 与 Web 页面混合来源

示例记录描述一个本地文件被切片并经过人工验证，再被 Web 文章补充来源的过程。

输入：本地文件路径 file:///docs/api.md，Git 提交哈希 7a3b，Web 页面 https://example.com/spec.html，HTTP ETag abc，抓取时间 2026-08-15T10:00:00Z。

处理：文件读取器先计算 sha256 为 a1b2c3...，写入 ProvenanceEvent pe-001；切片器 markdown-split 读取 pe-001，按二级标题拆分，生成 DerivationNode dn-001，outputFingerprint 为 d4e5f6...；人工验证者 human-review@project 检查 dn-001，在 2026-08-15T10:05:00Z 写入 VerificationClaim vc-001，verdict 为 accepted。Web 页面随后被独立摄入，生成 pe-002、dn-002，与本地 dn-001 无派生关系，但可通过共同查询条件被联合召回。

输出：当用户询问 API 端口时，系统返回答案文本，同时附带引用列表：vc-001 -> dn-001 -> pe-001（本地文件），以及可能的 pe-002。用户点击引用可查看完整来源 URI、证据时间、验证人。

## 性能、质量与可观测性指标

1. 来源链查询延迟：对任意召回片段，获取到原始来源事件的平均路径长度应小于 5 跳，p95 查询耗时低于 20 毫秒。测量方式：从索引中随机抽取 1000 个节点，记录 parentIndex 回溯耗时。

2. 来源覆盖率：知识库中具备非孤儿 ProvenanceEvent 的节点比例应高于 99.5%。测量：每日统计 orphan 节点数除以总节点数。

3. 指纹冲突率：理论上 sha256 冲突极低，但需通过随机采样 10000 对指纹对比进行监控，实际冲突数应为 0；若出现非零立即审计。

4. 验证声明新鲜度：expired claims 占比应低于 2%。测量：按 expiresAt 过滤，统计已过期但未被刷新或标记为 stale 的验证声明。

5. 无证据拒绝准确率：在测试集中，无证据问题被正确拒绝的比例应等于 100%；正向问题至少 95% 引用了正确的 verificationClaim。测量：运行回归测试集并统计 refusal 误触发率。

6. 审计不一致率：physical blob 与 manifest fingerprint 不一致的比率应为 0。测量：每日审计任务扫描存储，报告 mismatch 数量。

## 失败模式、诊断证据与恢复动作

1. 孤儿节点。诊断：启动索引时出现 missingParent 日志，节点 parentId 指向不存在的记录。恢复：先尝试从原始来源重新派生缺失父节点；若来源也丢失，则保留该节点并标记为 orphan，禁止其参与回答，直到人工补录来源。

2. 指纹不匹配。诊断：审计报告显示 storedFingerprint 不等于 recomputedFingerprint。恢复：若 blob 存在，可能是编码或规范化错误，重新计算并追加修正记录；若 blob 损坏，从备份或来源重新摄入。

3. 时间倒置。诊断：校验规则 observedAt 大于 processedAt 或 evidenceTime 大于当前 UTC 时间触发。恢复：拒绝该记录，要求摄入组件提供正确的时间或标记为 inferred；不能简单将时间改为当前时间以通过校验。

4. 验证人版本漂移。诊断：同一 verifierId 的 method 或版本号前后不一致，导致同一内容 verdict 不同。恢复：固定验证器版本，对受影响记录重新运行验证并写入新的 verificationClaim，旧声明保留但 superseded。

5. 过期证据被引用。诊断：召回结果中 verificationClaim 的 evidenceTime 早于来源的 observedAt 或 expiresAt 已过期。恢复：触发重新验证流水线，更新 evidenceTime 与 expiresAt；在更新前，回答必须附带 stale 警告。

6. 无证据回答泄漏。诊断：Agent 输出没有 provenanceId 或 verificationClaim 引用。恢复：在输出层强制拒绝，返回 no_evidence，并记录泄漏事件用于改进 prompt 与 middleware。

## 问答测试样例

1. 正向问题：API 的默认端口是多少？期望：回答 8080，并引用 vc-001 -> dn-001 -> pe-001，且 evidenceTime 不早于 pe-001 的 observedAt。

2. 正向多源问题：本地文档与 Web spec 对端口描述是否一致？期望：回答列出两个来源链 pe-001 与 pe-002，并说明差异或一致。

3. 边界问题：file:///docs/api.md 已被删除，但知识库仍保留其最后来源事件，能否引用它？期望：允许引用，但答案必须附带 unavailable-source 标记，并给出最后 observedAt。

4. 边界问题：同一来源存在两个版本 pe-001 与 pe-003，哪个优先？期望：以 observedAt 较晚者为准，且必须显式说明版本替换关系。

5. 无证据拒答：项目使用了多少个未在文档中列出的第三方库？期望：系统中若没有对应 ProvenanceEvent，必须返回 no_evidence，禁止根据模型训练数据猜测。

6. 无证据拒答：作者对某个设计决策的个人偏好是什么？期望：若文档中只记录事实，未记录主观偏好，必须拒绝并说明 source-contains-no-opinion。

7. 时间边界问题：上周的部署记录在哪里？期望：仅当存在证据时间覆盖上周的 ProvenanceEvent 或派生节点时才回答；否则返回 out-of-evidence-time-range。

## 维护、版本、来源与相邻主题关系

维护工作主要围绕 JSONL 日志的追加、索引重建、schema 迁移。schema 版本使用 semver 存储在 manifest 的 schemaVersion 字段；升级时保留旧日志，通过迁移脚本生成新日志，迁移后的记录保留 originalSequence 指向旧记录。来源本身不可删除，只能追加 tombstone 记录表示已移除。与相邻主题的关系：来源追踪依赖知识摄取提供原始字节，依赖验证提供 verdict，依赖检索提供召回，又为归因和审计提供输入。它不替代事实核查，只提供“谁、何时、如何生成”的机械证据。

## 结论

事实：来源追踪强制记录来源事件、派生节点、验证声明和三个时间锚；无证据时必须拒绝回答。推论：在 TypeScript 实现中，只要所有转换都写入派生节点、所有验证都写入声明，并强制拒绝无 provenance 的输出，就能显著降低幻觉被当作事实的风险。未知：外部来源本身的真伪、作者意图、以及模型对语义的理解是否正确，无法通过来源追踪解决；它只能保证系统内的证据链可被复现和审计。
