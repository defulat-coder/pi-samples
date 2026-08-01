---
type: concept
title: 可访问性：实现视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。让流式文本、状态和事件在键盘与屏幕阅读器中可理解
resource: .pi/knowledge/library/web-streaming/accessibility-implementation.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, accessibility, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: accessibility
variant: implementation
---

# Web 流式交互可访问性：面向键盘与屏幕阅读器的 TypeScript 实现

## 摘要与问题边界

流式交互把大模型或 Agent 的输出拆成 `text_delta`、`thinking_delta`、`tool_execution_*` 等连续事件推送到浏览器。视力正常用户可以通过逐字显现的动画感知进度，但键盘用户和屏幕阅读器用户面对的是同一个不断变化的 DOM。如果实现者直接把每次事件都塞进 `aria-live` 区域，会得到字符级连读、焦点被抢走、错误静默等灾难体验。本文聚焦前端 TypeScript 实现，目标是把事件流转换成屏幕阅读器可理解、键盘可操控、状态可预测的辅助技术表述。问题边界限定为：浏览器内基于 SSE 或 WebSocket 的文本/事件流，辅助技术为 NVDA、JAWS、VoiceOver、TalkBack 等遵循 WAI-ARIA 的屏幕阅读器，不涉及后端模型生成策略或通用 UI 设计规范。

## 核心概念与数据模型

1. **StreamEvent**：后端推送的最小事件单元，类型包括 `text_delta`、`thinking_delta`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`lifecycle` 和 `retry`。每个事件必须携带单调递增的 `seq`、来源 `sourceId` 和时间戳 `ts`，用于去重和排序。
2. **Utterance**：面向辅助技术的最小播报单元，字段包括 `id`、`priority`（`polite`/`assertive`/`off`）、`content` 文本、`group`（例如 `main`、`tool`、`error`）和 `expiresAt`。Utterance 不是原始事件，而是经过归一化、合并、截断后的结果。
3. **AuralBuffer**：内存中的有序 utterance 队列。实现为环形缓冲区，容量上限建议 256 条；超出上限时按 `priority=off` 优先、`polite` 其次的顺序丢弃，并在可观测性中记录 `droppedCount`。它负责把高频事件降速为可被理解的语音流。
4. **LiveRegionSlot**：真实 DOM 中的播报容器，通常只有一个 `aria-live="polite"` 的主槽和一个 `aria-live="assertive"` 的紧急槽。每个槽具有 `aria-atomic`、`aria-relevant` 和 `aria-busy` 属性。主槽只接收 `main` 和 `tool` 分组的 `polite` utterance；`assertive` 槽只接收 `error` 或需要立即打断的内容。
5. **FocusEnvelope**：描述键盘焦点的状态边界，包括当前 `document.activeElement`、可聚焦的流式段落锚点、roving tabindex 组和“跳转至最新内容”的 skip-link。FocusEnvelope 不得被流式事件自动修改，除非事件对应的是需要用户立即响应的错误或确认按钮。
6. **StateSnapshot**：运行时可验证的状态快照，字段包括 `phase`（`idle`/`streaming`/`paused`/`error`/`done`）、`pendingToolCount`、`lastError`、`contentLength`、`srActive`（用户是否启用屏幕阅读器，仅通过显式设置或辅助技术 API 探测，不做用户代理推断）、`reducedMotion`。它是所有调度决策的输入，而不是渲染视觉效果的中间变量。

## 设计决策与取舍

### 1. 归一化优于透传
原始事件不能直接写入 live region，否则 `text_delta` 的每个字符都会触发一次语音。实现时应把事件映射为 utterance，再按语义边界（句号、问号、换行、150 毫秒静默）合并。代价是引入 50–150 毫秒延迟，收益是把“字符雨”变成可理解的短句。

### 2. 单一 polite 槽与受限 assertive 槽
默认只使用一个 `aria-live="polite"` 容器播报普通流式内容；`assertive` 仅用于错误、`tool_execution_end` 导致输入被阻塞、或用户显式请求“跳转到关键消息”。例外：如果 assertive 消息过于频繁，应降级为 polite 并记录告警，避免打断用户当前操作。

### 3. 不自动窃取焦点
流式内容追加时禁止自动把焦点设到最新文本。键盘用户需要保持对输入框或操作按钮的控制。实现上提供显式快捷键（如 `Alt+End` 或 `Ctrl+Shift+L`）和 skip-link，让用户主动跳转。自动焦点的唯一例外是出现不可恢复错误且需要立即确认时。

### 4. 时间批处理与语义边界相结合
批处理窗口不是固定 150 毫秒，而是动态规则：遇到语义终止符立即刷新；无终止符时最多等待 150 毫秒；`assertive` 消息立即刷新。边界情况：代码块、URL、数学公式等不应按普通句子切分，而应作为整体 utterance 延迟到完整接收后再播报。

### 5. 尊重 `prefers-reduced-motion`
当用户启用减少动画时，视觉上仍可以逐字追加，但必须关闭装饰性状态闪烁和声音提示，并把 utterance 合并为更完整的段落，减少语音变化次数。实现中把 `reducedMotion` 纳入 `StateSnapshot`，不把它当作 CSS 媒体查询的副作用。

## 可执行的实施流程

1. 在 `packages/contracts` 中定义 `StreamEvent` 的 TypeScript union 与 zod 校验，确保每个事件都有 `seq`、`sourceId`、`ts` 和 `type`。
2. 实现 `EventNormalizer`，把 `StreamEvent` 转换为候选 `Utterance`；对 `text_delta` 按来源分组缓存，对 `tool_execution_*` 生成描述性文本，如“正在调用搜索工具”。
3. 实现 `AuralBuffer`，支持按优先级插入、去重、容量限制和丢弃计数；对外暴露 `flush()` 方法，返回当前应播报的 utterance 列表。
4. 创建 `LiveRegionManager`，在 `apps/web` 的 DOM 中挂载两个隐藏或可见的 live region 槽，动态设置 `aria-busy`、`aria-atomic` 和 `aria-relevant`。
5. 实现 `Scheduler`，使用 `requestAnimationFrame` 或 `requestIdleCallback` 轮询 `AuralBuffer`；根据 `StateSnapshot` 决定是否刷新 polite 或 assertive 槽。
6. 实现键盘层：为流式输出区设置 `tabindex="-1"` 的段落锚点，提供 skip-link 和 roving tabindex；记录 `FocusEnvelope` 并在调试日志中校验焦点变化是否由用户触发。
7. 实现错误与生命周期处理：当收到 `lifecycle: error` 或网络断开时，生成 assertive utterance，更新 `lastError`，将错误描述绑定到输入框的 `aria-describedby`，并把焦点移到 retry 按钮（仅在用户已聚焦到聊天容器内时）。
8. 实现可观测性：在调度器中记录 `flushLatency`、`droppedCount`、`assertiveCount` 和 `focusChangeSource`；通过 `window.matchMedia('(prefers-reduced-motion: reduce)')` 初始化 `reducedMotion`。
9. 编写单元测试与集成测试：使用 mocked `MutationObserver` 和辅助技术事件模拟，验证 batching、去重、错误播报和焦点边界。

## 输入、处理、输出示例

下面是一个运行时的配置与事件处理示例。输入是一组 SSE 事件；处理逻辑由 `AuralBuffer` 和 `Scheduler` 完成；输出是 DOM live region 的更新与可观测指标。

    // 输入：SSE 事件序列
    [
      { type: "text_delta", seq: 1, sourceId: "agent-1", ts: 0, content: "北京" },
      { type: "text_delta", seq: 2, sourceId: "agent-1", ts: 40, content: "今天" },
      { type: "text_delta", seq: 3, sourceId: "agent-1", ts: 90, content: "气温" },
      { type: "text_delta", seq: 4, sourceId: "agent-1", ts: 130, content: "25度。" },
      { type: "tool_execution_start", seq: 5, sourceId: "agent-1", ts: 140, tool: "weather" }
    ]

    // 处理规则
    const buffer = new AuralBuffer({ capacity: 256 });
    const scheduler = new Scheduler({
      politeDelayMs: 150,
      sentenceDelimiters: ["。", "？", "！", "\n"],
      codeBlockTimeoutMs: 500
    });

    // 输出：合并后的 utterance 写入 polite live region
    { id: "u-1", priority: "polite", group: "main", content: "北京今天气温25度。" }
    { id: "u-2", priority: "polite", group: "tool", content: "正在调用 weather 工具。" }

在此示例中，前四个 `text_delta` 在 150 毫秒内到达且无终止符，直到“。”出现才合并为一个 utterance；`tool_execution_start` 因语义独立被单独输出。`Scheduler` 同时上报 `flushLatency` 约为 130 毫秒、`droppedCount` 为 0。

## 性能、质量与可观测性指标

1. **Time-to-Utterance**：从事件到达前端到写入 live region 的耗时。目标 p99 ≤ 250 毫秒， polite 内容因批处理可放宽到 300 毫秒，assertive 错误必须 ≤ 50 毫秒。通过 `performance.now()` 在事件入口和 DOM 注入点采样。
2. **Dropped Utterance Rate**：因 `AuralBuffer` 满载而丢弃的 utterance 占比。目标 < 0.1%。在缓冲区丢弃分支计数并除以总插入数。
3. **Assertive Interruption Rate**：每会话 assertive 播报次数。目标中位数 ≤ 2 次，异常高的值提示有抖动或过度错误。由调度器直接累加。
4. **Focus Regression Count**：自动化测试与手动审计中发现的非用户触发焦点变化次数。每次焦点移动记录 `source`，非 `user` 即视为回归。
5. **Reduced Motion Compliance**：用户开启减少动画的会话中，正确抑制装饰性更新和语音抖动的比例。通过初始化时读取 `matchMedia` 并在测试环境注入该标志验证。

## 失败模式、诊断证据与恢复动作

1. **连读噪声（chatter）**：屏幕阅读器快速重复单字。诊断证据：`assertiveCount` 激增、live region 文本长度长期处于 1–3 字符。恢复：检查 `EventNormalizer` 是否未合并 `text_delta`，启用 batching 并增大 `politeDelayMs`。
2. **焦点被窃取（focus theft）**：用户在输入时焦点跳到流式输出区。诊断证据：`FocusEnvelope.source` 为 `streamAutoFocus` 或 `document.activeElement` 从输入框变为输出区。恢复：移除所有自动 `focus()` 调用，改为 skip-link 与显式快捷键。
3. **静默错误**：错误仅渲染为红色文字，未触发语音。诊断证据：出现 `lifecycle: error` 后 assertive live region 为空、`aria-describedby` 未更新。恢复：把错误事件路由到 assertive 槽，并确保错误文本绑定到输入控件。
4. **`aria-busy` 卡死**：区域长期保持 `aria-busy="true"`，屏幕阅读器不再播报新内容。诊断证据：流结束后超过 2 秒 `aria-busy` 仍为 true。恢复：在 `lifecycle: done` 或错误超时时强制设置 `aria-busy="false"`，并加入 watchdog 定时器。
5. **辅助技术误判**：通过用户代理字符串推断屏幕阅读器，导致功能被错误关闭或开启。诊断证据： telemetry 中 `srActive` 与真实用户反馈不一致。恢复：仅依赖显式用户设置、辅助技术 API 或系统无障碍开关，用户代理只做提示，不做功能门控。

## 问答测试样例

1. **正向**：用户按 Tab 如何到达最新流式段落？
   答：页面顶部提供“跳转到最新输出”skip-link，目标指向当前输出区末尾一个 `tabindex="-1"` 的段落锚点；进入后按方向键在段落间移动，roving tabindex 负责管理。
2. **正向**：屏幕阅读器用户如何知道工具调用结束？
   答：`tool_execution_end` 生成 `priority: "polite"` 的 utterance，例如“weather 工具已返回”；如果结果导致输入被阻塞，则升级为 `assertive`。
3. **边界**：150 毫秒内收到 50 个无标点的 `text_delta`，会念几次？
   答：在 150 毫秒批处理窗口结束时只念一次，内容按顺序拼接；如果中间遇到句号则提前分割。
4. **边界**：`prefers-reduced-motion: reduce` 时是否仍要播报每个 delta？
   答：不播报每个 delta，而是把窗口内文本合并为完整 utterance；同时关闭装饰性状态音。
5. **无证据拒答**：这个实现是否通过 JAWS 2023 认证？
   答：项目当前未提供 JAWS 2023 的测试矩阵或 NVDA/JAWS/VoiceOver 的自动化报告，无法给出“通过”结论；应参考 WCAG 2.1 与 ARIA 1.2 自行补充测试。
6. **无证据拒答**：屏幕阅读器是否会把 `aria-live="polite"` 内容打断当前朗读？
   答：不同屏幕阅读器对 polite 的调度策略不同，无法给出统一保证；实现中应把真正需要打断的内容放入 `assertive`。

## 维护、版本、来源与相邻主题关系

代码实现应与 `packages/contracts` 中的 `StreamEvent` DTO 保持版本同步；live region 语义遵循 WAI-ARIA 1.2，键盘与焦点行为参考 WCAG 2.1 的 1.3.1、4.1.2 和 1.4.13。`apps/api` 负责事件传输，不应在 API 层做语义切分；`packages/pi-agent` 负责把 Pi 的 `message_update` 和 `tool_*` 事件映射为 `StreamEvent`；`apps/web` 只消费 SSE/JSON，不接触 Pi SDK 或模型密钥。本文主题与“Web 流式交互”是实例与领域的关系，与“SSE/JSON 事件协议”是消费端关系，与“错误边界与重试”是生命周期互补关系。

## 结论：事实、推论与未知

**事实**：屏幕阅读器依赖 `aria-live` 区域感知动态内容；键盘用户需要稳定的焦点边界；`text_delta` 级事件直接播报会造成不可用的连读噪声。

**推论**：通过 `StreamEvent → Utterance → AuralBuffer → LiveRegionSlot` 的分层归一化，可以在不牺牲后端协议简洁性的前提下，把流式输出变得可访问；把 `assertive` 限制在错误和阻塞事件上，能显著降低对键盘用户的打扰。

**未知**：不同屏幕阅读器对 polite/assertive 的调度时序存在差异，具体阈值需在实际测试矩阵中校准；OKF-compatible concept 未来是否会把 `StateSnapshot` 或 `FocusEnvelope` 纳入可序列化的知识节点，目前版本未定。
