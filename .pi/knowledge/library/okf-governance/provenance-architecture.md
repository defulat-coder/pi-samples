---
type: concept
title: 来源追踪：架构视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。记录原始来源、生成过程、验证人和证据时间
resource: .pi/knowledge/library/okf-governance/provenance-architecture.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, provenance, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: provenance
variant: architecture
---

# OKF 来源追踪：面向知识治理的 provenance 架构设计

## 摘要与问题边界

来源追踪不是判断内容是否为真，而是把“一个知识条目为何被接纳”变成可审计的结构化记录。它的最小职责是记录：原始来源在哪里、生成过程用了什么、谁验证、以何时为证据锚点。边界上，它只治理知识进入系统之后的 provenance，不做实时授权、不做外部事实裁决；它对外只读，写入由受控的 `SourceResolver`、`ProcessLogger`、`EvidenceValidator` 三个可替换接口完成。如果一条知识没有来源记录，系统必须拒绝将其作为可引用事实，而不是自动补来源。设计视角优先关注接口语义、责任边界和可替换实现，而不是直接绑定到具体数据库或 provider。

## 核心概念与数据模型

1. **来源记录（SourceRecord）**：知识的物理或逻辑来源，包括稳定标识符 `sourceId`、可解析 URI/URN、检索策略 `retrievalPolicy`、内容哈希 `contentHash`、检索时间 `retrievalTime`。同一 URI 在不同时间检索产生不同来源记录，旧记录标记为 `superseded` 而非删除，从而保留历史证据链。
2. **生成过程（GenerationProcess）**：从来源到候选知识的变换，包括工具名与版本 `tool`、`toolVersion`、提示模板 ID `promptTemplate`、参数指纹 `paramHash`、输入来源 ID 列表、输出候选知识 ID、处理时间 `processingTime`。过程记录本身也写入 append-only 日志。
3. **证据断言（EvidenceAssertion）**：验证人对“来源能否支持某条主张”的正式声明，包括 `assertionId`、主张 ID `claimId`、证据类型（`primary`/`secondary`/`derived`）、验证人标识 `verifierId`、验证人角色、证据时间 `evidenceTime`、断言签名或校验和。证据时间是验证人把来源与主张绑定起来的锚点，不是检索时间，也不是观察时间。
4. **溯源图（ProvenanceGraph）**：以 `SourceRecord`、`GenerationProcess`、`EvidenceAssertion` 为节点，边类型为 `produced`、`verified`、`transformed` 的有向无环图。图存储是索引，不是真相来源；真相来源是 append-only 日志。
5. **信任边界（TrustBoundary）**：来源记录属于哪个受信域，如 `local-filesystem`、`web-public`、`third-party-notary`。边界包含过期策略 `expiry`、撤销句柄 `revocationHandle` 与最小验证等级 `minVerificationLevel`。不同信任域可以配置不同的来源解析与验证策略。
6. **可替换接口（Capability Interface）**：`SourceResolver` 负责解析 URI 并返回来源记录；`ProcessLogger` 负责记录生成过程；`EvidenceValidator` 负责验证断言并返回证据时间；`ProvenanceStore` 负责持久化；`QueryFacade` 负责对外只读查询。实现可以替换，但接口语义必须满足上述数据模型。

## 设计决策与取舍

### 记录粒度：主张级还是批次级
选择主张级记录。优点是可拒绝单个无来源的主张，避免批量污染；缺点是存储与查询成本高。缓解方案：引入批次聚合，批次 ID 与内部主张序列号构成映射，删除批次不会删除批次内主张的来源记录。查询时既能展开到单个主张，也能按批次审计。

### 时间语义：三种时间必须分离
检索时间、处理时间、证据时间分别记录。检索时间说明来源 freshness；处理时间用于调试生成过程，不暴露给最终查询；证据时间是 provenance 的因果锚点。系统设计禁止用证据时间替代检索时间，避免“未来证据”或“来源尚未存在就被引用”。

### 验证人身份：角色标识优先
验证人使用角色标识 `verifierRole` 加可选的 `verifierId`，不强制暴露自然人。这样既支持审计，又保护个人密钥。代价是无法直接追溯到个人；补救方式是保留组织级签名记录，并在安全流程中允许离线映射。`verifierId` 只在涉及法律或安全审计时由离线授权表解锁。

### 存储形态：日志优先，图是索引
append-only 日志是唯一真相来源，所有写入先追加日志；图数据库或关系索引异步构建。好处是审计简单、顺序号单调；坏处是查询需要等待索引同步。索引构建失败时必须回退到直接扫描日志，保证查询可用。系统必须暴露 `logSequence` 作为可验证的检查点。

### 验证后端可替换：本地默认，外部可选
默认 `EvidenceValidator` 是本地规则与签名校验；可替换为第三方公证或同行签名。替换条件由 `TrustBoundary` 配置决定。外部验证结果同样必须写入日志，系统不信任内存中的临时状态。风险是外部不可用时可能阻塞验证；因此系统把外部验证作为提升等级，而非写入的必要条件。

## 可执行的实施流程

1. 定义 `SourceRecord` schema 与命名空间，确保同一 URI 的不同检索产生递增版本号。
2. 设计 `SourceResolver` 接口，区分本地文件、HTTP、远程仓库三种 resolver，并定义统一的错误语义。
3. 在读取阶段实现内容哈希、检索时间、来源媒体类型的捕获，失败时生成 `source_unavailable` 记录而非静默跳过。
4. 设计 `ProcessLogger` 接口，要求工具名、版本、参数指纹、输入来源 ID、输出主张 ID 五项必填。
5. 实现 `EvidenceValidator` 接口，输出包含 `evidenceTime`、`verifierRole`、`assertionSignature` 与证据类型。
6. 构建 append-only 日志写入器，保证单调 `logSequence`，并支持幂等重试。
7. 从日志异步构建溯源图索引，边类型严格为 `produced`、`verified`、`transformed`。
8. 暴露只读查询门面，支持按 `claimId` 返回完整 provenance 路径、按 `sourceId` 返回下游主张、按 `verifierRole` 返回验证覆盖。
9. 接入观测：记录 resolver 成功率、验证覆盖率、图索引延迟、来源漂移率、无来源拒答数。
10. 制定版本与迁移策略：schema 变更时老日志保持原样，新日志使用新 schema 版本，查询层通过兼容层读取。
11. 提供来源导出接口，允许外部审计按 `logSequence` 范围导出原始日志，不经过查询索引。

## 实现示例：本地文件知识库的来源追踪

下面是一个 TypeScript 风格的概念验证，展示输入、处理与输出。

```typescript
type SourceRecord = {
  sourceId: string;
  uri: string;
  retrievalTime: string;
  contentHash: string;
  retrievalPolicy: { type: 'local-file'; path: string };
  status: 'current' | 'superseded';
};

type EvidenceAssertion = {
  assertionId: string;
  claimId: string;
  sourceId: string;
  evidenceTime: string;
  verifierRole: 'maintainer';
  evidenceType: 'primary';
};

function traceSource(input: { path: string; claimId: string }): SourceRecord & EvidenceAssertion {
  const content = readFile(input.path);        // 输入：本地文件路径
  const contentHash = sha256(content);         // 处理：计算内容哈希
  const now = monotonicNow();                  // 处理：单调证据时间
  const source: SourceRecord = {
    sourceId: `src:${input.path}:${now}`,
    uri: `file://${input.path}`,
    retrievalTime: now,
    contentHash,
    retrievalPolicy: { type: 'local-file', path: input.path },
    status: 'current',
  };
  const assertion: EvidenceAssertion = {
    assertionId: `assert:${input.claimId}:${source.sourceId}`,
    claimId: input.claimId,
    sourceId: source.sourceId,
    evidenceTime: now,
    verifierRole: 'maintainer',
    evidenceType: 'primary',
  };
  return { ...source, ...assertion };          // 输出：来源记录 + 证据断言
}
```

输入是本地文件路径与主张标识；处理阶段读取文件、计算哈希、生成单调时间；输出是同时包含来源记录和证据断言的 provenance 包。该包随后被追加到 append-only 日志，并由图索引消费。

## 性能、质量与可观测性指标

1. **来源解析成功率**：成功返回 `SourceRecord` 的调用占比，按 resolver 类型分桶，低于 95% 触发告警。
2. **证据断言覆盖率**：已有 `EvidenceAssertion` 的主张数 / 总主张数，目标 ≥ 98%，未覆盖的主张被自动拒答。
3. **溯源图查询 P95 延迟**：按 `claimId` 查询完整 provenance 路径的耗时，目标 < 200 ms。
4. **验证签名有效比例**：通过 `EvidenceValidator` 且签名或校验和有效的断言占比，低于 90% 触发审计。
5. **来源漂移率**：重新解析同一 URI 后 `contentHash` 不一致的比例，用于发现外部来源变化或本地篡改。
6. **无来源拒答数**：因缺少来源记录而被拒绝的回答请求数，反映治理边界是否被遵守。

## 失败模式、诊断证据与恢复动作

1. **resolver 不可达**：诊断证据是 `source_unavailable` 日志条目与 resolver 错误码；恢复动作是回退到缓存副本并标记 `stale=true`，不生成新断言。
2. **哈希漂移**：重新检索后 `contentHash` 不一致；诊断证据是 drift 日志；恢复动作是生成新的 `SourceRecord` 并标记旧记录为 `superseded`，同时重新验证下游主张。
3. **验证人缺失签名**：诊断证据是 `assertionSignature` 为空；恢复动作是将断言放入 `unverified` 队列，等待人工或二次验证，未验证前不进入查询结果。
4. **日志序列断裂**：发现 `logSequence` 不连续；诊断证据是序列缺口；恢复动作是暂停写入，从备份 replay 或隔离缺口后的记录，直到连续性恢复。
5. **证据时间倒置**：出现 `evidenceTime` 早于对应 `retrievalTime`；诊断证据是时间校验失败；恢复动作是拒绝该断言，要求验证人重新生成证据时间。
6. **图索引过期**：查询返回的 provenance 路径缺少最新断言；诊断证据是索引版本落后于 `logSequence` 的尾部；恢复动作是重建索引并设置索引落后告警阈值。

## 问答测试样例

1. **正向问题**：某条主张的原始来源是什么？期望返回包含 `uri`、`contentHash`、`retrievalTime` 的 `SourceRecord`。
2. **边界问题**：该来源已被更新，旧来源是否仍可追溯？期望返回当前记录与 `superseded` 历史，并说明新来源尚未重新验证。
3. **边界问题**：证据时间是否早于检索时间？系统应拒绝该断言并返回 `evidence_time_before_retrieval` 错误。
4. **无证据拒答**：用户询问一条没有 `EvidenceAssertion` 的主张来源，系统返回 `no_evidence_available`，不提供猜测。
5. **无证据拒答**：用户要求验证人暴露个人身份，而记录中只有 `verifierRole`，系统返回 `verifier_identity_not_recorded`。
6. **边界问题**：用户要求删除某条来源记录，系统拒绝并返回 `append_only_store`，解释 provenance 不可删除，只能追加新的撤销记录。

## 维护、版本、来源与相邻主题的关系

- **版本策略**：schema 版本按 `SourceRecord`、`GenerationProcess`、`EvidenceAssertion` 分别演进，写入时携带 `schemaVersion`。旧版本日志不迁移，查询层通过适配器读取。
- **来源归属**：本文是 OKF 知识治理中的来源追踪概念，属于 `.pi/knowledge` 或项目自定义 Markdown 知识库；设计决策参考 `AGENTS.md` 中“可替换接口”与“只读暴露”的约束。
- **与相邻主题关系**：来源追踪位于知识验证（Verification）与知识生命周期（Lifecycle）之间，为验证提供证据链，为生命周期提供退役与替换依据；与信任边界（Trust Boundary）共享 `TrustBoundary` 配置；与搜索（Search）只交付 provenance 元数据，不交付原始内容。
- **维护动作**：每季度审查 resolver 可用性、schema 版本分布、未覆盖主张比例、来源漂移率，并在 ADR 中记录接口变更。

## 结论

- **事实**：来源追踪记录原始来源、生成过程、验证人和证据时间，并把这些记录作为 append-only 日志写入。
- **推论**：基于这些记录，可以重建任意主张的 provenance 路径、检测来源漂移、约束无证据回答，并在不同实现之间替换 resolver、validator 或 store。
- **未知**：外部来源本身是否真实、验证人是否诚实、工具是否存在未记录的副作用，这些不在来源追踪范围内，需要相邻的信任机制与验证策略去处理。
