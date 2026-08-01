---
type: concept
title: 上下文预算：验证与运维视角
description: 把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。系统提示、工具说明、检索片段和历史消息如何共同消耗预算
resource: .pi/knowledge/library/agent-design/context-operations.md
tags: [Pi, Agent, Kimi, 知识库, agent-design, context, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: agent-design
topic: context
variant: operations
---

# Agent 上下文预算：系统提示、工具说明、检索片段与历史消息的共同消耗与运维验证

## 摘要与问题边界

上下文预算是单次大模型调用中可承载的 token 总量上限，不是抽象“内存”，而是系统提示、工具说明、检索片段、历史消息与当前输入共同竞争的可消耗资源。本文只讨论单请求内的预算分配与治理，不涉及多 Agent 分布式状态、微调数据集大小或外部 API 超时。运维视角的核心问题是：在大量请求中，能否稳定复现预算占用、识别超限根因、并在不破坏关键语义的前提下完成压缩与恢复。

## 核心概念与数据模型

1. **总预算（Context Window）**：模型单次调用可接受的最大 token 数，例如 128k，由模型能力决定，是硬上限，不可通过提示工程扩展。
2. **固定基座（Fixed Overhead）**：系统提示、安全指令、角色定义等每请求几乎恒定的部分，通常占预算 10%–20%，必须优先分配。
3. **工具说明（Tool Definitions）**：每个工具的名称、描述、JSON Schema 与示例共同占用 token。工具数量增加时，这部分呈线性增长，可能快速挤占历史消息空间。
4. **检索片段（Retrieved Snippets）**：来自向量库或本地 Markdown 知识库的 top-k 文本块，通常带文件名、路径与相关性分数。片段不是越多越好，必须受 token 上限而非仅受 k 值限制。
5. **历史消息（Conversation History）**：多轮对话中 user、assistant、tool 结果与角色标记的累积。每轮不仅包含文本内容，还包含角色 token、格式 token 与分隔符。
6. **当前输入（Current Input）**：用户最新问题与当前状态。若输入本身过长，同样会触发截断或拒绝。
7. **保留余量（Headroom）**：为模型输出预留的 token 空间，尤其是生成工具调用 JSON 时，必须确保输出不会二次触发上下文限制。
8. **切分策略（Slicing Strategies）**：截断、压缩、摘要、滑动窗口、相关性过滤。策略必须可配置、可度量、可回滚。
9. **可复现账本（Reproducible Ledger）**：每次请求前记录各组件实际 token 数、tokenizer 版本、配置版本与哈希，便于事后重放与根因分析。

## 设计决策与取舍

### 系统提示：长且稳定还是短且可更新
长系统提示能减少每轮重复指令，但会永久占用固定预算。边界判断：若系统提示超过总预算 20%，应拆分为“常驻核心指令”与“动态附加指令”，后者按需注入。

### 工具说明：详细 Schema 与精简描述的平衡
工具描述越详细，调用准确率越高，但 token 消耗越大。可验证原则：当工具总数超过 8 个或 Schema 深度超过 3 层时，应引入“摘要模式”——保留完整 Schema，但将描述压缩为不超过 128 tokens 的精炼版本。

### 检索片段：召回率与预算的竞争
片段按相关性排序，但 relevance score 只解决“有没有用”，不解决“装不装得下”。应转换为按 token 预算裁剪：先取 top-k，再按累计 token 截断，避免低相关长片段淹没历史消息。

### 历史保留：全量保留与滑动窗口
保留全部历史最利于多轮一致性，但在长对话中不可持续。建议设置“最大轮数 + 最大 token 数”双重门槛；超出后，对旧轮次做摘要，并保留关键工具调用结果与状态变量。

### 输出余量：不能只看输入
很多预算失败发生在输出阶段。工具调用 JSON、长代码块、反思文本都会消耗输出 token。设计时应预留至少 10%–15% 的总预算作为输出余量，并在生成前校验。

### 序列化格式：JSON、YAML 与纯文本的角色标记
不同格式 token 开销不同。数组与嵌套对象会增加大量结构 token。本地文件知识库若用 Markdown，可保留标题与标签作为可检索元数据，但应在注入时剔除冗余 YAML frontmatter。

## 可执行的实施流程

1. 确定预算所有者：为每个支持的模型声明 `max_context_tokens`，禁止业务代码直接写死。
2. 选择并固定 tokenizer：使用与模型提供商一致的 tokenizer 版本，记录版本号；本地测试用 `tiktoken` 或 SDK 自带计数器。
3. 将输入组件分类为固定、动态、临时三类，分别对应系统提示、工具与检索、历史与输入。
4. 为每类组件分配 token bucket：例如系统 15%、工具 20%、检索 25%、历史 30%、余量 10%。bucket 超过时触发内部截断而非直接请求模型。
5. 在检索层实现 token 级裁剪：先按分数取 top-k，再按累计 token 截断，保留源文件路径与片段哈希。
6. 在历史层实现滑动窗口与摘要：超过 maxTurns 或 maxTokens 时，将最旧轮次压缩为摘要，并保留状态变量。
7. 在调用模型前运行预算校验：计算总 token，若超过总预算则拒绝或回退到更轻量级模型。
8. 记录可复现账本：包含组件 token 数、tokenizer 版本、配置版本、时间戳、请求 ID。
9. 进行负载测试与故障注入：构造长检索片段、超长历史、大 Schema 场景，验证截断与降级行为。
10. 编写运维手册：明确 BudgetExceeded、截断、tokenizer 漂移等场景的恢复步骤。

## 配置与代码示例

以下配置声明了一个本地 Markdown 知识库与 TypeScript 组合的预算模型。输入是系统提示、工具、检索片段与历史；处理是逐 bucket 计算与截断；输出是合规的 prompt 账本。

```yaml
contextBudget:
  model: gpt-4o
  maxTokens: 128000
  tokenizerVersion: "cl100k_base"
  buckets:
    system:
      maxTokens: 15000
      reserved: true
    tools:
      maxTokens: 25000
      truncateStrategy: "description-first"
    retrieval:
      maxTokens: 35000
      topK: 8
      minScore: 0.72
      sourceTypes: ["markdown", "yaml"]
    history:
      maxTokens: 38000
      maxTurns: 20
      summaryAfter: 10
    headroom:
      maxTokens: 15000
      forOutput: true
```

```typescript
type BucketKey = 'system' | 'tools' | 'retrieval' | 'history' | 'headroom';

interface Ledger {
  requestId: string;
  used: number;
  maxTokens: number;
  components: Record<BucketKey, string>;
  tokenizerVersion: string;
  truncated: boolean;
}

function buildPromptLedger(
  budget: typeof contextBudget,
  components: Record<BucketKey, string>,
  requestId: string
): Ledger {
  let used = 0;
  let truncated = false;
  for (const key of ['system', 'tools', 'retrieval', 'history'] as BucketKey[]) {
    const limit = budget.buckets[key].maxTokens;
    let actual = estimateTokens(components[key], budget.tokenizerVersion);
    if (actual > limit) {
      components[key] = truncateToTokens(components[key], limit, budget.tokenizerVersion);
      actual = limit;
      truncated = true;
    }
    used += actual;
  }
  const headroom = budget.buckets.headroom.maxTokens;
  if (used + headroom > budget.maxTokens) {
    throw new Error(`BudgetExceeded: used=${used}, headroom=${headroom}`);
  }
  return { requestId, used, maxTokens: budget.maxTokens, components, tokenizerVersion: budget.tokenizerVersion, truncated };
}
```

输入是未裁剪的原始组件与预算配置；处理是逐 bucket 计算、截断、校验余量；输出是包含实际 token 占用与截断标记的账本，可用于日志、监控与重放。

## 性能、质量与可观测性指标

1. **预算利用率**：`used_tokens / max_tokens`，按模型与路由分桶。目标区间 70%–85%，低于 50% 说明检索或历史未充分利用，高于 90% 则风险过高。
2. **组件占比**：系统、工具、检索、历史、余量各自占比。通过 ledger 聚合，用于识别哪类组件膨胀。
3. **截断率**：触发截断的请求比例。超过 5% 应触发告警，超过 15% 应视为稳定性风险。
4. **端到端延迟**：按预算利用率分桶的 P95/P99 延迟。高利用率通常伴随更高延迟，可用于容量规划。
5. **任务成功率**：在截断前后对比同一任务的成功率，判断截断策略是否丢失关键语义。
6. **工具调用准确率**：预算压缩后，模型是否正确调用指定工具、参数是否完整。可结合测试集自动化评估。
7. **输出截断率**：模型响应本身被截断的比例，直接反映 headroom 不足。

## 失败模式、诊断证据与恢复动作

1. **预算超限（BudgetExceeded）**
   - 诊断证据：请求前 ledger 显示 `used + headroom > max_tokens`，或模型返回上下文长度错误。
   - 恢复：优先压缩检索片段，其次截断历史，最后考虑缩短系统提示；若仍超限，则降级到更大上下文模型或拒绝请求。

2. **Tokenizer 估算漂移**
   - 诊断证据：本地 ledger 为 110k tokens，但模型返回“超过 112k tokens”；不同版本 tokenizer 计数不一致。
   - 恢复：对齐 tokenizer 版本，添加 2%–5% 安全余量；在回归测试中对比本地与模型实际计数。

3. **截断丢失关键指令**
   - 诊断证据：任务成功率在截断后骤降，或模型忽略“必须返回 JSON”等约束。
   - 恢复：引入优先级标记，对系统指令、用户约束、工具调用结果设置不可截断保护区；改用摘要而非尾部截断。

4. **检索片段淹没历史**
   - 诊断证据：检索组件占比超过 40%，历史占比低于 10%，多轮对话一致性下降。
   - 恢复：将 topK 限制从“按数量”改为“按 token”，并提高 minScore 阈值；对长 Markdown 文件做段落级拆分。

5. **历史消息指数膨胀**
   - 诊断证据：历史 token 随轮次线性增长，最终占总预算 60% 以上。
   - 恢复：启用轮数上限与摘要；保留工具结果与状态变量，删除重复寒暄与中间推理。

6. **序列化格式开销被忽略**
   - 诊断证据：工具 JSON 或 YAML 元数据占总 token 15% 以上，但内容本身很短。
   - 恢复：使用紧凑格式，移除冗余缩进、注释与数组括号；在注入前对本地文件片段做规范化清洗。

## 问答测试样例

1. **正向问题**：系统提示 1200 tokens、工具说明 2500 tokens、检索片段 4000 tokens、历史消息 5500 tokens、当前输入 300 tokens，模型上限 16000 tokens。估算总占用？
   - 答案：13500 tokens，剩余 2500 tokens 作为输出余量。

2. **正向问题**：当检索片段 top-8 的累计 token 超过 retrieval bucket 上限时，应保留哪部分？
   - 答案：按相关性排序，从低分长片段开始截断，直到满足 token 上限，并记录被截断片段的 ID。

3. **边界问题**：检索片段最低得分 0.71，配置 minScore 为 0.72，是否进入预算？
   - 答案：不进入，即使其 token 很短，也必须先被过滤，否则破坏可配置阈值。

4. **边界问题**：历史消息已达 20 轮，最近一轮是工具执行结果，下一请求budget 不足，能否直接删除该轮？
   - 答案：不能直接删除，因为后续模型可能需要根据工具结果继续推理；应优先摘要旧用户轮，或保留工具结果并压缩其说明。

5. **无证据拒答**：用户反馈模型突然不调用工具，但没有任何 ledger 或请求日志，如何判断是预算问题？
   - 答案：无法仅凭现象判断；必须提供包含组件 token 占用的 ledger 或请求 ID 后才能分析。

6. **无证据拒答**：增加检索片段是否总能提高回答质量？
   - 答案：不能断言；需要检索相关性分数、任务成功率与预算占比的数据支撑，否则属于未验证假设。

## 维护、版本、来源与相邻主题

预算配置应纳入版本控制，与模型版本、tokenizer 版本、SDK 版本一一对应。每次升级 `@earendil-works/pi-coding-agent` 或更换模型时，必须运行回归测试，比较同一份输入在新旧 tokenizer 下的 token 差异。来源包括模型提供商文档、项目 ledger 日志、本地 `.pi/knowledge` Markdown 文件与测试集报告。

相邻主题包括：RAG 检索策略决定片段来源；提示工程决定系统提示质量；缓存策略减少重复历史注入；可观测性负责收集 ledger 与告警。上下文预算位于这几者的交叉点，是连接输入治理与稳定性保障的枢纽。

## 结论

**事实**：模型上下文窗口是硬上限；系统提示、工具说明、检索片段、历史消息与当前输入都按 token 计量；截断、摘要与 bucket 分配是现有工程实践中常用的控制手段。

**推论**：为每个组件设置 token 级上限、保留 10%–15% 输出余量、记录可复现账本，可以显著降低预算超限与输出截断风险；按 token 而非按数量裁剪检索片段，比单纯降低 topK 更能稳定多轮对话质量。

**未知**：不同模型对特殊 token 的计数规则存在差异，无法保证本地估算与模型实际完全一致；在高度压缩后，模型输出质量下降的具体阈值与任务类型强相关，目前尚无通用公式；最佳 bucket 比例是否随任务动态变化，仍需通过项目级 A/B 测试与长期监控验证。
