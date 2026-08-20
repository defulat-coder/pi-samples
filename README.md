# Pi Workbench · 数字人团队

Pi Workbench 是一个以 Pi Coding Agent 为唯一运行时、以 Web 为入口的文件定义数字人工作台。数字人拥有姓名、职业、人设和沟通风格；宿主能力档案决定它能使用的 Skills、工具和数据域。

## 结构

- `.pi/digital-humans/`：数字人角色档案，不具备工具授权能力；
- `apps/web`：数字人选择、独立会话、流式回答和运行 Inspector；
- `apps/api`：数字人 HTTP/SSE 网关，负责身份校验、Session 归属和能力注入；
- `packages/pi-agent`：数字人注册表、能力档案、Pi Session 生命周期和 JSONL 投影；
- `packages/contracts`：Web、网关和运行时共享的当前 DTO；
- `packages/workspace-data`：Markdown 知识检索与本地经营分析语义模型。

数字人档案只能引用宿主已有的 `project-knowledge` 或 `business-analytics` 能力档案，不能声明工具。所有执行仍由 `createAgentSession()` 创建的 Pi `AgentSession` 完成。

## 当前数字人

- 小派 · 项目知识管家：`read/search_knowledge`；
- 林澈 · 电商经营分析师：`read/query_business_data` 和 `business-intelligence` Skill。

## 启动

```bash
pnpm install
pnpm dev
```

打开 [http://localhost:5173](http://localhost:5173)。API 默认监听 `http://localhost:4310`，Web 通过 `POST /api/v1/digital-humans/chat/stream` 使用 SSE 发起对话。

项目要求启用真实 Pi 模型，不提供本地替代回答：

```bash
cp .env.example .env
# 在 .env 中填写 KIMI_API_KEY
pnpm dev
```

Provider key 只存在于 API 进程。浏览器不接触模型凭据，也不导入 Pi SDK。

## Session

Session 使用 Pi 官方 `SessionManager` JSONL 格式，保存在 `.pi/sessions/`。每个当前 Session 都必须包含：

```json
{
  "customType": "pi-workbench.digital-human",
  "data": { "digitalHumanId": "commerce-analyst" }
}
```

Session 不能跨数字人复用。没有当前 binding 的旧 Session 不加载，也不迁移。

## 经营分析

林澈通过一次受约束的 `query_business_data` 调用组合认证指标、维度、时间和枚举筛选。查询返回唯一事实源 `BusinessAnalyticalResult`，服务端生成与渲染库无关的 `BusinessPresentationPlan`，Web 再转换为 json-render Spec。

## 验证

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
```

完整设计见 [数字人设计](docs/digital-human-design.md)，运行学习路径见 [Pi-first 数字人学习主线](docs/pi-agent-learning.md)。
