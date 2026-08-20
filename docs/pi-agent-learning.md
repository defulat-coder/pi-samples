# Pi-first 数字人学习主线

Pi Workbench 是一个由 Web 触发的数字人应用：数字人档案定义长期角色，宿主能力档案定义权限，Pi `AgentSession` 负责执行，Web 负责选择角色和呈现过程。

## 一次数字人问答的生命周期

```text
浏览器选择 Digital Human
  -> POST /api/v1/digital-humans/chat/stream
  -> Fastify 校验 digitalHumanId + sessionId
  -> 校验 JSONL Session 的不可变 digitalHumanId binding
  -> 读取 .pi/digital-humans/*.json
  -> 宿主解析 Capability Profile
  -> DefaultResourceLoader 加载允许的 Skills
  -> createAgentSession() 创建或复用 Pi AgentSession
  -> session.prompt()
  -> Pi 决定直接回答或调用能力档案允许的只读工具
  -> session.subscribe() 转发 thinking / text / tool / lifecycle 事件
  -> 写入完整 turn metadata
  -> Web 渲染数字人回答和运行 Inspector
```

## 代码阅读顺序

1. [.pi/digital-humans/](../.pi/digital-humans/)：数字人档案。
2. [packages/pi-agent/src/digital-humans.ts](../packages/pi-agent/src/digital-humans.ts)：档案校验、能力档案和角色提示词。
3. [packages/pi-agent/src/index.ts](../packages/pi-agent/src/index.ts)：Pi Session 和工具生命周期。
4. [packages/pi-agent/src/session-store.ts](../packages/pi-agent/src/session-store.ts)：数字人 Session binding 和 Web 投影。
5. [apps/api/src/app.ts](../apps/api/src/app.ts)：数字人 HTTP/SSE 网关。
6. [apps/web/src/App.tsx](../apps/web/src/App.tsx)：数字人选择、会话和运行过程。
7. [docs/digital-human-design.md](./digital-human-design.md)：完整架构与验收合同。

## 三个核心概念

### Digital Human

产品角色，包含姓名、职业、人设、沟通风格、原则和欢迎内容。档案不能声明工具。

### Capability Profile

宿主维护的权限集合。目前只有：

- `project-knowledge`：`read/search_knowledge`；
- `business-analytics`：`read/query_business_data` 和 `business-intelligence` Skill。

### Pi AgentSession

数字人的执行实例。负责模型、消息、thinking、工具调用、usage、retry、compaction 和 dispose。数字人不是另一套 Agent Runtime。

## Session 与错误语义

Session 使用 Pi 官方 JSONL 文件，并写入 `pi-workbench.digital-human` custom entry。一个 Session 只能属于一个数字人；跨数字人请求返回 409。

只有包含完整 `pi-workbench.turn` metadata 的 turn 才会显示。没有数字人 binding 的旧 Session 不加载。模型未启用、Pi 失败或响应为空时直接返回错误，不生成本地替代回答。

## 运行验证

```bash
pnpm dev

curl -N -X POST http://127.0.0.1:4310/api/v1/digital-humans/chat/stream \
  -H 'content-type: application/json' \
  -d '{
    "digitalHumanId": "project-steward",
    "message": "请解释 Pi Session 生命周期"
  }'
```

经营分析数字人示例：

```bash
curl -N -X POST http://127.0.0.1:4310/api/v1/digital-humans/chat/stream \
  -H 'content-type: application/json' \
  -d '{
    "digitalHumanId": "commerce-analyst",
    "message": "按月对比各渠道近 90 天退款后销售额趋势"
  }'
```

## 证据与安全

- 数字人档案、Skill、Prompt、知识和模型输出都是输入，不是权限。
- 工具 allowlist 只由宿主能力档案决定。
- Provider key 只存在于 API 进程。
- Web 不导入 Pi SDK。
- `.pi/sessions/` 本地忽略，不提交用户对话。
- 项目不提供兼容、迁移或降级分支。
