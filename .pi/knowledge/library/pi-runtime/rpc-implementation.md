---
type: concept
title: RPC 与 JSONL：实现视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。进程内 SDK、RPC 和 JSONL 模式的边界以及 Web 适配方式
resource: .pi/knowledge/library/pi-runtime/rpc-implementation.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, rpc, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: rpc
variant: implementation
---

# Pi Agent 运行时：进程内 SDK、RPC 与 JSONL 的边界及 Web 适配

## 摘要与问题边界

Pi Agent 在 Node/TypeScript 侧默认使用进程内 `AgentSession` 直接调用模型运行时；当需要进程隔离或跨语言边界时，通过 JSONL 行协议与子进程通信。Web 端只消费 SSE 流，不触碰 Pi SDK 或 Provider 密钥。本文限定于输入输出帧格式、错误分级、生命周期管理、验证与 Web 适配，不讨论模型内部实现、浏览器直连 Provider 或分布式持久化。

## 核心概念与数据模型

1. **AgentSession**：进程内持有 `ModelRuntime`、`DefaultResourceLoader` 和工具注册表的会话对象。输入为带 capability 的 prompt 请求；输出为异步事件流；终止条件是 `dispose()` 完成且订阅取消。
2. **JSONL 事件帧**：RPC 模式下每行一个 JSON 对象，包含 `event_id`、`type`、`payload`、`request_id`。帧之间以换行符分隔，禁止跨行 JSON。
3. **Prompt 请求帧**：进入 RPC 进程的第一帧，字段包括 `session_id`、消息数组、`thinking_level`、`capabilities` 和 `resource_cwd`。该帧决定后续事件路由。
4. **增量事件**：`text_delta`/`thinking_delta`/`toolcall_delta` 三种类型，携带 `index` 和增量内容，必须按顺序拼接。
5. **工具执行生命周期**：`tool_execution_start` 标记开始，`tool_execution_update` 报告进度，`tool_execution_end` 返回结果或错误。Web 层据此渲染工具卡片。
6. **错误帧**：`error` 分四级：`transport`（管道断裂）、`session`（会话初始化失败）、`tool`（工具执行异常）、`model`（模型返回错误）。`payload` 只含 `code`、`message`、`recoverable`，不得携带堆栈或密钥。
7. **Capability 清单**：API 注入的只读能力，如 `read` 和 `search_knowledge`。RPC 进程据此过滤工具注册，拒绝未授权工具。
8. **SessionManager**：使用内存实现 `SessionManager.inMemory()` 管理会话映射，键为 `session_id`。该实现不保证跨进程共享。

## 设计决策与取舍

**进程内优先，RPC 仅在隔离边界使用**
直接复用 `AgentSession` 可避免序列化和上下文切换，延迟最低。仅当需要隔离不可信扩展或不同语言运行时时，才引入 JSONL RPC。

**JSONL 而非二进制协议**
JSONL 能逐行解析，便于流式处理和日志回放。代价是 Payload 体积较大，需防范换行符注入。

**stdio 默认，socket 作为扩展**
stdio 适合一对一声宿通信；socket 便于多客户端复用同一进程，但需处理端口、认证和背压。

**错误信息必须脱敏**
所有从子进程返回的错误帧在离开 API 层前移除 `stack`、替换密钥占位符，把模型错误码映射为公开错误码。

**流式 SSE 而非 WebSocket**
Web 端通过 SSE 接收事件，方向以服务器推送为主。SSE 基于 HTTP，便于穿过代理；WebSocket 增加连接管理复杂度。

**Capability 在 API 层注入**
Web 应用不能声明工具能力，只能携带会话标识。API 根据会话身份注入 `read` + `search_knowledge`，RPC 进程再加载对应工具。

## 可执行的实施流程

1. 在 `packages/contracts` 定义 DTO：使用 Zod 定义 `PromptRequest`、`EventEnvelope`、`ErrorFrame`、`ToolCallResult`。
2. 在 `packages/pi-agent` 实现 `InProcessAgentSession`：调用 `createAgentSession()`，订阅 `message_update` 和工具事件，归一化为 `EventEnvelope`。
3. 实现 `RpcAgentHost`：使用 `child_process.spawn` 启动子进程，通过 stdin 写入 JSONL，stdout 读取 JSONL。
4. 实现 JSONL 编解码器：写入前压缩为一行；读取时使用 `readline` 逐行解析，解析失败立即生成 `transport` 错误帧。
5. 引入 `request_id` 关联：每个 prompt 分配 ULID，所有产生的事件携带同一 `request_id`，API 通过 Map 路由到对应 SSE 响应。
6. 在 `apps/api` 实现 SSE 适配器：把 `EventEnvelope` 转换为 SSE 格式，`event:` 对应类型，`data:` 为 JSON Payload，`id:` 为单调递增序列号。
7. 实现输入验证与 capability 注入：验证 `session_id` 非空、`capabilities` 元素在白名单，注入后写入 Prompt 请求帧。
8. 实现生命周期管理：Web 请求到达时创建或复用会话；SSE 关闭时取消订阅；超时或异常时调用 `session.dispose()` 并发送 `dispose` 帧。
9. 实现关闭顺序：SIGTERM 时先停止接收请求，再等待 SSE 连接结束，最后 kill 子进程。
10. 编写测试：覆盖正常流式输出、JSONL 损坏、子进程崩溃、工具越权、SSE 断开五种场景。

## 协议示例：输入、处理与输出

Web 端 POST 请求体：{session_id: "sess_001", messages: [{role: "user", content: "查询 JSONL 笔记"}], thinking_level: 1}。API 注入 capabilities 后，向子进程写入一行：{event_id: "ev_1", type: "prompt", request_id: "req_7a8b", payload: {session_id: "sess_001", messages: [...], thinking_level: 1, capabilities: ["read", "search_knowledge"]}}。子进程返回行：{event_id: "ev_2", type: "tool_execution_start", request_id: "req_7a8b", payload: {tool_id: "tc_1", name: "search_knowledge"}}；{event_id: "ev_3", type: "text_delta", request_id: "req_7a8b", payload: {index: 0, delta: "正在检索"}}；{event_id: "ev_4", type: "tool_execution_end", request_id: "req_7a8b", payload: {tool_id: "tc_1", result: {matches: ["docs/research/..."]}}}。API 把事件映射为 SSE：id: 0, event: text_delta, data: {index: 0, delta: "正在检索"}。浏览器按 id 排序展示。

## 性能、质量和可观测性指标

1. **端到端首 token 延迟**：从 Web POST 到首个 `text_delta` 发出，目标 < 300 ms。
2. **JSONL 序列化开销**：进程内与 RPC 模式同 prompt 耗时差异，目标额外开销 < 15%。
3. **错误分类率**：按 `transport`/`session`/`tool`/`model` 计数，目标 `transport` 错误 < 0.1%。
4. **会话泄漏**：进程退出后检查未释放会话和僵尸子进程，监控会话 Map 大小。
5. **事件顺序正确性**：校验 `id` 单调递增，并对拼接后的文本做哈希比对。
6. **输入验证拒绝率**：记录非法请求 400 比例，目标 < 1%。

## 失败模式、诊断证据与恢复动作

1. **JSONL 行解析失败**：证据是 stdout 出现非 JSON 或含未转义换行符；丢弃该行、记录缺失 `event_id`、发送 `transport` 错误帧，但不终止子进程。
2. **子进程崩溃**：证据是 `exit` 事件早于 `dispose` 且退出码非 0；返回 `session` 错误，重启子进程，不自动重试当前失败请求。
3. **`request_id` 失踪**：证据是事件无 `request_id` 或不在路由 Map；写入全局限流日志，不推送给任何客户端。
4. **SSE 客户端断开**：证据是 `res.write` 抛出 `ERR_STREAM_WRITE_AFTER_END`；取消订阅、调用 `dispose()`、释放资源。
5. **工具执行超时**：证据是 `tool_execution_start` 后超过配置时间未收到 `tool_execution_end`；发送取消帧，返回 `tool` 错误。
6. **Provider 限流误报**：证据是错误帧返回 `rate_limit` 但配额未触发；映射为 `model` 公开码，返回 503 与 `Retry-After`，不暴露原始 Provider 响应。

## 问答测试样例

1. **正向**：合法 prompt 请求 `thinking_level=1` 时，浏览器 300 ms 内是否收到首帧 `text_delta`？
2. **正向**：`search_knowledge` 调用后是否成对出现 `tool_execution_start` 与 `tool_execution_end`，且 `tool_id` 一致？
3. **边界**：请求含 `capabilities: ["write", "read"]` 时，API 是否过滤 `write` 仅保留 `read` 并记录越权？
4. **边界**：子进程返回事件缺少 `request_id` 时，是否进入日志而非 SSE 流？
5. **边界**：同一 `session_id` 并发请求是否按 `request_id` 隔离事件，不串流？
6. **无证据拒答**：若问 Pi SDK 内部如何实现 `thinking_delta`，应回答本知识库仅记录事件协议，不揣测 SDK 内部实现。

## 维护、版本、来源与相邻主题关系

本项目依赖 `@earendil-works/pi-coding-agent@0.83.0`，`AgentSession`、`createAgentSession`、`SessionManager.inMemory` 和 `DefaultResourceLoader` 来自该版本。运行时行为以 `AGENTS.md` 与已安装 SDK 为准。相邻主题：进程内 SDK 用法归入 `packages/pi-agent`；Web 适配归入 `apps/api`；本地知识库归入 `.pi/knowledge` 与 `search_knowledge`；Skills 与提示模板归入 `.pi/skills` 与 `.pi/prompts`。本文不替代官方 SDK 文档。

## 结论

**事实**：Pi SDK 提供 `AgentSession` 供 Node/TypeScript 进程内调用；Web 不直接接触 SDK 或 Provider 密钥；API 注入 `read` 和 `search_knowledge` 两种只读能力；JSONL 要求每行一个完整事件帧。

**推论**：无隔离需求时进程内为默认路径；RPC/JSONL 适合隔离扩展或跨语言集成；错误脱敏后通过 SSE 输出可在保持可观测性的同时避免泄露凭据。

**未知**：不同 Provider 的 thinking 事件频率差异、JSONL 极端长文本下的最大行长度限制、多实例部署时内存 SessionManager 的状态共享方案，需在实际负载下验证。
