---
type: concept
title: 政策说明：验证与运维视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。明确适用范围、例外、审批人和不允许的解释空间
resource: .pi/knowledge/library/markdown-knowledge/policy-operations.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, policy, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: policy
variant: operations
---

# Markdown 知识库政策说明：验证与运维视角

## 摘要与问题边界

政策说明是一份强制性的元数据约束，用于规定 Markdown 知识条目在何时、由谁、以何种例外条件生效。本文只讨论**本地文件型 Markdown 知识库**中的政策声明机制，不覆盖 Wiki、Confluence 或外部 SaaS。核心矛盾是：知识作者希望表达灵活，而运维工程师需要把“允许/不允许”精确收敛到可校验的布尔结果。因此，政策说明必须明确适用范围、例外清单、审批人，并消除解释空间。

## 核心概念与数据模型

1. **政策主体（Policy Subject）**：被约束的 Markdown 文件或目录，通过 `policy.scope` 字段声明，例如 `scope: "pi-agent/*"`。
2. **生效版本（Effective Version）**：政策与知识条目版本必须同时锁定，使用 Git 提交哈希或语义版本号，禁止单独使用“最新版”这类动态描述。
3. **适用范围标签（Scope Tag）**：必填字段，至少包含一个环境维度（如 `prod`、`dev`、`ci`）和一个功能维度（如 `runtime`、`contracts`）。
4. **例外条目（Exception Entry）**：显式枚举所有例外，并附带 `exception.id`、`exception.expires`、`exception.approved_by`。未列出的情况一律视为不允许。
5. **审批人身份（Approver Identity）**：使用可验证标识，如邮件地址、GPG 指纹或组织 SSO ID，禁止只写姓名或“负责人”。
6. **证据链接（Evidence Link）**：指向测试日志、容量报告、故障复盘或自动化检查结果的本地相对路径，例如 `evidence: "./logs/adr-0001-capacity.md"`。
7. **审计时间戳（Audit Timestamp）**：记录政策应用、校验和变更的时间点，格式为 RFC 3339，由校验工具写入，不接受手写时间。

## 设计决策与取舍

### 显式枚举优于隐式推断
所有允许行为和禁止行为必须显式写在 Markdown 元数据中，不允许通过自然语言“可推断”。例如，不写“一般不允许”，必须写成“允许：false”。

### 拒绝模糊副词
禁用“通常”“可能”“尽量”等副词。校验器维护一个禁用词表，命中即报错。如果业务需要模糊性，则走例外流程，而不是保留在正文里。

### 审批人与作者分离
政策作者、知识作者、审批人三者不可相同。审批人必须属于运维或 SRE 角色，以确保恢复动作有人背书。

### 例外必须设过期时间
任何例外都附带 `expires` 字段，默认不超过 90 天。过期未续签的条目在 CI 阶段直接失败。

### 证据必须可本地复现
所有证据链接指向仓库内文件或本地构建产物，不能是临时 URL。运维工程师在断网环境下仍能验证。

### 校验失败即阻塞
采用 fail-closed 策略。只要政策校验报错，相关 Markdown 文件就不得进入发布分支，避免“先看一次成功请求”就上线。

## 可执行的实施流程

1. 盘点现有 Markdown 文件，建立清单 `docs/knowledge-index.json`。
2. 制定范围分类表，定义 `scope` 的合法取值与组合规则。
3. 为每份文件补齐 `policy` 前置元数据，缺省值统一标记为 `draft`。
4. 实现校验脚本 `scripts/verify-policy.ts`，覆盖字段、禁用词、例外过期、证据存在性。
5. 在 `pnpm lint` 中集成校验脚本，确保本地即可触发。
6. 配置 CI 流水线，校验失败时阻止合并，并输出 SARIF 格式报告。
7. 建立例外审批工单模板，记录申请人、理由、过期日、审批人签名。
8. 运行为期两周的灰度期，期间只告警不阻断，收集误报率。
9. 灰度结束后切换为阻塞模式，并写入运行手册。
10. 每月执行一次政策审计，检查过期例外、缺失证据、未关联的变更。

## YAML 示例：本地文件知识库中的政策记录

```yaml
# docs/policies/pi-agent-capacity.policy.yaml
policy:
  id: "POL-2025-003"
  subject: "docs/pi-agent/runtime/capacity.md"
  version: "v2.1.0+sha.a1b2c3d"
  scope:
    env: ["prod", "staging"]
    component: ["pi-agent"]
  allowed:
    - "单会话内存上限 512 MiB"
    - "并发会话数不超过 100"
  disallowed:
    - "在生产环境关闭内存回收"
    - "超过 100 并发且无队列限流"
  exceptions:
    - id: "EXC-2025-003-1"
      reason: "压测窗口临时放宽并发"
      expires: "2025-09-30T00:00:00Z"
      approved_by: "sre-lead@example.com"
      evidence: "./evidence/load-test-2025-08.md"
  approver: "sre-lead@example.com"
  evidence:
    - "./logs/capacity-test-2025-08-01.jsonl"
    - "./adrs/0002-capacity-limits.md"
```

输入：仓库内的 YAML 政策文件与对应的 Markdown 知识文件。处理：TypeScript 校验脚本读取 YAML，检查 `scope` 合法性、`approved_by` 是否属于审批人白名单、`evidence` 文件是否存在、`exceptions` 是否过期。输出：通过时写入 `policy.verified_at` 时间戳与 `verification_hash`；失败时返回包含文件路径、错误码、修复建议的 JSON 报告，CI 据此阻断合并。

## 性能、质量和可观测性指标

1. **政策覆盖率**：已声明政策的 Markdown 文件数 / 总数，目标 ≥ 95%。通过 `scripts/knowledge-index.ts` 统计。
2. **校验通过率**：每次 CI 运行中通过校验的政策文件比例，目标 ≥ 99%。
3. **平均校验延迟**：单文件校验耗时，目标 < 50 ms，使用 `process.hrtime.bigint()` 测量。
4. **例外占比**：处于生效状态的例外数 / 政策总数，目标 < 5%，反映解释空间的收紧程度。
5. **证据缺失率**：`evidence` 链接失效的政策占比，目标 = 0%，通过校验器自动检测。
6. **恢复耗时（MTTR）**：从发现政策违规到修复并重新校验通过的平均时间，目标 < 30 分钟。

## 失败模式、诊断证据与恢复动作

1. **缺少 scope 标签**
   - 诊断证据：校验器报错 `ERR_SCOPE_MISSING`，SARIF 指向文件首行。
   - 恢复动作：补充 `scope.env` 与 `scope.component` 后重新提交。

2. **未审批的例外**
   - 诊断证据：存在 `exceptions` 但 `approved_by` 不在白名单，或缺少 GPG 签名。
   - 恢复动作：由 SRE 审批人补签，或删除例外并修改正文为完全不允许。

3. **例外过期**
   - 诊断证据：`exception.expires < now`，CI 报 `ERR_EXCEPTION_EXPIRED`。
   - 恢复动作：续签并更新证据，或移除该例外并回滚对应配置。

4. **证据链接失效**
   - 诊断证据：校验器无法解析相对路径，文件不存在。
   - 恢复动作：补全证据文件，或改用不可辩驳的自动化报告路径。

5. **审批人身份模糊**
   - 诊断证据：`approver` 字段只有中文姓名或职位。
   - 恢复动作：改为邮件地址或 SSO ID，并在审批人白名单注册。

6. **自然语言残留解释空间**
   - 诊断证据：命中禁用词表，如“可以”“建议”“视情况而定”。
   - 恢复动作：改写为布尔判定，或把柔性规则移到已审批的例外条目中。

## 问答测试样例

1. **正向**：这份政策是否允许生产环境关闭内存回收？
   - 答案：不允许，因为 `disallowed` 列表明确禁止。
2. **正向**：压测窗口内的并发放宽是否有效？
   - 答案：有效，但仅在 `EXC-2025-003-1` 过期前，且需 `./evidence/load-test-2025-08.md` 存在。
3. **边界**：staging 环境是否受 512 MiB 内存限制？
   - 答案：受限制，`scope.env` 包含 `staging`。
4. **边界**：`docs/web/ui.md` 是否适用本政策？
   - 答案：不适用，因为 `subject` 只指向 `docs/pi-agent/runtime/capacity.md`，其他文件需各自声明。
5. **无证据拒答**：该政策是否允许使用 200 并发会话？
   - 答案：无法回答；当前政策与例外均未覆盖此数值，应视为不允许，除非新增经审批的政策修订。
6. **无证据拒答**：审批人是否同意了永久例外？
   - 答案：无法回答；本政策要求所有例外必须设 `expires`，不存在永久例外这一类别。

## 维护、版本、来源和与相邻主题的关系

政策说明的维护节奏与代码版本同步。每次修改需提交 PR，附带 `policy.version` 变更和审计记录。版本格式采用 SemVer，重大变更升级主版本。来源可追溯至 `docs/policies/` 目录与 Git 提交历史。与相邻主题的关系如下：

- **ADR（架构决策记录）**：ADR 解释“为什么”，政策说明解释“允许什么”；ADR 可作为 `evidence` 引用。
- **运行手册**：运行手册描述具体操作，政策说明提供操作边界；运行手册中的步骤必须被政策覆盖。
- **Skills 与 Prompts**：`.pi/skills` 与 `.pi/prompts` 中的 Markdown 也可纳入本政策约束，视 `scope` 而定。

## 结论

- **事实**：政策说明必须显式声明 scope、例外、审批人和证据，且校验失败会阻塞发布。
- **推论**：通过禁用模糊词、强制例外过期和审批人身份校验，可以显著降低解释空间，并提升故障恢复的可验证性。
- **未知**：不同团队对“解释空间”的容忍度尚未量化；长期运行后，政策覆盖率与工程师写作负担之间的最佳平衡点仍需通过实际数据确定。
