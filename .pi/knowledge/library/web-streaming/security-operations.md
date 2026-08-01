---
type: concept
title: 浏览器安全：验证与运维视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。保持 key、内部路径和宿主能力只在服务端可见
resource: .pi/knowledge/library/web-streaming/security-operations.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, security, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: security
variant: operations
---

# Web 流式交互中的浏览器安全：服务端持有 key、内部路径与宿主能力

## 摘要与问题边界

本文讨论在基于 Pi Agent Runtime 的 Web 流式交互中，浏览器仅作为展示与输入终端，不接触 Provider Key、项目内部路径、文件系统工具或模型 SDK 的能力。问题边界覆盖从浏览器发起请求到服务端调用 Pi SDK 并返回 SSE 事件流的完整链路，重点验证凭证隔离、资源加载、工具能力注入、错误恢复与延迟稳定性。运维视角要求把单次成功请求视为不充分证据，必须记录成功分布、失败模式、延迟分位、容量拐点与恢复时间。

## 核心概念与数据模型

1. 会话三元组：每个浏览器标签页对应一个 `sessionId`、一个 SSE 传输通道和一个 `AgentSession` 实例。服务端通过 `SessionManager.inMemory()` 维护生命周期，关闭页面时取消订阅并 dispose。
2. 事件流拓扑：服务端产生 `message_update`、`tool_execution_start`、`tool_execution_end`、`lifecycle`、`retry` 等事件；浏览器只消费 JSON 化后的 SSE 数据，不解析 Provider 原生流。
3. 凭证隔离边界：Provider Key 只出现在 `packages/pi-agent` 或 `apps/api` 的环境变量与进程内存中，浏览器请求体中只允许携带 `sessionId` 和用户文本。
4. 资源加载分层：`DefaultResourceLoader` 以项目 `cwd` 为根加载 `.pi/skills`、`.pi/prompts`、`AGENTS.md` 与 `.pi/knowledge`。文件路径解析在服务端完成，浏览器只收到经过过滤的响应片段。
5. 工具能力清单：服务端注册 `read` 与项目自定义 `search_knowledge`，均为只读；写文件、执行 shell 等能力不出现在浏览器可触达的接口中。
6. 传输信令契约：API 与 Web 之间通过 `packages/contracts` 共享 DTO，包括 `CreateSessionRequest`、`ChatMessage`、`StreamEvent`、`ErrorPayload`，确保序列化边界稳定。

## 设计决策与取舍

### 浏览器不直接引入 Pi SDK
Web 应用只使用标准 `fetch` 与 `EventSource` 消费 API，避免将 Provider Client 或模型密钥编译到前端产物。代价是浏览器无法本地构造 AgentSession，所有思考、工具调用、重试逻辑都依赖服务端。

### 服务端统一加载项目资源
`DefaultResourceLoader` 在 API 进程中初始化并复用，避免浏览器传递文件路径。副作用是资源加载的 I/O 与缓存压力集中在服务端，需要为 loader 设置 LRU 或文件监听。

### 只暴露只读工具
项目故意不将 Pi 内置的写文件、shell 执行等能力暴露给 Web 接口。这样可以降低 XSS 或会话劫持后的影响半径，代价是用户无法通过 UI 直接触发文件修改。

### SSE 替代 Provider 直连
使用 SSE 将多路事件统一推送到浏览器，而非让浏览器直接连接 Provider 的 WebSocket 或 HTTP 流。优点是隐藏 Provider 端点与认证头，缺点是 SSE 在弱网场景下更容易断连，需要重连与幂等设计。

### 会话状态集中在服务端内存
`SessionManager.inMemory()` 适合单实例 Web 演示，但多副本部署时会话会丢失。这是容量与扩展性上的取舍，生产部署应替换为共享存储或粘性会话。

## 可执行的实施流程

1. 在 `apps/api` 中定义 `POST /sessions` 与 `POST /sessions/:id/chat` 两个端点，前者创建 session 并返回 `sessionId`，后者接收用户文本并启动 SSE 流。
2. 在 `packages/pi-agent` 中实现 `createAgentSession(modelRuntime, resourceLoader)`，绑定 `SessionManager.inMemory()` 作为注册表。
3. 将项目 `cwd` 传入 `DefaultResourceLoader`，确保 `.pi/skills`、`.pi/prompts`、`AGENTS.md` 与 `.pi/knowledge` 可被加载。
4. 使用 `defineTool()` 注册 `read` 与 `search_knowledge`，返回结构化 content/details，并在 handler 中拒绝任何写入或路径穿越。
5. 在浏览器端用 `EventSource` 连接 `/sessions/:id/chat`，将事件按类型分发给 UI 组件；文本增量、思考增量、工具事件分别渲染。
6. 在服务端建立事件规范化层，将 Pi SDK 的 `message_update`、`toolcall_*` 等原生事件映射到 `packages/contracts` 定义的 DTO。
7. 实现错误边界：当 SSE 断连时，浏览器尝试带 `lastEventId` 重连；服务端在 `retry` 事件中返回已发送的最后一个事件序列号。
8. 运行端到端验证：使用 `pnpm dev` 启动 Web 与 API，连续发送 50 条请求，检查 `pnpm typecheck` 无错，并确认网络面板中没有 Provider Key 或 `.pi/` 内部路径泄露。

## 本地文件知识库与 TypeScript 示例

下面示例展示 API 如何初始化一个安全的会话并启动 SSE。输入是用户文本，处理在服务端完成，输出是规范化事件流。

    import { createAgentSession } from '@pi-agent/core';
    import { SessionManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
    import { searchKnowledgeTool } from './tools/search-knowledge';

    const loader = new DefaultResourceLoader({ cwd: process.cwd() });
    const sessionManager = SessionManager.inMemory();

    async function handleChat(req, res) {
      const session = await sessionManager.getOrCreate(req.sessionId, () =>
        createAgentSession({
          modelRuntime: configuredRuntime,
          resourceLoader: loader,
          tools: [readTool, searchKnowledgeTool],
          thinkingLevel: 'medium',
        })
      );

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const unsubscribe = session.on('event', (evt) => {
        const dto = normalizeEvent(evt);
        res.write(`event: ${dto.type}\n`);
        res.write(`id: ${dto.seq}\n`);
        res.write(`data: ${JSON.stringify(dto)}\n\n`);
      });
      session.prompt(req.body.text);
      req.on('close', () => {
        unsubscribe();
        session.dispose();
      });
    }

输入：HTTP 请求体仅含 `{ text: "..." }`，Cookie 或 Header 仅携带 `sessionId`。处理：服务端加载项目资源、调用模型、执行只读工具、归一化事件。输出：SSE 事件序列，浏览器收到文本增量、思考状态、工具开始与结束标记，但从未收到 Provider Key 或内部文件路径。

## 性能、质量与可观测性指标

1. 首 token 延迟：从浏览器提交请求到首次收到 `text_delta` 的耗时。应在 p50、p95、p99 三个分位记录，期望值低于 2 秒，异常阈值 5 秒。
2. SSE 流中断率：统计单位时间内未正常结束而断连的会话比例。通过 `lastEventId` 重连后补全的事件视为恢复，不计入中断。
3. 重连成功率：记录浏览器断连后首次重连即恢复流的次数占比。低于 95% 时检查网络层与 API 无状态假设。
4. 工具调用失败率：监控 `search_knowledge` 与 `read` 的异常返回占比。需要按异常类型细分：文件不存在、路径越界、超时、序列化错误。
5. 会话内存占用：在单实例进程中采样每个 `AgentSession` 与 `SessionManager` 的 RSS 增量。用于判断内存泄漏与单实例容量上限。

## 失败模式、诊断证据与恢复动作

1. SSE 连接反复断连：诊断证据是浏览器 `EventSource` 的 `readyState` 在 0 与 2 之间抖动，服务端日志出现大量 `ECONNRESET`。恢复动作是检查 Nginx 或负载均衡的 proxy_read_timeout，增加心跳事件，或实现指数退避重连。
2. Provider Key 出现在前端网络面板：诊断证据是响应或脚本中暴露 `OPENAI_API_KEY` 等字符串。恢复动作是立即轮换密钥，检查 Web 打包产物是否包含 `import` Pi SDK 的代码，并启用 CI 扫描 `grep -R "sk-" apps/web/dist`。
3. 工具越权尝试：诊断证据是日志中出现路径穿越参数如 `../../../etc/passwd`。恢复动作是拒绝该请求并告警，同时在 `read` 工具 handler 中强制 `path.resolve(cwd, requestedPath)` 并检查是否以 cwd 开头。
4. 会话状态丢失导致上下文重置：诊断证据是用户发现历史消息消失，服务端日志显示 `session not found`。恢复动作是区分 `inMemory` 与持久化模式，生产环境替换为 Redis 或粘性会话。
5. 资源加载失败导致模型上下文缺失：诊断证据是模型回答未引用 `.pi/knowledge` 内容，loader 缓存命中率为 0。恢复动作是检查 `cwd` 配置、文件权限、监听机制，并在启动时做一次同步预热。

## 问答测试样例

1. 正向：浏览器能否直接访问 Provider Key？答：不能。Key 只存在于服务端进程环境变量与 Pi SDK 配置中，浏览器请求与脚本中均不可见。
2. 正向：如果用户关闭浏览器标签页，服务端会话会怎样？答：通过 `req.on('close')` 触发 unsubscribe 与 dispose，会话资源被释放。
3. 边界：浏览器能否通过 SSE 拿到 `.pi/skills` 文件路径？答：不能。服务端只返回处理后的文本片段或工具结果，不暴露 loader 解析的绝对路径。
4. 边界：重连时是否可能丢失已生成的文本？答：如果服务端不记录 `lastEventId` 对应事件，则丢失；正确实现应在 `retry` 事件中返回序列号或支持从缓冲区补发。
5. 无证据拒答：浏览器端是否实现了沙箱？答：本文未提供浏览器端沙箱实现证据，不能据此声称沙箱存在；浏览器安全依赖凭证隔离与接口最小化。
6. 无证据拒答：多副本部署下会话是否持久？答：`SessionManager.inMemory()` 不持久，多副本会丢失会话；生产持久化需要额外证据。

## 维护、版本、来源与相邻关系

- 版本：与 `pnpm@10.30.3` 及 `@earendil-works/pi-coding-agent@0.83.0` 锁定一致；升级 Pi SDK 时需重新验证事件类型与 `defineTool()` 签名。
- 来源：项目上下文来自 `AGENTS.md` 与 `.pi/` 目录，Pi SDK 文档位于 `node_modules/@earendil-works/pi-coding-agent/docs/`。
- 相邻主题：与“LLM Provider 集成”相邻，共享模型运行时配置；与“Web 流式传输”相邻，共享 SSE 与 EventSource 实现；与“Agent 安全”相邻，涉及工具能力与资源隔离；与“可观测性”相邻，共享指标与日志规范；与“多副本部署”相邻，决定会话存储策略。

## 结论

事实：浏览器不持有 Provider Key、不加载 Pi SDK、不直接访问 `.pi/` 文件路径；服务端通过 `DefaultResourceLoader` 加载资源，并通过 `AgentSession` 注入只读工具；SSE 是 API 与 Web 之间的传输层。

推论：在单实例部署且 `SessionManager.inMemory()` 的前提下，会话生命周期可由服务端完全控制，关闭浏览器页面会触发资源释放；只暴露只读工具能降低凭证泄露与会话劫持后的影响半径。

未知：多副本或 Kubernetes 部署下的会话持久化方案、浏览器端 XSS 纵深防御的具体实现、Provider 流式 API 在中断后的精确续传语义，以及长会话在高并发下的内存峰值，均需要额外测试与架构证据。
