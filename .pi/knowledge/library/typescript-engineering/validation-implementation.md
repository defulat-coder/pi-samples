---
type: concept
title: 输入校验：实现视角
description: 用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。在边界验证请求和工具参数，内部逻辑使用已收窄类型
resource: .pi/knowledge/library/typescript-engineering/validation-implementation.md
tags: [Pi, Agent, Kimi, 知识库, typescript-engineering, validation, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: typescript-engineering
topic: validation
variant: implementation
---

# TypeScript 工程实践：在边界验证输入并以收窄类型驱动内部逻辑

## 摘要与问题边界

输入校验不是“写几个 if 判断”，而是把来自系统外部的不可信字节流，转换成内部可信的窄类型。需要处理的问题边界包括：HTTP 请求体、查询参数、路径变量、WebSocket 消息、CLI 参数、本地文件读取结果、Agent 工具调用参数。校验发生在这些边界之后、业务逻辑之前；内部逻辑不应再防御性检查类型，也不应使用 `as` 做运行时断言。输出侧则要求把领域结果序列化为符合契约的响应格式，而非直接返回内部类型。生命周期顺序为：接收原始载荷 → 形状与类型校验 → 清洗与 coerce → 映射为领域类型 → 执行业务逻辑 → 编码输出。

## 核心概念与数据模型

1. **原始载荷（Raw Payload）**：尚未解析的字节、字符串或 `unknown` 对象，没有任何类型保证。例如 HTTP body 字符串、文件读取的 JSON 文本。
2. **校验模式（Schema）**：用 Zod、Valibot 或 JSON Schema 描述的合法输入结构。Schema 是单一事实来源，既生成运行时校验，也导出 TypeScript 类型。
3. **入口 DTO（Ingress DTO）**：Schema 校验成功后得到的对象，仍属于传输层。允许存在 `string` 形式的 ID、`number` 形式的分页参数，但字段已清洗和 coerce。
4. **领域窄类型（Domain Narrow Type）**：从 DTO 经二次映射得到的类型，例如 `NonEmptyString`、`PositiveInteger`、`UserId`，代表业务上合法且不可回退的状态。
5. **结构化验证错误（ValidationError）**：包含字段路径、错误码、原始值片段、可本地化消息，便于返回给客户端并写入日志。
6. **验证包装（Validated Wrapper）**：如 `Validated<T>`，用于在类型层面标记“该值已穿过边界校验”。内部函数签名只接受 `Validated<T>`，避免被原始值直接调用。

## 设计决策与取舍

### Schema-first 优先于 Type-first
先写 interface 再手写校验函数会导致类型与校验渐行渐远。Schema-first 用一份声明同时生成类型和运行时逻辑，是事实来源。例外：当需要表达复杂的 discriminated union 且库支持不足时，可手写 refine 并加类型测试。

### 显式 Coerce，拒绝隐式转换
字符串 `"123"` 可以转成数字，但 `"  123  "` 是否允许？应显式定义 transform 规则。例如日期字符串用 `z.string().datetime()` 或显式 `new Date()` 映射。禁止 silent 转换，避免把 `"true"` 当作布尔值。

### 单层形状校验 + 多层领域规则
Schema 负责形状、类型、范围；领域函数负责业务规则（如 ID 是否存在于数据库）。不在内部函数重复校验 `typeof x === 'string'`。若发现内部函数仍在检查基础类型，说明边界校验失败或签名过宽。

### 全字段错误收集与快速拒绝的平衡
普通请求推荐收集所有字段错误返回 400；但若字段涉及安全或下游资源消耗，应在首个致命错误处立即拒绝。

### 共享 Schema 与包边界
入口 Schema 放在 `packages/contracts` 或 `apps/api` 的 validation 模块，Web 端可以复用同一份 Schema 做客户端预校验，但不应依赖服务端私有的校验逻辑。Agent 工具的参数 Schema 必须与代码注册时完全一致。

### 编译时类型不能替代运行时校验
TypeScript 在编译后抹除类型，不能阻止运行时恶意输入。同时使用 branded type 或 `Validated<T>` 增加编译时安全。

## 可执行的实施流程

1. 盘点所有入口：HTTP 路由、WebSocket handler、CLI 命令、文件读取、外部工具调用参数。
2. 为每个入口声明原始输入类型：通常是 `string`、`Buffer`、`unknown` 或 `Record<string, unknown>`。
3. 用 Schema 库定义 ingress schema，并导出 `z.infer<typeof Schema>` 作为 DTO 类型。
4. 在边界层编写 `parse` 函数：调用 `schema.safeParse` 或 `schema.parse`，失败返回统一 `ValidationError`。
5. 编写 DTO 到 domain type 的映射函数：执行 refine、coerce、字符串 trim、ID 封装。
6. 修改内部函数签名，只接受 domain type，移除内部的防御性判断。
7. 在错误响应中间件把 `ValidationError` 序列化为 400 响应，包含 `code`、`path`、`message`，避免泄露内部堆栈。
8. 编写测试套件：正向、边界、非法类型、超大数据、缺失字段，并加 `expectType` 检查 domain 类型不可由错误值构造。

## 示例：知识库搜索接口

> 输入：POST /api/search
> 载荷：{ "query": "TypeScript 输入校验", "maxResults": 20 }
> 校验：query 非空、trim 后长度 1–200；maxResults 为整数，1 ≤ value ≤ 100。
> 处理：通过 Schema 解析，生成 DTO，再映射为 `SearchQuery` 领域类型，包含 `NonEmptyString query` 和 `PositiveInteger maxResults`。
> 输出（成功）：{ "ok": true, "results": [...] }
> 输出（失败）：{ "ok": false, "error": { "code": "VALIDATION_ERROR", "fields": [ { "path": ["maxResults"], "message": "必须 ≤ 100" } ] } }

## 性能、质量与可观测性指标

1. **校验延迟**：在边界层记录 `schema.parse` 耗时，目标 P99 < 5ms；复杂对象可放宽到 10ms。
2. **验证错误率**：按路由和字段聚合 400 校验响应占比，识别是否因客户端契约不一致导致高频错误。
3. **类型漂移率**：通过 `tsc` 检查 schema 导出类型与 domain 使用处是否一致；编译错误数应逐版本下降。
4. **测试覆盖率**：每个入口至少 5 个测试用例，要求覆盖正向、边界、非法类型、缺失字段、超大载荷。
5. **运行时类型事故**：监控内部函数因 `undefined` 或错误类型导致的异常，目标为 0。
6. **错误修正成功率**：客户端按 `code` + `path` 修正后重试成功的比例，用于验证错误结构是否可消费。

## 失败模式、诊断证据与恢复动作

1. **Coerce 过宽**：把 `"true"` 当作布尔值，导致状态歧义。诊断证据：请求日志显示字符串值，下游日志显示布尔值。恢复：禁用隐式转换，在 Schema 中显式 `transform` 并记录。
2. **Schema 与 DTO 漂移**：新增字段未同步到 domain 类型。诊断证据：`tsc` 报错或运行时访问 `undefined`。恢复：在 `packages/contracts` 中集中管理 schema，版本化后全量跑 `tsc`。
3. **错误路径丢失**：扁平化错误只返回字段名，嵌套对象无法定位。诊断证据：多个字段同名错误混淆。恢复：使用 `error.issues` 输出完整路径数组。
4. **内部重复校验**：domain 函数里仍写 `if (!query)`。诊断证据：代码审查发现 domain 函数含基础类型判断。恢复：收窄签名，用 `Validated<T>` 或 branded type 替代防御代码。
5. **超大载荷拒绝服务**：JSON 数组或字符串过大。诊断证据：内存/CPU 峰值。恢复：解析前限制 body 大小、数组长度、字符串长度。
6. **工具参数绕过**：Agent 工具调用 schema 宽松，模型传入数组而非对象。诊断证据：工具执行抛出类型错误。恢复：工具入口处用 `strict` 模式解析，并返回结构化错误。

## 问答测试样例

1. 正向问题：请求 query 为“TypeScript 输入校验”、maxResults 为 20，应返回 200 和结果列表。
2. 边界问题：maxResults 为 100，刚好达到上限，应返回 200。
3. 边界问题：maxResults 为 0，应返回 400，错误路径指向 `maxResults`。
4. 非法类型：query 传入数字 123，应返回 400，错误信息为“期望字符串”。
5. 无证据拒答：问“该方案是否支持 Rust 后端？”应回答：未在本项目范围内验证，本方案基于 TypeScript 与 Node 运行时，Rust 侧实现属于未知。
6. 结构边界：请求体为 JSON 数组而非对象，应返回 400，错误路径为 `[]`。

## 维护、版本、来源与相邻主题

- **维护**：schema 与 domain 类型变更必须同步。建议将入口 schema 放入 `packages/contracts`，使用 `pnpm typecheck` 在 CI 中阻断类型漂移。
- **版本**：Schema 版本化通过 API 路径或 header 标识。新增 optional 字段为兼容；删除字段、重命名字段、收紧类型为破坏性变更。
- **来源**：本实践基于 Zod、Valibot 与 TypeScript 类型收窄机制，受 JSON Schema、io-ts 影响；不依赖特定外部商业服务。
- **相邻关系**：与“输出编码/序列化”互补，输入校验负责进入，输出编码负责离开；与“错误处理”共享 `ValidationError` 结构；与“权限/授权”区别：校验只判断形状，不判断身份；与“测试策略”交叉；与“Agent 工具定义”在工具参数入口处重叠。

## 结论

- 事实：TypeScript 类型在编译后消失，无法保证运行时输入；边界校验是进入内部逻辑前的必要步骤。
- 推论：采用 schema-first 并派生窄类型，可把防御代码集中到边界，减少内部函数认知负担，并使错误响应结构可消费。
- 未知：不同 schema 库在复杂联合类型上的错误精度差异，以及极端嵌套载荷在边缘设备上的 P99 校验延迟，需要具体项目实测。
