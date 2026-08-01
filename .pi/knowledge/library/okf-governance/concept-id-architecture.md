---
type: concept
title: Concept ID：架构视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。通过目录路径形成稳定标识，支持链接、引用和增量索引
resource: .pi/knowledge/library/okf-governance/concept-id-architecture.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, concept-id, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: concept-id
variant: architecture
---

# OKF 概念标识：以目录路径构建稳定可索引 ID

## 摘要与问题边界

在文件优先的知识库中，概念一旦写入就可能被提示词模板、Agent 上下文或外部页面引用。OKF-compatible 的 Concept ID 要解决的核心问题是：在不引入全局 UUID 注册中心的前提下，为每个概念提供一个长期稳定、可解析、可增量索引的标识。它把“概念所在目录的规范化路径”作为身份来源，而非文件内容哈希或标题文本，因为内容会改、标题会换，而目录结构是维护者显式承诺的架构边界。本概念不解决权限、加密、版本控制、实时协同或自然语言消歧；它也不替代文件系统路径，只是定义了一套从路径到稳定标识的契约。

## 核心概念与数据模型

1. **域根（Domain Root）**：仓库根目录下的 `okf.yaml` 声明可用域，例如 `concepts`、`skills`、`adr`。每个域是独立命名空间，避免不同业务线产生相同目录路径。域一旦声明，所有概念 ID 都必须带有域前缀。
2. **概念目录（Concept Directory）**：一个概念对应一个目录，目录名即概念的机器可读 slug。目录内必须包含入口文件，约定为 `concept.md`。目录可携带 `assets/`、`examples/` 等子目录，但这些子目录不参与 ID 构成，仅作为概念包的可选资源。
3. **规范化路径（Canonical Path）**：将相对路径按“NFKC 规范化、转小写、空白与下划线替换为连字符、去重分隔符、去除首尾斜杠”处理后的结果。例如 `AI-Strategy/03 Plan.md` 规范化为 `ai-strategy/03-plan`，但建议初始目录名就只含小写、数字和连字符。
4. **稳定标识（OKF-CID）**：完整形式为 `okf://<domain>/<canonical-path>`，本地短形式为 `<domain>/<canonical-path>`，URL 友好形式为 `https://kb.example.org/c/<domain>/<canonical-path>`。三种形式一一映射，由 ID 生成器保证幂等。
5. **引用记录（Reference Record）**：入口文件通过 `[[domain/path]]`、`okf://domain/path` 或标准 Markdown 链接引用其它概念。索引器提取后生成 `(source_id, target_id, anchor_text, line_number)` 记录，用于维护入链/出链。
6. **别名注册表（Alias Registry）**：仓库根或域根下的 `_okf/aliases.yaml` 维护历史路径到当前 ID 的映射。别名永不被物理删除，仅通过 `status: active | deprecated | removed` 标记生命周期。索引器解析引用时优先匹配当前 ID，其次按别名链解析，最多允许三条别名跳步。

## 设计决策与取舍

### 路径身份 vs. 内容身份

选择目录路径作为身份，是因为内容修改不应改变“谁在说话”，而目录重命名是显式且低频的架构动作。内容哈希方案虽能检测重复，但会导致一次编辑就产生新 ID，破坏所有既有链接。代价是重命名必须同步维护别名。

### 目录粒度 vs. 文件粒度

目录粒度把相关资源、示例、测试样例绑定在一起，使 Agent 检索时能以“概念包”为单位加载。代价是移动单个文件不足以改变身份，而删除整个目录才是概念失效信号；若只改入口文件名，需同时更新 `okf.yaml` 的 `entry_file` 约定。

### 集中注册 vs. 仓库约定

不设置中央注册服务，只在每个仓库根声明 `okf.yaml`。这使得概念可以在离线、fork 或私有部署中独立演进。一致性通过 CI gate 强制执行，而不是运行时的写锁。跨仓库唯一性不在本概念范围内。

### 严格规范化 vs. 保留原义

为了跨文件系统保持一致，强制使用 ASCII 小写连字符。非英语概念标题通过入口文件的 `title` 字段保留原义，ID 仅作为机器句柄。例外：专有名词缩写如 `HTTP` 在 ID 中一律小写，避免大小写冲突。

### 别名持久性 vs. 垃圾回收

别名不删除，确保旧外部链接和旧提示词模板长期可解析。代价是别名注册表会增长，需要年度审计，将 `removed` 别名归档到 `_okf/aliases-history.yaml`。未引用的 `deprecated` 别名可在两个主要版本后迁移。

## 可执行的实施流程

1. 在仓库根创建 `okf.yaml`，声明域列表、入口文件名、规范化规则和别名文件位置。
2. 编写 `okf-normalize` 脚本，对任意相对路径输出 canonical path，并检测与现有 ID 的冲突。
3. 为每个概念创建目录，目录名使用小写连字符，目录内放置入口文件和可选子目录。
4. 实现 `makeConceptId(domain, rawPath)` 函数，返回完整、短、URL 三种形式，并保证幂等。
5. 建立 `_okf/aliases.yaml`，定义 schema：`from`、`to`、`reason`、`since`、`status`。
6. 部署增量索引器：首次全量扫描生成 `(id, mtime, hash, refs)` 表；后续仅扫描 mtime 或 hash 变化的文件，并更新入链/出链。
7. 运行链接检查器：对每条引用记录验证目标 ID 或别名存在，输出未解析列表。
8. 在 CI 中注册 `okf-check` gate：重复 ID、规范化冲突、断链、别名循环、入口文件缺失均导致失败。
9. 将索引表写入只读存储或 API，供 Agent 在 prompt 时按 ID 召回上下文。

## 示例：本地 TypeScript 与文件知识库

```yaml
# okf.yaml
okf_version: "1.0"
domains:
  - concepts
  - skills
  - adr
entry_file: concept.md
alias_file: _okf/aliases.yaml
normalization:
  lowercase: true
  hyphenate: true
  unicode_form: NFKC
```

```yaml
# _okf/aliases.yaml
aliases:
  - from: concepts/ai-strategy
    to: concepts/ai-readiness-strategy
    reason: "rename for clarity"
    since: "2026-01-12"
    status: active
```

```typescript
// packages/indexer/src/concept-id.ts
import { createHash } from "crypto";

export function makeConceptId(domain: string, rawPath: string) {
  const canonical = rawPath
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\/+|\/+$/g, "");
  const short = `${domain}/${canonical}`;
  return {
    full: `okf://${short}`,
    short,
    url: `https://kb.example.org/c/${short}`,
  };
}

export function shouldReindex(
  entry: { mtime: number; hash: string },
  disk: { mtime: number; content: string }
) {
  const diskHash = createHash("sha256").update(disk.content).digest("hex");
  return entry.mtime !== disk.mtime || entry.hash !== diskHash;
}
```

输入：仓库收到一次 PR，新增 `concepts/ai-readiness-strategy/concept.md`。处理：`okf-normalize` 把路径规范化为 `concepts/ai-readiness-strategy`，`makeConceptId` 生成 `okf://concepts/ai-readiness-strategy`；索引器计算文件 hash，记录出链。输出：索引表新增一行，引用该 ID 的旧别名解析到当前 ID，Agent 可通过 `okf://concepts/ai-readiness-strategy` 召回概念正文与资源。

## 性能、质量和可观测性指标

- **ID 稳定性率**：30 天内未发生 ID 变更的概念数 / 总概念数。从索引快照比较得出，目标 ≥ 99.5%。
- **规范化冲突率**：新建概念时因规范化导致与已有 ID 冲突的比例。由 `okf-normalize` 在 CI 中统计，目标 < 0.1%。
- **链接解析成功率**：引用记录中成功解析到当前 ID 或有效别名的比例。链接检查器每次运行输出，目标 ≥ 99.9%。
- **增量重索引跳过率**：无需重新解析的概念数 / 总概念数。通过索引器日志统计，目标 ≥ 95%。
- **别名链最大深度**：活跃别名链的跳数 p99。解析器自带计数器测量，上限 3，超标报警。
- **孤立概念比例**：入链数为零且非显式根概念的比例。从索引表聚合，目标 < 5%。

## 失败模式、诊断证据与恢复动作

- **目录重命名未注册别名**：证据为链接检查器报告大量 `unresolved: okf://concepts/ai-strategy`；恢复动作为运行重命名检测脚本，将旧路径加入 `_okf/aliases.yaml`。
- **规范化冲突**：证据为 CI 失败信息 `duplicate canonical ID: concepts/http-client`；恢复动作为调整目录名或 slug，并记录旧路径别名。
- **别名循环**：证据为解析器报错 `alias cycle detected at concepts/x -> concepts/y -> concepts/x`；恢复动作为手动切断环，指定其中一个为 canonical，其余指向它。
- **增量索引遗漏变更**：证据为文件内容已改但索引表 hash 未变；恢复动作为修复 `shouldReindex` 同时比较 mtime 与 hash，并在每次全量重建时重新计算 hash。
- **跨文件系统大小写差异**：证据为 macOS 与 Linux CI 对 `HTTP`/`http` 目录给出相同 ID；恢复动作为强制小写并添加 CI 大小写冲突 gate。
- **别名链过长导致解析延迟**：证据为 p99 解析耗时 > 50 ms；恢复动作为收缩链，合并中间别名到最终 canonical ID。

## 问答测试样例

- **正向**：`concepts/ai-readiness-strategy` 的稳定标识是什么？答案：`okf://concepts/ai-readiness-strategy`，以及对应的短形式和 URL 形式。通过条件：三种形式均正确且不含 UUID。
- **边界**：如果 `concepts/AI-Strategy` 与 `concepts/ai-strategy` 同时存在会怎样？答案：规范化后产生冲突，CI gate 失败，必须改名。通过条件：指出冲突与恢复路径。
- **边界**：别名 `concepts/ai-strategy -> concepts/ai-readiness-strategy` 可否删除？答案：不可以物理删除，只能标记为 `deprecated` 或 `removed`。通过条件：说明持久性原则。
- **边界**：概念目录里放 `README.md` 而不是 `concept.md` 会怎样？答案：若 `okf.yaml` 未声明 `README.md` 为入口，索引器视其为普通资源，概念被判定为入口缺失。通过条件：说明入口契约。
- **无证据拒答**：请给出本仓库过去一年的概念 ID 变更趋势。答案：无法回答，除非提供索引快照或版本历史；指标必须由运行中的索引器或仓库 git 日志产生。通过条件：拒绝猜测并说明所需数据。
- **无证据拒答**：Concept ID 是否保证唯一跨全球所有 OKF 仓库？答案：无法保证；本设计只在仓库内及声明的域之间保证唯一，跨仓库唯一性需要外部注册中心，不在本概念范围内。通过条件：明确边界。

## 维护、版本、来源与相邻主题关系

- **维护**：每次目录重命名、拆分或合并都必须同步更新 `_okf/aliases.yaml` 并运行链接检查。建议每次发版前执行全量重建索引。
- **版本**：`okf_version` 字段标识契约版本。1.0 支持路径身份、三态别名、三形式 ID。升级大版本需迁移所有别名文件。
- **来源**：标识生成规则来自仓库根 `okf.yaml` 与 `okf-normalize` 脚本；引用记录来自索引器解析；别名来源来自维护者显式变更。
- **与相邻主题关系**：与“OKF 知识治理 / 索引与检索”共享索引表；与“OKF 知识治理 / 链接完整性”共享引用记录；与“OKF 知识治理 / 概念模板”共享目录结构；与“Agent 上下文加载”通过 ID 召回接口交互。它不负责版本控制，版本控制由 Git 完成；不负责渲染，渲染由 Web 或文档生成器完成。

## 结论

- **事实**：Concept ID 由仓库根声明的域、概念目录的规范化路径和入口文件约定共同决定；完整形式为 `okf://<domain>/<canonical-path>`；别名注册表必须持久保存。
- **推论**：以路径为身份能在内容频繁编辑时保持链接稳定，但代价是重命名需要显式别名维护；增量索引依赖 mtime 与内容 hash 双重比较才能在性能与一致性之间取得平衡。
- **未知**：在跨仓库、跨组织的全局命名空间中，是否需要引入 DID 或全局注册中心，以及如何为自然语言同义词建立可验证映射，均不在本概念当前设计之内，需要后续实验。
