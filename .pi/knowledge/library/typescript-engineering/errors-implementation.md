---
type: concept
title: 错误建模：实现视角
description: 用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。区分用户错误、能力错误、上游错误和不可恢复故障
resource: .pi/knowledge/library/typescript-engineering/errors-implementation.md
tags: [Pi, Agent, Kimi, 知识库, typescript-engineering, errors, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: typescript-engineering
topic: errors
variant: implementation
---

# TypeScript 工程实践：错误建模中的四种域与代码实现

## 摘要与问题边界

错误建模不是给每个函数包一层 `try/catch`，而是要在代码中明确区分“谁该为这个错误负责”以及“能不能恢复”。在 TypeScript 工程里，常见的失败至少应该被划分成四个域：用户错误、能力错误、上游错误和不可恢复故障。用户错误指调用方提供的输入、权限或流程状态不符合预期，例如文件路径不存在、参数越界、身份校验失败。能力错误指系统在当前配置或策略下无法满足请求，例如个人知识库容量达到上限、索引配额耗尽、当前版本不支持某种格式。上游错误指依赖的外部服务或资源返回了失败，例如嵌入模型 API 超时、对象存储服务 503、文件系统返回 IO 错误。不可恢复故障指运行时本身出现无法继续的异常，例如内存溢出、类型断言被违反、内部不变量破坏。

本视角聚焦实现层面，目标是把这套分类落到类型、返回值、日志和客户端协议中。适用边界是具备明确入口、依赖外部服务、需要持久化或索引的 TypeScript 后端服务、CLI 或本地知识库处理管道；不适用于纯浏览器交互的简单脚本或完全无外部依赖的一次性工具。

## 核心概念与数据模型

1. **域类型 `ErrorDomain`**。使用字面量联合类型 `type ErrorDomain = 'user' | 'capability' | 'upstream' | 'unrecoverable'`，所有错误对象都必须携带这个字段。编译时通过 `switch (err.domain)` 进行穷尽性检查，确保新增域后有显式分支。
2. **统一错误结构 `DomainError`**。基础字段包括：`domain`、`code`、`message`、`recoverable`、`retryable`、`context`、`causedBy`。`code` 采用 `域缩写-模块-序号` 的格式，例如 `US-FILE-001`、`UP-EMBD-003`、`UF-CORE-001`。`context` 至少包含 `operationId` 和 `inputId`，必要时补充 `userId`、`traceId`、`requestId`。
3. **结果容器 `Result<T, E>`**。业务函数不直接抛出未知异常，而是返回 `Result<T, DomainError>`。在 TypeScript 中可用 `{ ok: true; value: T } | { ok: false; error: DomainError }` 实现。调用方必须处理 `ok === false` 分支，否则类型检查会提示。
4. **生命周期状态 `ErrorLifecycle`**。错误不是静态对象，而是经历：检测 → 分类 → 记录 → 转换 → 响应 → 归档。每个阶段都要写入日志，但不同阶段的日志级别不同；分类阶段用 `debug`，响应阶段用 `info` 或 `warn`，不可恢复故障用 `error` 或 `fatal`。
5. **边界适配器 `BoundaryAdapter`**。所有与外部交互的库，包括 `fs`、`fetch`、`zod`、`prisma`、`openai` 等，都需要一个适配器把原始异常转换为 `DomainError`。这是防腐层，禁止在业务代码中直接判断 `err instanceof SomeLibraryError`。
6. **对外暴露契约 `PublicErrorResponse`**。HTTP 响应体只包含 `domain`、`code`、`message`、`retryable` 和最小上下文。`message` 应经过本地化且不泄露内部路径、SQL、Token。`details` 仅在 `user` 域下可包含字段级错误，例如 `{"field": "filePath", "issue": "not_found"}`。

## 设计决策与取舍

### 4.1 判别联合类型还是 Error 子类

优先使用带有 `domain` 字段的判别联合，而不是继承 `Error` 的类层次。判别联合能在 `switch` 中借助 TypeScript 的穷尽性检查，避免遗漏分支；也更利于序列化到 JSON。如果需要保留堆栈，可以让每个联合成员实现 `Error` 接口并暴露 `toJSON()` 方法。代价是调试时不再直接看到 `instanceof` 的类名，需要约定 `__type` 或 `domain` 字段。

### 4.2 集中转换还是分散捕获

在系统边界集中转换，而不是在业务逻辑里到处写 `try/catch`。集中转换点包括：HTTP 客户端、文件系统封装、命令行参数解析、环境变量读取、数据库驱动。业务函数只接收 `Result` 或 `DomainError`。代价是边界层需要维护完整的映射表；如果映射表遗漏某种库异常，错误可能以 `unrecoverable` 身份逃逸，因此需要单元测试定期注入第三方库异常。

### 4.3 重试语义由谁定义

`retryable` 不由调用方猜测，而由错误域和具体错误码决定。`user` 域永远不可重试；`capability` 域在配额、限流等场景下可重试，但需附带 `retryAfter`；`upstream` 域根据上游返回的 HTTP 状态或错误码判断，例如 503 可重试、400 不可重试；`unrecoverable` 不可重试。这个决策意味着错误定义中必须包含重试策略元数据，而不是由调用代码临时判断。

### 4.4 是否对外暴露错误码

对外暴露统一错误码，但隐藏内部模块名。错误码应稳定，因为客户端可能根据码做恢复。例如 `UP-EMBD-001` 表示上游嵌入服务超时，客户端可以据此触发退避重试。如果错误码频繁变化，检索和告警都会失效。代价是必须建立版本化的错误码注册表，并在合并时做重复检查。

### 4.5 是否保留 Error 原型

建议让 `DomainError` 实现 `Error` 接口，保留 `stack`，但序列化时只导出结构字段。这样既能被 Node 的 `unhandledRejection` 捕获，也能被日志系统安全打印。反模式是直接用 `throw new Error(JSON.stringify(obj))`，这会让堆栈和结构化数据混在一起。

## 可执行实施流程

1. 梳理项目所有外部边界：HTTP 入口、CLI 参数、文件系统、环境变量、数据库、第三方 API、缓存、消息队列。
2. 定义 `ErrorDomain` 联合类型和 `DomainError` 结构，写入 `packages/contracts` 或 `src/error-model.ts`，确保类型被 API 和客户端共享。
3. 为每个边界实现适配器：把 `fs` 的 `ENOENT` 映射为 `US-FILE-001`，`EACCES` 映射为 `US-AUTH-001`；把 `fetch` 的 `AbortError` 映射为 `UP-NET-001`，HTTP 5xx 映射为 `UP-SVC-00x`。
4. 在业务函数签名中显式返回 `Result<T, DomainError>`，或在需要同步异常时使用 `throw` 但保证抛出的对象符合 `DomainError`。
5. 在路由或控制器层统一序列化：根据 `domain` 设置 HTTP 状态码，`user` 对应 400，`capability` 对应 403 或 409，`upstream` 对应 502 或 503，`unrecoverable` 对应 500。
6. 为每个请求注入 `requestId` 和 `traceId`，并在错误 `context` 中传递，确保日志、告警和客户端消息可关联。
7. 建立可观测性：记录每个错误码的计数、重试次数、端到端延迟、首次成功时间；使用结构化日志而不是字符串拼接。
8. 编写测试矩阵：每个域至少一个正向用例、一个边界用例和一个无效转换用例，验证分类不会漂移。
9. 编写客户端恢复指南，说明每个错误码对应的用户动作或系统动作。
10. 在代码审查中检查新增错误码是否重复、是否有适配器、是否更新公开文档。

## 输入、处理与输出示例

以下是一个本地知识库导入任务的典型场景，展示输入、处理、输出如何映射到四种错误域。

输入：`{ operation: "ingestKnowledge", requestId: "req-20240801-001", payload: { filePath: "/docs/adr/0001.md", schemaName: "adr-v1", ownerId: "user-42" } }`

处理：
- 调用 `fs.promises.readFile` 读取文件，若路径不存在，边界适配器生成 `user` 域错误 `US-FILE-001`，字段 `{ field: "filePath", expected: "existing_file" }`。
- 使用 Zod 解析 frontmatter，如果 schema 版本由用户指定且字段缺失，归为 `user`；如果 schema 是系统内部配置且解析规则本身错误，则归为 `capability` 域 `CA-SCHM-002`。
- 调用嵌入模型服务，如果返回 504，边界适配器生成 `upstream` 域 `UP-EMBD-001`，`retryable: true`，`retryAfter: 2`。
- 如果处理过程中出现数组越界或类型断言失败，直接归类为 `unrecoverable` 域 `UF-CORE-001`，记录完整堆栈，但对外不返回堆栈。

输出：`{ ok: false, error: { domain: "upstream", code: "UP-EMBD-001", message: "嵌入服务响应超时", retryable: true, retryAfter: 2, context: { requestId: "req-20240801-001", operation: "ingestKnowledge" } } }`

在这个例子里，输入只包含业务字段，处理阶段的分类由边界适配器和策略规则决定，输出则只包含客户端需要的信息，内部细节不泄露。

## 性能、质量与可观测性指标

1. **分类准确率**：通过错误注入测试，将已知异常输入映射到预期域，目标不低于 98%。测量方式是在 CI 中运行 `error-classification.test.ts`，统计匹配数。
2. **结果包装开销**：测量 `Result<T, E>` 包装和拆包对 p99 延迟的影响，目标相对裸返回值增加不超过 1 毫秒。测量方式是用基准测试在 10 万次调用中对比。
3. **重试率**：按错误码统计 `retryable: true` 的触发次数和实际重试成功比例。上游域重试成功比例低于 50% 时应触发告警。
4. **不可恢复故障率**：记录每百万次请求中 `unrecoverable` 域错误和进程崩溃的次数，目标低于 0.1 次。测量方式依赖日志聚合和异常监控。
5. **日志基数**：统计一个月内产生的不同错误码数量。若数量异常增长，说明分类表碎片化，需要合并不必要的错误码。
6. **客户端恢复成功率**：记录收到错误响应后客户端按指南操作并最终成功的比例，用于验证错误码和恢复动作是否对齐。

## 失败模式与诊断恢复

1. **分类漂移**：库的次要版本改变了错误类名，导致原本映射为 `upstream` 的异常落入 `unrecoverable`。诊断证据是日志中出现 `UF-CORE-xxx` 但堆栈显示是第三方库的已知错误。恢复动作：更新适配器映射表，添加回归测试。
2. **敏感信息泄露**：`upstream` 或 `unrecoverable` 的 `message` 中包含了数据库连接串或内部路径。诊断证据是响应体或日志中包含 `Token=`、`file:///` 等模式。恢复动作：在序列化层增加 sanitizer，并在响应前运行正则扫描。
3. **重试风暴**：上游限流返回 503，但客户端按 `retryable: true` 无限重试。诊断证据是日志中同一 `requestId` 在 10 秒内产生超过 20 次 `UP-SVC-002`。恢复动作：在服务端和客户端同时实施指数退避加抖动，必要时触发断路器。
4. **错误码冲突**：两个模块都定义了 `UP-EMBD-001`，但含义不同。诊断证据是告警规则误报或客户端恢复行为不一致。恢复动作：建立集中式错误码注册表，并在 CI 中检查重复。
5. **不可恢复故障被吞没**：业务代码捕获了所有异常后返回 `user` 域错误，导致真正的内存或类型错误被掩盖。诊断证据是 `user` 错误率陡增且伴随 `heap out of memory` 日志。恢复动作：明确 `unrecoverable` 白名单，异常处理不得捕获 `RangeError`、`TypeError` 等运行时错误。
6. **上下文丢失**：分布式调用中没有传递 `traceId`，导致上游错误无法关联到原始请求。诊断证据是不同服务的日志 `requestId` 不一致。恢复动作：在异步上下文管理器中传递 `AsyncLocalStorage`，并在适配器中强制读取。

## 问答测试样例

1. **正向问题**：用户上传了一个不存在的本地文件路径，系统会返回什么？
   答：返回 `user` 域错误 `US-FILE-001`，响应体包含 `field: "filePath"` 和 `issue: "not_found"`。

2. **正向问题**：嵌入模型 API 返回 504 时，错误对象应包含哪些字段？
   答：返回 `upstream` 域 `UP-EMBD-001`，`retryable: true`，`retryAfter: 2`，`context` 包含原始 `requestId`。

3. **边界问题**：Zod 校验失败一定属于 `user` 域吗？
   答：不一定。如果失败是因为用户输入字段缺失，则属 `user`；如果是因为系统内部 schema 配置错误，则属 `capability` 域 `CA-SCHM-002`。

4. **边界问题**：上游对象存储返回 403，应该归为 `user`、`capability` 还是 `upstream`？
   答：如果 403 是因为用户提供的访问令牌无效，则属 `user` 域 `US-AUTH-001`；如果 403 是服务账户权限不足，则属 `capability` 域 `CA-PERM-001`；如果上游服务本身临时不可用但错误码不标准，则属 `upstream` 域。

5. **无证据拒答**：如果错误码不在当前注册表中，能否直接推断为 `unrecoverable`？
   答：不能。没有映射规则或错误上下文时，必须记录为 `unclassified` 并触发人工审查，不能默认升级为不可恢复故障。

6. **无证据拒答**：仅根据日志中的 `Error: timeout` 文本能否判断属于 `upstream` 域？
   答：不能。需要查看堆栈来源、调用目标和错误码，才能区分是网络超时、数据库超时还是业务逻辑超时。

## 维护、版本、来源与相邻主题

错误模型应作为独立模块维护，版本号随 `packages/contracts` 或 `src/error-model.ts` 的变更而升级。新增错误码时必须同步更新错误码注册表、适配器、测试矩阵和客户端恢复文档。来源应以代码和日志中的实际证据为准，不要基于文档假设推断分类。当外部依赖升级时，应重新运行异常注入测试，确认原有映射是否仍然有效。

与相邻主题的关系：错误建模的上游是输入验证和授权策略；下游是重试、断路器、告警和事件响应。它与结构化日志共享 `context` 字段，但与日志格式设计独立；与可观测性共享错误码，但指标口径需要单独约定。它依赖 TypeScript 类型系统，但和运行时异常监控属于不同层次。

## 结论

事实：在 TypeScript 中可以通过判别联合类型实现稳定的错误域分类；`user`、`capability`、`upstream`、`unrecoverable` 四个域在请求处理、响应码和恢复动作上有明显差异；边界适配器是防止分类漂移的关键。

推论：把错误码注册表、适配器、单元测试和响应序列化放在同一模块维护，可以显著降低错误错分和敏感信息泄露的概率；`retryable` 应由错误码元数据决定，而不是调用方临时判断。

未知：不同 Node 版本和第三方库对同一失败的异常类名可能不同，需要持续注入测试；在复杂微服务场景中，跨进程上下文传递的完整成本和对错误域分类准确率的定量影响，还需结合实际项目数据进一步验证。
