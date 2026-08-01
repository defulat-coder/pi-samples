---
type: concept
title: 降级回答：实现视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。没有模型、工具失败或证据不足时如何保持诚实且可操作
resource: .pi/knowledge/library/agent-design/fallback-implementation.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, fallback, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: fallback
variant: implementation
---

# 降级回答：Agent 在没有模型、工具失败或证据不足时的诚实回退实现

摘要与问题边界

降级回答不是让 Agent “优雅地撒谎”，而是在主链路不可用时，按照预先声明的策略把回答降级到仍可验证、仍可操作的层级。问题边界包含三类：模型不可用，例如模型 Provider 返回 503、429 或本地模型进程未启动；工具失败，例如检索工具超时、文件读取权限不足、网络抖动或返回结构校验失败；证据不足，例如检索命中数低于阈值、置信度分数低于阈值、或命中结果与问题无关。降级回答的输出仍然是自然语言，但每个主张必须携带来源分类、置信度标签与下一步动作，用户据此判断能否继续执行。

核心概念与数据模型

1. 失败类型（Failure Taxonomy）：`ModelUnavailable` 表示模型侧失败；`ToolError` 表示工具调用异常；`EvidenceInsufficient` 表示工具返回成功但无法支撑问题。三类错误在代码中应使用独立错误类，避免用统一 `Error` 混排。
2. 回答分级（Answer Class）：`Factual` 指有权威来源支撑；`Inferred` 指来源间接、需要额外确认；`Unknown` 指所有来源均未命中；`Refusal` 指直接拒绝回答。分级必须显式返回，不能隐藏在模板文案里。
3. 证据信封（EvidenceEnvelope）：每次工具调用返回 `{source, content, score, timestamp, validationStatus}`。`score` 是 0-1 的相关性分数；`timestamp` 记录证据生成时间；`validationStatus` 记录是否通过 schema 校验。
4. 回退能力栈（Fallback Capability Stack）：按优先级排列为 `primaryTool` -> `secondaryTool` -> `staticContext` -> `humanEscalation`。每一层必须声明可回答的问题子集与最低置信度要求。
5. 诚实契约（Honesty Contract）：任何回答中的断言，如果不能给出 `source` 与 `score`，必须降级为 `Unknown` 或 `Refusal`。禁止用“可能”“也许”包装没有来源的猜测。
6. 生命周期状态（Lifecycle State）：`Healthy` 主链路正常；`Degraded` 已触发回退但仍能回答；`Failed` 无法回答；`Recovering` 在失败后的冷却期内。状态变化必须写入日志与 trace。

设计决策与取舍

早失败还是优雅降级。对工具失败优先尝试一次重试与切换，如果备用能力仍有证据则进入 `Degraded`；如果备用能力也无法提供证据，则立即进入 `Failed` 并拒答。不能为了输出“看起来完整”的回答而牺牲诚实。

同步还是异步。对 Web 端实时会话采用同步回退链，超时上限 8 秒；对批量总结或重生成任务采用异步任务队列，允许 30 秒到数分钟。同步路径只保留轻量静态缓存，避免阻塞用户。

置信度展示与用户信任。所有 `Inferred` 与 `Degraded` 回答必须在文案中显式声明“以下信息来自间接证据”，并在 JSON 协议中返回 `confidence` 字段。隐藏置信度会削弱后续审计能力。

静态缓存与实时检索。项目级文件、AGENTS.md、.pi/knowledge 作为静态缓存，使用 commit hash 作为版本；检索工具结果按 TTL 失效。缓存与实时结果冲突时，以较新 timestamp 为准，并标记 `Conflict`。

拒答还是猜测。默认策略是：当证据分数低于 `minScore` 或命中数低于 `minHits` 时，拒绝回答并给出下一步动作。只有在用户明确要求“基于现有片段进行推断”且开启 `allowInference` 参数时，才允许输出 `Inferred` 回答。

可执行的实施流程

1. 在 `packages/pi-agent` 中定义 `FailureType` 联合类型与 `AnswerClass` 枚举，确保错误分类与回答分级可序列化。
2. 为每个工具实现 `EvidenceEnvelope` 返回结构，使用 Zod 校验，失败时返回 `ToolError` 并携带 `validationStatus: 'invalid'`。
3. 为每个能力层配置阈值：检索最小命中数 `minHits`、最小相关性分数 `minScore`、最大证据年龄 `maxAgeMs`、最大工具超时 `toolTimeoutMs`。
4. 实现回退链：先调用主工具，失败或证据不足时按顺序调用备用工具，每次调用前检查上层状态；使用断路器记录连续失败次数，超过 3 次后打开 30 秒。
5. 实现回答分类器：根据最终证据集合的 `score` 与 `source` 分布，输出 `Factual`、`Inferred`、`Unknown` 或 `Refusal`。
6. 对工具错误实现重试：对 5xx、超时、网络抖动进行指数退避，最多 3 次；对 401/403、schema 漂移直接失败。
7. 构造降级模板：为 `Degraded`、`Inferred`、`Refusal` 分别准备文案模板，模板中必须包含 `{{sourceList}}`、`{{confidence}}`、`{{nextAction}}` 插槽。
8. 在 API 层把回答事件包装为 SSE/JSON 协议，包含 `answer_class`、`confidence`、`provenance`、`next_action` 字段。
9. 接入可观测性：记录 `fallback_chain`、每层耗时、最终状态、错误类型，并写入 OpenTelemetry trace。
10. 在 `apps/web` 的 Inspector 中渲染这些字段，让用户看到“为什么这样回答”。

代码示例

以下示例描述一个本地文件知识库与检索工具组合的降级配置，输入、处理、输出一目了然。

    {
      "input": {
        "query": "Pi SDK 的 createAgentSession 是否支持本地模型？",
        "primary": {
          "tool": "search_knowledge",
          "minHits": 2,
          "minScore": 0.7
        },
        "fallback": [
          {
            "tool": "read_file",
            "path": "docs/sdk.md",
            "mustExist": true
          },
          {
            "static": "project_context",
            "version": "2026-08-01"
          },
          {
            "action": "refuse"
          }
        ]
      },
      "process": {
        "steps": [
          "调用 search_knowledge 获取命中",
          "若命中数小于 2 或最低分数小于 0.7 则回退到 read_file",
          "若文件不存在或读取失败则使用静态项目上下文",
          "若静态上下文仍无相关证据则执行 refuse"
        ]
      },
      "output": {
        "class": "Unknown",
        "text": "当前知识库与项目文件均未找到直接证据，无法确认 createAgentSession 对本地模型的支持。建议检查 docs/sdk.md 或等待模型恢复。",
        "provenance": [],
        "confidence": 0,
        "nextAction": "human_escalation"
      }
    }

性能、质量与可观测性指标

1. 降级率（Fallback Rate）：触发任何回退的请求占总请求的比例。从 `fallback_chain` 日志中按 `trace_id` 统计，目标上限 15%。
2. 证据覆盖率（Provenance Coverage）：有来源标签的回答主张占总主张的比例。通过正则或 AST 抽取 `provenance` 字段，目标 100%。
3. 降级延迟 P95（Degraded Latency P95）：主链路失败但成功回退的请求的端到端 P95 耗时。使用 histogram 指标，目标 < 6 秒。
4. 错误回答率（False Answer Rate）：在已知答案的测试集上，被判定为 `Factual` 但实际错误的比例。使用 LLM-as-judge 或人工标注，目标 < 2%。
5. 恢复成功率（Recovery Success Rate）：工具初次失败但在 3 次重试内恢复成功的比例。从 trace 中统计，目标 > 90%。
6. 用户升级率（Escalation Rate）：最终进入 `Refusal` 并建议人工升级的比例。用于衡量知识盲区，需与产品定义的目标区间对齐。

失败模式、诊断证据与恢复动作

1. 模型 Provider 503。诊断证据：HTTP 503、重试 3 次后仍失败、`ModelUnavailable` 计数增加。恢复：切换到备用模型，若无备用模型则使用静态缓存返回 `Degraded` 回答，并通知运维。
2. 工具超时。诊断证据：请求耗时超过 `toolTimeoutMs`，trace 中出现 `timeout` 异常。恢复：断路器打开，暂时跳过该工具，改用缓存或下一层能力；服务恢复后自动关闭。
3. 认证过期。诊断证据：返回 401/403、token 刷新失败。恢复：不反复重试，直接标记工具失败，使用静态上下文或 `Refusal`。
4. 返回结构漂移。诊断证据：Zod 校验失败、字段缺失、`validationStatus: 'invalid'`。恢复：将响应内容降级为无结构文本，重新打分，如果分数仍低则拒绝。
5. 检索低质量命中。诊断证据：命中数低于 `minHits` 或分数低于 `minScore`。恢复：回答分类为 `Inferred` 或 `Unknown`，要求用户补充关键词或限定范围。
6. 人工升级队列满载。诊断证据：升级接口返回 429 或队列深度告警。恢复：将问题写入持久化工单，返回用户一个 ticket ID 与预期响应时间。

问答测试样例

1. 正向问题：项目使用什么包管理器？预期：`Factual`，回答 “pnpm”，来源为 `AGENTS.md`，置信度 1.0。
2. 边界问题：Pi SDK 0.84 是否支持本地模型？预期：`Inferred`，证据只有 0.83 版本文档，需声明“未找到 0.84 的直接证据，基于 0.83 推断”。
3. 无证据拒答：如何配置 AWS Secret？预期：`Refusal`，知识库无 AWS 相关证据，返回“未检索到相关来源，请补充需求或人工升级”。
4. 工具失败回退：API 启动命令是什么？预期：检索工具超时，回退到 `read_file('package.json')`，回答 `pnpm dev`，分类为 `Degraded`，置信度 0.8。
5. 证据冲突：search_knowledge 返回 SDK 版本为 0.83，但本地文件标为 0.82。预期：`Degraded`，列出冲突来源，建议用户以官方发布为准。
6. 模糊查询：告诉我所有东西。预期：`Refusal`，理由是问题过于宽泛，无法确定证据范围。

维护、版本、来源与相邻主题关系

降级回答策略应与项目代码一起版本化。`AGENTS.md`、`.pi/knowledge`、`.pi/skills` 与 `docs/` 的 commit hash 作为静态证据版本；`packages/pi-agent` 中的阈值配置纳入代码审查。来源包括：官方 Pi SDK 文档中 `AgentSession` 与 `defineTool` 的使用方式、项目本地 `AGENTS.md` 中关于 Pi 集成契约与能力边界的规定。相邻主题包括：RAG 检索与重排序负责“提供证据”，降级回答负责“在证据失败时如何表达”；Guardrails 负责“什么不能说”，降级回答负责“能说多少、以什么置信度说”；可观测性负责“记录过程”，降级回答负责“把状态暴露给用户与下游系统”。三者必须独立设计，避免职责混叠。

结论

事实：模型、工具、证据都可能失败，失败时必须返回明确的 `AnswerClass` 与 `nextAction`。推论：通过分层回退、严格阈值、显式来源与可观测性，可以在主链路不可用的情况下仍保持用户信任。推论：把阈值配置、模板文案、版本信息纳入代码仓库，是实现一致可审计降级回答的前提。未知：具体阈值（如 `minScore=0.7`、`minHits=2`）在真实用户数据中是否最优，需要通过 A/B 测试与日志反馈持续校准；不同模型对同一问题的“证据充分性”是否存在差异，目前缺乏足够项目级数据，需要进一步实验。
