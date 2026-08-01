---
type: concept
title: RPC 与 JSONL：架构视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。进程内 SDK、RPC 和 JSONL 模式的边界以及 Web 适配方式
resource: .pi/knowledge/library/pi-runtime/rpc-architecture.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, rpc, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: rpc
variant: architecture
---

# Pi Agent 运行时：进程内 SDK、RPC 与 JSONL 的责任边界及 Web 适配

## 摘要与问题边界

在 Web 触发的 Pi Coding Agent 场景中，运行时存在三种协作形态：Node/TypeScript 进程内的 `AgentSession`、跨进程/跨语言时使用的 `RPC/JSONL` 桥接，以及面向浏览器的 Web API/SSE 适配层。本文要回答的不是“哪种模式更先进”，而是“哪一层必须承担哪项责任”。本项目的边界约定是：`packages/pi-agent` 负责会话生命周期与模型、工具、资源的配置；`apps/api` 负责请求校验、能力注入、密钥保管与事件传输；`apps/web` 只消费公共 API 的 SSE 流，不能接触 Pi SDK 或 provider 密钥。只有先把这些责任边界、可替换接口和升级路径说清楚，才能决定具体用哪一种序列化或进程模型。

## 核心概念与数据模型

1. `AgentSession`：Pi SDK 在进程内提供的会话对象，持有 `ModelRuntime`、已注册工具、资源加载器和可观察状态（如 `thinkingLevel`）。它是推理与工具调用的最小完整单元。
2. `ModelRuntime`：provider 客户端的封装，运行在 `apps/api` 进程内，持有 provider 密钥。它向外发出 `message_update` 增量（`text_delta`、`thinking_delta`、`toolcall_*`）以及重试/生命周期事件。
3. JSONL 事件协议：以换行分隔的 JSON 记录，每行一个自描述事件。该协议同时作为子进程双向流和 Web SSE 的帧格式基础。
4. RPC 传输层：需要进程隔离或语言边界时使用的桥接层，负责把 `AgentSession` 的对象调用编码为 JSONL 帧，并处理反向解析、心跳和异常退出。
5. 能力表面：本项目只暴露只读工具 `read` 和项目自定义的 `search_knowledge`。Pi 上游内置的写能力工具在本 playground 中不注入，避免在浏览器边界外产生未授权副作用。
6. `SessionManager`：在 `packages/pi-agent` 中维护的内存注册表，把 session 身份映射到具体的传输适配器（进程内或 RPC），并在连接关闭时执行取消订阅与销毁。
7. 资源加载器：`DefaultResourceLoader` 以项目 `cwd` 为根加载 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`。`.pi/knowledge` 中的文件不会自动加载，而是通过 `search_knowledge` 按需检索。
8. Web 适配器：`apps/api` 把运行时事件规范化为 SSE 帧；`apps/web` 只解析这些公共事件，渲染文本、思考块、工具执行与错误状态。

## 设计决策与取舍

### 1. 默认进程内 SDK，RPC 仅在确需隔离时启用
在 Node/TypeScript 一侧，直接创建 `AgentSession` 可避免跨进程序列化开销，保留类型检查和同步异常。只有当会话需要与不可信宿主隔离、跨语言运行，或复用已编译的 worker 时，才引入 `RPC/JSONL`。代价是 RPC 路径必须额外处理版本协商、心跳和进程生命周期。

### 2. JSONL 优先于二进制 RPC，换取可恢复与可审计
JSONL 的帧边界是换行符，便于在不完整缓冲区中逐行恢复，也便于日志审计。但协议需要显式的 `schema_version` 和 `event_type` 字段；二进制序列化在吞吐上可能更优，却会丧失可读性，并且在本项目中没有跨语言 IDL 生成需求。

### 3. API 层不预先路由语义意图
`apps/api` 只校验请求格式、注入允许的工具集合、建立 session，然后把用户消息交给 `AgentSession` 决定是直接回复还是调用工具。禁止在 API 中按关键字匹配“这是不是 read 命令”或“这是不是 search”，否则 Pi 的运行时信任模型会被绕过。

### 4. 浏览器端不暴露 Pi SDK 与 provider 密钥
provider 密钥必须停留在 `apps/api` 进程；`apps/web` 通过 HTTP/SSE 消费公共 API。所有模型增量、思考块、工具事件都必须先经过 API 规范化。这意味着任何新的原生 Pi 事件都需要先映射到公共 DTO 才能流向浏览器。

### 5. 只读工具表面是 host 边界的安全选择
虽然 Pi SDK 上游包含写工具，但本项目只注入 `read` 和 `search_knowledge`。所有工具响应必须通过 `content`/`details` 结构化返回。如果未来需要写能力，必须新增显式的授权/审批层，而不是简单把写工具加入当前注入列表。

### 6. `thinkingLevel` 在服务端控制，客户端不可假设
思考增量是否出现取决于配置的运行时 `thinkingLevel` 和 provider 支持。`apps/api` 保留过滤或不转发思考事件的权力，避免把模型内部推理细节泄露到浏览器。

## 可执行的实施流程

1. 在 `packages/contracts` 中定义公共 DTO：请求体、响应信封、SSE 流事件类型（`message_update`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`lifecycle`、`retry`、`error`）。
2. 在 `packages/pi-agent` 实现 `createAgentSession`：使用 `DefaultResourceLoader` 以项目 `cwd` 初始化，并加载 `.pi/skills`、`.pi/prompts`、`AGENTS.md`。
3. 注册工具：使用 `defineTool()` 注册 `read` 和 `search_knowledge`，所有返回使用结构化 `content` 和 `details`。
4. 配置 `ModelRuntime`：在 `apps/api` 启动时从环境变量读取 provider 密钥，注入运行时，并暴露 `thinkingLevel` observable。
5. 定义传输适配器接口 `ITransportAdapter`：包含 `prompt()`、`subscribe()`、`dispose()`，分别实现 `InProcessAdapter`（直接持有 `AgentSession`）和 `RpcJsonlAdapter`（启动子进程并通过 JSONL 通信）。
6. 实现 `SessionManager.inMemory()`：把 session id 映射到适配器实例，在连接关闭时取消订阅并销毁，释放文件描述符和子进程。
7. 实现 `apps/api` SSE 路由：校验请求，选择适配器，**先订阅事件再调用 `session.prompt()`**，把运行时事件转换为公共 DTO 后写入 SSE 流。
8. 实现 `apps/web` 事件解析：使用 `EventSource` 消费 SSE，按 `event_type` 分发到 UI 渲染器，处理断线重连和 `Last-Event-Id` 重放。
9. 编写集成测试：用固定 JSONL 帧序列测试 `RpcJsonlAdapter` 的解析器；注入假子进程以模拟 stderr 退出和半包 JSON。
10. 接入可观测性：为每个 session 记录 span，输出事件计数、首 token 时间、序列化耗时和错误码，并通过 `pnpm typecheck` 和 `pnpm test` 保持类型同步。

## 协议示例：一次搜索请求在 JSONL 中的映射

下面是一段贴近本项目的 JSONL 序列，展示输入、处理与输出。输入来自 Web 请求，处理由 `search_knowledge` 完成，输出是规范化的 SSE 事件。

    {"event_type":"request","session_id":"sess-7a3","body":{"message":"怎么让 Web 端不拿到 provider key？"}}
    {"event_type":"message_update","delta":"text_delta","payload":"这个问题要回到运行时边界。"}
    {"event_type":"tool_execution_start","tool":"search_knowledge","args":{"query":"provider key Web adapter boundary"}}
    {"event_type":"tool_execution_update","delta":"...","payload":"正在检索 .pi/knowledge"}
    {"event_type":"tool_execution_end","tool":"search_knowledge","result":{"content":"provider key 必须留在 apps/api 进程","details":{"source":".pi/knowledge/runtime-boundary.md"}}}
    {"event_type":"message_update","delta":"text_delta","payload":"因此，provider key 只应存在于 apps/api 的进程内存中。"}
    {"event_type":"lifecycle","status":"done"}

输入是 Web 端的 HTTP POST；处理阶段由 `AgentSession` 触发 `search_knowledge`，并通过 `RpcJsonlAdapter` 或 `InProcessAdapter` 把事件序列化；输出是 `apps/api` 写入 SSE 的帧，`apps/web` 只解析这些帧。

## 性能、质量与可观测性指标

- 首 token 时间（TTFT）：从收到 HTTP 请求到第一个 `message_update` 帧到达客户端的耗时，在服务端 span 中记录。
- 序列化开销：在相同提示下分别采样 `InProcessAdapter` 和 `RpcJsonlAdapter` 的端到端延迟，比较 P99 差异。
- 每会话内存：使用 `process.memoryUsage()` 或 Node heap snapshot，在 session 创建和销毁时计算增量。
- 事件吞吐：在包含多步工具链的会话中，统计每秒产出的 JSONL/SSE 帧数，识别瓶颈是模型还是序列化。
- 错误率：按适配器类型（`in-process`、`rpc-jsonl`）和 provider 分组统计会话失败比例。
- 工具返回合规率：检查 `tool_execution_end` 中返回的结构是否同时包含 `content` 和 `details`，未合规的视为质量事件。

## 失败模式、诊断证据与恢复动作

1. **RPC 子进程中途退出**：诊断证据是 JSONL 缓冲区以未完成的 JSON 行结束，并伴随子进程非零退出码。恢复动作是关闭当前 SSE、向客户端发送 `error` 帧，并在服务端销毁 session。
2. **JSONL 帧被 TCP 拆分**：诊断证据是缓冲区末尾为不完整的 JSON 行。恢复动作是维护一个行缓冲，遇到换行再解析，未遇到前不反序列化。
3. **provider 密钥缺失或无效**：诊断证据是 `ModelRuntime` 在创建 session 时抛出认证错误。恢复动作是返回 5xx 或 4xx，但响应中不得包含密钥本身。
4. **浏览器 SSE 连接断开**：诊断证据是客户端 `EventSource` 触发 `error` 且 `readyState` 为 reconnecting。恢复动作是客户端携带 `Last-Event-Id` 重连，服务端在 session 仍存活时重放已缓冲事件。
5. **工具返回非结构化内容**：诊断证据是 `tool_execution_end` 缺少 `content` 或 `details` 字段。恢复动作是 `apps/api` 拒绝该帧并记录日志，UI 降级为“工具返回格式异常”。
6. **思考增量被错误转发**：诊断证据是 `thinking_delta` 出现在 `thinkingLevel` 为 `off` 或 provider 不支持时的输出中。恢复动作是在 API 规范化层按配置过滤该事件。

## 问答测试样例

**Q1**：浏览器是否直接持有 provider 密钥？
**A1**：不。根据项目边界，provider 密钥只存在于 `apps/api` 进程中，`apps/web` 仅通过 SSE 消费公共事件。

**Q2**：何时应该使用 `RPC/JSONL` 而不是进程内 `AgentSession`？
**A2**：当需要进程隔离、跨语言边界，或复用独立 worker 时才使用。默认的 Node/TypeScript 集成应直接使用 `AgentSession`。

**Q3**：`.pi/knowledge` 是否由 `DefaultResourceLoader` 自动加载？
**A3**：不是。`DefaultResourceLoader` 自动加载 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`，`.pi/knowledge` 只能通过 `search_knowledge` 按需检索。

**Q4**：API 层是否可以根据用户消息中的关键字直接决定调用 `read`？
**A4**：不可以。API 只负责校验与能力注入，是否调用工具由 `AgentSession` 运行时决定。任何 API 层语义预路由都会破坏信任边界。

**Q5**：Pi SDK 是否支持 gRPC 传输？
**A5**：本项目的文档和依赖约定中没有这一声明。已知形态是进程内 SDK 和基于 JSONL 的 RPC；gRPC 属于未经验证的未知。

**Q6**：如果工具返回只有 `content` 没有 `details`，系统应该怎么表现？
**A6**：`apps/api` 应将其视为不合规输出，拒绝该帧，客户端显示降级信息，并记录可观测日志。

## 维护、版本、来源与相邻主题

- **版本管理**：使用 `pnpm` 锁定 `@earendil-works/pi-coding-agent` 版本；`pnpm-lock.yaml` 必须随代码变更同步。JSONL 协议本身应维护独立版本号，通过请求中的 `schema_version` 协商。
- **来源**：本文内容基于 `AGENTS.md`、`docs/pi-agent-learning.md`、`docs/adr/0001-monorepo-and-pi-boundary.md` 以及项目代码中的 `packages/pi-agent`、`packages/contracts`、`apps/api`、`apps/web` 边界。上游文档作为参考，但实现应以已安装的 SDK 版本为准。
- **相邻主题**：东侧是 Skills 与 Prompt 模板加载（`.pi/skills`、`.pi/prompts`），南侧是 `ModelRuntime` 与 provider 配置，西侧是 `apps/web` 的 SSE 与 UI 组件，北侧是主机信任边界与写工具的授权策略。

## 结论

- **事实**：`AgentSession` 是 Node/TypeScript 一侧的默认形态；`apps/api` 持有密钥并只暴露 `read` 和 `search_knowledge`；`apps/web` 不接触 Pi SDK 和密钥；`DefaultResourceLoader` 不自动加载 `.pi/knowledge`。
- **推论**：JSONL 作为可审计的文本协议，适合在 RPC 和 Web SSE 之间复用帧语义；在不需要进程隔离时，进程内适配器总是更优。
- **未知**：未来是否引入 gRPC、二进制序列化、或授权后的写工具，取决于上游 SDK 演进和具体宿主安全需求，当前项目未给出确定性设计。
