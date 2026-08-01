---
type: concept
title: 共享契约：架构视角
description: 用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。用 DTO、schema 和事件联合类型连接 API、Agent 与前端
resource: .pi/knowledge/library/typescript-engineering/contracts-architecture.md
tags: [Pi, Agent, Kimi, 知识库, typescript-engineering, contracts, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: typescript-engineering
topic: contracts
variant: architecture
---

# 共享契约：以DTO、Schema与事件联合类型贯通API、Agent与前端的TypeScript工程实践

## 摘要与问题边界

在同时包含HTTP API、Agent事件流和浏览器前端的TypeScript系统中，共享契约指被所有边界共同承认的消息结构与版本承诺。它要解决的问题不是“如何写类型”，而是“多个独立演进的生产者与消费者如何在不必同时部署的前提下，对同一份消息语义保持一致理解”。其边界止于消息形状的约定：约束字段、类型、可选性、事件种类与错误格式，但不保证业务规则正确，也不替代领域模型中的行为设计。若将契约与业务逻辑混为一谈，会导致边界层膨胀、领域泄漏与版本协商困难。

## 核心概念与数据模型

1. **契约（Contract）**：跨越进程或团队边界的消息形状承诺。一份契约必须明确字段、类型、可空性、默认值、错误响应格式及废弃策略；未写入契约的字段对消费者不可见，即使服务端物理存储中存在。

2. **DTO（Data Transfer Object）**：专用于序列化边界的不可变数据结构。DTO只承载状态，不封装行为；它与领域实体的关键区别在于是否允许包含运行时无法序列化的类型，例如类实例、闭包或循环引用。

3. **Schema**：机器可执行的结构约束，优先作为生成TypeScript类型的单一来源。Schema不仅用于编译期类型，更用于运行期验证、OpenAPI生成、测试固件和文档同步；当schema与手写类型并存时，schema为准。

4. **事件联合类型（Discriminated Union Events）**：用固定discriminator字段区分不同事件种类的类型级机制。每个事件kind值在全局命名空间中必须唯一，以避免运行时路由错误和TypeScript收窄失效。

5. **边界适配层（Adapter/Port）**：将契约映射到具体运行时对象的可替换接口。API控制器、Agent会话、前端store都不应直接依赖schema库的内部结构，而应通过适配器消费已验证的契约类型。

6. **版本化契约视图（Versioned Contract View）**：为每个消费者群体提供稳定承诺的契约切片。服务端可以新增字段，但已发布的视图在major版本不变时不得删除、重命名或改变现有字段语义。

## 设计决策与取舍

### Schema生成类型还是手写类型优先
优先以schema生成TypeScript类型，这能消除服务端改字段后前端类型未更新的常见漂移。代价是当schema工具不支持某些高级类型模式时，需要调整设计而非绕过生成器。例外：纯内部工具函数可使用手写类型，但不得跨越边界。

### 前端是否直接消费API DTO
不建议前端直接消费原始API DTO。API DTO倾向于反映服务端视角，常包含前端不需要的内部标识、审计字段或嵌套关系。应通过视图DTO或适配器映射为前端专用形状，以隔离后端重构对UI代码的影响。代价是引入映射函数，需在性能敏感路径测量其开销。

### 事件流采用单一Topic还是多Topic
Agent事件流在规模可控时优先使用单一逻辑topic配合discriminator过滤，这能避免新事件种类导致订阅方遗漏。当消费者数量巨大且事件种类差异显著时，再拆分为多topic以提升过滤效率。拆分后必须在契约中声明topic与kind的对应关系，防止路由漂移。

### Agent是否复用API契约
Agent事件与API请求响应不应默认复用同一份DTO。Agent语义通常包含session生命周期、流式片段、工具调用元数据等额外上下文，强复用会导致DTO字段含义模糊。正确做法是在contracts包内定义独立但可引用的primitive类型，例如`SessionId`、`Timestamp`。

### 错误响应是否统一Schema
跨边界错误响应应统一顶层结构，例如`{ success: false, error: { code, message, details } }`，但允许details字段保留源系统特有的结构。统一顶层使客户端能编写通用错误处理分支；保留details则避免为每个错误源强行泛化，导致诊断信息丢失。

## 可执行的实施流程

1. 绘制所有边界交叉点，列出每个方向上交换的消息名称、频率和变更历史。
2. 在monorepo中创建独立的`packages/contracts`，只依赖schema库与TypeScript，不依赖框架运行时。
3. 选择schema工具并定义primitive、request、response、event四类源文件，命名与目录结构反映边界方向。
4. 配置从schema生成类型的脚本，并在CI中禁止任何包直接导入schema内部辅助函数。
5. 为API、Agent、前端分别建立适配器目录，适配器接口以contracts导出的类型为输入和输出。
6. 为每个事件定义全局唯一的kind值，建立kind注册表并在测试中对重复值报错。
7. 制定版本策略：additive变更升级minor，breaking变更升级major，文档或修正升级patch；每次发布前生成契约变更日志。
8. 在CI中运行类型漂移检测、schema快照测试和跨包循环依赖检查。
9. 在生产环境启用消息验证埋点，记录验证失败、未知字段和版本协商结果。
10. 为每个消费者维护兼容性矩阵，明确其消费的契约版本范围与废弃窗口。

## 输入、处理与输出示例

```typescript
// packages/contracts/src/agent-events.ts
import { z } from 'zod';

export const TextDeltaEvent = z.object({
  kind: z.literal('text_delta'),
  sessionId: z.string().uuid(),
  payload: z.object({ content: z.string() })
});

export const ToolStartEvent = z.object({
  kind: z.literal('tool_execution_start'),
  sessionId: z.string().uuid(),
  payload: z.object({ toolName: z.string(), args: z.record(z.unknown()) })
});

export const AgentEvent = z.discriminatedUnion('kind', [
  TextDeltaEvent,
  ToolStartEvent
]);

export type AgentEvent = z.infer<typeof AgentEvent>;
```

输入是SSE流中的JSON行，例如`{ "kind": "text_delta", "sessionId": "...", "payload": { "content": "hi" } }`。API层使用`AgentEvent.parse`完成运行期验证，并生成类型安全的联合类型对象。前端订阅SSE后，通过`switch (event.kind)`进行TypeScript收窄，分别更新消息列表或工具调用面板。输出是UI状态变更、日志记录和错误边界触发条件，所有下游逻辑不再重新验证kind字段。

## 性能、质量和可观测性指标

1. **契约变更检测周期**：从schema源文件修改到CI报告消费者影响的时间，目标小于5分钟。通过CI pipeline时长和通知发送时间戳测量。
2. **类型错误逃逸率**：生产环境中因契约不匹配导致的运行时验证失败数除以总消息数，通过API中间件和Agent会话中的验证计数器计算。
3. **跨边界序列化开销**：消息平均体大小和单次`JSON.parse`加schema解析耗时，通过服务端metrics采样测量；超过P99阈值时触发告警。
4. **契约版本兼容覆盖率**：已声明版本协商路径的边界数除以总边界数，通过扫描contracts包导出和适配器实现统计。
5. **消费者迁移延迟**：新major版本发布后，所有消费者完成升级的日历天数，通过仓库PR合并时间和依赖更新提交记录测量。

## 失败模式与恢复

1. **Schema漂移**。证据：运行时发现前端访问了契约中不存在的字段，或schema快照测试失败。恢复：若未正式发布则回滚schema变更；若已发布则升级major版本并同步所有消费者。
2. **事件discriminator冲突**。证据：两个事件kind值相同，导致switch分支进入错误处理或TypeScript收窄不彻底。恢复：将kind改为带命名空间前缀的全局唯一值，并在CI注册表检查中阻止重复。
3. **适配器绕过**。证据：边界层代码直接引用schema库的内部类型或验证辅助函数。恢复：将schema内部导出标记为`@internal`，并通过ESLint禁止跨包导入非公开导出。
4. **循环依赖**。证据：`packages/contracts`内子模块互相引用，导致构建失败或类型检查性能急剧下降。恢复：拆出`packages/contracts-primitives`，并运行DAG验证脚本确保依赖单向。
5. **版本协商失败**。证据：旧客户端收到新字段后崩溃，或服务端返回不识别的错误码。恢复：在响应头暴露`x-contract-version`，客户端根据版本号选择解析路径或进入降级模式。

## 问答测试样例

1. 共享契约的核心目标是什么？答：为API、Agent与前端提供单一、可验证的消息结构真相，使各方独立演进时仍保持一致理解。
2. DTO与领域模型的根本区别是什么？答：DTO仅承载可序列化数据，不封装行为；领域模型包含不变式和业务行为。
3. Agent事件是否必须复用API响应DTO？答：否。当语义字段差异显著时，应定义独立事件契约，仅复用primitive类型。
4. 生成类型后能否手写覆盖以支持复杂类型？答：不能。手写覆盖破坏单一来源原则，应通过schema扩展、branded type或适配器映射解决。
5. 如何处理breaking change？答：升级major版本，维护兼容性层，并在消费者完成迁移后废弃旧版本。
6. 共享契约能否保证业务逻辑正确？答：不能回答。契约只约束消息结构，不验证业务规则本身；需要领域层测试和端到端测试补充。

## 维护、版本、来源与相邻关系

`packages/contracts`由跨功能架构组维护，变更前需运行影响范围脚本识别受影响的API、Agent与前端包。版本号遵循语义化版本，但对外发布前需额外声明“契约兼容级别”：additive、deprecation或breaking。契约来源文件是schema源与自动生成的TypeScript类型声明；文档由schema注释和OpenAPI导出共同生成。本主题与API设计、事件驱动架构、TypeScript类型系统、测试策略和monorepo治理相邻；与ORM实体定义、数据库迁移、UI组件样式等主题边界清晰，不应混为一谈。

## 结论

事实：在TypeScript工程实践中，DTO、schema与事件联合类型是表达共享契约的有效工具；将schema作为类型生成源能显著降低跨边界类型漂移的概率。推论：把契约包独立为边界层的首要依赖，并前置定义适配器接口，能够在长期演进中减少同步部署成本和意外破坏。未知：在超大规模仓库中，schema生成对CI构建时间和IDE类型检查性能的具体影响仍需项目级基准测试；不同前端框架和运行环境对运行时验证开销的容忍阈值也无法预先给出通用数值。
