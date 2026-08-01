---
type: concept
title: 可访问性：架构视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。让流式文本、状态和事件在键盘与屏幕阅读器中可理解
resource: .pi/knowledge/library/web-streaming/accessibility-architecture.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, accessibility, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: accessibility
variant: architecture
---

# 流式交互的可访问性：键盘与屏幕阅读器中的事件语义架构

## 摘要与问题边界

流式文本、状态和事件的可访问性不是 UI 层面的“加标签”问题，而是协议层到呈现层的责任划分问题。核心矛盾在于：大模型或服务端产生的事件是时间序列，而屏幕阅读器和键盘操作依赖的是离散、可导航、有语义的结构。若把流式字节直接注入 DOM，辅助技术会接收到杂乱无章的朗读指令；若过度合并后再渲染，又会牺牲实时感。因此，必须先在事件语义、渲染中间层、焦点管理和朗读调度之间建立可替换接口，再选择具体实现。

本文的边界覆盖：浏览器内 Web 应用通过 SSE 或 WebSocket 接收流式增量，并需要被键盘和屏幕阅读器（NVDA、JAWS、VoiceOver）理解的场景。不讨论原生客户端、不讨论语音输出硬件本身、不讨论服务端模型生成策略。

## 核心概念与数据模型

1. **语义事件单元（Semantic Event Unit, SEU）**
   SEU 是流式协议中的最小可理解原子，包含 `role`（如 `text_delta`、`tool_execution_start`、`thinking_delta`、`error`）、`id`（同一逻辑块内稳定）、`seq`（全局递增序列号）、`content`（可携带纯文本或结构化摘要）、`announce_policy`（`polite`、`assertive`、`off`）。浏览器不应对服务端格式做语义假设，而应通过适配器映射为 SEU。

2. **可导航块（Navigable Chunk, NC）**
   NC 是面向辅助技术的 DOM 或虚拟结构单元，对应一个 SEU 或若干 SEU 的聚合。每个 NC 必须有可聚焦入口、可朗读标签和稳定的 `aria-label` 来源。NC 与 SEU 的映射不必是 1:1，允许聚合，但不允许跨逻辑块拆分。

3. **朗读队列（Announcement Queue, AQ）**
   屏幕阅读器不能逐字符朗读。AQ 将同一 NC 内的短时文本增量合并，并在满足阈值（时间 500 ms 或字符 120 个）或遇到语义边界（如 tool 结束、换段）时触发一次 `aria-live` 更新。AQ 是渲染层与辅助技术之间的缓冲层。

4. **焦点锚点（Focus Anchor, FA）**
   流式区域必须有一个可键盘到达的入口（`tabindex="0"`），并且每次新 NC 生成时，可选地移动焦点或仅更新朗读。FA 决定用户是否能主动回溯历史、暂停输出或跳转到特定块。

5. **状态机（Stream State Machine, SSM）**
   定义 `connecting`、`receiving`、`buffering`、`speaking`、`idle`、`error` 六个状态。状态转换本身必须对辅助技术可感知，即每个状态变化产生一个 `assertive` 或 `polite` 的 SEU。

6. **持久化摘要（Persisted Summary, PS）**
   当流结束或用户离开页面后，需要保留一份按 NC 组织的摘要，用于会话恢复、历史检索和审计。PS 不是原始日志，而是经过语义压缩后的结构。

7. **能力协商（Capability Negotiation, CN）**
   在会话初始化时，客户端应声明自身支持的辅助技术特性（如是否支持 `aria-live="assertive"`、是否偏好键盘快捷键），服务端或本地策略据此调整事件粒度与聚合策略。

## 设计决策与取舍

### 增量渲染还是聚合后渲染
增量渲染能保留实时感，但会让屏幕阅读器频繁打断。聚合后渲染更稳定，但会引入可感知的延迟。建议对 `text_delta` 采用 AQ 聚合，对 `tool_execution_start/end`、`error` 等离散事件直接单独发布。取舍依据：事件本身的语义是否离散。

### 谁来宣布状态变化
服务端发送的是底层事件，浏览器负责将其转译为状态并宣布。不要把 `aria-live` 区域直接绑定到 SSE 消息；中间必须经过 SSM 归一化，否则“重连”或“重试”等内部状态将无法被用户理解。

### 焦点是否跟随新内容
默认不自动抢焦点，因为会打断用户正在阅读的历史内容。仅在用户明确选择“跟随最新输出”模式时，才将 FA 移入最新 NC。该模式必须通过键盘可切换，且状态本身要可朗读。

### 工具调用与中间思考的可见度
`thinking_delta` 是模型内部推理，默认不向最终用户暴露；但对需要可解释性的场景，应提供“显示推理过程”开关。工具调用结果必须比推理过程更优先朗读，因为工具事件通常是可操作的。

### 历史导航的 DOM 结构
用扁平列表还是嵌套树？扁平列表便于线性朗读，嵌套树便于表达因果关系。推荐用扁平列表作为默认，同时在每个 NC 上附加 `data-parent-id` 以支持可选的树状导航。取舍：可预测性优先于表达力。

### 回退策略
当 `aria-live` 不被支持或用户关闭屏幕阅读器时，系统必须退回到视觉指示和键盘通知。能力降级路径必须是可测试的，而不是“未检测到就关闭”。

## 可执行的实施流程

1. 定义 SEU 的 JSON Schema 或 TypeScript 类型，明确 `role`、`id`、`seq`、`content`、`announce_policy` 的取值范围和校验规则。
2. 在 `packages/contracts` 中建立 `StreamAccessibilityEvent` DTO，与 `apps/api` 的 SSE 响应格式解耦，确保前端不依赖服务端原始事件形状。
3. 实现 `EventAdapter`，将服务端协议（如 Pi JSONL、OpenAI SSE）统一转换为 SEU，并注入 `seq` 以保证顺序。
4. 实现 `AnnouncementQueue`，按时间阈值、字符阈值、语义边界三条规则合并 `text_delta`，并输出为 `aria-live` 可消费的文本片段。
5. 在 `apps/web` 中建立 `StreamRegion` 组件，包含 FA、NC 容器、状态条和朗读 polite 区域。NC 使用 `article` 或 `section` 包裹，每个块设置 `aria-label` 为“第 N 段，来自工具/助手/错误”。
6. 定义键盘快捷键：Ctrl+Shift+Down 跳到下一块，Ctrl+Shift+Up 跳到上一块，Ctrl+Shift+Space 暂停/继续朗读，Escape 停止流并聚焦状态条。
7. 建立 SSM，监听 SEU 并驱动状态条文本。状态转换必须触发一次 `assertive` 或 `polite` 的宣布。
8. 编写 `AccessibilityMonitor`，在测试环境中模拟 `aria-live` 事件、焦点移动和朗读文本，捕获断言。
9. 与真实屏幕阅读器（NVDA 在 Windows、VoiceOver 在 macOS）做手工走查，验证“流开始—输出—工具调用—错误—流结束”全链路。
10. 将 NC 聚合后的 PS 写入会话存储，支持刷新后恢复导航位置。
11. 在 CI 中运行无头测试：检查 NC 数量、每个 NC 是否有 `aria-label`、状态转换是否产生对应文本。
12. 每次版本迭代前，重跑失败模式清单，并更新能力协商默认值。

## 示例：Pi 流事件到可访问导航块的映射

```json
{
  "input": {
    "source_events": [
      { "type": "text_delta", "seq": 1, "delta": "正在" },
      { "type": "text_delta", "seq": 2, "delta": "分析" },
      { "type": "text_delta", "seq": 3, "delta": "文件。" },
      { "type": "tool_execution_start", "seq": 4, "tool": "search_knowledge", "input": { "query": "可访问性" } },
      { "type": "text_delta", "seq": 5, "delta": "找到" },
      { "type": "text_delta", "seq": 6, "delta": "3 条结果。" },
      { "type": "tool_execution_end", "seq": 7, "tool": "search_knowledge", "success": true }
    ]
  },
  "processing": {
    "adapter": "将 text_delta 1-3 合并为 NC-1，announce_policy=polite；将 tool_execution_start 映射为 NC-2，announce_policy=assertive；将 text_delta 5-6 合并为 NC-3；tool_execution_end 扩展 NC-2 并触发完成朗读。"
  },
  "output": {
    "navigable_chunks": [
      {
        "id": "NC-1",
        "aria_label": "助手回答第 1 段",
        "text": "正在分析文件。",
        "role": "assistant_text",
        "announce": "polite"
      },
      {
        "id": "NC-2",
        "aria_label": "工具 search_knowledge 已执行",
        "text": "正在调用 search_knowledge 查询“可访问性”。3 条结果已返回。",
        "role": "tool",
        "announce": "assertive"
      },
      {
        "id": "NC-3",
        "aria_label": "助手回答第 2 段",
        "text": "找到 3 条结果。",
        "role": "assistant_text",
        "announce": "polite"
      }
    ]
  }
}
```

输入是服务端原始增量事件；处理阶段由 `EventAdapter` 和 `AnnouncementQueue` 完成；输出是面向辅助技术的可导航块结构，可直接渲染到 `StreamRegion` 中。

## 性能、质量和可观测性指标

1. **朗读延迟（Announcement Latency）**
   从 SEU 产生到 `aria-live` 区域更新 DOM 的耗时。目标 P95 小于 700 ms，在字符阈值达到 120 或时间达到 500 ms 时触发。测量方式：在测试环境中注入 `performance.now()` 标记。

2. **焦点稳定性（Focus Stability）**
   流输出过程中，用户焦点被意外移动的次数。目标为 0 次，除非用户启用“跟随模式”。测量方式：监听 `focusin` 事件并检查事件来源是否来自 `StreamRegion` 的自动聚焦逻辑。

3. **NC 语义覆盖率（Chunk Semantic Coverage）**
   每个 NC 都有非空 `aria-label`、非空 `role` 和可朗读文本。目标 100%。测量方式：DOM 遍历 + 自动化断言。

4. **状态宣布完整率（State Announcement Completeness）**
   SSM 中定义的所有状态转换至少产生一次对应朗读。目标 100%。测量方式：在 `AccessibilityMonitor` 中订阅状态变化并断言输出文本。

5. **键盘可达性（Keyboard Reachability）**
   流式区域内所有可交互元素（暂停、跳转、复制、切换显示推理）均可通过 Tab 或快捷键到达。测量方式：Tab 顺序走查 + 无头测试。

6. **降级路径触发率（Fallback Trigger Rate）**
   当 `aria-live` 不被支持时，系统成功切换到视觉通知的会话比例。目标 100% 可检测降级。测量方式：在能力协商中注入 `prefers-reduced-motion` 或模拟不支持环境。

## 失败模式、诊断证据与恢复动作

1. **流输出导致屏幕阅读器持续中断**
   诊断证据：AQ 中 `text_delta` 被逐字发送，未触发聚合。恢复动作：检查 `AnnouncementQueue` 的时间阈值和字符阈值配置；确保同一 NC 内的增量被合并。

2. **新内容生成时焦点被抢走**
   诊断证据：`focusin` 事件来源显示 `StreamRegion` 在每次 NC 渲染后调用 `focus()`。恢复动作：移除自动聚焦；仅在“跟随模式”开启且用户未主动操作时移动焦点。

3. **工具调用结果未被朗读**
   诊断证据：`tool_execution_start` 的 `announce_policy` 被错误映射为 `off` 或 `polite`，且被后续文本覆盖。恢复动作：将工具事件统一设为 `assertive`；在 AQ 中赋予工具事件更高优先级。

4. **刷新后丢失朗读历史位置**
   诊断证据：PS 未保存或恢复时未重建 NC 序列。恢复动作：将 PS 持久化到会话存储，恢复时按 NC 重建 DOM 并将 FA 恢复到上次浏览位置。

5. **键盘快捷键与浏览器默认快捷键冲突**
   诊断证据：用户按下 Ctrl+Shift+Space 时触发浏览器缩放而非暂停。恢复动作：在事件监听中调用 `preventDefault()`，并提供可配置快捷键表。

6. **屏幕阅读器读出原始 JSON 或内部字段**
   诊断证据：DOM 中直接渲染了包含 `seq`、`tool_input` 的文本节点。恢复动作：所有面向辅助技术的文本必须经过 `EventAdapter` 和 `SummaryFormatter` 转换，禁止直接输出原始事件。

## 问答测试样例

1. **正向问题**：用户如何在流输出中跳到下一块？
   答案：按 Ctrl+Shift+Down，FA 移动到下一个 NC，屏幕阅读器朗读该块的 `aria-label` 和文本。

2. **正向问题**：工具调用结果为什么被 assertive 朗读？
   答案：工具事件通常是离散且可操作的，assertive 能打断当前 polite 文本，确保用户及时获知。

3. **边界问题**：当用户正在手动阅读历史块时，新 NC 生成是否会抢走焦点？
   答案：默认不会。只有在“跟随模式”开启且用户最近一次操作是输入新消息时，才可能移动焦点；其他情况仅更新 aria-live 区域。

4. **边界问题**：如果一个 `text_delta` 序列在 500 ms 内只产生了 5 个字符，AQ 会怎么做？
   答案：时间阈值触发时，将 5 个字符作为一个 NC 输出，不会等待字符阈值。

5. **边界问题**：服务端发送了无法识别的 `role`，前端如何处理？
   答案：适配器将其映射为 `unknown` 角色，announce_policy 设为 `polite`，文本渲染为“收到未知事件”，并在日志中记录类型，用于后续扩展。

6. **无证据拒答条件**：屏幕阅读器对某个具体型号的硬件朗读效果如何？
   答案：无证据。本文不覆盖硬件语音输出，仅讨论浏览器内 aria-live 与键盘导航。

7. **无证据拒答条件**：服务端模型如何决定生成多少 token？
   答案：无证据。这是模型生成策略，不在本文边界内。

## 维护、版本、来源与相邻主题

本文档建议纳入 `.pi/knowledge` 并通过 `search_knowledge` 召回。维护责任边界：SEU 与 `StreamAccessibilityEvent` DTO 由 `packages/contracts` 维护；适配器、AQ 和 `StreamRegion` 由 `apps/web` 维护；状态机和能力协商由 `packages/pi-agent` 维护。版本策略：当 SEU 增加新 `role` 时，必须同步更新适配器、SSM 状态定义和问答测试样例，属于破坏性变更。

相邻主题包括：Web 流式交互的实时性设计（关注延迟而非可访问性）、SSE 与 WebSocket 传输协议（关注传输而非语义）、Pi JSON 事件协议（关注协议格式而非辅助技术呈现）、前端状态管理（关注组件状态而非屏幕阅读器语义）。本文与这些主题的交界点在于：本文提供语义层接口，它们提供传输或实现层。

## 结论

事实：流式文本若不经过聚合和语义映射，会直接导致屏幕阅读器不可理解；`aria-live`、焦点管理和键盘导航是浏览器端必须承担的责任；SEU、NC、AQ、FA、SSM、PS、CN 是描述该问题域的核心抽象。

推论：将服务端事件转换为辅助技术可理解的结构，最佳做法是引入中间层（适配器、队列、状态机）而非直接绑定 DOM；默认不抢焦点、工具事件优先 assertive、状态变化必须宣布，这三条规则在长期演进中保持稳定。

未知：不同屏幕阅读器对 `aria-live="polite"` 的实际调度策略存在差异，具体阈值（如 500 ms/120 字符）需要通过用户测试校准；在多语言混合输出场景下，朗读队列的切分边界是否依赖 `Intl.Segmenter` 仍需验证。
