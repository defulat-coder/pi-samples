---
type: concept
title: 运行手册：实现视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。将触发条件、诊断步骤、恢复动作和验证证据写成顺序流程
resource: .pi/knowledge/library/markdown-knowledge/runbook-implementation.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, runbook, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: runbook
variant: implementation
---

# 运行手册：在 Markdown 知识库中实现可顺序执行的故障恢复流程

运行手册不是通用文档，而是把“触发条件→诊断步骤→恢复动作→验证证据”绑定为一条可追踪流程的知识条目。在 TypeScript/Web/本地文件知识库的语境下，它需要解决四个实现问题：输入如何被规范化接收、生命周期状态如何迁移、错误分支如何分流、以及每一步的验证证据如何被保留。本文聚焦于实现视角，目标读者是即将把这些方案写成代码的开发者。边界限定为：运行手册不替代监控或可观测系统，不在无证据时生成修复命令，也不在浏览器中暴露任何凭证。

## 摘要与问题边界

运行手册的核心目标是降低“已知故障”的重复处理成本。它假设故障症状已被监控系统或人工报告捕获，并且存在一条经过验证的恢复路径。问题边界在于：如果症状无法匹配到已知触发条件，系统应拒绝臆测恢复，转而收集更多证据；如果恢复动作可能产生不可逆副作用，必须显式声明并等待确认；如果验证证据缺失，即使恢复动作已执行，也不得标记为已解决。

## 核心概念与数据模型

1. **触发条件（Trigger）**：症状指纹、影响范围、置信度阈值。示例：`errorCode=EADDRINUSE AND service=api AND port=3000`，置信度阈值 `0.8`。
2. **诊断步骤（DiagnosticStep）**：包含步骤 id、前置条件、执行工具、期望输出、超时秒数、回退步骤。输出必须落入 `expected`、`unexpected`、`inconclusive` 三类之一。
3. **恢复动作（RecoveryAction）**：声明幂等性、副作用、所需权限、可撤销性。非幂等动作必须附加 guard 条件。
4. **验证证据（ValidationEvidence）**：可验证断言，例如 HTTP 状态码、文件存在性、日志条目正则匹配、进程退出码。
5. **运行会话（RunbookSession）**：状态机，状态为 `triggered → diagnosing → recovering → validating → resolved | failed`。
6. **证据日志（EvidenceLog）**：追加-only 结构，包含时间戳、工具名、原始输出、校验哈希，防止后续被篡改。
7. **步骤依赖图（StepGraph）**：有向无环图，诊断步骤可并发，恢复步骤必须串行，验证步骤必须串行。

## 设计决策与取舍

### Markdown 正文与结构化元数据并存

人读部分用 Markdown 编写，机器字段用前置 YAML 头保存。取舍：可解析性依赖一个稳定的 schema，任何字段变更需要同步更新解析器和版本号。

### 命令式顺序流程优先

运行手册要求明确顺序，因此步骤采用命令式编排；但在恢复动作内部，允许声明式目标验证，例如“端口 3000 无进程占用”。

### 本地文件作为知识来源，运行时状态不落地敏感数据

本地文件便于版本控制、diff 审查和 Agent 检索；运行时状态保存在内存或临时文件，凭证始终留在 API 进程。

### 诊断可并发，恢复与验证必须串行

并发诊断可缩短定位时间，但恢复动作可能相互依赖，验证必须在恢复完全结束后进行，因此后两者强制串行。

### 幂等重入而非精确一次

允许失败后重入同一运行手册。恢复动作必须设计为幂等，或带前置 guard 条件，避免重复产生副作用。

### 工具白名单而非任意命令

仅暴露只读工具和项目自定义的 `search_knowledge` 等受限工具，禁止执行未授权的写操作或 shell 任意命令。

## 可执行的实施流程

1. **定义输入模式**：接收 `IncidentDTO`，包含 `alertId`、`timestamp`、`serviceName`、`symptoms`、`severity`、`sourceLog`。
2. **加载并验证手册**：从 `.pi/knowledge/runbooks/` 读取 Markdown 文件，校验 YAML 头中的 `id`、`version`、`trigger`、`diagnosis`、`recovery`、`validation` 是否完整。
3. **触发匹配**：计算症状与触发条件的匹配度，超过阈值则创建 `RunbookSession`，否则记录为 `unmatched`。
4. **构建诊断图**：根据步骤依赖和可用工具生成 DAG，过滤掉当前环境无法执行的工具。
5. **执行诊断**：并发执行无依赖步骤，收集 `EvidenceLog`；任何步骤超时或返回 `unexpected` 即进入失败分支。
6. **选择恢复路径**：根据诊断结果映射到恢复动作；若诊断结果不能命中任何已知根因，标记为 `unknown`。
7. **顺序执行恢复**：按依赖顺序执行，每步前后记录状态快照；失败时按回退策略执行或终止。
8. **执行验证**：收集验证证据，所有断言通过则进入 `resolved`，否则进入 `failed`。
9. **输出事件流**：通过 SSE 向前端发送 `tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`message_update` 和生命周期事件。
10. **归档会话**：将 `EvidenceLog` 写入只读归档，供后续复盘和模型微调。

## 示例：本地 Markdown 运行手册条目

```yaml
# .pi/knowledge/runbooks/port-conflict.md
id: runbook-port-conflict-001
version: 1.2.0
trigger:
  symptoms:
    - errorCode: EADDRINUSE
      messageContains: "address already in use"
      service: api
      port: 3000
  confidence_threshold: 0.8
diagnosis:
  - id: d1
    name: 确认被占用端口
    tool: read
    input: { path: ".pi/logs/dev-server.log" }
    expected: "port 3000"
    timeout_sec: 5
  - id: d2
    name: 查找占用进程
    tool: shell
    input: "lsof -ti:3000"
    depends_on: [d1]
    expected: { exit_code: 0, stdout_not_empty: true }
    timeout_sec: 5
recovery:
  - id: r1
    name: 终止占用进程
    tool: shell
    input: "kill -9 $(lsof -ti:3000)"
    idempotent: true
    side_effects: ["可能终止非目标进程"]
    requires_confirmation: false
    depends_on: [d2]
validation:
  - id: v1
    name: 端口释放验证
    tool: shell
    input: "lsof -i:3000"
    expected: { exit_code: 1, stdout_empty: true }
  - id: v2
    name: 服务启动验证
    tool: shell
    input: "curl -sf http://localhost:3000/health"
    expected: { exit_code: 0, status: 200 }
```

输入：监控或日志分析产生的 `EADDRINUSE` 事件。处理：先读取日志确认端口，再查找进程，执行终止，最后验证端口释放和服务健康。输出：会话状态 `resolved` 或 `failed`，以及包含原始命令输出和哈希的 `EvidenceLog`。

## 性能、质量与可观测性指标

1. **手册加载解析延迟**：从文件读取到结构化 AST 的耗时，目标小于 50ms，可在 CI 中通过基准测试测量。
2. **触发匹配准确率**：`真阳性 / (真阳性 + 假阳性)`，通过人工标注 incident 与最终采用的手册对比计算。
3. **诊断步骤超时率**：`超时次数 / 总执行次数`，按工具类型分桶统计。
4. **恢复成功率**：`resolved 会话数 / 触发会话数`，按 runbook 维度分桶。
5. **证据完整率**：`validation` 中断言全部通过且保留原始输出的会话比例。
6. **端到端运行时长**：从 `triggered` 到 `resolved` 或 `failed` 的 p99 耗时，通过 SSE 事件时间戳计算。

## 失败模式、诊断证据与恢复动作

1. **触发条件过宽**：多个 runbook 同时匹配。诊断证据：匹配列表长度大于 1。恢复：按置信度排序，执行最高置信度；若失败则回退，并引入否定条件缩小范围。
2. **诊断工具不可用**：工具未注册或权限不足。诊断证据：`tool_execution_end` 中 `exit_code` 非 0 且包含 `ENOTFOUND` 或 `EACCES`。恢复：跳过依赖步骤，标记 `unknown`，通知人工。
3. **恢复动作非幂等**：重复执行导致状态不一致。诊断证据：第二次执行后验证失败。恢复：为动作添加 guard 条件，或改写为幂等操作。
4. **验证证据不足**：断言未覆盖真实恢复状态。诊断证据：会话 `resolved` 后故障复发。恢复：要求每个 `validation` 必须包含可观察指标，禁止仅验证“命令已执行”。
5. **Markdown schema 漂移**：YAML 头新增字段但解析器未同步。诊断证据：解析阶段抛出 `ZodError` 或字段缺失。恢复：版本化 schema 并在 CI 中运行 `pnpm typecheck`。
6. **步骤超时但未失败**：子进程或网络调用阻塞。诊断证据：状态卡在 `diagnosing` 超过 `timeout_sec` 且无 `tool_execution_end`。恢复：强制超时并清理子进程，标记 `incomplete`。

## 问答测试样例

1. **正向**：当 `api` 日志出现 `EADDRINUSE` 且端口为 3000 时，应匹配哪条运行手册并执行哪些步骤？
   答案：匹配 `runbook-port-conflict-001`，依次执行 `d1`、`d2`、`r1`、`v1`、`v2`。

2. **边界**：`d1` 未在日志中找到 `"port 3000"` 但症状存在，是否继续？
   答案：降级执行 `d2`，但置信度下降，会话标记为 `partial-evidence`。

3. **边界**：`EADDRINUSE` 和防火墙异常同时出现，多条 runbook 匹配怎么办？
   答案：按置信度排序，先执行最高置信度；若其诊断失败，再回退到次高置信度 runbook。

4. **无证据拒答**：用户仅描述“dev 起不来”，没有日志，系统应如何响应？
   答案：不得执行 `kill` 或重启命令，必须要求提供 `.pi/logs/dev-server.log` 或运行 `pnpm dev` 复现。

5. **边界**：`r1` 执行后 `v1` 仍显示端口被占用，是否自动重试？
   答案：最多重试 2 次，超过后标记 `failed` 并保留日志，禁止无限循环。

6. **边界**：`r1` 因权限不足失败，如何处理？
   答案：进入 `failed` 分支，建议用户手动执行，不允许系统自行提升权限。

## 维护、版本、来源与相邻主题关系

运行手册的版本字段采用语义化版本，破坏性变更必须升级 `version`。来源应链接到原始 incident 日志或复盘文档，保证可追溯性。与 SOP 的区别在于运行手册包含可验证证据和错误分支；与 Playbook 的区别在于 Playbook 更偏人工决策，运行手册更偏可执行流程；与检查清单的区别在于检查清单通常无状态机和顺序执行语义。在 pi-samples 项目中，运行手册存放于 `.pi/knowledge/runbooks/`，可被 `search_knowledge` 检索，也可由 Agent 在会话中引用。

## 结论

**事实**：运行手册必须包含触发条件、诊断步骤、恢复动作和验证证据四个要素；在 TypeScript 实现中，本地 Markdown 文件配合前置 YAML 是可行的知识表示形式；凭证和运行时状态必须留在 API 进程，不暴露给浏览器。

**推论**：将运行手册实现为本地 Markdown 加 YAML 元数据，可在人类可读性和机器可解析性之间取得平衡；SSE 事件流适合前端展示执行进度；幂等设计比重试次数控制更能避免副作用。

**未知**：多运行手册同时匹配时的自动消解策略在复杂故障中的准确率；长期 `EvidenceLog` 的存储成本与检索性能平衡点；以及在浏览器端不暴露工具实现细节的前提下，前端验证界面应展示多少原始证据。
