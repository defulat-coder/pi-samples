# Pi Rust 版本与智能体平台 SDK 选型

> 调研快照：2026-08-01（Asia/Shanghai）。热度与活跃度是时间敏感数据，本文同时记录观测值和可刷新的一手来源。

## 结论先行

1. 本文的 **Pi** 指 Mario Zechner 发起的 **Pi Agent Harness**。旧地址 `badlogic/pi-mono` 目前由 GitHub 重定向到官方主线 [`earendil-works/pi`](https://github.com/earendil-works/pi)，不是 Raspberry Pi，也不是 npm 上其他同名工具。
2. **官方 Pi 没有官方 Rust 版本或 Rust SDK**。官方主线是 TypeScript monorepo，公开包为 `@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`；独立可执行文件也由 Bun 编译，而不是 Rust。[官方 README](https://github.com/earendil-works/pi#readme) · [语言统计](https://api.github.com/repos/earendil-works/pi/languages)
3. Rust 版本确实存在，但属于**社区从头移植/兼容实现**。当前最受关注的是 [`Dicklesworthstone/pi_agent_rust`](https://github.com/Dicklesworthstone/pi_agent_rust)，不是官方仓库，也不是官方维护的 SDK。
4. 如果“最热门”按 GitHub stars 衡量，顺序非常清楚：**官方 Pi（81,664） > oh-my-pi（20,951） > pi_agent_rust（1,465）**。如果只看 Rust 移植，`pi_agent_rust` 是当前最热门的明确 Pi Rust port。[GitHub Rust 候选检索](https://api.github.com/search/repositories?q=%22Pi%20Agent%22%20language%3ARust%20in%3Aname%2Cdescription%2Creadme&per_page=100)
5. 做通用智能体平台，我的默认推荐是 **`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`**，平台自己负责持久化、队列、权限、沙箱、凭据、租户隔离、审计和调度。只有在要直接复用完整“编码智能体产品”能力时，才上 `@earendil-works/pi-coding-agent`。

## 三条主要路线

| 路线 | 身份与实现 | 2026-08-01 快照 | 最新稳定发布 | 判断 |
| --- | --- | ---: | --- | --- |
| [`earendil-works/pi`](https://github.com/earendil-works/pi) | 官方主线；TypeScript；MIT | 81,664 stars、10,086 forks；当日仍有提交 | [`v0.83.0`](https://github.com/earendil-works/pi/releases/tag/v0.83.0)，2026-07-29 | 生态、文档、兼容性和 SDK 的默认基线 |
| [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) | Pi 的社区 fork；TypeScript/Bun 主体，加 Rust N-API 原生模块；MIT | 20,951 stars、1,993 forks；当日仍有提交 | [`v17.2.2`](https://github.com/can1357/oh-my-pi/releases/tag/v17.2.2)，2026-07-31 | 功能最“满”的开发者产品变体，但不是纯 Rust，也不是官方 Pi |
| [`Dicklesworthstone/pi_agent_rust`](https://github.com/Dicklesworthstone/pi_agent_rust) | 社区从头编写的 Rust port，带 Rust SDK/RPC | 1,465 stars、172 forks；最近推送 2026-07-28 | [`v0.1.23`](https://github.com/Dicklesworthstone/pi_agent_rust/releases/tag/v0.1.23)，2026-07-28 | 最热门 Rust port，但成熟度、兼容性和许可风险都要单独评估 |

以上仓库数据来自 GitHub 官方 API，可实时刷新：[官方 Pi](https://api.github.com/repos/earendil-works/pi) · [oh-my-pi](https://api.github.com/repos/can1357/oh-my-pi) · [pi_agent_rust](https://api.github.com/repos/Dicklesworthstone/pi_agent_rust)。GitHub 的 `pushed_at` 代表仓库最近推送，不等同于稳定版本发布时间。

### 官方 Pi

官方仓库把产品拆成清晰的四层：多模型接口 `pi-ai`、agent loop `pi-agent-core`、完整编码智能体 `pi-coding-agent`、终端 UI `pi-tui`。[包清单](https://github.com/earendil-works/pi#all-packages)

- `pi-ai` 提供统一模型 API、认证解析、token/成本统计、上下文跨模型交接，并只收录支持 tool calling 的模型。[官方文档](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)
- `pi-agent-core` 提供有状态 agent、工具调用循环、事件流、steering/follow-up、并行或串行工具执行、工具调用前后 hook、自定义消息和上下文转换。[官方文档](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)
- `pi-coding-agent` SDK 再向上提供 session、消息历史、compaction、模型状态、extensions、skills、prompt templates 和资源加载，适合嵌入一个完整 Pi 编码智能体。[官方 SDK 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

截至快照，三个 npm 包的 `latest` 都是 `0.83.0`；npm 页面是直接的版本与安装来源：[`pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) · [`pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) · [`pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)。

### oh-my-pi

`oh-my-pi` 的 README 明确写明它是 Pi 的 fork。它的卖点不是“Rust 重写”，而是在 Pi 形态上加入大量开箱即用能力：更多内置工具、LSP/DAP、浏览器、子智能体、记忆、ACP/RPC 等。[项目 README](https://github.com/can1357/oh-my-pi#readme)

它确实包含约 5.5 万行 Rust，但这些 Rust 主要作为 `pi-natives`、shell、AST、workspace isolation 等 N-API 原生模块，宿主与 SDK 仍然是 Node/TypeScript/Bun。README 也把嵌入方式写成 Node SDK `@oh-my-pi/pi-coding-agent`。[Rust 原生层说明](https://github.com/can1357/oh-my-pi#roughly-55000-lines-of-rust-doing-the-work-other-harnesses-shell-out-for) · [SDK 入口](https://github.com/can1357/oh-my-pi#sdk--embed-in-node)

因此它适合“快速做一个能力很强的编码智能体产品”，但作为通用平台内核会带来更大的工具面、更多运行时依赖和更快的 fork API 演化。若选择它，应锁定确切版本并对升级做契约测试，而不要假设它与官方 Pi 永久 API 兼容。

### pi_agent_rust

`pi_agent_rust` 自称获得原作者许可、从头实现的 Rust port，提供单二进制、内置工具、session、RPC 和 Rust SDK；其 SDK 文档明确说它是“功能等价的 Rust companion”，**不是 TypeScript SDK 的 drop-in replacement**。[README](https://github.com/Dicklesworthstone/pi_agent_rust#readme) · [Rust SDK 文档](https://github.com/Dicklesworthstone/pi_agent_rust/blob/main/docs/sdk.md)

需要注意三点：

- 当前版本仍是 `0.1.23`，项目创建于 2026-02，历史和使用规模明显小于官方 Pi。
- SDK 文档的安装示例仍使用本地 path dependency `pi = { path = "." }`；这对可重复的第三方 SDK 消费不如稳定的 registry 包直接。
- 它不是标准 MIT：仓库许可证是 **MIT + OpenAI/Anthropic Rider**，对特定主体及其关联方施加额外限制。任何商业平台采纳前都应先做法律与供应链审查。[许可证原文](https://github.com/Dicklesworthstone/pi_agent_rust/blob/main/LICENSE)

所以：它值得做性能、安全模型和 Rust 原生部署的技术验证，但目前不应仅因“Rust”就替代官方 SDK 成为平台默认内核。

## SDK 选型建议

### 默认推荐：`pi-agent-core` + `pi-ai`

适合：多智能体平台、工作流平台、SaaS agent runtime、需要自己定义领域消息和工具协议的产品。

推荐原因：

- API 层次足够低，可以把 agent loop 当执行引擎，而不必继承完整 coding CLI 的本地文件系统假设。
- `beforeToolCall`/`afterToolCall`、事件流、并行工具、steering/follow-up 适合接平台的策略、审批、观测和实时 UI。
- 自定义 `AgentMessage`、`transformContext`、`convertToLlm` 便于加入平台事件、检索上下文和自有压缩策略。
- `pi-ai` 已解决多模型 provider、认证与流式响应的共性问题，平台无需重复造适配层。

建议依赖：

```bash
npm install @earendil-works/pi-agent-core @earendil-works/pi-ai
```

### 选择 `pi-coding-agent` SDK 的条件

当产品本身就是“云端/桌面/IDE 中的编码智能体”，并且确实需要 Pi 已有的 session tree、compaction、skills、extensions、内置 coding tools 与资源发现时，使用 `@earendil-works/pi-coding-agent` 更省工程量。官方明确支持自定义 UI、自动化流水线和程序化集成。[SDK 用例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#sdk)

若平台控制面不是 Node/TypeScript，优先保留官方 Pi 作为隔离 worker，通过 `pi --mode rpc` 的 stdin/stdout JSONL 协议控制，而不是急着采用社区 Rust 重写。官方 RPC 支持 prompt、steer、follow-up、abort、session 和事件流。[RPC 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)

### 什么时候选 oh-my-pi

如果目标是尽快交付“最强开箱即用编码智能体”，而不是构建稳定、最小的通用 agent runtime，可以评估 `@oh-my-pi/pi-coding-agent`。其优势来自大量内建工具和原生加速；代价是更大的攻击面、更多产品意见和 fork 演化风险。

### 什么时候选 pi_agent_rust

只有以下条件同时成立时才建议进入正式选型：

1. Rust 单二进制、低启动开销或 Rust 进程内嵌是硬性约束；
2. 已对关键 provider、tool、session、compaction、取消和故障恢复做过自有兼容测试；
3. 团队接受维护社区实现与官方 Pi 演进之间的差异；
4. 法务已接受其附加许可 rider。

否则，Rust 控制面 + 官方 Pi RPC worker 是风险更低的组合。

## 平台安全边界

官方 Pi 明确声明它**没有内建的文件系统、进程、网络或凭据权限隔离**，默认继承启动用户和进程的权限。[官方安全说明](https://github.com/earendil-works/pi#permissions--containerization) `beforeToolCall` 是有用的策略 hook，但不是强安全边界。

生产平台至少应补齐：

1. 每个任务/工作区独立的容器、micro-VM 或等价沙箱，默认只读根文件系统，按需挂载工作区；
2. 工具 allowlist 与参数级策略，危险操作进入审批流；
3. 网络出口 allowlist、DNS/HTTP 审计和下载大小限制；
4. 凭据代理或短期 token，不把平台主密钥直接注入 agent 进程；
5. CPU、内存、磁盘、token、成本、工具次数和墙钟超时配额；
6. 可追踪的 session、模型请求、工具调用、文件变更和人工审批审计日志；
7. extensions/skills/package 安装的签名、来源锁定与版本固定。

官方给出的三个隔离模式是 Gondolin、完整 Docker 和 OpenShell；文档同时提醒，extension 在 Pi 进程所在位置执行，只有覆盖内置工具并不自动隔离所有第三方 extension。[容器化文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)

## 最终建议

- **通用智能体平台**：选官方 `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`，平台层自建治理与持久化。
- **完整编码智能体产品**：选官方 `@earendil-works/pi-coding-agent`；如果优先追求功能密度，再单独 POC `oh-my-pi`。
- **Rust 平台宿主**：优先用官方 Pi 的 RPC worker；只有在 Rust 进程内嵌是硬约束且通过许可证审查后，再 POC `pi_agent_rust`。
- **“当前最热门版本”**：总体是官方 Pi `v0.83.0`；功能型 fork 是 oh-my-pi `v17.2.2`；Rust port 是 pi_agent_rust `v0.1.23`。
