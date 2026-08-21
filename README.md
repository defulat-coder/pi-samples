# Pi 工作台

Pi 工作台是一个以 Pi Coding Agent 为运行时、以 Web 为入口的多 Agent 聊天工作台，界面结构复刻 LangSmith Fleet。Agent 由文件定义，当前为纯聊天形态（无工具）。

## 结构

- `.pi/agents/`：Agent 定义（Markdown + YAML frontmatter），新增一个文件即新增一个 Agent；
- `apps/web`：Fleet 风格聊天界面（侧边栏分组、欢迎态、流式对话、模型选择、"/" 提示词面板、只读配置面板）；
- `apps/api`：HTTP/SSE 网关，负责请求校验、Agent 身份、Session 归属和事件转发；
- `packages/pi-agent`：Agent 加载、Pi Session 生命周期、模型运行时与 JSONL 持久化；
- `packages/contracts`：Web 与 API 共享的 DTO。

所有对话由 `createAgentSession()` 创建的 Pi `AgentSession` 完成。

## 启动

```bash
pnpm install
cp .env.example .env   # 填写 KIMI_API_KEY
pnpm dev
```

打开 [https://pi-workbench.localhost](https://pi-workbench.localhost)。`pnpm dev` 通过 portless 启动，Web/API 分别暴露在 `https://pi-workbench.localhost` 和 `https://api.pi-workbench.localhost`；绕过代理可用 `pnpm dev:direct` 或 `PORTLESS=0 pnpm dev`。

项目要求启用真实 Pi 模型，不提供本地替代回答。Provider key 只存在于 API 进程，浏览器不接触模型凭据，也不导入 Pi SDK。

## Session

Session 使用 Pi 官方 `SessionManager` JSONL 格式，保存在 `.pi/sessions/`。每个 Session 通过 custom entry `pi-workbench.agent` 绑定唯一 Agent，不能跨 Agent 复用；没有合法绑定的 Session 不加载、不迁移。

## 验证

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
```
