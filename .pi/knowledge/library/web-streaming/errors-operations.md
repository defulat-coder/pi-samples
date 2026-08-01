---
type: concept
title: 错误事件：验证与运维视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。保留可诊断错误，同时避免把内部凭据和堆栈泄露给浏览器
resource: .pi/knowledge/library/web-streaming/errors-operations.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, errors, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: errors
variant: operations
---

# Web 流式交互中的错误事件：可诊断性与机密隔离

## 摘要与问题边界

在 Web 流式交互中，错误事件不是请求的“终点”，而是会话生命周期的一部分。浏览器通过 SSE 或 JSONL 流持续消费消息，任何一次连接都可能在传输层、协议层、业务层或模型运行时失败。验证与运维视角要求：每一次失败必须留下可诊断的线索，但决不能把内部 API 密钥、原始堆栈、数据库连接串、模型 RPC 载荷或主机路径暴露给客户端。问题边界集中在三个层面：第一，流式通道本身不稳定，网络中断、浏览器切后台、代理超时都会触发事件中断；第二，错误来源可能位于服务端内部，例如下游模型提供者返回 503、工具执行超时、文件读取越权；第三，客户端只能看到“安全侧”的错误，而服务端日志必须保留“诊断侧”的完整上下文。本文围绕如何在同一错误路径上同时满足这两个目标展开。

## 核心概念与数据模型

1. **错误事件（Error Event）**：在 SSE 通道中是一个 `event: error` 的数据行，属于会话事件序列中的普通一员，不是 HTTP 响应体。它必须携带 `event_id`、`session_id`、`error_code`、`safe_message`、`timestamp` 和 `recoverable` 字段。
2. **安全侧信封（Safe Envelope）**：写给浏览器看的对象。只包含用户可理解、可行动的信息，例如 `provider_unavailable` 或 `stream_timeout`，不暴露主机名、端口、文件名、内部错误码。
3. **诊断侧信封（Diagnostic Envelope）**：写入服务端日志或分布式追踪系统的对象。包含 `trace_id`、`span_id`、`upstream_status`、`upstream_error_code`、脱敏后的堆栈摘要、重试次数和调用链时间戳。
4. **分类标签（Classification Tag）**：每个错误必须打上 `transient`/`permanent`/`client`/`internal` 四类之一。`transient` 可触发指数退避重连；`permanent` 必须关闭会话；`client` 表示请求参数问题；`internal` 需要触发告警。
5. **关联上下文（Correlation Context）**：错误事件必须与所属会话、消息批次、工具调用编号绑定。关键字段是 `session_id`、`message_id` 和 `tool_call_id`，避免只看一次错误而找不到上游触发点。
6. **保留与删除策略（Retention Policy）**：安全侧日志保留 30 天用于客户端投诉排查；诊断侧日志保留 90 天，但凭据字段必须在落盘前用 `REDACTED` 替换；涉及密钥泄露的紧急日志应立即轮转。

## 设计决策与取舍

**保留什么、隐藏什么必须显式定义**
运维侧不能只在代码里凭直觉写 `if (err.message.includes('key'))`。必须维护一个“脱敏规则表”：绝对禁止出境的字段包括 `api_key`、`authorization`、`private_key`、`password`、`connection_string`、`stack`（原始字符串）、`cwd`（主机路径）；允许出境的字段包括 `error_code`、`safe_message`、`retry_after`、`message_id`、`event_id`。例外：当浏览器处于本地调试模式且已通过身份校验时，可以返回 `correlation_id` 供工程师在服务端检索诊断详情。

**同步返回还是流内推送**
同步 HTTP 错误适合连接建立前的参数校验，例如 400 或 401。流内错误适合连接已建立后发生的运行时失败，例如模型提供者返回 503。把运行时失败写成 HTTP 500 会提前关闭连接，丢失已发送的上下文；全部用流内事件则客户端需要更复杂的状态机。最终选择：连接前错误同步返回，连接后错误流内推送。

**结构化 JSON 还是纯文本消息**
纯文本对人类友好，但检索器难以解析、Agent 引用时容易断章取义。结构化 JSON 虽然增加少量字节，却能被日志系统、检索器和测试脚本直接消费。取舍：SSE 数据字段统一使用 JSON，内部保留 `safe_message` 作为用户可读字符串。

**HTTP 状态码与事件错误码分层**
HTTP 状态码只描述传输层结果：200 表示流已建立，404 表示会话不存在。业务错误用事件错误码表达，例如 `STREAM_ERROR_PROVIDER_DEGRADED`。不要把 500 状态码与内部业务错误混为一谈，否则浏览器会误判为网关故障。

**全量采样还是按需采样**
运维需要全量诊断日志，但客户端侧事件可以采样。对于高频、可恢复错误，只把计数和聚合指标写入客户端，详细错误事件每 100 次发送一次。这样既降低带宽，也避免把内部调用模式泄露给浏览器。

## 可执行的实施流程

1. 在 `packages/pi-agent` 的错误归一化层中定义 `SafeError` 和 `DiagnosticError` 两个接口，所有异常都必须先归类。
2. 在 `apps/api` 的 SSE 入口中间件中建立 `trace_id` 和 `session_id`，并在响应头中写入 `X-Trace-Id`（仅服务端可见，浏览器可拿到用于投诉）。
3. 编写脱敏规则表，并用单元测试覆盖常见敏感字段的正则匹配，例如 `sk-[a-zA-Z0-9]{20,}` 和 `postgres://.*`。
4. 在错误发生点捕获异常后，先填充 `DiagnosticError` 的完整字段，再调用 `toSafeError()` 生成安全侧事件。
5. 在写入 SSE 通道前校验 `safe_message` 是否仍包含任何敏感模式，若有则替换为 `safe_message` 兜底模板。
6. 对 `transient` 类错误实现指数退避重连，向浏览器推送 `retry_after` 字段；对 `permanent` 类错误发送 `event: error` 后紧跟 `event: done`。
7. 将诊断事件异步写入只读日志通道，日志目录设为 `/var/log/pi-agent/diagnostic/`，并配置 logrotate 与 90 天保留策略。
8. 在 `apps/web` 的 Inspector 中订阅 `error` 事件，区分展示用户提示和“复制 trace_id”按钮，避免直接把错误对象打印到控制台。
9. 部署后运行一次故障注入：在本地用 `curl` 断开 SSE 连接，观察服务端是否记录 `client_disconnect` 且浏览器未收到敏感信息。
10. 每次迭代后更新 `docs/pi-agent-learning.md` 中的错误事件章节，并运行 `pnpm test` 与 `git diff --check` 确保同步。

## 本地文件知识库示例

```yaml
# .pi/knowledge/stream-error-schema.yaml
event_type: error
session_id: sess_7a2b9c
event_id: evt_42
message_id: msg_99
safe:
  code: provider_unavailable
  message: 模型服务暂时不可用，将在 5 秒后重试
  recoverable: true
  retry_after: 5
  correlation_id: corr_18f2a6
diagnostic:
  trace_id: trace_4d5e6f
  upstream_status: 503
  upstream_error_code: rate_limit_exceeded
  internal_message: Provider returned 503 after 3 retries
  stack_summary: "ProviderClient.call -> withRetry -> timeout"
  retry_count: 3
  redacted: true
```

输入是 `apps/api` 捕获到的上游异常，包含原始 503、重试次数和内部调用链。处理流程先读取 `diagnostic` 字段用于日志与告警，再调用 `safe` 转换，把 `upstream_error_code` 映射为 `provider_unavailable`，把 `internal_message` 替换为本地化文本，并确保 `stack_summary` 不进入 `safe` 对象。输出是浏览器 SSE 通道收到的事件：它包含可操作的重试提示和一个 `correlation_id`，工程师可以在服务端用该 ID 检索完整诊断记录。

## 性能、质量与可观测性指标

1. **流错误率（Stream Error Rate）**：每 1000 条 SSE 事件中错误事件占比。在 `apps/api` 的 Prometheus 指标中按 `error_code` 聚合，目标 < 2%。
2. **脱敏覆盖率（Redaction Coverage）**：每月抽检 100 条安全侧事件，检查是否包含敏感正则模式。覆盖率必须达到 100%，测量工具在 `packages/pi-agent` 的测试套件中。
3. **错误检测延迟（Error Detection Latency）**：从异常发生到第一个 `event: error` 推送给浏览器的时间。通过注入人为 `throw` 并用 `Date.now()` 差值测量，目标 < 50 ms。
4. **重试成功率（Retry Success Rate）**：`transient` 错误在客户端重连后成功恢复的比例。计算方式是 `recovered_sessions / total transient_errors`，目标 > 95%。
5. **诊断侧丢失率（Diagnostic Loss Rate）**：安全侧事件已发出但服务端未找到对应诊断日志的比例。通过 `correlation_id` 关联比对，目标 < 0.1%。
6. **敏感信息泄露事件数（Leak Incidents）**：任何安全侧事件中出现密钥、堆栈或主机路径的次数。必须为 0，通过 CI 中的脱敏单元测试和扫描脚本监控。

## 失败模式、诊断证据与恢复动作

**凭证随上游错误回传**
如果模型提供者返回的 JSON 中包含 `api_key`，而服务端未脱敏就把它序列化到 `safe_message`，浏览器会拿到密钥。诊断证据：在日志中搜索 `api_key` 出现在 `safe` 对象里。恢复动作：立即吊销相关密钥，补全脱敏规则表，并运行 `pnpm test` 验证新增正则。

**下游提供者返回 503 未分类**
错误未被标记为 `transient`，导致浏览器直接关闭会话。诊断证据：`diagnostic.upstream_status=503` 且 `safe.recoverable=false`。恢复动作：更新错误映射表，把 503 统一映射为 `transient`，并触发自动退避重试。

**客户端重连风暴压垮 API**
大量浏览器同时重连，导致 `apps/api` 连接池耗尽。诊断证据：QPS 曲线在 30 秒内飙升 5 倍以上，且 `stream_error` 计数同步上升。恢复动作：在服务端加入服务端侧重试限速（max 1 rps per session），并在安全事件中写入 `retry_after`。

**SSE 数据行包含非法 JSON**
浏览器解析器失败，但错误本身未进入错误事件流。诊断证据：服务端日志中 `event_payload` 正常，但 `apps/web` 控制台出现 `SyntaxError`。恢复动作：在 `apps/api` 输出前使用 JSON Schema 校验，并设置 `event: parse_error` 作为兜底。

**诊断日志目录权限过宽**
`/var/log/pi-agent/diagnostic/` 被设置为 755，本地用户可读取内部堆栈。诊断证据：文件权限测试失败。恢复动作：改为 750，只允许运行服务的用户和运维组读取，并在 CI 中加入权限断言。

## 问答测试样例

1. 正向问题：浏览器收到 `provider_unavailable` 后应该做什么？
   回答：读取 `retry_after` 字段，在指定秒数后重连，并把 `correlation_id` 提交给运维。

2. 正向问题：服务端在把错误写入 SSE 之前必须执行哪一步？
   回答：通过脱敏规则表校验 `safe_message` 及所有安全侧字段，确保没有凭据或堆栈。

3. 边界问题：如果上游返回 500，但业务语义是“用户输入触发的不可恢复错误”，应该分类为什么？
   回答：应分类为 `client` 或 `permanent`，而不是 `internal`，因为根因来自用户输入，不应触发内部告警。

4. 边界问题：本地开发模式下是否可以向浏览器返回完整堆栈？
   回答：即使本地开发，也只能返回 `correlation_id` 让工程师在服务端检索诊断记录，不能直接在安全侧携带原始堆栈。

5. 无证据拒答：错误事件是否一定要记录完整的 HTTP 响应体？
   回答：无法一概而论。如果响应体包含模型输出，可以记录其摘要；如果包含密钥或隐私数据，则必须脱敏或丢弃。缺少具体场景时不能给出绝对答案。

6. 无证据拒答：当浏览器未收到任何错误事件但连接断开时，能否直接判定为服务端故障？
   回答：不能。必须先检查网络层、代理超时、浏览器生命周期事件，没有证据支持服务端故障时只能标记为 `unknown_disconnect`。

## 维护、版本、来源与相邻主题

错误事件Schema 的版本号跟随 `packages/contracts` 的 DTO 版本，当前建议为 `v2.1`。每次修改 `error_code` 枚举、脱敏字段或保留策略，都必须同步更新 `docs/pi-agent-learning.md` 和 `.pi/knowledge/stream-error-schema.yaml`。本主题与相邻主题的关系如下：与“流式连接生命周期”相邻，因为错误事件必须定义重连和关闭语义；与“工具调用事件”相邻，因为工具超时或权限错误会产生错误事件；与“SSE/JSON 传输协议”相邻，因为错误编码受协议帧限制；与“可观测性与日志”相邻，因为诊断侧依赖日志保留与检索；与“安全与最小权限”相邻，因为脱敏规则是访问控制的一部分。来源主要基于本项目的 `AGENTS.md` 中关于 Pi 集成、事件转发和只读工具暴露的原则，以及 `apps/api` 与 `apps/web` 的职责边界。

## 结论

事实：错误事件是 SSE/JSONL 流的一部分，必须同时生成安全侧和诊断侧两种表示；脱敏规则表必须显式维护并经过测试；`transient` 错误需要重连、`permanent` 错误需要关闭；诊断日志目录权限应限制为运行用户与运维组。

推论：如果安全侧事件中出现 `correlation_id` 而诊断侧保留完整上下文，浏览器可以既获得可行动提示又不泄露内部细节；如果重试策略与错误分类绑定，可以显著降低重连风暴风险。

未知：具体浏览器与代理对 SSE 重连行为的差异是否会导致某些 `transient` 错误被浏览器静默丢弃；上游不同模型提供者的错误码映射是否足够稳定，仍需在实际运行数据中持续校准。
