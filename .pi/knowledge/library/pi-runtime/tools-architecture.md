---
type: concept
title: 工具执行：架构视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。Pi 如何根据工具契约选择工具，并把参数与执行结果纳入回合
resource: .pi/knowledge/library/pi-runtime/tools-architecture.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, tools, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: tools
variant: architecture
---

# Pi Agent 运行时工具执行：契约、调用与回合集成

## 摘要与问题边界

Pi Agent 的工具执行不是模型之外的副作用，而是会话回合内的完整往返：模型决定调用、运行时解析契约、边界执行函数、再把结果以结构化形式重新注入当前回合。本文的边界限定在 `packages/pi-agent` 的运行时层与 `apps/api` 的传输/身份层之间，不涉及 Web UI 的渲染细节，也不讨论 LLM 训练或模型选择。核心问题是：当模型输出一个 `toolcall_*` 事件时，运行时如何仅凭工具契约完成路由、参数校验与结果回写，同时保持可替换接口、只读边界和可观测性。

## 核心概念与数据模型

1. **ToolContract**：工具的唯一身份不是名称，而是 `{name, version, description, inputSchema, outputSchema, capability, idempotent}` 构成的契约。运行时只承认注册过的契约，不承认模型临时发明的别名。
2. **ToolRegistry**：可替换的契约存储接口， keyed by 限定名（如 `read_file@v1`）。`AgentSession` 初始化时注入，运行时不直接访问文件系统或网络来发现工具。
3. **ToolInvocation**：一次具体调用的事件对象，包含 `turnId`、`messageId`、`toolRef`、`rawArgs`、`correlationToken` 和发出时间戳。它是可序列化的审计单元。
4. **ArgumentBinder**：负责把模型输出的原始参数绑定到契约的 JSON Schema。绑定只校验与类型转换，不补全默认值，更不“猜测”缺失字段。
5. **ToolExecutor**：由宿主实现的可调用对象，接收已校验参数和能力令牌，返回 `ExecutionResult`。executor 本身不知道 SSE 或回合状态。
6. **ExecutionResult**：`{content, details, finishReason, errorCode?, labels}`。`content` 给模型看，`details` 给调用者和可观测性看；两者共同进入回合上下文。
7. **TurnIntegrator**：把 `ExecutionResult` 转成标准化的消息/内容块，追加到当前 turn，更新 token 预算，并保证同一 turn 内结果顺序与调用顺序一致。

## 设计决策与取舍

### 契约优先于名称匹配
模型只输出工具名称和参数，运行时必须先查 `ToolRegistry` 中的契约，再决定是否存在、是否允许执行。这样可以支持同名不同版本的平滑替换，也防止模型通过名称相近产生“影子调用”。代价是契约必须显式注册，动态发现能力被刻意关闭。

### 参数校验位于运行时与执行者之间
`packages/pi-agent` 在调用 `ToolExecutor` 前完成 JSON Schema 校验；`apps/api` 不重复校验业务语义，只负责身份与能力令牌注入。这样，executor 的接口输入是“已受信任的契约内参数”，而不是任意用户输入。代价是任何 schema 更新都必须同步到运行时。

### 结果不直接修改模型内部状态
`ToolExecutor` 返回事实，`TurnIntegrator` 把事实包装成新的内容块；当前 turn 不会自动让模型重新生成。模型要到下一次生成步骤才能看到结果。这避免了同一 turn 内的自举循环，也允许前端把中间结果直接展示给用户。

### 同步与异步执行分层
简单只读工具（如 `search_knowledge`、`read`）在同一请求内同步完成；可能阻塞或需要用户确认的工具，通过 `tool_execution_start` / `tool_execution_update` / `tool_execution_end` 事件异步推进。异步路径使用 job token 关联，不占用会话主线程。

### 错误作为正常回合内容而非异常
执行失败、超时、权限不足全部编码为 `ExecutionResult.errorCode`，随 SSE 事件流出；会话不因此崩溃。这样 Agent 可以在后续步骤决定是否重试、换工具或向用户说明。代价是前端必须能渲染“带错误码的结果块”。

## 可执行的实施流程

1. 在 `packages/pi-agent` 中为每个工具调用 `defineTool()`，显式声明输入/输出 schema、能力要求和幂等性。
2. 构造 `AgentSession` 时，把实现好的 `ToolRegistry` 与 `ToolExecutor` 注入运行时。
3. `apps/api` 收到 Web 请求后，解析消息并绑定 session identity 与 capability token，不解释消息语义。
4. 在调用 `session.prompt()` 之前完成事件订阅：`message_update`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`。
5. 模型输出 `toolcall_*` 增量时，运行时按限定名查询 `ToolRegistry`；若未命中，立即生成 `tool_not_found` 结果。
6. `ArgumentBinder` 根据 `inputSchema` 校验参数；失败则生成 `schema_violation` 结果，不进入 executor。
7. 校验通过后，运行时把 capability token 与参数一起交给 `ToolExecutor`；执行在受控作用域内完成。
8. `TurnIntegrator` 接收 `ExecutionResult`，生成内容块追加到当前 turn，刷新 token 计数，并关闭对应可观测性 span。
9. 通过 SSE 发送标准化事件，前端据此更新 Inspector；一次工具调用往返结束。

## 示例：本地文件知识库工具的调用与回写

```json
{
  "contract": {
    "name": "search_knowledge",
    "version": "v1",
    "description": "检索 .pi/knowledge 中的 Markdown 片段",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": { "type": "string" },
        "limit": { "type": "integer", "maximum": 10 }
      },
      "required": ["query"]
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "matches": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    },
    "capability": "knowledge:read"
  },
  "invocation": {
    "turnId": "turn_42",
    "toolRef": "search_knowledge@v1",
    "rawArgs": { "query": "session subscription order", "limit": 5 }
  },
  "result": {
    "content": { "matches": ["订阅必须在 prompt 之前"] },
    "details": { "source": ".pi/knowledge", "hits": 1 },
    "finishReason": "done"
  }
}
```

输入是模型发出的 `toolcall_*` 事件与原始参数；处理时，运行时先校验 `query` 存在且 `limit` 不超过 10，再检查 capability token 是否包含 `knowledge:read`，然后在 `.pi/knowledge` 中检索；输出是追加到当前 turn 的结构化结果块，并通过 SSE 送到前端 Inspector。

## 性能、质量和可观测性指标

1. **工具调用端到端延迟 P99**：从 `tool_execution_start` 到 `tool_execution_end` 的 span 时长，按 capability 分组。
2. **Schema 校验失败率**：`schema_violation` 次数除以总调用次数，高于阈值说明契约与模型提示不一致。
3. **参数幻觉率**：原始参数中出现但不在 `inputSchema.properties` 中的 key 占比。
4. **执行成功率**：`finishReason === "done"` 的调用比例，按工具名聚合。
5. **结果序列化错误率**：`ExecutionResult` 无法通过 `outputSchema` 校验的次数。
6. **工具结果导致的回合 token 增量**：结果块加入前后 turn 上下文 token 数之差，用于成本审计。

## 失败模式、诊断证据与恢复动作

1. **契约漂移**：模型调用旧版本名称（如 `read@v1` 已升级为 `read@v2`）。证据是 `tool_not_found` 但日志中显示相近名称存在。恢复：限定名必须包含版本，运行时拒绝模糊匹配，强制同步更新 prompt 模板。
2. **参数越界**：模型传入未声明字段或类型错误。证据是校验错误列出具体路径。恢复：返回 `schema_violation`，不自动修正，由 Agent 在下一轮重新生成。
3. **执行超时**：`ToolExecutor` 在 deadline 内未返回。证据是 span 只有 `tool_execution_start` 没有 `tool_execution_end`。恢复：取消任务并发出 `timeout` 结果；对非幂等工具不自动重试。
4. **权限逃逸**：executor 尝试访问未授权资源。证据是 capability token 中缺少对应 scope。恢复：在 executor 入口 gate 拒绝并记录审计事件；会话继续，但不再重试同一工具。
5. **结果反序列化失败**：executor 返回了非 JSON 或不符合输出 schema 的数据。证据是 `outputSchema` 校验错误。恢复：把原始输出包装为 `raw_error` 内容块，附带错误码，不中断会话。
6. **幻觉调用不存在工具**：模型请求 registry 中完全没有的工具。证据是名称完全无匹配。恢复：返回 `tool_not_found`，前端可提示用户该能力不可用。

## 问答测试样例

1. **正向**：Pi 运行时根据什么选择工具？答：根据 `ToolRegistry` 中注册的 `ToolContract`，按限定名匹配，而不是对消息做关键词分类。
2. **边界**：同一工具有两个版本怎么办？答：`ToolRegistry` 要求限定名唯一；模型必须显式使用带版本名称，运行时拒绝模糊版本。
3. **边界**：如果模型传了契约未声明的额外参数，会怎样？答：`ArgumentBinder` 返回 `schema_violation`，不会进入 `ToolExecutor`。
4. **正向**：执行结果如何进入回合？答：`TurnIntegrator` 把 `ExecutionResult` 转成内容块追加到当前 turn，模型在下一次生成时可见。
5. **无证据拒答**：Pi 内部是否允许任意工具写文件？答：本文档不假设通用写能力；项目契约中仅显式暴露只读工具，具体写能力需查 `.pi/skills` 与 capability token。
6. **边界**：Web 浏览器能否直接调用 `search_knowledge`？答：不能。浏览器只消费 `apps/api` 的 SSE，不接触 Pi SDK 或 provider key。
7. **无证据拒答**：未来是否会支持多工具并行？答：当前设计按顺序追加结果块；并行调度属于未在项目中验证的实现细节，需参考后续 ADR。

## 维护、版本、来源与相邻主题的关系

工具契约的版本通过限定名体现，升级时必须在 `packages/pi-agent` 注册新契约、在 `.pi/prompts` 同步示例、并在 `apps/api` 校验 capability token。`.pi/skills` 由 Skills CLI 管理，不应手工修改第三方 skill 文件。主要来源包括：`AGENTS.md` 中的 Pi 集成契约、`packages/pi-agent` 的 SDK 调用约定、以及 `@earendil-works/pi-coding-agent` 的 `defineTool()` 与 `AgentSession` API。相邻主题包括：会话生命周期管理、SSE/JSON 事件归一化、capability 模型、沙箱与项目信任边界。工具注册是静态入口，工具执行是动态运行时，二者通过 `ToolRegistry` 解耦。

## 结论

**事实**：本项目的 Pi 集成契约要求通过 `defineTool()` 注册工具，使用 `AgentSession` 与 `SessionManager`，并在 `apps/api` 中完成身份与能力注入，Web 端不接触 Pi SDK。

**推论**：把工具路由建立在 `ToolContract` 而非名称字符串上，可以在不改动模型调用格式的情况下替换实现；将参数校验置于 executor 之前、把错误编码为结果块，能够使运行时保持边界清晰且具备可观测性。

**未知**：异步多工具并行调度、跨会话工具状态持久化、以及长耗时工具的取消语义，目前未在现有代码路径中验证，需要在后续 ADR 中根据实际负载补充。
