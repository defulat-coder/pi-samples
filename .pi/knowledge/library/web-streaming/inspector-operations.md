---
type: concept
title: Inspector：验证与运维视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。把 thinking、工具输入输出和错误以可读方式呈现
resource: .pi/knowledge/library/web-streaming/inspector-operations.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, inspector, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: inspector
variant: operations
---

# Web 流式交互 Inspector：把 thinking、工具调用与错误变成可验证的运行时证据

标签：Web 流式交互、Inspector、可观测性、SSE、AgentSession、thinking 渲染、工具调用审计、故障恢复。

## 摘要与问题边界

Inspector 是流式 Agent 会话的运行时观测面，它不只展示最终回答，而是把 `message_update` 中的 `text_delta` 与 `thinking_delta`、工具调用的 `tool_execution_start/update/end` 以及 `lifecycle/retry` 事件，按时间顺序折叠成可阅读、可检索、可重放的证据链。它的核心职责是“把协议层事件转译成工程师能判断的状态”，而不是代替 Agent 做语义路由、不是调试器、也不是沙箱。因此 Inspector 只能呈现运行时已发出的事件；如果模型或 provider 没有输出 thinking 块，Inspector 不能推断其内部推理过程；它也不验证业务逻辑正确性，只记录输入、输出、错误和延迟。

问题边界进一步限定为：API 进程持有 provider 密钥和 Pi SDK 客户端，浏览器仅消费 SSE/JSON 事件；Inspector 属于只读面，不写文件、不执行命令、不暴露凭证；所有成功、失败、延迟、容量和恢复证据都必须来自事件流本身，而不是一次请求的眼测结果。

## 核心概念与数据模型

1. **EventEnvelope（事件信封）**： immutable 的最小单位，字段至少包括 `seq`（会话内单调递增序列号）、`ts_millis`（服务器接收时间戳）、`session_id`、`type`（如 `text_delta`、`thinking_delta`、`tool_start`、`tool_update`、`tool_end`、`lifecycle`、`error`）和 `payload`。`seq` 是重放、去重和顺序校验的关键。

2. **Delta 流**：`text_delta` 与 `thinking_delta` 都是追加型数据。客户端收到后必须按 `stream_position` 追加，不能随机覆盖；任何回退都应被视为异常并触发重放。

3. **ToolLifecycle（工具生命周期）**：由 `tool_execution_start`（含 `tool_call_id`、`tool_name`、脱敏后的输入摘要）、`tool_execution_update`（可选分块输出）和 `tool_execution_end`（输出或错误、耗时 `latency_ms`）组成。`tool_call_id` 是关联三段事件的稳定标识。

4. **Lifecycle 与 Retry 事件**：记录 `session_created`、`session_closed`、`retry`、`rate_limit`、`error`。必须包含 `attempt`（第几次重试）和 `backoff_ms`，以便判断故障是否在恢复还是在恶化。

5. **RenderFrame（渲染帧）**：从事件日志派生出的 UI 快照，包含当前消息缓冲区、thinking 缓冲区、工具时间线、活跃错误横幅、每个事件类型的延迟火花线。它是只读派生状态，不写入事件源。

6. **Watermark（水位）**：会话内最高连续 `seq` 号。客户端重连时携带 `Last-Event-ID`，服务端用 Watermark 决定从哪个 `seq` 开始重放；缺口则表示丢失或乱序。

## 设计决策与取舍

### 追加式事件日志优先于可变会话状态
选择把每个事件原样写入追加日志，再派生 UI 状态。代价是存储量增加，但收益是可重放、可审计，且失败恢复不依赖浏览器内存。若只保留最终消息，一旦页面刷新或连接闪断，工具报错证据就会丢失。

### 服务端归一化而非客户端解析 Pi 原生事件
`packages/pi-agent` 订阅 `AgentSession` 事件后，将其转换为 `packages/contracts` 中定义的 DTO，再经 SSE 推送给 `apps/web`。这样浏览器不依赖 Pi SDK，也不会拿到 provider 密钥或原始 provider 错误。代价是 API 进程承担解析和脱敏 CPU；收益是客户端与 SDK 版本解耦。

### thinking 面板默认折叠，错误时自动展开
正常运行时 thinking 块更新频繁且可读性差，默认折叠可减少布局抖动和视觉噪声。但当出现工具失败、retry 或 latency 突增时，Inspector 自动展开 thinking 面板并高亮相关段落，帮助运维人员定位“模型为什么决定调用该工具”。取舍是首次使用者可能找不到 reasoning，需要在 UI 中提供显式展开按钮和快捷键。

### 实时渲染与批量刷新平衡
`apps/web` 不应对每个 SSE 消息都触发 React re-render，而是使用 reducer 累积，并以 `requestAnimationFrame` 或 50–100 ms 的定时器批量 flush。取舍是极端低延迟场景会引入最多 100 ms 的显示延迟，但能将 UI 主线程占用降低一个数量级，避免 thinking 洪水导致掉帧。

### 工具 I/O 截断与敏感字段脱敏
工具输出可能包含文件内容、堆栈或 provider 返回的原始错误。Inspector 对单条 payload 设置硬上限（如 64 KB），超限后分片为 `tool_execution_update`，并对 HTTP header、文件路径、凭证片段进行脱敏。取舍是运维人员看不到完整原始输出，但可避免内存膨胀和凭证泄露；需要完整内容时应去服务器日志或专用审计系统查询。

## 可执行的实施流程

1. 在 `packages/contracts` 中定义流事件 DTO，使用 discriminated union 区分 `TextDeltaEvent`、`ThinkingDeltaEvent`、`ToolStartEvent`、`ToolUpdateEvent`、`ToolEndEvent`、`LifecycleEvent`、`ErrorEvent`。

2. 在 `packages/pi-agent` 中封装 `createAgentSession()`，在调用 `session.prompt()` 之前先订阅所有事件，并通过类型化 `EventBus` 把 Pi 原生事件映射为上述 DTO。

3. 使用 `SessionManager.inMemory()` 维护当前 Web 进程内的活跃会话表，记录 `session_id`、创建时间、最后心跳、`thinkingLevel` 和注入的工具集合。

4. 在 `apps/api` 暴露 SSE 端点，连接时校验 `model`、`runtime`、`thinkingLevel` 是否合法；通过 `DefaultResourceLoader` 以项目 `cwd` 加载 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`。

5. 仅注入只读工具：本项目使用 `read` 与自定义 `search_knowledge`，二者都通过 Pi `defineTool()` 注册，返回结构化 content/details，禁止任何写操作。

6. 调用 `session.prompt()` 后，把每一个 `EventEnvelope` 按 `seq` 写入会话追加日志；同时记录服务器 `ts_millis`，作为后续延迟和重放计算的权威时间。

7. 对工具输入输出设置大小阈值：单条 payload 超过阈值时，拆分为多个 `tool_execution_update` 帧，并在 `ToolEndEvent` 中标记 `truncated: true` 与原始字节数。

8. 在 `apps/web` 实现 Inspector 组件：左侧为消息流，右侧为 thinking 折叠面板与工具时间线；错误以红色横幅展示，并附带 retry 次数、backoff 和最后错误码。

9. 实现重连与重放：客户端断线后携带 `Last-Event-ID` 重新连接，服务端从该 `seq` 重放事件；若 `seq` 超出 Watermark 或会话已清理，则返回 410 Gone，客户端新建会话。

10. 验证：使用 `pnpm typecheck`、`pnpm test`，并构造 synthetic prompt 分别触发“工具成功返回”、“工具超时/报错”、“thinking 关闭”、“retry 事件”、“大输出截断”五种场景，确认 Inspector 能稳定渲染。

## 本地文件知识库的 JSON 示例

    {
      "session_id": "sess_7a3f",
      "seq": 12,
      "ts_millis": 1756001200345,
      "type": "tool_end",
      "payload": {
        "tool_call_id": "call_9x2",
        "tool_name": "search_knowledge",
        "status": "error",
        "latency_ms": 4200,
        "error_category": "timeout",
        "output_truncated": true,
        "output_bytes": 98304,
        "details": {
          "attempt": 2,
          "backoff_ms": 2000
        }
      }
    }

输入是 AgentSession 发出的 `tool_execution_end` 原始事件，处理流程是 `packages/pi-agent` 把它映射为 DTO、截取输出大小、注入服务器时间戳与序列号、脱敏文件路径，输出是 Inspector 在工具时间线中展示的一条错误记录：运维人员看到 `search_knowledge` 第二次尝试在 4.2 秒超时，输出原本约 96 KB 已被截断，当前 backoff 为 2 秒。

## 性能、质量与可观测性指标

| 指标 | 定义 | 测量方式 |
|---|---|---|
| 首字/首 thinking 延迟 | API 收到 prompt 请求到发出首个 `text_delta` 或 `thinking_delta` 的时间 | 在 `apps/api` 入口记录 `request_received_at`，与首条事件 `ts_millis` 比较 |
| 事件间隔 p50/p99 | 同一会话相邻 `EventEnvelope` 的 `ts_millis` 差值 | 客户端按 `seq` 排序后计算；p99 > 500 ms 视为卡顿 |
| 工具耗时与错误率 | 每个 `tool_end` 的 `latency_ms`；错误率 = 错误 `tool_end` / 总 `tool_end` | 按 `tool_name` 分组聚合；timeout 单独标记 |
| thinking 占比 | `thinking_delta` 字节 / (`text_delta` + `thinking_delta` 字节) | 按会话/消息计算；突变时可辅助判断模型是否陷入长推理 |
| 会话恢复耗时 | 断线重连后从 `Last-Event-ID` 到补完所有缺失事件的时间 | 客户端记录 `reconnect_at` 与收到最后缺失事件时间 |
| 容量水位 | 当前活跃会话数、`EventBus` 队列深度、单会话事件数 | 从 `SessionManager` 与队列计数器暴露为 `/metrics` |

## 失败模式、诊断证据与恢复动作

1. **SSE 连接中途断开**：证据是浏览器 `EventSource` 报错、服务端连接关闭日志、`Last-Event-ID` 与最新 `seq` 出现缺口。恢复动作：客户端自动重连并携带 `Last-Event-ID`，服务端从追加日志重放；若缺口在 Watermark 内则补全，否则提示用户会话已不可恢复。

2. **工具超时**：证据是 `tool_start` 后超过阈值未收到 `tool_end`，或 `tool_end` 的 `error_category` 为 `timeout`，且 `attempt` 递增。恢复动作：Inspector 将该工具标红；API 按 Pi runtime 策略重试或返回错误；运维人员应检查工具实现或降低输入规模。

3. **事件乱序或 seq 回退**：证据是客户端收到 `seq` 小于当前 Watermark 的非重放事件。恢复动作：拒绝该事件，向服务端请求从 Watermark 重放；若日志本身乱序，应检查 `EventBus` 并发写入或持久化层。

4. **thinking 洪水导致 UI 掉帧**：证据是 `thinking_delta` 频率远高于 `text_delta`，事件间隔 p99 极低，浏览器主线程帧率下降。恢复动作：启用批量 flush、虚拟化长 thinking 面板，必要时服务端对高频 thinking 帧做合并。

5. **大工具输出引发内存/队列压力**：证据是单条 payload 超过阈值、`EventBus` 队列深度持续增长、API 进程 RSS 上升。恢复动作：强制截断并分片输出，降低单条消息上限，将历史事件归档到外部存储。

6. **Provider 侧错误无可用输出**：证据是收到 `lifecycle/error` 事件或 retry 耗尽，但无 `text_delta`/`thinking_delta`。恢复动作：在 Inspector 错误横幅展示脱敏后的错误类别与重试次数，不暴露 provider 密钥；等待 backoff 后由用户触发重试。

## 问答测试样例

| 编号 | 问题类型 | 问题 | 可接受答案/拒答条件 |
|---|---|---|---|
| 1 | 正向 | 如何查看某会话所有工具调用的输入输出？ | 打开 Inspector 工具时间线，按 `session_id` 过滤，展示 `tool_start` 输入摘要与 `tool_end` 输出或错误。 |
| 2 | 正向 | 某工具报错后如何判断是否为超时？ | 查看 `tool_end` 的 `error_category` 是否为 `timeout`，或 `tool_start` 后长时间无 `tool_end`，`latency_ms` 超过阈值。 |
| 3 | 边界 | 为什么某次请求没有 thinking 面板？ | 可能 `thinkingLevel` 被关闭，或当前模型/provider 未发送 `thinking_delta`；不能推断模型没有内部推理。 |
| 4 | 边界 | `Last-Event-ID` 指向已清理会话怎么办？ | 服务端返回 410 Gone，客户端必须新建会话；事件保留受 TTL 策略限制。 |
| 5 | 拒答 | 工具返回的业务结果是否正确？ | 拒绝回答。Inspector 只记录输入输出，不验证业务逻辑；正确性需单元测试或人工复核。 |
| 6 | 拒答 | 这次失败是不是 provider 密钥泄露？ | 拒绝回答。密钥仅在 API 进程内，浏览器拿不到；没有证据时不应做安全归因。 |

## 维护、版本、来源与相邻主题的关系

事件 DTO 的版本号应随 `packages/contracts` 一起演进；若字段发生不兼容变更，需为旧会话日志提供迁移脚本或双读逻辑。事件日志保留策略建议按会话设置 TTL（如 7 天），超出后仅保留聚合指标与快照，原始 envelope 可归档到对象存储。

Inspector 的数据来源包括：Pi SDK 的 `AgentSession` 事件、`packages/pi-agent` 的归一化层、`apps/api` 的 SSE 传输以及 `apps/web` 的状态归约。相邻主题包括 `SessionManager`（会话注册与容量）、`DefaultResourceLoader`（项目级资源加载）、ModelRuntime 与 provider 配置（决定 thinking 与 retry 行为）、SSE/JSONL 传输协议、prompt 模板与 Skills（影响工具调用模式）。与“监控”主题的区别在于：Inspector 面向工程师的实时会话级审计，监控则面向全局聚合指标和告警。

## 结论

事实：Inspector 只能渲染运行时已发出的事件；事件日志是追加式、带单调 `seq` 和服务器时间戳；provider 密钥与 Pi SDK 客户端留在 API 进程，浏览器不接触；工具集合被限制为只读。

推论：thinking 面板空白不等于模型没有推理；工具错误率上升或 retry 次数增长通常意味着稳定性问题；高频 thinking delta 与 UI 掉帧相关。

未知：不同 provider 对 thinking 块的支持程度和触发条件；最优批量 flush 间隔在所有终端设备上的普适值；缺失 `tool_end` 时究竟是工具本身挂起还是网络层丢事件，需要结合服务端日志与客户端重连证据进一步区分。
