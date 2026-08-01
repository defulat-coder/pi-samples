---
type: concept
title: 模块边界：架构视角
description: 用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。通过 package exports 和依赖方向避免 Web 直接依赖运行时细节
resource: .pi/knowledge/library/typescript-engineering/modules-architecture.md
tags: [Pi, Agent, Kimi, 知识库, typescript-engineering, modules, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: typescript-engineering
topic: modules
variant: architecture
---

# TypeScript 工程实践中的模块边界：以 package exports 阻止 Web 直接依赖运行时细节

## 摘要与问题边界

在 TypeScript 单体仓库中，模块边界不是“每个目录一个模块”的命名问题，而是编译期可见性与运行时依赖方向的控制问题。本主题讨论的是：当 `apps/web` 作为浏览器端入口、`packages/pi-agent` 作为 Pi SDK 的本地运行时封装、`packages/contracts` 作为共享 DTO 时，如何通过 `package.json` 的 `exports` 字段和依赖方向规则，防止 Web 直接引入任何运行时实现细节（例如 Pi SDK 的 `AgentSession`、`provider` 初始化、API 密钥或子进程句柄）。问题边界限定在同一 pnpm 工作区内的 TypeScript 包之间，不涉及微服务拆分、网络隔离或容器沙箱。解决目标不是消除依赖，而是让 Web 只能依赖稳定的抽象与 DTO，而运行时实现细节被锁定在适配包内部。

## 核心概念与数据模型

1. **领域契约包（packages/contracts）**：只包含可以在 Web 与 API 之间共享的 DTO、枚举、命令/响应类型和运行时抽象接口。它不允许引用 `@earendil-works/pi-coding-agent` 或任何 Node 原生模块。判断标准是：删除该包后，Web 编译应失败，而 API 仍能编译通过吗？不，contracts 是两者共同依赖的基座，删除后两者都会失败。
2. **运行时适配包（packages/pi-agent）**：封装 Pi SDK 的 `AgentSession`、`ModelRuntime`、`DefaultResourceLoader` 等具体类。它对 Web 不可见，仅向 `apps/api` 暴露一个受 `exports` 控制的入口。包内负责将 SDK 事件转换为 contracts 中定义的 SSE/JSON 事件。
3. **应用层包（apps/web 与 apps/api）**：Web 是展示与交互边界，API 是会话与传输边界。Web 的 `package.json` 中只能声明 `packages/contracts` 为依赖；API 可以声明 `packages/contracts` 和 `packages/pi-agent` 为依赖。
4. **导出契约（Exports Contract）**：每个包的 `package.json#exports` 是模块边界的“白名单”。只有被列入白名单的入口点才能在包外被导入；任何未被导出的内部路径在编译期就应触发解析失败。
5. **依赖方向规则（Dependency Direction Rule）**：工作区依赖图必须是有向无环图，且方向为 `contracts <- pi-agent`，`contracts <- web`，`pi-agent <- api`。`web` 不能依赖 `pi-agent`，`pi-agent` 不能依赖 `api` 或 `web`。
6. **可替换接口（Replaceable Runtime Interface）**：在 contracts 中定义 `IAgentSessionAdapter` 等抽象接口，由 pi-agent 提供具体实现。Web 测试可以使用 contracts 包内的内存桩实现，从而在不加载 Pi SDK 的情况下跑通 UI 逻辑。

## 设计决策与取舍

### 抽象接口应放在 contracts 还是 pi-agent？
将抽象接口与 DTO 放在 `packages/contracts`。这样 Web 和 API 都能面向接口编程，而 pi-agent 只负责实现。例外：如果接口完全围绕 SDK 的回调签名（例如 `ToolCallHandler` 的精确参数顺序），则将其留在 pi-agent，contracts 中只保留平台无关的 `ToolInvocation` 结构。

### 包的粒度：一个适配包还是多个运行时包？
当前工作区只对接一个 Pi SDK，因此保留单个 `packages/pi-agent`。若未来引入第二个运行时（例如自研 Agent 或本地 LLM 进程），应将 contracts 中抽象接口保持不变，新增 `packages/pi-agent-2` 并实现同一接口，由 `apps/api` 在启动时选择注入。此时再将 pi-agent 拆分为 `pi-adapter-pi` 和 `pi-adapter-local`。

### 是否允许 Web 依赖 API 的专属类型？
不允许。Web 能依赖的仅限于 `packages/contracts`。如果 API 需要向 Web 暴露额外字段（如服务端时间戳、会话 ID 生成策略），应先在 contracts 中新增 DTO 字段，再由 API 填充。例外：纯调试用的内部日志类型可以留在 API 内部，不进入 contracts。

### 导出白名单还是黑名单？
使用白名单。每个包的 `exports` 明确列出允许的入口，例如 `./types`、`./adapter`，不使用通配符 `"./*"`。维护成本更高，但一旦发现 Web 导入了 `./src/agent/session.ts` 这类内部路径，即可判定为违规。

### TypeScript 路径别名与包 exports 的取舍
包间通信使用 `package.json#exports` 与 workspace 依赖，包内模块使用 `tsconfig#paths` 别名。禁止在 `apps/web` 中使用 `../../packages/pi-agent/src/...` 这类相对路径，因为它绕过 exports 检查，使模块边界失效。

## 可执行的实施流程

1. 运行 `pnpm why @earendil-works/pi-coding-agent` 与 `grep -r "pi-coding-agent" apps/web packages/contracts` 确认当前 Web 或 contracts 中是否已直接引用 SDK。
2. 若存在直接引用，在 `packages/contracts` 中定义与 SDK 无关的 DTO 与 `IAgentSessionAdapter` 接口，字段只保留消息内容、工具调用、事件类型等 Web 可理解的信息。
3. 在 `packages/pi-agent` 中创建 `PiAgentSessionAdapter` 实现 `IAgentSessionAdapter`，并负责订阅 `message_update`、`tool_execution_start` 等 SDK 事件，再将其转换为 contracts 中定义的标准事件。
4. 清理 `apps/web` 的 `package.json`，移除 `@earendil-works/pi-coding-agent` 和 `packages/pi-agent` 依赖；仅保留 `packages/contracts`。
5. 为 `packages/pi-agent` 配置 `package.json#exports`，仅导出 `./adapter` 和 `./types`，并确保 `tsconfig` 中 `rootDir` 与 `outDir` 不暴露源码路径。
6. 在 `apps/web` 配置 ESLint 规则 `import/no-restricted-paths`，禁止导入 `packages/pi-agent` 与 `@earendil-works/pi-coding-agent`。
7. 运行 `pnpm build` 与 `pnpm typecheck`，确认 Web 产物不再包含 SDK 字符串；可通过 `grep -i "earendil" dist/apps/web/**/*.js` 验证。
8. 在 `packages/contracts` 中提供 `InMemoryAgentSessionAdapter` 测试桩，更新 `apps/web` 单元测试，使其不依赖真实 SDK 即可验证流式消息渲染与工具状态展示。

## 示例：导出契约与运行时接口

示例输入：一个 `apps/web` 组件需要从会话接收消息更新。处理：组件通过 `packages/contracts` 中的 `IAgentSessionAdapter` 接口与类型进行编程，而不是直接实例化 Pi SDK 的 `AgentSession`。输出：Web 只编译接口与 DTO，真实实现由 API 在服务端注入。

```json
// packages/pi-agent/package.json
{
  "name": "@pi-samples/pi-agent",
  "exports": {
    "./adapter": {
      "types": "./dist/adapter/index.d.ts",
      "default": "./dist/adapter/index.js"
    },
    "./types": {
      "types": "./dist/types/index.d.ts",
      "default": "./dist/types/index.js"
    }
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.83.0",
    "@pi-samples/contracts": "workspace:*"
  }
}
```

```typescript
// packages/contracts/src/runtime-adapter.ts
export interface IAgentSessionAdapter {
  prompt(request: AgentRequest): AsyncIterable<AgentEvent>;
  close(): Promise<void>;
}

export interface AgentRequest {
  message: string;
  sessionId: string;
}

export type AgentEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_execution_start'; toolName: string };
```

`apps/web` 通过 `import { AgentEvent } from '@pi-samples/contracts'` 消费事件；`apps/api` 通过 `import { PiAgentSessionAdapter } from '@pi-samples/pi-agent/adapter'` 创建真实会话。Web 的 bundle 永远不会包含 `AgentSession` 或 SDK 密钥。

## 性能、质量与可观测性指标

1. **违规导入数量**：运行 `pnpm lint` 统计 `import/no-restricted-paths` 报错次数。目标值为 0，每新增一次合并请求都必须归零。
2. **Web 产物运行时符号残留**：构建后执行 `grep -E "AgentSession|earendil|DefaultResourceLoader" dist/apps/web/**/*.js`。目标出现次数为 0。
3. **contracts 接口变更频率**：统计每次版本发布中 contracts 公共类型或接口的变更数量。目标为低频，稳定契约优先。
4. **Web 测试冷启动时间**：在 CI 中记录 `pnpm test --filter web` 的 wall time，比较引入 contracts 测试桩前后的耗时。目标为移除 SDK 依赖后启动时间显著下降。
5. **运行时替换成本**：记录当 Pi SDK 主版本升级或替换为另一种实现时，需要修改的包数量。理想情况下只有 `packages/pi-agent` 受影响。

## 失败模式

1. **Web 直接引用 SDK 类型**：诊断证据为 `apps/web` 中出现 `import { AgentSession } from '@earendil-works/pi-coding-agent'` 或构建产物包含 SDK 字符串。恢复动作：将类型迁移到 `packages/contracts`，逻辑迁移到 `packages/pi-agent`，并在 ESLint 中禁止该导入。
2. **pi-agent 暴露内部路径**：诊断证据为 `exports` 字段缺失或存在 `./src/*` 通配，导致 Web 可以通过 `import ... from '@pi-samples/pi-agent/src/...'` 访问。恢复动作：收紧 exports 为白名单，移除通配。
3. **contracts 包膨胀并包含 SDK 类型**：诊断证据为 `packages/contracts` 的 `package.json` 出现 `@earendil-works/pi-coding-agent` 依赖。恢复动作：将 SDK 专用类型下放到 `packages/pi-agent`，contracts 中保留抽象接口或平台无关 DTO。
4. **循环依赖**：诊断证据为 `pnpm build` 或 `turbo` 报告 `circular dependency detected`，或 TypeScript 项目引用出现相互引用。恢复动作：将共享接口提取到 `packages/contracts`，打破 pi-agent 与 api 之间的直接依赖。
5. **测试桩与真实实现语义不一致**：诊断证据为 Web 测试全部通过，但集成环境中出现事件字段缺失或工具调用格式错误。恢复动作：在 `packages/contracts` 中为 `IAgentSessionAdapter` 编写 invariant 测试，要求所有实现（包括桩与 Pi 适配器）通过同一事件序列验证。

## 问答测试样例

1. **正向**：Web 组件可以安全导入 `packages/contracts` 中的哪些类型？应回答 `AgentEvent`、`AgentRequest`、`IAgentSessionAdapter` 等 DTO 与接口，因为它们属于导出白名单且不依赖 SDK。
2. **正向**：如果要将运行时从 Pi SDK 切换到本地子进程，需要修改哪些包？应回答实现 `IAgentSessionAdapter` 的新适配器，在 `apps/api` 中切换注入，Web 和 contracts 不变。
3. **边界**：`apps/api` 是否可以直接导入 `AgentSession`？可以，因为 API 是会话编排边界，有权访问运行时实现；但禁止将该实例或相关类型通过 API 返回给 Web。
4. **边界**：`packages/contracts` 能否包含 JSON 序列化辅助函数？可以，只要这些函数只使用平台无关的类型（如 `JSON.stringify` 封装），不引用 SDK 特有结构；如果序列化逻辑依赖 SDK 内部事件，则应留在 pi-agent。
5. **无证据拒答**：当前生产环境使用的 Provider API key 是什么？项目源代码中没有该值；它仅在 `apps/api` 启动时的环境变量中，因此不能回答。
6. **无证据拒答**：Pi SDK 的 `message_update` 事件在真实网络条件下的端到端延迟是多少？项目代码与本地测试无法提供该数据，需要依赖线上监控或上游文档，因此不能回答。

## 维护、版本、来源与相邻主题

维护 `packages/contracts` 时，每次修改公共类型或接口都应视为一次潜在的破坏性变更，优先使用 `minor` 版本新增字段，避免重命名或删除已暴露字段。`packages/pi-agent` 的版本应跟踪其依赖的 `@earendil-works/pi-coding-agent` 主版本，并在 `README` 中记录兼容性矩阵。

本内容的来源是项目自身的 `AGENTS.md`、`packages/pi-agent` 的 `package.json` 与源码、`docs/pi-agent-learning.md` 以及 `pnpm-workspace.yaml`。没有访问外部系统或实际运行时的密钥。

与相邻主题的关系：模块边界与 `package.json#exports` 技术、`SOLID` 中的依赖倒置原则、`pnpm workspace` 的依赖解析、`Turborepo`/`Nx` 的任务图、浏览器端构建安全（防止密钥泄露）以及 API 的 DTO/SSE 传输协议直接相关。它不是微服务边界或容器隔离，而是编译期和构建期的可见性边界。

## 结论：事实、推论与未知

- **事实**：`apps/web` 不应依赖 `@earendil-works/pi-coding-agent` 或 `packages/pi-agent`；`packages/contracts` 负责承载共享 DTO 与抽象接口；`package.json#exports` 是实现编译期白名单的关键机制；`pnpm` 工作区中包间导入由 `exports` 与 `dependencies` 共同决定。
- **推论**：严格执行上述边界后，Web 的浏览器产物不会携带 SDK 运行时符号，运行时实现的升级或替换主要局限在 `packages/pi-agent` 内，长期演进成本会降低。
- **未知**：Pi SDK 在真实网络环境下的性能特征、Provider 的 SLA 与延迟分布、未来是否会出现第二种运行时，以及 Web 是否需要新增目前 contracts 未覆盖的复杂交互能力。这些必须等到上线监控或需求变更后才能确认。
