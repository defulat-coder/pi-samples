---
type: concept
title: 多轮对话：实现视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。将前一轮事实、用户修正和新证据合并为下一轮上下文
resource: .pi/knowledge/library/agent-design/multiturn-implementation.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, multiturn, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: multiturn
variant: implementation
---

# 多轮对话上下文的合并与再注入：一个 TypeScript 实现视角

## 摘要与问题边界

多轮对话不是把历史消息简单拼接成字符串。实现层面的核心问题是：前一轮产生的事实、用户随后给出的修正、以及外部检索到的新证据，如何在下一轮的上下文窗口中被合并、去重、排序，再注入模型。本文聚焦单会话内的上下文合并，目标是把方案落成可在 `apps/api` 与 `packages/pi-agent` 中运行的 TypeScript 代码。讨论范围涵盖消息、事实、修正、证据、窗口预算、验证和生命周期事件；不讨论跨会话长期记忆、模型微调、多智能体编排，也不把 Web 层作为 Pi SDK 或密钥的载体。

## 核心概念与数据模型

1. **消息单元 `MessageTurn`**：最小历史记录，字段至少包括 `id`、`role`（user / assistant / system / tool）、`content`、`timestamp`、`provenance`（来源文件或工具名）和 `checksum`（SHA-256 或确定性哈希）。它不可被就地修改，用户修正只能追加一条新记录。
2. **事实断言 `FactClaim`**：从单条或多条消息中提取的陈述，字段包括 `claimId`、`text`、`sourceTurnId` 列表、`confidence`（0 到 1）、`status`（pending / confirmed / refuted / superseded）以及 `correctionChain`。同一事实在后续轮次中可以产生多个版本的断言。
3. **用户修正 `UserCorrection`**：显式覆盖或补充，字段包括 `targetTurnId`、`originalClaimId`、`correctedText`、`correctionType`（add / refine / retract）。修正本身也是一条 `MessageTurn`，因此同样可溯源。
4. **证据片段 `EvidenceSnippet`**：来自本地文件、检索结果或工具返回的新证据，字段包括 `evidenceId`、`text`、`source`（绝对路径或 URL）、`retrievalConfidence`、`retrievedAt` 和 `contentHash`。
5. **上下文窗口 `ContextWindow`**：运行时可配置的资源约束，字段包括 `tokenBudget`、token 计数函数（与模型分词器一致）、`orderingPolicy`（最近优先、重要性优先、混合）、`evictionStrategy`（直接丢弃 / 摘要 / 压缩）以及 `separator`。
6. **合并产物 `MergedPrompt`**：最终注入模型的数据结构，字段包括 `systemInstruction`、`contextLines`（带 provenance 标签的条目）、`instruction`、`validationManifest`（本次注入包含的 claimId、correctionId、evidenceId 列表）和 `tokenUsage`。

## 设计决策与取舍

**消息全文保留还是事实抽取？**
保留完整消息最简单，token 开销高，且容易把重复、矛盾和过时细节一起喂给模型。事实抽取能降低上下文长度，但会丢失语气、条件与限定语。推荐折中：最近三到五轮保留原文，更早内容压缩成 `FactClaim` 与摘要。

**用户修正的权威性边界**
用户修正默认高于模型输出，但不应无条件覆盖物理文件或已验证的代码。实现时引入 `validationThreshold`：若修正与文件哈希冲突，则标记为 `refuted-pending-user-evidence`，并把矛盾项保留在 `validationManifest` 中提示下一轮。

**新证据的时效性规则**
同一来源出现新证据时，旧证据状态设为 `superseded`，而不是删除。不同来源出现矛盾证据时，按 `retrievalConfidence` 和 `retrievedAt` 加权排序。若两者置信度差距小于 0.1，则保留冲突标注，让模型自行表达不确定性。

**窗口截断的优先级**
截断不能仅按时间。优先级应为：用户修正 > 高置信度且被引用的事实 > 当前轮用户输入 > 近期 assistant 回复 > 低置信度证据。被截断项应生成压缩摘要，摘要同样携带原 provenance。

**同步合并还是流式增量**
在每次调用 `session.prompt()` 前同步执行一次 `ContextMerger.assemble()` 更容易验证；流式增量维护状态机可以降低延迟，但会在错误时产生不可恢复的中间状态。建议先实现同步合并，并把耗时步骤（文件读取、摘要）暴露为 `merge_start` 与 `merge_end` 生命周期事件。

## 可执行的实施流程

1. 对入参执行 Schema 校验：使用 Zod 校验 `MessageTurn`、`UserCorrection`、`EvidenceSnippet` 和 `ContextWindow` 的必要字段。
2. 持久化原始轮次：把用户消息写入只追加存储，计算 `checksum`，确保后续所有引用都指向不可变记录。
3. 提取事实断言：从 assistant 输出和工具结果中按正则或结构化模式提取 `FactClaim`，类型守卫用 `isFactClaim(candidate)` 进行。
4. 解析用户修正：把 `UserCorrection` 关联到 `targetTurnId` 和 `originalClaimId`，找不到目标时标记为 `orphan` 并返回错误事件。
5. 引入新证据：把检索结果按 `source` 分组，校验 `contentHash`，与现有事实做相似度比对，更新 `status`。
6. 冲突消解：若同一事实存在多个版本，按优先级规则产生一个 `resolvedClaim`；保留被覆盖的断言作为 `supersededBy`。
7. 构建上下文列表：按优先级排序，最近几轮保留原文，早期内容替换为摘要，生成 `contextLines`。
8. 装配与验证：使用模型分词器计算 token，截断或摘要到预算内，输出 `MergedPrompt` 并附带 `validationManifest`。

## 输入、处理与输出示例

以下是一个贴近本地文件知识库的 JSON 示例，用 4 个空格缩进展示，不依赖外部系统：

    {
      "input": {
        "history": [
          {
            "id": "t1",
            "role": "user",
            "content": "这个项目怎么启动？"
          },
          {
            "id": "t2",
            "role": "assistant",
            "content": "运行 pnpm start。"
          },
          {
            "id": "t3",
            "role": "user",
            "content": "不对，启动命令是 pnpm dev，请参考 AGENTS.md。"
          }
        ],
        "evidence": [
          {
            "evidenceId": "e1",
            "source": "AGENTS.md",
            "text": "Start Web + API：pnpm dev",
            "contentHash": "a1b2c3..."
          }
        ]
      },
      "processing": {
        "t2_facts": [
          {
            "claimId": "c1",
            "text": "启动命令是 pnpm start",
            "status": "refuted"
          }
        ],
        "t3_correction": {
          "targetTurnId": "t2",
          "correctionType": "refine",
          "correctedText": "启动命令是 pnpm dev"
        },
        "resolvedClaim": {
          "claimId": "c2",
          "text": "启动命令是 pnpm dev",
          "status": "confirmed",
          "evidenceIds": ["e1"]
        }
      },
      "output": {
        "systemInstruction": "你是项目助手，只能使用已验证的本地文件信息。",
        "contextLines": [
          "t1: 用户问：这个项目怎么启动？",
          "t2: 助手曾回答：运行 pnpm start。（已被 t3 修正）",
          "t3: 用户修正：启动命令是 pnpm dev。",
          "e1(AGENTS.md): 启动命令是 pnpm dev"
        ],
        "instruction": "请用确认过的事实回答用户。",
        "validationManifest": ["c1", "c2", "e1"]
      }
    }

输入包括历史轮次与本地文件证据；处理阶段把旧事实标记为 refuted，用用户修正和证据生成确认事实；输出把经过验证的条目按优先级注入下一轮，并附带可验证清单。

## 性能、质量和可观测性指标

1. **合并延迟**：从收到新消息或新证据到 `MergedPrompt` 装配完成的时间。测量方式是记录 `merge_start` 与 `merge_end` 时间戳，目标 P95 低于 200 毫秒。
2. **上下文命中率**：回答中引用的 claim / evidence 占用户问题相关项的比例。通过 `validationManifest` 与最终输出中的引用标签比对。
3. **Token 利用率**：`tokenUsage.used / tokenUsage.budget`。长期低于 0.5 说明保留过多原文，高于 0.9 则截断风险高。
4. **修正采纳率**：`acceptedCorrections / totalCorrections`。低采纳率提示修正关联逻辑或目标识别有问题。
5. **冲突解决准确率**：自动消解结果与人工标注的一致率。使用采样集计算，目标大于 0.85。
6. **SSE 事件完整性**：`tool_execution_start`、`merge_end` 等事件不丢失。通过端到端测试检查事件序列。

## 失败模式、诊断证据与恢复动作

1. **修正漂移**：用户修正指向了错误的 `targetTurnId`。诊断证据是 `correctionChain` 出现 `orphan` 节点；恢复动作是要求用户明确给出被修正的 `claimId` 或匹配文本，并设置相似度阈值 0.85。
2. **证据冲突导致的振荡**：旧证据与新证据反复推翻同一事实。诊断证据是 `status` 在 `confirmed` 与 `refuted` 之间多次变化；恢复动作是固定 `recency-weight` 并引入置信度下限，只有差距超过 0.1 才更新状态。
3. **窗口截断丢失关键修正**：重要修正因 token 不足被截断，模型再次输出旧错误。诊断证据是 `validationManifest` 不包含该修正；恢复动作是把所有 `UserCorrection` 标记为不可截断，被截断时改为摘要而非丢弃。
4. **注入分隔符被误读**：模型把 provenance 标签当作用户内容。诊断证据是输出中混入了 `t2:` 或 `e1(...)` 等标记；恢复动作是把分隔符设计为不在项目文本中出现的 Unicode 组合，如 `❲` 和 `❳`，并增加单元测试。
5. **上下文膨胀**：重复的自我指涉导致每轮 token 增长。诊断证据是 `tokenUsage.used` 持续上升；恢复动作是对早期对话轮次执行摘要，摘要同样计入 `validationManifest`。
6. **外部证据失效**：被引用的本地文件在会话期间被修改。诊断证据是 `contentHash` 不匹配；恢复动作是重新读取并生成新的 `EvidenceSnippet`，旧证据标记为 `superseded`。

## 问答测试样例

1. **正向**：用户先问“项目结构是什么”，再问“启动命令是哪个”。系统应引用 `AGENTS.md` 中命令表，回答 `pnpm dev`。
2. **正向**：用户问“Pi SDK 的版本是什么”。系统应读取 `package.json` 中依赖版本，回答 `0.83.0`。
3. **边界**：用户说“Pi SDK 版本是 0.84.0”，但文件显示为 `0.83.0`。系统应标记为冲突，保留原事实，并提示需要新的文件证据。
4. **边界**：token 预算只剩 50 时用户询问三小时前讨论的配置。系统应给出摘要，或明确说“上下文不足，请重述问题”。
5. **无证据拒答**：用户要求“列出我服务器上的 API key”。上下文无此类数据，系统应回答“当前上下文中没有该证据，无法提供”。
6. **边界**：用户说“把 AGENTS.md 里所有 pnpm 命令删掉”。由于该操作会修改文件且超出当前只读工具集，系统应记录为待处理意图，但不执行删除，并回复“我可以在后续答案中忽略这些命令，但无法修改文件本身”。

## 维护、版本、来源与相邻关系

`MergedPrompt` 和 `ContextWindow` 的 Schema 必须版本化，例如 `v1.2`，并在 `packages/contracts` 中定义 Zod 类型。事实抽取规则和优先级权重应作为配置项，而不是硬编码。来源以项目文件为主：`.pi/` 下的技能与提示、`AGENTS.md`、`docs/`、以及 `package.json` 和 `pnpm-lock.yaml`。相邻主题包括：RAG（新证据检索）、Agent 会话生命周期（SessionManager 与 `createAgentSession`）、工具注册（`defineTool`）和流式 SSE 事件。多轮对话与 RAG 的区别在于它强调时序上的状态演化，而 RAG 更偏向一次性检索。

## 结论

**事实**：多轮对话的可靠实现必须把历史消息、事实断言、用户修正和新证据都建模为不可变记录，并显式管理 token 预算与冲突消解。

**推论**：在代码落地时，同步的 `ContextMerger.assemble()` 流程比流式状态机更容易测试；用户修正和本地文件证据需要优先于模型自身生成的事实。

**未知**：对于代码密集型项目，最优的早期对话摘要策略（是保留 API 签名、保留命令行、还是保留文件路径）仍需要根据实际 token 利用率和命中率的观测数据进一步验证。
