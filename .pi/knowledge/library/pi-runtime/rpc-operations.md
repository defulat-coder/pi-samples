---
type: concept
title: RPC 与 JSONL：验证与运维视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。进程内 SDK、RPC 和 JSONL 模式的边界以及 Web 适配方式
resource: .pi/knowledge/library/pi-runtime/rpc-operations.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, rpc, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: rpc
variant: operations
---

# Pi Agent 运行时：RPC 与 JSONL 的边界、Web 适配与可验证运维

## 摘要与问题边界

Pi Agent 运行时的核心问题不是“能否返回一次正确结果”，而是“在多次请求、失败、重连、升级后，系统是否仍能在可观测的边界内保持一致”。本仓库 `AGENTS.md` 将默认路径定为 Node/TypeScript 同进程直接使用 `AgentSession`；`apps/api` 负责把事件流转为 SSE/JSON；`apps/web` 只消费流，不持有 Pi SDK 或模型密钥。RPC 与 JSONL 不是默认选项，而是隔离、沙箱或跨语言边界时的备选通道。运维视角需要记录成功、失败、延迟、容量和恢复证据，而不是仅凭一次成功请求下结论。

## 核心概念与数据模型

1. `AgentSession`：进程内 SDK 的会话对象。Node 通过 `createAgentSession()` 与配置的 `ModelRuntime` 建立会话，使用 `SessionManager.inMemory()` 维护当前 Web 会话注册表。边界：该对象只能在 `packages/pi-agent` 的 Node 进程中实例化，浏览器不能直接引入。

2. RPC 子进程：当需要进程隔离时，Pi 运行时被包装为独立子进程，宿主通过标准输入输出传递 JSONL 消息。边界：引入序列化、反序列化、进程心跳和退出码管理，恢复链路比同进程长。

3. JSONL 消息协议：每行一个完整 JSON 事件，常见事件包括 `message_update`（`text_delta`、`thinking_delta`、`toolcall_*`）、工具事件（`tool_execution_start`、`tool_execution_update`、`tool_execution_end`）以及生命周期/重试事件。边界：行尾换行符是消息边界，任何半行都会导致解析失败。

4. SSE 传输层：`apps/api` 将 JSONL 或结构化事件包装为 `text/event-stream` 发送给 `apps/web`。边界：SSE 受浏览器并发连接数、代理缓冲和超时策略影响，不能假设所有事件都实时到达。

5. 会话生命周期：一个 Web 会话对应一个 AgentSession，必须在调用 `session.prompt()` 之前完成订阅，请求结束后取消订阅并 dispose。边界：未订阅就调用 prompt 会丢失 thinking 和工具事件，后续无法补全。

6. 工具白名单：自定义工具通过 `defineTool()` 注册，本仓库仅暴露 `read` 和 `search_knowledge`，拒绝 Pi 内置的写能力工具。边界：工具参数和结果只是诊断信息，不能替代主机层的审批与沙箱。

7. 资源加载器：`DefaultResourceLoader` 以项目 `cwd` 构造，自动加载 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`；`.pi/knowledge` 不会自动注入，必须通过 `search_knowledge` 读取。边界：资源加载受项目信任保护，但不是沙箱。

8. 事件顺序与订阅契约：AgentSession 通过订阅回调推送事件，运行时保证事件顺序；前端按 SSE 到达顺序解析，不得乱序重排。边界：若订阅被延迟或客户端 buffering，重排会误导对“已完成”的判断。

## 设计决策与取舍

### 同进程 SDK 优先

Node/TypeScript 同进程使用 `AgentSession` 是最短路径，避免 IPC 和 JSONL 序列化开销。取舍：失去进程级隔离，模型输出或工具执行异常可能直接影响 API 进程。可验证指标：同进程的首事件延迟应低于本地网络回环的 RPC 版本。反模式：在 Node 同进程可用时，为追求“架构先进性”而强制启用 RPC，会引入不必要的序列化失败面和延迟。

### RPC/JSONL 仅在隔离或跨语言边界启用

当需要进程隔离时，Pi 运行时被包装为独立子进程，宿主通过标准输入输出传递 JSONL 消息。取舍：引入序列化、反序列化、进程心跳和退出码管理，恢复链路比同进程长。可验证指标：子进程崩溃率、重建会话平均耗时。反模式：把 RPC 子进程当作默认路径，会导致所有请求都承受 IPC 开销，且子进程重启时恢复困难。

### Web 端通过 SSE 消费，不持有凭证

`apps/api` 不向前端发送 Pi SDK 对象或模型密钥，只发送 JSON 事件。取舍：增加一层序列化，但保证浏览器无可迁移凭证。可验证指标：前端网络面板中不应出现 provider key 或 model key。反模式：让浏览器直接连接 provider SSE，会暴露密钥并失去白名单控制。

### 只读工具白名单

API 只注入 `read` 和 `search_knowledge`。取舍：限制 Agent 能力以换取安全；若业务需要写操作，必须在主机层显式扩展并增加审批。可验证指标：工具返回中若出现文件写入或 shell 命令，即视为绕过。反模式：因业务方便直接暴露 Pi 内置写工具，等于把主机文件系统权限交给模型输出。

### 共享 DTO 在 `packages/contracts`

`apps/api` 与 `apps/web` 共享请求/响应/流 DTO，避免两端各自解析 JSON。取舍：DTO 版本必须跟随 Pi SDK 升级，`pnpm typecheck` 可在编译期暴露字段不匹配。可验证指标：每次升级后 `pnpm typecheck` 与 `pnpm build` 必须通过。反模式：两端各自用 `any` 解析事件，升级 Pi SDK 后字段漂移，导致前端渲染异常。

## 可执行的实施流程

1. 确认环境：Node 版本与 `packageManager: pnpm@10.30.3` 一致；运行 `pnpm install` 保持 `pnpm-lock.yaml` 同步。
2. 在 `packages/pi-agent` 核对 `@earendil-works/pi-coding-agent` 版本，与项目当前版本及官方文档比对 API 签名。
3. 选择运行模式：同进程 `AgentSession` 或 RPC/JSONL 子进程；在 `packages/pi-agent` 中提供 `createSession` 工厂函数，统一入口。
4. 配置 `ModelRuntime` 与密钥，确保密钥只在 API 进程内可用；`apps/web` 不读取任何 provider key。
5. 以项目 `cwd` 构造 `DefaultResourceLoader`；验证 `.pi/skills`、`.pi/prompts`、`AGENTS.md` 存在；将 `.pi/knowledge` 留给 `search_knowledge`。
6. 注册工具：仅注册 `read` 和 `search_knowledge`；使用 `defineTool()` 返回结构化 content/details；拒绝返回写能力。
7. 在 `apps/api` 实现 SSE 路由：先 `session.subscribe()`，再调用 `session.prompt()`，把事件序列化为 JSON 或 JSONL 行，通过 `text/event-stream` 推送；连接关闭时取消订阅并 dispose。
8. 运行 `pnpm typecheck`、`pnpm build`、`pnpm test`；启动 `pnpm dev`；观察一次完整对话是否包含 `thinking_delta`、工具事件、`text_delta` 和结束事件。

## 输入、处理、输出示例

以下是一段 `apps/api` 向 `apps/web` 推送的 JSONL 事件流，输入为用户请求“解释 `.pi/knowledge` 中的 RPC 章节”，处理过程为 Agent 先思考、再调用 `search_knowledge`、最后返回文本。

    {"event":"message_update","delta":{"type":"thinking_delta","thinking":"需要先在 .pi/knowledge 中查找 RPC 与 JSONL 的相关内容。"}}
    {"event":"tool_execution_start","tool":"search_knowledge","args":{"query":"RPC JSONL 边界"}}
    {"event":"tool_execution_update","content":{"type":"text","text":"匹配到 docs/research/pi-official-agent-md-reference-2026-08-01.md 中的 JSON/RPC 章节。"}}
    {"event":"tool_execution_end","result":{"matches":[{"path":"docs/research/pi-official-agent-md-reference-2026-08-01.md"}]}}
    {"event":"message_update","delta":{"type":"text_delta","text":"RPC 与 JSONL 不是默认路径，而是隔离边界下的备选。"}}
    {"event":"done"}

输入为 HTTP POST 到 `/api/chat` 的用户消息；处理是 `packages/pi-agent` 内的 AgentSession 订阅与工具执行；输出是 SSE 携带的 JSONL 行，前端逐行解析后渲染到 Inspector 界面。

## 性能、质量和可观测性指标

| 指标 | 测量方法 | 合格判断 |
|------|----------|----------|
| 首事件延迟 | 从 HTTP 请求到首个 SSE 事件的时间戳差 | 同进程应低于 100 ms；RPC 版本应低于本地回环加序列化开销 |
| 事件间隔 P95 | 相邻 SSE 事件的时间差分布 | P95 不应超过模型 provider 正常吞吐的 2 倍 |
| 工具调用成功率 | 成功 `tool_execution_end` 数 / 总 `tool_execution_start` 数 | 正常场景应接近 100% |
| 会话完整结束率 | 收到 `done` 或正常关闭事件的会话 / 总会话 | 应高于 99.5%，残余会话需告警 |
| 连接异常率 | 非正常关闭的 SSE 连接 / 总连接 | 超时、错误、客户端 abort 需分类统计 |
| 资源占用 | API 进程与子进程 RSS、CPU；Node 用 `process.memoryUsage()` 和 `process.cpuUsage()` | 子进程 OOM 前必须触发平滑重启 |

## 失败模式、诊断证据与恢复动作

1. JSONL 行解析失败。证据：日志出现 `SyntaxError: Unexpected end of JSON input` 或最后一个事件字段不完整。恢复：丢弃半行，关闭当前会话，前端显示“流中断”，用户重试。

2. SSE 被代理缓冲。证据：浏览器网络面板中所有事件一次性到达，而非逐行到达。恢复：响应头加 `Cache-Control: no-cache` 和 `X-Accel-Buffering: no`；必要时改用 chunked fetch 并自行分帧。

3. RPC 子进程崩溃。证据：子进程退出码非零，心跳丢失，模型输出后立刻断开。恢复：捕获 `exit` 事件，按策略重启子进程，重建会话，向前端发送 `session_recreated` 事件。

4. 工具返回越界。证据：`tool_execution_end` 的 result 中出现文件写入、shell 命令或网络请求。恢复：在 `packages/pi-agent` 中校验 result 类型，拒绝非 read 内容，写入审计日志。

5. 密钥进入前端。证据：浏览器 DevTools 的请求或响应中出现 `api_key` 或模型 provider 凭证。恢复：立即删除前端硬编码，统一通过 `apps/api` 代理，旋转相关密钥。

6. 会话未订阅就 prompt。证据：数据库或日志中有 prompt 调用，但缺少 `thinking_delta` 和工具事件。恢复：在 `createSession` 工厂中强制 subscribe 后才返回可调用会话，并记录 subscription token。

7. 版本升级导致 DTO 字段漂移。证据：`pnpm typecheck` 报错或运行时事件字段缺失。恢复：升级前对比 `packages/contracts` 与 Pi SDK 事件类型，先类型检查再部署。

## 问答测试样例

1. 正向：Node 同进程应使用哪个对象与 Pi 运行时交互？答案：`AgentSession`，依据 `AGENTS.md` 和 `packages/pi-agent` 的默认实现。

2. 正向：Web 端以什么协议接收 Agent 事件？答案：`text/event-stream` 包装的 JSON 或 JSONL 事件。

3. 正向：如何验证资源加载器已正确加载项目上下文？答案：检查启动日志是否包含 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md` 的加载记录，且 `.pi/knowledge` 不在自动加载列表。

4. 边界：何时应启用 RPC/JSONL？答案：需要进程隔离、沙箱或跨语言边界时；默认不启用。

5. 边界：`.pi/knowledge` 是否随会话自动加载？答案：否，必须通过 `search_knowledge` 工具读取。

6. 边界：为什么 `apps/web` 不能持有模型密钥？答案：`AGENTS.md` 明确密钥只能留在 API 进程中，浏览器属于不可信边界。

7. 无证据拒答：Pi SDK 支持哪些模型 provider？答案：项目未公开具体 provider 列表；应检查 `@earendil-works/pi-coding-agent` 当前版本与 `.env` 配置后再回答。

8. 无证据拒答：RPC 子进程是否比同进程更快？答案：不能断言；需要测量 JSONL 序列化、IPC、上下文切换和恢复开销。

## 维护、版本、来源与相邻主题

- 版本管理：使用 `pnpm@10.30.3`；所有依赖变更必须同步 `pnpm-lock.yaml`；升级 Pi SDK 后先运行 `pnpm typecheck` 和 `pnpm test`。
- 技能管理：`.agents/skills/` 与 `skills-lock.json` 由 Skills CLI 管理，使用 `npx skills experimental_install` 或 `npx skills add` 恢复/新增，禁止手改。
- 文档来源：本主题主要依据 `AGENTS.md`、`packages/pi-agent`、`apps/api`、`apps/web` 的代码边界，以及 Pi 官方 `sdk.md`、`rpc.md`、`json.md` 和 `skills.md`。
- 相邻主题：与同进程 `AgentSession` 集成互补；与 `packages/contracts` 的 DTO 共享相关；与 `apps/web` 的 SSE 消费相关；与 `.pi/knowledge` 的 `search_knowledge` 工具相关；与 pi 项目信任和安全边界相关。

## 结论

- 事实：本项目的默认运行时是 Node 同进程 `AgentSession`；`apps/api` 通过 SSE/JSON 向 `apps/web` 推送事件；工具只暴露 `read` 和 `search_knowledge`；`DefaultResourceLoader` 以项目 `cwd` 加载 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`。
- 推论：RPC/JSONL 在隔离、沙箱或跨语言场景下更稳妥，但会引入序列化、进程管理和恢复延迟；同进程路径在延迟上占优，但共享崩溃域。
- 未知：具体模型 provider 在开启/关闭 thinking 时的事件密度差异、生产环境多浏览器 SSE 兼容性细节、RPC 子进程在高并发下的内存与进程调度极限。这些需通过实测日志和指标补充，不能从单次成功请求推导。
