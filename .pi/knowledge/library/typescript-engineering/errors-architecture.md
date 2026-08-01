---
type: concept
title: 错误建模：架构视角
description: 用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。区分用户错误、能力错误、上游错误和不可恢复故障
resource: .pi/knowledge/library/typescript-engineering/errors-architecture.md
tags: [Pi, Agent, Kimi, 知识库, typescript-engineering, errors, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: typescript-engineering
topic: errors
variant: architecture
---

# TypeScript 工程实践中的错误建模：以架构视角区分用户错误、能力错误、上游错误与不可恢复故障

## 摘要与问题边界

在 TypeScript 工程里，错误常被混为一谈：把参数校验失败记为 `Error`，把数据库连接中断也记为 `Error`，导致调用方只能用字符串匹配或 HTTP 状态码猜测意图。本文讨论的“错误建模”是在运行时语义之前，先为失败建立分类、责任边界与可替换接口。问题边界限定在：HTTP/API 服务层、本地文件知识库读取、进程内函数调用三类交互；不包含浏览器 DOM 事件、编译期类型错误、安全审计日志等相邻主题。目标是让设计者能在不修改业务逻辑的前提下，替换错误编码方式（异常、Result、Effect 等）并保留可观测语义。

## 核心概念与分类模型

1. **用户错误**：调用方提供了语义无效但语法合法的输入。例如请求中要求排序一个不存在的字段、知识库查询缺少关键词。责任在调用方，服务应返回结构化反馈并让对方重试。
2. **能力错误**：系统按设计无法完成此请求，但状态一致。例如当前租户未启用 OCR、文件大小超过配置阈值。责任在策略层，不是缺陷。
3. **上游错误**：依赖服务或进程返回了失败，但本系统自身未受损。例如向量数据库超时、对象存储返回 503。责任边界在“外部”，本系统只能传递、降级或缓存。
4. **不可恢复故障**：本系统内部状态不一致或资源损坏，继续服务可能扩大错误。例如内存堆损坏、事件流序列号断裂、文件系统变为只读。必须终止进程或关闭上下文，由编排器重启。
5. **错误代码**：分类之上的稳定标识，形如 `USER_INVALID_FILTER`、`UPSTREAM_TIMEOUT`、`FAULT_STATE_INCONSISTENT`。不随文案变化而变化。
6. **错误边界**：类型系统中的接口契约，用于在层与层之间翻译错误。例如从数据库驱动抛出的 `ConnectionError` 到 API 层的 `UPSTREAM_DB_TIMEOUT`。
7. **可替换接口**：错误建模应先定义输出格式与重试语义，再选择实现。是否使用 `try/catch`、fp-ts 的 `Either` 或 `neverthrow` 属于实现细节，不应写入领域模型。
8. **上下文证据**：每次错误必须携带可验证证据，包括请求 ID、时间戳、涉及的资源名、上游返回码、调用栈，但不包含敏感凭证或原始 Token。

## 设计决策与取舍

### 异常还是 Result 类型

异常在同步代码和框架中间件中表达自然，但跨异步边界时容易丢失调用栈；Result 类型要求调用方显式处理，适合高阶函数组合。取舍原则：在领域层使用 Result 或 tagged union 强制处理；在框架边界（Express/Fastify 中间件）使用异常拦截器统一翻译，避免每处业务代码都写 `if (err)`。

### 谁来判定错误类别

分类应由距离失败原因最近、但拥有足够上下文的那一层决定。例如数据库连接超时在仓储层判定为 `UPSTREAM_DB_TIMEOUT`，而不应在 API 层通过字符串解析重判。若上游返回语义模糊，则在日志中标记 `category_tentative`，由运行时告警人工复核。

### 是否引入全局错误 ID

全局错误 ID 有助于跨服务追踪，但集中注册表会拖慢演进。建议：在单体内使用 `DOMAIN_MODULE_CODE` 三段式前缀，不强制全局唯一；跨服务传播时通过 `correlation_id` 关联，而非强制统一枚举。

### 上游超时属于哪一类

上游超时不可简单归类为“上游错误”：若请求已发出但响应未回，则属于 `UPSTREAM_TIMEOUT`；若连接从未建立，属于 `UPSTREAM_UNAVAILABLE`；若本系统因自身线程池耗尽导致请求未发出，则属于 `FAULT_RESOURCE_EXHAUSTED`。边界判定依赖是否已越过本进程 I/O 边界。

### 不可恢复故障的终止策略

不可恢复故障应触发快速失败，但终止范围需最小化。Node.js 中可关闭当前 `AsyncLocalStorage` 上下文并返回 503，而非直接 `process.exit`。仅当事件循环完整性受损或句柄泄漏不可控时，才允许进程退出。

## 可执行的实施流程

1. 梳理当前代码库中所有 `throw`、`.catch()`、返回 `null` 的边界点，建立清单。
2. 定义四类错误的最小属性集合：`code`、`message`、`evidence`、`is_retryable`、`target_action`。
3. 在 `packages/contracts` 或共享类型包中声明 `AppError` tagged union，并禁止业务层直接使用 `Error` 基类。
4. 为每个外部依赖（数据库、对象存储、向量检索、本地文件系统）编写 `AdapterErrorMapper`，将库原生错误翻译为四类之一。
5. 在 API 入口层配置统一错误拦截器，把 `AppError` 映射到 HTTP 状态码与响应体，但保留 `code` 字段。
6. 为每类错误建立结构化日志模板：用户错误使用 `INFO`，能力错误使用 `WARN`，上游错误使用 `WARN` 并带 `upstream_service` 标签，不可恢复故障使用 `ERROR`/`FATAL`。
7. 引入针对每类的测试夹具：用户错误返回 400 并给出字段级提示；能力错误返回 403/409；上游错误返回 502/503 或降级结果；不可恢复故障触发健康检查失败。
8. 在 CI 中运行错误分类一致性检查：若新引入的 `throw` 未在 `ErrorMapper` 中注册，则阻塞合并。

## 贴近本地文件知识库的示例

```yaml
# .pi/knowledge/errors.yaml — 项目级错误语义注册表
errors:
  - code: USER_MISSING_KEYWORD
    category: user_error
    retryable: false
    http_status: 400
    evidence_fields: [request_id, query_text]
    action: "向调用方返回具体字段错误，提示必须提供至少一个关键词"
  - code: CAPABILITY_FILE_SIZE_EXCEEDED
    category: capability_error
    retryable: false
    http_status: 409
    evidence_fields: [request_id, file_path, max_bytes]
    action: "拒绝请求并给出当前租户可上传的最大值"
  - code: UPSTREAM_VECTOR_DB_TIMEOUT
    category: upstream_error
    retryable: true
    http_status: 503
    evidence_fields: [request_id, upstream_name, elapsed_ms]
    action: "短延迟后重试，或返回缓存的近似结果"
  - code: FAULT_INODE_READ_ONLY
    category: unrecoverable_fault
    retryable: false
    http_status: 503
    evidence_fields: [request_id, mount_path, errno]
    action: "终止当前请求上下文，触发进程健康检查失败"
```

输入：仓储层读取本地 Markdown 知识库时，`fs.readFile` 抛出 `EROFS`。处理：`LocalFileAdapterErrorMapper` 根据 `errno` 与挂载点状态判定为 `FAULT_INODE_READ_ONLY`，组装证据并上抛。输出：API 拦截器返回 503，并在日志中标记 `fault=true`，运维侧依据挂载路径排查。

## 性能、质量与可观测性指标

1. **错误分类准确率**：每周抽查 50 条 ERROR 日志，由维护者复核分类是否正确。目标：≥ 95%。
2. **用户错误重试率**：同一 `request_id` 在 5 分钟内重复产生相同用户错误的比例。目标：≤ 5%，若偏高则提示文案或校验不足。
3. **上游错误降级成功率**：上游超时后触发缓存或默认值的比例及用户可见延迟。目标：≥ 80% 的关键路径在降级下仍返回结果。
4. **不可恢复故障检测延迟**：从 `FAULT_*` 发生到健康检查失败的时间。目标：≤ 5 秒。
5. **错误翻译覆盖率**：代码扫描中 `AdapterErrorMapper` 覆盖的库原生错误数除以总捕获数。目标：≥ 90%。
6. **分支覆盖率**：对每类错误路径的单元测试覆盖。目标：用户错误与能力错误 100%，上游与故障通过集成测试覆盖。

## 失败模式、诊断证据与恢复动作

1. **分类漂移**：新成员把 `UPSTREAM_TIMEOUT` 写进用户错误。诊断：日志中 `http_status=400` 但 `upstream_name` 非空。恢复：在 CI lint 中增加枚举校验。
2. **敏感信息泄露**：错误响应把原始文件路径或数据库连接串带出去。诊断：响应体包含 `errno` 或 IP 地址。恢复：序列化前使用 `evidence_fields` 白名单过滤，禁止输出原始上游错误 message。
3. **重试风暴**：上游错误 `retryable=true` 但无指数退避，导致雪崩。诊断：同一 `upstream_name` 的 QPS 与错误率同步上升。恢复：把重试策略绑定到错误代码，最大退避 8 秒，并启用断路器。
4. **不可恢复故障被吞没**：中间件捕获 `FAULT_*` 后返回 500 并继续运行。诊断：进程存活但健康检查仍通过，日志中 `fault=true` 没有触发退出。恢复：在全局异常拦截器中为 `FAULT_*` 单独分支，先标记健康检查失败再关闭上下文。
5. **能力错误被误判为缺陷**：未启用能力返回 500 而不是 409。诊断：异常监控中 `CAPABILITY_*` 被标记为异常。恢复：把能力错误从异常监控排除，改为业务指标仪表盘。

## 问答测试样例

1. 正向问题：当用户上传超过租户限制的文件时，应返回什么错误类别？答案：能力错误 `CAPABILITY_FILE_SIZE_EXCEEDED`，HTTP 409。
2. 正向问题：向量数据库请求超时且未建立连接，如何分类？答案：上游错误 `UPSTREAM_VECTOR_DB_TIMEOUT`，可重试。
3. 边界问题：本地文件系统突然变为只读，应返回用户错误还是不可恢复故障？答案：不可恢复故障 `FAULT_INODE_READ_ONLY`，因为本系统状态受损，调用方无法通过重试修复。
4. 边界问题：请求参数在 JSON 解析阶段就失败，属于哪一类？答案：用户错误 `USER_INVALID_PAYLOAD`，但应由框架在反序列化边界判定。
5. 无证据时的拒答条件：如果只知道 API 返回了 500，但日志中没有 `code`、`evidence_fields` 或 `upstream_name`，能否判断为上游错误？答案：不能，必须拒答，先补充日志证据。
6. 无证据时的拒答条件：某错误消息包含“timeout”，能否直接归类为上游超时？答案：不能，必须区分是本进程资源耗尽导致的 `FAULT_RESOURCE_EXHAUSTED` 还是依赖服务超时。

## 维护、版本、来源与相邻关系

本错误模型由项目 `AGENTS.md` 与 `docs/adr/0001-monorepo-and-pi-boundary.md` 共同约束，版本与 TypeScript 包版本同步，遵循 SemVer：增加错误代码为 minor，变更分类语义为 major，删除代码为 major。错误代码注册表应存放在 `packages/contracts` 或 `.pi/knowledge/errors.yaml`，避免分散在业务代码中。相邻主题包括：可观测性负责传播 `correlation_id`；输入校验负责在入口阶段捕获用户错误；重试与熔断策略负责上游错误的行为；安全审计负责敏感信息过滤。本主题不处理编译期错误、浏览器运行时异常或模型调用内容的语义审核。

## 结论

事实：TypeScript 项目可以通过稳定 code、分类、证据与可替换接口，将错误从实现细节提升为架构契约。推论：在领域层优先使用 Result/tagged union，在框架边界统一翻译，能显著降低用户错误与不可恢复故障的误归类。推论：把上游错误与能力错误分开，有助于在发生依赖故障时选择重试或降级，而不是一律返回 500。未知：在 Effect、RxJS 或 tRPC 等框架中，具体的错误类型推断与类型回传语义仍依赖团队约定，尚无统一的社区标准能够覆盖所有边界。
