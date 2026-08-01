---
type: concept
title: 共享契约：实现视角
description: 用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。用 DTO、schema 和事件联合类型连接 API、Agent 与前端
resource: .pi/knowledge/library/typescript-engineering/contracts-implementation.md
tags: [Pi, Agent, Kimi, 知识库, typescript-engineering, contracts, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: typescript-engineering
topic: contracts
variant: implementation
---

# TypeScript 共享契约：用 DTO、Schema 与事件联合类型连接 API、Agent 与前端

## 摘要与问题边界

共享契约是把 API、Agent 运行时与前端置于同一数据边界的 TypeScript 工程实践。它通过 DTO、运行时 schema 和事件联合类型，把跨进程传输的结构固化成可版本化的知识单元。边界清晰：只约束输入、输出、错误和生命周期事件的数据形状，不约束内部算法或业务规则；只在编译期提供类型，运行时仍需 schema 校验；不替代 API 文档，但要求文档与代码同源。超出这四类结构（输入、输出、错误、事件）的领域概念，不应进入契约包。

## 核心概念与数据模型

1. 输入 DTO：描述 API 或 Agent 接收的原始载荷。所有字段必须显式声明必填或可选，例如会话 ID 为 UUID 字符串，消息体长度限制在 1 到 4096 字符，思考级别为枚举或缺失。输入 DTO 不携带默认值，默认值属于服务端逻辑。

2. 输出 DTO：描述成功场景返回的结构。它是总响应的子集，与错误结构互斥。输出字段不包含内部追踪 ID、日志级别或调试堆栈，这些信息属于可观测性层。

3. 错误 DTO：描述可预期的失败。必须区分业务错误与系统错误，错误码为字符串常量，禁止动态拼接，以便前端和 Agent 穷尽匹配。

4. Schema 派生类型：使用 Zod 或 Valibot 定义运行时 schema，并通过 `z.infer` 派生 TypeScript 类型。类型必须单向派生：从 schema 到类型，不能把类型当 schema 实现，确保运行时校验与编译时类型同源。

5. 事件联合类型：SSE 或 WebSocket 消息使用 `type` 字段作为判别标签，每个分支携带不同 payload。分支必须穷尽，禁止 `any`。新增事件类型必须同步更新联合类型，否则 TypeScript 暴露未处理分支。

6. 契约版本戳：每个契约文件包含版本标识，由主版本、源文件哈希和修改日期组成。版本戳用于检测三方契约是否来自同一次构建，不替代语义化版本，只用于定位问题。

## 设计决策与取舍

1. 单契约包还是多契约包：monorepo 中推荐集中到一个 `packages/contracts` 包，降低循环导入风险，但会增加无关模块的构建依赖。若某领域契约频繁变更，可拆分为 `contracts-api` 与 `contracts-agent`，但拆分后禁止跨包导入具体实现，只能导入类型和 schema。

2. 运行时解析还是类型断言：必须选择运行时解析。`as T` 在跨进程边界上是错误的，因为数据来自外部进程，TypeScript 无法验证。使用 `schema.parse` 后再进入业务逻辑。性能成本是边界上一次解析，收益是避免数据污染向下传播。

3. 严格剔除还是透传未知字段：默认应剔除未知字段。`z.object({}).strict()` 或 `strip` 行为确保 Agent 不会泄露未声明字段给前端，也防止前端发送未声明字段给 API。只有在明确扩展点（如插件元数据）时才使用 `passthrough`，且必须文档化。

4. 事件命名采用点分域动作：事件类型使用 `domain.action.state` 三段式，例如 `session.message.received`、`tool.execution.start`、`lifecycle.close.completed`。三段式便于检索器按前缀召回，也便于 Agent 按事件族批量订阅。禁止在同一域内混用过去分词与现在分词。

5. 版本策略采用源签名优先：每次发布计算契约文件内容哈希，写入构建产物。三方在启动时对比本地哈希与服务端暴露哈希，不一致时拒绝启动或发出警告。语义化版本用于对外发布，哈希用于内部一致性校验。

## 可执行的实施流程

1. 定义请求 schema：列出调用方字段，确定必填与可选，标注长度、枚举和格式约束，不添加默认值。

2. 定义响应 schema：只包含调用方需要消费的成功字段，排除内部标识、堆栈和日志。

3. 定义错误 schema：区分业务错误与系统错误，错误码使用常量字符串，payload 包含 `code` 和 `message`。

4. 定义事件联合类型：以 `type` 为判别标签，列出所有分支，每个分支声明明确 payload，禁止 `any` 或裸对象。

5. API 入口解析输入：收到请求后先调用 `RequestSchema.safeParse`，失败返回 400 并附带结构化错误 DTO，不进入业务逻辑。

6. Agent 生成事件序列：Agent 运行时调用工具或产生文本时，统一使用事件工厂函数构造联合类型实例，确保 `type` 字段与 schema 一致。

7. 前端消费 SSE 流：按行读取 SSE 数据，通过 `EventSchema.safeParse` 校验，未识别事件类型进入未知事件处理分支，记录但不抛错。

8. 运行类型检查与回归测试：执行 `tsc --noEmit` 和契约测试，覆盖所有事件分支、错误分支和字段边界。

## 输入、处理与输出示例

以下片段贴近 Web、Agent 与本地文件知识库场景：

    export const QueryRequestSchema = z.object({
      sessionId: z.string().uuid(),
      query: z.string().min(1).max(2048),
      knowledgeBases: z.array(z.string().max(64)).max(8).optional(),
    });

    export const QueryResponseSchema = z.object({
      answer: z.string(),
      sources: z.array(z.object({
        path: z.string(),
        relevance: z.number().min(0).max(1),
      })),
    });

    export const QueryErrorSchema = z.discriminatedUnion('code', [
      z.object({ code: z.literal('SESSION_NOT_FOUND'), sessionId: z.string() }),
      z.object({ code: z.literal('KNOWLEDGE_BASE_INVALID'), path: z.string() }),
      z.object({ code: z.literal('QUERY_TOO_LONG'), maxLength: z.number() }),
    ]);

    export const QueryEventSchema = z.discriminatedUnion('type', [
      z.object({ type: z.literal('chunk.delta'), text: z.string() }),
      z.object({ type: z.literal('source.found'), path: z.string(), score: z.number() }),
      z.object({ type: z.literal('lifecycle.complete') }),
      z.object({ type: z.literal('lifecycle.error'), error: QueryErrorSchema }),
    ]);

输入是调用方 JSON，包含 `sessionId`、`query` 和可选知识库列表。处理阶段由 API 使用 `QueryRequestSchema.safeParse` 解析，Agent 检索本地文件并产生 `chunk.delta` 或 `source.found` 事件。输出是 SSE 流，前端用 `QueryEventSchema` 反序列化，得到结构化答案或错误。

## 性能、质量与可观测性指标

1. 类型检查耗时：测量 `tsc --noEmit` 在契约包上的耗时。目标值低于 5 秒；若超过 15 秒，说明联合类型嵌套过深或存在循环类型引用。

2. 运行时解析失败率：在 API 入口记录 `safeParse` 失败的请求比例。预期接近 0%；若单日超过 0.1%，说明版本漂移。

3. 事件端到端延迟：从 Agent 生成事件到前端渲染该事件的毫秒数。应在 50 毫秒以内，超过 200 毫秒提示序列化或网络缓冲问题。

4. 契约变更密度：统计一周内契约文件变更行数。高密度（超过 20%）预示边界不稳定，应启动版本锁定。

5. 契约测试覆盖率：每个 DTO、每个事件分支和每个错误分支都至少有一个正向和一个边界测试。目标 90%，低于 80% 阻塞发布。

## 失败模式、诊断证据与恢复动作

1. 运行时字段缺失：API 日志出现 `Required` 或 `too_small` 错误，错误码集中在输入解析阶段。恢复动作：前端检查请求字段，Agent 检查事件工厂是否遗漏字段，必要时补回归测试。

2. 联合类型标签拼写错误：TypeScript 在 `switch` 中报告未穷尽分支，或运行时事件被归类为未知事件。恢复动作：统一使用事件工厂函数，禁止手写 `type` 字符串。

3. 版本漂移：启动时哈希校验失败，或运行时解析失败率突增。恢复动作：重新构建并同步部署三方，禁止单独升级其中一个。

4. 循环导入：构建时 TypeScript 报错 `TS2307` 或运行时出现 `Cannot access before initialization`。恢复动作：把共享类型上提到契约包，禁止契约包导入实现包。

5. 序列化不一致：例如 Date 对象通过 JSON 变成字符串，或 Buffer 被丢弃。诊断证据是字段类型在运行时与编译时不一致。恢复动作：DTO 中只使用 JSON 原生类型，复杂类型在序列化前显式转换。

## 问答测试样例

1. 正向：如何定义请求 DTO？答案：使用 Zod schema 声明字段、约束和类型，通过 `z.infer` 导出 TypeScript 类型，禁止反向从类型推断 schema。

2. 正向：事件联合类型如何保证前端不漏处理事件？答案：通过 `type` 判别标签和 `z.discriminatedUnion`，TypeScript 检查 `switch` 或 `if` 分支是否穷尽。

3. 边界：Agent 需要返回未在契约中声明的调试字段，应如何处理？答案：调试字段不应进入共享契约，应通过日志或追踪输出，或在响应中显式定义可选 `debug` 字段并重新发布契约。

4. 边界：前端发送未知字段，API 应忽略还是拒绝？答案：默认应剔除，使用 strict 模式；只有契约明确允许扩展点才透传。

5. 无证据：共享契约能否替代业务层状态机？必须拒答，因为契约不定义状态转换规则，只定义事件结构。

6. 无证据：Zod 与 Valibot 在大型项目中哪个性能更好？若无基准数据，必须拒答具体数值，只能列出评估维度（构建时间、运行时开销、生态兼容性）。

## 维护、版本、来源与相邻主题关系

维护节奏：契约包独立版本，每次发布前运行 `pnpm typecheck` 和契约测试。契约变更必须伴随 ADR 或变更日志，说明新增字段、删除字段或约束收紧的原因。

版本来源：schema 文件是单一来源，类型由 schema 派生，文档由 schema 生成。禁止在 README 中手写与代码不一致的字段说明。

相邻主题：共享契约与 API 设计相邻，但不决定路由、认证和限流；与错误处理相邻，但不决定重试策略；与测试策略相邻，但测试用例由契约边界推导；与 Monorepo 包管理相邻，但不决定包管理器选择。

## 结论

事实：共享契约在 TypeScript 中通过 DTO、schema 和事件联合类型，把 API、Agent 与前端的数据边界统一到一个可类型检查的包中。运行时解析是防止跨进程数据污染的唯一可靠手段。

推论：当契约变更频率高、运行时解析失败率上升或版本哈希不一致时，系统边界已经失控，需要停止功能开发并重新对齐契约。

未知：不同团队对 schema 库的具体性能差异、超大规模联合类型（超过 100 个分支）下的类型检查衰减曲线，以及在前端生产构建中 tree-shaking 运行时 schema 的最优策略，仍需在各自项目环境下通过测量获得。
