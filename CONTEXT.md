# Pi 工作台 领域词汇

Pi 工作台是一个用于学习和验证 Pi Coding Agent 的单产品实例 Web 工作台，不绑定具体业务领域。

## Agent 与运行时

**Agent**：由 `.pi/agents/` 下的 Markdown 文件定义的长期角色，包含名称、mark、简介、建议问题和系统提示词正文。当前为纯聊天形态，无工具。
_避免_：数字人、机器人、聊天配置

**Pi AgentSession**：承载一个 Agent 完成对话的运行时实例，包含资源加载、消息和 turn 状态。
_避免_：Agent 本身、浏览器会话

**Session**：一个且仅属于一个 Agent 的持久对话上下文，通过 JSONL custom entry `pi-workbench.agent` 绑定。
_避免_：跨 Agent 聊天室、浏览器页面状态

**Turn**：用户提交一次 prompt 到 Agent 结束本轮处理的生命周期。
_避免_：把每个 text delta 当成独立 turn。

## 项目资源

**Skill**：描述 Agent 行为、路由和安全边界的项目 Markdown 文件（`.pi/skills/`）。
_避免_：把 Skill 当作任意代码插件或权限提升机制。

**Prompt**：可复用的对话模板（`.pi/prompts/`），在 Web 输入框中以 `/name` 选择填入。
_避免_：把 Prompt 当作运行时工具。

## 网关

**Agent Gateway**：API 层，负责请求校验、Agent 身份、Session 归属、模型白名单校验和 SSE 事件转发；不在模型前做语义路由。
_避免_：让浏览器直接持有 provider key 或直接初始化 Pi SDK。
