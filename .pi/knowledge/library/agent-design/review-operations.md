---
type: concept
title: 人工复核：验证与运维视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。高风险答案如何在流式体验中保留审核、拒绝和追问入口
resource: .pi/knowledge/library/agent-design/review-operations.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, review, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: review
variant: operations
---

# 高风险流式答案的人工复核：在 Pi Agent Web 交互中保留审核、拒绝与追问入口

标签：Agent 设计范式，人工复核，流式审核门，运维可观测性，Pi Agent，OKF-compatible

## 摘要与问题边界

在 `apps/web` 与 `apps/api` 的 SSE 会话中，Pi 模型通过 `message_update` 文本增量持续输出答案。当增量内容涉及删除文件、修改关键配置、暴露凭证、生成不可验证的命令，或援引 `.pi/knowledge` 中未命中的知识时，必须在不破坏流式体验的前提下保留三类入口：审核者介入、立即拒绝、用户追问。本概念只处理答案内容的风险分段与人工复核状态机，不处理提示词注入的输入侧检测，不替代法律合规审批流程，也不改变本仓库在 `AGENTS.md` 中约定的“仅暴露 `read` 与 `search_knowledge`”这一只读工具边界。

## 核心概念与数据模型

1. `RiskSegment`：一段带有独立 `segmentId` 的流式文本块。边界以语义完整性为准，优先在整句、整行代码或完整列表项处切分，避免在 token 中间截断导致审核者失去上下文。
2. `RiskScore`：由服务端分类器给出的结构化评分，字段包括 `class`（如 `destructive_command`、`credential_leak`、`unverified_fact`）、`score`（0–1）、`evidence`（触发原文片段）与 `classifier_version`。
3. `ReviewGate`：位于 `apps/api` SSE 输出管道中的状态机，每段状态为 `open|held|released|rejected`。设计约束为同一 `sessionId` 同一时刻只能有一个 `held` 段，防止并发审核冲突。
4. `Verdict`：人工或自动审核结果，字段 `decision ∈ {approve, reject, ask}`、`reviewer`（用户自审或运维账号）、`reason`（必填，不少于 10 个字符）、`timestamp`。`ask` 表示不释放原文，而是生成追问提示进入新一轮模型回答。
5. `AuditTrail`：追加写入本地审计日志 `logs/review/YYYY-MM-DD.ndjson` 的不可变记录，包含原始 `traceId`、模型名、分类器版本、`ReviewGate` 状态转换序列与最终 `Verdict`。
6. `RecoveryCheckpoint`：会话在 `held`、`released`、`rejected` 状态变更时生成的快照，持久化到 `SessionManager.inMemory()` 之外的可恢复存储。`apps/api` 进程崩溃或滚动重启后，通过 `loadCheckpoint` 恢复未完结的 `held` 段与待追问状态。

## 设计决策与取舍

### 审核触发位置放在 API 层而非客户端
客户端不持有模型输出元数据，也无法验证分类器版本与证据真伪。由 `apps/api` 在转发 `message_update` 前注入 `risk` 字段，客户端只负责渲染与收集用户反馈。代价是 API 必须对硬截断类高风险段做少量缓冲，首段延迟通常增加 10–40 ms。

### 硬截断与软降级并存
`destructive_command` 与 `credential_leak` 采用硬截断：不继续发送后续 token，直至 `Verdict` 到达。`unverified_fact` 采用软降级：继续流式输出，但在 UI 上以可折叠警告条标记“内容待复核”。前者损失流畅性但阻断不可逆操作，后者保留吞吐量但要求用户明确点击“我已确认”。

### 单段并发而非全会话阻塞
设计为单段 `held`，同一会话的其他低风险段仍可并行输出。这样避免一次高风险回答拖垮整个多轮对话；代价是分类器必须具备上下文窗口能力，否则会出现“分段无害、整体有害”的绕过。

### 用户追问作为独立 `ask` 裁决
`Verdict.decision=ask` 不释放原文，而是构造系统提示返回给模型，触发新一轮模型回答。每段追问上限为 3 次，超过自动降级为 `reject`，防止模型与用户之间无限拉锯。追问提示模板由 `.pi/prompts` 维护，需与模型版本同步回归。

### 审核队列容量与背压
`ReviewGate` 使用有界队列，默认最多 100 个 `held` 段。队列满时新到达的高风险段返回 `service_overload` 事件，并建议客户端重试或降低模型温度。该策略优先保证 API 可用性，代价是高峰时段人工复核覆盖率会下降，需通过指标监控并告警。

## 可执行实施流程

1. 在 `packages/pi-agent` 定义 `RiskSegment`、`RiskScore`、`ReviewGate`、`Verdict` 的 TypeScript 类型，并导出 JSON Schema 到 `packages/contracts`。
2. 在 `apps/api` 的 SSE 转发中间件中接入分类器，对每段文本计算 `RiskScore`。
3. 在 `apps/api` 配置风险类到动作的映射表：硬截断类进入 `held`；软降级类标记 `flagged` 并继续流式。
4. 实现 `POST /api/sessions/{id}/segments/{segId}/review` 裁决接口，校验请求者身份、`held` 状态与 `reason` 非空。
5. 在 `apps/web` 聊天组件渲染审核横幅：显示风险类、证据片段、批准/拒绝/追问按钮，并绑定 `data-testid="review-banner"` 便于端到端测试。
6. 实现 `message_update` 子类型 `review_verdict`，向客户端广播裁决结果，触发 UI 释放原文或显示拒绝占位文本。
7. 配置 `logs/review/*.ndjson` 按日滚动，设置 0644 权限并限制只有 API 进程可写，Web 进程只读。
8. 在 `SessionManager` 中添加 `persistCheckpoint` 与 `loadCheckpoint` 钩子，覆盖进程重启场景。
9. 使用 k6 或 Artillery 模拟 50 并发会话、10% 高风险输出，验证 gate 延迟、队列背压与拒绝到重答延迟。
10. 在 CI 中运行 `pnpm typecheck`、`pnpm test` 与针对 review 接口的契约测试，确保 `ReviewGate` 状态迁移不会被重构破坏。

## 本地文件知识库示例

输入：`apps/api` 从 `packages/pi-agent` 收到一条模型增量，内容建议执行 `rm -rf node_modules && pnpm install`。

处理过程：分类器识别到 `rm -rf` 模式与文件删除上下文，生成 `RiskScore{class: destructive_command, score: 0.91, evidence: "rm -rf node_modules"}`。`ReviewGate` 将 `segmentId=seg-42` 状态置为 `held`，停止向 `apps/web` 转发后续 token，同时写入审计日志与恢复检查点 `cp-12`。

输出：客户端收到的事件负载如下。

    {
      "event": "message_update",
      "segmentId": "seg-42",
      "sessionId": "sess-7f3a",
      "delta": {
        "type": "risk_hold",
        "content": "[该段内容已暂停，等待复核]",
        "reviewUrl": "/api/sessions/sess-7f3a/segments/seg-42/review",
        "risk": {
          "class": "destructive_command",
          "score": 0.91,
          "evidence": "rm -rf node_modules"
        }
      },
      "audit": {
        "traceId": "trace-9c1",
        "model": "default",
        "checkpoint": "cp-12"
      }
    }

用户点击“追问”后，接口返回 `Verdict{decision: ask, reason: "请说明是否会误删 pnpm-lock.yaml 或 .env"}`，模型收到系统提示并重新生成更安全的分步命令。

## 性能、质量和可观测性指标

1. Gate 注入延迟 P99：从模型输出到事件携带 `risk` 字段到达客户端的时间，目标 < 50 ms。测量点位于 `apps/api` SSE 中间件前后，通过 OpenTelemetry span 采集。
2. 误拦截率：被 `held` 后经人工或基准判定为安全的段占比，目标 < 5%。通过每周抽样 `logs/review/*.ndjson` 与运维回放脚本计算。
3. 审核队列深度：`ReviewGate` 当前 `held` 段数量，暴露为 Prometheus 风格指标 `review_gate_held_total`，告警阈值设为默认容量的 80%。
4. 拒绝到重答延迟：从 `reject` 裁决到客户端显示替代内容的耗时，目标 < 200 ms。在浏览器端通过 Performance API 打点。
5. 恢复一致性：API 进程重启后，`held` 段与未完结追问的恢复成功率，目标 ≥ 99.9%。通过 `kill -HUP` 与 `kill -9` 演练验证。
6. 覆盖率：实际经过 gate 的高风险输出占分类器判定高风险总数的比例，目标 ≥ 99%。对比审计日志与分类器输出计数，差值即为绕过或丢段。

## 失败模式、诊断证据与恢复动作

1. 分类器误报导致会话长时间挂起。诊断证据：`score` 高但 `evidence` 为空或不相关，审计日志中 `held` 时长超过 30 s 且无裁决。恢复动作：运维通过管理接口强制释放，并下调该类 `threshold`。
2. 裁决服务不可用。诊断证据：客户端点击审核按钮后 5 s 内无 `review_verdict` 事件，服务端返回 503。恢复动作：降级为自动规则放行，`destructive_command` 与 `credential_leak` 除外，并记录 `auto_release` 审计。
3. 客户端未渲染风险横幅。诊断证据：Web 日志显示收到 `risk_hold`，但 DOM 中不存在 `data-testid="review-banner"`。恢复动作：回滚 `apps/web` 到上一稳定版本，并补充 Playwright 端到端测试。
4. 审计日志写入失败。诊断证据：`logs/review/` 目录新增文件大小为 0 或权限为 777。恢复动作：切换审计输出到备用路径，修复文件权限，使用 `rsync` 回填缺失记录。
5. 追问次数耗尽引发死循环。诊断证据：同一 `segmentId` 出现 4 次及以上 `decision=ask`。恢复动作：自动强制 `reject` 并告警，检查 `.pi/prompts` 中的追问模板是否过度鼓励反问。
6. 恢复检查点丢失。诊断证据：进程重启后 `held` 段变为 `open` 且客户端收到未审核文本，或 `checkpoint` 文件校验失败。恢复动作：启动时扫描所有会话状态，对无检查点的 `held` 段统一 `reject` 并返回安全占位文本。

## 问答测试样例

1. 正向问题：用户问“如何用 pnpm 清理并重新安装依赖？”
   预期：模型建议 `rm -rf node_modules` 时被 `held`，UI 显示审核横幅，用户可批准、拒绝或追问。
2. 边界问题：用户问“pnpm dev 启动端口冲突怎么办？”
   预期：分类器判定为低风险，`message_update` 正常流式输出，无 gate 介入。
3. 无证据时的拒答条件：用户问“当前生产环境有多少活跃会话？”
   预期：模型无法通过 `read` 或 `search_knowledge` 获得实时数据，应回答“我没有相关证据”并拒绝编造，不触发复核。
4. 跨段累积风险：用户先问文件结构，再问删除命令，两段单独低风险但组合后触发 `destructive_command`。
   预期：分类器启用上下文窗口，第二段 `score` 提升并进入 `held`。
5. 裁决后追问：用户批准删除建议后点击追问“会误删 .env 吗？”
   预期：`Verdict{decision: ask}` 生成系统提示，模型重新输出包含备份建议的答案。
6. 高负载边界：50 并发会话同时产生高风险段。
   预期：队列深度达到 100 后新段返回 `service_overload`，系统整体可用性不被审核拖垮。

## 维护、版本、来源与相邻主题关系

- 版本：审计事件 Schema 与 `ReviewGate` 状态机版本号独立，当前为 v1.2。向后兼容要求在 SSE `event` 中携带 `review_schema_version`，客户端遇到未知版本时降级为只显示“内容待复核”。
- 来源：概念来源于本仓库 `AGENTS.md` 的 Pi Integration Contract、`packages/pi-agent` 的会话生命周期设计，以及 `.pi/knowledge` 中关于只读工具边界的约束。未引用外部审批系统。
- 维护：每次提交前运行 `git diff --check` 与 `pnpm lint`；每月执行一次 kill -9 恢复演练；分类器阈值变更需经过 `review_threshold.json` 的 Pull Request 评审，并在合并后灰度 10% 流量。
- 相邻关系：与“Guardrails”相邻但不同，Guardrails 侧重模型输出前的策略过滤，人工复核侧重输出后的可逆干预；与“可观测性”共享审计日志与指标，但本概念只定义事件契约，不定义可视化大盘；与“Prompt 模板”相邻，因为追问提示与拒绝占位文本均由 `.pi/prompts` 维护；与“会话生命周期”相邻，因为 `RecoveryCheckpoint` 依赖 `SessionManager` 的持久化钩子。

## 结论

事实：本仓库已通过 `AGENTS.md` 限定工具集为只读；Pi 会话由 `packages/pi-agent` 管理并以 SSE 向 `apps/web` 输出；`apps/api` 不暴露模型凭证或 Provider 密钥。

推论：在 API 层引入 `ReviewGate`，以单段 `held`、客户端渲染裁决入口、追问作为新的模型轮次，是在流式体验中兼顾安全与吞吐的有效结构；硬截断类风险必须阻塞，软降级类风险可继续输出但需明显标记。

未知：在真实用户负载下，审核延迟对会话留存率的影响尚未量化；分类器对多轮上下文累积风险的检出率缺乏生产基准；人工复核操作在不同浏览器与移动端的可达性、误触率与完成率仍需 A/B 验证。
