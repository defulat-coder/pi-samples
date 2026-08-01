---
type: concept
title: 来源追踪：验证与运维视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。记录原始来源、生成过程、验证人和证据时间
resource: .pi/knowledge/library/okf-governance/provenance-operations.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, provenance, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: provenance
variant: operations
---

# OKF 来源追踪：验证与运维视角下的原始来源、生成过程与证据时间

## 摘要与问题边界

来源追踪不是事后的引用补录，而是对知识单元从产生到被消费的全链路记录。工程师需要观察的不仅是单次成功请求，而是系统在成功、失败、延迟、容量和恢复五种状态下保持来源信息完整的能力。问题边界限定为本地文件、Web API 返回以及 Agent 生成的中间产物；未授权的私有仓库、临时缓存和外部付费服务不在默认追踪范围，除非显式配置为受信来源。

## 核心概念与数据模型

1. 原始来源记录。记录知识单元最初的获取位置，包括本地文件绝对路径、HTTP URL、Git 提交哈希或数据库主键。路径禁止使用匿名别名，Web 来源必须保留完整协议与域名。

2. 生成过程记录。保存从原始来源到最终知识形态的转换步骤，包括 Markdown 分片、向量嵌入、摘要生成或工具调用。每个步骤记录输入指纹、输出指纹和工具版本。

3. 验证人记录。记录执行验证动作的主体，分为人工工程师、自动化脚本或 CI 任务 ID。验证类型包括来源可达性、内容一致性和语义等价性三类。

4. 证据时间。采用单调时钟与 wall-clock 双轨记录。wall-clock 用于人工审计，单调时钟用于计算延迟和顺序；两者偏差超过 500 毫秒时触发告警。

5. 版本快照。每次来源或生成过程变更时生成不可变快照，以内容寻址哈希命名。本地文件保留最近 100 个版本，运行时指标保留 7 天。

6. 可信度衰减。为每个来源设置半衰期：本地文件 30 天、Web API 24 小时、临时缓存 1 小时。未重新验证则可信度从 1.0 降至 0.5 以下。

## 设计决策与取舍

### 完整内容还是指纹
默认记录 SHA-256 指纹与 512 字节片段，完整内容仅在文件小于 1MB 或标记为关键知识时保留。指纹节省空间但来源失效时无法就地重建；完整内容提升恢复速度但增加存储成本。

### 实时验证还是异步校验
查询路径采用异步校验，先返回带来源标记的结果，后台再触发验证。CI 发布采用实时验证，阻塞发布直至来源链完整。实时保证基线但增加延迟，异步提升响应却可能暴露短暂不一致。

### 中心化日志还是分布式索引
来源元数据写入集中式 WAL，原始文件索引分布式存储。集中日志便于审计但成为单点；分布式索引提高并发却增加一致性检查复杂度。

### 手动验证还是自动验证
关键来源首次引入、依赖变更或可信度衰减到阈值时强制人工复核；常规来源由脚本自动化验证。

### 保留期限
本地来源与项目生命周期一致，Web 来源 90 天，临时缓存 24 小时。长期保留支持回溯但增加合规清理成本。

## 可执行的实施流程

1. 在 `packages/contracts` 定义 `SourceRecord`、`ProvenanceStep`、`Verifier`、`EvidenceTime` 四个 DTO，使用 Zod 校验。

2. 在 `packages/pi-agent` 的文件读取、API 调用、嵌入生成、摘要生成、缓存命中和缓存失效六处注入来源记录。

3. 在 `apps/api` 建立 `/provenance/verify` 端点，返回验证状态、延迟、验证人 ID 和证据时间。

4. 在 `apps/web` 不暴露 Pi SDK 或密钥，仅通过 SSE 消费 `/provenance/stream` 事件。

5. 为本地文件配置 `chokidar` 监听器，变更时自动生成新快照并标记旧快照为待验证。

6. 配置双轨时间服务，偏差超 500 毫秒进入降级模式。

7. 注册 Prometheus 指标：`provenance_records_total`、`provenance_verify_latency_seconds`、`provenance_failures_total`、`provenance_recovery_duration_seconds`、`provenance_storage_bytes`。

8. 每月演练：随机删除 10% 本地来源记录，验证系统能否在 5 分钟内重建索引。

## TypeScript 与本地文件知识库集成示例

```typescript
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

interface SourceRecord {
  sourceId: string;
  origin: string;
  kind: 'local-file';
  contentHash: string;
  contentPreview: string;
  generatedBy: string;
  verifier: string;
  wallClock: string;
  monotonicMs: number;
}

export async function loadKnowledge(path: string): Promise<SourceRecord> {
  const start = performance.now();
  const buffer = await readFile(path);
  const hash = createHash('sha256').update(buffer).digest('hex');
  return {
    sourceId: `local-file://${path}@${hash.slice(0, 16)}`,
    origin: path,
    kind: 'local-file',
    contentHash: hash,
    contentPreview: buffer.toString('utf-8').slice(0, 512),
    generatedBy: 'loadKnowledge@pi-agent:0.83.0',
    verifier: 'system-watchdog',
    wallClock: new Date().toISOString(),
    monotonicMs: performance.now() - start,
  };
}
```

输入为经 `cwd` 校准的本地文件路径；处理过程读取文件、计算哈希、截取片段；输出为包含来源 ID、内容指纹、生成工具、验证人和双轨时间的结构化记录，写入集中日志后可供检索器召回。

## 性能、质量与可观测性指标

1. 来源覆盖率。已追踪来源数占总知识单元数比例。每日对比 `provenance_records_total` 与 `knowledge_entries_total`，目标大于 99%。

2. 验证延迟。从触发到返回的中位时间。记录 `provenance_verify_latency_seconds`，P99 小于 2 秒。

3. 失败恢复时间。来源记录丢失或损坏后重建到可查询状态的时间。演练记录 `provenance_recovery_duration_seconds`，目标小于 5 分钟。

4. 来源链完整性。每个响应是否携带完整来源链。对 `/chat` 响应采样，检查 `sourceChain` 非空且至少包含原始来源与生成过程，目标 100%。

5. 存储增长率。来源元数据周环比增长。监控 `provenance_storage_bytes`，超过 20% 周环比触发容量审查。

## 失败模式、诊断证据与恢复动作

1. 来源记录丢失。证据：`provenance_records_total` 突降或 `sourceChain` 为空。恢复：从快照恢复，或从原始文件重新生成并标记为“重建”。

2. 验证人不可用。证据：验证队列堆积，延迟指标无新增。恢复：切换备用脚本或降级为“未验证”，通知人工复核。

3. 时间戳漂移。证据：同一记录双轨时间偏差超 500 毫秒。恢复：暂停该节点写入，同步时间源后重新验证。

4. 生成过程中断。证据：存在步骤记录但缺少最终快照，或最终哈希与输出不匹配。恢复：丢弃不完整记录，回滚到最近一致状态。

5. 索引不一致。证据：检索器返回的 `sourceId` 在来源日志中不存在。恢复：重建倒排索引，删除孤立项。

## 问答测试样例

1. 正向：某条知识的本地文件路径是什么？必须返回 `origin` 字段绝对路径及 `wallClock`。

2. 正向：这条记录的验证人是谁？必须返回 `verifier` 字段并区分人工、系统或 CI。

3. 边界：文件读取后被修改，结果是否可信？若 `wallClock` 早于修改时间，返回“来源已过期，需重新验证”。

4. 边界：内容指纹与当前文件不一致？标记为 `hash_mismatch`，进入异步验证，不直接拒绝原结果。

5. 无证据：缺少 `generatedBy` 字段？回答“无法确认生成过程，建议人工复核或重新采集来源”。

6. 无证据：外部付费 API 未配置追踪？回答“该来源不在默认追踪范围，需显式配置为受信来源”。

## 维护、版本、来源与相邻主题关系

来源元数据每周全量备份，版本快照在每次变更时自动追加。`packages/contracts` 中的 DTO 版本号遵循 SemVer，破坏性变更仅在大版本升级时引入。本主题与“知识验证”相邻，后者关注内容正确性；与“访问控制”相邻，后者决定谁能读取来源记录；与“缓存策略”相邻，后者决定临时命中是否写入来源链。向量嵌入是生成过程的一步，必须记录原始来源与模型版本，但向量索引本身不是原始来源。

## 结论

事实：来源追踪在 OKF 框架中记录原始来源、生成过程、验证人和证据时间，并通过集中日志与分布式索引实现可观测。推论：异步验证加版本快照可以在保证响应性的同时提供故障恢复基线。未知：极端高并发或跨地域时钟不同步场景下，来源链严格一致性与系统可用性的最佳平衡点仍需通过实际运行数据进一步验证。
