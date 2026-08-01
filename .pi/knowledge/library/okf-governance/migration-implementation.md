---
type: concept
title: 格式迁移：实现视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。从旧字段或旧目录迁移时保持 ID、引用和内容语义稳定
resource: .pi/knowledge/library/okf-governance/migration-implementation.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, migration, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: migration
variant: implementation
---

# OKF 知识治理中的格式迁移：在 TypeScript 实现里保持 ID、引用与语义稳定

## 摘要与问题边界

格式迁移不是文件复制或字段重命名，而是在旧目录结构、旧字段定义与新 schema 之间建立可验证映射，保证每条知识的稳定标识、引用链路、内容语义在迁移后继续有效。本主题的边界覆盖本地文件型知识库（如 `.pi/knowledge`）及 JSON/YAML 条目；明确不包括 LLM 语义改写、分布式并发迁移、访问控制策略迁移。核心目标可量化：迁移后外部链接 404 率趋近于零；同一实体的旧 ID 与新 ID 能在别名表一一对应；关键字段反序列化后与迁移前语义等价，除非显式声明了有损转换。

## 核心概念与数据模型

1. **Canonical ID**：采用 `okf://domain/kind/<uuid>` 形式，生命周期内不随文件路径、目录层级或重命名改变；禁止从标题、slug 或目录名派生，避免一次重命名引发级联 ID 变更。
2. **Physical Path**：文件在磁盘或 Web 资源中的实际位置，仅作为读取入口，不进入引用计算。旧路径 `/legacy/2024/a.md` 与新路径 `/knowledge/a.md` 可指向同一 canonical ID。
3. **Reference Edge**：有向三元组 `(source_id, relation, target_id)`，例如 `(okf://concept/migration, depends-on, okf://concept/id-stability)`。迁移时必须通过 ID 映射表重写 target，而非文本替换。
4. **Content Blob**：原始字节序列、媒体类型（`text/markdown`、`application/json`）与 SHA-256 校验和的组合；语义稳定性优先比较 Blob 或解析后结构，而非渲染后文本。
5. **Schema Marker**：每个文档头部或元数据字段声明 `okf_schema_version`，无版本字段的条目默认归类为 `v1-legacy`，触发最保守迁移路径。
6. **Alias Table**：旧 ID 到 canonical ID 的映射，保存所有历史 ID，包括已合并、已拆分实体；一个 canonical ID 可对应多个历史别名，但一个历史别名在同一批次只能指向一个 canonical ID。
7. **Migration Record**：包含批次 ID、源版本、目标版本、脚本哈希、执行时间、每实体转换日志与最终校验状态，是审计与回滚的唯一依据。
8. **Tombstone**：被删除实体不直接移除，而以 `{id, deleted_at, replaced_by?}` 保留，使旧引用解析为“已删除”而非悬空。

## 设计决策与取舍

### 稳定 ID 优先于可读 slug
可读 slug 在 URL 展示时更友好，但基于标题的 slug 会在标题变更时断裂。OKF 场景下外部 Agent 与检索器长期依赖 ID，因此选择机器生成的 UUID 作为 canonical ID，slug 仅作为可选展示别名。

### 文件优先于数据库
本知识库以本地 Markdown/JSON 文件为真相源，数据库或索引只是派生产物。迁移脚本直接读写文件系统，索引在迁移后重建。这样可以避免数据库 schema 与文件 schema 的双向同步问题，代价是大批量迁移时 I/O 更高。

### 复制-写入而非原地修改
迁移不覆盖旧目录，而是写入新目录或新分支，旧目录保持只读。回滚只需切换符号链接或修改入口配置，不需要逆向转换。代价是磁盘占用翻倍，验证通过后必须按策略回收旧目录。

### 预验证而非后修复
在写入新文件之前，先完成所有引用解析、schema 校验与冲突检测。如果发现错误，整个批次标记为失败，禁止部分提交。这样可以防止“半迁移”状态污染生产索引。

### 引用重写与文本替换分离
引用必须通过 ID 映射表重写。旧文本中的 `[](#old-anchor)` 若对应某个 canonical ID，应转换 target；若只是普通 Markdown 锚点而非 OKF 实体，则保持不变。边界由引用解析器根据链接前缀或元数据判定。

### 批次迁移而非实时同步
格式迁移作为显式命令执行，而不是每次保存自动触发。这降低了日常写入的复杂度，也便于在 CI 中复现。代价是新旧格式并存期间，搜索索引需要同时兼容两套 schema。

## 可执行的实施流程

1. **盘点与快照**：枚举旧目录下所有条目，按扩展名和 `okf_schema_version` 分组；使用 `git tag` 或文件系统快照保存迁移前的完整状态哈希。
2. **建立别名表**：读取旧 ID 字段，若已存在 canonical ID 则复用；若不存在，则生成新的 canonical ID 并登记别名。合并重复条目时，保留最早创建时间作为 canonical 实体的创建时间。
3. **旧格式校验**：用旧版本 JSON Schema 或 Zod 类型校验每个旧条目。任何校验失败立即记录到错误清单，不进入下一步。
4. **内容转换**：按字段映射表转换。必填字段缺失时中断；可选字段缺失时填充默认值；枚举值超出新 schema 范围时标记为待人工审核。
5. **引用重写**：扫描所有 `links`、`related`、`parent` 等字段，将旧 ID 替换为 canonical ID；无法解析的引用记录为悬空引用。
6. **Blob 校验和计算**：迁移后重新读取新文件，计算 SHA-256，与迁移前内容 Blob 的语义等价校验对比。Markdown 标准化空白字符后应一致；JSON 比较解析后对象结构。
7. **新格式校验**：用 Zod 或 JSON Schema 对新文件执行严格校验，包括 ID 唯一性、引用闭合、必填字段完整。
8. **生成迁移记录**：写入 `migrations/<batch-id>.json`，包含源目录哈希、目标目录哈希、脚本版本、每文件状态、错误清单。
9. **索引重建与回归测试**：运行 `pnpm typecheck` 与自定义回归测试，确保新索引可被 `search_knowledge` 工具正确读取，且所有旧 canonical ID 仍能命中。
10. **原子切换与清理**：通过修改入口配置文件或符号链接指向新目录完成切换；保留旧目录至少一个发布周期，再按策略删除。

## 输入、处理与输出示例

以下展示一条旧条目到 OKF v2 的转换：

    # 旧输入：.pi/knowledge/legacy/migration.md
    ---
    id: legacy-migration-2024
    title: 格式迁移
    category: legacy/concepts
    related:
      - id: legacy-id-001
        relation: requires
    body: |
      迁移时应保持 ID 稳定。
    ---
    # 处理后：.pi/knowledge/v2/concept/migration.md
    ---
    okf_schema_version: "2.1.0"
    canonical_id: "okf://concept/550e8400-e29b-41d4-a716-446655440000"
    aliases: ["legacy-migration-2024"]
    title: 格式迁移
    category: concept
    related:
      - target: "okf://concept/6ba7b810-9dad-11d1-80b4-00c04fd430c8"
        relation: requires
    body_sha256: "a3f5..."
    created_at: "2024-01-15T08:00:00Z"
    ---
    # 迁移记录：.pi/migrations/20250801-001.json
    {
      "batch_id": "20250801-001",
      "from_version": "1.0.0",
      "to_version": "2.1.0",
      "source_hash": "sha256:abc...",
      "target_hash": "sha256:def...",
      "entries": [
        {
          "canonical_id": "okf://concept/550e8400...",
          "old_paths": [".pi/knowledge/legacy/migration.md"],
          "status": "migrated",
          "validation": "passed"
        }
      ]
    }

输入端包含未版本化的旧 `id` 与目录结构；处理阶段建立别名表、重写引用、计算校验和；输出端则产生带模式版本、canonical ID 与迁移记录的新条目。

## 性能、质量与可观测性指标

1. **单条目迁移耗时**：在本地 SSD 上测量从读取旧文件到写入新文件并校验完成的平均耗时，目标小于 50 ms/条。使用 `process.hrtime.bigint()` 采样。
2. **引用解析成功率**：迁移后所有引用边中成功解析为 canonical ID 或墓碑的比例，目标 ≥ 99.9%。通过遍历新索引的 `related`/`links` 字段统计。
3. **校验和语义漂移率**：迁移前后语义等价但校验和不一致的条目比例。Markdown 需先规范化空白与换行再比较；JSON 需按键排序后序列化。目标漂移率为 0。
4. **每批次验证错误率**：按旧 schema 版本分组，记录校验失败条目占比。若某版本错误率超过 5%，暂停迁移并回归旧 schema 测试。
5. **别名表命中率**：后续查询使用旧 ID 访问时，能在别名表中命中的比例。通过访问日志采样，目标 ≥ 99.5%。
6. **回滚耗时**：从发现错误到恢复旧目录入口的时间，目标小于 5 分钟，前提是旧目录快照已保留。

## 失败模式、诊断证据与恢复动作

1. **悬空引用**：迁移后某条目的 `related.target` 无法在任何别名表或墓碑中找到。诊断证据：迁移记录中 `status` 为 `dangling-reference`；恢复动作：将该引用降级为普通文本链接，或人工补全目标实体。
2. **ID 冲突**：两个旧条目声明了相同的旧 ID，但内容不同。诊断证据：别名表插入时报 `duplicate key`；恢复动作：依据创建时间或来源优先级选择主实体，另一个作为历史别名指向主实体，并在记录中标注冲突。
3. **媒体类型丢失**：旧条目没有声明 `content_type`，迁移后默认按 `text/markdown` 处理，导致二进制附件损坏。诊断证据：目标文件校验和不等于原始 Blob 校验和；恢复动作：在旧 schema 中补齐 `media_type` 字段后重新迁移。
4. **部分写入导致索引不一致**：迁移脚本中断后，新目录中部分文件已写入但迁移记录未生成。诊断证据：目标目录存在文件，但 `migrations/` 下无对应批次记录；恢复动作：丢弃目标目录，从快照重新执行迁移，禁止基于不完整状态继续。
5. **枚举值越界**：旧字段值不在新 schema 枚举范围内，例如 `category: legacy/concepts` 对应新枚举只有 `concept`、`task`、`reference`。诊断证据：新 schema 校验失败；恢复动作：标记为 `needs-review`，由治理流程决定是新增枚举值还是映射到最近父类。
6. **路径变更触发缓存失效**：迁移后物理路径变化，但外部系统仍按旧路径请求文件。诊断证据：HTTP 404 或文件系统 `ENOENT` 日志；恢复动作：在入口层维护路径别名映射 30 天，或在构建时生成重定向表。

## 问答测试样例

1. **正向**：旧 ID `legacy-migration-2024` 迁移后的 canonical ID 是什么？
   答案：在别名表中查找 `legacy-migration-2024`，返回 `okf://concept/550e8400-e29b-41d4-a716-446655440000`。该映射以迁移记录为证据。

2. **正向**：迁移后旧引用 `legacy-id-001` 如何表达？
   答案：重写为 `okf://concept/6ba7b810-9dad-11d1-80b4-00c04fd430c8`，关系类型保持 `requires` 不变。

3. **边界**：如果一个旧条目没有 `okf_schema_version` 字段，迁移脚本如何处理？
   答案：默认视为 `v1-legacy`，执行最保守转换；所有字段先按旧 schema 校验，缺失的可选字段使用默认值，缺失的必填字段触发人工审核。

4. **边界**：两个不同旧目录中的文件拥有相同旧 ID 但内容不同，是否都能保留为独立 canonical 实体？
   答案：不能。同一旧 ID 在同一迁移批次中只能映射到一个 canonical ID；必须选择主实体，另一个作为历史别名，并记录冲突。

5. **边界**：迁移后旧物理路径被删除，外部链接如何保持可用？
   答案：必须在入口层维护路径别名或生成重定向表，期限不少于一个发布周期；单靠 canonical ID 无法自动恢复基于路径的访问。

6. **拒答条件**：某条目在迁移后语义是否完全等价？
   如果无法取得迁移前后的 Blob 校验和、解析后结构对比及迁移记录，应回答：无法确认，需要补充 source_hash、target_hash 与 validation 字段后才能判断。

7. **拒答条件**：新 schema 的字段限制是否一定比旧 schema 更严格？
   如果项目未公布新旧 schema 的字段清单与枚举定义，应回答：无法确认；严格性取决于具体字段，不能由“版本号更高”直接推断。

## 维护、版本、来源与相邻主题的关系

迁移脚本本身应纳入版本控制，脚本文件哈希写入迁移记录，确保任何修改都可追溯。Schema 版本采用语义化版本号：主版本号变更表示 ID 或引用模型发生不兼容变化；次版本号变更表示新增可选字段；修订号仅修正文档。每个迁移批次必须声明来源：源目录的 git commit hash、迁移脚本路径与执行者身份。

相邻主题包括：格式验证（负责静态 schema 检查）、引用完整性（负责运行时引用解析与悬空检测）、搜索索引（负责将 canonical ID 与内容暴露给检索器）、访问控制（决定是否允许读取已迁移条目）。格式迁移是这些主题的输入侧，它不提供搜索排序策略，也不决定权限模型，但必须输出可被它们消费的稳定 ID 与规范化内容。

## 结论

**事实**：格式迁移必须在写入新文件前建立旧 ID 到 canonical ID 的别名表；迁移记录保存了源目录哈希、目标目录哈希与脚本哈希；物理路径与 canonical ID 解耦；复制-写入策略可避免半迁移状态。

**推论**：如果严格遵循“先校验旧 schema、再转换、再校验新 schema、最后重建索引”的顺序，迁移后引用解析成功率可以稳定达到 99.9% 以上；采用文件优先架构时，回滚时间主要取决于符号链接或入口配置的切换，而非数据逆向转换。

**未知**：LLM 或其他 Agent 在迁移后读取内容时，是否会将语义等价但表达不同的文本判断为不同含义，取决于具体模型的语义理解策略，本主题无法保证；跨多个 OKF 域的 federation 迁移中，ID 命名空间冲突的协商机制，需要额外的协议设计，目前不在本实现范围内。
