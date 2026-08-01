---
type: concept
title: Inspector：架构视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。把 thinking、工具输入输出和错误以可读方式呈现
resource: .pi/knowledge/library/web-streaming/inspector-architecture.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, inspector, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: inspector
variant: architecture
---

# 流式会话 Inspector：可观测事件渲染与边界隔离架构

## 摘要与问题边界

在 Web 流式交互场景中，Pi Agent 通过 SSE 向浏览器推送 `text_delta`、`thinking_delta`、`toolcall_*`、`tool_execution_*` 以及 `error` 等事件。Inspector 是负责把这些中间状态以人类可读、可折叠、可关联的形式呈现给终端用户的 Web 组件层。它的核心问题边界必须限定为：只消费服务端已规范化的事件，不替代服务端日志；只渲染与当前会话强相关的内容，不缓存或泄露其他会话的上下文；只负责展示形态，不主动修改 Agent 的调用策略或重试逻辑。Inspector 与 `apps/api` 的事件总线、`packages/pi-agent` 的会话生命周期、以及 `packages/contracts` 的 DTO 之间存在清晰的依赖方向：后三者是上游，Inspector 是下游只读消费者。

## 核心概念与数据模型

1. **会话事件流（SessionEventStream）**： Inspector 订阅的原始输入。它是一个按时间戳单调递增的 JSONL 流，每条记录包含 `eventId`、`sessionId`、`type`、`payload`、`timestamp` 和 `seq`。该流不保证业务语义上的因果顺序，只保证同一 TCP 连接内的到达顺序。

2. **渲染节点（RenderNode）**： Inspector 内部的最小渲染单元。每个节点由 `nodeId`、`parentNodeId`、`kind`（`text`、`thinking`、`tool_input`、`tool_output`、`error`、`lifecycle`）以及 `content` 组成。一个 `tool_execution` 可能生成 `tool_input` 和 `tool_output` 两个子节点，而 `thinking_delta` 会聚合到同一个 `thinking` 节点。

3. **折叠状态（CollapseState）**： 由客户端维护的 UI 状态，记录每个可折叠节点（如 thinking、工具卡片）的展开/收起状态。它属于纯本地 UX 状态，不应写入 URL 或持久化到后端，以避免会话间状态泄漏。

4. **工具卡片（ToolCard）**： 专门承载工具调用输入与输出的容器。其输入侧展示结构化参数，输出侧展示原始返回或格式化摘要。工具卡片必须支持语法高亮、JSON 折叠、以及关键字段的显式展示。

5. **错误帧（ErrorFrame）**： 当事件流中出现 `error` 或渲染管道自身抛出异常时生成的节点。错误帧包含 `category`（`transport`、`tool_execution`、`render`、`session`）、`message`、`recoverable` 以及可选的 `retryEventId`。

6. **时间线游标（TimelineCursor）**： 标记用户当前可见的事件索引。它用于实现虚拟滚动、断点重放以及“跳转到最新”功能。游标只指向已确认到达的事件，不预测未到达的事件。

## 设计决策与取舍

### 渲染与事件归一化分离
服务端 `apps/api` 负责把 Pi SDK 的事件转换为 `contracts` 中定义的 DTO。Inspector 只消费这些 DTO，不做 Provider 特定的语义解析。这样当模型运行时切换时，Inspector 无需改动。代价是：某些 Provider 特有的元数据（如 thinking 的 token 消耗）如果不被服务端规范化，Inspector 就看不到。

### 明文展示与隐私边界
工具输入输出默认以明文展示，但 `contracts` 必须提供一个 `sensitivity` 标记。对于标记为 `credential` 或 `pii` 的字段，Inspector 只显示字段名和哈希摘要，点击后通过一次性授权展开。这保留了可调试性，同时避免页面截图或录屏时的信息泄露。

### 状态存储与渲染状态解耦
 Inspector 的事件数据来自会话缓存或 SSE 重放，而折叠状态、时间线游标、主题偏好保存在 `sessionStorage` 中。这样刷新页面不会丢失会话内容，但关闭标签页后本地 UI 状态被清除，符合会话隔离原则。

### 虚拟滚动与全量渲染
当工具输出或日志流超过 5 万字符时，Inspector 从全量渲染切换到虚拟滚动。该阈值可根据视口高度和行平均长度动态计算。取舍：虚拟滚动会降低文本搜索的即时性，因此需要配合一个异步 Worker 做离屏索引，而不是在 DOM 内全量搜索。

### 错误事件与渲染错误统一处理
无论是服务端返回的 `error` 事件，还是客户端渲染 JSON 失败抛出的异常，都统一进入错误帧。这要求渲染层必须捕获异常并把异常信息包装为与事件流一致的结构，避免一个坏事件导致整个 Inspector 崩溃。

## 可执行的实施流程

1. 在 `packages/contracts` 中定义 `InspectorEvent`、`ToolCardInput`、`ToolCardOutput`、`ErrorFrame` 和 `RenderNode` 的 TypeScript 类型，并确保与现有 SSE DTO 兼容。
2. 在 `apps/api` 的事件转换层中，把 Pi SDK 的 `thinking_delta` 和 `tool_execution_*` 映射到 `InspectorEvent` 的子类型，统一注入 `eventId` 和 `seq`。
3. 在 `apps/web` 中新建 `Inspector` 组件目录，实现 `EventStream` 订阅器、节点归一化器、折叠状态管理器、以及虚拟滚动容器。
4. 实现 `ThinkingNode` 组件：累积 delta，支持高亮、折叠、以及“仅展示最终结论”模式。
5. 实现 `ToolCard` 组件：输入侧展示参数表格，输出侧支持 JSON/文本/表格三种渲染形态，并接入敏感度标记。
6. 实现 `ErrorFrame` 组件：区分可恢复与不可恢复错误，可恢复错误提供“重连并重放从某 eventId 开始”的按钮。
7. 引入 Worker 建立离屏索引，用于在虚拟滚动模式下进行内容搜索。
8. 编写集成测试：用 mock SSE 推送事件流，验证节点聚合、折叠状态、错误恢复、以及虚拟滚动阈值切换。
9. 添加 `pnpm test` 中的 E2E 场景：真实触发一次工具调用，确认 Inspector 正确展示 tool_input 和 tool_output。
10. 在 `docs/` 下新增 ADR，记录 Inspector 与 api/web 的边界、渲染阈值、错误处理策略。

## 代码示例

以下示例展示 Inspector 如何处理一个工具调用事件对。输入为服务端的 `tool_execution_start` 与 `tool_execution_end` 两个事件：

```json
{
  "eventId": "evt-42",
  "sessionId": "sess-abc",
  "type": "tool_execution_start",
  "timestamp": "2025-06-01T12:00:01.000Z",
  "seq": 101,
  "payload": {
    "toolName": "search_knowledge",
    "arguments": { "query": "Pi Inspector 渲染边界", "topK": 3 }
  }
}
{
  "eventId": "evt-43",
  "sessionId": "sess-abc",
  "type": "tool_execution_end",
  "timestamp": "2025-06-01T12:00:01.800Z",
  "seq": 102,
  "payload": {
    "toolName": "search_knowledge",
    "status": "success",
    "output": { "results": [{ "id": "doc-1", "score": 0.92 }] }
  }
}
```

处理阶段：Inspector 的归一化器先按 `toolName` 和 `eventId` 关联起止事件，生成一个 `RenderNode` 序列，其中 `tool_input` 和 `tool_output` 共享同一个 `parentNodeId`（如 `toolcard-search_knowledge-42`）。输出阶段：DOM 渲染为一个可折叠工具卡片，输入侧显示参数表格，输出侧显示 JSON 结果。由于 `query` 字段敏感度标记为 `normal`，直接显示原文；`apiKey` 若存在则显示脱敏摘要。

## 性能、质量与可观测性指标

1. **首帧渲染时间（TTFI）**：从 SSE 首条事件到达至 Inspector 首次完成 DOM 渲染的时间。目标值在 100 毫秒内，通过浏览器 Performance API 测量。
2. **事件聚合正确率**：对于一次工具调用，start 和 end 事件被正确聚合为一张卡片的百分比。用 mock 测试断言 `parentNodeId` 一致性和子节点数量。
3. **虚拟滚动掉帧率**：在输出超过阈值时，滚动帧率保持在 50 fps 以上。使用 `requestAnimationFrame` 统计帧间隔。
4. **错误帧误报率**：将真实服务端错误与客户端渲染异常混合后，统计错误帧被正确分类为 `recoverable` 或 `non_recoverable` 的比例。
5. **会话隔离违规数**：通过审计日志检查 Inspector 是否渲染了非当前 `sessionId` 的事件。期望为 0，检测方式是在事件到达时校验 `sessionId` 与 URL 中的会话参数。

## 失败模式、诊断证据与恢复动作

1. **SSE 断连后事件丢失**：证据是 `seq` 出现跳号或时间戳不连续。恢复动作：前端向 API 请求 `lastEventId` 之后的事件重放，API 从会话缓存中按 `seq` 重发。
2. **工具输出 JSON 解析失败**：证据是 `tool_execution_end` 的 `output` 不是合法 JSON，渲染层抛出 `SyntaxError`。恢复动作：降级为原始文本展示，并标记错误帧为 `render`，提示“输出无法结构化，已按原文显示”。
3. **Thinking 节点无限增长**：证据是 thinking 节点字符数超过阈值（如 1 万字符）且仍在接收 delta。恢复动作：自动截断并显示“后续内容已折叠，点击展开”，同时停止高频 DOM 重排。
4. **事件乱序到达**：证据是 `seq` 先大后小或 `tool_execution_end` 先于 `tool_execution_start`。恢复动作：本地缓冲并按 `seq` 排序，直到缺失的 `seq` 到达或超时后标记为 orphan。
5. **渲染内存泄漏**：证据是切换会话后 DOM 节点数未下降，或 `sessionStorage` 体积持续增长。恢复动作：在会话切换时调用 `dispose` 清理订阅、Worker 和缓存，并限制 `sessionStorage` 中保留的最大事件数。

## 问答测试样例

1. **正向**：Inspector 应如何展示一次成功的 `search_knowledge` 工具调用？答：生成一张工具卡片，输入侧展示 `query` 和 `topK`，输出侧展示命中结果列表。
2. **边界**：当 `tool_execution_end` 缺失时，Inspector 应做什么？答：保留 `tool_input` 节点，并在 5 秒超时后追加一个状态为 `timeout` 的占位输出节点。
3. **边界**：`thinking_delta` 被服务端标记为空字符串时是否渲染？答：不渲染新节点，只更新游标，避免视觉抖动。
4. **无证据拒答**：如果事件流中没有 `sensitivity` 标记，Inspector 能否推断字段是否敏感？答：不能，必须按 `normal` 处理，服务端规范化是必要条件。
5. **无证据拒答**：Inspector 是否能直接调用 Pi SDK 重试工具？答：不能，它无权访问 Provider 凭证或 Agent 会话控制接口。
6. **正向**：如何验证错误帧的可恢复性？答：检查 `recoverable` 字段为 `true` 且存在 `retryEventId`，点击后触发重放并观察 `seq` 是否从目标位置重新递增。

## 维护、版本、来源与相邻主题关系

Inspector 的版本号与 `apps/web` 的 UI 版本绑定，但与 `packages/contracts` 的 DTO 版本保持前向兼容。当 `contracts` 中的事件类型新增时，Inspector 必须显式注册对应的渲染器，未识别的类型应渲染为“未支持事件”占位，而不是静默丢弃。来源方面，所有事件语义来自 `packages/pi-agent` 的会话生命周期和 `apps/api` 的 SSE 规范化。相邻主题包括：SSE 传输协议（上游，负责推送可靠性）、会话管理器（上游，负责身份与会话隔离）、Prompt 模板（无关，不进入 Inspector 渲染范围）、以及 Provider 运行时（上游，产生 thinking 和工具事件）。文档维护应在 `docs/adr/0002-web-inspector-rendering-boundary.md` 中记录每一次边界变更。

## 结论

**事实**：Inspector 是 `apps/web` 中负责只读渲染会话事件的组件；它必须消费 `packages/contracts` 定义的规范化事件；工具输入输出和错误需要以结构化卡片呈现。

**推论**：如果服务端能够提前对 thinking 和工具事件做统一规范化，那么 Inspector 可以在不依赖 Provider 细节的情况下长期稳定；虚拟滚动和离屏索引是应对长工具输出的必要工程手段。

**未知**：不同 Provider 的 thinking 事件格式差异、错误事件可恢复性的判定规则、以及大规模并发会话下的浏览器内存上限，仍需在真实集成环境中通过负载测试和 A/B 观测进一步验证。
