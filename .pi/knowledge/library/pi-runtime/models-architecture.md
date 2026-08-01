---
type: concept
title: ModelRuntime：架构视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。provider、model、凭据和模型能力如何在 API 端被安全配置
resource: .pi/knowledge/library/pi-runtime/models-architecture.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, models, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: models
variant: architecture
---

# ModelRuntime：Pi Agent 运行时中模型、提供方与凭据的 API 侧安全配置架构

## 摘要与问题边界

ModelRuntime 是 Pi Agent 运行时中把「一次 Web 会话请求」安全转换为「一个可执行的模型后端实例」的边界对象。它的责任不是理解用户意图，也不是渲染 UI，而是在 API 进程内完成三件事：选定 provider、绑定具体 model、注入隔离的凭据，并把结果交给 `createAgentSession()`。Web 端只传递 capability profile 与可选的 model hint；provider key、endpoint、配额等敏感信息必须保留在 API 进程内，绝不通过 SSE 或 JSON 返回给浏览器。本文从架构视角描述其接口、责任、决策与可替换性。

## 核心概念与数据模型

1. **ModelRuntimeDescriptor**：由 Web 端提交的轻量 DTO，包含 `providerHint`、`modelHint`、`requiredCapabilities`、`maxTokens`、`thinkingLevel`，本身不含凭据。
2. **ProviderCapabilityManifest**：部署时携带的静态清单，记录每个 provider-model 对的能力位（上下文长度、工具调用、流式输出、思考层级）、配额与端点白名单。
3. **ProviderAdapter**：`packages/pi-agent` 中的具体实现，负责把 descriptor + 凭据翻译为 Pi SDK 所需的 `ModelRuntime` 实例。
4. **CredentialVault**：API 侧的凭据解析层，仅通过环境变量或进程内 secret manager 读取，返回 `CredentialSpec` 对象，不记录、不序列化到日志。
5. **RuntimeFactory**：接收 descriptor 与 vault 输出，执行校验、选型、实例化，失败时抛出可映射为 HTTP DTO 的 `RuntimeConfigurationError`。
6. **SessionCapabilitySnapshot**：会话创建瞬间固化的能力快照，包含实际选用的 provider、model、生效 token 预算与 capability 位掩码，后续 Agent 调用以此为契约。
7. **ModelCapabilityNegotiator**：当 required capabilities 与 model hint 冲突时，按「安全降级、显式拒绝」策略进行协商，而不是静默替换。

## 设计决策与取舍

### 1. 接口先于实现
`packages/contracts` 定义 `IModelRuntimeFactory` 与 `ICredentialVault`，`packages/pi-agent` 提供实现。这样 `apps/api` 只依赖接口，可在不修改路由代码的情况下替换 provider 适配器。

### 2. Capability-driven 而非 model-name-driven
Web 端描述「需要什么能力」，API 端对照 manifest 解析为具体 model。优点是可替换底层模型而不改前端；代价是必须在 manifest 中维护准确的 capability 表。

### 3. 凭据与会话绑定，而非与用户绑定
每个会话独立注入凭据实例，避免长期缓存导致 key 漂移。凭据对象在 factory 内部消费，生命周期与会话一致。

### 4. 静态 manifest 与动态发现分离
Capability 表以部署时 JSON 为准，降低运行时不确定性；动态端点或模型列表仅作为可选项，默认关闭，防止线上配置漂移。

### 5. 错误边界在 API 侧收敛
所有 provider 构造异常由 factory 捕获并映射为不含敏感字段的 DTO。SDK 原始错误中的 endpoint、key 片段在日志中脱敏处理。

### 6. 版本化 runtime 契约
Descriptor 与 snapshot 都带 `schemaVersion`，API 拒绝无法识别的版本，避免新旧部署交叉时出现静默语义变化。

## 可执行的实施流程

1. 在 `packages/contracts` 中定义 `IModelRuntimeFactory`、`IModelRuntimeDescriptor`、`ICredentialVault` 与错误类型。
2. 在 `packages/pi-agent` 实现 Pi SDK 的 `ModelRuntime` 封装，每个 provider 一个 `ProviderAdapter`。
3. 创建 `capability-manifest.json`，列出本地环境支持的 provider-model 组合与能力位。
4. 在 `apps/api` 实现 `EnvCredentialVault`，从 `process.env` 读取 `PROVIDER_<NAME>_API_KEY` 等变量。
5. 编写 `RuntimeFactory`，在校验 descriptor 版本后查询 manifest、匹配 model、注入凭据并构造 runtime。
6. 为 API 路由增加请求校验：required capabilities 必须是 manifest 中存在的子集。
7. 接入 observability 钩子：记录 runtime 构造耗时、token 预算、provider 命中、失败原因码。
8. 编写集成测试：覆盖凭据缺失、capability 不匹配、manifest 版本过旧、provider 超时四类场景。
9. 在 Web 端移除所有直接引用 provider key 或 model endpoint 的代码，仅保留 capability profile 提交。
10. 建立 manifest 变更审查清单，每次新增 model 必须同步更新 capability 与凭据变量名。

## 配置与调用示例

```typescript
// packages/pi-agent/src/runtime-factory.ts
interface ModelRuntimeDescriptor {
  schemaVersion: 'v1';
  providerHint?: string;
  modelHint?: string;
  requiredCapabilities: ('tool-use' | 'streaming' | 'thinking')[];
  maxTokens: number;
  thinkingLevel?: 'none' | 'low' | 'high';
}

export class RuntimeFactory implements IModelRuntimeFactory {
  constructor(
    private manifest: ProviderCapabilityManifest,
    private vault: ICredentialVault
  ) {}

  async create(descriptor: ModelRuntimeDescriptor) {
    if (descriptor.schemaVersion !== 'v1') {
      throw new RuntimeConfigurationError('unsupported_schema');
    }
    const candidate = this.manifest.resolve(descriptor);
    const credential = await this.vault.get(candidate.providerId);
    const runtime = createAgentRuntime(candidate, credential);
    return { runtime, snapshot: candidate.toSnapshot() };
  }
}
```

输入：Web 提交的 descriptor（无凭据）。处理：factory 校验版本、解析 manifest、匹配 provider-model、从 vault 取凭据、构造 Pi SDK runtime。输出：API 内部使用的 runtime 实例与可返回给前端的 snapshot（仅含 provider/model/capability，不含凭据）。

## 性能、质量与可观测性指标

1. **runtime 构造延迟**：从 descriptor 到可用 `ModelRuntime` 的时间，目标 P99 < 50 ms，在 factory 出口打点测量。
2. **凭据解析延迟**：vault.get 耗时，目标 P99 < 10 ms；若使用远程 secret manager 则增设缓存与告警。
3. **capability 不匹配率**：required capabilities 与 resolved model 的位掩码差异事件数，按天统计。
4. **provider 错误率**：构造失败 / 首 token 失败 / SSE 断连的比例，按 provider 与 model 维度分组。
5. **token 预算越界率**：实际请求 `maxTokens` 超过 model 上下文窗口或项目配额的占比。
6. **敏感信息泄露事件数**：通过日志扫描检测 key、endpoint、Authorization 头等字段是否意外落盘。

## 失败模式、诊断证据与恢复动作

1. **凭据缺失**
   - 证据：`RuntimeConfigurationError` 错误码 `credential_not_found`，vault 返回 undefined。
   - 恢复：检查对应 provider 的环境变量是否注入；重启 API 进程以重新加载 env。

2. **Capability 不匹配**
   - 证据：descriptor 要求 `tool-use` 但 manifest 显示该 model 不支持。
   - 恢复：返回 400 并提示前端调整 capability profile；或更新 manifest 启用更高能力模型。

3. **Model hint 解析失败**
   - 证据：`model_not_found`， manifest 中不存在该 model。
   - 恢复：若开启 capability fallback 则按能力匹配替代模型；否则显式拒绝。

4. **Provider 端点不可达**
   - 证据：factory 构造成功但首 token 超时，网络错误日志中出现 connect timeout。
   - 恢复：切到备用 provider；检查端点白名单与代理配置。

5. **Token 预算越界**
   - 证据：`maxTokens` 大于 manifest 中该 model 的 `maxContextWindow`。
   - 恢复：API 自动截断到上限并记录审计事件；或拒绝请求让前端调整。

6. **Manifest 版本漂移**
   - 证据：descriptor `schemaVersion` 高于 API 支持的版本。
   - 恢复：返回 400 `unsupported_schema`；同步更新 contracts 与前端代码。

## 问答测试样例

1. **正向**：哪些字段应该出现在 `ModelRuntimeDescriptor` 中但不能包含凭据？
   - 答：`providerHint`、`modelHint`、`requiredCapabilities`、`maxTokens`、`thinkingLevel`、`schemaVersion`。

2. **正向**：API 如何选择具体 model？
   - 答：根据 descriptor 的 capability profile 查询 `ProviderCapabilityManifest`，匹配支持全部 required capabilities 且 token 预算充足的 provider-model 组合。

3. **边界**：如果 Web 端同时传了 providerHint 和 modelHint，但二者在 manifest 中不匹配怎么办？
   - 答：factory 优先校验 modelHint 的 capability；若 modelHint 不满足 required capabilities 则按安全策略拒绝，而不是静默忽略 providerHint。

4. **边界**：凭据是否可以在多个会话之间共享同一个实例？
   - 答：不建议。每个会话应独立从 vault 获取凭据，避免实例状态漂移与 key 作用域扩大。

5. **无证据拒答**：某个 provider 的 endpoint 是否支持 IPv6？
   - 答：未在 capability manifest 或网络配置中声明，无法回答。

6. **无证据拒答**：Pi SDK 的 `createAgentSession()` 内部是否缓存了 provider key？
   - 答：这是 SDK 实现细节，本架构文档未提供可验证信息，不能推断。

## 维护、版本、来源与相邻主题

- **维护**：`capability-manifest.json` 与 `packages/contracts` 的接口变更必须同步升级 `schemaVersion`；新增 provider 时需同步更新 `.env.example`、凭据注入脚本与集成测试。
- **版本**：ModelRuntime descriptor 与 snapshot 使用显式 `schemaVersion`，API 拒绝不兼容版本，防止新旧 Web 部署混用导致 capability 语义变化。
- **来源**：核心概念来自 `@earendil-works/pi-coding-agent` SDK 的 `createAgentSession()` 与 `ModelRuntime` 配置契约，以及本项目 `packages/pi-agent` 的封装层。未引入外部未验证的 provider 文档。
- **相邻关系**：
  - 与 `AgentSession`：`ModelRuntime` 是构造 `AgentSession` 的输入之一。
  - 与 `SessionManager`：session 创建后由 `SessionManager.inMemory()` 持有，runtime 实例随 session 生命周期释放。
  - 与 `DefaultResourceLoader`：resource loader 提供项目级 skills/prompts，不替代理 model 选择。
  - 与 `Custom Tools`：tool 定义由 Pi SDK 的 `defineTool()` 完成；runtime 的 capability 决定了 tool 调用是否可被模型执行。
  - 与 API 路由：路由负责校验 descriptor 与身份，但不包含语义 pre-routing；model 选择交给 factory。

## 结论

- **事实**：ModelRuntime 负责把 descriptor 转换为 Pi SDK 可执行的 provider/model/凭据三元组；凭据只存在于 API 进程；Web 端只传 capability profile。
- **推论**：将 factory、vault、manifest 分离后，可以在不修改 Web 代码的前提下替换底层 provider 或模型；capability-driven 选型的可维护性优于硬编码 model name。
- **未知**：具体 provider 在高压并发下的连接池行为、Pi SDK 内部是否对凭据做额外缓存、以及不同 thinkingLevel 在流式输出中的事件顺序细节，需要针对实际部署进行压测与源码验证后才能确定。
