# Pi Workbench 领域词汇

Pi Workbench 是一个用于学习和验证 Pi Coding Agent 的单产品实例 Web 工作台，不绑定具体业务领域。

## Agent

**Agent**：能够读取项目资源、根据证据组织回答并通过受控工具完成推理工作的运行时。
_避免_：把模型文本生成器、聊天气泡或自动化脚本直接称为 Agent。

**Session**：一次 Agent 运行上下文，包含资源加载、消息、工具调用和 turn 状态。
_避免_：把浏览器页面状态等同于 Pi session。

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

**Read-only tool**：当前唯一启用的 `read` 工具，只能读取项目资源。
_避免_：把模型生成的文字视为已经执行的外部动作。

**Agent Gateway**：API 层，负责请求校验、只读工具注入、Pi session 编排和结果返回；不在模型前做语义路由。
_避免_：让浏览器直接持有 provider key 或直接初始化 Pi SDK。

**Local fallback**：未启用模型或 provider 不可用时的确定性回答模式，用于零成本验证 Web 和证据链路。
_避免_：把 fallback 误标为真实模型回答。
