---
type: concept
title: 资源加载：验证与运维视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。AGENTS、skills、prompts 与项目目录如何形成 Agent 上下文
resource: .pi/knowledge/library/pi-runtime/resources-operations.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, resources, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: resources
variant: operations
---

# Pi Agent 运行时资源加载的验证与运维视角

## 摘要与问题边界

Pi Agent 在收到用户请求之前，必须先把项目级上下文装进会话。这个过程的核心是资源加载：运行时以 `AGENTS.md` 为根契约，读取 `.pi/skills`、`.pi/prompts` 和 `.pi/knowledge`，再通过 `DefaultResourceLoader` 与 `AgentSession` 把结果注入模型上下文。本文只讨论加载阶段的事实、延迟、失败与恢复，不讨论模型权重、provider key 管理、Web UI 渲染或推理算法调优。目标读者是负责观察性能、稳定性与故障排查的工程师，因此文中会记录可验证的边界、例外和失败证据，而不是一次成功请求的运行路径。

## 核心概念与数据模型

1. **根契约 `AGENTS.md`**：位于项目根目录，是运行时首先加载的上下文文件。它声明项目边界、能力限制、包管理器约定以及“不要把文本当作权限授予”的原则。如果该文件不存在，加载阶段会立即失败，后续 skills 与 prompts 不会继续注入。
2. **`DefaultResourceLoader`**：SDK 提供的文件级加载器，构造时以 `cwd` 为锚点，解析相对路径并读取 Markdown、JSON 和文本文件。它把磁盘资源转换成运行时内部可消费的 `Resource` 集合。
3. **Skills 目录 `.pi/skills/`**：由 `npx skills` CLI 管理，每个 skill 包含 manifest 与实现文件。Skill 是“只读工具”的声明式载体，AGENTS.md 明确要求本项目的 Web Agent 只暴露 `read` 与 `search_knowledge`，不开放写能力。
4. **Prompts 目录 `.pi/prompts/`**：存放系统与用户 prompt 模板，可能包含变量插值。加载时先完成模板展开，再进入会话上下文；展开失败会在初始化阶段抛出，而不是等到第一次用户请求。
5. **知识库 `.pi/knowledge/`**：项目自定义 Markdown 文件集合，默认不会被自动加载进上下文。运行时通过自定义工具 `search_knowledge` 按需检索，避免把整本知识库一次性塞进模型窗口。
6. **会话上下文快照**：`AgentSession` 启动时得到一份有序组合：根契约 → skills → prompts → 动态检索结果。`SessionManager.inMemory()` 维护当前 Web 会话注册表，所有资源引用以这份快照为准。

## 设计决策与取舍

### 以 `cwd` 为根，而非以包目录为根

`DefaultResourceLoader` 使用启动进程的工作目录作为根路径。这简化了 monorepo 场景：API 进程在仓库根启动时，`.pi/` 与 `AGENTS.md` 都在同一层。代价是：如果启动脚本误把 `cwd` 改为 `apps/api` 或 `packages/pi-agent`，加载器会找不到 `AGENTS.md`，直接报错。验证时必须把 `cwd` 当作可观测项。

### 只暴露只读工具

运行时虽然有能力注册更多写工具，但项目决定只暴露 `read` 和 `search_knowledge`。这降低了误写风险，但也意味着 Agent 无法通过运行时自我修复缺失文件。运维侧需要接受：任何文件缺失、损坏或版本不一致，都必须由外部 CI 或运维脚本恢复，而不是让 Agent 自行创建。

### Prompt 模板在加载阶段展开

Prompt 模板在进入会话前完成变量替换。优点是错误早发现、首 token 延迟更稳定；缺点是初始化阶段会引入额外 CPU 和 I/O 时间。如果模板引用外部变量且变量未就绪，启动会失败。验证时要把“模板展开失败率”作为单独指标。

### 文件优先的知识库，而非向量索引

`.pi/knowledge` 使用本地 Markdown 文件，通过 `search_knowledge` 以关键词/标题匹配检索。好处是确定性高、无嵌入服务依赖、无额外推理成本；坏处是检索质量受文件结构和命名影响，长文档容易返回过大块。运维上需要定期检查知识库文件大小、标题层级和检索结果的相关性。

### 内存中的会话注册表

`SessionManager.inMemory()` 不依赖外部数据库，单进程 Web 会话快速恢复重启前状态是不可能的。优点是实现简单、无网络依赖；缺点是进程重启会丢失全部会话。对于验证与运维视角，这意味着“会话状态”不是可恢复资产，资源加载必须幂等，保证任何新会话都能从磁盘重新生成相同上下文。

## 可执行的实施流程

1. 在启动 API 进程前，先确认 `pwd` 输出的是 monorepo 根目录，且根目录存在 `AGENTS.md` 和 `.pi/`。可在启动脚本中加入 `test -f AGENTS.md || exit 1`。
2. 执行 `npx skills list --json` 并与 `skills-lock.json` 比对，确认已安装 skill 集合与锁定版本一致。
3. 初始化 `DefaultResourceLoader` 时显式传入 `cwd`，不要依赖默认路径。例如 `new DefaultResourceLoader({ cwd: process.cwd() })`。
4. 先加载 `AGENTS.md`，记录其字节数、行数和解析耗时；若失败立即中断启动，不要降级为空上下文。
5. 遍历 `.pi/skills/` 与 `.pi/prompts/`，逐个读取 manifest 并校验 JSON 结构；任何 schema 错误都作为启动失败处理。
6. 确认 `.pi/knowledge/` 目录存在且可搜索；注册 `search_knowledge` 自定义工具，并在注册后执行一次健康查询以验证返回非空。
7. 使用 `createAgentSession()` 和配置好的 `ModelRuntime` 创建会话，把第 4-5 步生成的快照注入上下文。
8. 在调用 `session.prompt()` 之前完成事件订阅，将 `message_update`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end` 以及生命周期事件写入日志或遥测系统。

## 输入、处理、输出示例

    # 资源加载配置示例（用于 packages/pi-agent 初始化）
    loader:
      cwd: /Users/xbjt/Documents/myself/pi-samples
      resources:
        - type: agents-manifest
          path: AGENTS.md
          required: true
        - type: skills-bundle
          path: .pi/skills
          required: true
        - type: prompts-bundle
          path: .pi/prompts
          required: true
        - type: knowledge-bundle
          path: .pi/knowledge
          required: false
          access: search_knowledge
    session:
      manager: inMemory
      eventSubscription: beforePrompt
      allowedTools: [read, search_knowledge]

输入：项目根目录下的 `AGENTS.md`、`.pi/skills/`、`.pi/prompts/` 和可选的 `.pi/knowledge/`。处理：`DefaultResourceLoader` 以 `cwd` 为根，按顺序读取并校验文件，把 skills 和 prompts 合并成会话上下文，并把 `.pi/knowledge` 绑定到 `search_knowledge` 工具。输出：一份可注入 `AgentSession` 的上下文快照，以及包含加载耗时、资源数量、字节数的事件遥测记录。

## 性能、质量与可观测性指标

1. **资源加载延迟**：从 `DefaultResourceLoader` 初始化到 `AgentSession` 就绪的耗时。使用 `performance.now()` 或进程级日志记录。目标应区分冷启动（磁盘 I/O）与热启动（缓存命中）。
2. **上下文快照大小**：以字符数或字节数衡量最终注入模型的文本总量。过大的快照会拉低首 token 延迟，应设置告警阈值。
3. **Skill 注册一致性**：已加载 skill 数量与 `npx skills list --json` 输出数量之差。非零差异说明目录或锁文件不同步。
4. **Prompt 模板展开失败率**：启动阶段模板渲染错误次数除以 prompts 总数。任何非零值都应阻塞部署。
5. **知识检索质量**：在 `.pi/knowledge` 上运行一组黄金查询，记录召回率与平均结果长度。应监控返回空结果的比例和结果中是否包含目标文件标题。
6. **工具事件延迟**：记录 `tool_execution_start` 到 `tool_execution_end` 的间隔，分别针对 `read` 与 `search_knowledge`，用于发现磁盘或检索路径的抖动。

## 失败模式、诊断证据与恢复动作

1. **`cwd` 漂移导致 `AGENTS.md` 未找到**
   诊断证据：日志中出现 `ENOENT: AGENTS.md` 或 `DefaultResourceLoader` 返回空根契约。恢复动作：检查启动脚本与 `process.cwd()`，强制在启动时校验文件存在；必要时使用绝对路径初始化加载器。

2. **`skills-lock.json` 与已安装 skill 不一致**
   诊断证据：`npx skills list --json` 与磁盘 `.pi/skills/` 内容不匹配，或加载器读取到缺少 manifest 的目录。恢复动作：执行 `npx skills experimental_install` 重建；禁止手工修改已安装的第三方 skill 文件。

3. **Prompt 模板语法错误**
   诊断证据：启动日志中模板引擎抛出未定义变量或插值格式错误，且发生在 `session.prompt()` 之前。恢复动作：在 CI 中引入模板静态校验，将失败率作为部署门禁；修复模板变量后重新加载。

4. **`.pi/knowledge` 缺失或为空导致检索恒为空**
   诊断证据：`search_knowledge` 持续返回空结果，而查询在文件中确实存在。恢复动作：确认目录存在、文件扩展名为 `.md`、标题层级正确；必要时建立黄金查询回归测试。

5. **上下文过大导致首 token 延迟突增**
   诊断证据：快照字节数超过阈值，且 `message_update` 中首 token 时间显著高于基线。恢复动作：拆分长 prompts、按需检索知识库而非预加载全部、审查 `AGENTS.md` 是否引入冗余章节。

6. **事件订阅发生在 `session.prompt()` 之后**
   诊断证据：日志缺失部分 `tool_execution_start` 或 `thinking_delta`。恢复动作：在 SDK 使用层强制先 `subscribe` 再调用 prompt，并在代码审查中检查该顺序。

## 问答测试样例

1. **正向**：Pi Agent 启动时最先加载哪个文件？
   答案：`AGENTS.md`，位于项目根目录，作为根契约。

2. **正向**：`.pi/knowledge` 中的内容如何进入会话？
   答案：不会自动注入，而是通过自定义工具 `search_knowledge` 按需检索。

3. **边界**：如果 `AGENTS.md` 被删除，运行时会怎样？
   答案：加载阶段失败，会话无法启动，不应降级为空上下文。

4. **边界**：运行时能否让 Agent 通过 skill 写入文件？
   答案：本项目约定不允许；只暴露 `read` 与 `search_knowledge`，写能力需要由外部运维或 CI 处理。

5. **无证据拒答**：`DefaultResourceLoader` 是否缓存已读取文件？
   答案：无法从项目文档确认，必须查看 SDK 源码或进行加载延迟对比实验。

6. **无证据拒答**：`.pi/knowledge` 的检索算法具体是什么？
   答案：项目文档只说明通过 `search_knowledge` 访问，未公开算法细节；可验证的是它基于本地 Markdown 文件而非远程向量服务。

## 维护、版本、来源与相邻主题

维护工作应围绕三个版本边界展开：一是 `pnpm-lock.yaml` 中的 `@earendil-works/pi-coding-agent` SDK 版本；二是 `skills-lock.json` 管理的 skill 版本；三是 `.pi/prompts` 与 `.pi/knowledge` 由 Git 直接管理的文本版本。任何升级 SDK 都应重新运行 `pnpm typecheck` 与 `pnpm test`，并复测资源加载延迟。

主要来源包括项目根目录的 `AGENTS.md`、`.pi/` 目录、`packages/pi-agent` 的实现代码，以及 SDK 文档。验证时不应声称访问了不存在的外部系统；所有结论应能从这些本地可检查的资源中复现。

相邻主题包括：模型运行时与 `ModelRuntime` 配置、事件流与 SSE 传输、自定义工具注册与 `defineTool()` 契约、Web API 的会话身份管理、provider key 与凭据隔离。资源加载是这些主题的上游：如果上下文快照失败，下游事件流和推理都不会得到正确输入。

## 结论

**事实**：`AGENTS.md` 是加载阶段的根契约；`.pi/skills`、`.pi/prompts` 与 `.pi/knowledge` 分别承担技能、模板和知识库职责；`DefaultResourceLoader` 以 `cwd` 为锚点；`search_knowledge` 是访问 `.pi/knowledge` 的唯一通道；`SessionManager.inMemory()` 不持久化会话。

**推论**：项目选择只读工具面、prompt 预展开、文件优先知识库和内存会话注册表，这些设计降低了写风险与外部依赖，但把版本一致性与容量控制责任压到运维侧；任何部署都应把资源加载延迟、快照大小、skill 一致性、模板失败率和检索质量作为门禁指标。

**未知**：`DefaultResourceLoader` 是否跨会话缓存文件系统读取、`.pi/knowledge` 检索算法具体实现、以及 SDK 在不同 provider 下对 thinking delta 的精确行为，都需要通过源码阅读或受控实验进一步确认，当前文档未提供足够证据。
