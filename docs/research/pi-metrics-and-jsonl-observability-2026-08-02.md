# Pi 指标与 JSONL 可观测性调研

> 调研快照：2026-08-02（Asia/Shanghai）。本项目安装的 `@earendil-works/pi-coding-agent` 为 `0.83.0`。事实来源优先使用 Pi 官方文档与当前安装包类型定义；项目实现推论单独标出。

## 结论

Pi 的指标不是一个单独的“metrics”事件，而是分散在三层：

1. **模型调用层**：每个 `AssistantMessage.usage` 可包含 input、output、cacheRead、cacheWrite、可选的 cacheWrite1h、reasoning、totalTokens 和逐项 cost。
2. **Agent 运行层**：`AgentSessionEvent` 提供 agent/turn/message 生命周期、工具执行、队列、压缩、自动重试和 settled 状态。
3. **Session 汇总层**：`AgentSession.getSessionStats()` 聚合整个 JSONL 文件的用户消息、assistant 消息、工具调用/结果、token 总量和成本；`getContextUsage()` 提供当前上下文 token、窗口和百分比。

因此，Web 应同时保存“本次 turn 指标”和“整个 session 汇总”，不能只展示 output token 或一次耗时。

## 官方指标边界

### Usage 与成本

[Pi Session File Format](https://pi.dev/docs/latest/session-format) 定义了 `Usage`：`input`、`output`、`cacheRead`、`cacheWrite`、`totalTokens` 和 `cost.input/output/cacheRead/cacheWrite/total`。当前安装的 `pi-ai@0.83.0` 还包含可选的 `cacheWrite1h` 和 `reasoning`；其中 reasoning 是 output 的子集，不应再次加到 total。

### 运行事件

[Pi JSON Event Stream](https://pi.dev/docs/latest/json) 定义了：

- `agent_start`、`agent_end`、`agent_settled`
- `turn_start`、`turn_end`
- `message_start`、`message_update`、`message_end`
- `tool_execution_start/update/end`
- `queue_update`
- `compaction_start/end`
- `auto_retry_start/end`
- summarization retry 事件
- `extension_error`

`agent_end` 只代表一个低层 agent run 结束；[Pi RPC 文档](https://pi.dev/docs/latest/rpc) 明确 `agent_settled` 才表示没有自动重试、压缩重试或排队续作。因此 UI 的“完成”状态应以 settled 为最终边界，不能只数 agent_end。

### Session 汇总

当前安装包的 `AgentSession.getSessionStats()` 返回：

- session 文件路径、session id；
- user/assistant/tool call/tool result/total message 数；
- input/output/cacheRead/cacheWrite/total token；
- cost；
- 可选 `contextUsage`。

`getContextUsage()` 返回 `tokens`、`contextWindow` 和 `percent`；tokens/percent 在压缩后可能暂时为 `null`，不能显示成 0。

## JSONL 是否已经有这些指标

有，但不是全部在同一行：

- `assistant` 消息保存模型、provider、model、stopReason、timestamp、thinking/toolCall 内容和 `usage`；
- `toolResult` 消息保存 toolName、content、isError、timestamp，可选 `details` 与嵌套 `usage`；
- `compaction` / `branch_summary` 保存 tokensBefore、summary 和可选 usage；
- `thinking_level_change` / `model_change` 保存配置变化；
- Pi 的 JSONL session 是树结构，entry 通过 `id`/`parentId` 形成分支；
- 生命周期、队列和重试事件属于运行时事件，不会天然作为完整事件时间线写入 session 文件。

本项目因此继续使用 Pi 原生 JSONL 作为事实源，并在 `pi-workbench.turn` custom entry 中追加 Web 观测快照；custom entry 不进入 LLM context，但可以把事件计数、宿主测得的时间、工具耗时、重试/压缩结果和 session 汇总保存下来。

## 本项目落地映射

| 官方事实 | 项目 DTO/UI |
| --- | --- |
| `AssistantMessage.usage` | `AgentTokenUsage`，补齐缓存、reasoning、cost |
| `AgentSessionEvent` | `AgentEventSummary`，保留时间、类别、工具、重试、压缩和 settled |
| `getSessionStats()` | `AgentSessionTotals`，展示在回合指标详情与 JSONL 文件摘要 |
| `getContextUsage()` | `AgentContextUsage`，展示上下文占用和窗口 |
| `tool_execution_start/end` | `AgentToolMetric`，展示工具名、状态、耗时、输入/输出摘要 |
| JSONL message/custom/compaction entries | 结构化 Session 查看器；原始 JSONL 作为可折叠详情保留 |

宿主时间（turn 开始/结束、工具耗时）是项目观测值，不冒充 Pi provider 的服务端时间。provider 没有返回的 token/cost 继续标记为 `unavailable`，不以估算值伪装成精确值。

## 参考来源

- [Session File Format · Pi](https://pi.dev/docs/latest/session-format)
- [JSON Event Stream Mode · Pi](https://pi.dev/docs/latest/json)
- [RPC Mode · Pi](https://pi.dev/docs/latest/rpc)
- [SDK · Pi](https://pi.dev/docs/latest/sdk)
- [Pi 官方源码仓库](https://github.com/earendil-works/pi)
