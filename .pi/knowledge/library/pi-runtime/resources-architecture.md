---
type: concept
title: 资源加载：架构视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。AGENTS、skills、prompts 与项目目录如何形成 Agent 上下文
resource: .pi/knowledge/library/pi-runtime/resources-architecture.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, resources, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: resources
variant: architecture
---

# Pi Agent 运行时资源加载：上下文构造与责任边界

## 摘要与问题边界

Pi Agent 运行时将项目目录、AGENTS.md、skills、prompts 与本地知识库整合为一次会话的上下文。资源加载层不是简单的文件读取器，而是负责决定 Agent 能读取什么、以什么顺序读取、在何时停止读取，以及如何把磁盘上的树状结构转换为模型可消费的加权上下文。其边界止于：不解释用户消息、不 keyword-route 请求、不执行模型输出中的危险操作；其边界始于：从项目根目录递归发现资源，并为 Agent 生成可验证的上下文清单。

## 核心概念与数据模型

1. **项目上下文根（Project Context Root）**：固定为进程启动时的 cwd。所有相对路径从这里解析，禁止运行时切换根目录，避免相对路径漂移。
2. **AGENTS.md**：作为宿主声明文件，声明项目意图、指令、包管理命令、边界与相邻主题引用。它被信任为项目上下文，但不是权限授予。
3. **Skills**：位于 `.pi/skills`，由 Skills CLI 安装并管理。每个 skill 是自我描述的能力单元，Agent 通过 skill 名称与参数调用，加载时只读引入。
4. **Prompt Templates**：位于 `.pi/prompts`，是面向模型或用户场景的模板。加载时解析占位符，但不对模板做语义预执行。
5. **Knowledge Bundle**：位于 `.pi/knowledge`，是项目自定义 Markdown 集合。它不会被自动注入，必须通过 `search_knowledge` 显式检索。
6. **Resource Loader 接口**：核心抽象。实现负责扫描目录、按优先级排序、计算 checksum、缓存与失效。`DefaultResourceLoader` 是默认实现，但可被替换。
7. **Capability Injection**：运行时把允许的工具集合注入会话。本项目只暴露 `read` 与 `search_knowledge`，所有写操作在 host 边界被拒绝。
8. **Context Manifest**：一次会话实际送入模型的资源清单，包含路径、来源、版本摘要、token 估算与加载时间戳。

## 设计决策与取舍

### 1. 先接口，后实现
`ResourceLoader` 接口定义了扫描、过滤、排序、加载四个方法。只有接口稳定后，才实现 `DefaultResourceLoader`。这允许测试用 fake loader，也允许未来用远程资源加载器替换本地文件加载器。

### 2. 只读默认原则
加载层默认只读取。AGENTS.md 与 prompts 虽然携带指令，但加载层不执行它们。执行权在 Pi Agent 运行时与宿主边界。sknowledge 不自动注入，防止无关 Markdown 噪声淹没用户问题。

### 3. 分层排序
资源按优先级加载：AGENTS.md > skills 元数据 > prompts 模板 > knowledge 检索结果。同一层内按字典序稳定排序，保证可重复性。

### 4. 不预路由用户消息
API 层不解析用户消息来决定是否加载某类资源。资源加载由运行时根据会话阶段触发，保持 Pi Agent 决策优先。

### 5. 缓存与失效
文件内容按 mtime + size 做缓存键；skills-lock.json 与 prompts 的 checksum 做版本锚点。缓存命中时跳过 I/O，缓存失效时全量重新扫描。

### 6. 安全边界大于便利
加载层不跟随符号链接出项目根，不加载 `.env`、密钥文件或 node_modules。这一取舍牺牲了部分灵活性，换来可审计的上下文。

## 可执行的实施流程

1. 在 `packages/pi-agent` 中定义 `ResourceLoader` 接口，包含 `scan(root)`、`filter(files)`、`sort(files)`、`load(file)` 四个方法。
2. 实现 `DefaultResourceLoader`，使用 `fs.promises` 递归扫描，最大深度默认 16，超出深度记警告。
3. 配置忽略列表：`node_modules/**`、`.git/**`、`*.env*`、`.pi/.cache/**`，以及符号链接。
4. 读取 `AGENTS.md` 作为第一优先级，解析为纯文本块，附加来源标记。
5. 读取 `.pi/skills/**/*.md` 与 `skills-lock.json`，建立 skill 名称到文件路径的映射。
6. 读取 `.pi/prompts/**/*.md`，提取模板名称与占位符列表，但不渲染。
7. 注册 `.pi/knowledge` 目录，但不主动注入；仅为 `search_knowledge` 工具建立索引。
8. 为每次会话生成 `ContextManifest`，包含路径、大小、checksum、token 估算与加载耗时。
9. 在 `apps/api` 中初始化 `DefaultResourceLoader` 并传入项目根目录；Web 层不接触资源加载器。
10. 运行 `pnpm typecheck` 与 `pnpm test`，确保接口实现不破坏 contracts 包中的 DTO。
11. 在生产启动前通过 `git diff --check` 验证新增文件未引入尾随空格或换行异常。
12. 在会话关闭时调用 `loader.dispose()`，释放文件句柄与缓存。

## 示例：资源加载的输入、处理与输出

JSON 示例表示一次会话的上下文片段：

{
  "sessionId": "sess_8a2f",
  "projectRoot": "/Users/xbjt/Documents/myself/pi-samples",
  "manifest": [
    {
      "source": "AGENTS.md",
      "path": "AGENTS.md",
      "priority": 0,
      "checksum": "sha256:a1b2c3",
      "tokens": 420,
      "loadedAt": "2026-08-15T09:12:00Z"
    },
    {
      "source": "skill",
      "path": ".pi/skills/typescript-linting.md",
      "priority": 1,
      "checksum": "sha256:d4e5f6",
      "tokens": 180,
      "loadedAt": "2026-08-15T09:12:01Z"
    },
    {
      "source": "prompt",
      "path": ".pi/prompts/code-review.md",
      "priority": 2,
      "checksum": "sha256:g7h8i9",
      "tokens": 95,
      "loadedAt": "2026-08-15T09:12:01Z"
    }
  ],
  "knowledgeIndex": {
    "root": ".pi/knowledge",
    "indexedFiles": 12,
    "queryable": true
  }
}

输入是项目目录树与加载器配置；处理是扫描、过滤、排序、checksum 计算与 token 估算；输出是带优先级的 manifest 与知识索引。Agent 在调用 `search_knowledge` 时，只从 knowledge 索引中返回相关片段，而不是把 12 个文件全部塞进上下文。

## 性能、质量和可观测性指标

1. **首次加载延迟**：从会话创建到 manifest 生成的时间。测量方式：在 `DefaultResourceLoader.scan()` 前后打点，目标 < 200 ms（项目根文件数 < 500 时）。
2. **缓存命中率**：加载过程中命中内存缓存的文件比例。通过缓存键统计，目标 > 80%。
3. **上下文 token 占用比**：资源总 token 占模型上下文窗口的比例。超过 50% 时触发告警，避免有效用户空间被压缩。
4. **检索精确率**：`search_knowledge` 返回的 top-3 片段与用户问题相关的比例。用人工标注的 50 个查询做回归测试。
5. **资源加载失败率**：无法读取的文件数占总扫描文件数的比例。目标 < 0.1%，超过时记录 errno 与路径。
6. **端到端会话初始化时间**：从 HTTP 请求到首次 `message_update` 事件。测量方式：API 层中间件记录。

## 失败模式、诊断证据与恢复动作

1. **根目录漂移**：启动时 cwd 不是项目根，导致 AGENTS.md 找不到。诊断证据：manifest 为空，日志出现 `AGENTS.md not found under root`。恢复：重启进程前验证 cwd，或在配置中显式指定 `projectRoot`。
2. **符号链接逃逸**：加载器跟随符号链接读到项目外部。诊断证据：manifest 中出现根目录外路径。恢复：在 `filter()` 中拒绝任何 `realpath` 不在根目录下的文件。
3. **缓存与文件不同步**：缓存命中但文件已更新，导致旧上下文进入会话。诊断证据：checksum 与磁盘不一致。恢复：每次加载前校验 mtime + size，命中时也做 checksum 抽样。
4. **Knowledge 索引损坏**：knowledge 文件删除后索引未刷新。诊断证据：`search_knowledge` 返回不存在的文件路径。恢复：索引构建时记录文件 mtime，查询前检查文件是否存在。
5. **Prompt 模板无限展开**：模板互相引用形成循环。诊断证据：渲染栈深度超过阈值。恢复：对 prompt 渲染图做拓扑检测，发现环即报错。
6. **Skills 版本与 lock 文件不一致**：`skills-lock.json` 中的 checksum 与 `.pi/skills` 实际文件不符。诊断证据：加载器警告 `skill checksum mismatch`。恢复：运行 `npx skills experimental_install` 重新同步。

## 问答测试样例

1. **正向**：AGENTS.md 中声明了哪些包管理命令？**答**：pnpm dev、pnpm typecheck、pnpm build、pnpm test、pnpm lint。
2. **正向**：知识库如何被 Agent 使用？**答**：通过 `search_knowledge` 工具显式检索，不自动注入。
3. **边界**：如果 cwd 不是项目根，资源加载会失败还是回退？**答**：按当前设计失败，因为项目根固定为启动 cwd；可配置 `projectRoot` 作为例外。
4. **边界**：`DefaultResourceLoader` 能否被替换？**答**：能，只要实现 `ResourceLoader` 接口并在运行时注入。
5. **无证据**：资源加载器是否执行模型输出中的 shell 命令？**答**：没有证据支持；执行在 host 边界，加载层只读。
6. **无证据**：skills 是否自动拥有写文件权限？**答**：没有；本项目只暴露 `read` 与 `search_knowledge`，写权限未在配置中出现。

## 维护、版本、来源与相邻关系

维护节奏：每次修改 `.pi/skills`、`.pi/prompts` 或 `.pi/knowledge` 后，必须运行 `pnpm typecheck` 与 `pnpm test`。skills 由 CLI 管理，禁止手写修改已安装 skill 文件。版本锚点：`skills-lock.json` 与 `pnpm-lock.yaml` 必须同步提交。

来源：本设计基于 `AGENTS.md` 与项目结构中声明的边界，以及 `packages/pi-agent` 的实现意图。未引入未声明的外部系统。

相邻主题：资源加载与 Agent 会话管理（createAgentSession、SessionManager）紧密相邻，但会话管理负责生命周期，加载负责上下文；与工具注册（defineTool）相邻，但工具注册决定能力，加载决定资源；与 SSE 传输相邻，但传输只搬运事件，不构造上下文。

## 结论

**事实**：资源加载层的输入是项目目录树，输出是 `ContextManifest`；AGENTS.md、skills、prompts 按优先级加载；knowledge 通过 `search_knowledge` 显式检索；`DefaultResourceLoader` 可被替换。

**推论**：将加载、过滤、排序、执行四层分离，可降低长期演进中新增资源类型或替换存储后端的风险；只读默认原则能抑制未授权副作用。

**未知**：未来 Pi SDK 版本对 ResourceLoader 接口的要求是否变化；远程知识库或数据库后端的性能是否仍满足 200 ms 目标；多项目合并会话时的资源冲突规则尚未在代码中验证。
