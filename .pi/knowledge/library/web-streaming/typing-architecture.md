---
type: concept
title: 输入状态：架构视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。在回答生成、工具执行和等待重试之间给出准确状态
resource: .pi/knowledge/library/web-streaming/typing-architecture.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, typing, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: typing
variant: architecture
---

# Web 流式交互中的输入状态：在生成、工具与重试之间给出准确状态

## 摘要与问题边界

在 Web 流式对话系统里，输入状态是一条用户消息从提交到最终答复全生命周期中，服务端与客户端共同维护的可观测进程描述。本文按 OKF-compatible 概念格式组织，聚焦“当前在做什么”这一问题的准确表达。其边界限定为会话级（per-session）可见状态机，覆盖回答生成、工具执行和等待重试三个阶段；不包括大模型内部推理过程，不包括持久历史存储的完整语义，也不涉及第三方 provider 的认证与计费协议。任何状态断言都必须能从事件日志中回放验证。

## 核心概念与数据模型

1. 输入回合（Input Turn）：一次完整提交的最小单位，包含提交时快照、用户标识、会话 ID，以及项目约定的只读能力令牌（capability token）列表。
2. 状态集合（State Space）：离散枚举 {idle, composing, submitted, validating, queued, streaming, tool_active, retrying, error, terminal}，terminal 之后禁止任何转换。
3. 转换日志（Transition Ledger）：按会话分区、追加只写的有序记录，每条记录 fromState、toState、事件名、单调序列号 seq、触发本次转换的 causalityId，以及服务端时间戳。
4. 工具执行槽（Tool Execution Slot）：每个工具调用拥有独立子状态机，其生命周期嵌入在父回合的 tool_active 阶段内，结束必须显式发布 tool_execution_end 或 tool_execution_error。
5. 重试计数器（Retry Counter）：在 retrying 状态中维持单调计数与指数退避基准，超过 maxAttempts 后必须进入 error。
6. 协调检查点（Reconciliation Checkpoint）：服务端在每个 message_update 或工具事件后生成并广播的客户端可见快照，携带状态校验和，允许客户端以事件溯源方式合并。
7. 能力边界（Capability Boundary）：输入状态只反映被授予的只读能力，例如 read 与 search_knowledge，不暴露 provider 密钥或任何写操作。

## 设计决策与取舍

### 1. 状态应中心化于会话还是按输入轮次隔离
选择按输入轮次隔离，并在会话中聚合只读视图。单个回合的错误、重试或工具调用不会影响前序轮次的展示。会话对象只负责创建新回合和查询当前回合，不修改历史回合状态。

### 2. 工具执行状态是嵌套还是扁平
采用嵌套模型。每个工具调用有独立的 begin/update/error/end 事件，可支持多工具并行。当项目仅暴露单一工具时，可退化为一维状态，作为例外兼容。

### 3. 重试状态对客户端是否透明
选择透明。retrying 作为显式状态广播，附带 attemptNumber、maxAttempts 与 nextAttemptAt。这样用户可知系统仍在处理，而非卡死；但客户端必须实现对应 UI，并避免泄露 provider 内部错误。

### 4. 乐观更新与严格顺序
客户端允许提交后立即进入 optimistic submitted 状态，但收到服务端协调检查点后必须以服务端 seq 覆盖。严格顺序由 SSE 帧中的 seq 字段保证；若检测到乱序，客户端暂停渲染并请求回放。

### 5. 状态持久化到内存还是追加日志
优先追加日志到内存中的事件流，同时定期快照到项目约定的日志目录。高频写入适合追加结构，而日志提供审计和回放。不采用数据库行级更新，因为因果事件强、顺序敏感。

## 可执行的实施流程

1. 在 packages/contracts 定义输入状态枚举、事件 DTO 与协调检查点 schema。
2. 在 packages/pi-agent 实现回合上下文工厂，每个新用户消息创建 InputTurn 并初始化状态为 idle。
3. 注入能力边界：从会话配置读取 read 与 search_knowledge 等工具列表，写入 capabilityToken。
4. 在调用 AgentSession.prompt() 前订阅事件，确保回调注册后才开始产生流。
5. 将 Pi SDK 的 message_update、thinking_delta、tool_execution_start/update/end、retry 等事件归一化为输入状态事件。
6. 在 packages/pi-agent 维护每个会话的转换日志，事件按 seq 递增写入。
7. 通过 apps/api 的 SSE 端点向客户端发送事件，每帧包含当前状态、校验和与 causalityId。
8. 在 apps/web 实现事件消费者，合并到本地状态树并校验 seq 连续性。
9. 定义超时策略：tool_active 超过 30 秒未结束则触发 synthetic tool_execution_error；retrying 超过 maxAttempts 进入 error。
10. 暴露 /healthz 与 /metrics，返回当前会话数、悬挂工具数与重试分布。

## 示例：输入状态的 YAML 表示

以下为单个输入回合在 tool_active 与 retrying 之间转换的示例。输入是用户消息触发的工具调用；处理是服务端将 Pi 事件归一化并写入日志；输出是客户端可渲染的状态快照。

    turnId: turn-019
    sessionId: sess-42
    seq: 7
    state: retrying
    previousState: tool_active
    causalityId: tool-call-7
    capabilities:
      - read
      - search_knowledge
    toolSlots:
      - slotId: tool-call-7
        toolName: search_knowledge
        status: error
        attempt: 2
        maxAttempts: 3
        nextAttemptAt: "2026-08-10T12:34:56Z"
    retry:
      reason: timeout
      attemptNumber: 2
      backoffMs: 4000
    checksum: sha256:abc123...
    emittedAt: "2026-08-10T12:34:52Z"

输入：用户提交消息后模型调用 search_knowledge，首次调用超时。处理：服务端将 tool_execution_error 与 retry 事件映射为状态转换，更新 attemptNumber 并计算校验和。输出：客户端渲染“正在重试（2/3），4 秒后再次尝试”，Inspector 可展开 causalityId 查看关联调用。

## 性能、质量和可观测性指标

1. 状态传播延迟：从服务端写入转换日志到客户端完成 UI 更新，用浏览器 Performance API 测量事件到达时间与渲染时间戳差，目标 p99 < 120 ms。
2. 状态转换错误率：日志中出现不合法 from→to 条目数占总条目数比例，通过单元测试穷举状态机覆盖，目标为 0。
3. 工具悬挂率：tool_active 持续超过 30 秒未收到结束事件的回合比例，通过后台扫描 metrics 检测。
4. 重试次数分布：按工具名称聚合 attemptNumber 的直方图，识别高频超时工具或 provider 异常。
5. 客户端状态漂移：客户端校验和与服务端校验和不一致的会话数，由心跳或主动同步请求统计。
6. 端到端首状态延迟：从用户点击发送到客户端首次收到非 optimistic 的 submitted 状态的间隔，目标 p99 < 250 ms。

## 失败模式

1. 客户端连接断开
   证据：SSE 连接关闭，服务端在 30 秒内未收到心跳。恢复：客户端重连后发送 lastSeenSeq，服务端从转换日志重放后续事件。

2. 重试风暴
   证据：同一 causalityId 在短时内产生大量 retrying 事件，attemptNumber 快速递增。恢复：引入指数退避与最大尝试上限；达到上限后转入 error，并触发告警。

3. 工具状态悬挂
   证据：toolSlots 中存在 status=running 且 elapsed > 30 秒。恢复：超时守卫发送 synthetic tool_execution_error，强制进入 retrying 或 error。

4. 并发提交导致状态合并错误
   证据：同一回合出现多个 submitted 事件或 seq 重复。恢复：回合级锁，每次提交生成新 turnId，禁止跨回合修改。

5. SSE 事件乱序或重复
   证据：客户端收到 seq 递减或重复帧。恢复：客户端缓存乱序事件，等待缺失 seq 或请求回放；重复事件通过 causalityId 去重。

6. 非法状态转换
   证据：转换日志出现 terminal→streaming。恢复：状态机拒绝写入，记录错误日志，并终止该会话避免污染。

## 问答测试样例

1. 正向：用户提交问题后模型正在调用工具，界面应显示什么状态？
   答：应显示 tool_active，并展示各工具槽的名称与进度。

2. 正向：工具调用超时后系统重试，客户端应收到哪些字段？
   答：应收到 state=retrying、attemptNumber、maxAttempts、nextAttemptAt、backoffMs 与关联 causalityId。

3. 边界：工具在重试过程中用户发送新消息，两个回合状态是否互相影响？
   答：不应影响。新消息创建独立 InputTurn，前序回合的 retrying 在其 own 上下文内继续。

4. 边界：最大重试次数达到后仍未成功，状态如何转移？
   答：从 retrying 转入 error，并附带 reason=exhausted，不再重试。

5. 无证据：客户端能否确认当前使用了哪个 provider？
   答：输入状态不暴露 provider 信息；如无 provider 元数据，应拒绝回答。

6. 无证据：客户端能否确认服务端已调用 write 工具？
   答：本项目只授予 read 与 search_knowledge，未授予 write；若无能力令牌记录，应拒绝声称存在 write 调用。

7. 边界：客户端收到 seq=5 后断开，重连后服务端只有 seq=6，应如何表现？
   答：服务端从 lastSeenSeq+1 即 seq=6 开始重放，并补全 causalityId 上下文。

## 维护、版本、来源和与相邻主题的关系

输入状态 schema 版本遵循项目约定，如 v1.0.0，变更需同步更新 packages/contracts 与转换日志解析器。来源包括：AGENTS.md 中的会话生命周期约定、packages/pi-agent 的事件归一化实现、apps/api 的 SSE 端点以及 .pi/knowledge 中通过 search_knowledge 读取的自定义 Markdown 检索结果。

相邻主题：输入状态依赖会话管理（SessionManager.inMemory() 与 createAgentSession()），位于其上层抽象；其下是 Pi SDK 的事件流与 ModelRuntime；横向关系包括工具注册（只读工具集）、能力边界（capability token）和可观测性（SSE/Inspector）。输入状态不属于提示工程或模型推理协议，仅描述交互进程。

## 结论

事实：输入状态是面向用户与客户端的可观测进程描述，必须由服务端事件驱动并追加日志。推论：将其按输入轮次隔离、工具状态嵌套、重试透明化，可显著降低界面歧义与状态漂移。未知：不同 provider 对 retry 和 thinking 事件的具体语义差异需要针对实际版本验证；长期运行下日志回放的最优策略（全量重放 vs 快照+增量）尚未在项目负载测试中得出定量结论。
