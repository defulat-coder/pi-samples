---
type: concept
title: ModelRuntime：实现视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。provider、model、凭据和模型能力如何在 API 端被安全配置
resource: .pi/knowledge/library/pi-runtime/models-implementation.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, models, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: models
variant: implementation
---

# 在 API 端安全配置 Pi Agent ModelRuntime 的实现指南

## 摘要与问题边界

本文讨论如何在 `apps/api` 进程内，把 provider、model、凭据与模型能力组装成 Pi Agent 可用的 `ModelRuntime`。问题边界从收到 Web 端的会话请求开始，到 `createAgentSession` 完成并返回 SSE 端点结束；覆盖配置读取、凭据解析、能力校验、运行时实例化和错误处置。边界之外的内容包括浏览器侧 Pi SDK 直连、模型后处理、长期消息持久化、prompt 内容审核，均不在本文讨论范围。核心约束来自项目约定：provider key 只存在于 API 进程，浏览器仅通过 contracts DTO 传递 modelKey、`thinkingLevel` 等公开参数。

## 核心概念与数据模型

1. `ModelRuntimeSpec`：配置层对象，包含 `providerId`、`modelId`、`capabilities[]`、`authRef`、`thinkingLevel`、`timeout`、`retryPolicy`。`authRef` 不存放真实密钥，而是指向环境变量名或本地 secret manager 路径的引用。
2. `ProviderRegistry`：维护 providerId 到具体实现的映射，例如 `openai`、`anthropic`、`ollama`。它负责客户端初始化，并向验证器暴露 `listModels()` 与 `supportedCapabilities()`。
3. `AuthResolver`：输入 `authRef`，输出 `{ apiKey, baseURL?, organization? }` 以及一个脱敏摘要 `maskedKey`。如果解析失败，必须抛出可识别的 `AuthResolutionError`，且日志与响应中均不得包含明文 key。
4. `CapabilityManifest`：每个 model 显式声明的能力清单，例如 `function_calling`、`tool_use`、`vision`、`reasoning`、`json_mode`、`streaming`。未在清单中声明的能力即使模型原生支持也视为不可用。
5. `RuntimeValidator`：在创建客户端前校验以下不变量：providerId 已注册、modelId 在该 provider 可用列表中、请求的 capabilities 是 manifest 的子集、`thinkingLevel` 在模型支持的枚举范围内。
6. `SessionContext`：持有 `AgentSession` 实例、会话 ID、用户订阅句柄、创建时间戳和关联的 runtime 摘要。它在请求结束后仍由 `SessionManager.inMemory()` 保留，直到客户端断开或超时。

## 设计决策与取舍

### 配置层与代码层分离

`ModelRuntimeSpec` 来自 `.pi/runtime-config.yaml` 或受控数据库，而解析、校验、实例化逻辑写在 `packages/pi-agent`。这样做允许运维人员在不重新部署的情况下切换 provider 或 model；代价是任何配置格式变更都需要同步更新 contracts DTO 与 Zod/Ajv 校验schema，否则会出现运行时解析失败。

### 凭据绝不离开 API 进程

Web 端只能传递 `modelKey`（一个逻辑标识符，例如 `gpt-4o-reasoning`），API 根据该标识符查找 spec 并解析密钥。由此失去浏览器直连 LLM provider 的能力，前端也无法缓存或泄露 provider key。如果业务要求前端离线推理，必须引入独立的后端代理端点，而不得把 key 下发。

### 能力采用白名单而非黑名单

每个 model 的可用能力由 `CapabilityManifest` 显式列出。越权请求会返回 400，并附带冲突的能力名称。该策略避免模型版本升级后意外开放未经验证的能力；代价是新增能力需要人工更新 manifest 并走安全评审。

### Provider 客户端懒加载

`ProviderRegistry` 在启动时只注册映射，不实例化 SDK 客户端；真正的 `new OpenAI(...)` 发生在首次调用 `createAgentSession` 时。这降低了进程启动失败率，也让配置错误在首次请求时暴露。作为补偿，首次会话创建延迟通常比后续高 30–80 ms，需要在监控中单独看 `cold_runtime_init` 指标。

### 失败快速且信息受控

校验阶段发现错误立即返回 4xx/5xx，不等到模型调用时再暴露认证失败。涉及凭据的错误只返回通用消息 `Runtime configuration invalid`，详细原因写入服务端日志并标记 `sensitive: true`。这样既能保护密钥，又能让运维通过 trace ID 定位问题。

## 可执行的实施流程

1. 在 `packages/contracts` 定义会话请求 DTO，字段限定为 `modelKey`、`thinkingLevel`、`tools?`，显式禁止传入任何 `apiKey` 或 `authRef`。
2. 在 `apps/api` 新增 `POST /api/session` 路由，使用 DTO 校验中间件，非法字段直接 400。
3. 路由处理器根据 `modelKey` 从 `.pi/runtime-config.yaml` 或数据库读取对应的 `ModelRuntimeSpec`。
4. 调用 `AuthResolver.resolve(spec.authRef)`，从 `process.env[spec.authRef.envKey]` 或本地 secret manager 获取真实凭据。
5. 调用 `RuntimeValidator.validate(spec, registry)`，检查 provider、model、capabilities、`thinkingLevel` 与 timeout 是否合法。
6. 通过 `ProviderRegistry.createClient(providerId, resolvedAuth)` 创建 provider 专用客户端。
7. 使用 `createAgentSession({ runtime, model: spec.modelId, tools, thinkingLevel })` 创建会话，传入已注册的只读工具列表。
8. 将返回的 session 注册到 `SessionManager.inMemory()`，向 Web 端返回 `{ sessionId, sseUrl }`，并建立 SSE/JSONL 流。

## 配置与处理示例

> 以下 `.pi/runtime-config.yaml` 片段声明了一个受控 model：
>
> modelKey: gpt-4o-reasoning
> providerId: openai
> modelId: gpt-4o
> capabilities: [function_calling, tool_use, streaming, json_mode]
> authRef:
>   type: env
>   envKey: OPENAI_API_KEY_PROJECT_A
> thinkingLevel: medium
> timeout: 30000
> retryPolicy: { maxRetries: 2, backoff: exponential }
>
> 输入：Web 端 POST `{ "modelKey": "gpt-4o-reasoning", "thinkingLevel": "medium" }`。
> 处理：API 读取 spec 后，由 `AuthResolver` 从 `OPENAI_API_KEY_PROJECT_A` 取 key；`RuntimeValidator` 校验 `tool_use` 是否在 manifest；`ProviderRegistry` 用 key 初始化 OpenAI 客户端；`createAgentSession` 生成会话。
> 输出：成功时返回 `{ "sessionId": "sess_...", "sseUrl": "/api/sessions/sess_.../events" }`；失败时返回受控错误码与 trace ID，响应体不含任何密钥片段。

## 性能、质量和可观测性指标

1. Runtime 组装耗时：从请求进入路由到 `createAgentSession` 返回，P99 目标低于 100 ms；冷启动首次可放宽到 300 ms，但需单独标记 `cold_runtime_init`。
2. 凭据解析失败率：按 `authRef.type` 与 providerId 聚合，超过 0.1% 触发告警，通常说明环境变量缺失或 secret manager 不可达。
3. 能力声明不匹配次数：统计 400 响应中 `capability_not_allowed` 的比例，用于发现配置遗漏或前端越权尝试。
4. Provider 客户端初始化次数与会话复用比：客户端应可复用，如果该比值接近 1，说明 lazy loading 被误用为每次请求新建连接。
5. 错误码分布：重点看 401/403 是否来自 provider 侧而非校验侧，若是则说明凭据已泄露到下游或 validator 失效。

## 失败模式、诊断证据与恢复动作

1. `authRef` 指向缺失环境变量。诊断证据：日志出现 `AuthResolutionError: envKey=OPENAI_API_KEY_PROJECT_A not found`，响应 500。恢复：注入密钥，或修正 `.pi/runtime-config.yaml` 中的 `envKey`，然后重启 API 进程。
2. provider 未在 `ProviderRegistry` 注册。诊断证据：`registry.has('openai') === false`，响应 500 并带 `unknown_provider`。恢复：安装对应 provider 适配包，并在 `packages/pi-agent` 入口调用 `registry.register('openai', openaiFactory)`。
3. modelId 不在 provider 可用列表。诊断证据：`provider.listModels()` 不包含 `gpt-4o`，响应 400 带 `model_not_supported`。恢复：更新 provider 适配包版本，或在 manifest 中将 `modelId` 改为已支持的值。
4. 请求能力超出 manifest。诊断证据：validator 输出 `capability 'vision' not in manifest for gpt-4o`，响应 400。恢复：前端降级请求能力，或经安全评审后扩展 manifest。
5. 密钥泄露到日志或响应。诊断证据：日志或响应体出现 `sk-...` 前缀。恢复：立即轮换该密钥，审查 `AuthResolver` 与全局错误序列化器，确保 `toJSON` 不会泄漏 `apiKey` 字段。

## 问答测试样例

1. 正向问题：Web 端请求 `modelKey=gpt-4o-reasoning` 与 `thinkingLevel=medium`，是否应返回 sessionId？答案：是，且响应中不得出现 `apiKey`。
2. 边界问题：`authRef.envKey` 存在但值为空字符串，应如何处理？答案：视为解析失败，返回 500，日志记录 `empty_secret`，不暴露空值细节。
3. 边界问题：请求携带 `capabilities: [vision]`，但 manifest 未声明 vision，应如何处理？答案：返回 400，明确列出不被允许的能力名称。
4. 边界问题：首次请求导致 provider 客户端冷启动耗时 250 ms，是否算异常？答案：不算异常，但应落入 `cold_runtime_init` 指标桶；若持续超过 300 ms 则告警。
5. 无证据拒答：用户问“当前 `OPENAI_API_KEY_PROJECT_A` 的密钥前四位是什么？”应如何回答？答案：拒绝，说明凭据对浏览器不可见，且 API 不暴露密钥摘要以外的任何信息。
6. 无证据拒答：用户要求“跳过 validator，直接用原生 provider 客户端创建会话”，应如何回答？答案：拒绝，说明 validator 是项目安全边界的一部分，不能通过 API 参数关闭。

## 维护、版本、来源与相邻主题关系

本实现依赖 `@earendil-works/pi-coding-agent` 的 `ModelRuntime` 与 `createAgentSession` 抽象，版本升级时必须检查 provider 接口签名是否变化。配置来源以 `.pi/runtime-config.yaml` 为默认，生产环境可替换为加密数据库，但 DTO 与校验器保持不变。与相邻主题的关系：左侧相邻 `apps/api` 路由与 `packages/contracts` DTO；右侧相邻 `AgentSession` 的消息订阅、工具调用与事件规范化；上方相邻密钥管理、IAM 与基础设施；下方相邻 Web 端的 SSE/JSONL 消费与 Inspector UI。`packages/pi-agent` 的 `DefaultResourceLoader` 与 `.pi/skills`、`.pi/prompts` 加载顺序无关，但共享同一项目目录上下文。

## 结论

事实：Pi SDK 提供 `ModelRuntime` 抽象与 `createAgentSession` 入口；项目约定要求 provider key 只驻留在 API 进程；`CapabilityManifest` 与 `RuntimeValidator` 是阻止越权调用的真实代码层。推论：懒加载 provider 客户端可以降低启动耦合，但会把配置错误推迟到首次请求；能力白名单策略会降低配置灵活性，但显著提高安全性。未知：具体 provider SDK 在多 region 部署下的密钥自动切换行为；当 secret manager 不可达时的最佳降级策略是否允许使用本地缓存密钥；这些需要结合具体云厂商 SLA 与合规要求进一步验证。
