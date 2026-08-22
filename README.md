# Pi 工作台

以 [Pi Coding Agent](https://github.com/earendil-works/pi) 为运行时、界面复刻 LangSmith Fleet 的多 Agent 聊天工作台。Agent 由 `.pi/agents/` 下的 Markdown 文件定义（YAML frontmatter + 正文作为 system prompt），当前为纯聊天形态（空工具白名单）。所有对话由 Pi `AgentSession` 驱动，不提供本地替代回答。

## 架构

```
┌──────────┐  HTTP/SSE  ┌──────────┐        ┌────────────────────┐        ┌─────────────────┐
│ apps/web │ ◄────────► │ apps/api │ ─────► │ packages/pi-agent  │ ─────► │ Pi SDK          │
│ React UI │            │ Fastify  │        │ Agent 加载 /        │        │ AgentSession /  │
└──────────┘            │ 网关     │        │ Session 生命周期    │        │ SessionManager  │
                        └────┬─────┘        └─────────┬──────────┘        └────────┬────────┘
                             │                        │                            │
                     packages/contracts        SQLite（通用数据：           .pi/（Pi 状态：
                     共享 DTO                  用量事件、UI 偏好）          sessions/*.jsonl、
                                                                          agents、settings）
```

边界约束：

- Web 不导入 Pi SDK、不接触 provider 凭据；key 只存在于 API 进程。
- API 只做请求校验、Agent/Session 归属与事件转发，不对用户消息做语义预路由。
- SQLite（`.pi/workbench.db`）只存通用数据；Session、消息、Agent 定义等 Pi 状态保留在 `.pi/` 文件中，不重复落库。
- Session 通过 JSONL custom entry `pi-workbench.agent` 绑定唯一 Agent，不可跨 Agent 复用；无合法绑定的 Session 不加载、不迁移。

## 快速开始

要求：Node >= 20（建议 22）、pnpm 10（见根 `packageManager` 字段）。

```bash
pnpm install
cp .env.example .env   # 填写 KIMI_API_KEY
pnpm dev
```

打开 <https://pi-workbench.localhost>。`pnpm dev` 通过 portless 启动，Web/API 分别暴露在 `https://pi-workbench.localhost` 和 `https://api.pi-workbench.localhost`；绕过代理可用 `pnpm dev:direct` 或 `PORTLESS=0 pnpm dev`。

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 并行启动 Web + API（经 portless 代理） |
| `pnpm build` | 构建全部包（turbo） |
| `pnpm typecheck` | 全部包 `tsc --noEmit`（TypeScript 7 原生编译器） |
| `pnpm lint` | 各包 tsc + ESLint（typescript-eslint 走旁路 TS 6，见 `.pnpmfile.cjs`） |
| `pnpm test` | 全部包测试（node:test；api/pi-agent 跑 dist，web 跑 tsx） |
| `pnpm format` | Prettier 格式化 |

## 目录结构

```
apps/web            Fleet 风格聊天界面（React 19 + Vite + motion）
apps/api            HTTP/SSE 网关（Fastify）
packages/pi-agent   Agent 文件加载、Pi Session 生命周期、事件归一化、SQLite 投影
packages/contracts  Web ↔ API 共享 DTO
tools/eslint        ESLint 工具链（typescript-eslint + 旁路 TypeScript 6）
.pi/                Agent 定义、Skills、prompt 模板、Session JSONL、workbench.db
docs/               架构笔记、ADR、Fleet 设计 token 参考
plans/              变更计划记录
```

## 测试与 CI

- 测试框架为 `node:test`：`apps/api` 与 `packages/*` 先构建再跑 `dist/**/*.test.js`，`apps/web` 用 `tsx --test` 直接跑源码（含 jsdom 组件测试）。
- GitHub Actions（`.github/workflows/ci.yml`）在 push 与 PR 时依次执行 install → build → typecheck → lint → test。
- 提交前本地验证：`pnpm build && pnpm typecheck && pnpm lint && pnpm test`。

更多约定见 [AGENTS.md](AGENTS.md)、[docs/adr/0001-monorepo-and-pi-boundary.md](docs/adr/0001-monorepo-and-pi-boundary.md)。
