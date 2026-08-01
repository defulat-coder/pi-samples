---
type: concept
title: 浏览器安全：实现视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。保持 key、内部路径和宿主能力只在服务端可见
resource: .pi/knowledge/library/web-streaming/security-implementation.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, security, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: security
variant: implementation
---

# 浏览器安全：服务端持有能力密钥的 Web 流式交互实现指南

## 摘要与问题边界

在浏览器与后端之间建立流式交互时，所有敏感能力必须留在服务端进程内。浏览器只发送用户消息、接收事件流，绝不应接触大模型供应商密钥、项目内部文件路径或宿主级工具能力。本指南面向使用 TypeScript 构建 Web + API 的开发者，重点说明在编码之前需要明确的输入、输出、错误、生命周期与验证步骤，并给出可复现的边界判断。

问题边界限定为：基于 Server-Sent Events 的 Web 流式对话。不涉及浏览器本地模型推理、不涉及第三方 OAuth 登录、不涉及持久化会话存储。安全假设是：浏览器、传输层、前端代码均被视为不可信，API 进程是可信边界。

## 核心概念与数据模型

1. **ClientRequest DTO**：浏览器发送的字段仅包含 `message`、`sessionId`、`thinkingLevel`、`streamFormat`。任何 `apiKey`、`projectPath`、`toolRegistry` 字段都不应出现在 schema 中。
2. **ServerSession**：在 API 进程内维护的对象，包含 `sessionId`、关联的 `ModelRuntime`、工具白名单、创建时间戳与最后活动时间。`SessionManager.inMemory()` 是当前的注册表实现，会话重启即失效。
3. **CredentialBundle**：仅在服务端环境变量或 API 进程内存中可用的配置，包括供应商密钥、模型运行时构造参数、资源加载器的 `cwd`。该对象永不序列化给前端。
4. **ResourceLoader**：以项目根目录为 `cwd` 初始化，负责加载 `.pi/skills`、`.pi/prompts`、`.pi/knowledge` 与 `AGENTS.md`。前端只通过 `search_knowledge` 工具获取结果摘要，而非原始路径。
5. **EventStream**：从服务端到浏览器的推送格式，事件类型包括 `text_delta`、`thinking_delta`、`toolcall_start`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`lifecycle`、`retry` 与 `error`。
6. **CapabilityPolicy**：描述当前会话可调用哪些工具的声明。例如，仅暴露 `read` 与 `search_knowledge` 两个只读工具，所有写、执行、网络、文件系统工具均不注册。

## 设计决策与取舍

**服务端持有全部密钥**。供应商密钥只在 API 进程内使用，环境变量注入，构建产物与浏览器代码均不引用。若发现 `apps/web` 中任何文件出现 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`，即视为配置错误。

**内部路径对浏览器不可见**。项目根目录、`.pi` 目录、技能文件路径均不返回给客户端。`search_knowledge` 的结果只返回 Markdown 文本摘要，不返回绝对路径或文件句柄。

**SSE 优先于 WebSocket**。SSE 基于 HTTP，天然支持自动重连、标准认证与负载均衡；代价是只能单向推送。若需要浏览器向后端发送额外指令，应通过独立的 POST 请求，而非建立双向通道。

**会话由服务端创建与销毁**。浏览器不持有 `AgentSession` 对象，只持有不透明的 `sessionId`。`createAgentSession()` 在 API 中调用，并在浏览器断开时触发 `unsubscribe` 与 `dispose`。

**工具白名单硬编码在 API 层**。Pi 运行时决定何时调用工具，但 API 层在注册时已经过滤可用工具。`apps/api` 不做语义预路由，只执行能力注入与允许列表校验。

**读取工具保持只读**。`read` 与 `search_knowledge` 均返回结构化内容，且不修改文件系统。任何尝试写入、删除、执行命令的工具定义都不会被加入 `session.tools`。

## 可执行的实施流程

1. 在 `packages/contracts` 中定义 `ClientRequest`、`StreamEvent`、`ErrorEvent` 的 Zod schema，明确列出允许字段。
2. 在 `apps/api` 中实现路由处理器，先用 Zod 验证请求体，再校验 `Content-Type` 与 `Accept: text/event-stream`。
3. 从服务端环境变量读取供应商密钥，构造 `ModelRuntime`；在 `packages/pi-agent` 中封装该逻辑，避免 API 层直接引用 SDK 细节。
4. 使用 `SessionManager.inMemory()` 注册会话，生成 UUID 作为 `sessionId`，记录创建时间与 `remoteAddr`。
5. 在调用 `session.prompt()` 之前先订阅事件，将 SDK 事件映射为 `StreamEvent` 类型。
6. 开启 SSE 响应，设置 `Cache-Control: no-cache`、`Connection: keep-alive`、CORS 白名单，并周期性发送心跳注释。
7. 在事件转发中校验 payload，确保任何包含绝对路径、内部文件名的字段被过滤或替换为相对标识。
8. 实现错误包装：将 SDK 异常、验证失败、超时统一映射为 `error` 事件，并在严重错误时关闭流。
9. 在浏览器端实现事件消费者，仅负责渲染、重连与取消按钮；不引入 Pi SDK，不访问任何密钥。
10. 补充单元测试与集成测试，覆盖合法请求、越权字段、工具白名单、路径泄露、断线重连五种场景。

## 输入、处理与输出示例

```typescript
// apps/api/src/routes/chat.ts
export async function chatHandler(req: Request, res: Response) {
  const body = ClientRequestSchema.parse(req.body);
  const runtime = createServerOnlyRuntime(process.env.MODEL_KEY!);
  const session = SessionManager.inMemory().create(runtime, {
    cwd: process.env.PROJECT_CWD!,
    tools: [readTool, searchKnowledgeTool],
  });
  session.subscribe((event) => {
    const safe = sanitizeEvent(event);
    res.write(`event: ${safe.type}\ndata: ${JSON.stringify(safe.payload)}\n\n`);
  });
  await session.prompt(body.message);
  session.unsubscribe();
  session.dispose();
}
```

输入是浏览器 JSON 中的 `message` 与 `thinkingLevel`。处理阶段在服务端完成：解析请求、创建会话、订阅事件、调用模型、过滤输出。输出是 SSE 流事件，浏览器接收的每一段数据都已剥离密钥与路径。

## 性能、质量与可观测性指标

- **首 token 时间**：从请求到达 API 到首个 `text_delta` 事件发出的毫秒数，可用日志中的 `requestReceived` 与 `firstDeltaSent` 时间戳计算。
- **事件吞吐**：每秒钟发送的 SSE 事件数，用于检测模型后端 stalls 或网络阻塞。
- **会话内存占用**：`SessionManager.inMemory()` 中活跃会话数量与每个会话引用对象体积，通过内存快照或运行时指标统计。
- **错误率**：按事件类型分类的 `error` 事件占比，重点观察 `tool_execution_end` 与 `lifecycle` 类错误。
- **重连次数**：浏览器 SSE 在 30 分钟会话内的 `EventSource` 重连次数，用于评估网络稳定性。
- **路径泄露检测**：对每条发往浏览器的数据做正则扫描，若出现 `/.pi/`、`/Users/` 或 `node_modules` 等模式，立即告警并断开连接。

## 失败模式、诊断证据与恢复动作

1. **浏览器包含供应商密钥**：证据是 `apps/web` 产物中出现 `sk-` 或 `ANTHROPIC_API_KEY`。恢复动作是 CI 静态扫描阻断，并将密钥移入 API 环境变量。
2. **内部路径通过工具结果泄露**：证据是响应命中路径泄露正则。恢复动作是在 `sanitizeEvent` 中强制替换，并记录违规工具。
3. **会话过期或找不到**：证据是 `sessionId` 不在 `SessionManager` 中。恢复动作是返回 404，让前端重新初始化会话。
4. **恶意工具参数注入**：证据是工具参数中出现路径遍历或 shell 元字符。恢复动作是参数 schema 校验，拒绝命中黑名单的调用。
5. **SSE 流卡住**：证据是 30 秒内未发送任何心跳或事件。恢复动作是浏览器自动重连，服务端超时关闭旧会话。
6. **CORS 配置错误**：证据是 `Origin` 头不在白名单。恢复动作是拒绝非信任域名的 SSE 请求，防止第三方网站读取流内容。

## 问答测试样例

1. **正向**：浏览器发送 `{ message: "解释项目架构" }`，是否返回不含密钥的 SSE 文本？预期为是。
2. **正向**：`search_knowledge` 返回的内容是否只包含 Markdown 摘要？预期为是。
3. **边界**：请求中携带 `apiKey` 字段，应被 Zod 校验拒绝，返回 400。
4. **边界**：工具返回的结果中出现绝对路径 `/Users/xbjt/...`，`sanitizeEvent` 应替换为 `internal` 并继续输出。
5. **无证据拒答**：若用户询问“本实现是否支持 WebSocket？”且无文档说明，应回答“未在当前设计中使用，无法确认”。
6. **无证据拒答**：若用户询问“会话能否持久化到数据库？”因当前使用 `inMemory` 注册表，应回答“当前实现不支持持久化，重启即失效”。

## 维护、版本、来源与相邻主题

本设计依赖 `@earendil-works/pi-coding-agent` SDK 提供的 `AgentSession`、`createAgentSession`、`defineTool` 与事件协议。`apps/api` 只应升级经过测试的 SDK 版本，并在升级后运行 `pnpm typecheck` 与 `pnpm test`。

相邻主题包括：模型运行时配置、自定义工具定义、SSE 重连策略、TypeScript monorepo 边界划分。安全机制与这些主题交叉时，应以“服务端持有能力”原则作为统一判断标准。

## 结论：事实、推论与未知

**事实**：供应商密钥、项目 `cwd`、`.pi` 目录路径、工具注册表只在 `apps/api` 与 `packages/pi-agent` 中可见；浏览器仅消费 SSE 事件；工具白名单仅包含只读工具。

**推论**：只要 API 进程不被攻破，且事件过滤逻辑正确，浏览器无法直接获得宿主能力。会话内存占用与重连频率可作为运行健康度的代理指标。

**未知**：不同供应商模型运行时的事件粒度与重试行为存在差异；长期运行的会话是否需要持久化或限流策略；浏览器端内容安全策略（CSP）的最小允许集合尚需根据实际部署域名进一步收紧。
