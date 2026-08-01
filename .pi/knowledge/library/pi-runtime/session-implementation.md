---
type: concept
title: Session 生命周期：实现视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。从资源加载、创建 session、提交 turn 到关闭的状态变化
resource: .pi/knowledge/library/pi-runtime/session-implementation.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, session, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: session
variant: implementation
---

# Pi Agent 运行时 Session 生命周期实现指南

## 摘要与问题边界

本文从实现视角描述 Pi Agent 在 TypeScript 代码中的完整 Session 生命周期，覆盖从项目资源加载、Session 创建、turn 提交到关闭与释放的状态变化。目标读者是把方案落到 `packages/pi-agent` 与 `apps/api` 的开发者。讨论范围限定为：`AgentSession` 的创建与订阅、`DefaultResourceLoader` 的构造与重载、工具注册、`ModelRuntime` 配置、SSE 事件归一化、以及 `SessionManager.inMemory()` 的注册与清理。不涉及 Web UI 的 React 渲染、也不展开 provider 内部并发算法或模型训练细节。

## 核心概念与数据模型

1. **项目资源加载器（DefaultResourceLoader）**
   以项目 `cwd` 为根，读取 `.pi/skills`、`.pi/prompts`、`AGENTS.md`。`.pi/knowledge` 不自动加载，必须通过自定义 `search_knowledge` 工具按需查询。加载器是 Session 的输入源，而不是 Session 本身。

2. **Session 身份与注册表**
   `SessionManager.inMemory()` 为当前 Web 会话维护一个内存注册表，把生成的 session id 映射到 `AgentSession` 实例。该注册表是“临时、进程内、单 Web 会话”的，重启即清空。

3. **模型运行时（ModelRuntime）**
   封装 provider、model、温度/thinkinglevel 等参数，provider key 只能在 API 进程中出现，绝不能序列化给浏览器。

4. **AgentSession 实例**
   由 `createAgentSession()` 创建，内部持有事件订阅、待处理 turn、工具注册表、当前生命周期状态。它是“一次性”还是“可复用”取决于具体 runtime 约定，但关闭后必须调用 dispose。

5. **Turn 边界**
   一次 turn = 一次 `session.prompt()` 调用 + 到 `message_update` 结束为止的后续事件。工具调用可能穿插其间，但仍在同一 turn 内，直到收到 `message_complete` 或 error/abort。

6. **归一化事件流**
   上层需要消费的事件包括：`text_delta`、`thinking_delta`、`toolcall_*`、`tool_execution_start/update/end`，以及 lifecycle/retry 事件。API 层负责把这些事件统一为 SSE 行，不暴露原始 SDK 差异。

7. **能力注入与只读工具面**
   当前暴露 `read` 与自定义 `search_knowledge` 两个只读工具。所有自定义工具必须用 `defineTool()` 声明，返回结构化 `content/details`，禁止返回任何可用于写文件或执行 shell 的句柄。

8. **生命周期状态**
   建议把 Session 显式建模为：`initializing → ready → prompting → tool_executing → closing → disposed`。状态转换必须可观测、可记录。

## 设计决策与取舍

### 1. 先订阅再 prompt
Pi SDK 的事件可能在调用 `session.prompt()` 后立即产生。若先提交再订阅，第一个 `text_delta` 或 `thinking_delta` 会丢失。实现上必须在 `session.prompt()` 之前完成所有事件监听器的挂载。

### 2. 内存注册表而非持久 Session store
当前 playground 面向单 Web 会话，使用 `SessionManager.inMemory()` 足够轻量。代价是 API 进程重启后所有活跃 Session 失效；若后续需要跨部署保留上下文，应改用外部 store，但需额外处理序列化与密钥隔离。

### 3. provider key 不出 API 进程
Web 应用只能消费 SSE；任何 provider key、base URL、模型凭据都只在 `apps/api` 的环境变量或运行时变量中存在。序列化配置给前端时必须显式剥离这些字段。

### 4. 只读工具面与 capability-limited 自定义工具
项目故意不暴露写文件、执行命令等内置能力。`search_knowledge` 虽然自定义，但只返回 Markdown 片段；`read` 只返回文件内容。工具参数与结果用于诊断，不能替代授权检查。

### 5. API 不预路由语义
`apps/api` 只做请求验证、Session 路由、SSE 传输，不做意图识别或关键词路由。是否调用工具、调用哪个工具，由 Pi runtime 决定。

## 可执行的实施流程

1. 校验入站 DTO：session id 格式、model 配置、`thinkingLevel` 是否合法。
2. 以项目 `cwd` 构造 `DefaultResourceLoader`，读取 `.pi/skills`、`.pi/prompts`、`AGENTS.md`。
3. 验证 `.pi/knowledge` 是否可通过 `search_knowledge` 访问，而不是直接加载到 prompt。
4. 根据请求创建 `ModelRuntime`，注入 provider key 与可观测的 `thinkingLevel`。
5. 通过 `defineTool()` 注册 `read` 与 `search_knowledge`，确认返回结构符合 `{ content, details }`。
6. 调用 `createAgentSession()`，拿到 `AgentSession`，并在 `SessionManager.inMemory()` 中注册。
7. 在首次 `session.prompt()` 之前订阅所有事件流，把事件归一化为 SSE 行输出给客户端。
8. 提交 turn：调用 `session.prompt()`，消费 `text_delta`、`thinking_delta`、`toolcall_*`、工具执行与 lifecycle 事件。
9. 客户端断开或主动关闭时，先 unsubscribe，再调用 dispose，最后从注册表移除。
10. 运行 `pnpm typecheck`、`pnpm test`、`pnpm lint`，并通过 `git diff --check` 检查空白错误。

## 输入、处理、输出示例

下面是一段贴近实现的事件流片段，表示一次读取本地知识库后返回文本的 turn：

    // 输入：客户端 POST /api/session/{id}/turn
    {
      "model": "claude-sonnet-4",
      "thinkingLevel": "medium",
      "messages": [
        { "role": "user", "content": "解释 .pi/knowledge 的加载边界" }
      ]
    }

    // 处理：API 校验 → 创建/复用 AgentSession → 调用 search_knowledge → 聚合结果 → 提交给 runtime
    {
      "tool": "search_knowledge",
      "input": { "query": ".pi/knowledge 加载边界" },
      "result": {
        "content": ".pi/knowledge 必须由 search_knowledge 按需读取，DefaultResourceLoader 不自动注入。",
        "details": { "sources": [".pi/knowledge/agent-lifecycle.md"] }
      }
    }

    // 输出：SSE 多行事件
    event: text_delta
    data: { "delta": ".pi/knowledge" }

    event: text_delta
    data: { "delta": " 必须经由 search_knowledge 读取。" }

    event: message_complete
    data: { "turnId": "turn_20250811_001" }

输入是 HTTP JSON；处理发生在 `apps/api` 与 `packages/pi-agent`；输出是 SSE 事件流，Web 端消费后逐字渲染。

## 性能、质量和可观测性指标

1. **首字延迟（Time to First Delta）**
   测量 `session.prompt()` 调用到第一个 `text_delta` 的时间。目标按模型分级，超过阈值即告警。

2. **工具执行耗时**
   记录 `tool_execution_start` 与 `tool_execution_end` 之间的时间，用于判断 `read`/`search_knowledge` 是否卡住。

3. **事件吞吐与丢失率**
   在归一化层为每个事件编号，对比客户端确认收到的数量；若 `sent !== received`，说明订阅时机或网络存在问题。

4. **Session 泄漏数**
   定时检查 `SessionManager.inMemory()` 中注册表大小与活跃 Web 连接数的差值。差值持续为正表示 dispose 未执行。

5. **Turn 错误率**
   统计 `error` 与 `retry` 事件占 turn 总数的比例，按 provider/model 维度分组。

6. **资源加载缓存命中率**
   `DefaultResourceLoader` 可缓存 `.pi/skills` 与 `.pi/prompts`；命中率高说明重启间可复用，低则说明频繁重读磁盘。

## 失败模式、诊断证据与恢复动作

1. **先 prompt 后订阅导致首段文本丢失**
   证据：客户端首条消息显示不完整，服务端日志中第一个 `text_delta` 早于订阅时间戳。
   恢复：强制 `subscribe` 在 `session.prompt()` 之前；事件归一化层增加“订阅前无事件”断言。

2. **provider key 随配置泄露到前端**
   证据：浏览器 Network 中 response 包含 `apiKey` 或 `providerKey` 字段。
   恢复：立即轮换 key；在 DTO 序列化层显式 `delete config.apiKey` 并增加单元测试。

3. **自定义工具返回非结构化内容**
   证据：归一化层出现 `Cannot read properties of undefined (reading 'content')`。
   恢复：在 `defineTool()` 的 handler 内用 Zod/schema 校验返回值，不符合时返回 `{ content: '', details: { error: '...' } }`。

4. **客户端断连后 Session 未释放**
   证据：注册表大小持续上升，`/metrics` 中 `active_sessions` 与 WebSocket/SSE 连接数不符。
   恢复：在连接 close 事件里执行 `unsubscribe()`、`session.dispose()`、然后从 `SessionManager` 删除。

5. **`.pi/knowledge` 被误当成自动 prompt 资源**
   证据：token 用量异常高，系统提示里出现整篇知识库 Markdown。
   恢复：从 `DefaultResourceLoader` 加载列表中移除 `.pi/knowledge`，强制通过 `search_knowledge` 按需检索。

6. **thinking 关闭时仍收到 thinking delta**
   证据：`thinkingLevel === 'off'` 但客户端收到 `thinking_delta` 事件。
   恢复：在归一化层根据 `thinkingLevel` observable 过滤；若 provider 仍发送，则记录 warn 并丢弃。

## 问答测试样例

1. **正向**：Session 创建后、首次 prompt 前必须做什么？
   期望：先订阅事件流；否则可能丢失初始 delta。

2. **正向**：`DefaultResourceLoader` 默认加载哪些项目资源？
   期望：`.pi/skills`、`.pi/prompts`、`AGENTS.md`。

3. **边界**：一个 turn 中发生两次 `search_knowledge` 工具调用，是否属于同一 turn？
   期望：属于，直到 `message_complete` 或错误/abort 才结束该 turn。

4. **边界**：`thinkingLevel` 设置为 `off` 时上层应如何表现？
   期望：不归一化 `thinking_delta`；若 SDK 仍发送则丢弃并记录 warn。

5. **拒答**：如果用户问“Pi SDK 内部 LLM 的采样温度默认值是多少”，但项目未配置默认值，应如何回答？
   条件：只能回答项目级可验证配置；未提供默认值时回答“未知，需查看运行时传入配置或 SDK 文档”。

6. **拒答**：用户要求通过 `read` 工具修改 `AGENTS.md`，能否执行？
   条件：`read` 是只读工具，无写入能力；应拒绝并说明工具 capability 受限。

## 维护、版本、来源与相邻主题关系

- **版本**：当前项目依赖 `@earendil-works/pi-coding-agent` 0.83.0，实现前应先核对 `node_modules` 中对应版本 SDK 的 `docs/sdk.md`，避免使用上游 main 才出现的新 API。
- **来源**：约定与接口来自项目 `AGENTS.md`、`packages/pi-agent` 的实现边界，以及 Pi 官方 SDK 文档中的 `AgentSession`、`ModelRuntime`、`SessionManager` 说明。
- **相邻主题**：
  - 与“自定义工具”相邻：`defineTool()` 与 `search_knowledge` 的实现。
  - 与“SSE 事件协议”相邻：API 如何把 SDK 事件转成 JSONL/SSE。
  - 与“Provider 配置”相邻：`ModelRuntime` 与密钥隔离。
  - 与“Prompt 模板”相邻：`.pi/prompts` 加载发生在 Session 创建前。

## 结论

**事实**：Session 生命周期包括资源加载、`AgentSession` 创建、`SessionManager.inMemory()` 注册、订阅事件、提交 turn、消费 delta 与工具事件、最后 unsubscribe 与 dispose；`apps/api` 只暴露只读 `read` 与 `search_knowledge`；`thinkingLevel` 是上层可观测的过滤条件。

**推论**：为了保证事件不丢失，必须先订阅再 `prompt`；内存注册表适合当前单 Web 会话 playground，若产品化需要跨进程状态，必须引入外部 store 并重新设计密钥与序列化边界。

**未知**：Pi SDK 在不同 provider 下对同一 turn 中事件顺序的具体保证、`tool_execution_*` 与 `message_update` 的并发上限、以及未来版本是否会把 `.pi/knowledge` 改为自动加载，都需要以实际 SDK 测试为准。
