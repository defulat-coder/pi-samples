---
type: concept
title: 资源加载：实现视角
description: 围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。AGENTS、skills、prompts 与项目目录如何形成 Agent 上下文
resource: .pi/knowledge/library/pi-runtime/resources-implementation.md
tags: [Pi, Agent, Kimi, 知识库, pi-runtime, resources, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: pi-runtime
topic: resources
variant: implementation
---

# Pi Agent 运行时资源加载：从项目目录到会话上下文的实现路径

## 摘要与问题边界

资源加载不是把项目文件原样灌给模型，而是把磁盘上的 `AGENTS.md`、`.pi/skills`、`.pi/prompts`、`.pi/knowledge` 与项目目录结构，转换成 Agent 会话可以消费的上下文面。本文讨论的范围限定在 Pi SDK 的 `DefaultResourceLoader`、`createAgentSession` 与 `SessionManager` 构成的 TypeScript 运行时链路，不涉及模型本身的训练数据、API 密钥分发或前端 UI 的 SSE 渲染。实现者需要回答的核心问题是：哪些目录被信任、哪些文件被自动加载、哪些资源必须通过工具显式检索、以及加载失败时如何向调用方暴露可诊断的信号。

## 核心概念与数据模型

1. **资源根（cwd）**。`DefaultResourceLoader` 在构造时接受一个项目根目录路径。该路径是后续所有相对路径解析的锚点，也是 Pi 项目信任边界的起点。根目录必须存在且可读，否则构造阶段直接抛出 `ENOENT` 类错误。

2. **`AGENTS.md`**。项目级 Agent 上下文入口文件，通常位于项目根。它承载角色、能力约束、包管理命令、项目边界和与相邻主题的引用。加载器将其内容注入系统提示或等效上下文槽，但不解析其中的命令行。

3. **`.pi/skills`**。由 Skills CLI 管理的目录，包含第三方或自研 skill 包。每个 skill 包有自己的 `manifest` 和工具实现。运行时通过 `defineTool` 把这些工具注册到会话，但 `.agents/skills/` 和 `skills-lock.json` 是 CLI 管理的产物，不应手写。

4. **`.pi/prompts`**。提示模板目录，存放可复用的提示片段。加载器在会话初始化时按文件名或模板标识符索引，供后续 `prompt()` 调用引用。模板语法错误会导致初始化阶段报错，而不是运行时才暴露。

5. **`.pi/knowledge`**。项目自定义 Markdown 知识库。与前三者不同，它默认不会被自动加载到上下文，必须通过自定义 `search_knowledge` 工具在对话中按需检索。这是控制上下文窗口和成本的关键设计。

6. **`DefaultResourceLoader` 加载管线**。其内部通常按“发现目录 → 校验文件 → 解析元数据 → 构建资源索引 → 注入会话上下文”的顺序执行。任何一步失败都会中断构造，不会留下半初始化状态。

7. **会话上下文物化形式**。最终表现为系统提示文本、已注册工具列表、资源索引表和事件订阅通道。调用方在 `session.prompt()` 之前必须完成订阅，否则无法接收 `message_update` 或 `tool_execution_*` 事件。

## 设计决策与取舍

**文件系统优先于打包资源**。`DefaultResourceLoader` 以本地目录为输入，而不是嵌入式 JSON 包。这样开发者可以直接用 IDE 编辑 Markdown 和 YAML，代价是运行时依赖文件系统权限和目录结构稳定。若部署到无本地盘环境，需要自行实现虚拟文件加载器。

**AGENTS.md 自动加载，knowledge 显式检索**。`AGENTS.md` 和 `.pi/skills`、`.pi/prompts` 在会话初始化时进入上下文，`.pi/knowledge` 不自动进入。取舍在于：自动加载保证 Agent 始终掌握项目契约，但可能浪费 token；knowledge 按需搜索保留 token，但要求工具实现正确返回结构化结果。

**Skills 只注册，不手写工具源码**。`npx skills add` 安装第三方 skill 后，运行时通过 SDK 自动注册；自定义工具才需要手写 `defineTool`。若越过 CLI 直接修改 `.agents/skills/` 中的文件，下一次 `npx skills experimental_install` 会覆盖改动，导致不可预期的工具签名变化。

**Markdown 原生格式降低模板门槛，但缺乏强类型校验**。提示模板和知识库都用 Markdown，便于版本控制和人工审阅。缺点是加载器无法像 JSON Schema 那样在构造阶段对模板参数做严格校验，错误往往延迟到首次渲染时暴露。

**只读上下文与可写工具分离**。项目上下文资源只读，工具可以只读（`read`、`search_knowledge`）或写。本项目的 API 只暴露读工具，因此资源加载后不会被运行时修改；若未来扩展写工具，需要在调用边界增加审批和审计。

## 可执行的实施流程

1. 确认 `packageManager` 为 `pnpm@10.30.3`，运行 `pnpm install` 同步 `pnpm-lock.yaml`。
2. 在项目根创建 `AGENTS.md`，写入项目边界、命令映射和信任声明。
3. 执行 `npx skills experimental_install` 恢复 `.agents/skills/` 和 `skills-lock.json`，再用 `npx skills add <owner/repo> --skill <name> -a universal -y` 添加所需技能。
4. 创建 `.pi/prompts/` 目录，按命名约定存放提示模板，例如 `system-prompt.md`。
5. 创建 `.pi/knowledge/` 目录，将项目知识切成小文件，便于 `search_knowledge` 返回精确片段。
6. 在 `packages/pi-agent` 中引入 `DefaultResourceLoader`，以 `process.cwd()` 或配置的项目根路径构造。
7. 初始化 `SessionManager.inMemory()` 作为会话注册表，调用 `createAgentSession()` 并传入 `ModelRuntime` 与已加载资源。
8. 在 `session.prompt()` 前完成事件订阅，处理 `text_delta`、`thinking_delta`、`tool_execution_start/update/end` 和生命周期事件。
9. 运行 `pnpm typecheck` 和 `pnpm test`，确认资源加载与事件流无类型错误。
10. 运行 `pnpm dev`，通过 Web Inspector 观察 SSE 消息，验证上下文是否按预期进入模型。

## 代码示例：资源加载与知识检索

```typescript
import { createAgentSession, DefaultResourceLoader, SessionManager, defineTool } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';

const cwd = process.env.PI_PROJECT_ROOT || process.cwd();
const loader = new DefaultResourceLoader({ cwd });

await loader.load(); // 失败时抛出，不会半初始化

const searchKnowledge = defineTool({
  name: 'search_knowledge',
  description: '在 .pi/knowledge 中搜索项目知识',
  parameters: z.object({ query: z.string(), limit: z.number().optional() }),
  execute: async ({ query, limit }) => {
    const results = await loader.knowledge.search(query, { limit });
    return { content: results.map(r => r.text).join('\n'), details: results };
  },
});

const session = createAgentSession({
  modelRuntime,
  resources: loader.resources,
  tools: [searchKnowledge],
});

const manager = SessionManager.inMemory();
manager.register(session.id, session);

session.events.on('message_update', (delta) => sendToClient(delta));
session.events.on('tool_execution_end', (result) => auditLog.write(result));

await session.prompt('如何在本项目中添加一个新的 Skill？');
```

输入：`cwd` 指向项目根；`.pi/knowledge` 存在 Markdown 文件。处理：`DefaultResourceLoader` 加载目录、注册工具、构建索引；`search_knowledge` 在调用时检索知识。输出：SSE 流中的 `text_delta` 和 `tool_execution_end` 结构化结果；失败时返回错误事件而非静默吞掉。

## 性能、质量、可观测性指标

1. **资源加载耗时**。从 `new DefaultResourceLoader()` 到 `await loader.load()` 结束的时间。应在 500 毫秒内完成普通项目；超过 2 秒需要检查是否加载了过多知识文件。
2. **上下文 token 数**。加载完成后统计系统提示 + 自动注入资源所占 token。超过模型上下文上限 80% 时触发告警。
3. **知识检索命中率**。`search_knowledge` 返回非空结果的查询比例。低于 50% 说明切分策略或关键词索引有问题。
4. **工具调用成功率**。`tool_execution_end` 中 `success` 为 true 的比例。低于 95% 需要检查参数 schema 和资源加载一致性。
5. **事件流延迟**。从 `session.prompt()` 到首个 `message_update` 的时间。超过 1 秒通常意味着模型建立连接或资源注入耗时过长。

## 失败模式、诊断证据与恢复动作

1. **cwd 不存在或不可读**。诊断证据：`loader.load()` 抛出 `ENOENT` 或 `EACCES`。恢复动作：检查 `PI_PROJECT_ROOT` 环境变量，确认路径存在且 Node 进程有读取权限。
2. **`AGENTS.md` 缺失**。诊断证据：加载器警告或上下文为空，Agent 无法回答项目特定命令。恢复动作：在项目根创建 `AGENTS.md`，至少包含项目边界和命令映射。
3. **Skills 安装与 lock 文件不一致**。诊断证据：`skills-lock.json` 与 `.agents/skills/` 内容不匹配，或 `pnpm dev` 启动时工具签名校验失败。恢复动作：运行 `npx skills experimental_install`，不要手动修改 skill 文件。
4. **提示模板语法错误**。诊断证据：首次引用模板时抛出渲染错误，或输出出现未替换的占位符。恢复动作：在 `.pi/prompts` 中运行静态模板校验脚本，确保变量与调用方传入一致。
5. **知识库搜索返回空**。诊断证据：用户问项目知识时 Agent 回答“没有相关信息”。恢复动作：检查 `.pi/knowledge` 是否被 `DefaultResourceLoader` 索引，确认文件扩展名为 `.md`，并调整切分粒度。
6. **事件订阅遗漏**。诊断证据：调用 `session.prompt()` 后前端未收到 SSE。恢复动作：确保订阅在 `prompt()` 之前完成，并在会话关闭时调用 `unsubscribe` 和 `dispose`。

## 问答测试样例

1. **正向**：本项目使用哪个包管理器？预期回答：pnpm 10.30.3，依据 `AGENTS.md` 中的命令表。
2. **正向**：如何为 Pi 会话添加自定义工具？预期回答：使用 `defineTool()` 并在 `createAgentSession` 时传入，同时保持只读约束。
3. **边界**：`.pi/knowledge` 是否自动加载到上下文？预期回答：不会，必须通过 `search_knowledge` 工具按需检索。
4. **边界**：能否手动修改 `.agents/skills/` 中的文件？预期回答：不建议，会被 `npx skills experimental_install` 覆盖。
5. **无证据**：本项目的模型 API 密钥存储在哪里？预期拒绝：公开上下文中没有 API 密钥位置信息，请参考部署文档或环境变量配置。
6. **无证据**：Pi SDK 的下一个版本会支持哪些新事件？预期拒绝：当前项目上下文只包含已安装 SDK 版本的行为，无法预测未来版本。

## 维护、版本、来源与相邻关系

`AGENTS.md` 和 `.pi/` 目录应与代码一起版本控制。`skills-lock.json` 必须提交，保证团队使用同一 skill 版本。`.pi/prompts` 和 `.pi/knowledge` 的变更建议走 PR 审查，因为它们直接影响 Agent 输出。来源上，`DefaultResourceLoader` 与 `SessionManager` 来自 `@earendil-works/pi-coding-agent`，而 `search_knowledge` 是本项目自定义工具。与相邻主题的关系：资源加载属于 `packages/pi-agent` 职责；`apps/api` 负责请求验证和 SSE 传输；`apps/web` 不接触 SDK 或密钥。

## 结论

事实：Pi 运行时通过 `DefaultResourceLoader` 把项目根目录、`.pi/skills`、`.pi/prompts` 和 `AGENTS.md` 加载为会话上下文；`.pi/knowledge` 必须经 `search_knowledge` 工具显式检索；`pnpm` 与 Skills CLI 管理 skill 包。推论：在会话初始化前完成资源加载与事件订阅，可以显著降低运行时故障和 token 浪费。未知：不同模型运行时对相同上下文长度的实际开销差异、以及 `DefaultResourceLoader` 在超大知识库下的索引策略细节，需要针对具体部署进行基准测试。
