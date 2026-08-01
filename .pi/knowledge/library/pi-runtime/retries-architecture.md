---
type: concept
title: 中止与重试：架构视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。模型重试、工具失败、客户端断开和最终收敛的处理策略
resource: .pi/knowledge/library/pi-runtime/retries-architecture.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, retries, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: retries
variant: architecture
---

# Pi Agent 运行时的中止与重试：模型、工具、客户端与最终收敛的架构策略

## 摘要与问题边界

Pi Agent 运行时需要同时处理三类不确定性：模型 provider 的间歇性失败、工具执行的非确定性失败、以及 Web 客户端在流式响应期间的连接中断。中止与重试策略的核心目标，是在这三类干扰下仍能把一次用户请求收敛到可交付的最终答案，同时避免无效循环、重复计费和状态丢失。

本文的讨论边界被严格限定在运行时内部：上游 LLM provider 的限流、认证、计费由 provider 抽象层负责；业务层面的补偿事务由调用方负责；SSE 传输协议本身不在本文重新定义，只规定运行时使用该协议时应传递的状态语义。本文面向需要设计长期边界的设计者，因此先建立概念、责任边界和可替换接口，再讨论具体实现。

## 核心概念与数据模型

1. **Session**：一次端到端对话，持有身份标识、根级别的 `AbortSignal`、会话级重试预算，以及不可变的 Checkpoint 日志。
2. **Turn**：从用户消息到最终响应的完整周期，可能包含多次模型调用、多轮工具调用和若干次重试。
3. **Step**：一次模型调用或一次工具调用，是重试的最小原子单位。每次重试都产生新的 Step，而不是简单重发同一请求。
4. **FailureClass**：运行时将失败划分为 `transient`（网络抖动、provider 5xx）、`tool_recoverable`（下游 API 限流或超时）、`tool_fatal`（参数校验、权限错误）、`client_disconnect`、`policy_violation` 和 `unrecoverable`。
5. **Checkpoint**：每个 Step 成功后追加到会话日志，记录输入 token、工具输出、部分文本输出、idempotency key、时间戳和哈希校验。
6. **RetryBudget**：双维度计数器，分为会话级与工具级，记录剩余重试次数、剩余 token 配额和截止时间。
7. **ConvergenceSignal**：运行时显式生成的 `final` 或 `give_up` 标记，用于结束当前 Turn。模型只能产出建议文本，不能直接终止流程。
8. **TransportAck**：客户端通过 `Last-Event-ID` 上报已确认的事件序号，服务端据此判断哪些事件需要在断线后重放。

## 设计决策与取舍

### 重试决策权归运行时

模型可以在 reasoning 或 tool 结果中表达“请再试一次”，但这只是建议。运行时必须综合 `FailureClass`、`RetryBudget` 和 `Checkpoint` 后做出是否重试的决策。这样可避免模型因提示变化或上下文截断而产生不一致的恢复行为，也便于审计。

### 工具失败分类采用注册表加启发式

已知工具在注册时声明可恢复错误码、状态码和默认重试策略；未知错误则通过错误消息正则、HTTP 状态码和超时标志进行启发式分类。边界例外：若同一工具在 60 秒内连续出现同类可恢复错误超过 3 次，则升级为 `unrecoverable`，防止无效循环消耗预算。

### 客户端断开后保留服务端状态

SSE 连接关闭不等于会话结束。运行时在会话级保持 Turn 状态，并在可配置 TTL（默认 5 分钟）内允许客户端通过 `session_id` 与 `Last-Event-ID` 恢复。取舍：换取用户体验和避免重复调用，代价是运行时需要管理内存与会话驱逐策略。

### 重试以新 Step 而非同一调用内重发

每次重试生成新的 Step，附带单调递增的 `step_index` 与新的 `idempotency_key`。模型上下文在 Checkpoint 基础上追加“上一次尝试失败”的元信息，而不是简单重发同一请求。这保留了审计轨迹，也让幂等下游工具能够安全重放。

### 收敛判定由三重保险组成

第一重是 Step 数量上限；第二重是时间盒；第三重是 token 或费用上限。任一条件触发即强制生成 `ConvergenceSignal`。在 `give_up` 场景下，运行时返回当前最佳部分答案并附带未完成的工具列表，而不是编造成果。

### 流式事件优先保证 at-least-once 而非 exactly-once

客户端可能收到重复事件；运行时通过 `event_id` 与事件哈希让客户端去重。断线续传时允许事件重放，Checkpoint 保证幂等。这样简化了传输层实现，代价是客户端必须实现幂等消费逻辑。

## 可执行的实施流程

1. 在 tool registry 中为每个工具声明失败分类规则、默认重试预算和幂等语义。
2. 用 `ProviderRetryMiddleware` 包裹模型客户端，捕获状态码、超时、空响应和流中断，并映射到 `FailureClass`。
3. 为每个工具调用生成全局唯一的 `idempotency_key`，并在工具 adapter 中实现“相同 key 返回相同结果”的幂等语义。
4. 每次模型生成或工具返回成功后，立即追加 Checkpoint 到会话日志，记录输入输出哈希与时间戳。
5. 将 HTTP/SSE 连接的 `abort` 或 `close` 信号转换为运行时内部的 `AbortSignal`，区分用户主动取消与网络断开。
6. 实现 `RetryBudget` 递减逻辑：每次发起重试前先扣减预算，预算归零时禁止发起新 Step。
7. 在运行时循环中注入 `ConvergenceGuard`：每完成一个 Step 检查 `step_count`、`elapsed_time` 和 `remaining_budget`。
8. 为客户端实现 reconnect resume 协议：重连时上传 `Last-Event-ID`，服务端从该 ID 之后的事件流重放。
9. 在测试环境中注入失败：provider 超时、工具 500、客户端随机断开，验证 Checkpoint 与事件重放一致性。
10. 发布前冻结 retry policy schema 版本，运行迁移测试，确保旧会话在新策略下仍可恢复。

## 示例：类型与分类逻辑

    // packages/pi-agent/src/retry.ts
    interface FailureClass {
      kind: 'transient' | 'tool_recoverable' | 'tool_fatal' |
             'client_disconnect' | 'unrecoverable';
      retryable: boolean;
      maxAttempts: number;
      backoffMs: number;
    }

    interface Step {
      stepIndex: number;
      idempotencyKey: string;
      checkpointHash: string;
      failure?: FailureClass;
    }

    function classifyError(
      error: unknown,
      registry: ToolRegistry
    ): FailureClass {
      const known = registry.match(error);
      if (known) return known;
      if (isTimeout(error)) {
        return {
          kind: 'transient',
          retryable: true,
          maxAttempts: 3,
          backoffMs: 1000
        };
      }
      return {
        kind: 'unrecoverable',
        retryable: false,
        maxAttempts: 0,
        backoffMs: 0
      };
    }

输入是一个抛出的异常或 provider 响应；处理逻辑先匹配 tool registry，再按超时或状态码做启发式分类；输出是带有 `retryable`、`maxAttempts` 和 `backoffMs` 的 `FailureClass`。运行时据此选择重试或中止，并在 Checkpoint 中记录分类结果。

## 性能、质量与可观测性指标

1. **会话级重试率**：重试 Step 数除以总 Step 数，按 `FailureClass` 分组，从运行时日志聚合。目标值应低于 15%。
2. **首次 token 到达延迟**：从 Turn 开始到第一个 `text_delta` 的时长，包含一次重试后的恢复时间，使用 SSE `event_id` 与客户端时间戳计时。
3. **Checkpoint 写入延迟**：每次追加 Checkpoint 的 p99 耗时，通过 storage adapter 埋点，目标 p99 低于 50 毫秒。
4. **误分类率**：被标记为 `transient` 但最终在 `maxAttempts` 内未恢复的错误比例，通过人工标注抽样评估。
5. **断线续传命中率**：客户端重连后命中已有会话并成功恢复事件流的比例，从 `SessionManager` 统计。
6. **收敛正确率**：最终答案满足用户意图的比例，通过评估集或人工判断，与无失败基线对比。

## 失败模式、诊断证据与恢复动作

1. **Provider 间歇性 5xx**。诊断证据：HTTP 状态码 5xx、响应为空、同一会话其他 provider 请求成功。恢复动作：按指数退避重试 3 次，仍失败则切换 fallback provider 并记录降级事件。
2. **工具 schema 校验失败**。诊断证据：工具返回明确 400/422、错误信息含 `validation` 或 `invalid`。恢复动作：停止重试，将错误作为上下文返回给模型，由模型修正参数后发起新 Step。
3. **工具下游超时但幂等键丢失**。诊断证据：工具返回 504、服务端无 `idempotency_key` 命中记录。恢复动作：先查询工具侧状态，确认未执行再重试；若无法确认状态，则标记为 `unrecoverable`。
4. **客户端 SSE 连接意外断开**。诊断证据：transport 层 `onClose` 事件、无用户取消标记、`Last-Event-ID` 存在且小于最新事件号。恢复动作：保留会话状态，等待重连并按 `event_id` 重放。
5. **模型在工具失败与重试之间循环**。诊断证据：连续 N 个 Step 调用同一工具且输出相似错误、`step_count` 持续增长。恢复动作：触发 `ConvergenceGuard`，注入“请基于已有信息给出最佳答案”的系统提示。
6. **事件流在重连后出现重复或乱序**。诊断证据：客户端收到相同 `event_id` 或 `event_id` 逆序。恢复动作：客户端按 `event_id` 去重并丢弃逆序事件，服务端只重放已持久化的事件。

## 问答测试样例

1. **正向**：当 provider 返回 503 时，运行时应如何决策？
   答案：将错误分类为 `transient`，在 `RetryBudget` 内按指数退避重试；预算耗尽则切换 fallback provider 或返回 `give_up`。

2. **正向**：客户端在工具执行中途断开，如何恢复？
   答案：会话状态保留在 TTL 内，客户端用 `session_id` 与 `Last-Event-ID` 重连，服务端从 Checkpoint 重放未确认事件。

3. **边界**：`RetryBudget` 只剩 1 次，但当前 Step 已连续失败 2 次且属于 `transient`，是否继续？
   答案：允许再试一次；若仍失败，则禁止进一步重试并触发收敛流程。

4. **边界**：工具返回 400，错误信息未在注册表中声明，如何处理？
   答案：使用启发式规则；若包含 `validation` 或 `invalid` 则标记 `tool_fatal`，否则先按 `tool_recoverable` 尝试一次并记录观察结果。

5. **无证据拒答**：运行时应自动将模型建议的“再试一次”作为重试依据吗？
   答案：否；必须以 `FailureClass` 与 `RetryBudget` 为依据，模型建议仅作为上下文参考。

6. **无证据拒答**：客户端断开 30 分钟后重连，能否保证恢复？
   答案：无法保证；恢复取决于 TTL 配置与会话是否被驱逐，未给出具体配置时不能断言一定可恢复。

## 维护、版本、来源与相邻主题关系

`RetryPolicy`、`FailureClass` schema 和 Checkpoint 格式必须在仓库中显式版本化，并以 JSON Schema 或 TypeScript 类型锁定。升级时通过迁移脚本将旧 Checkpoint 转换为新格式，避免历史会话在恢复时解析失败。

主要来源包括：项目 `AGENTS.md`、`packages/pi-agent` 的实现、`@earendil-works/pi-coding-agent` SDK 中 `AgentSession` 与 `defineTool` 的文档，以及内部 ADR 中关于 monorepo 边界和 Pi 集成契约的记录。

相邻主题包括：工具注册（决定哪些错误码可被识别为可恢复）、能力注入（决定运行时可见工具集合）、SSE 传输（承载事件与重连语义）、可观测性（指标与追踪）、provider 抽象（模型调用超时与降级策略）。这些主题通过明确接口与本策略交互，而不是在运行时内部耦合实现。

## 结论

**事实**：Pi Agent 运行时的中止与重试可以通过 `FailureClass`、`RetryBudget`、`Checkpoint` 和 `ConvergenceSignal` 四个核心抽象统一建模；运行时拥有最终重试决策权；工具幂等键与 Checkpoint 是断线续传和幂等重放的实现基础。

**推论**：将每次重试建模为新 Step 而非同一请求重发，可以在审计轨迹、工具幂等和模型上下文质量三方面同时获益；服务端保留会话状态能显著提升客户端断线后的恢复体验，但会带来明确的内存占用、TTL 管理和驱逐策略成本。

**未知**：不同 provider 在流式响应中途断开后的精确重试语义尚未完全覆盖；Checkpoint 的最优粒度（每次工具调用 vs 每个 token chunk）对延迟与存储成本的影响需要项目实测确定；人类评估收敛正确率的成本与自动化代理评估之间的取舍仍待验证。
