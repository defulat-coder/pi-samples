---
type: concept
title: Thinking level：验证与运维视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。不同思考级别对可见事件、成本和回答稳定性的影响
resource: .pi/knowledge/library/pi-runtime/thinking-operations.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, thinking, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: thinking
variant: operations
---

# Pi Agent 运行时 Thinking Level 验证与运维指南

## 摘要与问题边界

Thinking Level 是 Pi Agent 运行时中一个可观测的会话级参数，决定 `ModelRuntime` 在向 LLM provider 发起请求时是否请求推理内容，并决定客户端在 SSE 流中能否看到 `thinking_delta` 事件。本指南只讨论 `pi-samples` 仓库内的运行时发现：`packages/pi-agent` 的会话生命周期、`apps/api` 的请求验证、`apps/web` 的 Inspector 事件展示，以及 `packages/contracts` 的事件 DTO。我们不讨论 provider 模型内部的训练细节或未来版本的未公开 API，也不声称访问过任何外部计费系统。

核心运维问题：同一 prompt 在不同 thinking level 下，事件流长什么样、成本如何变化、答案是否稳定、失败时如何降级。

## 核心概念与数据模型

1. `thinkingLevel` 是会话状态，不是后处理过滤器。它通常用一个枚举表示，例如 `Off=0`、`Low=1`、`Medium=2`、`High=3`，在 `createAgentSession()` 时传入 `ModelRuntime` 配置。
2. 可见事件集合由 `packages/contracts` 定义。与本主题直接相关的 delta 类型包括 `text_delta`、`thinking_delta`，以及 `toolcall_begin / toolcall_delta / toolcall_end`。
3. 当 `thinkingLevel = 0` 时，运行时显式不向 provider 请求 reasoning 内容。若 provider 内部仍返回 reasoning，运行时应将其过滤，不发出 `thinking_delta`，仅向 web 暴露 `text_delta` 与工具事件。
4. 当 `thinkingLevel > 0` 时，运行时在请求中携带 reasoning 标志。若 provider 支持，则先返回一段或多段 `thinking_delta`，再返回 `text_delta`；若不支持，则与 `Off` 类似，但 `text_delta` 内容可能因请求参数不同而略有差异。
5. 成本模型把 token 分为输入、推理、输出三类。`packages/pi-agent` 从 provider 元数据中提取 token 用量，并在 `message_update` 或结束事件中给出。高 level 通常增加推理 token 数量，但单位 token 价格由 provider 决定，不在本运行时可控范围内。
6. 稳定性以“同一配置 + 同一 prompt + 同一份资源加载结果”多次运行的输出一致性衡量。运行时不保证确定性，因为 provider 采样、temperature 和 reasoning 过程均可能引入方差，所以运维视角必须记录多次运行的证据。

## 设计决策与取舍

**1. 会话级可观测配置，而非环境变量**
把 `thinkingLevel` 做成可观测状态，允许在不重建 API 进程的情况下动态调整。代价是必须在 `SessionManager.inMemory()` 中保存当前值，并确保 web 切换后下一次 `session.prompt()` 生效。

**2. 独立 `thinking_delta` 通道，不混入 `text_delta`**
这样 `apps/web` 的 Inspector 可以把 reasoning 单独展示、折叠或隐藏。但下游只处理 `text_delta` 的组件会忽略推理内容，因此最终答案评估应以完整事件流为准。

**3. 成本上限与 thinking level 解耦**
API 可以强制每轮请求的 token 预算，无论用户选择哪一级。这样高 level 不会无限消耗推理 token，缺点是可能截断 provider 的 reasoning 过程，导致输出质量下降。

**4. Thinking Level 不参与重试逻辑**
网络错误、provider 限流或生命周期事件由 `retry` 机制处理，而不是靠调低 thinking level 解决。运维时不能混淆“推理失败”和“连接失败”。

**5. Web 与 API 的边界**
浏览器只发送期望的 level 字符串，API 负责校验并注入 provider 参数。provider 密钥、endpoint 和原始响应都留在 `apps/api` 和 `packages/pi-agent` 进程内，不进入前端。

## 可执行的实施流程

1. 在 `packages/contracts` 定义 `ThinkingLevel` 枚举，并生成前端共享类型。
2. 在 `apps/api` 用 Zod 校验请求体中的 `thinkingLevel`，未知值返回 400，缺省值设置为 `Off`。
3. 在 `packages/pi-agent` 把 `thinkingLevel` 映射到 `ModelRuntime` 的 provider 参数。
4. 构造 `AgentSession` 时通过 `createAgentSession()` 传入配置，并关联 `SessionManager.inMemory()` 实例。
5. 在 `apps/web` 添加下拉选择器，把用户选择的 level 随每次请求发送给 API。
6. 在调用 `session.prompt()` 之前订阅事件流，将 `thinking_delta` 路由到 Inspector 的独立面板。
7. 在服务端记录：请求时间、首个 `thinking_delta` 时间、首个 `text_delta` 时间、结束事件中的 token 用量、finish reason。
8. 在 `packages/pi-agent` 或 `apps/api` 添加单元测试：模拟支持/不支持 reasoning 的 provider，断言每种 level 的事件序列和 token 分类。

## 本地文件知识库与 TypeScript 运行示例

```json
{
  "sessionId": "sess-20260801-ops-01",
  "cwd": "/Users/xbjt/Documents/myself/pi-samples",
  "thinkingLevel": 2,
  "resources": [".pi/skills", ".pi/prompts", "AGENTS.md"],
  "messages": [
    { "role": "user", "content": "分析当前仓库 AGENTS.md 对 thinking level 的约束" }
  ]
}
```

输入：一次会话请求包含 `thinkingLevel` 和本地资源路径，资源加载器会读取 `.pi/skills`、`.pi/prompts` 和 `AGENTS.md`，但不会自动读取 `.pi/knowledge`（后者需通过 `search_knowledge` 工具显式检索）。处理：`apps/api` 校验字段后，由 `packages/pi-agent` 创建 `AgentSession`；`DefaultResourceLoader` 按项目 `cwd` 加载资源；`ModelRuntime` 根据 level 向 provider 发送请求。输出：SSE 流按顺序推送 `thinking_delta`（若 provider 支持）、`text_delta`、工具事件、以及带 token 统计的结束事件。

## 性能、质量和可观测性指标

1. **首字延迟（TTFT）**：从 API 收到请求到第一个 `text_delta` 到达的时间。同时测量 `time_to_first_thinking_delta`，两者差值反映 reasoning 阶段长度。
2. **推理 token 占比**：`thinking_delta` 对应的 token 数除以总 token 数。用 provider 返回的 usage 字段计算，而不是前端字数。
3. **答案稳定性**：对同一 prompt 连续运行 10 次，比较最终文本的字符串差异或语义相似度；高 level 通常更稳定，但过度推理可能引入新错误。
4. **事件流完整性**：检查 `message_update` 序列是否包含 `begin`、若干 delta、以及 `end`；缺失 `end` 视为未正常关闭。
5. **成本异常率**：若某次请求总 token 超过预算，或 `thinkingLevel=0` 时 reasoning token 占比却异常高，触发告警。
6. **工具调用与推理交叉频率**：统计 `toolcall_*` 出现在 `thinking_delta` 和 `text_delta` 之间的次数，用于判断复杂任务是否出现“思考—调用工具—再思考”的循环。

## 失败模式

1. **Provider 不支持 thinking level**
   现象：请求中携带 reasoning 参数，但流中始终没有 `thinking_delta`。诊断：在 30 秒或首个 `text_delta` 出现前未观察到 `thinking_delta`。恢复：运行时应降级到 `thinkingLevel=0`，并记录 provider 不支持标记。
2. **推理内容混入文本**
   现象：`text_delta` 中出现“Let's think step by step”或内部草稿片段。诊断：对文本做正则采样或关键词检测。恢复：调整 `ModelRuntime` 的解析逻辑，把 reasoning 部分提取为 `thinking_delta`。
3. **高 level 导致超时或成本爆炸**
   现象：TTFT 或总耗时显著增加，token 用量超出预算。诊断：监控 `time_to_first_text_delta` 和 usage 字段。恢复：在 API 层实施硬 token 上限，超时后终止流并返回部分结果。
4. **`thinkingLevel` 切换未生效**
   现象：web 切换 level 后，事件流仍按旧级别输出。诊断：对比 API 日志中 `effectiveThinkingLevel` 与请求体。恢复：确保新值写入 `SessionManager` 并在下一次 `session.prompt()` 前生效。
5. **前端解析 `thinking_delta` 失败**
   现象：浏览器控制台报 SSE JSON 解析错误，Inspector 白屏。诊断：检查 `packages/contracts` 的 DTO 版本是否与前端一致。恢复：对未知 delta 类型做降级渲染，而不是直接崩溃。
6. **资源热加载导致旧配置残留**
   现象：`.pi/prompts` 已更新，但 reasoning 提示未生效。诊断：比较 `DefaultResourceLoader` 的资源哈希。恢复：重新加载资源并重启会话。

## 问答测试样例

1. 正向问题：当 `thinkingLevel=0` 时，客户端应看到哪些事件？
   期望：只出现 `text_delta`、`toolcall_*`、生命周期和重试事件；不应出现 `thinking_delta`。
2. 正向问题：如何验证 `thinkingLevel=2` 时 provider 确实返回了推理？
   期望：在事件流中至少观察到一段 `thinking_delta`，且其出现在至少部分 `text_delta` 之前或之间。
3. 边界问题：若 `thinkingLevel=0` 但 provider 仍返回 reasoning 内容，运行时应如何处理？
   期望：过滤为 `thinking_delta` 不发送，或按失败模式 2 进行规范化；web 不应直接看到未加工的推理文本。
4. 边界问题：web 切换 thinking level 后，旧请求是否会被影响？
   期望：不会。新 level 从下一次 `session.prompt()` 开始生效，已进行中的流保持原配置。
5. 边界问题：web 请求未传 `thinkingLevel` 时默认值是什么？
   期望：API 校验 schema 中默认值为 `Off=0`，并在日志中记录为缺省设置。
6. 无证据拒答：各 LLM provider 2026 年的 thinking token 定价和内部算法是否在本知识库中？
   期望：未收录。请直接查询 provider 账单 API 或官方文档，不要从本仓库推断实时价格。

## 维护、版本、来源与相邻主题

- 版本：仓库使用 `pnpm@10.30.3`，Pi SDK 版本为 `@earendil-works/pi-coding-agent@0.83.0`；任何新增 thinking level 都必须同步更新 `packages/contracts` 的枚举、`apps/api` 的 Zod schema 和 `apps/web` 的选择器。
- 来源：项目级约束主要来自 `AGENTS.md` 以及 `packages/pi-agent`、`apps/api`、`apps/web` 的源码；运维证据应来自本地测试日志，而不是外部系统。
- 相邻主题：与 `ModelRuntime` 配置、`AgentSession` 事件订阅、`SessionManager` 内存注册、`DefaultResourceLoader` 资源加载、`.pi/knowledge` 的 `search_knowledge` 工具、以及 `defineTool()` 自定义工具均相关。Thinking Level 只改变事件流和请求参数，不改变工具能力或权限边界。

## 结论

事实：在本项目中，`thinkingLevel` 是一个可观测的会话级配置，通过 `apps/api` 校验后注入 `packages/pi-agent` 的 `ModelRuntime`；它直接决定客户端是否看到 `thinking_delta`；`apps/web` 不接触 provider 密钥。

推论：提高 thinking level 通常会增加 reasoning token 和延迟，可能提升复杂任务答案稳定性，但也会抬高成本并放大 provider 采样带来的不确定性。运维时应把“成功一次”和“稳定十次”分开评估。

未知：具体 provider 的 thinking token 定价、模型内部 reasoning 算法、以及不同 provider 在相同 level 下的行为一致性，均不在本仓库可控范围内，不能凭运行时代码推断。
