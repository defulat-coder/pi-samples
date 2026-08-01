---
type: concept
title: 生命周期状态：验证与运维视角
description: 用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。区分 active、draft、deprecated 和过期内容的消费策略
resource: .pi/knowledge/library/okf-governance/status-operations.md
tags: [Pi, Agent, Kimi, 知识库, okf-governance, status, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: okf-governance
topic: status
variant: operations
---

# OKF 生命周期状态：active、draft、deprecated 与过期内容的消费策略与运维验证

## 摘要与问题边界

在 OKF-compatible 知识库中，生命周期状态不是元数据的装饰品，而是决定检索器与 Agent 能否消费、如何消费的闸门。active、draf、deprecated 与过期（expired）四个状态共同构成一条从发布到退场的证据链。本文从验证与运维视角出发，记录成功、失败、延迟、容量和恢复证据，避免把一次成功请求当成系统稳定。核心问题是：当同一份知识在不同状态下被并发消费时，如何保证检索结果的可预期性、服务可用性以及状态变更后的快速恢复。

## 核心概念与数据模型

1. `lifecycle_state` 是知识记录的首要维度，取值限定为 `active`、`draft`、`deprecated`、`expired`，状态字段由写入服务在变更事务中强一致更新，禁止消费端自行推断。
2. `active` 表示知识已完成审查、版本锁定并纳入服务等级目标（SLO），可以被检索器和 Agent 默认消费，必须携带 `version_id`、`valid_since` 和 `last_verified_at`。
3. `draft` 表示知识仍在编辑或等待人工审查，仅允许在隔离的预览环境或显式开启 `draft_mode` 的测试请求中消费，生产流量默认不可见。
4. `deprecated` 表示知识内容仍然正确但不再推荐，保留可读性并设置 `deprecated_until` 截止时间，期间必须提供迁移指引或替代 `canonical_id`。
5. `expired` 表示知识已超出可用窗口，默认从消费路径中剔除，但保留原始数据用于审计、合规回放和差分恢复，删除需经物理清除流程。
6. 消费策略（consumption policy）是状态与运行时能力的映射表，包括：默认可见性、缓存失效规则、降级路径、容量配额和告警阈值，策略本身也按版本管理。

## 设计决策与取舍

### 状态机优先于标签组合

采用严格状态机而不是多个布尔标签组合，减少消费端在查询时的组合爆炸。代价是每次状态变更必须走原子事务，短期会增加写入延迟，但换来的是消费端查询条件的确定性和可回滚性。

### 显式截止时间优先于隐式 TTL

`deprecated` 和 `expired` 都携带 `until` 或 `expired_at` 时间戳，而不是依赖缓存层的 TTL。这样检索结果可以精确返回“还有多少秒可用”，便于 Agent 在答案中提示用户；缺点是时间戳必须与时钟同步服务对齐，否则会出现提前或延后失效。

### 软删除而非硬删除

过期知识默认隐藏但不被立即物理删除。运维收益是可以在误操作或合规审计时快速恢复；存储成本通过独立归档桶和压缩策略控制，而非直接抹除。

### 单一注册表与只读副本

状态注册表采用主写多读的架构，写入走强一致主节点，读取通过本地副本加速。trade-off 是副本可能滞后数百毫秒，因此消费端必须在响应头中返回 `registry_lag_ms`，让调用方判断数据新鲜度。

### 乐观消费与强制验证的混合

对 `active` 内容采用乐观消费加后台校验；对 `deprecated` 内容在每次查询时增加一次轻量校验，确认替代版本已存在；对 `draft` 和 `expired` 内容采用强制拒绝，除非请求显式携带 capability token。

## 可执行的实施流程

1. 在 schema 中新增 `lifecycle_state` 字段及必填校验，对 `deprecated` 强制要求 `replacement_id`，对 `expired` 强制要求 `expired_at`。
2. 改造写入流水线：创建时默认 `draft`，审批后转入 `active`，下线时先 `deprecated` 再 `expired`，禁止跳过中间态。
3. 实现注册表查询 API，支持 `filter=state` 和 `include_expired` 两个开关，返回字段必须包含 `state_changed_at` 和 `registry_lag_ms`。
4. 在 Agent 检索层引入 policy engine，根据请求上下文决定可见状态集合，并把最终决策写入日志。
5. 为缓存层增加状态感知：当状态从 `active` 变为 `deprecated` 时触发主动失效，而不是等待 TTL。
6. 接入可观测性：记录按状态分类的 QPS、延迟、错误率和缓存命中率，并绘制状态转换漏斗。
7. 实施混沌测试：随机把若干 `active` 记录置为 `expired`，验证消费端是否在 5 秒内完成降级并返回可解释的错误码。
8. 编写运行手册：包含状态误操作回滚、缓存污染清理、注册表副本延迟修复、过期数据恢复四张检查清单。

## 本地文件知识库的 YAML 示例

    knowledge:
      id: ts-patterns-001
      lifecycle_state: active
      version_id: "2.1.0"
      valid_since: "2025-01-10T00:00:00Z"
      last_verified_at: "2025-08-20T14:32:00Z"
      deprecated_until: null
      expired_at: null
      replacement_id: null
      content_type: markdown
      canonical_path: ./docs/patterns/async-context.md

    consumption_policy:
      default_visible_states: [active]
      preview_states: [draft]
      migration_states: [deprecated]
      require_capability_for: [draft, expired]
      cache_invalidation: on_state_change
      fallback: { state: deprecated, max_age_hours: 168 }

    observed_run:
      request_states: [active]
      registry_lag_ms: 12
      cache_hit: false
      returned_version: "2.1.0"
      latency_p99_ms: 34

输入是知识记录与消费策略；处理过程根据请求上下文过滤状态、检查版本新鲜度并决定缓存策略；输出是允许消费的版本、注册表延迟、缓存命中情况和延迟指标。

## 性能、质量和可观测性指标

- 状态可见性错误率：在采样日志中统计返回了非预期状态记录的请求占比，目标小于 0.01%，通过访问日志中 `actual_state` 与 `expected_states` 的差值计算。
- 按状态 P99 延迟：分别对 `active`、`deprecated`、`draft`、`expired` 查询链路打点，测量从请求到返回首字节的延迟，要求在 `active` 路径上 P99 低于 100ms。
- 缓存状态一致性：对比缓存命中的 `cached_state` 与注册表当前 `registry_state`，计算不一致率，不一致必须触发告警。
- 状态转换耗时：记录从 `draft` 到 `active`、从 `active` 到 `deprecated`、从 `deprecated` 到 `expired` 的各阶段中位时间，用于发现审批瓶颈。
- 恢复时间（MTTR）：当状态误操作导致消费异常时，从告警发生到策略恢复、缓存刷新完成的时间，目标小于 5 分钟。

## 失败模式、诊断证据与恢复动作

- 失效后仍命中缓存：知识已 `deprecated` 但缓存仍返回 `active` 视图。证据是响应头 `registry_state=deprecated` 与 `cached_state=active` 不一致。恢复动作是手动触发 cache purge 并检查失效监听器是否遗漏。
- draft 内容泄露到生产：生产请求未携带 capability 却返回 `draft` 记录。证据是日志中 `capability_token=none` 且 `returned_state=draft`。恢复动作是立即关闭该 API 的默认可见状态，回滚策略版本，并审计请求来源。
- expired 记录被错误索引：搜索引擎仍把 `expired` 文档排在结果前列。证据是索引元数据中 `index_state=expired` 的文档占比上升。恢复动作是重建增量索引，并在索引任务中增加状态过滤断言。
- 注册表副本延迟导致状态不一致：不同实例返回不同状态。证据是 `registry_lag_ms` 超过 500ms 且跨实例对比出现差异。恢复动作是切换读取到主节点、调查副本同步积压。
- 策略引擎崩溃导致全部拒绝：所有状态请求都返回 503。证据是 policy engine 错误日志激增且消费端降级到 deny-all。恢复动作是切换到静态策略文件兜底，并重启引擎。

## 问答测试样例

- 正向问题：当前生产 Agent 可以消费哪些生命周期状态？答案：仅 `active`，除非显式请求 preview。
- 边界问题：一份 `deprecated` 知识在 `deprecated_until` 当天 23:59 是否仍可返回？答案：若当前时间未超过 `deprecated_until` 则允许，但响应中必须附带 replacement 提示。
- 边界问题：如果缓存持有 `active` 版本，而注册表已变为 `expired`，系统优先使用哪个？答案：以注册表为准，缓存应立即失效；若失效失败则返回 409 并提示状态冲突。
- 无证据拒答：能否告诉我某条 `draft` 知识在生产环境中的性能表现？答案：无法回答，因为 `draft` 不应进入生产流量，没有合规的观测证据。
- 无证据拒答：能否判断 `expired` 内容是否一定错误？答案：无法回答，过期只说明可用窗口结束，不直接证明内容错误。
- 恢复类问题：发生缓存污染后如何验证已恢复？答案：检查 `cached_state` 与 `registry_state` 不一致率连续 3 分钟为 0，且采样请求返回的状态符合预期。

## 维护、版本、来源与相邻主题

生命周期状态字段本身跟随知识版本升级。每次 schema 变更需同步更新索引模板、缓存键和策略 DSL。来源信息记录写入者、审批者和自动化检查任务 ID，便于审计。与相邻主题的关系：状态管理依赖“知识来源与信任链”来验证 `active` 的合法性；依赖“检索与排序”来保证 `expired` 不出现在默认结果；依赖“缓存与副本一致性”来落实状态变更后的快速收敛；也影响“Agent 能力鉴权”，因为 `draft` 和 `expired` 的可见性与 capability 绑定。

## 结论

事实：OKF-compatible 知识库通过 `active`、`draft`、`deprecated`、`expired` 四个状态控制消费边界；`active` 可被默认消费，`draft` 需 capability，`deprecated` 在窗口内可读但需提示替代，`expired` 默认隐藏但保留审计。推论：在运维视角下，状态变更必须触发缓存失效、索引重建和延迟观测，否则单点成功无法代表系统稳定。未知：不同检索器对 `deprecated` 的容忍阈值、长文本知识在状态变更后缓存预热的最优策略，以及跨副本注册表在极端分区下的最终一致性边界，仍需要在具体部署环境中通过混沌实验和长期运行数据进一步验证。
