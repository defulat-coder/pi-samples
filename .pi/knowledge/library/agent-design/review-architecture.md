---
type: concept
title: 人工复核：架构视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。高风险答案如何在流式体验中保留审核、拒绝和追问入口
resource: .pi/knowledge/library/agent-design/review-architecture.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, review, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: review
variant: architecture
---

# 高风险流式答案的人工复核架构：审核、拒绝与追问入口

## 摘要与问题边界

在流式（streaming）回答场景中，模型逐 token 吐出内容，用户在看到完整答案之前就可能已经接触到风险信息。人工复核不是把整段回答生成完再交给人工打分，而是在流式管道中保留可以暂停、拒绝、追问的架构入口。本文只讨论服务端到客户端之间的复核边界：谁来判定风险、何时把控制权交给人、拒绝后如何恢复、追问如何保持上下文。我们不讨论模型训练、提示词工程或法律合规细节，只关注可替换接口和长期演进结构。

## 核心概念与数据模型

1. `AnswerChunk`：流式响应的最小单元，包含 `chunkId`、`sessionId`、`turnIndex`、`deltaText`、`timestamp`、`traceId`。所有审核动作都基于 chunk 序列，而不是最终拼接后的文本。
2. `RiskSignal`：每个 chunk 的伴生风险标记，包含 `riskClass`（如医疗、金融、法律、安全）、`confidenceScore`（0–1 连续值）、`evidenceSpans`（触发风险的具体文本范围）。
3. `ReviewPolicy`：策略接口，定义 `shouldReview(chunk, context)`、`rejectThreshold`、`clarifyThreshold`、`allowedActions`。实现可以是规则、分类器、LLM-as-judge 或人工队列。
4. `ReviewCheckpoint`：流式管道中的暂停点，携带当前已累积的 chunk 序列、风险信号、候选动作（放行、拒绝、追问）。checkpoint 不阻塞网络连接，而是把状态推送给人机界面。
5. `RejectionToken`：一种特殊的终止事件，向客户端声明该流已被截断，包含 `reasonCode`、`fallbackHint`、`resumeAllowed`。它必须被当作流事件协议的一部分，而不是 HTTP 错误。
6. `ClarificationThread`：追问会话，记录用户追加的问题、模型追加的澄清、最终判定结果。它与原始 `sessionId` 绑定，但独立编号，避免污染主对话历史。
7. `AuditLog`：不可变事件序列，记录每个 checkpoint 的输入、策略版本、决策人、动作、输出 chunk 指纹。它是后续审计、回滚和指标统计的唯一来源。

## 设计决策与取舍

### 在流式中埋点，而非批量后审查
批量后审查简单，但用户已经看到风险内容。埋点方案会增加每 chunk 的延迟（约 5–20 ms），但能在风险刚露出时立即介入。取舍点：延迟敏感场景可采用“先放行低风险 chunk，对高风险 chunk 启动并行异步审查”。

### 阻断式拒绝与渐进降级
阻断式拒绝直接截断流，适合明确违规；渐进降级对高风险内容先模糊化（如“[内容需人工复核]”），再等待人工决定。前者一致性高，后者体验更平滑，但实现复杂。推荐默认阻断，对高置信度低场景使用渐进降级。

### 通用策略接口 vs. 硬编码规则
硬编码规则上线快，但无法随业务演进。`ReviewPolicy` 必须是一个接口，底层实现可替换。规则实现、模型实现、人工队列实现应共享同一事件形状，避免客户端感知差异。

### 审核能力在服务端持有，不暴露给浏览器
客户端只接收事件并渲染入口，不执行风险判定。策略密钥、分类器、人工队列连接都在 API 层。这样可以防止绕过，并保证不同客户端行为一致。

### 持久化日志 vs. 仅内存流
日志持久化会增加存储和 schema 迁移成本，但人工复核系统需要事后审计。仅内存流无法支持跨会话重放、版本回滚和争议排查。必须持久化。

## 可执行的实施流程

1. 定义 `AnswerChunk` 和 `RiskSignal` 的 JSON Schema，并在 `packages/contracts` 中发布版本号。
2. 在 `packages/pi-agent` 中抽象 `ReviewPolicy` 接口，包含同步返回、异步回调和超时默认值。
3. 在流式响应管道中插入 `ReviewCheckpoint`：每收到 chunk 时先计算风险，再决定是否进入 checkpoint。
4. 实现默认风险评分器：规则分类器 + 轻量模型分类器，输出 `confidenceScore` 和 `evidenceSpans`。
5. 实现 `RejectionToken` 和 `ClarificationRequest` 事件类型，并加入 SSE 协议。
6. 在 `apps/web` 中增加复核 UI：暂停指示、拒绝提示、追问输入框、重新生成按钮。
7. 接入持久化 `AuditLog`：写入 append-only 日志，保留策略版本、输入指纹、动作和输出指纹。
8. 建立指标采集：checkpoint 触发率、拒绝率、追问率、从触发到人工动作的中位时间、误拒率。
9. 灰度发布：按流量百分比启用新策略，支持按 `sessionId` 或 `userSegment` 回滚。
10. 定期 replay 审计日志，验证策略版本变更不会导致旧会话行为不一致。

## 输入、处理、输出示例

以下是一个贴近 TypeScript/Web/本地文件知识库的 JSON 事件示例，表示一个流式 chunk 进入 checkpoint：

```json
{
  "event": "review_checkpoint",
  "sessionId": "sess-7a9b",
  "turnIndex": 3,
  "chunkId": "c-42",
  "accumulatedText": "要删除整个项目目录，可以先执行 `rm -rf /` 再...",
  "riskSignal": {
    "riskClass": "system_safety",
    "confidenceScore": 0.91,
    "evidenceSpans": [{ "start": 38, "end": 48 }]
  },
  "actions": ["reject", "clarify", "allow"],
  "policyVersion": "v2.3.1"
}
```

输入是流式 chunk 和累积文本；处理是策略实现判定风险类别与置信度，决定候选动作；输出是 checkpoint 事件，客户端据此渲染拒绝或追问入口。

## 性能、质量与可观测性指标

1. **Checkpoint 触发率**：进入 checkpoint 的 chunk 数 / 总 chunk 数。从 `AuditLog` 统计。
2. **中位延迟（chunk 到 checkpoint 信号）**：`timestamp(review_checkpoint)` 减去 `timestamp(answer_chunk)`。目标 < 30 ms。
3. **误拒率**：人工复核后认为应当放行的拒绝数 / 总拒绝数。通过抽样审计获得。
4. **漏过率**：事后发现的高风险内容 / 已处理高风险内容。依赖离线评估集和日志 replay。
5. **人工介入中位时间**：从 checkpoint 推送到人工完成动作的时间。通过 UI 埋点测量。
6. **追问转化率**：追问后成功获得有效澄清并放行的会话比例 / 总追问会话。

## 失败模式、诊断证据与恢复动作

1. **审核器滞后**
   - 证据：chunk 到 checkpoint 信号延迟 P99 超过阈值，或风险内容已渲染后才收到拒绝。
   - 恢复：降低 chunk 累积窗口、增加并行评分、必要时临时降级为阻断策略。

2. **阈值过严导致误拒**
   - 证据：误拒率持续上升，用户频繁点击“重新生成”。
   - 恢复：提升 `rejectThreshold`，启用灰度策略对比，回滚到上一版本。

3. **上下文丢失导致追问无效**
   - 证据：追问后模型回答偏离原问题，或 `ClarificationThread` 中缺少关键 chunk。
   - 恢复：在追问事件中携带完整上下文摘要，并校验 `turnIndex` 连续性。

4. **策略版本回滚失败**
   - 证据：回滚后仍出现新版本的行为，日志中 `policyVersion` 未更新。
   - 恢复：检查版本缓存与路由配置，确保 `ReviewPolicy` 实现按版本号隔离。

5. **客户端忽略复核入口**
   - 证据：服务端已发送 `review_checkpoint`，但前端未暂停渲染。
   - 恢复：在 SSE 协议中把 `review_checkpoint` 标记为必须处理，对未处理客户端触发兼容降级。

## 问答测试样例

1. 正向：用户要求“帮我写一段删除文件的 shell 命令”。系统应识别 system_safety 风险，发送 checkpoint，提供拒绝或追问入口。
2. 正向：用户询问“2+2 等于几”。不应触发 checkpoint，直接流式输出。
3. 边界：用户要求“模拟一次 SQL 注入”。风险置信度 0.48，低于 rejectThreshold 0.60，应进入追问而非直接拒绝。
4. 边界：用户问题包含多语言风险表达，分类器返回低置信度，系统应默认进入 checkpoint，而不是放行。
5. 无证据：用户问“你怎么看？”。无明确风险类别和 evidenceSpans，不应触发人工复核。
6. 无证据：用户要求生成医疗建议，但分类器因输入过短无法提取证据，系统应拒绝生成而不是直接放行，并提示“需要更多信息”。

## 维护、版本、来源与相邻主题的关系

- `ReviewPolicy` schema 与 `AuditLog` 采用语义化版本，任何字段变更必须升级 minor 或 major 版本，并保留旧版本解析器至少两个发布周期。
- 来源证据全部来自本项目的架构文档和事件日志，不依赖外部网页；可验证性通过 `git log` 和 `AuditLog` replay 保证。
- 与相邻主题的关系：人工复核建立在“安全护栏（guardrails）”之上，但比护栏更强调人机回环；与“提示词工程”相邻，但复核接口不应修改提示词，而是控制输出流；与“模型评估”相邻，复核日志是评估数据集的重要来源。

## 结论

事实：流式答案中的风险必须在 chunk 级别被检测，并通过标准化事件协议向客户端暴露审核、拒绝、追问入口。推论：把 `ReviewPolicy` 设计成可替换接口、把审核日志持久化、把客户端保持为无判定能力的渲染层，是支持长期演进的最小可行架构。未知：具体某个业务领域的风险分类清单、不同模型在流式场景下产生风险的先验分布、以及用户愿意为等待人工复核付出多高的延迟成本，都需要在上线后通过 `AuditLog` 和 A/B 实验继续验证。
