---
type: concept
title: 文章编写：实现视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。先定义读者、问题边界和事实来源，再组织可检索正文
resource: .pi/knowledge/library/markdown-knowledge/authoring-implementation.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, authoring, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: authoring
variant: implementation
---

# Markdown 知识写作中的文章编写：面向 TypeScript 实现的可检索文档工程方法

## 摘要与问题边界

本文描述在 TypeScript/Web 本地文件知识库中，如何把方案写成可被检索器和 Agent 引用的 Markdown 文章。它聚焦“文章”这一知识单元，而不是 Markdown 语法教程、通用技术写作或运行时 LLM 提示工程。输入范围限定为：源码文件、测试用例、架构决策记录（ADR）、CI 输出、运行日志；输出范围是一篇遵循 `.pi/knowledge` 或 `docs/` 目录约定的单文件 Markdown。不在本范围内：营销文案生成、版本控制系统实现、多模态内容管理。目标读者是把方案落成 TypeScript 代码的开发者，因此必须优先定义输入、输出、错误、生命周期和验证步骤，再进入编码。

## 核心概念与数据模型

1. 知识单元（Knowledge Entry）：以单文件 Markdown 存在，H1 标题作为唯一语义入口。slug 由 H1 按 ASCII 小写、短横线、去停用词生成，例如 `markdown-article-authoring`。文件首不输出 YAML frontmatter，元数据通过标题、标签段和正文内的明确语句表达。
2. 输入源清单（Input Manifest）：每篇文章开头列出引用的具体路径，包括仓库相对路径、Git commit hash 或分支名、行号区间、测试名称。来源必须可被 `git show` 或本地文件系统验证。
3. 问题边界（Problem Boundary）：用显式的 in-scope / out-of-scope 列表划定范围，并定义终止条件，说明何时停止扩展主题。
4. 事实来源（Fact Source）：每条设计主张至少关联一个来源；来源类型包括 `source-code`、`test-case`、`adr`、`log`、`observation`。如果无法关联，则标注为“推论”或“未知”。
5. 可检索正文（Retrievable Body）：正文使用 H1-H3 层级，关键术语首次出现时加粗，并在 H2 或段落中提供同义词；内部链接使用相对路径，例如 `[ADR-0001](docs/adr/0001-monorepo-and-pi-boundary.md)`。
6. 验证记录（Validation Log）：文末或独立段落包含测试问题、预期答案、边界条件和拒答条件，用于每次代码变更后复核。
7. 错误与生命周期状态（Error & Lifecycle Model）：文章状态为 `draft`、`verified`、`stale`、`archived`。错误码：`E001` 来源缺失，`E002` 标题漂移，`E003` 边界越界，`E004` 链接失效，`E005` 验证用例失败。

## 设计决策与取舍

### H1 唯一性与 slug 生成
采用 H1 作为唯一入口，slug 从 H1 派生，避免多个文件名映射到同一主题。例外：当主题发生语义偏移时，宁可重命名文件并添加重定向说明，也不保留旧 slug。

### 元数据放在正文而非 YAML frontmatter
frontmatter 对构建工具友好，但纯文本检索器可能忽略它。因此关键元数据写入 H2 段落，让向量检索和关键词检索都能捕获。代价：失去部分静态站点生成器的自动分类能力。

### 单主题边界，宁可拆分
一篇 Markdown 只回答一个由 ADR 或代码变更引发的问题。允许跨文件重复，因为检索器可以通过去重提示处理。例外：若两个主题共享同一失败模式且必须对比，可在同篇文章中设置两个 H2，但开头必须明确标注双重主题。

### 证据优先的写作顺序
强制在编写实现细节前完成输入、输出、错误、生命周期和验证步骤的描述。这增加了写作成本，但降低了后续返工。如果事实不足，必须标记为未知，而不是用“通常如此”掩盖。

### 来源引用使用 commit hash 而非分支名
commit hash 提供不可变来源，防止分支前进导致证据失效。边界：在 `draft` 阶段允许分支名，但发布前必须替换为完整 hash，否则状态不能从 `draft` 转为 `verified`。

## 可执行的实施流程

1. 定义读者与调用场景：明确检索查询会出现在哪些 Agent 步骤中，例如“如何验证 Pi 会话生命周期？”。
2. 锁定问题边界：写 in-scope / out-of-scope 列表，并定义终止条件。
3. 收集事实来源：列出所有文件路径、commit、测试名、行号，形成 Input Manifest。
4. 定义输入/输出/错误契约：用 TypeScript 接口或 JSON 描述文章结构。
5. 定义生命周期：创建、验证、发布、废弃、归档。
6. 构建可检索结构：写 H1、H2、术语表、同义词、内部链接。
7. 编写实现细节：编码步骤、配置示例。
8. 编写验证用例：Q&A、边界问题、拒答条件。
9. 运行工具链检查：slug 唯一性、链接完整性、字符数、证据覆盖率、未知比例。
10. 发布与索引：移动到目标目录，运行检索器测试，记录状态。

## 示例：输入清单与文章记录结构

    {
      "article": {
        "slug": "markdown-article-authoring",
        "h1": "Markdown 知识写作中的文章编写",
        "state": "verified",
        "inputManifest": [
          {
            "source": "AGENTS.md",
            "commit": "a1b2c3d",
            "lines": [1, 45]
          },
          {
            "source": "docs/adr/0001-monorepo-and-pi-boundary.md",
            "commit": "a1b2c3d"
          },
          {
            "source": "packages/pi-agent/src/session.ts",
            "commit": "a1b2c3d",
            "test": "session-lifecycle.test.ts"
          }
        ],
        "inScope": ["Markdown 文章结构", "来源引用", "验证用例"],
        "outOfScope": ["LLM 提示工程", "版本控制系统实现"],
        "validationLog": [
          {
            "question": "该方法的第一个步骤是什么？",
            "expected": "定义读者与调用场景"
          }
        ]
      }
    }

输入：三个不同来源的具体路径与 commit。处理：工具链验证 slug 唯一性、链接可解析、证据覆盖率。输出：一篇 `verified` 状态的 Markdown 文件，可被检索器召回。

## 性能、质量与可观测性指标

1. 检索召回率：使用 10-20 个真实查询，检查目标文章是否出现在 top-3，目标 ≥ 90%。
2. 检索精确率：统计返回文章中与查询无关的比例，目标 ≤ 10%。
3. 证据覆盖率：断言数量 / 来源引用数量，目标每条断言至少 1 个来源。
4. 未知标注比例：明确标为“未知”的语句占比，目标 < 5%，但绝不强行降为 0。
5. 验证用例通过率：Q&A 样例全部通过，运行命令 `pnpm test:kb`。
6. 链接完整性：内部相对链接 404 数量，目标为 0。
7. 生成耗时：从输入收集到发布合并的 wall time，目标 < 2 小时。

## 失败模式

1. 标题漂移：H1 与正文关键词不一致。诊断证据：用核心术语查询时 top-k 未命中。恢复动作：在 H2 和同义词段加入检索词。
2. 事实悬空：存在无来源的设计主张。诊断证据：证据覆盖率低于阈值。恢复动作：补充来源或改为“推论/未知”。
3. 边界越界：出现超出 in-scope 列表的内容。诊断证据：字数显著超限且无法归入任何 H2。恢复动作：拆分为新文章并添加链接。
4. 验证用例失效：代码变更后 Q&A 答案改变。诊断证据：CI 中 `pnpm test:kb` 失败。恢复动作：更新文章、来源 commit 和验证答案。
5. 生命周期失控：archived 文章仍被检索返回。诊断证据：状态字段未更新或检索器未过滤。恢复动作：移动文件到 `archive/` 或添加 `archived: true` 标记。
6. 同义词鸿沟：检索器使用与正文不同的术语。诊断证据：同义词查询召回率低。恢复动作：添加标签段和“又称”说明。

## 问答测试样例

1. 正向问题：该方法的第一个步骤是什么？预期答案：定义读者与调用场景。来源：实施流程第 1 步。
2. 边界问题：一篇文章能否覆盖多个 ADR 主题？预期答案：仅当它们共享同一决策边界且需要对比；否则拆分。来源：设计决策“单主题边界”。
3. 无证据问题：此方法对 Python 项目是否适用？拒答条件：本文档未验证 Python 实现路径，不能给出确定结论。
4. 正向问题：证据覆盖率目标是什么？预期答案：每条断言至少一个来源。来源：指标第 3 项。
5. 边界问题：draft 阶段能否使用分支名作为来源？预期答案：可以，但发布前必须替换为 commit hash。来源：设计决策“来源引用使用 commit hash”。
6. 无证据问题：推荐的文章字数上限是多少？拒答条件：未给出硬性上限，仅提供 2200-2800 中文字符的参考区间。

## 维护、版本、来源与相邻主题关系

版本：每篇文章在文末记录最后验证日期和来源 commit。当依赖文件变更时，状态从 `verified` 退回到 `stale`。来源主要来自 `AGENTS.md`、`docs/adr/0001-monorepo-and-pi-boundary.md`、`packages/pi-agent/src`、`apps/api/src` 和 `.pi/knowledge`。相邻主题：Markdown 格式规范、Skills 管理、提示模板、架构决策记录、检索器实现。本文章是这些主题的下游消费者，又是提示模板和编码任务的上游输入。

## 结论

事实：文章必须包含 H1、输入源清单、问题边界、可检索正文、验证记录；元数据写入正文而非 frontmatter；来源优先使用 commit hash。推论：将验证用例纳入 CI 可以显著降低文章与代码 drift 的风险。未知：不同检索器对 heading 层级和术语加权的具体影响，以及长中文文章在向量切分中的最佳 chunk 策略，仍需要项目级实测数据。
