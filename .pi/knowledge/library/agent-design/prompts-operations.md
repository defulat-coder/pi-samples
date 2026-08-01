---
type: concept
title: 提示层次：验证与运维视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。系统约束、项目上下文、工具指南和用户问题如何分工
resource: .pi/knowledge/library/agent-design/prompts-operations.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, prompts, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: prompts
variant: operations
---

# 提示层次：约束、上下文与工具在Agent运行时中的分工

## 摘要与问题边界

提示层次描述的是 Agent 运行时将不同来源的指令按固定优先级装配为一次模型请求的结构化机制。它不是单次“提示工程”的调优技巧，而是生产环境中决定“系统约束、项目上下文、工具指南与用户问题”谁说了算的运行时契约。本主题面向需要观测性能、稳定性和故障恢复的工程师，核心边界是：在每次 `session.prompt()` 调用之前，必须完成层次装配、事件订阅与证据记录；运行时不能先按用户消息关键字路由到工具，再反向构造提示。所有关于优先级、覆盖和冲突的声明，都必须以运行日志、版本哈希和事件序列为可验证证据。

## 核心概念与数据模型

1. 系统约束层：由 `ModelRuntime` 和 `AgentSession` 在启动时注入，包含安全边界、输出格式、禁止行为与能力上限。该层在运行中具有最高优先级，用户问题或工具指南均不能覆盖它，除非通过显式配置参数化槽（例如允许启用的工具白名单）进行受控变更。
2. 项目上下文层：通过 `DefaultResourceLoader` 从项目 `cwd` 加载，包括 `AGENTS.md`、`.pi/skills`、`.pi/prompts` 与 `.pi/knowledge` 等文件。该层提供项目级指令、包管理约定、技能边界与本地知识引用，是中等优先级，可被系统约束层限制，但不应被用户问题直接覆盖。
3. 工具指南层：由 `defineTool()` 注册的工具元数据与调用指南构成，描述每个工具的输入 schema、返回结构、能力限制与使用场景。该层只在工具实际被注入会话时生效，未注册的工具不得出现在模型可调用集合中。
4. 用户问题层：最终用户发送的具体请求文本，通常处于最低优先级。它触发工具调用，但不能推翻系统约束或项目上下文中的硬性规定；当用户请求与高层约束冲突时，运行时必须记录冲突证据并执行预设的降级策略。
5. 层次优先级与冲突消解规则：默认顺序为系统约束层优先于项目上下文层，项目上下文层优先于工具指南层，工具指南层优先于用户问题层。冲突消解采用“明确优于模糊”原则：结构化字段（如 `allowedTools`）优于自然语言描述；同层内后出现的具体指令优于前面的一般性声明。
6. 证据链：每次提示装配必须生成不可变记录，包括各层来源路径、版本哈希或修改时间、注入 token 数、装配耗时、最终启用工具列表与会话标识。该记录是事后诊断、容量评估与合规审计的唯一可信来源。

## 设计决策与取舍

1. 静态注入还是动态检索：静态注入在会话建立时一次性加载项目上下文，优点是可重复、缓存友好、TTFT 稳定；缺点是文件变更后必须重启会话。动态检索在每次请求前重新读取文件，保持最新，但会放大 I/O 抖动。推荐默认静态注入，并在 `AGENTS.md` 或 `.pi/prompts` 发生变更时由会话管理器触发 reload。
2. 覆盖深度与 Token 成本：项目上下文层通常包含大量文件，需要截断策略。取舍在于：过度截断会丢失关键边界（如 `packageManager` 版本），截断不足则占用模型上下文窗口并增加延迟。应建立可配置的优先级截断队列，先保留 `AGENTS.md`、再 `.pi/prompts`、最后 `.pi/knowledge`，并记录被截断的文件名。
3. 硬约束与软提示的表达方式：系统约束应优先使用结构化字段（如 `allowedTools`、`maxSteps`、输出 schema），辅以简短自然语言重申；工具指南应以 `defineTool()` 的 schema 和 `description` 为主。纯自然语言约束容易被模型忽略，因此只能作为补充，不能作为唯一约束机制。
4. 工具可见性与最小权限：会话只注册当前请求域所需的工具，不暴露全部工具库。这样可以降低误调用风险，但也要求项目上下文准确描述任务范围。例外是“通用问答”会话，可保留最小只读工具集，并在系统约束中明确禁止写操作。
5. 上下文注入与隐私边界：本地文件路径、环境变量、凭证或内部 URL 不应被原样注入到用户可见的上下文或事件流中。`DefaultResourceLoader` 应在加载时做脱敏处理，而 API 层向浏览器发送的事件只包含已经脱敏后的知识片段标识。

## 可执行的实施流程

1. 初始化项目资源目录：确保项目根目录包含 `AGENTS.md`、`.pi/skills`、`.pi/prompts`、`.pi/knowledge`，并在 `AGENTS.md` 中声明 `packageManager`、`commands` 表与项目边界。
2. 定义系统提示基线：在 `packages/pi-agent` 或等价的会话工厂中写入系统级约束，包括允许的工具类型、输出格式、安全边界与重试策略。
3. 加载项目上下文：构造 `DefaultResourceLoader` 时传入项目 `cwd`，按官方顺序读取 `.pi/skills`、`.pi/prompts`、`.pi/knowledge`，并读取 `AGENTS.md`。记录每个资源的加载结果与哈希。
4. 注册工具与生成指南：使用 `defineTool()` 为每个工具声明输入 schema、返回结构、错误码与示例。只注册当前会话域需要的工具，并生成对应的工具指南文本。
5. 装配提示层次：在调用 `session.prompt()` 前，按系统约束层、项目上下文层、工具指南层、用户问题层的顺序装配最终提示。确保每一层都有稳定的分隔标记。
6. 订阅事件流：在 `session.prompt()` 之前完成事件订阅，捕获 `message_update`（`text_delta`、`thinking_delta`、`toolcall_*`）、`tool_execution_start`、`tool_execution_update`、`tool_execution_end` 以及生命周期与重试事件。
7. 建立测试基准：准备至少三类测试样例：正向问题（能正确触发工具并返回）、边界问题（触达约束极限）、无证据拒答问题（要求回答不在知识库中的事实）。记录每次测试的延迟、token 消耗与事件序列。
8. 部署监控与降级：在会话管理器或 API 层记录 TTFT、层次装配耗时、工具调用成功率、恢复事件频率；当某层加载失败或装配超时，应回退到缓存版本或返回明确的错误响应，而不是静默继续。

## 运行时装配示例

以下是一个面向 TypeScript/Web/本地文件知识库的会话装配配置示例。输入为项目资源路径与工具注册表；处理为 `createAgentSession` 前的层次装配；输出为带版本哈希与证据链的会话对象。

```
输入：
- cwd: /Users/xbjt/Documents/myself/pi-samples
- systemBaseline: packages/pi-agent/system-prompt.md
- contextSources: [AGENTS.md, .pi/skills, .pi/prompts, .pi/knowledge]
- tools: [search_knowledge, read_file, list_directory]
- allowedTools: [search_knowledge, read_file]

处理：
1. DefaultResourceLoader 读取 cwd 下 contextSources。
2. 对每个 source 计算 SHA-256，记录 token 数。
3. defineTool 注册 search_knowledge、read_file、list_directory。
4. 根据 allowedTools 过滤，仅保留 search_knowledge 与 read_file。
5. 按系统基线、项目上下文、工具指南、用户问题的顺序装配。
6. createAgentSession 启动会话，并装配 ModelRuntime。

输出：
- sessionId: sess_20250815_001
- evidence:
  - systemBaselineHash: 7a3f...
  - contextHashes: {AGENTS.md: 9e2b..., .pi/skills: 4c1d...}
  - injectedTokens: 1847
  - enabledTools: [search_knowledge, read_file]
  - assemblyLatencyMs: 23
```

## 性能、质量与可观测性指标

1. 首次 Token 延迟（TTFT）：从调用 `session.prompt()` 到收到首个 `text_delta` 的时间。测量方法：在 API 层记录请求时间戳，并与首个 SSE 事件的时间戳比较。目标值取决于模型与网络，但同一模型下应稳定。
2. 提示层次装配耗时：从资源加载完成到最终 prompt 发送的时间。测量方法：在 `DefaultResourceLoader` 与装配函数之间插入计时，分别记录 I/O 耗时与文本拼接耗时。
3. 工具调用成功率：工具事件 `tool_execution_end` 中返回成功状态的比例。测量方法：统计一定时间窗口内的 `tool_execution_start` 与 `tool_execution_end` 配对事件，计算成功/失败比。
4. 上下文命中率：用户问题通过 `search_knowledge` 或项目上下文直接回答的比例，无需调用额外工具。测量方法：标记每次会话最终答案的知识来源，统计来自项目上下文的比例。
5. 恢复事件频率：因加载失败、超时或版本冲突触发降级或回滚的次数。测量方法：记录 `fallback_to_cache`、`resource_load_timeout`、`version_mismatch` 等事件标签，并按小时或会话聚合。

## 失败模式、诊断证据与恢复动作

1. 上下文污染：项目上下文文件被错误地整体注入，导致系统约束被稀释。诊断证据：系统约束关键词在最终 prompt 中的位置后移超过 50 个 token，或模型开始忽略安全指令。恢复动作：重新排序层次，缩短项目上下文摘要，并增加系统约束的独立分隔标记。
2. 工具指南过时：工具 schema 已变更，但指南文本未更新。诊断证据：模型输出的工具参数不符合 schema，导致 `tool_execution_end` 返回参数校验错误。恢复动作：版本化工具注册表，在 CI 中运行 schema 一致性检查，并在变更时触发指南重新生成。
3. 层次冲突未消解：用户明确要求绕过系统约束（如“忽略前面的指令”）。诊断证据：安全日志中出现冲突关键词，模型响应违反约束。恢复动作：在系统约束层使用结构化字段固定边界，并训练测试样例识别此类注入尝试。
4. 资源加载失败：`DefaultResourceLoader` 找不到 `AGENTS.md` 或 `.pi/skills` 目录。诊断证据：装配日志中记录文件缺失或权限错误，assemblyLatencyMs 异常增大。恢复动作：启动时校验资源完整性，缺失时立即报错，而不是用默认提示继续。
5. 订阅事件丢失：调用 `session.prompt()` 后才订阅事件，导致部分 delta 或工具事件未被捕获。诊断证据：事件序列缺少开头的 `thinking_delta` 或首个 `toolcall_start`。恢复动作：将订阅逻辑固化为会话工厂模板，并在代码审查中检查订阅顺序。

## 问答测试样例

1. 正向问题：如何在本项目中启动 Web 与 API 服务？可验证答案应引用 `AGENTS.md` 中的命令表，回答 `pnpm dev`，并说明该命令启动 Web 与 API 两个进程。
2. 正向问题：当前项目使用什么包管理器？可验证答案应来自 `AGENTS.md` 的 `packageManager` 字段，回答 `pnpm@10.30.3`。
3. 边界问题：用户要求直接写入文件，但当前会话只注册了 `read` 与 `search_knowledge`。系统应拒绝写操作，并说明原因：当前工具集合不包含写工具，且项目上下文要求只读。
4. 边界问题：用户询问 `docs/pi-agent-learning.md` 的内容，但 `.pi/knowledge` 中未收录该文件。系统应调用 `read_file` 读取该文件，而不是从 `.pi/knowledge` 中编造答案。
5. 无证据拒答：用户询问官方 Pi SDK 的下一个未发布版本特性。系统应拒绝回答，因为项目上下文只包含已安装的 `@earendil-works/pi-coding-agent@0.83.0`，无法验证未来版本。
6. 无证据拒答：用户要求列出本机所有文件。系统应拒绝，因为运行时的 `cwd` 被限定在项目目录，超出范围的文件路径不可访问。

## 维护、版本、来源与相邻主题关系

维护提示层次的关键是版本化。`AGENTS.md`、`.pi/prompts` 与 `.pi/skills` 应纳入版本控制，并在每次提交时重新计算资源哈希。`packages/pi-agent` 中的系统基线更新必须同步更新测试基准，否则会出现测试样例与运行时行为不一致。

来源方面，系统约束层来自 Pi SDK 与项目级会话工厂；项目上下文层来自本地文件系统；工具指南层来自 `defineTool()` 注册表；用户问题层来自 API 请求。

相邻主题包括：提示模板（Prompt Templates）专注于单条提示的措辞与格式；技能（Skills）关注可复用的工具与知识包；工具注册表（Tool Registry）关注 `defineTool()` 的 schema 与生命周期；沙箱与信任边界关注执行隔离。本主题与它们的关系是：提示层次决定这些组件在运行时的装配顺序与优先级，而不是替代它们。

## 结论

事实：提示层次由系统约束、项目上下文、工具指南和用户问题四层构成，默认优先级依次降低；`AGENTS.md`、`.pi/skills`、`.pi/prompts`、`.pi/knowledge` 是项目上下文层的官方来源；`defineTool()` 是工具指南层的唯一合法来源；事件订阅必须在 `session.prompt()` 之前完成。

推论：当模型输出违反约束时，最可能的原因是系统约束层位置太后或被自然语言稀释；当工具调用频繁失败时，最可能的原因是工具指南与 schema 不一致；当 TTFT 出现长尾延迟时，最可能的原因是项目上下文加载未做截断或缓存。

未知：不同模型对同一层次顺序的敏感度差异；长上下文窗口下过度截断与保留完整项目上下文之间的最佳平衡点；多会话并发时共享资源缓存的最优策略与一致性边界。这些应通过持续观测与 A/B 测试逐步确定。
