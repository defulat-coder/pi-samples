---
type: concept
title: 浏览器安全：架构视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。保持 key、内部路径和宿主能力只在服务端可见
resource: .pi/knowledge/library/web-streaming/security-architecture.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, security, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: security
variant: architecture
---

# Web 流式交互中的浏览器安全：服务端隔离架构

## 摘要与问题边界

Web 流式交互将语言模型的增量输出、工具事件与生命周期信号通过 SSE/JSON 推送给浏览器。浏览器位于不可信边界：用户脚本、扩展、网络中间人、共享设备都可能读取内存或抓包。因此，API 密钥、模型运行时内部路径、宿主级能力（文件写入、子进程执行、扩展加载）必须永远只驻留在服务端进程内部。本文的边界覆盖从服务端到浏览器的传输层，不讨论浏览器插件市场自身的安全模型，也不替代 TLS 与身份认证，而是聚焦“什么信息根本不应该出现在浏览器可接触的字节流中”。

## 核心概念与数据模型

1. **能力面（Capability Surface）**：服务端向浏览器暴露的最小接口集合。在本项目中只包含 `read` 与 `search_knowledge` 两个只读工具，任何写入、执行、加载扩展的能力均不在能力面内。
2. **事件信封（Event Envelope）**：SSE 消息只携带 `type`、`payload` 与 `correlationId`。`payload` 在序列化前必须经过过滤层，剥离 `apiKey`、`internalPath`、`hostCapabilities` 等字段。
3. **传输 DTO（Transport DTO）**：`packages/contracts` 定义的多端共享数据结构，只包含浏览器需要渲染的字段，例如文本增量、思考增量、工具调用名与结构化结果摘要。
4. **运行时注册表（Runtime Registry）**：`ModelRuntime` 与 `AgentSession` 的实例化只发生在 `packages/pi-agent` 或 `apps/api` 进程内，浏览器通过会话标识间接引用，从不持有运行时对象。
5. **资源加载器（Resource Loader）**：`DefaultResourceLoader` 以服务端 `cwd` 构造，读取 `.pi/skills`、`.pi/prompts`、`.pi/knowledge` 等路径。这些路径字符串属于内部实现细节，不得进入 SSE 流。
6. **能力注入点（Capability Injection Point）**：在 `apps/api` 的请求处理层，根据会话身份与配置注入允许的工具集合。注入逻辑是显式的、可单元测试的，而非由模型动态决定。
7. **订阅生命周期（Subscription Lifecycle）**：`session.prompt()` 调用前必须先订阅；会话关闭时必须取消订阅并释放资源，防止浏览器侧异常导致服务端句柄泄漏。
8. **宿主边界（Host Boundary）**：Pi 项目信任机制只保护资源加载，不提供沙箱。Shell、文件系统、扩展、提示词、模型输出和检索文件均应视为不可信输入，由宿主边界实施审批与隔离。

## 设计决策与取舍

### 1. 浏览器绝不接收 Pi SDK 或模型客户端

`@earendil-works/pi-coding-agent` 仅在 `packages/pi-agent` 与 `apps/api` 中导入。`apps/web` 只消费 SSE/JSON 协议。取舍是前端无法做本地工具编排，任何工具调用都必须回环服务端，这增加了网络往返，但消除了密钥与运行时对象泄露面。

### 2. 只读工具优先，写入能力默认关闭

虽然 Pi 官方内置包含写能力工具，但本项目 intentionally 只暴露 `read` 与 `search_knowledge`。需要写入的场景应通过独立的有状态服务审批后再执行，而不是通过流式会话直接暴露。取舍是交互延迟略高，但单次会话的爆炸半径被限制为只读。

### 3. 内部路径作为实现细节过滤

`.pi/skills`、`.pi/prompts`、`.pi/knowledge` 与 `node_modules` 中的绝对路径只用于服务端 `ResourceLoader`。事件规范化和 DTO 映射层会校验并删除任何包含文件系统路径的字段。例外：当工具返回的结果需要引用知识来源时，只返回人工可读的片段标识或摘要，而非磁盘路径。

### 4. 服务端持有 Provider 密钥，浏览器持有会话句柄

API 进程通过环境变量或受控密钥存储读取 provider key。浏览器只获得 `sessionId` 与一次性 `connectionToken`，且 `connectionToken` 具有短 TTL。即使 token 泄露，攻击者也仅能获得只读 SSE 流，无法访问密钥或内部文件。

### 5. 可替换接口先于具体实现

`SessionManager`、`ModelRuntime`、`ToolRegistry`、`EventNormalizer` 均定义为接口，具体实现可替换为内存版、Redis 版或持久化日志版。该决策保证安全策略不依赖于 `SessionManager.inMemory()` 这一当前实现，未来切换运行时无需重写访问控制逻辑。

## 可执行的实施流程

1. 在 `packages/contracts` 中定义浏览器可见的 SSE DTO，显式列出允许字段，默认拒绝未声明字段。
2. 在 `packages/pi-agent` 实现 `EventNormalizer`，将 Pi 的 `message_update`、`tool_execution_*` 等事件映射为 DTO，删除 `apiKey`、`internalPath`、`cwd`、`hostCapabilities`。
3. 在 `apps/api` 构建能力注入中间件，根据请求身份读取配置，构建仅含 `read` 与 `search_knowledge` 的工具注册表。
4. 将 provider key 读取逻辑限制在 API 进程启动阶段，禁止在请求处理上下文中读取或序列化密钥。
5. 实现 `ResourceLoader` 时，确保其构造参数与加载日志不进入事件流；错误消息中不带绝对路径。
6. 为 SSE 连接引入 `connectionToken`，设置短 TTL 与单点失效，关闭标签页即服务端清理会话。
7. 在 `apps/web` 中仅使用 `EventSource` 或基于 fetch 的 SSE 解析器消费 JSON 事件，禁止直接调用 provider SDK。
8. 编写端到端测试：在浏览器侧抓包验证响应中不存在 `apiKey`、绝对路径、`write` 工具名或 `internal` 前缀字段。
9. 建立静态扫描规则：禁止 `apps/web` 出现 `@earendil-works/pi-coding-agent` 导入，禁止服务端代码中出现 `process.env.OPENAI_API_KEY` 之外的字符串拼接泄露。
10. 在 CI 中运行 `pnpm typecheck`、`pnpm test` 与 `git diff --check`，确保 DTO、中间件与前端导入约束持续生效。

## TypeScript 边界示例

```ts
// apps/api/src/session/createSession.ts
import { createAgentSession, DefaultResourceLoader } from 'packages/pi-agent';
import { SessionManager } from 'packages/pi-agent';

export async function createBrowserSession(cwd: string, identity: string) {
  const loader = new DefaultResourceLoader({ cwd }); // 输入：服务端受控 cwd
  const tools = buildReadOnlyTools(loader);          // 处理：只注册 read/search_knowledge
  const runtime = await createModelRuntime({ apiKey: process.env.MODEL_API_KEY });
  const session = createAgentSession({ runtime, tools });
  const handle = SessionManager.inMemory().register(session, { identity, ttlSeconds: 300 });
  return { sessionId: handle.id };                  // 输出：浏览器只获得会话句柄
}
```

输入是 HTTP 请求中的 `identity` 与项目配置；处理在 API 进程内完成，provider key 与文件路径都不离开服务端；输出只有 `sessionId`，浏览器通过 SSE 接收经过 `EventNormalizer` 过滤的事件。

## 性能、质量和可观测性指标

1. **敏感字段泄露检测**：在测试与 staging 环境中对 SSE 响应做正则与结构扫描，目标为每 10 万次事件零命中。
2. **会话句柄 TTL 合规率**：监控 `connectionToken` 与 `sessionId` 的 TTL 配置覆盖率，应达 100%。
3. **工具注册表大小**：运行时注册的写入能力工具数量必须恒为 0，可通过 `/health` 端点暴露给监控。
4. **事件过滤延迟**：`EventNormalizer` 处理一条事件的 P99 延迟应小于 1 毫秒，避免成为流式瓶颈。
5. **未授权能力调用拦截率**：对尝试调用非白名单工具的请求，返回 403 并记录，目标 100% 拦截。
6. **路径泄露日志审计**：每月抽查错误日志，确保不包含绝对路径，目标零例外。

## 失败模式、诊断证据与恢复动作

1. **密钥出现在浏览器内存**：诊断证据是前端 bundle 或网络抓包包含 `apiKey` 字段。恢复动作是立即轮换密钥，启用 `apps/web` 导入 SDK 的 lint 禁令，并审查 `packages/contracts` DTO。
2. **绝对路径随错误回传**：诊断证据是 SSE 错误负载包含 `/Users/.../.pi/...`。恢复动作是重写错误序列化器，使用相对标识或错误码；清理 CDN 缓存。
3. **会话句柄未过期导致重放**：诊断证据是同一 `connectionToken` 在 TTL 后仍能建立 SSE。恢复动作是检查 `SessionManager.inMemory()` 的清理定时器，并增加服务端主动失效接口。
4. **写入工具被错误注入**：诊断证据是工具注册表中出现 `write` 或 `shell` 等名称。恢复动作是回滚能力注入中间件变更，并在启动时断言白名单。
5. **浏览器直接实例化 AgentSession**：诊断证据是 `apps/web` 出现 `createAgentSession` 调用。恢复动作是删除该导入，并在 CI 中增加静态检查。
6. **模型输出泄露内部路径**：诊断证据是文本增量中出现 `.pi/` 或 `node_modules/`。恢复动作是在 `search_knowledge` 返回阶段对来源引用做脱敏，必要时对模型输出增加后处理过滤。

## 问答测试样例

1. **正向**：浏览器 SSE 流中能否包含 `apiKey`？**答案**：不能；只有服务端进程与环境变量可见。
2. **正向**：当工具返回知识来源时，浏览器应看到什么？**答案**：人工可读片段标识或摘要，而非磁盘路径。
3. **边界**：如果模型输出意外包含绝对路径，系统应如何处理？**答案**：通过输出后处理过滤，并记录审计日志，而不是直接转发。
4. **边界**：`SessionManager.inMemory()` 是否安全依赖？**答案**：不是安全边界；它只是一个可替换实现，访问控制不依赖它。
5. **无证据拒答**：本项目是否禁止所有 Pi 官方工具？**答案**：无法确认；已知只暴露 `read` 与 `search_knowledge`，具体内置工具列表需查阅已安装 SDK 版本。
6. **无证据拒答**：浏览器是否一定无法通过 XSS 获取 provider key？**答案**：不能绝对断言；本文只保证 key 不进入浏览器运行上下文，XSS 还需依赖 CSP、输入消毒等相邻机制。

## 维护、版本、来源与相邻主题的关系

- **版本锁定**：`@earendil-works/pi-coding-agent` 的版本、环境变量 schema 与 DTO 版本应在 `package.json` 与 `packages/contracts` 中同步更新，升级后重跑敏感字段泄露扫描。
- **来源**：安全边界主要来源于项目 `AGENTS.md` 的 Pi Integration Contract 与官方 security 文档；代码示例以当前 monorepo 结构为参照。
- **相邻主题**：与 TLS/身份认证正交——本文假设传输层已加密；与浏览器 CSP/XSS 相邻——不重叠但需共同部署；与模型输出安全相邻——模型可能生成危险指令，需宿主边界拦截；与审计日志相邻——所有能力调用与过滤事件应记录。
- **维护节奏**：每次新增工具或事件类型时，必须更新 `EventNormalizer` 白名单与 DTO，补充端到端抓包测试，并在 PR 描述中声明对能力面的影响。

## 结论

**事实**：provider key、文件系统内部路径与写入/执行/扩展加载等宿主能力只应存在于服务端；浏览器消费的 SSE 事件必须经由 `packages/contracts` DTO 与 `EventNormalizer` 过滤；`apps/web` 不导入 Pi SDK。

**推论**：如果严格实施能力注入点与 DTO 过滤层，则即使浏览器端发生脚本注入或网络抓包，攻击者也难以获得密钥或内部实现细节；可替换接口设计让安全策略不依赖当前内存会话实现。

**未知**：具体 SDK 版本未来可能新增的事件字段与工具类型需要逐版本审计；浏览器扩展、操作系统剪贴板、屏幕录制等带外泄露渠道不在本文架构边界内；模型输出中主动构造的社会工程学载荷对终端用户的影响需额外研究。
