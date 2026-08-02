# Pi-first Web Agent 学习主线

Pi Workbench 的核心不是 CLI，也不是业务后台，而是一个由 Web 触发的 Pi Agent 应用：Web 负责提问和展示，API 负责 Agent Gateway，`packages/pi-agent` 负责 Pi session，`.pi/` 文件负责项目资源和知识。

## 一次 Web 问答的完整生命周期

```text
浏览器 Agent Playground
  -> POST /api/v1/agent/chat/stream (SSE)
  -> Fastify Agent Gateway
  -> 在项目 .pi/sessions/ 创建/复用 Pi JSONL session，并注入只读工具
  -> DefaultResourceLoader 加载 .pi/
  -> session.prompt(原始用户消息)
  -> Pi 自己决定：直接回答，或调用 search_knowledge / read
  -> 工具结果回到 Pi，再生成最终回答
  -> session.subscribe() 观察 thinking_delta / text_delta / tool_execution / turn_end
  -> API 持续转发 start / event / thinking_delta / text_delta，最后发送 done
  -> 浏览器边收边渲染回答、thinking、工具过程和 Inspector
```

## 代码阅读顺序

1. [apps/web/src/App.tsx](../apps/web/src/App.tsx)：对话页面、消息状态、证据和运行 Inspector。
2. [apps/api/src/app.ts](../apps/api/src/app.ts)：`/api/v1/agent/chat/stream`、兼容 JSON 的 `/api/v1/agent/chat` 和 `/api/v1/agent/workspace`。
3. [packages/pi-agent/src/index.ts](../packages/pi-agent/src/index.ts)：`createPiAgentSession()`、`askPiAgent()` 和 Pi 事件收集。
4. [packages/pi-agent/src/session-store.ts](../packages/pi-agent/src/session-store.ts)：Pi 官方 JSONL session 文件、Web 元数据 custom entry 和反馈投影。
5. [.pi/skills/pi-workbench/SKILL.md](../.pi/skills/pi-workbench/SKILL.md)：项目级 Agent 行为约束。
6. [.pi/prompts/agent-chat.md](../.pi/prompts/agent-chat.md)：对话提示模板。
7. [packages/workspace-data/src/knowledge.ts](../packages/workspace-data/src/knowledge.ts)：OKF-compatible Markdown 加载和确定性检索 consumer。

## 三层职责

### Web：交互层

Web 不直接接触 Pi SDK，也不持有 provider key。它只提交原始 `message/sessionId`，然后展示：

- `answer`：自然语言回答；
- `decision`：由 `pi` 或 `fallback` 产生，以及 Pi 实际调用的工具；
- `route`：`workspace` 或 `knowledge`，仅表示执行后的观察结果，不是输入路由；
- `sources`：Markdown 文件引用；
- `events`：本次 turn 的生命周期摘要；
- SSE 中的 `thinking_delta`、`text_delta` 和 `event`：用于实时观察模型 thinking、回答增量、工具调用参数/结果和生命周期；
- `tools/model/latency`：运行状态。

### API：Agent Gateway

API 是安全边界和编排入口：

1. 校验请求；
2. 读取当前项目资源快照；
3. 创建或复用 `.pi/sessions/*.jsonl` 中的 Pi session；
4. 注入 `read` 和 `search_knowledge` 两个只读工具；
5. 把原始消息交给 Pi，不在这里判断业务意图；
6. 收集 Pi 的工具事件和来源，实时转发 SSE，再在 `done` 事件中返回统一 DTO。

### Pi Agent：运行时

`packages/pi-agent` 负责 Pi 的核心生命周期：

- `DefaultResourceLoader`：按 Pi 官方发现规则加载 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`；`.pi/knowledge` 由项目的 `search_knowledge` 只读 custom tool 读取；
- `createPiAgentSession()`：创建 Agent session；
- `session.prompt()`：提交原始用户问题；
- `session.subscribe()`：观察消息和工具事件；
- `session.dispose()`：关闭 session。

Session 历史不再进入 SQLite：`SessionManager` 使用官方 JSONL 树结构保存用户消息、assistant 消息、tool result、thinking、模型 usage 等；本项目的回答指标和点赞/点踩作为 `custom` entry 写入同一个 JSONL 文件，不会进入 LLM context。`.pi/sessions/` 已加入 `.gitignore`，避免把用户对话和模型输出提交到仓库。

Pi 不直接写文件、执行 shell 或修改外部数据。它在只读工具边界内自行决定是否检索，并组织答案。

## 证据边界

- 项目规则、session 说明和工具策略：`.pi/knowledge/*.md`；
- 一次回答只引用 Pi 实际使用的文件片段；
- 没有证据时明确说不知道；
- 本地 fallback 必须标记 `source=local-fallback`；
- 真实模型回答必须标记 `source=pi-coding-agent`。

## Pi 资源目录

```text
.pi/
├── skills/pi-workbench/SKILL.md
├── prompts/agent-chat.md
├── sessions/                 # Pi 官方 JSONL session（本地忽略）
└── knowledge/
    ├── index.md
    └── agent/*.md
```

知识 Markdown 使用 OKF-compatible frontmatter，可以通过 Git 审阅、版本控制和回滚。OKF 是知识文件格式，不是在线 RAG 引擎；当前 consumer 是本地确定性检索，未来可以替换为 SQLite FTS5、QMD 或其他索引。

## 建议的 Web 学习顺序

```bash
# 1. 启动 Web + API
pnpm dev

# 2. 打开 Agent Playground
open http://localhost:5173

# 3. 直接观察 Web 使用的 Agent SSE 合同
curl -N -X POST http://127.0.0.1:4310/api/v1/agent/chat/stream \
  -H 'content-type: application/json' \
  -d '{"message":"请解释 Pi session 生命周期"}'

# 4. 配置 Kimi Code 后启用真实 Pi
cp .env.example .env
# 在 .env 中填写 KIMI_API_KEY
pnpm dev
```

## 下一步实验

- 将 `search_knowledge` 替换为 QMD/SQLite FTS5 consumer，保持 Pi 的工具决策不变；
- 阅读 `.pi/sessions/*.jsonl`，观察多轮上下文、树结构、compaction 和 custom entry；
- 给知识文档增加 `owner`、`effective_from`、`stale_after`，检索时过滤过期资源；
- 记录 prompt、route、sources、model 和 latency，建立 Agent 评测集。
