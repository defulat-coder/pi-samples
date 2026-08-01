---
type: concept
title: Thinking level：架构视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。不同思考级别对可见事件、成本和回答稳定性的影响
resource: .pi/knowledge/library/pi-runtime/thinking-architecture.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, thinking, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: thinking
variant: architecture
---

# Pi Agent 运行时中的 Thinking Level：事件可见性、成本与稳定性的架构控制

摘要与问题边界

Thinking Level 是 Pi Agent 运行时中的一项**推理预算控制**，它决定模型在产生对外可见内容之前愿意消耗多少内部计算资源。它不是新的模型，也不是语义路由规则；它不改变工具白名单、文件系统权限或安全边界。本文讨论的范围仅限于：在 `packages/pi-agent` 与 `apps/api` 之间如何定义该级别；它如何映射到不同 Model Provider 的本地参数；它如何影响 SSE 事件流、Token 成本以及多次调用下回答的稳定性；以及 `apps/web` 应该以何种方式观察它。所有结论均基于当前仓库对 `@earendil-works/pi-coding-agent` SDK 的封装方式，不假设任何外部系统已被访问。

核心概念与数据模型

1. **ThinkingLevel 枚举**
   在 `packages/contracts` 中用一个有限枚举表示，例如 `'none' | 'low' | 'medium' | 'high'`。它必须是可序列化的字符串，不能是 Provider 原生的数值或结构体，以保证 Web 与 API 的契约稳定。

2. **Thinking Budget（推理预算）**
   每个级别对应一个内部 Token 预算或 effort 参数。对 Anthropic 扩展思考模式可能是 `budget_tokens`，对 OpenAI 推理系列可能是 `reasoning_effort`。该映射由 Provider 适配器维护，而不是写死在会话层。

3. **可见事件模型**
   Pi 的 `message_update` 事件包含 `text_delta`、`thinking_delta`、`toolcall_*` 等子类型。`thinking_delta` 只应在运行时确认当前 Provider 支持思考输出且用户选择非 `none` 级别时才可能出现。

4. **回答稳定性空间**
   稳定性不是随机种子的问题，而是模型在内部是否被允许进行充分验证。较高级别通常降低“冲动”工具调用和前后矛盾的概率，但并不能保证确定性输出。

5. **成本向量**
   一次会话的成本至少包含输入 Token、输出 Token 和可选的思考 Token。运行时必须在 Provider 返回的 usage 中识别思考 Token 并单独上报，否则成本仪表盘会失真。

6. **能力降级接口**
   如果当前模型不支持思考，Provider 适配器必须返回一个等价的生成参数补丁（如固定 temperature、增加 max_tokens），并通知会话层不要发送 `thinking_delta`。这是可替换接口的核心。

设计决策与取舍

**配置权归属 API，而非 Web**
`apps/web` 只能请求一个语义级别（如 `medium`），不能传入 Provider 原始参数。具体预算在 `apps/api` 中根据 `ModelRuntime` 和项目配置计算。这保证了 Provider Key 不出现在浏览器，也防止前端绕过预算上限。

**不用于语义路由**
`thinkingLevel` 绝不能用于“如果用户提到复杂问题就自动切换高级别”或“如果请求包含文件名就使用低级别”。路由决定必须由 Pi 运行时基于模型输出做出，API 只做能力注入。

**Provider 适配层作为可替换接口**
定义一个 `ThinkingLevelAdapter` 接口，包含 `supports(modelId)` 和 `apply(level, config)`。 Anthropic 适配器与 OpenAI 适配器独立实现，新增模型时只需增加一个适配器，无需修改 `createAgentSession` 的核心路径。

**事件协议向后兼容**
`thinking_delta` 是可选字段。Web 的 JSON Schema 必须把它标记为可选；如果某次响应没有思考事件，前端仍应正常渲染文本和工具事件。

**安全与信任边界**
思考内容属于模型内部产物，不可视为用户输入，也不能作为安全沙箱证据。它应被记录到观测日志，但不应直接喂给工具参数或文件写入路径。

可执行的实施流程

1. 在 `packages/contracts` 中新增 `ThinkingLevel` 类型和 `ThinkingConfig` DTO。
2. 在 `packages/pi-agent` 创建 `ThinkingLevelAdapter` 接口及 `AnthropicThinkingAdapter` 实现。
3. 为 OpenAI 推理系列实现 `OpenAIReasoningAdapter`，实现不支持的模型返回 `supported: false`。
4. 在 `createAgentSession` 的 `ModelRuntime` 初始化中注入当前选中的 `thinkingLevel` 作为 observable。
5. 在 `SessionManager.inMemory()` 的会话注册表中保存每个会话的 `thinkingLevel`，便于后续审计。
6. 在 `apps/api` 的会话创建路由中校验 `thinkingLevel` 是否属于合法枚举，拒绝任何原始 Provider 参数。
7. 在 API SSE 归一化层中把 Provider 的思考输出转换为 `thinking_delta`，并附加 `thinkingLevel` 元数据。
8. 在 `apps/web` 的 Inspector 组件中绑定一个只读 selector，仅允许用户选择 `low/medium/high/none`。
9. 为降级路径编写 E2E 测试：当 Provider 不支持思考时，确认不生成 `thinking_delta` 且会话不崩溃。
10. 在 `packages/pi-agent` 的测试夹具中模拟多次相同请求，测量不同级别下的稳定性变化。

本地文件知识库配置示例

    # .pi/knowledge/thinking-level-budgets.yaml
    thinkingLevels:
      none:
        visible: false
        adapterPatch: {}
      low:
        visible: true
        anthropic_budget_tokens: 1024
        openai_reasoning_effort: low
      medium:
        visible: true
        anthropic_budget_tokens: 4096
        openai_reasoning_effort: medium
      high:
        visible: true
        anthropic_budget_tokens: 12000
        openai_reasoning_effort: high

- **输入**：该 YAML 文件由 `DefaultResourceLoader` 在 `cwd` 下加载，为每个语义级别提供 Provider 相关映射。
- **处理**：`ThinkingLevelAdapter` 根据当前 `ModelRuntime` 的模型 ID 读取对应字段，并生成请求补丁。
- **输出**：补丁被注入到 Provider 调用中；若 `visible: false` 或模型不支持，则运行时抑制 `thinking_delta` 事件。

性能、质量和可观测性指标

- **思考事件可见率**：含 `thinking_delta` 的消息数 / 消息总数，从 API SSE 日志中统计。
- **思考 Token 占比**：单次请求中 `thinking_tokens / total_tokens`，由 Provider 返回的 usage 计算。
- **回答稳定性**：同一提示词重复 N 次，比较最终文本的语义相似度和工具调用序列一致性；高级别通常方差更小。
- **每会话成本**：按 `thinkingLevel` 分组聚合 Provider 账单，区分输入、输出与思考 Token。
- **延迟分解**：记录 `time_to_first_thinking_delta`、`time_to_first_text_delta`、`total_duration`，识别思考是否阻塞首 token。
- **降级触发率**：统计 `supported: false` 的会话比例，用于发现适配器遗漏的模型。

失败模式、诊断证据与恢复动作

**模型未按预期输出思考事件**
证据：usage 中 thinking_tokens 为 0，事件流中没有 `thinking_delta`。恢复：检查 adapter 是否正确注入参数；确认模型本身支持扩展思考；如不支持，则降级为普通生成。

**Web 端因未知事件类型报错**
证据：前端控制台出现 `unknown message_update type: thinking_delta`。恢复：更新 `packages/contracts` 中的 JSON Schema，将 `thinking_delta` 标记为可选；前端添加未知字段忽略逻辑。

**成本突然激增**
证据：某 `high` 会话的思考 Token 占比超过阈值。恢复：在 API 中对该级别设置 `budget_tokens` 上限，超过时拒绝继续请求并提示用户。

**稳定性未随级别提升而改善**
证据：N 次重复实验的文本相似度分数相同。恢复：检查是否同时启用了非零 temperature 或非确定性工具排序；必要时固定 temperature 并排序工具结果。

**前后端枚举不一致**
证据：Web 发送 `auto` 而 API 返回 `400 Invalid thinkingLevel`。恢复：从共享的 `packages/contracts` 类型生成前端 selector 选项，并在 CI 中运行契约测试。

问答测试样例

1. **正向**：为什么复杂任务推荐 `high` 级别？答：它允许更大的内部推理预算，降低冲动工具调用，提高回答一致性。
2. **正向**：`thinkingLevel` 在哪里被解析为 Provider 参数？答：在 `apps/api` 或 `packages/pi-agent` 的 Provider 适配器中，而非浏览器。
3. **边界**：用户能否通过 Web 直接传入 `budget_tokens: 64000`？答：不能，API 只接受枚举字符串，超出范围则拒绝。
4. **边界**：当模型不支持思考时会发生什么？答：适配器返回 `supported: false`，运行时不发送 `thinking_delta`，并可能调整 temperature 或 max_tokens 作为降级。
5. **无证据拒答**：`thinkingLevel` 是否扩大 Agent 的文件写入权限？答：没有证据支持该结论；它只影响推理预算，不改变工具能力。
6. **无证据拒答**：思考内容是否可以作为安全沙箱证据？答：不能；思考内容仍是模型生成的未信任文本，不能单独作为授权依据。

维护、版本、来源与相邻主题的关系

- 本主题应存放于 `.pi/knowledge` 并通过 `search_knowledge` 读取，不应假设 Pi 自动加载。
- 实现变更需同步更新 `packages/contracts`、`packages/pi-agent`、`apps/api` 与 `apps/web` 的共享类型。
- 版本跟踪以 `@earendil-works/pi-coding-agent` 的 SDK 版本为准；Provider 适配器映射应随 SDK 升级重新校验。
- 参考来源：`AGENTS.md` 中的 Pi 集成契约、`docs/pi-agent-learning.md` 的本地架构说明，以及已安装的 SDK 中的 `sdk.md`。
- 相邻主题：与 `ModelRuntime` 配置、SSE 事件协议、Provider 适配器、会话生命周期管理、成本观测仪表盘直接相关。

结论

**事实**：Pi Agent SDK 将 `thinkingLevel` 作为可观测的运行时参数；`apps/api` 负责解析与注入 Provider 参数；`apps/web` 只消费归一化 SSE 事件；Provider 不支持思考时必须降级。
**推论**：在需要多步规划的复杂任务中，较高级别通常通过增加内部推理预算来提升回答稳定性，并降低工具调用序列的方差。
**未知**：不同 Provider 对思考 Token 的精确计费方式、具体模型在不同级别下的最优预算数值、以及思考内容对长期上下文窗口的实际占用，仍需结合项目实测数据和 SDK 版本文档进一步确认。
