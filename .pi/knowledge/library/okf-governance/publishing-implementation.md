---
type: concept
title: 发布流程：实现视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。把作者草稿、验证、索引编译和线上切换分成清晰阶段
resource: .pi/knowledge/library/okf-governance/publishing-implementation.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, publishing, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: publishing
variant: implementation
---

# OKF 知识库发布流程：从作者草稿到线上切换的实现规范

## 摘要与问题边界

发布流程解决的核心问题是：作者以非结构化或半结构化形式产出的知识单元，如何在进入线上检索与 Agent 消费路径之前，被可靠地校验、编译、打包，并以可回滚的方式切换到目标部署槽。该流程不处理作者创作工具本身，也不承担原始内容的语义正确性仲裁；它只保证输入满足 schema、链接可达、索引完整、切换原子。实施范围限定在本地文件知识库与 Web 侧管理界面触发的 TypeScript 服务内，不包含第三方 SaaS 的写权限集成。

## 核心概念与数据模型

1. DraftConcept：作者原始产物，最小字段包括 `id`、`version`、`locale`、`content`、`references`。`references` 必须是 URI 或相对路径数组，空数组视为合法但需标记为“孤立条目”。
2. ValidationReport：一次校验运行的结构化结果，包含 `passed`、`errors`（带路径定位）、`warnings`、`durationMs`。任何 `error` 都会阻止进入下一阶段；`warning` 仅用于审计。
3. IndexManifest：编译后的索引清单，记录每个概念切片的 `term`、`aliases`、`vectorSignaturePath`、`checksum`、`slot`。它不代表原始 Markdown，而是面向检索器的倒排与向量摘要。
4. PublishBundle：待上线的发布包，是一个不可变目录，包含原始文件副本、IndexManifest、ValidationReport 以及 `bundle.checksum`。发布包按 `{pipelineId}/{timestamp}` 命名，避免覆盖。
5. DeploymentSlot：线上运行时可见的知识库视图，区分 `staging` 与 `production` 两个独立槽位。切换操作只在 `staging` 验证通过后才会向 `production` 推进。
6. AuditLog：每次状态迁移的记录，字段包括 `eventType`、`bundleId`、`fromSlot`、`toSlot`、`operator`、`timestamp`、`traceId`。它是事后排查和合规审计的唯一可信来源。

## 设计决策与取舍

阶段化而非单步原子提交。将“接收—验证—编译—切换”拆成独立阶段，每个阶段写入独立目录，失败时只需重跑当前阶段，而不必回滚作者草稿。代价是磁盘占用增加，但换来了调试清晰度和阶段级缓存。

验证层幂等设计。同一份 DraftConcept 重复提交不会重复产生副作用；验证服务通过 `contentChecksum` 判断是否已经校验过。例外是 schema 版本升级时，历史通过记录需标记为“待重新验证”。

索引编译与原始文件分离。IndexManifest 不嵌入原始内容，而是引用发布包内的原始路径。这样原始文件可独立替换而不重新建索引，但索引与原始文件之间的引用一致性必须在包签名前二次校验。

蓝绿切换而非覆盖。线上切换通过符号链接或配置原子指向新的发布包目录，而不是逐文件覆盖。回滚只需重新指向旧包，但要求旧包在保留窗口期内不被清理。

错误回滚的粒度。验证错误回滚到作者；编译错误回滚到上一次成功发布包；切换错误回滚到上一个 DeploymentSlot。不同阶段的回滚目标不一致，因此每个阶段结束时都要记录当前“可恢复点”。

并发控制采用乐观锁加队列。多个作者同时提交时，先进入 FIFO 队列，每个任务在读取当前 slot 版本后执行，提交时比较版本号。高并发场景下吞吐受队列限制，但避免了分布式锁的复杂部署。

## 可执行的实施流程

1. 接收草稿：API 接收 POST /draft，将原始内容写入 drafts/{conceptId}/{version}/draft.md，返回 draftToken。
2. 格式解析：读取文件扩展名，使用对应解析器（Markdown、YAML、JSON）。扩展名未知时直接返回 400。
3. Schema 校验：对照当前 schema 版本检查必填字段。缺少 `id` 或 `content` 时记录错误并终止。
4. 链接可达性检查：遍历 `references`，解析相对路径并在发布空间内查找。dangling link 计入 error，外部 URI 只校验格式不校验可达性。
5. 语义校验：检查循环引用、重复别名、版本号单调递增。检测到循环引用时给出完整路径。
6. 索引编译：将概念切片生成 term 列表、别名映射、向量签名文件，输出 IndexManifest。
7. 包签名：对原始文件、IndexManifest、验证报告计算总 checksum，生成 PublishBundle 目录。
8. 切换上线：先加载到 `staging` 槽位运行探测，探测通过后原子切换到 `production`，写入 AuditLog。

## 配置与示例

以下展示一次发布的输入、处理与输出示例。

输入：作者提交了一个 Markdown 草稿，文件名为 concepts/publish-flow.md，包含 frontmatter 字段 id、version、tags 以及正文和 references 列表。

处理：服务读取文件，校验 schema，解析 references，生成向量签名并写入 bundles/20260115-001/，最后生成 IndexManifest。

输出：PublishBundle 目录为 bundles/20260115-001/；IndexManifest 路径为 bundles/20260115-001/index.manifest.json；线上 production 槽位指向 slots/production/current -> bundles/20260115-001；AuditLog 记录 eventType 为 slot_switched，bundleId 为 20260115-001，toSlot 为 production。

## 性能、质量和可观测性指标

1. 端到端发布延迟：从接收草稿到切换完成的耗时，目标 P99 小于 30 秒。通过 AuditLog 中 receivedAt 与 switchedAt 差值测量。
2. 验证失败率：每百次提交中因 schema 或链接错误被终止的比例。从 ValidationReport 统计。
3. 索引编译时间：单个概念切片的平均编译耗时。在编译阶段通过计时器记录。
4. 切换失败率：staging 探测通过但 production 切换失败或超时的次数占比。从 AuditLog 的 slot_switch_failed 事件统计。
5. 检索召回率：发布后的 24 小时内，抽样查询命中新发布条目的比例。通过检索器日志与发布清单交叉验证。

## 失败模式与恢复

1. 循环引用：ValidationReport 中 error.type 为 circular_reference，证据为引用路径数组。恢复动作是作者拆分概念或移除反向引用。
2. 缺失必需字段：错误定位到具体字段路径。恢复动作是补充字段并重新提交。
3. 索引损坏：包签名 checksum 与文件实际 checksum 不一致，或索引文件无法被检索器解析。恢复动作是丢弃该包，回退到上一成功包。
4. 切换超时：staging 验证通过但 production 切换耗时超过阈值，AuditLog 中出现 slot_switch_timeout。恢复动作是回滚符号链接并告警。
5. 并发写入冲突：乐观锁版本不一致导致 version_conflict 错误。恢复动作是将任务重新入队，由队列串行化处理。

## 问答测试样例

1. 正向：发布流程包含哪些阶段？答案应列出接收、解析、校验、编译、打包、切换六个阶段。
2. 正向：ValidationReport 中的 error 和 warning 有什么区别？答案应说明 error 阻止流程，warning 仅审计。
3. 边界：references 为空数组时是否合法？答案：合法，但标记为孤立条目。
4. 边界：schema 版本升级后，历史已通过草稿如何处理？答案：标记为待重新验证，不自动跳过。
5. 边界：外部 URI 链接是否要求可达？答案：只校验格式，不校验可达性。
6. 拒答条件：如果 AuditLog 中没有某个 bundle 的切换记录，能否确认它已上线？答案：不能，必须以 AuditLog 为唯一可信来源。

## 维护、版本、来源与相邻关系

发布流程的 schema 版本应独立于代码版本，通过 .pi/schema-version 文件管理。每次 schema 升级必须附带迁移脚本，将历史发布包重新标记为“待重新验证”。旧发布包保留策略默认 30 天，可通过配置调整。该流程与“知识检索”相邻：检索器消费 IndexManifest，但不关心原始文件如何产生；与“权限管理”相邻：切换操作需要 operator 签名，但权限检查由 API 层负责，不在发布流程内部实现。

## 结论

事实：发布流程将作者草稿到线上切换划分为独立阶段；错误分为可恢复警告和阻断错误；AuditLog 是切换事件的唯一可信记录。
推论：阶段化设计在长期维护中会降低调试成本；蓝绿切换能在秒级完成回滚。
未知：在超过万级概念切片的单体知识库中，索引编译的单机瓶颈具体出现在哪一环节，需要实际基准测试确定。
