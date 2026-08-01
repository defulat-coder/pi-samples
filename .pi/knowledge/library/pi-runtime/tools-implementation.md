---
type: concept
title: 工具执行：实现视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。Pi 如何根据工具契约选择工具，并把参数与执行结果纳入回合
resource: .pi/knowledge/library/pi-runtime/tools-implementation.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, tools, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: tools
variant: implementation
---

# Pi Agent 运行时工具执行的实现机制

## 摘要与问题边界

Pi Agent 的工具执行不是由 Web 或 API 层根据用户消息做关键词分发，而是由 `AgentSession` 在模型输出与本地工具契约之间完成匹配。本文从实现视角出发，优先明确输入、输出、错误、生命周期和验证步骤，再给出可落地的编码路径。主题聚焦：当模型产生 toolcall 请求后，运行时如何依据 `defineTool()` 声明的契约选择工具、校验参数、执行并把结果以事件形式回注到当前 prompt 回合。内容不包括模型训练细节、Provider 内部实现、前端 UI 渲染，也不讨论技能（Skills）如何被 `DefaultResourceLoader` 加载。

## 核心概念与数据模型

1. **ToolSchema**：由 `defineTool()` 注册，包含 `name`、`description`、`parameters` JSON Schema、`returns` 结构声明、`capability` 标签与同步/异步标记。同一 `name` 在进程内必须唯一；重复注册应抛出 `DUPLICATE_TOOL_NAME`。`parameters` 必须显式声明，不允许省略。
2. **ToolInvocation**：模型输出中解析得到的单次调用对象，包含 `id`、`name`、`arguments`。`id` 用于把后续结果与 toolcall 对齐；同一回合允许存在多个 invocation，但每个 `id` 必须唯一。
3. **ExecutionResult**：工具执行后的标准化结构，包含 `status`（`ok`/`error`）、`content`（业务结果对象）、`details`（元数据）、`errorCode`、`errorMessage`。`content` 不是裸字符串，而是供模型继续消费的 JSON 对象。
4. **RoundState**：当前 prompt 回合的上下文，包括 `userMessage`、累积的 `assistantMessageDelta`、`pendingToolCalls`、`completedToolResults` 与 `tokenUsage`。运行时每完成一次工具调用就追加结果，直到模型不再产生新的 toolcall。
5. **ToolCapabilityPolicy**：宿主注入的能力边界，决定哪些工具对模型可见且可执行。例如本项目只暴露 `read` 与 `search_knowledge`，写操作即使注册也不会进入可用工具列表。Policy 在 `createAgentSession()` 时传入。
6. **EventEnvelope**：SSE/JSON 传输单元，类型包括 `message_update`（`text_delta`、`thinking_delta`、`toolcall_*`）以及 `tool_execution_start/update/end`、`lifecycle/retry`。订阅必须在 `session.prompt()` 前建立，否则首条 delta 可能丢失。

## 设计决策与取舍

### 运行时路由而非 API 关键词路由

API 层只负责请求验证与会话身份，不根据用户 query 判断该调用哪个工具。否则每新增工具都要修改路由表，且会破坏模型自主决策。边界例外：API 仍可在 capability 注入层过滤工具集合，即模型“可见”的工具列表受 policy 控制，但可见性不等于可用性，最终执行还要再校验一次。

### 统一 Promise 接口与顺序执行

本地文件读取可以同步返回，远程查询则为异步。设计决策是所有工具函数统一返回 `Promise<ExecutionResult>`，运行时内部用 `await` 顺序执行同一回合内的多个 invocation，避免共享状态竞态。边界：若某工具内部又触发新的 prompt，必须由该工具显式创建子会话，绝不允许在父会话的事件回调里递归调用 `session.prompt()`，否则直接抛 `REENTRANT_PROMPT`。

### 结构化结果与截断策略

工具结果强制为结构化对象并序列化为 JSON，再作为 assistant message 的 tool result 内容。若返回大段文本，必须截断并标记 `truncation=true`，同时给出实际读取长度。取舍：提升模型解析稳定性，但要求所有工具遵循同一 schema。例外：`search_knowledge` 无结果时应返回空数组，而不是返回 “未找到” 字符串，防止模型误判语义。

### 能力白名单与密钥隔离

SDK 内置写工具，但本项目只暴露只读能力。能力在 `packages/pi-agent` 组装 session 时注入，`apps/api` 不携带 provider key，前端更不可见。边界：即使模型请求写操作，运行时也会因 capability 缺失直接返回错误结果，不会降级执行或落到默认路径。写能力需要显式修改 policy 才能启用。

### 错误暴露与重试边界

参数格式错误由运行时即时返回，不自动重试；业务错误（如文件不存在）由模型决定是否重试。重试次数通过 `SessionManager` 配置；超过阈值后生成 `error` 事件并结束该工具链。例外：幂等读操作可在工具内部实现缓存重试，但不允许由运行时隐藏失败，以免掩盖真实异常。

## 可执行的实施流程

1. 在 `packages/pi-agent` 中注册工具：使用 `defineTool()` 声明 `name`、参数 schema、返回 schema 与 `handler`。
2. 组装 `ToolCapabilityPolicy`：读取项目配置，仅把 `read` 与 `search_knowledge` 加入允许列表，并显式排除所有写标签。
3. 创建 `DefaultResourceLoader`：传入项目 `cwd`，加载 `.pi/skills`、`.pi/prompts` 与 `AGENTS.md`，但不自动加载 `.pi/knowledge`。
4. 调用 `createAgentSession()`，传入 `ModelRuntime`、工具注册表、能力策略与 `SessionManager.inMemory()`。
5. 在调用 `session.prompt()` 前订阅 `message_update` 与 `tool_execution_*` 事件，并准备 `EventEnvelope` 到 SSE 的序列化；序列化失败视为 fatal error。
6. prompt 过程中，运行时把可用工具以 schema 形式发送给模型；模型返回 toolcall 后，解析为 `ToolInvocation[]`。
7. 对每个 invocation：校验 capability → 校验参数 schema → 校验业务约束（如路径 traversal） → 调用 handler → 封装 `ExecutionResult` → 按 `id` 回注 `RoundState` → 发送 `tool_execution_end`。
8. 若仍有 pending toolcall，重复步骤 7；否则把完整 assistant message 返回给前端，并关闭本次事件流。

## 输入、处理与输出示例

下面以 `read` 工具为例，展示一次工具调用的 JSON 形态：

    input:
    {
      "id": "call_7a3f",
      "name": "read",
      "arguments": {
        "path": ".pi/knowledge/api-limits.md",
        "limit": 2000
      }
    }

    processing:
    运行时先校验 capability "read" 是否在白名单中；
    再用 JSON Schema 校验 arguments，path 必须落在项目 cwd 下，
    limit 不得超过 8192，且不能包含 .. 等 traversal 模式；
    随后调用文件读取 handler，读取内容并统计字符数。

    output:
    {
      "id": "call_7a3f",
      "status": "ok",
      "content": {
        "path": ".pi/knowledge/api-limits.md",
        "text": "# API Limits\n...",
        "charCount": 1842
      },
      "details": {
        "truncated": false,
        "encoding": "utf-8"
      }
    }

若 `path` 越界，output 变为 `status=error`、`errorCode=PATH_OUTSIDE_CWD`、`content` 为空对象，模型收到后可决定道歉或请求合法路径。

## 性能、质量与可观测性指标

1. **tool selection accuracy**：模型输出 `name` 命中已注册工具的比率。测量：对比 `invocation.name` 与 `registry.keys()`，每日统计；低于 99% 说明模型频繁幻想工具名。
2. **argument validation pass rate**：首次通过 schema 校验的 invocation 占比。测量：记录失败字段与错误码，要求 >95%；连续低通过率应回退 prompt 模板。
3. **end-to-end tool latency p99**：从 `tool_execution_start` 到 `tool_execution_end` 的耗时。测量：使用单调时钟记录，阈值 5s；超出则触发告警。
4. **result truncation rate**：返回 `truncated=true` 的结果占比。测量：若持续高于 20%，应提升单条上限或拆分工具，避免模型丢失上下文。
5. **error recovery success rate**：工具错误后，同一回合内模型通过重试拿到 `ok` 的比例。测量：按 session 聚合，目标 >70%；过低说明错误提示不够明确。

## 失败模式与恢复

1. **工具名幻觉**：模型请求未注册的工具。诊断证据：`invocation.name` 不在 `registry`；恢复：运行时返回 `errorCode=TOOL_NOT_FOUND`，并附带可用工具列表，让模型重新选择。
2. **参数校验失败**：缺少必填字段或类型错误。诊断证据：JSON Schema 校验错误数组；恢复：返回 `errorCode=INVALID_ARGUMENTS`，模型可修正后重新调用，不会静默补默认值。
3. **工具超时或崩溃**：handler 抛出异常或超过 deadline。诊断证据：未收到 `tool_execution_end`，捕获到未处理异常；恢复：返回 `EXECUTION_TIMEOUT` 或 `EXECUTION_FAILED`，超过 `SessionManager` 重试阈值则结束该工具链。
4. **结果过大**：`content` 序列化后超过 SSE 单消息上限。诊断证据：`payload byte length > maxPayloadSize`；恢复：截断并设置 `truncated=true`，提示模型可分页读取，不直接断开连接。
5. **会话重入错误**：开发者在事件回调里直接调用 `session.prompt()`。诊断证据：`RoundState` 已存在 `pendingToolCalls` 或流状态非 idle；恢复：抛错 `REENTRANT_PROMPT`，强制外部排队，避免状态损坏。

## 问答测试样例

1. 正向：模型请求 `read` 合法文件 `.pi/knowledge/api-limits.md`，应返回 `status=ok` 且 `content.text` 非空。
2. 边界：请求 `limit=100000` 时，运行时拒绝并返回 `INVALID_ARGUMENT`，而不是静默截断到 8192。
3. 边界：同一回合出现 3 个 `read` 调用，运行时按 `await` 顺序执行，不并行打开文件句柄。
4. 无证据：`.pi/knowledge` 为空时，`search_knowledge` 返回 `ok` 但 `content.results=[]`，不编造内容。
5. 无证据：模型要求写入文件，但 capability policy 未包含 `write`，运行时返回 `CAPABILITY_DENIED`，不执行磁盘写。
6. 边界：handler 返回字符串而非对象，运行时视为结果 schema 违规，返回 `EXECUTION_RESULT_INVALID`，不自动包装。

## 维护、版本、来源与相邻主题

工具契约随 `@earendil-works/pi-coding-agent` SDK 版本演进；本项目锁定 `0.83.0`，升级前必须重新校验 `defineTool()` 与事件协议。工具注册位于 `packages/pi-agent`；能力注入由 `apps/api` 的会话中间件控制；前端 `apps/web` 仅消费 SSE，不接触 Pi SDK。相邻主题：会话生命周期、Prompt 模板加载、SSE/JSON 事件协议、Capability 安全策略。来源：项目 `AGENTS.md`、`packages/pi-agent` 源码，以及 SDK 官方 `docs/sdk.md` 与 `docs/security.md`。

## 结论

事实：Pi 的工具执行由 `AgentSession` 在本地完成；API 不预先路由用户消息；工具结果以结构化对象回注当前回合；`read` 与 `search_knowledge` 是本项目当前暴露的只读工具。推论：把 capability 注入与 schema 校验放在 `packages/pi-agent` 层，可以在不改动前端的情况下收紧或放宽工具能力。未知：上游 SDK 在后续版本是否会支持工具流式结果（`tool_execution_update` 的增量 `content` 语义）或多模态工具参数，需以官方 changelog 为准。
