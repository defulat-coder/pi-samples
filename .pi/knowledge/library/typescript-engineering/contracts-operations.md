---
type: concept
title: 共享契约：验证与运维视角
description: 用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。用 DTO、schema 和事件联合类型连接 API、Agent 与前端
resource: .pi/knowledge/library/typescript-engineering/contracts-operations.md
tags: [Pi, Agent, Kimi, 知识库, typescript-engineering, contracts, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: typescript-engineering
topic: contracts
variant: operations
---

# 共享契约：用 DTO、Schema 与事件联合类型连接 API、Agent 与前端的验证与运维实践

## 摘要与问题边界

在 TypeScript monorepo 中，API、Agent 运行环境与前端 Web 应用如果各自定义消息结构，任何字段增删、重命名或类型收窄都会在三端同时引发静默失败或线上错误。共享契约通过在 `packages/contracts` 中统一维护 DTO、Zod Schema 与事件联合类型，让 API 的入口校验、Agent 的工具输入输出、前端 SSE 流事件都引用同一份类型真相。本文的视角限定在验证与运维：只讨论如何利用共享契约提升可观测性、失败定位与恢复能力；不讨论业务语义编排、数据库持久化或传输层协议细节；假设运行环境为 Node.js，包管理使用 pnpm，Agent 运行通过 `@earendil-works/pi-coding-agent` 的 `AgentSession` 实现。

## 核心概念与数据模型

1. **DTO（Data Transfer Object）**：位于 `packages/contracts` 的纯 TypeScript 类型，描述 API 请求体、响应体、SSE 事件载荷与工具结果。DTO 与领域模型分离，仅用于进程边界的数据传输。
2. **运行时 Schema**：与每个 DTO 同名共存的 Zod 对象，例如 `PromptRequestSchema`。`z.infer<typeof PromptRequestSchema>` 导出 DTO 类型，保证静态类型与运行时校验同源。
3. **事件联合类型 `AgentEvent`**：所有 SSE 事件统一为以 `kind` 为判别字段的联合类型，包括 `text_delta`、`thinking_delta`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`error`、`done`。前端通过 `switch (event.kind)` 分支处理。
4. **工具契约 `ToolContract`**：每个自定义工具在 `packages/pi-agent` 中通过 `defineTool()` 声明 `name`、`description`、`parameters` schema、`returns` schema。输入与输出 schema 必须直接引用 `packages/contracts` 中的类型。
5. **会话标识与能力注入**：`apps/api` 为每次 Web 会话分配 `sessionId`，并仅注入 `read` 与 `search_knowledge` 两个只读工具；Agent 无权自行声明或扩展其他工具。
6. **版本化契约包**：每个 DTO 文件导出 `CONTRACT_VERSION` 常量。构建流水线校验 API 与 Web 引用的版本号一致；大版本变更时保留旧版本接口直至前端发布完成。

## 设计决策与取舍

### 静态类型与运行时校验双重防御

TypeScript 在编译期消除拼写错误和字段缺失，但无法阻止 LLM 返回非结构化 JSON 或前端发送旧版字段。Zod 在 API 入口和 Agent 工具出口执行二次校验。代价是同一份结构需要定义类型和 schema，但可通过 `z.infer` 和自测脚本避免重复维护。

### 单一 SSE 事件联合类型

API 到 Web 只暴露一条 SSE 流，所有事件类型合并为 `AgentEvent`。这比按不同通道推送更易观测，因为日志中只需按 `kind` 过滤。缺点是事件对象必须携带所有字段的并集，未被使用的字段填充 `undefined` 或 `never`； schema 层面通过 Zod 的 discriminated union 校验具体字段。

### 只读工具集合

项目故意只暴露 `read` 与 `search_knowledge`，避免 LLM 通过工具调用直接写文件或执行命令。这一边界需要 API 显式提供独立的恢复/管理端点，不能依赖 Agent 自行修复错误。

### Schema 下沉到 Contracts 包

`packages/contracts` 被 `apps/api` 和 `packages/pi-agent` 共同依赖，但自身不引入 Pi SDK 或前端 UI 库，从而切断循环依赖。例外是 contracts 包中只放结构，不放业务逻辑；任何转换函数应下沉到对应应用或工具包。

### 显式版本号用于漂移检测

在 API 响应头 `X-Contract-Version` 和事件元数据中暴露版本号。运维侧可以通过对比 API 版本与前端 `package.json` 引用的版本，快速发现构建产物不一致，而不必依赖人工核对。

## 可执行的实施流程

1. 在 `packages/contracts/src` 中定义 DTO 与对应 Zod schema，例如 `PromptRequest`、`PromptResponse`、`AgentEvent`、`ToolResult`。
2. 使用 `z.infer<typeof ...>` 导出 TypeScript 类型，确保 DTO 与 schema 来自同一源码。
3. 在 `apps/api` 的 POST 入口调用 `schema.safeParse()` 校验请求体；失败时返回 400 并将 `zodError` 写入结构化日志。
4. 在 `packages/pi-agent` 注册工具时，把 `parameters` 和 `returns` 绑定到 `packages/contracts` 的 schema。
5. 在 Agent session 订阅中，将 `message_update`、`tool_execution_*` 等 SDK 事件映射为 `AgentEvent`，补充 `sessionId` 与 `timestamp`。
6. 在 `apps/web` 中只消费 `packages/contracts` 的类型，按 `event.kind` 分支渲染；禁止在前端直接引入 Pi SDK 或处理 provider key。
7. 构建流水线执行 `pnpm typecheck` 并在 `packages/contracts` 中增加 schema 与类型差异的单元测试，覆盖有效、缺失、多余字段样本。
8. 部署时比较 API 响应头 `X-Contract-Version` 与前端引用的版本；若不一致触发告警；蓝绿发布时后端先保持旧契约兼容，再升级前端。

## 代码示例：事件契约与校验

以下片段位于 `packages/contracts/src/agent.ts`，展示输入的 schema 定义、处理时的类型分支以及输出的联合事件结构。

    import { z } from "zod";

    export const TextDeltaSchema = z.object({
      kind: z.literal("text_delta"),
      sessionId: z.string(),
      timestamp: z.number(),
      content: z.string(),
    });

    export const ToolExecutionEndSchema = z.object({
      kind: z.literal("tool_execution_end"),
      sessionId: z.string(),
      timestamp: z.number(),
      toolName: z.string(),
      result: z.unknown(),
    });

    export const AgentEventSchema = z.discriminatedUnion("kind", [
      TextDeltaSchema,
      ToolExecutionEndSchema,
      // thinking_delta, tool_execution_start, tool_execution_update, error, done
    ]);

    export type AgentEvent = z.infer<typeof AgentEventSchema>;

输入为 Agent SDK 原始事件与 `sessionId`；处理为通过 `AgentEventSchema.safeParse()` 校验并补充时间戳；输出为前端可安全分支消费的统一 SSE 事件。

## 性能、质量与可观测性指标

1. **请求体解析失败率**：统计 API 日志中 `zodError` 数量除以总请求数。目标值应低于 0.1%，否则说明前端或调用方版本漂移。
2. **事件映射丢帧率**：前端收到无法匹配 `kind` 的事件次数除以总事件数。通过 Web 应用中的 SSE 日志采样测量。
3. **端到端首字延迟（TTFT）**：从 API 收到 POST 到前端收到首条 `text_delta` 的时间差。在 API 日志和前端事件时间戳上计算。
4. **工具输出 schema 校验失败率**：Agent 工具返回结果未通过 `returns` schema 的次数除以工具调用次数。在 `packages/pi-agent` 中记录，用于评估模型对结构约束的遵守度。
5. **版本漂移告警数**：生产环境中 API 响应头 `X-Contract-Version` 与前端部署包版本不一致的次数。通过部署脚本或监控面板统计。

## 失败模式、诊断证据与恢复动作

1. **请求体字段类型漂移**：前端发送旧字段名或错误类型，API 返回 400 并在日志中记录 `zodError.path`。恢复时核对 `pnpm-lock.yaml` 中的 `packages/contracts` 版本，必要时回滚前端或发布兼容 API。
2. **Agent 输出非结构化工具结果**：LLM 返回的结果无法通过 `returns` schema 校验。诊断证据是 `tool_execution_end` 后紧跟 `error` 事件。恢复动作包括收紧提示词格式示例、增加重试以及引入错误 schema 分支。
3. **SSE 事件缺少 `kind` 字段**：前端渲染卡住并出现 `unknown event kind` 计数。恢复时应在 API 事件映射层补全默认 `kind` 并再次校验，同时在前端增加 `unknown` 分支上报。
4. **版本号不一致导致反序列化失败**：API 头 `X-Contract-Version` 与前端版本常量不同。恢复策略是蓝绿发布期间后端保持旧契约可用，待前端完成升级后再下线旧版本。
5. **会话关闭后未释放订阅**：Node 堆内存中 `AgentSession` 实例持续增长。诊断证据是内存快照中会话对象随连接数增加而不下降。恢复动作是在 API 的 `on close` 中调用 `unsubscribe()` 与 `session.dispose()`，并记录 `sessionId` 生命周期日志。

## 问答测试样例

- **正向**：如何测量首字延迟？
  答：API 记录收到 POST 的时间戳，前端记录收到首条 `text_delta` 的时间戳，两者相减。
- **正向**：为什么 `packages/contracts` 不能引入 Pi SDK？
  答：避免 API 与 Agent 包之间的循环依赖，并保证 Web 前端可以安全引用结构类型。
- **边界**：如果 Agent 返回了 schema 未定义的额外字段，会如何处理？
  答：项目默认采用 Zod 的 strip 模式，额外字段被忽略；但会在严格测试模式下触发告警，不会直接信任。
- **边界**：只读工具集合是否意味着 Agent 绝对不能修改文件？
  答：是的，当前只注入 `read` 与 `search_knowledge`；任何写操作必须由 API 的独立端点执行，而非 Agent 工具。
- **无证据**：该共享契约能否支持 10,000 并发？
  答：无法回答，当前设计未经过容量测试，需要补充负载实验与内存/延迟基线。
- **无证据**：LLM 是否总会遵守 schema 约束？
  答：否，schema 只是约束；模型在边缘场景下的合规率属于未知，必须依赖运行时校验与重试。

## 维护、版本、来源与相邻主题

维护层面，每次 `packages/contracts` 变更必须同步更新 `CONTRACT_VERSION`，并执行 `pnpm typecheck` 与 `pnpm test`；contracts 包测试需覆盖有效样本、必填缺失样本与非法类型样本。版本策略采用小版本新增可选字段、中版本修改必填字段、大版本删除字段；大版本通过路径或版本前缀共存。本文内容来源于本项目的 `AGENTS.md`、`packages/contracts` 设计以及 `@earendil-works/pi-coding-agent` 的 SDK 文档；未声称访问任何外部实时系统。相邻主题包括：Pi 集成契约（侧重 session 生命周期与事件订阅）、SSE/JSON 事件协议（侧重传输与序列化）、项目安全与只读能力边界。

## 结论

**事实**：本项目在 `packages/contracts` 中集中维护 DTO、Zod Schema 与事件联合类型；`apps/api` 在入口使用 schema 校验请求；`apps/web` 不直接引入 Pi SDK，仅通过 SSE 消费统一事件；`packages/pi-agent` 只向 Agent 注入 `read` 与 `search_knowledge` 两个只读工具。

**推论**：将 schema 与类型下沉到 contracts 包并显式版本化，能够在 API、Agent 与前端之间降低因字段漂移导致的故障；事件联合类型使单一 SSE 流的日志检索与问题定位更为直接。

**未知**：在特定 LLM 模型与提示词组合下，工具输出 schema 的长期合规率；生产高并发场景下的端到端延迟与内存稳定性；多版本契约长期共存所带来的运维复杂度与回滚成本。这些需要通过持续测试与运行数据补充证据。
