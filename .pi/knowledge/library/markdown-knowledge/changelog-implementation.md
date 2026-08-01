---
type: concept
title: 变更记录：实现视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。让内容读者知道何时、为什么、由谁改变了事实
resource: .pi/knowledge/library/markdown-knowledge/changelog-implementation.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, changelog, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: changelog
variant: implementation
---

# Markdown 知识库变更记录的实现与验证

## 摘要与问题边界

变更记录（change log）在 Markdown 知识库中的目标，是让读者在任意事实断言处都能回答三个问题：何时、为什么、由谁改变了这一事实。本文只讨论可被独立验证的事实变更，例如端口号、依赖版本、CLI 命令、环境变量、配置开关、接口签名。不讨论写作风格调整、拼写修正、段落重排，除非这些修改改变了事实含义。实现边界限定在本地文件知识库与 Web 渲染层之间，不依赖外部工单系统或远程仓库 API；所有外部证据均通过可验证引用标识，无法访问时按“无证据”处理。

## 核心概念与数据模型

1. 变更条目（ChangeEntry）：最小记录单元，字段包括 `changedAt`（ISO 8601 UTC）、`author`（身份标识）、`scope`（作用域）、`action`（`add | update | deprecate | remove`）、`reason`（变更动机）、`beforeValue`（变更前值）、`afterValue`（变更后值）、`evidence`（证据引用列表）。
2. 作用域（Scope）：由文件路径与锚点组成，锚点可以是 heading slug（如 `#build-commands`）或行号范围（`L42-L55`）。作用域必须能在解析时唯一映射到正文中的事实单元。
3. 事实单元（FactUnit）：正文中可被单独引用的断言，例如“开发服务器默认监听 5173”或“构建命令为 `pnpm build`”。事实单元是变更的客体，而非整篇文章。
4. 变更动作（Action）：`add` 表示新增事实；`update` 表示修改事实；`deprecate` 表示事实仍然可见但已标记弃用；`remove` 表示事实从正文中删除。
5. 证据引用（Evidence）：指向可验证来源的元组，包括 `kind`（`commit | issue | test | adr | manual`）、`id`、`url`（可选）、`digest`（校验摘要）。手动证据必须附带审计说明。
6. 校验规则（ValidationRule）：用于在构建阶段拒绝非法变更记录的断言集合，包括必填字段检查、时间单调性、action 与 before/after 一致性、author 白名单、evidence 格式。

## 设计决策与取舍

### 嵌入式 frontmatter 与独立变更文件

将变更记录嵌入每篇 Markdown 的 YAML frontmatter 可降低阅读成本，但会污染 git diff，且难以做跨文件聚合。独立的 `.changes.yml` 文件便于批量校验与聚合渲染，却容易在文件重命名或删除后 orphaned。推荐主知识文件使用独立 `.changes.yml`，并在 frontmatter 中仅保留版本锚点。

### 自动提取与手动声明

Git 的 author 与 commit timestamp 只能回答“谁在什么时候改了文件”，无法回答“谁在什么时候改了哪个事实”。自动提取适合生成候选条目，但必须由内容负责人手动声明 scope 与 reason。未手动审核的自动条目应标记为 `provisional`，在渲染时显示为待确认。

### 粒度选择

按文件级粒度维护成本低，但无法定位具体变更；按行级粒度最精确，却导致维护爆炸。推荐按 heading 级粒度记录，即变更作用域定位到某个 H2 或 H3 下的完整事实块。若一个 heading 内存在多个独立事实，则拆分为子 heading。

### 时区与排序

存储统一使用 UTC，渲染时按客户端时区转换。同一作用域下的变更条目按 `changedAt` 升序排列；若时间戳相同，则按 evidence 中的 commit 序列号或手动审计序号二次排序，保证稳定且可复现。

### 验证时机

提交前校验（pre-commit）可快速反馈，但难以访问完整构建上下文；构建时校验可运行全文一致性检查，但会延长 CI 时间。推荐在本地 pre-commit 做格式校验，在 CI 构建阶段做完整语义校验。

## 可执行的实施流程

1. 定义变更记录 Schema 与对应的 TypeScript 类型，使用 zod 或 valibot 进行运行时校验。
2. 在知识库根目录创建 `changes/` 目录，每篇 Markdown 对应一个同名的 `.changes.yml` 文件。
3. 编写 Markdown 解析器，提取 heading slug、行号范围与 frontmatter 版本锚点。
4. 实现作用域解析器，将 `.changes.yml` 中的 scope 字符串映射为具体文件位置，检测锚点失效。
5. 实现验证器：检查必填字段、时间单调性、action 与 before/after 一致性、author 白名单、evidence 格式。
6. 在构建脚本中注册校验命令，例如 `pnpm validate:changes`，使其在 CI 中失败阻塞。
7. 实现 Web 渲染层：在事实单元附近注入“变更历史”折叠面板，按作用域聚合相关条目。
8. 编写贡献者指南：要求任何改变事实的提交必须附带对应的 `.changes.yml` 条目。
9. 编写单元测试覆盖解析、验证、渲染三个模块，包含正向与错误用例。
10. 设置变更记录健康度看板，监控未解释变更比例与锚点失效率。

## 代码示例

以下是一个贴近本地 Markdown 知识库的 `.changes.yml` 示例及其处理说明。

```yaml
# changes/docs/deployment.changes.yml
schemaVersion: "1.0"
entries:
  - changedAt: "2024-11-08T09:12:00Z"
    author: "dev-x"
    scope: "docs/deployment.md#port"
    action: "update"
    reason: "开发服务器端口从 5173 改为 8080 以规避本地冲突"
    beforeValue: "5173"
    afterValue: "8080"
    evidence:
      - kind: "commit"
        id: "a1b2c3d"
      - kind: "manual"
        id: "adr-0007"
        digest: "sha256:..."
```

输入为 Markdown 文件 `docs/deployment.md` 与 `changes/docs/deployment.changes.yml`。处理流程读取两者：解析 Markdown 得到 heading 与行号映射，校验变更条目的字段、时间单调性、scope 锚点存在性、before/after 链一致性；输出为渲染可用的变更时间线数组，若校验失败则返回带文件路径与字段名的错误数组。

## 性能、质量与可观测性指标

1. 解析耗时：测量每千条变更条目的解析时间，目标小于 50ms；使用 `process.hrtime` 或 `performance.now` 在构建脚本中采样。
2. 验证失败率：在 CI 中统计变更校验失败次数占总提交次数的比例，超过 5% 应触发贡献流程审查。
3. 未解释变更比例：统计 `reason` 为空或长度小于 10 个字符的条目占比，目标低于 10%。
4. 事实一致性：为关键事实单元编写自动化测试，断言正文当前值与最新变更条目的 `afterValue` 一致。
5. 锚点失效率：统计 scope 解析失败的条目数量，目标为零；每周生成一次 orphaned 条目报告。

## 失败模式、诊断证据与恢复动作

1. 锚点失效：诊断证据为验证器报告 `scope not found: docs/deployment.md#port`；恢复动作是更新 scope 为当前 heading slug 或行号范围。
2. 时间戳倒置：诊断证据为同一作用域下后一条目的 `changedAt` 早于前一条目；恢复动作是核查 git 历史或审计记录，修正时间戳。
3. author 无法识别：诊断证据为 author 不在团队白名单；恢复动作是注册新作者或更正拼写。
4. before/after 链断裂：诊断证据为第 N 条目的 `afterValue` 不等于第 N+1 条目的 `beforeValue`；恢复动作是补充中间缺失的变更条目或修正笔误。
5. 文件已删但变更记录残留：诊断证据为 `.changes.yml` 指向不存在的 Markdown 文件；恢复动作是归档或删除该变更文件，并在归档日志中记录原因。

## 问答测试样例

1. 正向：开发服务器现在监听哪个端口？回答应基于正文最新值“8080”，并引用变更条目说明它于 2024-11-08 由 dev-x 从 5173 更新。
2. 正向：谁把默认包管理器从 npm 改为 pnpm？若变更记录存在，回答作者与变更时间；若不存在，回答“无记录”。
3. 边界：同一文件同一天有两条 update 记录，如何确定先后顺序？回答应依据 `changedAt` 的完整时间戳，若时间戳相同则按 evidence 序列号二次排序。
4. 边界：变更记录说端口为 8080，但正文仍为 5173，以哪个为准？回答应以正文当前值为准，并标记该变更记录需要同步更新。
5. 无证据拒答：为什么 dev-x 要改端口？若 `reason` 字段存在则引用；若不存在，必须回答“原因未记录，无法推断”。
6. 无证据拒答：2023 年的变更是什么？若变更记录始于 2024 年，则回答“无 2023 年记录”，不得根据 git log 推测。

## 维护、版本、来源与相邻主题关系

Schema 采用语义化版本管理：v1.0 包含基本字段；v1.1 增加 `deprecate` 动作；v2.0 计划引入证据链完整性校验。变更记录的数据来源包括 git commit、ADR、测试结果与手动审计。与相邻主题的关系：变更记录依赖文档版本控制提供文件级历史，但补充了语义级归因；它与事实核查共享事实单元定义，与 Agent 引用溯源共享 evidence 格式。维护频率应与知识库主版本发布同步，每次发布前运行完整校验。

## 结论

事实：变更记录由 `changedAt`、`author`、`scope`、`action`、`reason`、`beforeValue`、`afterValue`、`evidence` 八个字段构成；作用域解析、时序校验与 author 白名单是构建阶段必须通过的检查。

推论：在 Markdown 知识库中落地该方案后，读者与 Agent 对事实变更的归因能力会显著提升，知识库过时导致的误用风险会下降。

未知：具体团队的贡献节奏、读者对变更时间线面板的实际使用频率、以及按 heading 级粒度是否会在大规模知识库中造成维护负担，均需在实际运行后通过上述指标验证。
