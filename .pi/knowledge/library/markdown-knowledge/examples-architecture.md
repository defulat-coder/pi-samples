---
type: concept
title: 代码示例：架构视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。让配置、请求和响应示例可运行、可解释并标明版本
resource: .pi/knowledge/library/markdown-knowledge/examples-architecture.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, examples, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: examples
variant: architecture
---

# 代码示例：让 Markdown 知识库中的配置、请求与响应可运行、可解释、可版本化

## 摘要与问题边界

在 Markdown 知识库中，代码示例不是点缀，而是承担“可验证接口”的角色。本文讨论的边界是：如何把配置片段、HTTP 请求、JSON 响应、命令行调用等示例，从静态文本提升为可运行、可解释、可版本化的知识单元。核心问题不包括通用编程教学代码的写法，也不涉及运行时沙箱或 IDE 插件的实现，而是聚焦在“知识作者与消费系统之间的契约”：示例必须标明运行环境、依赖版本、输入输出语义，并能在无外部网络时仍能被解析与校验。

## 核心概念与数据模型

1. **示例单元（Example Unit）**：一个最小可引用知识块，包含输入、处理、输出、断言、依赖版本五个字段。不可只有代码片段而无上下文。
2. **可运行标记（Runnability Flag）**：显式声明示例是 `executable`、`pseudo` 还是 `readonly`。`pseudo` 表示仅示意，`readonly` 表示只能被阅读，不能执行。
3. **版本锚点（Version Anchor）**：示例必须声明所依赖的运行时、库、协议或规范的版本号。版本号为空时，该示例视为“未锚定”，检索器与 Agent 都必须降低置信度。
4. **输入契约（Input Contract）**：对配置、请求参数、环境变量、文件路径的精确描述，包括类型、默认值、必填性、来源。
5. **输出断言（Output Assertion）**：对响应或结果的预期形状，可以是 JSON Schema、字符串包含、退出码、状态码，或它们的组合。
6. **知识基线（Knowledge Baseline）**：项目级默认环境，例如 Node.js 20、pnpm 10、TypeScript 5.x。单个示例可覆盖基线，但不可与基线冲突而不加说明。

## 设计决策与取舍

### 1. 先定义接口契约，再选择代码语言
示例的交换格式先于具体语法。所有示例必须能被解析成“输入—处理—输出”三元组，然后再决定用 YAML、JSON、shell 还是 TypeScript 表达。若先写代码再补说明，会导致语义边界模糊。

### 2. 可运行性分三级，不强制全部执行
“可运行”不等于“每次都被执行”。本设计把示例分为可执行、可解释、只读三类。强制所有示例可执行会拖慢构建；全部只读又会失去验证能力。边界是：配置和请求响应示例优先可执行，架构图和伪代码示例可只读。

### 3. 版本号写入示例而非依赖全局锁
全局锁文件（如 pnpm-lock.yaml）记录项目构建依赖，但知识示例需要面向读者。因此每个示例必须内嵌版本声明，而不是依赖读者去查 lock 文件。代价是重复，收益是知识可迁移。

### 4. 示例文件与正文文件解耦，但保持引用关系
长代码示例应存为独立文件，正文通过相对路径引用。解耦避免 Markdown 正文臃肿；引用关系则保证 Agent 在回答问题时能定位原始文件。引用路径必须可解析，否则视为无效示例。

### 5. 校验工具对本地文件系统只读，不修改源码
示例校验器只能读取项目文件、运行解释器或发送本地请求，不能回写源码或自动修复。修复动作必须由作者确认，避免工具在知识库中引入未经审查的变更。

## 可执行的实施流程

1. 在项目根目录定义 `knowledge-baseline.yaml`，声明默认运行时、包管理器、协议版本。
2. 为每个 Markdown 文件建立同名目录，如 `docs/pi-agent.md` 对应 `docs/pi-agent.examples/`。
3. 在该目录下为每个示例创建独立文件，文件名包含顺序编号与主题，如 `01-session-create.yaml`。
4. 在示例文件头部写入 `runnability`、`runtime`、`version` 三个必填字段。
5. 在 Markdown 正文中使用相对路径引用示例，例如 `[示例 01](pi-agent.examples/01-session-create.yaml)`。
6. 编写校验脚本扫描所有 `.md` 文件，提取引用路径，检查文件是否存在、字段是否完整。
7. 对标记为 `executable` 的示例，按声明的运行时执行并比对输出断言；对 `pseudo` 示例仅做语法检查。
8. 将校验结果写入 `knowledge-examples-report.json`，在 CI 中失败阈值设为“可运行示例未通过”或“未锚定示例超过 5%”。

## 本地文件知识库中的示例格式

示例文件 `docs/pi-agent.examples/01-session-create.yaml` 内容如下：

```yaml
runnability: executable
runtime: nodejs
runtime_version: "20.15.0"
sdk_version: "@earendil-works/pi-coding-agent@0.83.0"
description: 使用 AgentSession 创建会话并订阅消息更新
input:
  env:
    PI_PROJECT_CWD: /Users/xbjt/Documents/myself/pi-samples
  files:
    session.ts:
      source: ./session.ts
      required: true
process:
  command: npx tsx session.ts
  timeout_ms: 5000
  working_directory: ${PI_PROJECT_CWD}
output_assertion:
  exit_code: 0
  stdout_contains: "message_update"
  file_exists:
    - /tmp/pi-session-events.jsonl
```

该示例的输入是项目根目录 `PI_PROJECT_CWD` 环境变量和本地文件 `session.ts`。处理阶段使用 Node.js 运行 TypeScript 脚本，超时五秒。输出断言要求进程退出码为零、标准输出包含 `message_update`、且生成事件日志文件。任何一项失败都视为示例失效。

## 性能、质量和可观测性指标

1. **示例覆盖率**：可运行示例数量除以知识库中“配置、请求、响应”三类代码片段总数。目标不低于 70%，由校验脚本统计。
2. **版本锚定率**：含有明确版本声明的示例比例。目标 100%，未锚定示例在报告中标红。
3. **平均校验耗时**：单个可运行示例从解析到断言通过的平均时间。目标在本地 CI 中小于 10 秒。
4. **示例失效率**：最近一次 CI 中未通过断言的示例比例。大于 0% 即阻塞合并，除非显式标记为 `pseudo`。
5. **引用解析率**：Markdown 中示例引用路径可正确解析到文件的比例。由校验脚本扫描并计算，目标 100%。

## 失败模式与恢复

1. **示例路径漂移**：Markdown 引用的示例文件被重命名或删除，校验时路径解析失败。诊断证据是 `knowledge-examples-report.json` 中 `missing_references` 非空。恢复动作：重命名示例文件时同步修改 Markdown 引用，或在 CI 中增加路径检查。
2. **版本声明过期**：运行时版本已升级，但示例仍声明旧版本，导致可运行示例在新环境中失败。诊断证据是执行器报告版本不匹配。恢复动作：批量更新示例版本号，或引入 `knowledge-baseline.yaml` 的版本继承机制。
3. **输出断言过强**：示例代码因日志格式微调而失败，但实际语义正确。诊断证据是退出码为零但字符串断言失败。恢复动作：将断言从字符串包含改为 JSON Schema 或正则，或增加允许波动范围。
4. **外部依赖不可用**：示例依赖网络服务或私有仓库，离线环境无法执行。诊断证据是超时或连接错误。恢复动作：将示例改为 `pseudo` 或 `readonly`，或提供本地 mock 数据。
5. **可运行性标记错误**：一个实际不能执行的示例被标记为 `executable`。诊断证据是执行器抛出语法或运行时错误。恢复动作：修正标记为 `pseudo`，或补充缺失的输入和环境。

## 问答测试样例

1. **正向问题**：`pi-coding-agent@0.83.0` 中创建 `AgentSession` 的示例文件路径和运行时版本是什么？答案应引用 `docs/pi-agent.examples/01-session-create.yaml` 中的 `runtime_version: "20.15.0"` 和 `sdk_version`。
2. **正向问题**：如何校验一个示例的输出是否包含 `message_update`？答案应说明 `output_assertion.stdout_contains` 字段。
3. **边界问题**：如果 `session.ts` 不存在，示例是否仍可运行？答案：不可运行，因为 `input.files.session.ts.required` 为 true，缺失输入会导致校验失败。
4. **边界问题**：示例超时五秒是否足够？答案：对本地启动脚本足够，但依赖网络时可能不足，需按实际情况调整。
5. **无证据拒答**：这个示例是否兼容 Deno？拒答条件：示例文件只声明 `runtime: nodejs`，没有 Deno 相关断言或配置，不能推断兼容性。
6. **无证据拒答**：运行该示例会不会修改源码？拒答条件：示例声明为 `executable` 且只读取文件、生成 `/tmp` 日志，没有写入源码的字段，因此不能推断它会修改项目源码。

## 维护、版本、来源与相邻主题的关系

示例文件与 Markdown 正文应使用同一版本号策略：当知识基线升级时，同步更新所有示例的版本锚点；若单个示例因 API 变化而失效，优先修改示例而非正文。来源方面，每个示例必须引用其对应的代码文件或接口定义，禁止复制其他主题的内容凑数。相邻主题包括：Markdown 正文写作（负责叙述与结构）、知识检索（负责按标题、标签、术语召回）、Agent 工具定义（负责可调用能力）。代码示例与它们的边界是：示例解释“如何运行”，正文解释“为什么这样设计”，检索器负责定位，Agent 工具负责执行，四者不可互相替代。

## 结论

事实：本文定义的示例单元包含输入、处理、输出、断言、依赖版本五个字段；可运行性分为 `executable`、`pseudo`、`readonly` 三级；校验器不修改源码，只读并执行。

推论：当知识基线与示例版本锚点保持同步时，示例覆盖率与版本锚定率可作为知识库健康度的有效代理指标；示例文件与正文解耦能提升长期可维护性。

未知：不同 Agent 运行时对 `pseudo` 示例的容忍度是否一致；校验器在 Windows 与 Linux 环境下对路径和环境变量的行为差异；未锚定示例对检索置信度的实际影响阈值。这些需要结合具体项目运行数据进一步验证。
