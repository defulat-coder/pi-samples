---
type: concept
title: 多语言内容：架构视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。保持术语映射、数字和条件一致，而不是逐句机械翻译
resource: .pi/knowledge/library/markdown-knowledge/translation-architecture.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, translation, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: translation
variant: architecture
---

# Markdown 知识库中的多语言内容：以语义等价为中心的架构设计

## 摘要与问题边界

多语言 Markdown 知识库的目标不是把每一句原文机械地转换成另一种语言，而是在不同 locale 下保持同一概念的可复现理解。真正的问题边界集中在三个层面：术语映射必须一一对应，数值与条件语义必须保持等价，而风格、语序、例句允许本地化调整。凡是会改变结论、接口行为、阈值或决策路径的内容，都属于必须严格一致的范围；凡是仅影响阅读流畅度的修辞，则属于可变性范围。本架构将 Markdown 视为可渲染视图，把可复用知识抽取为带稳定标识的结构化对象，locale 文件只是这些对象的多语言投影。

## 核心概念与数据模型

1. **Canonical Knowledge Unit（CKU）**：每个知识条目拥有一个全局稳定标识符，如 `concept/session-lifecycle@v3`，以及一个版本号。它是所有 locale 投影的唯一事实来源。

2. **Locale Projection**：一个 CKU 在不同语言下的视图，例如 `zh-CN`、`en-US`。Projection 不是独立文档，而是引用同一 CKU 的本地化表达，必须声明依赖版本。

3. **Term Equivalence Table**：维护跨语言术语映射，例如“session”对应“会话”，而不是“session”在某些段落被译为“连接”。术语表以键值加示例上下文的方式保存，避免同词多义。

4. **Numeric Invariant**：数值与条件必须存储在结构化字段中，例如 `maxRetryCount: 3`、`timeoutMs: 5000`。渲染时才根据 locale 格式化数字，确保比较与计算不受文化格式影响。

5. **Conditional Rule Node**：如果知识包含“若 A 则 B”这类规则，规则本体使用逻辑表达式或伪代码节点存储，只有自然语言标签参与翻译，避免条件语义在翻译中丢失或变形。

6. **Invariant Boundary List**：明确列出哪些字段不可翻译，包括标识符、键名、代码片段、正则表达式、文件路径、版本字符串。这些字段在所有 locale 中保持原样。

7. **Change Vector**：CKU 每次变更都会产生变更向量，指明哪些字段被修改。Locale Projection 通过变更向量判断是否需要重新校验，而不是全文比对。

## 设计决策与取舍

### 1. 主语言与语言无关语义层
选择一种主语言作为人类撰写入口，但强制把数值、条件、术语抽象为语义层。这样既能降低写作成本，又能在未来把主语言切换为另一种语言而不破坏既有 locale 投影。代价是写作时必须同时填写结构化字段，增加了初始复杂度。

### 2. 单文件多语言还是按 locale 切分
按 locale 切分文件更利于版本控制、差异比较和并行审校，但需要在 CI 中验证所有文件引用同一 CKU 版本。单文件虽然读取方便，但合并冲突频繁，不适合多人协作的代码仓库。因此采用“结构化元数据单文件 + 各 locale Markdown 分文件”的混合模式。

### 3. 自动翻译与人工校验的边界
自动翻译只能用于自然语言描述和示例段落；术语映射、数值、条件、代码说明必须由人工确认。任何自动翻译结果必须通过“术语一致性检查”后才能合并，否则会出现同一术语在不同 projection 中不同译法。

### 4. 数字与条件作为结构化数据而非纯文本
将数字和条件从 Markdown 正文中抽取到 YAML 或 JSON 字段，而不是在段落中直接写“三秒钟”。这样渲染器可以根据 locale 输出“3 seconds”或“3 秒”，而知识库检索器仍用原始数值做比较。代价是牺牲了部分“自由写作”体验。

### 5. 代码示例与不可翻译块的定位
代码片段、命令行示例、配置文件内容属于不变量，不参与翻译流程。如果需要在不同语言环境下解释同一段代码，应把代码放在共享块中，仅对说明文字做本地化。避免维护多份代码副本，减少 drift 风险。

## 可执行的实施流程

1. 定义 CKU 模式：为每类知识条目设计稳定标识符、版本字段、invariant list 和 locale projection 引用格式。

2. 建立术语表：在项目级知识库中创建 `terms.yaml`，记录每个术语在不同 locale 下的等价映射及反例。

3. 抽取数值与条件：将 Markdown 中所有阈值、计数、超时、条件语句迁移到结构化字段，使用 locale 无关的原始单位。

4. 撰写主语言 CKU：用主语言写出完整语义，包括标题、正文、示例、规则节点引用和数值字段。

5. 生成 locale projection：基于术语表和结构化字段，翻译自然语言段落，并显式声明 projection 版本与 CKU 版本一致。

6. 运行一致性校验：检查所有 locale 是否包含同一组数值、条件、术语键；检测缺失或多余的字段。

7. 执行渲染测试：将每个 locale projection 渲染为最终 Markdown，确认数字格式、术语链接、条件标签正确显示。

8. 合并与版本标记：在合并请求中要求 CKU 版本号变更，并记录变更向量；未通过校验的 projection 禁止合并。

9. 发布到本地文件索引：把渲染后的 Markdown 输出到 `knowledge/{locale}/` 目录，并生成用于检索的反向索引。

10. 设置漂移监控：定期扫描已发布文件与当前 CKU 的差异，超过阈值时通知维护者更新 projection。

## 本地文件知识库的示例与输入处理输出

以下是一个概念条目的 YAML 形态示例，表示“会话超时”知识：

    concept_id: concept/session-timeout@v3
    numeric_invariants:
      idle_timeout_ms: 300000
      max_retries: 3
    term_keys:
      - session
      - idle_timeout
      - retry
    conditional_rule:
      predicate: "retry_count >= max_retries"
      action: "close_session"
      label_i18n_key: action_close_session
    locale_projections:
      zh-CN:
        title: "会话空闲超时"
        summary: "当会话在 300 秒内没有任何交互，系统将关闭会话。"
      en-US:
        title: "Session Idle Timeout"
        summary: "The system closes the session when it has been idle for 300 seconds."

输入是上述结构化文件；处理时渲染器读取 `numeric_invariants` 中的原始数值，并根据 locale 格式化为“300 秒”或“300 seconds”，同时用 `term_keys` 校验术语表映射是否存在；输出是最终面向读者的 Markdown 文件，其中数字和条件语义与 CKU 保持一致，而语言风格符合各 locale 习惯。

## 性能、质量与可观测性指标

1. **术语一致性覆盖率**：检查 projection 中术语键命中 `terms.yaml` 的比例。目标高于 98%，通过静态分析脚本测量。

2. **数值漂移率**：每个 locale 渲染结果中数字与 CKU 原始数值不一致的条目占比。测量方式是对渲染输出进行正则抽取并反向比对。

3. **条件语义等价率**：人工或规则判断每个 locale 是否保留同一组条件节点，缺失或重排即记为失败。

4. **渲染延迟**：从 CKU 到生成单个 locale Markdown 的耗时，目标低于 50 毫秒/千字符，通过 CI 基准测试记录。

5. **投影陈旧度**：CKU 版本升级后，未同步更新的 locale projection 的平均滞留时间。可用 drift 监控任务报告。

## 失败模式、诊断证据与恢复动作

1. **术语漂移**：证据是同一英文术语在不同中文段落中出现多种译法。恢复动作：统一回术语表，重新翻译受影响段落，并提升校验覆盖率。

2. **数值格式错误**：证据是 locale 渲染输出中出现“3,000”被当作“3000”或反之，导致比较失败。恢复动作：将数字从正文移回结构化字段，删除自由文本中的硬编码数字。

3. **条件丢失**：证据是某 locale 投影中缺少 `conditional_rule` 引用或标签与 predicate 不对应。恢复动作：补回结构化规则节点，并增加 schema 校验。

4. **孤立 projection**：证据是 locale 文件引用的 CKU 版本在仓库中不存在。恢复动作：要么升级 projection 到最新版本，要么标记为废弃并从索引中移除。

5. **渲染编码错误**：证据是 Markdown 输出中中文引号或数字分隔符被错误转义。恢复动作：修复 locale 渲染器，增加输出字符级快照测试。

## 问答测试样例

1. **正向**：`concept/session-timeout` 的空闲超时毫秒数是多少？答案：300000，因为该数值在 `numeric_invariants.idle_timeout_ms` 中定义。

2. **正向**：中文 projection 中“session”应翻译为什么？答案：应译为“会话”，依据 `terms.yaml` 中的术语映射。

3. **边界**：如果某 locale 未提供 `max_retries` 的本地化说明，是否影响语义？答案：不影响，因为数值在结构化字段中统一维护，缺失的仅是自然语言解释。

4. **边界**：能否把 `300000` 毫秒在中文里写成“5 分钟”？答案：可以，只要渲染后语义等价且经过校验，但结构化字段仍保持毫秒值。

5. **无证据拒答**：英文 projection 中“retry”被翻译为“retry”是否错误？无证据，因为未定义该 locale 的术语映射，应回答无法判断。

6. **无证据拒答**：该知识条目的作者是谁？如果来源字段未记录，应回答无记录，不能推断。

## 维护、版本、来源与相邻主题的关系

版本管理采用 CKU 语义版本，并约定 minor 版本变更仅允许自然语言或示例调整，major 版本变更才允许修改数值、条件或术语键。来源信息必须在 CKU 中记录原始文档路径、最后审校日期和审校者标识。与相邻主题的关系如下：本主题依赖于“Markdown 结构化写作”所定义的标题与块级规范；它为“Agent 检索增强”提供可本地化的事实单元；同时与“自定义工具设计”相邻，因为条件节点可能直接被工具参数引用。但不要将这三个主题混为一谈，本主题只负责内容的多语言等价，不负责检索算法或工具执行逻辑。

## 结论：事实、推论与未知

**事实**：Markdown 知识库的多语言问题核心在于语义等价，而非逐句翻译；将数值、条件和术语抽象为结构化字段可以在不同 locale 之间保持一致。

**推论**：以 CKU 为单一事实来源、locale projection 为视图的架构，能够降低长期维护中的 drift 风险；切分文件、术语表校验和渲染器格式化是实现该架构的最小必要组合。

**未知**：不同自然语言在表达条件、否定、时态时的差异是否会导致某些规则无法保持完全等价，仍需在具体项目术语表中通过案例库持续验证；此外，自动化渲染器对复杂数字范围和文化特定表达的处理准确率上限尚未被充分测试。
