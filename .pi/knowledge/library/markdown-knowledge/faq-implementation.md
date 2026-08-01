---
type: concept
title: FAQ 组织：实现视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。把真实问题、边界答案和拒答条件组织成可复用问答单元
resource: .pi/knowledge/library/markdown-knowledge/faq-implementation.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, faq, implementation]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: faq
variant: implementation
---

# FAQ 组织：把真实问题、边界答案与拒答条件实现为可复用问答单元

## 摘要与问题边界

FAQ 组织不是把常见问答堆成文档，而是把真实用户输入、可验证边界条件、拒答规则与答案本体封装成可在检索或 Agent 流程中复用的单元。核心边界在于：FAQ 单元只回答有证据支持的问题；对超出当前来源、版本或运行时条件的问题，必须给出明确拒答，而不是返回模糊猜测。它与通用对话、长文档检索和教程型内容相邻，但区别在于以问题为检索入口，以答案加边界为输出，以拒答为失败保护。

## 核心概念与数据模型

FAQ 单元的最小数据模型应包含以下字段，所有字段在 TypeScript 类型中应非空且可校验：

1. rawQueries：原始问句集合，记录真实用户或日志中实际出现的表达，用于训练语义索引和召回测试。
2. canonicalQuestion：规范化问题，作为检索主键与标题，必须唯一且语义稳定。
3. answerBody：答案本体，包含步骤、命令、配置示例与结论，但不得包含未经验证的假设。
4. boundaryConditions：边界条件列表，明确答案成立的前提，如运行时、版本、依赖、操作系统、配置开关。
5. refusalTriggers：拒答触发器，定义在缺少必要上下文或证据时返回的拒绝条件与提示。
6. evidenceSource：证据来源，指向本地文件、提交哈希、测试用例或官方文档路径，保证可验证。
7. version：版本标识，与项目依赖或文档版本对齐，避免陈旧答案被误用。
8. lifecycleState：生命周期状态，包括 draft、active、deprecated、retired，控制是否参与检索。

## 设计决策与取舍

### 规范化问题：精确匹配还是语义匹配
精确匹配实现简单，但无法覆盖同义问句；语义匹配依赖嵌入模型，召回泛但可能引入无关结果。推荐做法：先以 canonicalQuestion 精确命中，再以 rawQueries 的语义向量作为兜底，两者通过阈值分治。

### 边界答案：单元内描述还是拆分到独立文档
把边界条件写在单元内便于一次性返回，但会导致单元膨胀；拆分到独立文档可保持单元简洁，却增加二次检索成本。实践中，边界条件与答案本体放在同一单元，复杂细节通过 evidenceSource 链接到长文档。

### 拒答条件：硬编码还是可配置规则
硬编码拒答响应稳定，但难以随项目扩展；可配置规则灵活，却可能因规则冲突导致不可预期行为。建议把通用拒答模板作为配置，而特定领域拒答保留在单元内。

### 版本控制：独立文件还是数据库记录
独立文件适合本地知识库与 Git 版本追踪，便于评审；数据库记录适合高频更新与权限控制。本主题偏向本地文件优先，文件名为 faq-id 加版本戳，辅以索引清单。

### 检索策略：标题召回还是全文向量
标题召回精确但依赖规范问题质量；全文向量覆盖广但噪声大。推荐双路召回：标题精确匹配加权最高，rawQueries 向量匹配作为补充，最后由边界条件过滤做重排。

## 可执行实施流程

1. 收集真实问题：从 Issue、聊天日志、搜索热词中提取高频问句，避免编造。
2. 编写规范化问题：用主谓宾完整句子，去掉口语填充词，确保唯一性。
3. 定义边界条件：逐条列出运行环境、版本、配置、依赖、权限要求。
4. 撰写答案本体：每一步附带可验证命令或配置片段，结论与证据来源绑定。
5. 编写拒答触发器：列出必须知道的上下文字段，给出缺失时的默认回复。
6. 定义 TypeScript 类型与校验：使用 Zod 或自定义守卫，在加载时校验必填字段与类型。
7. 实现本地文件加载：扫描 .pi/knowledge/faq 目录下的 JSON，建立 id 到内容的 Map，并捕获解析错误。
8. 构建检索与排序：先精确匹配 canonicalQuestion，再向量匹配 rawQueries，最后按边界相关度打分。
9. 添加运行时日志：记录查询、命中单元、得分、边界过滤结果、拒答原因。
10. 执行问答测试：覆盖正向、边界、无证据、版本过期、标签错误场景。
11. 发布与版本：将 FAQ 文件与代码一同提交，版本号写入文件，并在 CHANGELOG 中记录新增与废弃。

## 输入、处理与输出示例

以下 JSON 表示一个面向 TypeScript Node 本地知识库的 FAQ 单元，存放在 .pi/knowledge/faq/ts-node-import-001.json：

    {
      "faqId": "ts-node-import-001",
      "canonicalQuestion": "在 TypeScript Node 项目中如何正确导入本地 JSON 文件？",
      "rawQueries": [
        "typescript import json file",
        "ts-node require json",
        "import json module typescript node"
      ],
      "answerBody": "在 tsconfig.json 中设置 resolveJsonModule: true 与 esModuleInterop: true，然后使用 import pkg from './package.json'。",
      "boundaryConditions": [
        "适用于 Node.js 运行时与 ts-node 环境",
        "需要 TypeScript 4.5 或更高版本",
        "不适用于纯浏览器打包器"
      ],
      "refusalTriggers": [
        "若用户未提供 tsconfig.json 或 Node.js 版本，则回答：请补充运行环境，否则无法判断具体配置路径。",
        "若用户询问浏览器场景，请返回：本答案仅覆盖 Node.js，浏览器打包器请查询对应 FAQ。"
      ],
      "evidenceSource": "docs/typescript-node-import.md",
      "version": "1.2.0",
      "tags": ["typescript", "node", "json", "import"],
      "lifecycleState": "active"
    }

输入是用户原始查询与当前上下文对象，如 runtime、version、topic。处理流程先校验 JSON 模式，再检查 lifecycleState 为 active，随后用精确匹配或向量匹配召回候选，应用边界条件过滤，若命中则返回 answerBody，否则触发 refusalTriggers 并记录原因。输出是包含答案、命中单元 id、证据来源、版本与拒答标志的结构化对象。

## 性能、质量、可观测性指标

1. 检索延迟：从收到查询到返回候选的 P99 时间，目标小于 100 毫秒；用单元测试或性能基准测量。
2. 召回率：在测试集中，正确 FAQ 单元出现在前 5 候选中的比例；通过人工标注的问答对计算。
3. 精确率：前 5 候选中确实相关的比例；用标签与边界条件人工审核。
4. 拒答率：因缺少证据或边界不满足而触发拒答的查询占比；从日志中聚合 refusalTriggers 命中次数。
5. 答案过时率：版本低于当前项目依赖的 active 单元数量；定期扫描并与 package.json 或 lockfile 版本比较。
6. 用户修正率：用户后续追问“这不是我要问的”或“版本不对”的比例；通过对话日志统计。

## 失败模式、诊断证据与恢复动作

1. 过度泛化导致错误答案：语义匹配把无关查询召回为 Top1。诊断证据是用户后续否定或边界条件命中次数低。恢复动作是补充 rawQueries 负例、提高阈值或把该单元标记为 needs-review。
2. 边界条件缺失导致过期答案：项目依赖升级后，旧答案仍被返回。诊断证据是 version 字段低于当前依赖。恢复动作是更新 version、answerBody、boundaryConditions，并将旧单元标记为 deprecated。
3. 拒答模板过于激进：大量合法查询被错误拒答。诊断证据是拒答率突增且用户继续追问同一主题。恢复动作是审查 refusalTriggers，补充必要上下文字段的默认值。
4. 版本漂移导致证据不一致：evidenceSource 指向的文档已更新，但 FAQ 内容未同步。诊断证据是来源文件哈希与 FAQ 记录不一致。恢复动作是在加载时校验来源文件哈希，触发告警或自动更新。
5. 检索排序错误：无关 FAQ 因标题关键词重合被置顶。诊断证据是精确匹配得分高但 rawQueries 向量得分低。恢复动作是调整排序权重，或拆分 canonicalQuestion。
6. 元数据标签混乱：同一主题存在多个冲突标签，导致聚合失败。诊断证据是标签集合存在重复或拼写不一致。恢复动作是引入受控词表并在提交时做 lint 检查。

## 问答测试样例

1. 正向问题：typescript 里怎么 import json？ 预期命中 ts-node-import-001，返回 resolveJsonModule 与 esModuleInterop 配置。
2. 边界问题：我在 Vite 项目里用 TypeScript 想 import JSON。 预期触发 refusalTriggers，返回浏览器打包器不在本答案范围内。
3. 无证据问题：怎么在 Deno 里导入 JSON？ 预期无命中单元，返回请补充运行环境或查询 Deno 相关 FAQ。
4. 版本边界问题：TypeScript 3.9 项目导入 JSON 失败。 预期检测到用户版本低于 boundaryConditions，返回版本不满足提示。
5. 同义问题：ts-node require json 报错。 预期通过 rawQueries 语义召回，命中同一单元。
6. 过期单元问题：查询命中 lifecycleState 为 deprecated 的单元。 预期过滤掉该单元，返回拒答或提示该答案已废弃，请查看新版本。

## 维护、版本、来源与相邻主题

维护工作包括每月扫描 active 单元的 evidenceSource 是否仍然有效，每季度根据新增问题补充 rawQueries，每次依赖升级时同步 version 与 boundaryConditions。版本策略采用 FAQ 文件内 version 与项目版本解耦，但废弃单元保留至少一个主版本周期，避免检索断裂。来源必须指向仓库内文件或带哈希的 URL，禁止引用未经审核的外部链接。相邻主题包括 Markdown 文档结构、检索增强生成、对话状态管理、技能注册与提示模板。FAQ 组织是检索增强生成的前置单元，也是提示模板中 few-shot 示例的稳定来源。

## 结论

事实：FAQ 单元需要包含 canonicalQuestion、answerBody、boundaryConditions、refusalTriggers、evidenceSource、version 与 lifecycleState 才能被可靠检索与验证。推论：通过 TypeScript 类型校验、本地文件索引与双路召回排序，可以把 FAQ 组织成一个可观测、可回滚的知识组件。未知：不同嵌入模型对 rawQueries 的召回效果、用户拒答后继续追问的行为分布、以及长文档与 FAQ 单元最优粒度，仍需在具体项目中通过 A/B 测试与日志分析确定。
