# Pi Workbench · Agent Playground

Pi Workbench 是一个以 Pi Coding Agent 为核心、以 Web 为入口的 TypeScript monorepo。页面的唯一目的，是验证 Agent 的 session、项目资源、只读工具、知识检索和回答证据。

## 结构

- `apps/web`：Agent 对话页面，展示回答、来源、运行状态和事件摘要。
- `apps/api`：Agent Gateway，负责请求校验、资源快照、只读工具注入和 Pi 调用；不做语义路由。
- `packages/pi-agent`：`@earendil-works/pi-coding-agent` SDK 适配层，封装 session、turn 和 `.pi/sessions/` JSONL 持久化。
- `packages/contracts`：Web/API/Agent 的共享 DTO。
- `packages/workspace-data`：通用本地 SQLite 数据与 Markdown consumer，提供可替换的数据适配样例。
- `.pi/`：类似 Claude Code `.claude/` 的项目级 Agent 文件资源。

会话历史遵循 Pi 官方 `SessionManager` JSONL 格式，保存在项目 `.pi/sessions/`；不会写入 SQLite。Pi 的原生消息、thinking、tool result 和 usage 保留在 JSONL 中，工作台指标与反馈使用同文件的 `custom` entries 保存。

## 启动

```bash
pnpm install
pnpm dev
```

打开 [http://localhost:5173](http://localhost:5173)。页面通过 `POST /api/v1/agent/chat/stream` 以 SSE 调用 Agent Gateway，API 默认监听 `http://localhost:4310`。旧的 `POST /api/v1/agent/chat` JSON 接口仍保留给非流式调用。

## Pi 运行模式

默认模式不需要模型凭据：Agent Gateway 使用本地 Markdown consumer 做可解释的 fallback，方便先验证 Web、来源和权限状态。真实 Pi 模式下，前端原始消息会进入 Pi，由 Pi 自己决定是否调用工具。

当前项目已接入 Kimi Code Provider。配置本地 `.env` 后启用真实 Pi：

```bash
cp .env.example .env
# 在 .env 中填写 KIMI_API_KEY
pnpm dev
```

默认选择 `kimi-coding/kimi-for-coding`。也可以通过 `PI_MODEL_PROVIDER`、`PI_MODEL` 和 `PI_THINKING_LEVEL` 覆盖。Kimi Code 的 API key 只放在 API 进程环境中，浏览器不会接触。

`packages/pi-agent` 的核心运行时包含：

- `DefaultResourceLoader`：按 Pi 官方发现规则加载 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`；`.pi/knowledge` 由项目的 `search_knowledge` 只读 custom tool 读取；
- `createPiAgentSession()`：创建 Pi session；
- `session.prompt()`：提交一次 turn；
- `session.subscribe()`：观察消息、thinking、工具和生命周期事件；
- `tools: ['read']` + `search_knowledge`：保持只读权限边界；`search_knowledge` 是 Pi 可选择调用的本地 Markdown 工具，不是请求前的路由器。

流式通道会在最终 `done` 之前持续发送 `thinking_delta`、`text_delta` 和结构化 `event`：Inspector 可以实时看到 Pi 的 thinking 阶段、工具选择、工具输入/输出、turn 生命周期和错误重试；对话区域则实时追加回答文本。

## 文件知识库

`.pi/knowledge` 使用 OKF-compatible Markdown + YAML frontmatter。它是可审阅、可版本控制的知识源，不是在线 RAG 引擎；当前 consumer 使用确定性关键词检索，未来可以替换为 SQLite FTS5、QMD 或其他索引。

## 验证

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
```

设计与学习路径见 [Pi-first Web Agent 学习主线](docs/pi-agent-learning.md)。
