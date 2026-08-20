# Pi Workbench 领域词汇

Pi Workbench 是一个用于学习和验证 Pi Coding Agent 的单产品实例 Web 工作台，不绑定具体业务领域。

## 数字人与运行时

**Digital Human（数字人）**：由项目档案定义的长期角色，包含姓名、职业、人设、沟通风格和宿主能力档案。
_避免_：Agent、机器人、聊天配置

**Capability Profile（能力档案）**：宿主维护的权限集合，决定数字人可加载的 Skill、工具和数据域；数字人档案只能引用，不能扩展它。
_避免_：工具清单、角色权限 JSON

**Pi AgentSession**：承载一个数字人完成对话的运行时实例，包含资源加载、消息、工具调用和 turn 状态。
_避免_：数字人、浏览器会话

**Session**：一个且仅属于一个数字人的持久对话上下文。
_避免_：跨数字人聊天室、浏览器页面状态

**Turn**：用户提交一次 prompt 到 Agent 结束本轮处理的生命周期。
_避免_：把每个 text delta 当成独立 turn。

**Evidence**：由 Pi 实际调用只读工具得到的文件片段和来源引用。
_避免_：把模型没有来源的猜测当成证据。

## 项目资源

**Skill**：描述 Agent 行为、路由和安全边界的项目 Markdown 文件。
_避免_：把 Skill 当作任意代码插件或权限提升机制。

**Prompt**：可复用的用户/系统对话模板，用于保持回答格式和安全约束。
_避免_：把 Prompt 当作运行时工具。

**Knowledge**：`.pi/knowledge` 下带 OKF-compatible frontmatter 的 Markdown 概念文件。
_避免_：把知识文件等同于向量数据库或隐藏系统指令。

## 工具与验证

**Read-only tool**：由能力档案授予的只读宿主能力，例如 `read`、`search_knowledge` 或 `query_business_data`。
_避免_：把数字人档案或模型生成的文字视为工具授权。

**Agent Gateway**：API 层，负责请求校验、只读工具注入、Pi session 编排和结果返回；不在模型前做语义路由。
_避免_：让浏览器直接持有 provider key 或直接初始化 Pi SDK。
