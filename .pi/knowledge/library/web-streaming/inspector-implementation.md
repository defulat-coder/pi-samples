---
type: concept
title: Inspector：实现视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。把 thinking、工具输入输出和错误以可读方式呈现
resource: .pi/knowledge/library/web-streaming/inspector-implementation.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, inspector, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: inspector
variant: implementation
---

# Inspector：流式会话中思考、工具与错误的可读化呈现

## 摘要与问题边界

Inspector 是 Web 流式交互里负责把 Agent 会话的原始事件流转换成人类可阅读界面的渲染组件。它的核心任务不是产生回答，而是忠实地呈现思考过程、工具调用输入输出以及运行期错误。边界必须清晰：Inspector 只处理已经进入浏览器的事件流，不接触模型鉴权、工具执行或会话路由；它不承担会话状态机职责，也不把事件写回服务器。凡是需要用户确认后才会出现的副作用，例如重新触发工具或修改提示词，应由宿主应用通过独立按钮完成，而不是 Inspector 内部隐式处理。

 Inspector 的输入是协议事件，输出是 DOM 或虚拟节点；因此任何设计都应当先明确输入契约、输出形态、错误分类、生命周期顺序和验证步骤，再开始编写 TypeScript 组件。

## 核心概念或数据模型

1. **EventEnvelope**。每一条从服务端到达浏览器的事件都应被包装为 `{ id, type, payload, timestamp, sessionId }`。`id` 必须全局唯一且单调递增，用于检测乱序和重复；`type` 是预定义枚举，禁止用自由字符串扩展。

2. **ContentDelta**。文本增量 `text_delta` 和思考增量 `thinking_delta` 共用同一结构 `{ mime, content, index }`。`mime` 决定渲染器是走 Markdown 还是纯文本；`index` 表示在最终消息中的位置偏移，支持多段穿插。

3. **ToolCallBlock**。一个工具调用块包含 `callId`、`toolName`、参数流 `argsChunks`、结果 `result` 和状态 `pending|success|error`。参数流在到达时可能是分片 JSON，需要本地累积并在 `toolcall_end` 时尝试解析。

4. **ErrorFrame**。错误事件 `{ code, message, recoverable, retryCount, source }` 必须区分可恢复与不可恢复。可恢复错误允许展示重试提示；不可恢复错误应锁住当前消息并高亮提示用户。

5. **RenderNode**。渲染节点树以 `blockId` 作为稳定 key，包含 `kind: delta|tool|error|lifecycle` 和 `collapsed` 折叠状态。节点顺序必须按事件时间戳而非到达时间排序，避免网络抖动导致阅读顺序错乱。

6. **LifecycleMarker**。生命周期事件 `session_start`、`message_start`、`message_end`、`error` 负责划定消息边界。`message_end` 出现后，该消息的所有增量应视为只读，后续同 `messageId` 事件按非法处理。

## 设计决策与取舍

**增量渲染与全量渲染**。选择增量渲染是因为 SSE 流量可能持续数秒甚至更长，全量重绘会导致 textarea 或 Markdown 解析器反复从头计算。取舍是：增量渲染必须在客户端维护累积状态，内存占用与消息长度成正比；超过 128 KB 的思考文本应自动折叠，仅保留前 4 KB 预览。

**工具块默认折叠**。默认把工具调用块折叠为单行摘要，减少视觉噪音；但当参数或结果包含错误码时，自动展开。例外：如果用户此前手动展开过同 `toolName` 的块，则保持用户选择。

**错误着色与可访问性**。错误文本不能仅靠红色传递语义，必须同时添加图标和 `role="alert"`。在深色主题下，错误背景应使用 `#4a1818` 而非 `#ff0000`，避免高对比度导致刺眼。

**时间戳精度**。内部使用服务端时间戳排序，UI 展示时只精确到秒。毫秒级差异在网络乱序场景下会让用户困惑，因此排序与展示解耦。

**本地状态与服务器状态分离**。Inspector 的折叠状态、滚动位置只保存在本地 `useState` 或 `Zustand`，不与服务器同步。这保证刷新页面后状态重置，避免跨会话污染；但代价是用户无法把折叠偏好持久化到账户。

## 可执行的实施流程

1. 用 Zod 定义 `EventEnvelope` 和全部子类型，并在入口函数对每条事件做 `safeParse`。失败事件进入 `ErrorFrame` 队列，而不是静默丢弃。

2. 创建 `InspectorStore`，使用不可变数据结构保存 `messages` 和 `blocks` 两个字典。`messages` 以 `messageId` 为 key，`blocks` 以 `blockId` 为 key。

3. 实现 `dispatchEvent` 函数，根据 `type` 路由到 `appendDelta`、`startToolCall`、`appendToolArgs`、`endToolCall`、`setError` 或 `markLifecycle`。

4. 编写 `appendDelta` 逻辑：找到或创建 `RenderNode`，按 `index` 排序，将 `content` 追加到缓冲区，触发重新渲染。

5. 编写 `toolCall` 系列逻辑：收到 `toolcall_start` 时创建 `ToolCallBlock` 节点；`toolcall_args` 分片追加；`toolcall_end` 时尝试 `JSON.parse`，解析失败则把 `status` 置为 `error` 并在节点内展示原始分片。

6. 编写错误渲染组件：根据 `recoverable` 决定展示“重试”或“停止”按钮；按钮回调由宿主应用注入，组件本身不调用。

7. 实现键盘与屏幕阅读器支持：每个工具块支持 `Enter` 展开/折叠，错误区域使用 `aria-live="polite"`，确保增量内容被朗读而不刷屏。

8. 编写单元测试：覆盖乱序事件、重复 `id`、非法 JSON 参数、超长思考文本折叠、消息结束后的非法追加，以及事件丢失 30 秒后的超时提示。

## 输入、处理、输出示例

以下示例展示本地文件知识库中一段事件流如何进入 Inspector。

输入事件：

    {
      "id": 101,
      "type": "thinking_delta",
      "payload": {
        "mime": "text/plain",
        "content": "用户要求读取 ",
        "index": 0
      },
      "timestamp": 1700000001,
      "sessionId": "sess-abc"
    }

处理：Inspector 先验证 `type` 是否在枚举中，`timestamp` 是否大于当前消息最大时间戳；然后创建 `RenderNode`，kind 为 `delta`，子类型为 `thinking`，把 `content` 追加到缓冲区。由于 `mime` 是 `text/plain`，渲染器走纯文本预格式化节点，并默认折叠。

输出 DOM：一个 `<details>` 元素，summary 显示“思考过程（1 秒前）”，内部 `<pre>` 包含“用户要求读取 …”。当后续 `text_delta` 事件到达时，同一节点内容追加，DOM 文本节点直接更新，而不是重建整个树。

## 性能、质量和可观测性指标

1. **首帧渲染延迟**：从第一个事件到达浏览器到首字符出现在屏幕上的时间。目标小于 50 毫秒，使用 `performance.now()` 在 `dispatchEvent` 和 React commit 之间测量。

2. **渲染帧率**：长文本增量推送时，主线程是否出现掉帧。使用 `requestAnimationFrame` 采样，目标每秒 60 帧，低于 30 帧连续 3 秒即报警。

3. **工具块解析错误率**：`toolcall_end` 中 `JSON.parse` 失败次数占总工具调用次数比例。目标小于 0.5%，错误原始分片必须保留供排查。

4. **可访问性违规数**：使用 axe-core 在每次构建后扫描 Inspector 树，目标零 `critical` 和 `serious` 问题。

5. **状态一致性**：对比 Store 中的 `blocks` 顺序与事件 `id` 单调序列，每 100 毫秒检查一次，乱序事件必须在 200 毫秒内被重排或报错。

## 失败模式、诊断证据与恢复动作

1. **乱序事件**。诊断证据：新事件 `id` 小于当前消息已处理最大 `id`，或 `timestamp` 早于前一条事件。恢复：缓存到乱序缓冲区，等待缺失事件 500 毫秒；超时后按到达顺序渲染，并在界面顶部提示“事件流曾乱序”。

2. **非法 JSON 工具参数**。诊断证据：`toolcall_end` 时 `JSON.parse` 抛出异常。恢复：把状态改为 `error`，展示原始参数文本和错误消息，提示用户检查工具协议版本。

3. **长时间无增量**。诊断证据：当前消息处于 `pending` 状态且 30 秒内未收到任何事件。恢复：展示“等待中…”，提供取消按钮，按钮动作由宿主注入；不自动关闭会话。

4. **重复事件 ID**。诊断证据：新事件 `id` 等于已处理事件。恢复：丢弃重复事件，记录 `warn` 到可观测日志，不刷新界面。

5. **渲染器崩溃**。诊断证据：React Error Boundary 捕获到异常。恢复：捕获异常后展示占位块，包含原始事件 `id` 和 `type`，并允许用户点击“查看原始 JSON”。

## 问答测试样例

1. **正向**：用户问“当前工具调用了什么？”回答必须列出最近消息中 `status` 为 `pending` 或 `success` 的 `toolName`，并给出对应 `callId`。

2. **正向**：用户问“为什么出现红色提示？”回答必须定位到 `ErrorFrame` 节点，复述 `code` 和 `message`，并说明是否 `recoverable`。

3. **边界**：用户问“第 5 条思考内容是什么？”如果该消息只有 3 条思考增量，回答应拒绝并说“没有第 5 条思考内容的证据”，而不是编造。

4. **边界**：用户问“工具参数里有没有 userId？”如果参数 JSON 中不存在该字段，回答应为“参数中未出现 userId”，而非“没有”。

5. **无证据拒答**：用户问“这个会话的 API key 是什么？”回答必须拒绝，因为 Inspector 输入事件流不包含凭据。

6. **无证据拒答**：用户问“模型下一步会做什么？”回答必须标记为未知，因为 Inspector 只呈现已发生事件，不预测未来。

## 维护、版本、来源和相邻主题关系

Inspector 的版本应与会话协议版本对齐，建议采用主版本号对应协议破坏性变更、次版本号对应新增事件类型的策略。来源包括 Agent 运行时的事件流、SSE 传输层和 JSONL 解析器。相邻主题中，SSE 负责传输，SessionManager 负责会话生命周期，API 负责鉴权与事件注入，Agent 运行时负责产生事件，而 Inspector 仅负责可读化呈现。更新协议时，必须先更新 Zod schema，再更新渲染组件，最后更新测试样例，三者必须同一次提交。

## 结论

事实是：Inspector 的输入是带 `id` 和 `type` 的事件流，输出是渲染节点，必须对事件做验证和排序，工具参数可能以分片形式到达，错误必须区分可恢复与不可恢复。推论是：增量渲染比全量渲染更适合长流式会话，但需要在客户端维护状态并设置折叠阈值。未知是：不同浏览器对 `aria-live` 增量的朗读频率存在差异，具体阈值需要以目标屏幕阅读器实测为准；在弱网环境下，事件乱序缓冲区的最优等待时间也取决于真实网络分布，目前 500 毫秒是项目级假设，需后续验证。
