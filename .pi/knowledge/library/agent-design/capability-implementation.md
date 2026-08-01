---
type: concept
title: 能力注入：实现视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。只给 Agent 当前任务需要的最小能力，避免无限工具集合
resource: .pi/knowledge/library/agent-design/capability-implementation.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, capability, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: capability
variant: implementation
---

# 能力注入：为 Agent 按任务注入最小工具集

## 摘要与问题边界

能力注入指在单次会话或单次请求前，只把当前任务确实需要的工具、权限与上下文装配进 Agent 运行时，而不是把所有可用工具一次性暴露给模型。问题边界限定在 TypeScript 实现的 Agent 会话层：本仓库 `packages/pi-agent` 负责构造 `AgentSession`，`apps/api` 负责身份与会话，二者都不对自然语言做语义路由，而是依赖显式声明的能力清单决定工具可见范围。本方案不讨论如何让模型“自觉”少调用工具，而是讨论宿主代码如何在调用 `session.prompt()` 之前收窄能力集合，并在调用结束后撤销。

## 核心概念与数据模型

1. **能力元语 `CapabilityPrimitive`**：包含稳定标识符 `capabilityId`、机器可读的 JSON Schema 参数描述、执行器 `execute(args)` 以及副作用级别（`read`/`idempotent-write`/`destructive-write`）。一个元语只能对应一个最小原子能力，禁止把“读文件”和“写文件”合并成同一个元语。
2. **能力契约 `CapabilityContract`**：记录每个元语的输入模式、输出模式、幂等性、超时时间、可重试策略以及是否依赖外部网络。契约是注入前的验证依据，缺少契约或契约版本不匹配的工具不得注入。
3. **当前能力集 `ActiveCapabilitySet`**：表示某次 `prompt` 调用时实际挂载到会话的工具映射。它必须是一个可枚举、可比较、可快照的纯数据结构，不能引用全局可变注册表。
4. **任务能力清单 `TaskCapabilityManifest`**：由调用方或上游编排器提交的声明，列出本次任务所需的最小 `capabilityId` 集合以及每个能力所需的参数范围。清单采用显式白名单，未列出的能力即使存在也不得注入。
5. **能力解析器 `CapabilityResolver`**：输入为任务清单与全局注册表，输出为当前能力集。解析器负责版本匹配、依赖展开、冲突检测和降级选择，不执行任何工具逻辑。
6. **能力生命周期 `CapabilityLifecycle`**：包含 `declare`（声明）、`resolve`（解析）、`validate`（校验）、`inject`（注入）、`invoke`（调用）、`revoke`（撤销）、`dispose`（释放）七个阶段，每个阶段必须生成结构化日志或事件，供审计与排障使用。

## 设计决策与取舍

### 声明式清单还是命令式注入
选择声明式清单作为唯一入口。命令式注入虽然灵活，但会把能力扩散到业务代码各处，难以在 `apps/api` 做统一审查。代价是调用方必须提前知道任务需要什么工具，因此需要在任务编排层维护一份能力模板。

### 静态注入还是运行时推导
默认采用静态注入：在 `session.prompt()` 之前根据清单完成挂载。运行时推导仅用于极少数需要上一步模型输出才能确定下一步工具的场景，且推导结果必须再次经过解析器校验。静态方案更容易审计，运行时方案更容易导致工具集合膨胀，所以被限制为可选扩展。

### 只读工具与写工具隔离
读工具与写工具必须分属不同能力元语，写工具默认不注入。若任务清单包含写能力，`CapabilityResolver` 需要额外检查本次会话是否带有写授权令牌，否则解析阶段直接失败。这种隔离让误注入写工具变成可观测事件，而不是潜在风险。

### 白名单还是黑名单
强制白名单。黑名单无法处理新增工具带来的未知风险，且模型名称变化会让黑名单失效。白名单的代价是每新增一类任务都要更新清单，但可通过项目级能力模板复用。

### 集中注册表还是包级注册
全局注册表只保存工具契约与工厂函数，不保存实例。实际执行器按包隔离注册，例如 `.pi/skills` 下由 Skills CLI 安装的技能只能在各自命名空间注册能力，解析器通过 `namespace:capabilityId` 前缀避免冲突。

## 可执行的实施流程

1. **定义工具契约**：为每个工具编写 JSON Schema 与副作用级别，存入 `packages/pi-agent/src/capabilities/contracts/`。
2. **实现执行器工厂**：每个能力提供一个无状态工厂函数，输入配置对象，返回实现 `CapabilityPrimitive` 的对象。
3. **建立全局能力注册表**：在启动时读取所有契约与工厂，按 `namespace:capabilityId` 索引，注册表本身不可在运行时写入。
4. **设计任务清单 Schema**：包含 `taskId`、`requiredCapabilities`（数组，每项带 `capabilityId` 与可选参数约束）、`maxTokens`、`thinkingLevel` 等字段。
5. **实现 `CapabilityResolver`**：解析清单时检查能力是否存在、版本是否兼容、是否有未满足的依赖、是否存在权限冲突。
6. **注入会话前快照**：在调用 `session.prompt()` 之前，使用 `resolver.resolve(manifest)` 得到 `ActiveCapabilitySet`，并调用 `session.injectCapabilities(set)` 挂载。
7. **执行时校验调用参数**：工具执行器在真正运行前使用 JSON Schema 再次校验参数，超出清单声明范围的参数直接拒绝。
8. **调用后撤销与释放**：`prompt` 返回或异常后，调用 `session.revokeCapabilities()`，解除工具绑定并清理执行器持有的临时资源，最后写入审计日志。
9. **发布审计事件**：将 `resolve`、`inject`、`revoke` 事件通过 SSE 推送到 `apps/web`，让前端 Inspector 可以实时查看当前挂载了哪些工具。
10. **回归测试模板**：每次新增能力时，必须更新 `packages/pi-agent/__tests__/capability-injection.spec.ts`，验证最小清单能跑通、越权清单被拒绝、空清单不会导致崩溃。

## 示例：本地文件知识库的最小能力注入

输入：用户请求要求 Agent 根据本地 Markdown 知识库回答技术问题，本次任务不需要写文件，也不需要访问外部网络。任务清单如下：

    taskId: "kb-answer-001"
    requiredCapabilities:
      - capabilityId: "project:read_file"
        allowedPaths: [".pi/knowledge/**", "docs/**"]
        readOnly: true
      - capabilityId: "project:search_knowledge"
        allowedNamespaces: ["project"]
    deniedCapabilityPatterns:
      - "*:write_*"
      - "*:network_*"

处理：API 收到请求后，先通过 `CapabilityResolver` 解析清单。解析器发现 `project:read_file` 与 `project:search_knowledge` 均存在于注册表，且副作用级别为 `read`；同时清单通过 `deniedCapabilityPatterns` 显式排除了所有写能力和网络能力，因此解析器生成的 `ActiveCapabilitySet` 只包含这两个能力。

输出：挂载后的 `AgentSession` 只能调用这两个工具。若模型试图调用未注入的写文件工具，运行时会返回工具不可用的结构化错误，而不是让调用穿透到操作系统。审计日志记录如下：

    {
      "event": "capability_injected",
      "taskId": "kb-answer-001",
      "injected": [
        "project:read_file",
        "project:search_knowledge"
      ],
      "excludedByPattern": [
        "project:write_file",
        "project:network_fetch"
      ],
      "timestamp": "2025-06-01T12:00:00Z"
    }

## 性能、质量、可观测性指标

1. **能力命中率**：实际挂载的能力中被模型调用的比例。通过审计日志统计，目标高于 70%，过低说明清单过大。
2. **注入延迟**：从解析清单到完成挂载的耗时。在 `packages/pi-agent` 单元测试中测量，目标 p99 小于 10 毫秒。
3. **工具越权调用率**：每万次调用中被执行器拒绝的未注入或超范围调用占比。目标为 0，任何非零值都是安全事件。
4. **会话能力集大小**：单次 `prompt` 挂载的平均能力数。监控目标是随任务增长而非线性增长，避免“无限工具集合”。
5. **撤销完成率**：调用结束后成功执行 `revokeCapabilities()` 的比例。通过审计事件统计，目标 100%，未撤销会留下权限残留。
6. **清单解析失败率**：因版本不匹配、依赖缺失、权限冲突导致解析失败的请求占比。该指标用于发现注册表与清单不同步。

## 失败模式、诊断证据与恢复动作

1. **缺失能力**：解析器报 `CapabilityNotFoundError: project:read_file`。诊断证据是日志中 `missing` 字段非空。恢复动作：检查契约文件是否已注册，或更新任务清单移除该能力。
2. **越权注入**：审计日志发现写能力被注入到只读任务。诊断证据是 `injected` 列表中包含 `write` 级别能力。恢复动作：立即终止会话，检查 `deniedCapabilityPatterns` 与解析器权限校验逻辑。
3. **能力残留**：`revokeCapabilities()` 后再次调用会话仍能触发旧工具。诊断证据是两次 `prompt` 之间的 `injected` 集合未清空。恢复动作：在 `revoke` 后增加断言，强制释放执行器引用。
4. **解析器歧义**：同一 `capabilityId` 在多个命名空间注册，清单未指定命名空间导致解析失败。诊断证据是 `AmbiguousCapabilityError`。恢复动作：要求清单使用完整 `namespace:capabilityId`，并在注册表启动时检测重复。
5. **参数越界**：模型调用 `read_file` 时传入不在 `allowedPaths` 中的路径。诊断证据是执行器日志中的 `ParameterOutOfScope` 错误。恢复动作：执行器拒绝调用并返回结构化错误，同时前端提示任务清单需要扩展路径范围。

## 问答测试样例

1. **正向问题**：本次任务需要读取 `docs/pi-agent-learning.md`，能力清单应如何编写？
   答案：在 `requiredCapabilities` 中列出 `project:read_file`，并设置 `allowedPaths: ["docs/**"]`。

2. **边界问题**：任务需要同时读取 `.pi/knowledge` 与 `node_modules` 中某个文档，但清单只声明了前者，会发生什么？
   答案：对 `node_modules` 的调用会被执行器以参数越界拒绝，并记录审计事件。

3. **边界问题**：清单为空数组，模型是否还有可用工具？
   答案：没有。会话将以零工具启动，模型只能依赖系统提示中的上下文作答。

4. **无证据拒答**：如果任务清单声明了 `project:network_fetch`，但注册表中不存在该能力，应如何响应？
   答案：解析阶段直接返回 `CapabilityNotFoundError`，不进入 `prompt` 阶段。

5. **无证据拒答**：如果模型声称自己需要写权限，但任务清单未声明，能否临时注入？
   答案：不能。任何运行时注入请求必须重新经过解析器与授权校验，模型输出不能作为注入依据。

6. **边界问题**：同一 `capabilityId` 在两个命名空间都存在，清单只写短名会怎样？
   答案：解析器抛出 `AmbiguousCapabilityError`，要求使用完整 `namespace:capabilityId`。

## 维护、版本、来源与相邻主题

能力契约与任务清单需要版本化。建议把清单 Schema 版本写入 `capabilityManifestVersion` 字段，与 `packages/pi-agent` 主版本对齐；当 Schema 发生破坏性变更时，旧版本清单应能在解析器中收到 `ManifestVersionMismatch` 错误。来源上，本仓库通过 `.pi/skills`、`.pi/prompts` 与 `AGENTS.md` 注入项目级上下文，其中 `.pi/skills` 提供额外能力契约，`.pi/prompts` 提供任务模板，`AGENTS.md` 声明安全边界。能力注入与相邻主题的关系如下：它位于工具注册（下层）与提示模板（上层）之间，向下消费工具契约，向上被任务清单驱动；它与“Agent 信任边界”紧密相关，但本身不提供沙箱，沙箱隔离需要宿主进程与权限系统实现。

## 结论：事实、推论与未知

**事实**：本仓库通过 `CapabilityResolver` 与 `ActiveCapabilitySet` 把工具挂载限制在任务清单声明的最小集合内；写工具默认不注入，撤销阶段必须释放资源；所有注入与撤销事件均写入审计日志并可被前端 Inspector 消费。

**推论**：收窄能力集合能够降低模型误调用风险、减少 token 占用、让调用链更容易审计；声明式清单比命令式注入更适合多任务 Web 服务。

**未知**：当任务本身需要在多步之间动态切换能力集合时，注入的最优粒度与切换开销之间的平衡点尚需在真实 workload 下测量；模型在工具受限时是否会出现规划质量下降，也需要针对本仓库的本地知识库场景进行专项评估。
