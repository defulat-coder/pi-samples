# 从 Claude Code 视角理解 Pi、Pi Agent Core 与 Pi Coding Agent

> 调研快照：2026-08-01（Asia/Shanghai）。Claude Code 侧仅使用 `code.claude.com/docs` 官方文档；Pi 侧仅使用 `pi.dev` 与 `earendil-works/pi` 官方仓库/文档。

## 一句话结论

如果用你熟悉的 Claude Code 建立心智模型：

- **Pi** 是开源项目/产品家族的总称；日常说“运行 Pi”时，通常又特指它的 `pi` 编码智能体 CLI。
- **`@earendil-works/pi-coding-agent` 最接近“Claude Code CLI + Claude Agent SDK”这一整层**：它既提供可直接使用的编码智能体，也提供 `createAgentSession()` 供 TypeScript 应用嵌入。
- **`@earendil-works/pi-agent-core` 不是 Claude Agent SDK 的准确对应物**。它更低一层，是公开、可替换模型与工具的 agent loop/runtime。Claude Code 官方没有发布一个同层级、可独立安装的“Claude Agent Core”包。

最重要的映射是：

| Claude 世界 | Pi 世界 | 映射性质 |
| --- | --- | --- |
| Claude Code CLI/产品 | `pi` CLI（来自 `pi-coding-agent`） | **产品定位上的近似对应** |
| Claude Agent SDK | `@earendil-works/pi-coding-agent` 的 SDK | **最接近的 SDK 对应**，但能力与安全默认值不同 |
| Claude Code 概念上的 agentic loop | `@earendil-works/pi-agent-core` | **架构类比，不是 API 对应** |
| `claude -p` | `pi -p` | **用途上的直接对应** |
| Claude SDK 的 `query()` / `ClaudeSDKClient` | Pi 的 `createAgentSession()` / `AgentSession` | **调用入口类比** |
| Claude Code hooks | Pi coding-agent extensions；低层的 `beforeToolCall` / `afterToolCall` | **功能类比，不是同一扩展协议** |
| Claude Code Skills | Pi Skills | **格式和用途高度接近**，但发现路径、命令名和运行语义有差别 |
| Claude Code MCP | Pi extension/第三方 package 中自行接 MCP | **没有内建一一对应** |
| Claude Code subagents | Pi extension、外部编排或多个 Pi 实例 | **没有内建一一对应** |
| Claude Code permissions + Bash sandbox | Pi extension 策略 + 外部 sandbox/container | **目标相同，实现与默认安全边界不同** |
| `@anthropic-ai/sdk`（直接模型 API client） | `@earendil-works/pi-ai` | **仅粗略类比**：都在 agent loop 之下，但 `pi-ai` 是多 provider 统一层，API 与职责范围并不相同 |

## 先把两边的层次摆正

### Claude Code 一侧

Claude Code 官方把产品描述为 agentic coding tool：可以读取代码库、编辑文件、运行命令，并运行在 terminal、IDE、desktop 和 web 等界面。[Claude Code overview](https://code.claude.com/docs/en/overview)

官方文档对它的概念模型是“收集上下文 → 采取行动 → 验证结果”的循环，模型负责推理，工具负责行动，Claude Code 是模型外面的 agentic harness，提供工具、上下文管理与执行环境。[How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)

Claude Agent SDK 则把这套 Claude Code 能力作为 Python/TypeScript 库开放。官方明确说 SDK 提供驱动 Claude Code 的相同工具、agent loop 和上下文管理；公开入口主要是 `query()` / `ClaudeSDKClient`，SDK 包内捆绑对应平台的原生 Claude Code binary。[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

这里需要严格区分“官方承诺复用相同 loop”与“内部实现公开”：

- 官方文档公开了 loop 的概念阶段和 SDK 行为契约。
- 官方并没有发布一个类似 Pi `agentLoop()` 或 `Agent` 类的、可独立替换模型流函数和消息转换层的低级开源包。
- 因而本文不会声称能访问、检查或复刻 Claude Code 未公开的内部 agent loop 实现；只比较官方公开的产品行为与 API。

### Pi 一侧

Pi 是一个开源 monorepo，官方仓库把主要层次拆为：

```text
Pi 项目 / 产品家族
├── @earendil-works/pi-coding-agent  编码智能体 CLI + 可嵌入 SDK
│   └── @earendil-works/pi-agent-core  有状态 agent runtime / tool loop
│       └── @earendil-works/pi-ai      多 provider LLM 接口
└── @earendil-works/pi-tui             终端 UI 库
```

这不是推测：官方仓库将 `pi-coding-agent` 定义为 interactive coding agent CLI，将 `pi-agent-core` 定义为带 tool calling 和状态管理的 agent runtime，将 `pi-ai` 定义为多 provider LLM API。[Pi 官方仓库](https://github.com/earendil-works/pi#all-packages)

## 1. Pi 对 Claude Code：产品层的比较

把 `pi` 当成你打开终端直接使用的产品时，它最接近 Claude Code CLI。

两者都提供：

- 交互式编码对话；
- 读取、搜索、编辑文件和运行 shell；
- 项目级指令文件；
- session 延续；
- Skills 和自定义工具；
- 非交互/脚本化调用。

Pi 内建工具是 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`，支持 `AGENTS.md`，也兼容加载 `CLAUDE.md`；session 会自动保存并支持树状分支与 compaction。[Pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#context-files) · [CLI reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#cli-reference)

但 Pi 不是“开源版 Claude Code 的逐项复刻”。最明显的产品哲学差异是：

| 能力 | Claude Code | 官方 Pi 默认产品 |
| --- | --- | --- |
| 外部工具协议 | MCP 是一等能力，支持 remote HTTP、stdio 等连接方式和 local/project/user scope。[MCP](https://code.claude.com/docs/en/mcp) | 官方明确写着 **No MCP**；可以写 extension 接入或安装第三方 package。[Pi philosophy](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy) |
| 子智能体 | 内建 custom subagents；子智能体通常有独立 context，完成后向主智能体返回结果。[Subagents](https://code.claude.com/docs/en/sub-agents) | 官方明确写着 **No sub-agents**；可用 extension、tmux/多进程或第三方 package 自行选择实现。[Pi philosophy](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy) |
| 权限交互 | 内建 allow/ask/deny 规则、permission modes 和 managed policy；规则由 Claude Code 而不是模型执行。[Permissions](https://code.claude.com/docs/en/permissions) | 默认没有 permission popup/system；可用 `tool_call` extension 做确认/阻断，但这属于自建策略。[Extensions](https://pi.dev/docs/latest/extensions) |
| OS 隔离 | Bash sandbox 对 Bash 及其子进程提供 OS 级文件系统和网络限制；它与工具权限规则是两层机制。[Sandboxing](https://code.claude.com/docs/en/sandboxing) | Pi 默认继承启动用户/进程权限；官方建议把整个进程放入隔离环境，或把工具执行路由到隔离环境。[Containerization](https://pi.dev/docs/latest/containerization) |
| 扩展方式 | CLAUDE.md、Skills、hooks、MCP、subagents、plugins 各有独立的一等协议。[Extend Claude Code](https://code.claude.com/docs/en/features-overview) | 倾向用通用 TypeScript extension + Skills + packages 组合出能力；extension 还能改 TUI、命令和模型 provider。[Extensions](https://pi.dev/docs/latest/extensions) |
| 模型层 | Claude Agent SDK 围绕 Claude Code/Claude；官方文档所示认证是 Anthropic API 或列出的云平台路径。[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | `pi-ai` 是多 provider 层，官方列出 Anthropic、OpenAI、Google 等 provider。[Pi repository](https://github.com/earendil-works/pi#all-packages) |

因此，Claude Code 更像“能力和治理都已经装配好的产品”；Pi 更像“保留好用默认值，但鼓励你替换工作流的开源 harness”。

## 2. `pi-agent-core` 对 Claude Agent SDK：为什么不是一一对应

`@earendil-works/pi-agent-core` 的公开定位是“stateful agent with tool execution and event streaming”。它暴露：

- `Agent` 状态：system prompt、model、tools、messages；
- `prompt()`、`continue()`、`abort()`、steering 和 follow-up queue；
- `agent_start`、`turn_start`、`message_update`、`tool_execution_*` 等事件；
- `beforeToolCall` / `afterToolCall`；
- 自定义 `AgentMessage`、`transformContext`、`convertToLlm`；
- 更低层的 `agentLoop()` / `agentLoopContinue()`；
- 可注入的 `streamFn`，通常由 `pi-ai` 提供。[Pi Agent Core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)

这比 Claude Agent SDK 的公共抽象更低。Claude Agent SDK 的入门代码直接通过 `query()` 获得带 Read/Edit/Bash 等内建工具的完整 agent；官方还列出 hooks、subagents、MCP、permissions 和 sessions 等能力。[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

所以更准确的说法是：

> `pi-agent-core` 类比 Claude Code harness 内部“负责模型—工具—结果继续循环”的那一层职责，但 Claude 官方没有把该层作为同形态的独立低级 SDK 发布。

这会带来非常实际的选择差异：

- 使用 Claude Agent SDK 时，你从“已经是 Claude Code 的 agent”开始，再限制工具或扩展能力。
- 使用 `pi-agent-core` 时，你从“有 loop、有状态、有事件，但没有现成 coding harness”开始；工具、持久化、资源发现、compaction 策略和安全边界都可以由平台决定。

如果你熟悉 Claude Agent SDK，容易犯的错误是看到 `Agent` 类就认为 `pi-agent-core` 是替代品。实际迁移到它，相当于从 Claude Code 的产品级 SDK 下沉一层并接管更多基础设施。

## 3. `pi-coding-agent` 对 Claude Code/Agent SDK：最接近的对应层

`@earendil-works/pi-coding-agent` 同时扮演两个角色：

1. 安装后提供 `pi` CLI，是面向人的完整编码智能体；
2. 包内直接提供 SDK，通过 `createAgentSession()` 嵌入 Web、Desktop、Mobile、自定义 UI 或自动化流程，不需要另装一个 SDK 包。[Pi SDK](https://pi.dev/docs/latest/sdk)

这与 Claude 的“两种入口”最相似：

```text
Claude Code CLI                 Pi CLI
claude                          pi
claude -p                       pi -p
--output-format stream-json     --mode json

Claude Agent SDK                Pi Coding Agent SDK
query(...)                      createAgentSession(...)
ClaudeSDKClient                 AgentSession
```

注意最后两行是“职责上的类比”，不是类型或协议兼容。

Pi 的 `AgentSession` 管理 agent lifecycle、消息历史、模型状态、compaction 和事件流；`ResourceLoader` 负责 extensions、skills、prompt templates、themes 与 context files。[Pi SDK](https://pi.dev/docs/latest/sdk) 这与 Claude Agent SDK 从完整 harness 起步的开发体验，比 `pi-agent-core` 更接近。

### 非交互与进程集成

Claude Code 的 `claude -p` 支持文本、JSON、newline-delimited `stream-json`，也支持 JSON Schema 结构化输出。[Headless mode](https://code.claude.com/docs/en/headless)

Pi 的对应表面有三种：

- `pi -p`：打印结果后退出；
- `pi --mode json`：把 agent 事件输出为 JSONL；
- `pi --mode rpc`：通过 stdin/stdout 的严格 JSONL 协议接收命令并流式返回 response/event，适合非 Node 宿主、IDE 或自定义 UI。[Pi CLI reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#cli-reference) · [RPC mode](https://pi.dev/docs/latest/rpc)

`pi --mode rpc` 没有 Claude CLI 的严格一一对应物。它更像 Pi 专门提供的长驻双向子进程控制协议；而 Claude 官方对其他语言的公开建议是程序化运行 CLI 的 `-p` 加 JSON 输出，TypeScript/Python 则用 Agent SDK。[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

## 4. 用 Claude Code 功能逐项翻译 Pi

### CLAUDE.md / AGENTS.md

- Claude Code：`CLAUDE.md` 是项目指令与上下文入口。[Overview](https://code.claude.com/docs/en/overview)
- Pi：优先使用 `AGENTS.md`，同时也会加载 `CLAUDE.md`；它会从 cwd 向父目录发现并拼接匹配文件。[Pi context files](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#context-files)

这是高相似度映射，但目录发现和优先级规则不能假定完全相同。

### Skills

两者都采用目录中的 `SKILL.md`，用 frontmatter 描述能力，用 Markdown 写工作流，并可带 scripts、references、assets。Claude Code 可由用户显式调用，也可自动加载匹配技能；Pi 启动时收集名称与描述，模型匹配时再读取完整 `SKILL.md`，也可用 `/skill:name` 强制调用。[Claude Skills](https://code.claude.com/docs/en/skills) · [Pi Skills](https://pi.dev/docs/latest/skills)

这属于格式与意图上的高度兼容，但不是运行时完全兼容：

- Claude 项目路径主要是 `.claude/skills/`；
- Pi 支持 `.pi/skills/`、`.agents/skills/` 等位置；
- Claude 的 skill 可以配置在 isolated subagent context 运行，Pi 本身没有内建 subagent 语义；
- skill 内如果依赖特定 host 工具名、hook、环境变量或 UI 指令，仍需改写。

### Hooks 与 Extensions

Claude Code hooks 是明确的生命周期回调系统。`PreToolUse` 可以 allow/deny/ask 或修改输入，此外还有 session、prompt、stop、subagent 等事件；Agent SDK 也提供 callback hooks。[Hooks](https://code.claude.com/docs/en/hooks) · [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)

Pi 没有同名 hook 配置协议。最接近的是：

- `pi-agent-core` 的 `beforeToolCall` / `afterToolCall`；
- `pi-coding-agent` extension 的 `pi.on("tool_call")` 和 `pi.on("tool_result")`；前者可以修改输入或阻断，后者可以修改结果；
- extension 还能注册工具、命令、快捷键、flags 和 TUI 组件，范围比 Claude hooks 更宽。[Pi Agent Core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md) · [Pi Extensions](https://pi.dev/docs/latest/extensions)

所以“把 Claude hook 搬到 Pi”通常是一次 TypeScript extension 重写，而不是复制配置文件。还要注意 Pi extension 以启动用户的完整系统权限执行任意代码。[Pi Extensions security](https://pi.dev/docs/latest/extensions#extension-locations)

### MCP

Claude Code 对 MCP 有完整的一等支持，包括服务器安装、传输、作用域、OAuth、tool search、permissions 和 plugin 打包。[Claude MCP](https://code.claude.com/docs/en/mcp)

官方 Pi 核心故意不内建 MCP。它允许 extension 注册工具，因此可以安装或开发 MCP adapter，但此时连接生命周期、认证、工具发现、schema 转换、策略和故障处理属于该 adapter/平台，而不是 Pi 核心的保证。[Pi philosophy](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy)

因此，不能把“Pi extension 能做 MCP”写成“Pi 原生 MCP 与 Claude Code 等价”。

### Subagents

Claude Code custom subagent 是产品级概念：通常从独立 context 启动，可配置 prompt、tools、skills、MCP、hooks、permission mode、background 和 worktree isolation 等。[Claude subagents](https://code.claude.com/docs/en/sub-agents)

Pi SDK 文档允许你创建“会 spawn sub-agents 的自定义工具”，但官方 coding-agent 默认明确没有 subagents。[Pi SDK](https://pi.dev/docs/latest/sdk) · [Pi philosophy](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy)

所以在 Pi 平台里，你需要自己决定：

- 子 agent 是同进程 `AgentSession`，还是独立 Pi RPC worker；
- 是否共享消息、文件系统、凭据和预算；
- 如何聚合事件和结果；
- 如何隔离工作区与取消任务。

这不是缺少一个开关，而是你接管了编排语义。

### Permissions 与 Sandbox

Claude Code 的公开安全模型至少分两层：

1. permission rules/modes 决定工具调用是 allow、ask 还是 deny，并由 host 执行；
2. Bash sandbox 对 Bash 及其子进程施加 OS 级文件系统和网络边界。[Permissions](https://code.claude.com/docs/en/permissions) · [Sandboxing](https://code.claude.com/docs/en/sandboxing)

Pi 默认没有同等的内建系统。`beforeToolCall` 或 extension `tool_call` 阻断适合做策略钩子，但不能替代 OS 级隔离；Pi 官方说明默认以启动用户/进程的权限运行，并建议使用容器或把工具路由到隔离环境。[Pi repository security note](https://github.com/earendil-works/pi#permissions--containerization) · [Containerization](https://pi.dev/docs/latest/containerization)

对平台开发而言，这是两边最大的非功能性差异。把 Claude Code permission 配置迁移成 Pi extension 后，仍然需要独立的容器/micro-VM、网络出口策略和凭据代理。

## 5. 站在 Claude Code 用户视角，SDK 应该怎么选

### 想要“Claude Agent SDK 的开源、多模型近似替代”

优先从 **`@earendil-works/pi-coding-agent`** 开始。

原因不是它与 Claude Agent SDK 完全等价，而是它已经提供最相近的产品级起点：built-in coding tools、session、compaction、Skills、extensions、context files 和事件流。你的应用围绕 `createAgentSession()` / `AgentSession` 集成即可。

适合：

- 云端或桌面编码智能体；
- 自定义 Coding Agent UI；
- CI 代码审查/修复 worker；
- 想复用 Pi session 与 compaction 的多模型 agent 产品。

### 想要“自己做智能体平台内核”

选择 **`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`**，前提是你确实希望自己定义：

- 消息与上下文模型；
- 工具注册和执行环境；
- session/任务持久化；
- compaction 和记忆；
- permission/approval；
- sandbox、凭据和网络隔离；
- subagent 调度、预算与观测。

这条路线的价值是控制力，而不是“比 coding-agent 更完整”。它对应的是自己搭 harness，而不是直接拿到 Claude Code 产品能力。

### 平台宿主不是 Node/TypeScript

优先把 `pi-coding-agent` 作为独立 worker，用 `pi --mode rpc` 控制。官方 RPC 已覆盖 prompt、state、model、queue、compaction、session 和事件流；这通常比在其他语言里重写 Pi loop 更稳。[Pi RPC](https://pi.dev/docs/latest/rpc)

## 6. 最终心智模型

如果只记住三句话：

1. **Pi CLI ≈ Claude Code CLI**，但 Pi 默认更小、更开放，也少了 Claude Code 内建的 MCP、subagents、permissions 与 Bash sandbox。
2. **Pi Coding Agent SDK ≈ Claude Agent SDK 的最近邻**，因为两者都是从完整 coding harness 起步；它们不协议兼容，也不具备相同的默认治理能力。
3. **Pi Agent Core ≠ Claude Agent SDK**；它是更低层、真正公开可改的 agent runtime。把它用于平台意味着你主动接管 Claude Agent SDK 已经替你装配的许多部分。

补充一条容易混淆的类比：如果把 Claude 侧的直接模型 API client `@anthropic-ai/sdk` 放进图里，它在层次上比 Claude Agent SDK 更低，因此可以和 `pi-ai` 做粗略比较；但前者面向 Anthropic API，后者统一多个 provider，所以它们不是可替换 SDK，也不是精确对应。

## 官方来源

### Claude Code

- [Claude Code overview](https://code.claude.com/docs/en/overview)
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Extend Claude Code](https://code.claude.com/docs/en/features-overview)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Skills](https://code.claude.com/docs/en/skills)
- [MCP](https://code.claude.com/docs/en/mcp)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Bash sandbox](https://code.claude.com/docs/en/sandboxing)

### Pi

- [Pi official repository](https://github.com/earendil-works/pi)
- [Pi Agent Core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)
- [Pi Coding Agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Pi Coding Agent SDK](https://pi.dev/docs/latest/sdk)
- [Pi RPC mode](https://pi.dev/docs/latest/rpc)
- [Pi Extensions](https://pi.dev/docs/latest/extensions)
- [Pi Skills](https://pi.dev/docs/latest/skills)
- [Pi Containerization](https://pi.dev/docs/latest/containerization)
