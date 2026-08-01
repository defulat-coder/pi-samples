---
type: concept
title: 取消：架构视角
description: 把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。将用户停止、浏览器离开和 API 中止传递到 Agent session
resource: .pi/knowledge/library/web-streaming/cancel-architecture.md
tags: [Pi, Agent, Kimi, 知识库, web-streaming, cancel, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: web-streaming
topic: cancel
variant: architecture
---

# Web 流式交互中取消信号向 Agent Session 的传递架构

## 摘要与问题边界

在 Web 触发的 Pi Coding Agent playground 中，取消不是关闭一个按钮的样式状态，而是把三类异构事件——用户点击停止、浏览器 tab 隐藏或关闭、API 进程主动中止——一致地转化为对 `AgentSession` 的终止请求。本文讨论的范围止于会话级取消：即让运行中的 `session.prompt()` 停止产生新的输出、停止派发工具调用，并释放与该会话绑定的订阅句柄。它不包括模型内部正在进行的推理步骤的强制中断（这取决于具体 provider 的 `AbortSignal` 支持），也不包括已落盘文件或数据库状态的回滚（属于事务边界而非取消边界）。设计目标是让取消动作可追踪、可替换、在浏览器与 API 之间不丢失。

## 核心概念与数据模型

1. **取消源（Cancellation Source）**。产生取消意图的实体，包括：用户点击 UI 停止按钮、浏览器触发 `pagehide`/`beforeunload`、API 进程收到 `SIGTERM` 或调用方显式 `controller.abort()`。每个源必须携带一个可验证的身份和原因标签，例如 `user-stop`、`browser-leave`、`api-shutdown`。

2. **取消令牌（SessionAbortToken）**。与会话一一对应的单一对象，通常封装 Node.js 的 `AbortController` 或 Web 的 `AbortSignal`。关键约束是：令牌由 `packages/pi-agent` 在创建 `AgentSession` 时生成，并在 `session.prompt()` 调用前注入，而不是由浏览器直接构造，防止客户端伪造会话级中止权限。

3. **取消传播器（CancelPropagator）**。位于 `apps/api` 与 `packages/pi-agent` 之间的薄层接口，负责把浏览器层的取消请求映射到 `session.abort(reason)`。它只做三件事：验证请求来源、去重同一取消 ID、调用底层 SDK 的终止方法并返回确认。

4. **响应片段状态机（ResponseChunkStateMachine）**。跟踪一次 `prompt()` 输出的生命周期：`started` → `streaming` → `cancelled` | `completed` | `failed`。取消时，如果状态机处于 `streaming`，则后续到达的 `text_delta` 或 `tool_execution_start` 都视为过期数据并被丢弃，避免取消后界面仍继续滚动。

5. **工具执行边界（ToolExecutionBoundary）**。Pi SDK 的工具调用可能是异步长任务。取消必须在该边界产生 `tool_execution_end` 或向工具内部传递 `AbortSignal`，否则工具会继续读写文件或调用外部进程。该边界由 `CancelPropagator` 在调用 `session.abort()` 后继续监听，直到所有 `tool_execution_end` 事件到达。

6. **取消确认日志（CancellationAcknowledgmentLog）**。每次取消请求记录：取消 ID、源标签、API 收到时间、SDK 确认时间、最终响应片段状态、资源释放时间。该日志是排查“取消后仍有副作用”的唯一来源。

## 设计决策与取舍

### 取消权威归属 API 层而非浏览器层

浏览器只被允许表达“我不再需要这次会话的输出”，真正的取消 authority 在 `apps/api`。这样即使浏览器 tab 直接关闭，未发送取消请求，API 也可以依赖心跳超时或 SSE 连接断开推断取消意图。代价是 API 必须维护每个会话的最后活动时间，并承担误推断风险。

### 浏览器离开默认触发软取消，用户停止触发硬取消

`pagehide` 事件不一定意味着用户永久离开页面，可能只是切 tab。因此它只触发软取消：先尝试优雅中止，并在 5 秒内没有收到 SDK 确认时再升级。用户点击停止按钮则直接触发硬取消，跳过软取消阶段。

### SSE 连接断开不自动等价于取消

流式传输中，SSE 连接可能因网络抖动而断开，但用户并未停止。如果把 SSE 断开直接映射为取消，会导致在弱网环境下会话频繁被误杀。因此 SSE 断开后进入 30 秒宽限期，期间若浏览器重连并恢复同一 session ID，则继续输出；只有宽限期结束且未重连才触发软取消。

### 工具执行期间取消采用信号传递而非强制终止

直接 kill 工具进程可能留下半写文件。更安全的做法是：把 `AbortSignal` 传入工具执行上下文，让工具自己决定如何优雅退出。只有工具在 10 秒内未响应取消时，才允许 API 强制结束进程。这要求所有自定义工具在 `defineTool()` 时声明是否支持 `AbortSignal`。

### 取消后保留已输出片段但标记来源

已经推送到浏览器并被渲染的响应片段不会被隐藏，而是追加 `cancelledAt` 元数据，告知前端“后续内容来自取消前的输出”。这保留了用户的上下文连续性，但明确告知内容可能不完整。

## 可执行的实施流程

1. 在 `apps/web` 中初始化会话时，由 `apps/api` 返回 `sessionId` 和 `cancelEndpoint`，前端不保存任何 API 密钥或 provider 配置。

2. `apps/web` 为停止按钮绑定事件处理器，点击时生成 `clientCancelId`（UUID）并附带 `reason: user-stop` 向 `cancelEndpoint` 发送 `POST` 请求。

3. `apps/web` 监听 `window.pagehide` 与 `beforeunload`，在事件触发时调用 `navigator.sendBeacon` 发送同样的取消请求，避免异步 `fetch` 在页面卸载时被中断。

4. `apps/api` 接收到取消请求后，用 `sessionId` 从 `SessionManager.inMemory()` 中查找对应会话，验证请求身份与当前 session 的绑定关系。

5. `apps/api` 把请求交给 `CancelPropagator`，由其生成 `serverCancelId` 并记录到 `CancellationAcknowledgmentLog`，检查该 session 是否已有未完成的取消请求。

6. `CancelPropagator` 调用 `session.abort({ reason })`，并订阅 `session` 的 `message_update` 和 `tool_execution_end` 事件，确认没有新的输出片段继续产生。

7. `CancelPropagator` 收到 SDK 的终止确认后，更新 `CancellationAcknowledgmentLog` 中的 `acknowledgedAt` 字段，并向浏览器返回 `204 No Content` 或 SSE 终端帧。

8. `apps/api` 在确认终止后，调用 `session.unsubscribe()` 和 `session.dispose()`，释放 `AbortController` 与订阅句柄，并从 `SessionManager` 中移除该会话。

## 类型与接口示例

```typescript
// packages/pi-agent/src/cancel-propagation.ts
export interface CancelPropagator {
  propagate(sessionId: string, source: CancelSource): Promise<CancelResult>;
}

export type CancelSource =
  | { kind: 'user-stop'; clientCancelId: string; timestamp: number }
  | { kind: 'browser-leave'; via: 'pagehide' | 'beforeunload'; timestamp: number }
  | { kind: 'api-shutdown'; signal: 'SIGTERM' | 'SIGINT' };

export interface CancelResult {
  serverCancelId: string;
  previousState: 'started' | 'streaming' | 'completed' | 'cancelled' | 'failed';
  acknowledged: boolean;
  toolExecutionPending: string[]; // 仍未结束的工具调用 ID
  releasedAt: number;
}
```

输入是 `sessionId` 和一个带原因标签与时间戳的取消源对象。处理由 `CancelPropagator` 完成去重、权限验证、调用 `session.abort()` 并等待工具边界结束。输出返回取消前状态、是否被 SDK 确认、仍挂起的工具调用列表以及资源释放时间戳，供日志与前端状态同步使用。

## 性能、质量与可观测性指标

1. **取消请求到 SDK 确认的平均延迟**。从 `CancelPropagator` 收到请求到 `session.abort()` 返回或事件确认的时间。目标在本地运行时低于 50ms，可通过 `CancellationAcknowledgmentLog` 中的 `acknowledgedAt - receivedAt` 计算。

2. **取消成功率**。在 5 秒内收到 SDK 确认的取消请求占比。监控方式：统计 `acknowledged: true` 的日志条目数除以总取消请求数。

3. **误取消率**。因 SSE 断开或心跳超时导致、但用户在宽限期内重新连接的会话比例。通过会话重连日志与取消日志的关联计算，目标低于 1%。

4. **工具执行取消 hanging 时间**。从 `session.abort()` 到所有 `toolExecutionPending` 为空的最大耗时。若超过 10 秒，应触发告警。

5. **端到端取消响应时间**。从浏览器点击停止到 UI 停止滚动的耗时。由前端记录 `user-stop` 发送时间与最后一个 `text_delta` 渲染时间之差，目标低于 200ms。

## 失败模式、诊断证据与恢复动作

1. **浏览器离开后取消请求未到达 API**。诊断证据：`beforeunload` 或 `pagehide` 发送成功，但 `CancellationAcknowledgmentLog` 中无对应记录；恢复动作：依赖 SSE 宽限期与心跳超时，在 30 秒后触发软取消，并在 API 关闭时兜底清理。

2. **SDK 未实现 `session.abort()` 或返回无响应**。诊断证据：`CancelPropagator` 调用后 5 秒未收到确认，且日志中 `acknowledged: false`。恢复动作：强制调用 `session.unsubscribe()` 并释放引用，同时记录 provider 能力缺口，避免将后续请求路由到该 provider 配置。

3. **工具执行内部吞掉 `AbortSignal` 继续运行**。诊断证据：`CancelResult.toolExecutionPending` 长期非空，且后端进程或文件持续变更。恢复动作：在 10 秒超时后向工具进程发送 `SIGTERM`，并标记该工具版本为“不支持取消”，在注册时降级为强制超时。

4. **重复取消请求导致竞态**。诊断证据：同一 `serverCancelId` 下出现多条 `acknowledged` 记录，或 `previousState` 在 `cancelled` 后仍收到 `text_delta`。恢复动作：`CancelPropagator` 以 `serverCancelId` 去重，确保对同一 session 同一秒内只发起一次 `session.abort()`，后续请求直接返回已记录结果。

5. **取消确认丢失，前端停止按钮一直显示加载**。诊断证据：API 日志显示已释放，但浏览器未收到 SSE 终端帧或 `204` 响应。恢复动作：前端为取消请求设置 10 秒超时，超时后自动重置 UI 为“已取消”状态，并允许用户再次发起会话，API 对重复 session ID 返回 `already-cancelled` 而不执行新操作。

## 问答测试样例

1. **正向问题**：用户点击停止按钮后，取消信号如何到达 `AgentSession`？答案：浏览器发送带 `clientCancelId` 的 `POST` 请求，API 验证后通过 `CancelPropagator` 调用 `session.abort()`，并返回 `CancelResult` 记录。

2. **正向问题**：`pagehide` 与用户停止在取消强度上有什么区别？答案：`pagehide` 触发软取消，5 秒未确认后升级；用户停止直接触发硬取消。

3. **边界问题**：SSE 断开是否一定取消会话？答案：不一定，30 秒宽限期内重连可继续；只有宽限期结束且无重连才触发软取消。

4. **边界问题**：工具执行中取消是否立即停止？答案：优先通过 `AbortSignal` 通知工具优雅退出；10 秒未响应才强制终止。

5. **无证据时的拒答条件**：如果 `CancellationAcknowledgmentLog` 中没有记录，能否确认会话已取消？答案：不能，只能确认“未收到取消请求”；需结合 SSE 心跳超时或 API 关闭推断，但不能作为事实确认。

6. **无证据时的拒答条件**：如果前端未显示停止按钮，是否说明用户从未取消？答案：不能，浏览器可能通过 `pagehide` 或 tab 关闭触发取消，无需点击按钮。

## 维护、版本、来源与相邻主题关系

本设计依赖 `@earendil-works/pi-coding-agent` 的 `AgentSession` 与 `AbortSignal` 契约，版本锁定为仓库内安装的 `0.83.0`。若上游 SDK 在后续版本扩展 `abort()` 的返回值或增加工具级取消信号，应通过 `CancelPropagator` 接口适配，而不是直接修改 `apps/web` 或 `apps/api` 的事件处理代码。

来源上，取消策略来源于三部分：项目 `AGENTS.md` 中的会话生命周期约定、SDK 的 `session.prompt()` 订阅/取消模式，以及 `apps/api` 的 SSE 传输契约。与相邻主题的关系如下：与**重试**相邻，取消后的会话不应自动重试，需由用户显式发起新会话；与**流式恢复**相邻，SSE 宽限期机制为恢复提供入口，但取消一旦确认则不可恢复；与**SessionManager** 相邻，取消完成后必须从 `inMemory()` 注册表中移除，防止内存泄漏；与**工具注册**相邻，所有自定义工具应声明是否支持 `AbortSignal`；与**可观测性**相邻，取消日志是审计流式会话生命周期的核心数据源。

## 结论

事实层面：`AgentSession` 由 `packages/pi-agent` 创建并持有 `AbortSignal` 权威；`apps/api` 负责验证与转发取消请求；`apps/web` 只表达取消意图，不持有 provider 凭证；SSE 断开不直接等价于取消；取消完成后必须调用 `unsubscribe()` 与 `dispose()`。

推论层面：将取消权威集中在 API 层，比让浏览器直接控制会话更能抵御 tab 关闭、网络抖动等不可靠场景；区分软取消与硬取消可以在减少误杀的同时保证用户停止的响应速度；工具级 `AbortSignal` 优雅退出优于强制 kill，前提是工具作者遵守契约。

未知层面：不同 provider 对 `session.abort()` 的内部实现细节（例如是否立即终止推理、是否继续产生缓存 token）未在项目中完全验证；在并发量较高时 `SessionManager.inMemory()` 的取消去重与宽限期管理是否会产生长尾延迟，需要生产流量验证；浏览器在 `pagehide` 时 `sendBeacon` 的送达率在不同浏览器与扩展环境下的实际表现，目前仅依赖设计假设而非实测数据。
