# Pi Coding Agent 官方 SDK、AGENTS.md 与 Web 集成边界

> 调研快照：2026-08-01（Asia/Shanghai）。本文只把 `pi.dev` 与官方仓库 `earendil-works/pi` 的文档/README 当作 Pi 事实来源；“本项目推论”单独标出。所有列出的官方 URL 均在调研时以 HTTP 200 验证。

## 一句话结论

`@earendil-works/pi-coding-agent` 是可嵌入 Node.js/TypeScript 应用的 SDK：用 `createAgentSession()` 创建 `AgentSession`，用 `session.prompt()` 发起一轮，用 `session.subscribe()` 观察 `AgentSessionEvent`，并在 `dispose()` 时清理。`DefaultResourceLoader` 负责 Pi 文档明确列出的 extensions、skills、prompt templates、themes 和 `AGENTS.md` context files；官方资源列表没有把任意 `.pi/knowledge` 目录列为内建资源，因此本项目的 `.pi/knowledge` 应继续由应用自己的只读工具读取，而不能声称会被 Pi 自动加载。

Pi 的事件模型适合由后端转换为 Web 流，但官方定义的是进程内回调、CLI JSONL 或 RPC stdin/stdout JSONL，不是 HTTP/SSE 合同。当前项目的 Fastify SSE 事件名、DTO 和断开/重连语义均属于项目层适配。只读工具 allowlist 是能力配置，不是安全沙箱；Pi 官方明确说明默认使用启动用户权限、没有内建 sandbox，真正隔离需要容器、VM、micro-VM 或其他 OS/虚拟化边界。

## 1. 官方来源与验证记录

| 官方文档标题 | 用途 | 直接 URL |
| --- | --- | --- |
| SDK · Documentation · Pi | `createAgentSession`、`AgentSession`、`DefaultResourceLoader`、工具 allowlist、事件流、SDK/RPC 选择 | <https://pi.dev/docs/latest/sdk> · <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md> |
| RPC Mode · Documentation · Pi | headless JSONL stdin/stdout 协议、事件和跨进程集成 | <https://pi.dev/docs/latest/rpc> · <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md> |
| JSON Event Stream Mode · Documentation · Pi | `pi --mode json` 的 JSONL 事件流 | <https://pi.dev/docs/latest/json> · <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md> |
| Session File Format · Documentation · Pi | JSONL session、消息内容、树结构、`SessionManager` | <https://pi.dev/docs/latest/session-format> · <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md> |
| Skills · Documentation · Pi | `.pi/skills`、`.agents/skills`、渐进式加载、技能风险 | <https://pi.dev/docs/latest/skills> · <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md> |
| Security · Documentation · Pi | project trust、权限、无内建 sandbox | <https://pi.dev/docs/latest/security> · <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md> |
| Containerization · Documentation · Pi | 容器、Gondolin micro-VM、OpenShell 等隔离模式 | <https://pi.dev/docs/latest/containerization> |
| `@earendil-works/pi-agent-core` README | Agent loop、thinking/tool 事件、工具 hooks、浏览器后端 proxy、低层 API | <https://github.com/earendil-works/pi/blob/main/packages/agent/README.md> |

## 2. TypeScript SDK 创建 session 的官方事实

### 官方明示

1. SDK 包含在 `@earendil-works/pi-coding-agent` 主包中；官方 quick start 用 `ModelRuntime.create()`、`SessionManager.inMemory()` 和 `createAgentSession()` 创建 `{ session }`。
2. `createAgentSession()` 是创建单个 `AgentSession` 的主工厂。它使用 `ResourceLoader` 提供 extensions、skills、prompt templates、themes 和 context files；未传入 loader 时使用带标准发现规则的 `DefaultResourceLoader`。
3. `AgentSession` 管理 agent lifecycle、message history、model state、compaction 与 event streaming。接口包含：
   - `prompt(text, options?) : Promise<void>`；
   - `subscribe(listener) : () => void`（返回取消订阅函数）；
   - `sessionId`、`sessionFile`、`messages`、`isStreaming`；
   - `abort()`、`dispose()`、`compact()` 等生命周期控制。
4. `prompt()` 在接受的运行（包含重试）完成后才 resolve；如果在 streaming 中再次 prompt，必须指定 `streamingBehavior`，或使用 `steer()` / `followUp()`。这是 SDK 的调用语义，不等同于 RPC 的“接受即 response”。

来源：

- [SDK · Documentation · Pi](https://pi.dev/docs/latest/sdk)（“Quick Start”“createAgentSession”“AgentSession”“Prompting and Message Queueing”）
- [官方 `packages/coding-agent/docs/sdk.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#core-concepts)

### 本项目对应关系（推论）

`packages/pi-agent/src/index.ts` 当前的 `createPiAgentSession()` 对官方 API 的组合方式是合理的：设置 `cwd`、构造 `DefaultResourceLoader`、`await resourceLoader.reload()`，然后把项目 `.pi/sessions/` 下的 `SessionManager.create/open()`、`tools`、`customTools` 和 `thinkingLevel` 传给 `createAgentSession()`。测试场景才使用 `SessionManager.inMemory(cwd)`。这段目录选择是本项目实现；JSONL、树结构和 `SessionManager` API 是 Pi 官方能力，不是 Pi 官方要求所有 Web 应用都使用项目目录。

项目代码中 `session.prompt()` 与 `session.subscribe()` 的用法遵循官方接口，但 API 层如何复用 session、串行化 sessionId、清理订阅和处理异常，仍需由项目自己保证。

## 3. `DefaultResourceLoader`、`.pi` 资源与 `AGENTS.md`

### 官方明示的发现范围

SDK 文档把 `cwd` 作为 `DefaultResourceLoader` 的项目发现根：

- project extensions：`.pi/extensions/`；
- project skills：`.pi/skills/`，以及当前 `cwd` 和祖先目录（到 Git 根或文件系统根）的 `.agents/skills/`；
- project prompts：`.pi/prompts/`；
- context files：从 `cwd` 向上查找的 `AGENTS.md`；
- session directory naming。

`agentDir` 对应全局 extensions、skills、prompts、`AGENTS.md`、settings、models、credentials 和 sessions。传入自定义 `ResourceLoader` 后，`cwd`/`agentDir` 不再控制资源发现，但仍影响 session 命名和工具路径解析。

来源：

- [SDK · Documentation · Pi](https://pi.dev/docs/latest/sdk#options-reference)（“Directories”）
- [官方 `packages/coding-agent/docs/sdk.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#directories)

### `.pi/knowledge` 的边界

官方 SDK 的资源类型和目录清单没有列出 `.pi/knowledge`，也没有把任意项目 Markdown 目录描述为自动注入 context 的机制。因而可以确认：**官方文档没有给出 `.pi/knowledge` 自动加载保证**。将 `.pi/knowledge` 作为本项目自有知识 bundle，由 `search_knowledge` 等 custom tool 按需读取，是基于官方清单的保守推论；它不是 `DefaultResourceLoader` 的已记录能力。

这一区分很重要：

- `.pi/skills`、`.pi/prompts`、extensions 和 `AGENTS.md` 可按官方发现规则进入 Pi 资源；
- `.pi/knowledge/*.md` 需要项目代码显式读取、索引或注册成工具；文件存在本身不等于已经进了模型 context；
- 因此项目 `.pi/knowledge` 文档里“`DefaultResourceLoader` 加载 knowledge”的说法应理解为项目期望/封装，而不是 Pi 官方事实。

### `AGENTS.md` 与 trust

官方 security 文档明确：`AGENTS.md` 和 `CLAUDE.md` context files 在 project trust 解决前也会加载（除非关闭 context loading）；project-local `.pi` 资源、packages、extensions 和 `.agents/skills` 则受 project trust 控制。一个裸 `.pi` 目录本身不触发需要 trust 的资源判定；`.pi/settings.json`、`.pi/extensions`、`.pi/skills`、`.pi/prompts`、`.pi/themes`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md` 以及 project `.agents/skills` 会触发该判定。

非交互 `-p`、`--mode json`、`--mode rpc` 不弹 trust prompt；没有已保存决策时，`defaultProjectTrust` 为 `ask` 或 `never` 会忽略受保护资源，`always` 才信任；也可用 `--approve` / `--no-approve` 覆盖单次运行。

来源：[Security · Documentation · Pi](https://pi.dev/docs/latest/security#project-trust) · [官方 `packages/coding-agent/docs/security.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md#project-trust)

## 4. Skills 与 `.agents/skills` 的官方事实

Pi 实现 Agent Skills standard，但对大多数违规只警告并继续加载。官方发现位置包括全局 `~/.pi/agent/skills/`、`~/.agents/skills/`，受信任项目的 `.pi/skills/` 和 `cwd`/祖先目录中的 `.agents/skills/`，package 的 `skills/` 或 `pi.skills`，settings 的 `skills`，以及显式 `--skill <path>`。

发现规则和执行边界：

- `.pi/skills` 与 `~/.pi/agent/skills` 下的根 `.md` 可作为单个 skill；所有技能位置中带 `SKILL.md` 的目录会递归发现；根 `.md` 在 `.agents/skills` 中会被忽略；
- 启动时先收集名称/描述，把可用 skills 放进 system prompt；匹配后模型用 `read` 读取完整 `SKILL.md`，这是 progressive disclosure；也可用 `/skill:name` 强制加载；
- skill 内容可以指示模型做任意动作，也可能包含模型会执行的代码，官方要求使用前审阅；
- 缺少 `description` 的技能不会加载，名称冲突会告警并保留首先发现的技能。

来源：[Skills · Documentation · Pi](https://pi.dev/docs/latest/skills#locations) · [官方 `packages/coding-agent/docs/skills.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md#how-skills-work)

**本项目推论：**仓库的 `.agents/skills/*/SKILL.md` 目录形状符合官方发现规则，但“已安装技能来源和哈希由 `skills-lock.json` 管理”是本仓库 `AGENTS.md` 的工程约束，不是 Pi SDK 的功能保证。

## 5. `session.prompt()`、`subscribe()` 与 thinking/tool 事件

### SDK/AgentSession 事件

官方 SDK 示例把 `session.subscribe()` 作为流式输出入口：监听 `message_update`，再按 `assistantMessageEvent.type` 处理 `text_delta` 和 `thinking_delta`。完整事件示例还列出：

- assistant message：`text_start` / `text_delta` / `text_end`、`thinking_start` / `thinking_delta` / `thinking_end`、`toolcall_start` / `toolcall_delta` / `toolcall_end`；
- 工具生命周期：`tool_execution_start`、`tool_execution_update`、`tool_execution_end`；
- message/agent/turn 生命周期：`message_start`、`message_end`、`agent_start`、`agent_end`、`turn_start`、`turn_end`；
- session 级 queue、compaction、retry 事件。

`turn_end` 携带 assistant message 和该 turn 的 tool results；`tool_execution_update.partialResult` 是当前累计输出，客户端可以用它替换已有展示，而不必自行拼 delta。

来源：

- [SDK · Documentation · Pi](https://pi.dev/docs/latest/sdk#events)
- [RPC Mode · Documentation · Pi](https://pi.dev/docs/latest/rpc#event-types)（完整事件表与 JSON 示例）
- [JSON Event Stream Mode · Documentation · Pi](https://pi.dev/docs/latest/json#event-types)

### Agent Core 的 loop 与安全钩子

官方 `@earendil-works/pi-agent-core` README 说明它是基于 `@earendil-works/pi-ai` 的 stateful agent，提供 tool execution 和 event streaming。调用 `prompt()` 时，典型顺序是 `agent_start → turn_start → message_start/end → message_update* → message_end → turn_end → agent_end`；有 tool call 时会插入 `tool_execution_start/update/end`、tool result message，并继续下一轮 LLM 调用。

README 还明确：默认 tool execution 是 `parallel`，可改为 `sequential`；`beforeToolCall` 在参数校验后、工具执行前运行并可阻断，`afterToolCall` 在执行后、最终 tool 事件和结果消息前运行。`Agent.subscribe()` listener 按注册顺序等待；`agent_end` 表示不再发出 loop 事件，但 `prompt()`/`waitForIdle()` 会等待已注册的异步 `agent_end` listener。

来源：[官方 `@earendil-works/pi-agent-core` README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#event-flow) · [工具 hooks](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#tools)

### 持久化 session 中的 thinking/tool 数据

官方 Session Format 将 session 存为 JSONL，每行有 `type`；条目用 `id`/`parentId` 形成树。`AssistantMessage.content` 可包含 `ThinkingContent` 和 `ToolCall`，`ToolResultMessage` 保存 `toolCallId`、`toolName`、结果内容和 `isError`。`StopReason` 的 `pending` 只用于流式 partial message，终态持久化 JSONL 不应出现 `pending`。

来源：[Session File Format · Documentation · Pi](https://pi.dev/docs/latest/session-format#message-types) · [官方 `packages/coding-agent/docs/session-format.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md#base-message-types-from-pi-ai)

**本项目推论：**项目把 `thinking_delta`、`text_delta`、`tool_execution_*` 摘要转发给浏览器是合理的观察层设计；不能把这些事件等同于 session JSONL 的最终持久化记录，也不能假设每个 provider 都会产生 thinking 事件（SDK 文档注明 thinking output 取决于是否启用 thinking）。

## 6. 只读工具与安全边界

### 官方工具配置

SDK 文档列出的内建工具是 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`；默认内建集合是 `read`、`bash`、`edit`、`write`。官方示例把 `tools: ["read", "grep", "find", "ls"]` 标为 **Read-only mode**，并支持 `noTools: "all"`、`noTools: "builtin"` 与 `excludeTools`。custom tools 仍可通过 `customTools` 或 extensions 注册，若使用 `tools` allowlist 则要显式列出想启用的 custom/extension tool 名称。

来源：[SDK · Documentation · Pi](https://pi.dev/docs/latest/sdk#tools) · [官方 `packages/coding-agent/docs/sdk.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#tools)

### 官方安全边界

Pi 官方 security 文档的边界非常明确：

- Pi 是本地 coding agent，以启动它的用户账户权限运行；该用户可写的文件都在同一 local trust boundary；
- project trust 只控制是否加载项目本地 settings/resources/packages/extensions，**不是 sandbox**，不会限制模型在工作目录开始后让工具做什么；
- Pi 没有 built-in sandbox；内建工具可读/写/编辑文件并运行 shell，extensions 也以同等进程权限运行；
- 对不可信仓库、无人监控自动化或不想密切审阅的生成代码，应把整个 Pi 放入 container/VM/micro-VM/受策略控制的 sandbox，或把工具执行路由进隔离环境；只读挂载、最小凭据和网络限制由部署方负责。

来源：[Security · Documentation · Pi](https://pi.dev/docs/latest/security#no-built-in-sandbox) · [Containerization · Documentation · Pi](https://pi.dev/docs/latest/containerization#choose-a-pattern)

**本项目约束推论：**`packages/pi-agent` 只允许 `read` 与项目自定义的只读 `search_knowledge`，能减少 Pi loop 的可用能力，但它不是 OS 级安全边界。要保证“不能写文件、不能 shell、不能改数据库”，除了 tool allowlist，还需要确保没有可写/执行的额外 extension/custom tool，并在 API 鉴权、进程权限、容器/VM 与凭据策略层重复校验。

## 7. Web、后端 proxy、JSONL 与 SSE 的集成边界

### 官方提供的集成面

1. SDK 的用例明确包含 custom UI（web、desktop、mobile），同一 Node.js 进程内可直接持有 `AgentSession`，读取 agent state、注册 custom tools/extensions，并从 `session.subscribe()` 获取事件。
2. 官方 Agent Core README 为 browser app 提供 `streamProxy` 示例：浏览器侧通过后端传递 `proxyUrl`/`authToken`，后端负责模型流代理。该示例是模型流 proxy，不是 Pi 官方 HTTP/SSE endpoint 规范。
3. 需要跨语言或进程隔离时，RPC 通过 stdin/stdout 传 JSON 命令、JSON response 和 JSON event lines；官方特别建议 Node.js/TypeScript 应用优先直接使用 `AgentSession`，而不是不必要地 spawn subprocess。
4. `pi --mode json` 把 session events 逐行写到 stdout；这是 JSONL，不是 `text/event-stream`。

来源：

- [SDK · Documentation · Pi](https://pi.dev/docs/latest/sdk#run-modes)（SDK/RPC 选择）
- [RPC Mode · Documentation · Pi](https://pi.dev/docs/latest/rpc#protocol-overview)（stdin/stdout JSONL）
- [JSON Event Stream Mode · Documentation · Pi](https://pi.dev/docs/latest/json#output-format)（stdout JSONL）
- [官方 `@earendil-works/pi-agent-core` README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#proxy-usage)

### 本项目的 SSE 结论（明确是推论）

官方文档没有定义 Fastify route、HTTP method、`Content-Type: text/event-stream`、SSE `event:` 名称、心跳、断线重连、sessionId 并发锁或浏览器 DTO。因而本项目可以把 Pi 事件映射成自己的 SSE（例如 `text_delta`、`thinking_delta`、`event`、`done`），但必须把这些视为应用层合同：

```text
AgentSession.subscribe(AgentSessionEvent)
        -> API 将事件归一化/鉴权/加上 session 元数据
        -> HTTP SSE（项目自定义 event/data framing）
        -> Browser
```

不要把项目 SSE 名称写成“Pi 官方事件协议”，也不要让浏览器直接持有 provider key 或把 RPC stdin/stdout 暴露为公网 HTTP。若要使用官方跨进程协议，应由受控后端进程管理 `pi --mode rpc`，而不是让浏览器直接连接本机 stdin/stdout。

项目实现参照：[packages/pi-agent/src/index.ts](../../packages/pi-agent/src/index.ts) · [apps/api/src/app.ts](../../apps/api/src/app.ts)。这些本地文件只证明本项目当前适配方式，不是官方来源。

## 8. 对当前仓库 `AGENTS.md` 与实现的可执行核对

| 事项 | 官方事实 | 当前项目应保持的表述 |
| --- | --- | --- |
| SDK 创建 | `createAgentSession` + `AgentSession` | 可说“项目使用官方 Pi SDK 创建 session” |
| 资源加载 | `DefaultResourceLoader` 发现 `.pi/extensions`、`.pi/skills`、`.pi/prompts`、`AGENTS.md` 等 | 不要说它自动加载 `.pi/knowledge`；知识由 custom tool/应用读取 |
| `.agents/skills` | 受信任项目可从 cwd/祖先目录发现包含 `SKILL.md` 的目录 | 仓库 `.agents/skills/*/SKILL.md` 符合；根 `.md` 不会按该规则加载 |
| prompt/events | `prompt()` 等待接受的完整运行；`subscribe()` 返回取消订阅 | API 转发事件是观察层，仍需处理 unsubscribe/dispose/并发 |
| thinking/tool | `message_update` 可带 text/thinking/toolcall delta；另有 tool execution 生命周期 | thinking 可能为空；不能以单一事件替代最终 answer 或持久化记录 |
| 只读 | SDK 有 read-only tools allowlist 示例 | allowlist 是能力缩减，不是 sandbox；保留 API/进程/容器安全边界 |
| Web/SSE | 官方给 SDK、JSONL、RPC、backend proxy 示例，没有 SSE 合同 | SSE event names/DTO/reconnect 属于本项目 API 约束 |

## 9. 最小证据清单

- 若要证明 session 正常创建：记录 `createAgentSession()` 返回的 `session`，订阅一次后调用 `await session.prompt()`，最终调用 `session.dispose()`。
- 若要证明只读配置：检查实际 session 的 active tool names，不只检查 system prompt；确认没有默认 `bash`/`edit`/`write`，并审阅 custom tools/extensions。
- 若要证明资源加载：使用 loader 的 `getSkills()`、`getPrompts()`、`getAgentsFiles()` 等官方 API；不要把 `.pi/knowledge` 文件存在误当成已进入 context。
- 若要证明 Web 流：分别记录原始 Pi `AgentSessionEvent` 与 API SSE frame，明确它们是“官方事件”与“项目映射”的两层。
- 若要证明安全：在实际部署权限下验证进程用户、可写路径、扩展来源、provider credentials、网络出口和容器/VM 边界；trust prompt 或 read-only allowlist 不能替代这些验证。
