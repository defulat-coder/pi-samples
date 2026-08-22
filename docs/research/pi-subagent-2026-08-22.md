# Pi Coding Agent SubAgent 能力调研（2026-08-22）

调研目的：为把 SubAgent 作为基础能力集成进本仓库的多 Agent 工作台提供事实依据（对标已完成的 HITL 审批集成）。
一手来源：上游 `earendil-works/pi` main 分支（GitHub raw/API）、本仓库已安装的 `@earendil-works/pi-coding-agent@0.84.1`、本仓库现有集成代码。

下文统一缩写：

- `<sdk>` = `node_modules/.pnpm/@earendil-works+pi-coding-agent@0.84.1_ws@8.21.1_zod@4.4.3/node_modules/@earendil-works/pi-coding-agent`
- `<pps>` = `node_modules/.pnpm/pi-permission-system@0.8.0_patch_hash=abddc81d…/node_modules/pi-permission-system`
- 上游 raw 链接均指向 `main` 分支，抓取日期 2026-08-22。

## 0. 核心结论（TL;DR）

1. **Pi 没有内置的 SubAgent 核心能力。** SubAgent 的唯一官方形态是 `examples/extensions/subagent/` 这个**示例扩展**：它通过 `ExtensionAPI.registerTool` 注册一个名为 `subagent` 的工具，父会话的模型像调普通工具一样调用它。SDK 核心（`dist/core/*.js` / `dist/core/*.d.ts`）中不存在任何 subagent 相关代码或 `createAgentSession` 选项。
2. **该示例的实现方式是「子进程 + JSON 事件流」**：对每个子代理 `spawn` 一个独立的 `pi --mode json -p --no-session` 进程，逐行解析其 stdout 的 JSON 事件，取最后一条 assistant 文本作为结果返回给父会话。不是会话嵌套，也不是 RPC 层概念，也不是 SDK API。
3. **JSON 事件协议里没有 subagent 专属事件类型。** 子进程发出的是标准事件流（`message_end` / `tool_result_end` 等）；父会话侧只表现为一次普通的 `tool_execution_start/update/end`（工具名 `subagent`）。
4. **`PI_IS_SUBAGENT` / `PI_AGENT_ROUTER_PARENT_SESSION_ID` 不是 Pi 上游的机制**，而是第三方扩展 `pi-permission-system` 自己定义的约定，用于「任何无 UI 的执行上下文」（headless SDK 宿主、delegated/routed subagent）把 `ask` 审批通过文件转发给有 UI 的会话。上游 pi 仓库代码中完全搜不到这两个变量。
5. **0.84.1 与上游 main 的实质差异很小**：main 的 subagent 示例新增了对 `ctx.isProjectTrusted()` 的检查（已信任项目跳过逐次确认），0.84.1 的示例无此检查；但 `isProjectTrusted()` 这个 API 在 0.84.1 已存在。核心 SDK 两侧均无 subagent 入口。
6. **对本项目最自然的集成路径不是照搬子进程示例**，而是在 `packages/pi-agent` 内**进程内**注册一个 `subagent` 自定义工具（`customTools` 或 inline extension），复用现有 `createPiAgentSession` + 审批扩展 + SQLite 投影管线。

## 1. SubAgent 的确切形态

### 1.1 上游 main 文档说法

- `packages/coding-agent/docs` 目录下**没有** subagents.md / agents.md 之类的专门文档；全目录中只有 `extensions.md` 在示例扩展清单里列了一行：`subagent/ | Spawn sub-agents | registerTool, exec`。
  - 来源：目录列表 <https://api.github.com/repos/earendil-works/pi/contents/packages/coding-agent/docs?ref=main>（2026-08-22 抓取，无 subagent 专项文档）；`extensions.md` 清单行同时见本地 `<sdk>/docs/extensions.md:2970`。
- `sdk.md`、`rpc.md`、`json.md` 在 main 分支均不含 subagent 内容（GitHub code search `repo:earendil-works/pi subagent path:packages/coding-agent/docs` 仅命中 `docs/extensions.md`，2026-08-22）。
- 上游 src 中也搜不到 subagent（code search `repo:earendil-works/pi subagent path:packages/coding-agent/src` 无结果，2026-08-22）。

### 1.2 示例扩展的实际形态（0.84.1 随包发布，main 同源）

`pi registerTool` 注册名为 `subagent` 的工具，三种调用模式（`<sdk>/examples/extensions/subagent/index.ts:448-470`、README「Tool Modes」表 `<sdk>/examples/extensions/subagent/README.md:91-97`）：

| 模式 | 参数 | 语义 |
|------|------|------|
| Single | `{ agent, task, cwd? }` | 一个 agent 执行一个任务 |
| Parallel | `{ tasks: [{agent, task, cwd?}...] }` | 并发执行，上限 8 个任务 / 4 并发（`index.ts:33-34`） |
| Chain | `{ chain: [{agent, task}...] }` | 顺序执行，task 中 `{previous}` 占位符替换为上一步输出（`index.ts:534-536`） |

Agent 定义格式：`~/.pi/agent/agents/*.md`（user 级）与 `.pi/agents/*.md`（project 级）的 Markdown + YAML frontmatter，字段为 `name` / `description` / `tools`（逗号分隔）/ `model`，body 即 system prompt（`<sdk>/examples/extensions/subagent/agents.ts:52-72`）。默认只加载 user 级；`agentScope: "project"|"both"` 才纳入 project 级，且交互模式下会弹确认（`index.ts:505-528`，README「Security Model」`README.md:55-65`）。

**注意**：这个 agent 文件格式与本仓库 `.pi/agents/*.md` 格式**兼容但不等同**——本仓库 frontmatter 另有 `mark`/`tagline`/`suggestions` 字段（`.pi/agents/code-reviewer.md:1-10`），且本仓库按 AGENTS.md 契约不允许 agent 文件声明工具；示例扩展的 `tools`/`model` 字段是扩展自己解析的，不是 Pi 核心语义。

### 1.3 形态判定

SubAgent 不是：内置 `task` 工具（不存在）、会话嵌套（无此 API）、`createAgentSession` 选项（`CreateAgentSessionOptions` 无任何 subagent 字段，`<sdk>/dist/core/sdk.d.ts:10-50`）、RPC 概念（`rpc.md` 无相关内容）。它就是「扩展注册的自定义工具 + 子进程编排」，任何宿主都可以自己实现等价物。

## 2. 生命周期与事件流

以下全部来自 0.84.1 示例实现 `<sdk>/examples/extensions/subagent/index.ts`：

- **创建**：`runSingleAgent()` 拼 CLI 参数 `["--mode", "json", "-p", "--no-session"]`，按需追加 `--model <m>`、`--tools a,b,c`、`--append-system-prompt <临时文件>`（system prompt 写入 `os.tmpdir()` 下 `pi-subagent-*` 临时文件，权限 0600，结束后删除），最后一个参数是 `Task: <task>`（`index.ts:294-330`，临时文件 `index.ts:239-247`）。
  - 这些 CLI flag 在 0.84.1 的 CLI 解析器中均存在：`<sdk>/dist/cli/args.js:27`（`--mode json`）、`:49`（`--append-system-prompt`）、`:61`（`--no-session`）。
- **进程启动**：`getPiInvocation()` 优先用 `process.argv[1]`（当前 pi 脚本）+ `process.execPath` 自举，兜底 `pi` 命令（`index.ts:249-263`）；`spawn(cmd, args, { cwd, stdio: ["ignore","pipe","pipe"] })`（`index.ts:333-339`）。
- **事件流**：逐行解析子进程 stdout 的 JSONL，只消费两类事件——`message_end`（累积消息、turns、usage、model、stopReason、errorMessage）和 `tool_result_end`（`index.ts:342-377`）。进度通过工具的 `onUpdate` 回调回传父会话，父会话侧表现为 `tool_execution_update` 的 `partialResult`。
  - 子进程事件协议即标准 JSON 模式协议：`agent_start/turn_start/message_*/tool_execution_*/agent_end`，无 subagent 专属类型（`<sdk>/docs/json.md:9-47`）。
- **结果**：取最后一条 assistant 消息的 text 部分作为返回值（`getFinalOutput`，`index.ts:170-180`）；parallel 模式每个任务回给父模型的输出截断到 50 KB（`index.ts:36`、`193-202`）。
- **取消**：父会话 abort signal 触发时先 `SIGTERM`，5 秒未退出再 `SIGKILL`，并抛 "Subagent was aborted"（`index.ts:399-413`）。README 称交互模式 Ctrl+C 会传播杀子进程（`README.md:12`）。
- **失败语义**：`exitCode != 0`、`stopReason === "error"|"aborted"` 视为失败；chain 模式在第一个失败步停止并报出是哪一步（`index.ts:182-184`、`566-574`；README「Error Handling」`README.md:163-168`）。
- **用量**：每 agent 汇总 turns/input/output/cacheRead/cacheWrite/cost/contextTokens（`index.ts:351-369`）。

## 3. 权限 / 工具与审批转发

### 3.1 子代理的工具白名单

示例扩展通过 `--tools` CLI flag 把 agent frontmatter 的 `tools` 字段传给子进程（`index.ts:296`）；未声明则子进程用默认内置工具集。子进程是独立的 pi 进程，独立加载自己的扩展与配置——**父会话的权限上下文不会自动继承给子进程**，安全模型完全靠「子进程自己加载的扩展 + agentScope 确认」两道闸（`README.md:55-65`）。

### 3.2 PI_IS_SUBAGENT 转发机制的真正归属

- 这两个环境变量由 **pi-permission-system 扩展**（第三方，非上游 pi）定义和消费：
  - `SUBAGENT_ENV_HINT_KEYS = ["PI_IS_SUBAGENT", "PI_SUBAGENT_SESSION_ID", "PI_AGENT_ROUTER_SUBAGENT"]`、`SUBAGENT_PARENT_SESSION_ENV_KEY = "PI_AGENT_ROUTER_PARENT_SESSION_ID"`（`<pps>/src/permission-forwarding.ts:9-11`）。
  - 无 UI 且 `isSubagent` 时，ask 决策的转发目标会话 id 从 `PI_AGENT_ROUTER_PARENT_SESSION_ID` 读取；读不到则报错 "Permission forwarding target session could not be resolved from subagent runtime metadata"（`<pps>/src/permission-forwarding.ts:117-134`、`<pps>/src/index.ts:1003`）。
- 上游 pi 仓库 main 中**搜不到** `PI_IS_SUBAGENT`、`PI_AGENT_ROUTER_PARENT_SESSION_ID`、`agent-router`（GitHub code search，2026-08-22，三个查询均无结果）。所以这套机制**不是为某个上游内置 subagent 功能设计的配套**，而是 pi-permission-system 面向「一切无 UI 执行上下文」的通用设计——README 原文："When a delegated or routed subagent runs without direct UI access, `ask` permissions can still be enforced by forwarding the confirmation request through Pi session directories"（`<pps>/README.md:564-568`）。`PI_AGENT_ROUTER_*` 的命名暗示扩展作者设想了一个外部 "agent router" 宿主角色，本仓库的 API 进程目前正是在扮演这个角色。
- 转发协议本身：`ForwardedPermissionRequest`（id/responseNonce/requesterSessionId/targetSessionId/requesterAgentName/message）写到 `<agentDir>/sessions/permission-forwarding/sessions/<sessionId>/requests/<id>.json`，响应写同级 `responses/`，请求方轮询最长 10 分钟（`<pps>/src/permission-forwarding.ts:6-8`、`21-47`、`93-115`）。
- 父会话（有 UI）侧：扩展轮询转发目录，弹确认，写回响应文件；本仓库把「父会话」角色替换成了 API 进程 + Web 收件箱——`packages/pi-agent/src/approvals.ts:9-15` 描述的文件桥正是消费这个 `requests/`/`responses/` 协议，再投影进 SQLite `approvals` 表。

### 3.3 与本仓库现有集成的关系

本仓库 `packages/pi-agent/src/permissions.ts:39-41` 已经给**所有**会话（不只是 subagent）设置了 `PI_IS_SUBAGENT=1` + `PI_AGENT_ROUTER_PARENT_SESSION_ID='workbench'`——因为在 Web 网关场景下每个 Pi 会话都是无 UI 的「subagent 式」上下文。这意味着：**未来真正的 subagent 会话只要复用同一套 `loadPermissionExtension` 加载路径，审批转发就自动工作，无需额外机制**。注意 env 是进程全局的（`??=` 只在未设置时写入），同一 API 进程内所有会话共享同一个转发目标 `'workbench'`，靠请求文件里的 `requesterSessionId` 区分来源会话（`packages/pi-agent/src/permissions.ts:21-22` 注释）。

## 4. SDK 0.84.1 实际可用入口 vs 上游 main

| 面 | 0.84.1（本仓库事实） | 上游 main | 差异 |
|----|----------------------|-----------|------|
| 核心 SDK subagent API | 无。`createAgentSession` 选项无 subagent 字段（`dist/core/sdk.d.ts:10-50`）；`dist/` 全量 grep `subagent` 零命中 | 无（src 中无 subagent 代码） | 无差异 |
| subagent 示例扩展 | 随 npm 包发布于 `examples/extensions/subagent/`（可直接 import 源码，上游回归测试就是这么做的） | 同路径，持续维护 | main 版在 project agent 确认处增加 `!ctx.isProjectTrusted()` 检查（<https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/subagent/index.ts>，第 522-524 行）；0.84.1 版只看 `confirmProjectAgents && ctx.hasUI`（`index.ts:505`） |
| `ctx.isProjectTrusted()` API | **已存在**（`dist/core/extensions/types.d.ts:234`、`:1214`） | 存在 | 0.84.1 可自己补信任检查，不必等升级 |
| JSON 事件协议 | 无 subagent 事件类型（`docs/json.md:9-47`） | 同 | 无差异 |
| 注册自定义工具的宿主入口 | `ExtensionAPI.registerTool`（扩展/`extensionFactories`）；另有 `createAgentSession({ customTools: ToolDefinition[] })`（`dist/core/sdk.d.ts:44-45`）可不走扩展机制直接加工具 | 同 | — |
| CHANGELOG 中的 subagent 条目 | 全部是示例扩展的修复（`CHANGELOG.md:1170` parallel 输出、`:1836` bun vfs 路径泄漏、`:2617` user agents 目录解析、`:2757` unknown-agent 报错、`:4125` README 文件名），无核心功能条目 | — | 印证 subagent 一直是示例而非核心 |

另外，上游 main 有一条回归测试 `test/suite/regressions/8261-subagent-project-trust.test.ts`：trusted 项目跳过逐次确认、untrusted 项目保留确认且拒绝时返回 "Canceled: project-local agents not approved."（<https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/test/suite/regressions/8261-subagent-project-trust.test.ts>）。该测试还展示了一个重要用法：**示例扩展可以直接 `import subagentExtension from ".../examples/extensions/subagent/index.ts"` 作为 `extensionFactories` 元素注入测试 harness**——这与本仓库 `extensionFactories: [permissionExtension]` 的加载方式（`packages/pi-agent/src/index.ts:87`）同构。

## 5. 对本项目的集成建议（初步，未实现）

前提判断：本仓库会话全部由 API 进程托管（无 TUI），照搬示例的「spawn pi 子进程」路线会引入第二套会话持久化、第二份 provider key 分发和进程管理负担；而本仓库已有进程内 `createAgentSession` 管线（`packages/pi-agent/src/index.ts:109-118`）。建议：

1. **在 `packages/pi-agent` 内实现进程内 `subagent` 工具**，而非引入示例扩展：
   - 新增类似 `subagent.ts` 的模块，用 `customTools`（`CreateAgentSessionOptions.customTools`，`dist/core/sdk.d.ts:44-45`）或第二个 inline extension 注册 `subagent` 工具；
   - `execute` 内部调用现有 `createPiAgentSession()`（`SessionManager.inMemory()` 或独立的 subagent JSONL 会话），`session.prompt(task)`，订阅事件并把进度通过工具的 `onUpdate` 回调映射为父会话的 `tool_execution_update`；
   - 取消语义：父会话 abort → `session.dispose()` / abort 子 prompt（对应示例的 SIGTERM→SIGKILL，`index.ts:399-413`）。
2. **Agent 定义复用 `.pi/agents/*.md`**：给 frontmatter 增加一个显式能力标记（例如 `subagent: true` 或 `callable: true`），而不是让每个 agent 默认可被调用——符合 AGENTS.md「Agent 文件不得声明或扩展工具」的契约，工具白名单仍由宿主控制（子会话沿用 `['read','grep','find','ls','bash']` 或按 agent 收敛）。是否引入示例扩展的 `tools`/`model` frontmatter 字段需单独决策，建议**不引入**，模型选择走现有 chat request 的 `model` 字段通道。
3. **审批链路零新机制**：子会话同样经 `loadPermissionExtension` 加载（env 已是进程全局），`ask` 决策自动落入现有 `.pi/permission-forwarding` 文件桥 → `approvals.ts` → SQLite → `/api/v1/approvals` → Web 收件箱。需要补的只是把审批记录的 `requesterSessionId` 在 Web 侧展示为「哪个父会话的哪个 subagent 调用」。
4. **API 层**：不需要独立的 subagent 端点——subagent 调用是父会话 turn 内的一次工具调用，走现有 SSE 通道转发 `tool_execution_start/update/end`（工具名 `subagent`）即可。可选增强：在 contracts 里给 `subagent` 工具的 `partialResult`/`details` 定义结构化 DTO（agent 名、任务、状态、用量），让 Web 端稳定渲染，而不是解析文本。
5. **Web 层**：参照示例的 collapsed/expanded 视图语义（`README.md:99-123`）渲染嵌套工具卡片：状态图标 + agent 名 + 最近 N 条工具调用 + 用量行；并行/链式调用展示聚合进度。细节属于设计任务，此处不展开。
6. **信任模型**：若未来允许模型自主决定调用 subagent，建议参考 main 版示例的 `ctx.isProjectTrusted()` 思路，在 API 宿主侧用配置（而非交互确认）控制「哪些 agent 可被自动调用」；本仓库项目信任语义由 API 进程托管，无 TUI 确认通道。

## 6. 未确认事项

- 上游是否有将 subagent 从示例晋升为核心能力的路线图：**未确认**（docs/CHANGELOG/code search 均无迹象，但没有查阅上游 issues/讨论区）。
- 示例扩展在**非 TUI 宿主**（`hasUI === false`）下 `agentScope: "project"` 的确认行为：代码显示 `confirmProjectAgents && ctx.hasUI` 才弹确认（`index.ts:505`），即 headless 下静默放行 project agent——对我们不重要（不打算用该扩展），但若直接复用需注意。
- 进程内嵌套 `createAgentSession`（父会话工具执行回调里再建子会话）在 0.84.1 是否有已知的重入/资源限制问题：**未确认**，需要 spike 验证。
- `PI_SUBAGENT_SESSION_ID` / `PI_AGENT_ROUTER_SUBAGENT` 这两个 hint key 在 pi-permission-system 内部的具体判定逻辑（`SUBAGENT_ENV_HINT_KEYS`，`permission-forwarding.ts:9`）本次未逐行读完，集成前如需依赖其精确语义应再核对 `src/index.ts` 中 isSubagent 的判定路径。

## 7. 最终落地（2026-08-22 补充，已实现）

第 5 节的自实现建议被否决（用户要求用现成方案直接集成），最终选型与落地如下：

1. **选型 `pi-subagents`（nicobailon，npm 0.54.0）**：社区实现，功能远超上游示例（内建 reviewer/worker/oracle 等 agents、并行/链式/后台 run、管理 action）。peer 兼容本仓 0.84.x。与 HITL 的引入方式相同：第三方扩展 + 加载层（`packages/pi-agent/src/subagents.ts`）。
2. **加载方式是 jiti 而非 esbuild bundle**：pi-subagents 多处按 `import.meta.url` 相对源码布局定位运行时资产（子进程要加载的 `subagent-prompt-runtime.ts` / `fanout-child.ts`、内建 `agents/`、`prompts/`），bundle 后全部错位（实测子进程报 `Extension path does not exist: .../dist/subagent-prompt-runtime.ts`）。改为 `createJiti().import(require.resolve('pi-subagents'))` 从真实安装路径加载 TS 源码（与 pi CLI 加载扩展的方式一致），所有相对路径天然成立，无需 patch。
3. **委派的真实形态是「spawn pi CLI 子进程」**（`pi-subagents/src/runs/foreground/execution.ts` → `shared/pi-spawn.ts`），不是进程内 fork。子进程跑 RPC 模式，会自己 `bindExtensions` → `session_start` 正常触发 → 项目策略在子进程内生效。
4. **关键修复：`createAgentSession` 不代发 `session_start`**。只有 CLI 的 print/interactive/rpc 模式内部调 `session.bindExtensions()`（`dist/core/agent-session.js`），SDK 宿主直接 `createAgentSession` 时扩展永远收不到 `session_start`。pi-permission-system 在 `session_start` 里才用 `ctx.cwd` 重建 PermissionManager，缺失时项目策略文件（`.pi/agent/pi-permissions.jsonc`）完全不加载，所有工具退回 DEFAULT_POLICY(ask)。修复：宿主侧 `createPiAgentSession` 建会话后显式 `await session.bindExtensions({})`（`packages/pi-agent/src/index.ts`）。这一坑同时解释了此前「始终允许持久化不生效」（策略写了但没人读）。
5. **工具白名单语义是「只启用列出的名字」**：扩展注册的 `subagent` 必须显式加入 `tools: [...,'subagent']`，并在项目策略里 `"subagent": "allow"`（委派只是编排；子进程里的 bash 等仍按各自策略审批，ask 经 spawnEnv 继承的 `PI_IS_SUBAGENT` 自动落审批桥）。
6. **事件流**：父会话侧即标准 `tool_execution_start/update/end`（工具名 `subagent`），API 转发为 SSE `tool` 帧（contracts `ChatStreamEvent`），Web ThreadView 渲染委派卡片。args/result 在 API 侧截断 4KB。
7. **验证**：`packages/pi-agent/src/subagents-spike.test.ts`（3 用例：工具注册 / list 含内建与项目级 agent / 真实委派终态不挂起）+ 真实 API 端到端（kimi-for-coding 父会话委派 reviewer，子进程正常 spawn、状态轮询、结果回传）。
