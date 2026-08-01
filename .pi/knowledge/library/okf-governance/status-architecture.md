---
type: concept
title: 生命周期状态：架构视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。区分 active、draft、deprecated 和过期内容的消费策略
resource: .pi/knowledge/library/okf-governance/status-architecture.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, status, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: status
variant: architecture
---

# OKF 知识治理中的生命周期状态：边界、接口与消费策略

## 摘要与问题边界

生命周期状态是知识治理的第一道边界机制。它回答的不是“内容是否正确”，而是“这份内容在当前治理体系下应当被谁、以何种方式、在什么时间内消费”。在 OKF-compatible 的知识库中，active、draft、deprecated、expired 四个状态将作者、策展者、检索运行时与最终消费者拆分为四个独立的责任域。本节的边界是：只讨论状态机本身、状态与消费策略的合约接口、以及检索和 Agent 引用时的行为规则；不讨论具体审核流程、自动语义质量评分，也不讨论渲染层 UI 的展示样式。

## 核心概念与数据模型

1. 状态原子：active 表示已被策展且处于正常消费窗口；draft 表示内容已创建但尚未完成策展、未进入公开消费索引；deprecated 表示内容仍被允许消费，但已被官方声明为不再推荐，通常伴随替代链接；expired 表示内容已超出有效时间窗口，默认应拒绝直接消费，仅保留历史或审计用途。

2. 状态转换图：draft 经策展审批后进入 active；active 可经显式决策进入 deprecated；deprecated 在到达 expiryDate 后进入 expired；expired 在治理允许下可转为 archived 或 tombstone。不允许从 expired 直接回滚为 active，必须先创建新版本并重新走策展流程。

3. 版本与状态解耦：状态不是内容字段的可覆盖值，而是绑定到具体版本的元数据。一份文档可以有多个版本同时存在，其中 v1.2 为 deprecated，v2.0 为 active，v1.1 为 expired。运行时通过 (id, version, status) 三元组定位内容。

4. 消费策略合约：策略由 PolicySelector 接口决定，常见策略包括 defaultOnlyActive、allowDraftWithOptIn、warnOnDeprecated、denyExpiredWithRedirect。策略只声明行为，不声明内容正确性。

5. 责任边界：作者负责把内容写入 draft；策展者负责将 draft 转为 active 或标记 deprecated；运行时负责根据状态与策略决定返回、警告或拒绝；消费者只能看到策略允许的内容，除非显式声明 opt-in 上下文。

6. 时间维度：effectiveDate 声明生效起始；deprecationDate 声明进入 deprecated 的起始；expiryDate 声明 expired 的起始；reviewDueDate 用于主动提醒策展者复审。时间采用 wall-clock 与 logical-clock 双轨：状态机以 wall-clock 触发，但版本比较使用逻辑版本号。

7. 可替换接口：StatusResolver 负责把状态映射为当前允许行为；TransitionValidator 负责校验状态转换是否合法；PolicySelector 负责根据调用方上下文选择策略；ExpiryEnforcer 负责定时触发 expired 转换。这些接口都必须是可替换的，以便不同治理策略可以注入。

8. 索引与召回：检索层必须将状态作为可过滤字段写入索引，字段名固定为 `status` 与 `effectiveDateRange`，但消费策略在查询返回后由运行时再次评估，避免索引层越权决策。

## 设计决策与取舍

### 状态与版本是否绑定

选择绑定。如果将状态设计成内容实体的可变字段，作者修改后旧版本会“自动”变成 active，导致历史引用失效。绑定到版本后，引用某版本时状态不可变，Agent 引用可得到稳定答案。代价是索引需要保留多版本，但这一点通过时间窗口裁剪可控制。

### 过期策略：硬拒绝还是软降级

默认采用硬拒绝，仅对明确配置 legacy-access 的上下文允许软降级。硬拒绝使过期内容不会污染新系统决策；软降级用于迁移窗口，但必须在日志中标记为 expired-consumed。边界例外：如果替代版本不存在，则进入手动审批队列，而不是自动允许消费。

### 草稿可见性：统一索引还是命名空间隔离

默认隔离。draft 内容不得进入 public search index，只能通过作者工作区或策展审批接口访问。这样可以避免检索器把未完成内容召回给普通 Agent。如果项目启用 peer-review 模式，可配置 allowDraftInOptInContext 策略，此时索引仍不包含，但持有 opt-in 令牌的消费端可请求。

### deprecated 的消费策略：仅提示还是链接替换

策略选择“提示并替换”。返回 deprecated 内容时，响应头或元数据必须携带 `successor` 字段指向 active 替代版本。这样 Agent 可以在回答中说明“该文档已废弃，当前推荐参考 v2.0”。如果替代版本不存在，则降级为“提示但不阻止”。

### 来源继承与镜像

canonical 来源的状态是权威来源，mirror 或 fork 来源必须继承 canonical 状态，但允许携带自己的 `syncedAt` 与 `localOverride`。本地覆盖只能覆盖展示策略，不能覆盖状态本身。这样防止镜像站点因同步延迟而展示过期内容。

### 时间模型：wall-clock 与逻辑版本

状态转换使用 wall-clock 触发，例如 cron 在每日 00:00 检查 expiryDate。但并发写入时以版本号仲裁，避免时间戳回拨导致状态回滚。日志中同时记录 `transitionTime` 与 `appliedVersion`，便于审计。

## 可执行的实施流程

1. 建立项目术语表：定义 active、draft、deprecated、expired 的精确判定条件，写入 `AGENTS.md` 或 `.pi/knowledge/governance.md`，并注册为 OKF concept。

2. 设计状态机 JSON Schema：定义状态枚举、转换边、时间字段、策略字段，作为 `packages/contracts` 的共享 DTO。

3. 实现版本实体与状态元数据分离：在存储层中，content 记录与 status 记录使用相同 id 但不同 key 或表，确保状态不可被内容更新覆盖。

4. 实现可替换接口：在 `packages/pi-agent` 中定义 `StatusResolver`、`PolicySelector`、`TransitionValidator` 的 TypeScript 接口，并提供默认实现。

5. 配置索引与召回：在检索索引中加入 `status` 和 `effectiveDateRange` 字段；检索器返回结果后，再调用 `PolicySelector` 进行二次判定。

6. 配置策略上下文：为 Web 普通用户、内部 Agent、迁移工具分别建立不同的 `consumptionPolicy` 配置，存储在仓库配置文件中。

7. 建立观测与审计：所有状态转换写入只读审计日志，包含 actor、previousStatus、newStatus、version、reason。

8. 渐进上线：先对新增内容启用状态机，存量内容默认标记为 active 并设置 reviewDueDate；然后启用 deprecated 与 expired 的定时任务；最后接入检索与 Agent 引用。

9. 回滚测试：在 staging 环境构造 draft、deprecated、expired 样本，验证检索器、API 与 Agent 响应行为符合预期。

## 示例：本地文件知识库的 JSON 配置与处理

下面是一个本地 Markdown 知识库中某条目的状态配置示例。输入是文件 `docs/caching.md` 的 Frontmatter 与仓库级策略配置。处理流程由 `StatusResolver` 读取 effectiveDate 与 expiryDate，结合调用方上下文决定消费结果。

    {
      "id": "docs/caching",
      "version": "v2.1.0",
      "status": "deprecated",
      "effectiveDate": "2025-01-10",
      "deprecationDate": "2025-11-01",
      "expiryDate": "2026-05-01",
      "successor": "docs/caching-v3",
      "consumptionPolicy": {
        "default": "allowWithWarning",
        "draftVisibility": "namespace",
        "expiredAction": "denyAndRedirect"
      },
      "sources": [
        { "role": "canonical", "uri": "docs/caching.md" },
        { "role": "mirror", "uri": "mirror/docs/caching.md", "syncedAt": "2025-11-02T00:00:00Z" }
      ]
    }

输入是文件元数据与调用方上下文。处理时，StatusResolver 检查当前时间：若处于 deprecationDate 之后、expiryDate 之前，则状态为 deprecated；PolicySelector 发现调用方未声明 opt-in 且默认策略为 allowWithWarning，于是返回内容并在响应中附加 `successor` 警告。输出是：Agent 可以引用正文，但必须在回答中说明“该版本已废弃，建议迁移到 docs/caching-v3”。如果当前时间已超过 expiryDate，则输出为拒绝与重定向，正文不进入回答。

## 性能、质量、可观测性指标

1. 状态命中率：在检索结果中，按 status 统计 active、deprecated、expired 被消费的次数。测量方式是在 API 层记录每次返回的 `resolvedStatus`，按小时聚合到日志。

2. 过期内容泄漏率：监控返回的 expired 内容占比。正常应为 0，除非处于 legacy-access 窗口。测量方式是扫描响应日志中 `status=expired` 且 `policyAction≠deny` 的条目。

3. 状态转换延迟：从 deprecationDate 或 expiryDate 到达，到实际状态更新生效的时间差。测量方式是对比审计日志中的 `scheduledTime` 与 `appliedTime`，要求 p99 小于 1 分钟。

4. 草稿误入公开索引率：扫描公开检索索引，检查是否包含 `status=draft` 的条目。目标为 0，通过每日巡检任务测量。

5. deprecated 消费中的警告覆盖率：对返回 deprecated 内容的响应，检查是否包含 `successor` 字段。目标 100%，由响应 schema 校验器测量。

6. 策略一致性错误数：同一 (id, version) 在不同调用方上下文下得到冲突的消费决策次数。测量方式是对运行时返回结果做一致性抽样，对冲突事件告警。

## 失败模式

1. 时间漂移导致过期内容提前或延后暴露。诊断证据：审计日志中 `appliedTime` 与 `scheduledTime` 差值异常，或响应中 `status` 与 wall-clock 不符。恢复动作：重新同步 NTP，手动触发状态重算，并检查定时任务是否遗漏。

2. 状态索引与运行时状态不一致。诊断证据：检索器返回 `status=active`，但运行时评估为 `deprecated`。恢复动作：先以运行时为准拒绝错误结果，然后重建索引并校验版本号。

3. 草稿泄漏到公开索引。诊断证据：公开搜索日志中出现 `status=draft`。恢复动作：立即从索引中移除，并检查写入管道是否跳过了 PolicySelector 的二次过滤。

4. deprecated 内容无 successor 导致 Agent 引用误导。诊断证据：deprecated 响应缺少 `successor` 字段，或 successor 指向自身。恢复动作：触发策展任务补全 successor，并更新内容验证规则。

5. 策略配置被错误地应用到生产环境。诊断证据：普通用户上下文返回了 draft 内容，或 expired 内容被允许。恢复动作：回滚配置文件，启用只读策略校验，对异常响应做审计。

## 问答测试样例

1. 正向问题：某文档 v2.0 状态为 active，当前时间在 effectiveDate 之后，调用方为普通 Agent。期望回答：返回正文，不附加废弃警告。

2. 正向问题：某文档 v1.2 状态为 deprecated，successor 指向 v2.0，调用方默认策略为 allowWithWarning。期望回答：返回正文，并明确提示存在更推荐的 v2.0。

3. 边界问题：当前时间恰好等于 expiryDate。期望回答：按 expired 处理，因为状态转换采用闭区间右端点，过期时间包含边界点。

4. 边界问题：某文档状态为 draft，但调用方持有 opt-in 令牌。期望回答：在 opt-in 上下文中允许消费，但索引中仍不召回，响应头标记为 draft-consumed。

5. 边界问题：某 deprecated 文档的 successor 指向的版本本身也是 expired。期望回答：拒绝直接引用，并进入策展队列，因为 successor 链失效。

6. 无证据拒答：用户询问“某文档何时被 deprecated”。如果审计日志中无 `deprecationDate` 且状态字段不存在，则回答：依据当前可验证数据，无法确认该文档是否进入 deprecated 状态，需要补充审计记录或策展元数据。

## 维护、版本、来源与相邻主题

维护策略：每个 active 内容必须设置 `reviewDueDate`，默认 12 个月；到期未复审则自动降级为 deprecated。版本管理采用语义化版本，状态变更必须通过版本升级或状态转换事件，不允许原地修改状态。来源字段必须声明 canonical 与 mirror，并记录 `syncedAt`。相邻主题包括：知识检索与召回策略、来源可信度评分、内容质量评估、变更审批工作流。生命周期状态本身不评分质量，只决定消费入口；它依赖来源治理提供权威信息，也依赖质量评估触发 deprecated 决策。

## 结论

事实：生命周期状态是一个由 active、draft、deprecated、expired 组成的状态机，状态绑定到版本而不是内容本身，消费策略通过可替换接口决定运行时的返回、警告或拒绝行为。推论：将状态与版本解耦、将索引过滤与运行时二次判定分离，能够在长期演进中防止过期内容污染 Agent 回答，同时保留迁移与历史审计的灵活性。未知：不同组织的内容复审周期、deprecated 到 expired 的宽限期、以及 mirror 站点同步延迟的最大可接受值，需要根据各自领域风险容忍度在项目中单独验证，而不是由生命周期状态机制本身预先决定。
