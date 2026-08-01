---
type: concept
title: Session 生命周期：架构视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。从资源加载、创建 session、提交 turn 到关闭的状态变化
resource: .pi/knowledge/library/pi-runtime/session-architecture.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, session, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: session
variant: architecture
---

# Pi Agent 运行时 Session 生命周期：从资源加载到关闭的架构边界与可替换接口

关键词：Pi Agent 运行时、Session 生命周期、AgentSession、ModelRuntime、DefaultResourceLoader、SSE/JSONL、Capability 边界。

## 摘要与问题边界

Pi Agent 运行时的 Session 生命周期不是“创建—对话—销毁”三段式叙述，而是从资源加载、能力注入、Turn 提交、事件流归一化到关闭清理的一整套状态转移。本文聚焦架构边界：哪些职责属于 Pi SDK 内核，哪些属于 API 宿主进程，哪些属于 Web 客户端。边界一旦模糊，就会出现浏览器侧泄露 provider key、session 关闭后仍推送事件、工具越权调用等风险。讨论范围限定在本仓库的 TypeScript/Node 侧实现，基于 `@earendil-works/pi-coding-agent` SDK；Web 侧只消费 SSE/JSONL 事件流。不讨论 provider 内部推理实现、LLM 训练数据、浏览器 UI 状态管理或多租户持久化方案。

## 核心概念与数据模型

1. **AgentSession**：一次可订阅、可提示、可释放的运行时上下文，是生命周期状态机的主体。Pi SDK 提供 `createAgentSession()` 工厂，它持有 `ModelRuntime` 引用、订阅者集合和工具集合。边界：一个 session 不能跨进程共享；API 进程重启后原有 `sessionId` 即失效，客户端必须重新创建。
2. **ModelRuntime**：决定调用哪个模型、是否启用 `thinking`、如何解析 provider 响应的可替换接口。判断：运行时应在 API 进程构造，浏览器只能传递 `runtimeAlias`，永远不能接触 provider key 或模型客户端实例。
3. **DefaultResourceLoader**：项目级资源加载器。事实：构造时必须传入项目 `cwd`；官方默认加载路径包括 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`。例外：`.pi/knowledge` 不自动加载，必须通过自定义 `search_knowledge` 工具显式读取。
4. **SessionManager**：session 注册表。本仓库使用 `SessionManager.inMemory()`。边界：只负责 identity 映射与 `dispose` 路由，不做任何语义预路由。异常：进程崩溃导致全部 in-memory session 与上下文丢失。
5. **Turn**：一次从用户提交到运行时返回完整响应或错误的完整回合。它包含 input message、tool calls、tool results、assistant message。事实：`turn_end` 是生命周期中的关键同步点，标志着一次 prompt 处理完毕。
6. **Event Stream**：运行时生成的事件序列。Pi 协议包含 `message_update`（`text_delta`、`thinking_delta`、`toolcall_*` 等）、`tool_execution_start/update/end`、lifecycle/retry 事件。API 层需将其归一化为 JSONL 输出给 Web。
7. **Capability / Tool Allowlist**：本仓库当前只暴露 `read` 与 `search_knowledge`。判断：虽然 Pi 官方内置支持写工具，但本项目边界只读；所有自定义工具必须用 `defineTool()` 实现并返回结构化 content/details。
8. **Lifecycle State Machine**：Created → Subscribed → Prompting → Streaming → ToolExecuting → TurnCompleted/Error → Disposed。边界：只有在 Subscribed 之后才能调用 `prompt()`；`dispose()` 后再调用 `prompt()` 应抛出或被 API 层包装为错误响应。

## 设计决策与取舍

### SessionManager 采用 in-memory 而非持久化

理由：当前 Web playground 的会话生命周期与浏览器标签一致，持久化会引入数据库依赖、session 恢复语义和过期策略。边界：`sessionId` 只在 API 进程内有效。例外：若未来需要多实例横向扩展，必须引入外部 store 并重新定义 session affinity 与重放语义。

### DefaultResourceLoader 随 session 创建重建而非全局单例

理由：`cwd` 可能因测试隔离、多仓库场景而变化；重建成本在单次 turn 中可控。边界：loader 不应缓存可变文件系统状态。例外：高并发只读场景可引入基于 mtime 的共享缓存，但需先验证 `.pi` 目录在运行期间不可变的假设。

### 强制 subscribe 在 prompt 之前

事实：Pi SDK 要求订阅必须先于 `session.prompt()`，否则事件会丢失。判断：API 层应在调用 `prompt()` 前检查订阅集合非空。边界：若 `subscribe` 成功后、`unsubscribe` 前发生错误，应让 lifecycle 事件通知客户端后再执行清理。

### 浏览器侧不持有 Pi SDK 或 provider key

理由：安全边界决定 provider key 只能在 API 进程。取舍：Web 失去直接调试 Pi SDK 的能力，但可通过 SSE Inspector 观察事件流。异常：本地开发禁止把 `VITE_*` 变量透传 provider key，所有 key 读取应限定在 `apps/api` 进程环境变量。

### 工具清单做减法

理由：`AGENTS.md` 明确当前只暴露 `read` 与 `search_knowledge`。边界：`read` 只能读工作区内允许路径；`search_knowledge` 只能查 `.pi/knowledge`。取舍：牺牲 agent 部分自主性，换取可审计、可回滚的安全边界。

## 可执行的实施流程

1. API 进程启动时读取模型配置，构造 `ModelRuntime`，但不预先构造 session。
2. 收到 `POST /api/session/create` 请求后，校验 `runtimeAlias` 与请求身份。
3. 以项目 `cwd` 实例化 `DefaultResourceLoader`。
4. 调用 `createAgentSession({ runtime, loader, tools: registeredTools })`。
5. 将 session 注册到 `SessionManager.inMemory()`，生成并返回 `sessionId`。
6. SSE 连接建立后，调用 `session.subscribe(handler)` 并记录 handler 引用。
7. 收到 `POST /api/turn` 请求后，校验 `sessionId` 存在且未 disposed，再调用 `session.prompt(message)`。
8. 通过 handler 将运行时事件转发为 JSONL；遇到 tool 事件时由 capability 层执行并回填结果。
9. Turn 结束或报错后，更新 session 内部状态，保留 session 以便后续 turn。
10. 客户端断开 SSE 或调用 `/api/session/close` 时，先 `unsubscribe` 再 `dispose`，并从 registry 移除。

## 输入、处理与输出示例

> 输入：`apps/web` 通过 `POST /api/session/create` 提交
> `{ "runtimeAlias": "default", "message": { "role": "user", "content": "解释 Session 生命周期" } }`
>
> 处理：`apps/api` 内部
> `loader = new DefaultResourceLoader({ cwd: projectRoot })`
> `runtime = createModelRuntime(config, loader)`
> `session = createAgentSession({ runtime, tools: [read, searchKnowledge] })`
> `manager.register(sessionId, session)`
> `session.subscribe((event) => res.write("data: " + JSON.stringify(event) + "\n\n"))`
> `session.prompt(message)`
>
> 输出：SSE/JSONL 片段
> `data: {"type":"message_update","delta":{"type":"thinking_delta","thinking":"..."}}`
> `data: {"type":"tool_execution_start","tool":"read","args":{"path":"AGENTS.md"}}`
> `data: {"type":"message_update","delta":{"type":"text_delta","text":"Session 生命周期..."}}`
> `data: {"type":"lifecycle","name":"turn_end"}`

说明：输入是 Web 层无 SDK 的纯 JSON；处理在 API 进程完成所有 Pi SDK 调用；输出是被 SSE 包裹的 JSONL 事件流，Web 侧仅负责渲染。

## 性能、质量和可观测性指标

1. **首次 token 延迟（TTFT）**：从 `prompt()` 调用到第一个 `message_update` 事件到达的时间。测量：在 API handler 中记录 `promptStart` 与 `firstDelta` 时间戳，按 `runtimeAlias` 聚合 P50/P95。
2. **Turn 端到端延迟**：从请求收到到 `turn_end` 事件发出的时间。测量：使用 turn 开始与结束时间戳，按工具调用次数分组。
3. **事件 delta 丢失率**：预期 delta 数与实际收到 delta 数之差。测量：在 subscribe handler 中计数，与 SDK 内部计数对比；差值大于 0 时告警。
4. **每 session 内存占用**：`AgentSession` 及上下文累积的估算。测量：Node 堆快照中按 `sessionId` 隔离，或记录 message history 字节数与工具结果大小。
5. **工具调用成功率**：`tool_execution_end` 中 `success=false` 的比例。测量：按工具名与参数模式聚合。
6. **订阅者泄漏率**：`dispose()` 后仍存在的 handler 引用数。测量：在关闭路径强制检查 registry 与 session subscriber 列表为空。

## 失败模式

1. **loader cwd 错误**。证据：`DefaultResourceLoader` 找不到 `.pi/prompts`，运行时提示资源缺失。恢复：在启动与每次构造时校验 `cwd` 下存在 `AGENTS.md` 与 `.pi` 目录；校验失败返回 500 并记录 `process.cwd()`。
2. **subscribe 在 prompt 之后**。证据：客户端收不到事件，但服务端日志显示模型已返回。恢复：API 层在 `prompt()` 前断言 `subscribers.size > 0`；失败时返回 409 并丢弃本次 turn。
3. **工具不在 allowlist**。证据：运行时尝试调用写工具，capability 层拒绝并返回 `tool_execution_end error=capability_denied`。恢复：返回结构化错误；检查 `AGENTS.md` 与 `defineTool` 注册表是否一致。
4. **SSE 连接中断**。证据：客户端只收到部分 delta，服务端出现 `ECONNRESET`。恢复：区分可重试与不可重试错误；turn 未结束时允许客户端重连，但当前 in-memory 实现暂不支持事件重放。
5. **session 泄漏**。证据：session 数量随时间增长，dispose 后仍占用堆内存。恢复：在 close 路径使用 `try/finally` 保证 `unsubscribe` 与 `registry.remove`；定期扫描 idleTimeout 未活跃的 session 强制清理。
6. **runtime 版本 skew**。证据：新 SDK 事件类型在旧 API 序列化失败。恢复：`packages/contracts` 显式枚举已知事件类型，未知类型走 `fallback` 字段并记录 warn。

## 问答测试样例

1. 正向：如何在 API 侧创建一个 session？答：构造 `DefaultResourceLoader` 与 `ModelRuntime`，调用 `createAgentSession()` 并注册到 `SessionManager.inMemory()`。
2. 正向：事件流应包含哪些 `message_update` delta？答：`text_delta`、`thinking_delta`、`toolcall_begin/result/text` 等，但 `thinking_delta` 仅在 `thinkingLevel` 启用且 provider 支持时出现。
3. 边界：一个 session 是否可以在不同浏览器标签间共享？答：不能；in-memory registry 与 `sessionId` 绑定到 API 进程；跨标签必须创建新 session。
4. 边界：关闭 session 后再次调用 `prompt()` 会怎样？答：应被拒绝或抛出；API 层需包装为 410 Gone。
5. 无证据拒答：Pi 运行时是否提供进程级沙箱隔离？答：无法从给定信息确认；`AGENTS.md` 指出 project trust 不是 sandbox，应视为未经验证的设计假设。
6. 无证据拒答：能否在浏览器中直接调用 `createAgentSession()`？答：不能；Web 侧禁止导入 Pi SDK，且 provider key 只能留在 API 进程。

## 维护、版本、来源和与相邻主题的关系

来源：本仓库 `AGENTS.md`、`packages/pi-agent` 实现、`@earendil-works/pi-coding-agent` 已安装版本。版本策略：Pi SDK 升级前必须跑 `pnpm typecheck` 与 `pnpm test`；新增事件类型需在 `packages/contracts` 中声明。相邻主题：与 ModelRuntime 配置、Custom Tool 定义、SSE/JSONL 传输、Project Trust/安全、Monorepo 构建流程相邻。维护检查清单：每次改动后运行 `git diff --check`；保留 `pnpm-lock.yaml` 同步；`.pi/` 目录变更需同步文档；`skills-lock.json` 与 `.agents/skills/` 由 Skills CLI 管理，禁止手工修改第三方 skill 文件。

## 结论

事实：Session 生命周期由 `AgentSession`、`ModelRuntime`、`DefaultResourceLoader`、`SessionManager`、Turn、Event Stream、Capability Allowlist 七个核心实体组成；当前仓库只暴露 `read` 与 `search_knowledge`；浏览器不接触 Pi SDK 与 provider key；`.pi/knowledge` 必须通过 `search_knowledge` 显式读取。

推论：in-memory registry 适合单进程 playground，但不适合多实例部署；强制 subscribe-before-prompt 是防止事件丢失的最小充分条件；将 provider key 限定在 `apps/api` 是当前安全边界下的必然选择。

未知：Pi SDK 内部事件顺序保证是否在所有 provider 实现中一致；`thinking` delta 在不同模型下的回退行为细节；外部 store 引入后的 session 恢复语义与重放策略尚未在本仓库设计。
