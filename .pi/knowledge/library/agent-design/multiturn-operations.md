---
type: concept
title: 多轮对话：验证与运维视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。将前一轮事实、用户修正和新证据合并为下一轮上下文
resource: .pi/knowledge/library/agent-design/multiturn-operations.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, multiturn, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: multiturn
variant: operations
---

# 多轮对话上下文合并：面向验证与运维的设计与实践

## 摘要与问题边界

多轮对话不是简单地把历史消息拼接进 prompt，而是要在每一轮把前一轮确认的事实、用户主动修正和新出现的证据合并成一致的上下文。本文从验证与运维视角出发，记录成功、失败、延迟、容量和恢复证据，帮助工程师观察 Agent 在长会话中的性能、稳定性与故障恢复能力。讨论边界限定在会话运行时的上下文合并逻辑，不包括模型微调、前端 UI 状态管理，也不涉及认证与计费。

## 核心概念与数据模型

1. **TurnRecord（轮次记录）**。每一轮产生一条不可变记录，包含原始用户消息、模型回复、时间戳、token 用量和本次抽取的事实列表。它是后续合并的最小审计单元。
2. **FactSlot（事实槽）**。把领域事实按结构化槽位存储，例如 `location`、`budget`、`priority`。每个 slot 维护当前值、来源轮次、置信度、过期 TTL 和“被用户修正”标记。
3. **CorrectionDelta（修正增量）**。当用户说“不对，应该是…”时，系统生成 delta，记录被替换的 slot、旧值、新值、修正触发语句和是否显式确认。显式确认优先于模型推断。
4. **EvidenceWindow（证据窗口）**。不是所有历史都进入 prompt，而是按 token 预算、时间衰减和 slot 相关性挑选证据。窗口内的条目保留 provenance，便于回溯。
5. **ContextAssembler（上下文装配器）**。负责把 slot 快照、修正 delta、窗口证据和系统提示合并为最终 prompt envelope。装配过程必须是幂等的：同一输入顺序产生同一输出。
6. **ReconciliationLog（对账日志）**。记录每次合并前后的 slot 差异、被丢弃的证据、token 开销和异常事件。用于事后审计、回归测试和故障恢复。

## 设计决策与取舍

### 增量快照与全量快照
采用基于 slot 的增量合并：只把发生变化的事实和新证据写入上下文，而不是把全部历史消息原样塞进 prompt。这样降低 token 用量，也减少模型被早期错误引导的概率。代价是如果装配器逻辑有 bug，增量视图会与原始轮次不一致，因此必须保留全量 ReconciliationLog。

### 记忆深度与延迟预算
设定三层记忆：当前轮显式事实、近 N 轮证据、全局长期 slot。Token 预算超限时，先丢弃长期低相关证据，再压缩系统提示示例，绝不静默丢弃用户最近一轮的显式修正。边界情况：当 N=0 时，系统退化为单轮 agent，需在日志中标记“记忆截断”。

### 修正覆盖策略
支持三种强度：强替换（用户明确说“改为 X”）、软标记（用户说“也许 X”但无确认）、双轨保留（新旧值都保留并注明冲突）。默认策略是“显式强替换优先，连续冲突进入双轨并追加澄清提示”。这避免了过度相信模型对修正意图的猜测。

### 证据可信度衰减
每轮对非显式事实按衰减因子降低置信度；超过 TTL 的证据转为“过期但可参考”状态，不再写入 active context。例外：用户主动确认的关键事实不受衰减，直到用户再次修改。这样防止陈旧假设污染当前轮。

### 失败回退与降级
当装配器检测到 slot 冲突、反序列化失败或 token 预算被击穿时，执行分级回退：先尝试只保留用户显式修正的 slot；若仍超限，使用最小系统提示；若仍失败，返回可解释错误并保留当前会话状态供重试。所有回退路径都写入日志，不能静默吞掉异常。

## 可执行的实施流程

1. 在每轮结束时由提取器输出结构化 `TurnRecord`，包含 `extracted_facts` 和 `user_corrections`。
2. 对 `extracted_facts` 做归一化：去重、合并同义槽位、标记置信度来源。
3. 将 `user_corrections` 转换为 `CorrectionDelta`，并检查与当前 slot 的冲突。
4. 更新 `FactSlot`：显式修正覆盖旧值，新事实按置信度插入，过期事实降级。
5. 根据当前 token 预算和轮次相关性计算 `EvidenceWindow`，丢弃低相关性证据时记录 discard log。
6. 调用 `ContextAssembler` 生成 prompt envelope，包含系统提示、active slots、窗口证据和修正摘要。
7. 在装配前后对 slot 集合做一致性快照，写入 `ReconciliationLog`。
8. 暴露 `/health` 与 `/metrics` 端点，输出装配延迟、token 用量、冲突次数和最近失败时间戳。
9. 定期运行混沌测试：随机丢弃一轮、注入矛盾修正、压测大容量会话，验证回退路径。
10. 发布上下文 schema 版本号，并在每轮 envelope 中携带 `context_version`，保证新旧实现可灰度切换。

## TypeScript/Web/本地文件知识库示例

下面给出一个 JSON 形式的知识库片段，说明输入、处理与输出。

    {
      "input": {
        "previous_slots": {
          "location": { "value": "北京", "turn": 2, "confirmed": false, "ttl": 300 }
        },
        "new_turn": {
          "user": "不对，我在上海，而且预算提到 2000。",
          "extracted_facts": [
            { "slot": "location", "value": "上海", "confidence": 0.99, "source": "user_correction" },
            { "slot": "budget", "value": 2000, "confidence": 0.95, "source": "user_statement" }
          ]
        }
      },
      "process": {
        "deltas": [
          { "slot": "location", "old": "北京", "new": "上海", "confirmed": true },
          { "slot": "budget", "old": null, "new": 2000, "confirmed": true }
        ],
        "discarded": [],
        "context_version": "v1.3.0"
      },
      "output": {
        "prompt_envelope": {
          "system": "你是旅行规划助手。当前已知事实如下。",
          "active_slots": {
            "location": { "value": "上海", "confirmed": true, "since": 3 },
            "budget": { "value": 2000, "confirmed": true, "since": 3 }
          },
          "evidence_window": [ { "turn": 3, "summary": "用户更正地点并声明预算" } ]
        }
      }
    }

输入是上一轮的 slot 状态与新轮次提取到的事实；处理阶段生成修正 delta、丢弃无关证据、记录版本；输出是交给模型下一轮的 prompt envelope，其中显式修正被标记为 confirmed，未确认的旧值不再影响生成。

## 性能、质量和可观测性指标

1. **装配延迟（ContextAssemblyLatency）**：从收到轮次到生成 envelope 的 P99 延迟。通过 `performance.now()` 或 Node.js histogram 测量，目标一般低于 50 ms。
2. **Token 利用率（TokenUtilization）**：装配后 prompt token 数占预算上限的比例。超过 0.85 触发警告，超过 0.95 必须进入回退。
3. **修正冲突率（CorrectionConflictRate）**：用户修正与现有 slot 冲突的轮次占比。等于 `冲突轮次 / 总会话轮次`。持续高于 10% 说明事实提取或槽位设计有问题。
4. **事实漂移（FactDriftScore）**：对同一 slot，跨轮次值变化的频率。通过 ReconciliationLog 统计 `|delta| / |turns|`。高频漂移需触发审核。
5. **回退触发率（FallbackRate）**：装配过程中进入任何降级路径的会话比例。需按回退级别细分，并关联错误码。
6. **用户重复修正率（ReworkRate）**：同一 slot 被用户在连续两轮重复更正的次数。高 rework 说明上下文没有真正吸收上一轮修正。

## 失败模式、诊断证据与恢复动作

1. **上下文截断导致修正丢失**。证据：用户已声明“改为上海”，但下一轮模型仍引用“北京”；ReconciliationLog 中该 delta 被标记为 `discarded_by_prune`。恢复：提升显式修正的保留优先级；若预算不足，优先保留最近一轮的 confirmed slot 并返回提示“已丢失部分历史”。
2. **矛盾修正引起值振荡**。证据：同一 slot 在连续三轮出现 A→B→A→B；`FactDriftScore` 超过阈值。恢复：进入双轨保留，向模型同时列出候选值并要求用户澄清；同时触发运营告警。
3. **过期证据污染当前轮**。证据：模型引用一条 TTL 已过期且未被用户确认的 slot；log 中该 slot `stale=true`。恢复：收紧 TTL 或提高过期证据的过滤强度；对关键 slot 强制要求显式确认。
4. **序列化/反序列化不匹配**。证据：本地文件知识库写入的 YAML/JSON 包含未知字段，导致装配器抛 `SchemaMismatch`；/health 返回失败。恢复：使用 schema 版本号门控；旧版本数据走兼容转换层；新版本实现先灰度再全量。
5. **会话状态无限增长**。证据：长会话内存占用线性上升；EvidenceWindow 长度未收敛；出现 OOM 或 GC 压力。恢复：实施基于轮次和 TTL 的滑动窗口；对长期事实归档到外部向量存储，不再每次带入 prompt。
6. **Token 预算被击穿**。证据：prompt token 超过模型上限，API 返回 400/413；TokenUtilization=1。恢复：按优先级裁剪非系统提示内容，必要时使用更小模型摘要历史，并记录 `truncated_context` 事件。

## 问答测试样例

1. **正向问题**：用户第二轮说“把地点改成上海”，第三轮问“附近有什么好玩的？”系统应如何回答？
   可接受回答：必须基于“上海”推荐，且 ReconciliationLog 显示 location slot 在第二轮被 confirmed 为上海。

2. **边界问题**：用户在第四轮说“还是北京吧”，第五轮又说“算了，上海”，第六轮再次说“还是北京”。系统该如何处理？
   可接受回答：进入双轨保留或向用户确认；不能盲目跟随最后一次发言，应记录 oscillation 告警。

3. **边界问题**：用户只在第一轮提到预算 1000，之后过了 30 分钟再次对话，期间未确认预算。系统能否继续使用 1000？
   可接受回答：取决于 TTL 设置；若 TTL 已过期，应标记为未确认或主动询问，不能默认沿用。

4. **无证据拒答条件**：没有收到用户任何关于“旅行日期”的信息，用户问“我哪天出发？”系统应如何回应？
   可接受回答：明确说明没有该事实的记录，询问用户具体日期，不能 hallucinate 日期。

5. **正向问题**：用户说“不对，我没有说过要去上海，我说的是杭州”。系统应如何更新 slot？
   可接受回答：生成 CorrectionDelta，将 location 更新为杭州，标记 confirmed=true，并在 prompt envelope 中写入修正来源语句。

6. **边界问题**：同一轮中模型提取出两个互相冲突的事实（如 priority=高 和 priority=低）。系统应如何装配？
   可接受回答：不应直接写入单一 slot；应保留冲突摘要、降低置信度或请求用户澄清，并记录 conflict 事件。

## 维护、版本、来源和与相邻主题的关系

维护者应定期检查 ReconciliationLog 中的 `discarded_by_prune` 和 `fallback` 事件，并据此调整 EvidenceWindow 大小与 token 预算。每次修改 slot schema、覆盖策略或衰减算法，都必须升级 `context_version`，并在灰度环境中对比新旧版本的装配延迟、冲突率和用户重复修正率。

来源标记应贯穿每个事实：原始语句、轮次、提取器版本和置信度。这样当模型出现错误时，可追溯到具体轮次与证据，而不是把问题简单归因于模型本身。

多轮对话上下文合并与以下主题相邻：RAG/知识检索负责从外部库补充证据，但不负责会话内的事实一致性；提示工程决定如何表达上下文，却不能替代状态管理；会话管理负责连接生命周期与持久化，通常把上下文当作不透明 payload；评估与测试负责定义成功标准，需要依赖 ReconciliationLog 中的结构化信号。本文聚焦的是这些系统之间的“状态装配层”。

## 结论

事实：多轮对话的核心风险是“上一轮已经被确认或修正的信息在下一轮丢失或被覆盖”；通过结构化 slot、delta 日志、证据窗口和幂等装配器，可以在工程层面把风险变成可观测事件。

推论：当运维指标中修正冲突率、回退触发率和用户重复修正率同时上升时，最可能的原因是 EvidenceWindow 的裁剪策略过激进或 slot 设计粒度不足，而不是模型能力问题。

未知：不同业务场景下“显式确认”与“模型推断确认”的最优边界仍缺乏统一判据；长会话中记忆深度与模型幻觉之间的定量关系也需要在具体数据集上持续实验。
