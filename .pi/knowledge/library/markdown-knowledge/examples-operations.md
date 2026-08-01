---
type: concept
title: 代码示例：验证与运维视角
description: 让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。让配置、请求和响应示例可运行、可解释并标明版本
resource: .pi/knowledge/library/markdown-knowledge/examples-operations.md
tags: [Pi, Agent, Kimi, 知识库, markdown-knowledge, examples, operations]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: markdown-knowledge
topic: examples
variant: operations
---

# Markdown 知识写作中的代码示例：让配置、请求与响应可运行、可解释且可版本验证

## 摘要与问题边界

在面向验证与运维的 Markdown 知识库中，代码示例不是装饰性插图，而是可重复执行的证据单元。工程师排查性能抖动、稳定性退化和故障恢复时，需要的不只是“一次成功请求”的截图，而是配置、请求、响应三者之间可被复现、可解释、可锚定版本的关系。本文聚焦 TypeScript/Web 与本地文件知识库场景，讨论如何把 Markdown 中的代码示例转化为可观测的运维证据。范围限定为：配置片段、API 请求示例、响应断言、版本声明与运行环境描述；不覆盖实时生产流量捕获、真实密钥管理、跨语言运行时适配。

## 核心概念与数据模型

1. 示例片段（Snippet）：Markdown 中 fenced code block 承载的原始代码，必须标注语言标识符与来源路径，例如 `typescript:examples/agent-session.ts`。
2. 运行意图（Intent）：示例要验证的精确行为，如“创建会话”“重试工具调用”“关闭时取消订阅”，不是功能概述。
3. 版本锚点（Version Anchor）：运行时、依赖、工具链的显式版本声明，例如 Node.js 20.11.0、pnpm 10.30.3、`@earendil-works/pi-coding-agent` 0.83.0。
4. 断言契约（Assertion）：对成功、失败、延迟、容量、恢复五类结果的预期，必须能量化，如“p95 延迟 < 200ms”“重试 3 次后失败”。
5. 观测点（Observation Point）：示例执行时写入日志或指标的位置，如 `message_update` 事件计数、`tool_execution_end` 耗时。
6. 证据链（Evidence Chain）：单次执行留下的时间戳、版本、输入、输出、环境差异，用于后续比对与回归定位。

## 设计决策与取舍

### 静态示例 vs 可运行示例
静态示例维护成本低，但无法验证版本漂移。可运行示例需要构建环境，却能直接暴露依赖过期、接口变更、路径错误。核心配置与请求响应示例应全部可运行，辅助说明片段可保持静态。

### 真实请求 vs 模拟桩
真实请求能捕获网络延迟与外部依赖失效，但引入不稳定与凭证风险。模拟桩保证可重复，却可能掩盖容量问题。决策边界：本地文件知识库操作使用真实请求，依赖外部模型或网络的服务使用记录式桩，并在桩元数据中保留原始延迟分布。

### 版本锁定 vs 最新兼容
锁定版本使知识库可复现，但会滞后于安全补丁。声明“兼容最新”减少维护，却容易在读者环境失效。推荐：知识库正文锁定主版本，CI 在补丁版本矩阵中运行，发现不兼容时触发文档更新。

### 单路径成功 vs 多路径覆盖
只展示成功路径会让运维人员低估失败场景。每个请求示例至少配套：正常响应、超时重试、错误响应、降级响应。本地文件操作还需覆盖文件不存在、权限不足、并发写入。

### 内嵌知识库 vs 外部测试仓库
内嵌示例便于阅读与检索，但会让文件膨胀。外部仓库可独立 CI，却增加跳转成本。折中：知识库保留最小可运行片段与链接，完整测试套件存放于 `packages/pi-agent/__tests__/examples/` 并定期同步。

## 可执行的实施流程

1. 在 Markdown 中标注每段代码的类型标签：`config`、`request`、`response`、`assertion`、`observation`。
2. 在代码块前声明运行环境，包括 Node.js 版本、包管理器、必要环境变量。
3. 将示例抽取为可运行文件，放入仓库的 `examples/` 或 `__tests__/` 目录，文件名与 Markdown 中一致。
4. 为每个请求注入观测点，记录开始时间、结束时间、事件类型、字节数或事件数。
5. 执行示例，记录成功证据：至少连续 3 次成功，且 p95 延迟落在断言区间内。
6. 构造失败与延迟场景：网络超时、文件缺失、依赖版本回退，确认示例能产出预期错误响应。
7. 执行容量测试：在并发数 2、4、8 下运行，观察内存、句柄泄漏与恢复时间。
8. 将示例纳入 CI，每次依赖升级或文档修改时触发回归；失败时阻断合并，并更新版本锚点。

## 示例：本地文件知识库的请求与响应

```typescript
// examples/knowledge-query.ts
// 运行环境: Node.js 20.11.0, pnpm 10.30.3
// 输入: 本地 Markdown 文件路径与查询关键词
import { readFile } from 'node:fs/promises';
import { searchKnowledge } from '../packages/pi-agent';

const input = { path: '.pi/knowledge/api-contracts.md', query: 'SSE timeout' };
const start = performance.now();

try {
  const result = await searchKnowledge(input);
  const latency = performance.now() - start;

  console.log(JSON.stringify({
    output: result,
    latencyMs: latency,
    version: process.env.PI_AGENT_VERSION || '0.83.0',
    status: 'success'
  }));
} catch (error) {
  console.log(JSON.stringify({
    output: null,
    error: (error as Error).message,
    latencyMs: performance.now() - start,
    status: 'failure'
  }));
}
```

输入为本地 Markdown 文件路径与查询字符串；处理过程调用 `searchKnowledge`，内部读取文件、解析标题与标签、执行关键词匹配；输出为 JSON 结构，包含结果、延迟、版本与状态，便于日志收集与断言校验。

## 性能、质量与可观测性指标

1. 示例覆盖率：可运行示例占全部代码块的比例，通过 `find docs -name "*.md"` 与 `find examples -type f` 数量比计算，目标 ≥ 60%。
2. 运行成功率：CI 中示例通过次数 / 总执行次数，按版本矩阵分别统计，目标 ≥ 98%。
3. 平均执行延迟：对请求响应示例重复执行 30 次，取 p95 延迟，本地文件操作目标 < 50ms，网络请求目标 < 500ms。
4. 断言失败率：断言不匹配次数 / 总断言数，用于检测版本漂移或接口变更，目标 < 1%。
5. 版本漂移率：知识库中版本锚点与 lock 文件不一致的示例数，通过脚本扫描 `package.json` 与 Markdown 版本字符串得到，目标 = 0。

## 失败模式、诊断证据与恢复动作

1. 版本不匹配：运行时 `PI_AGENT_VERSION` 与 lock 文件不一致，表现为 `TypeError` 或 `Module not found`。诊断证据为 package.json 版本与代码块注释版本差异。恢复：同步版本锚点，运行 `pnpm install`，重新执行示例。
2. 路径依赖漂移：示例引用 `../packages/pi-agent` 但实际目录已重命名。诊断证据为 `ENOENT` 与路径不存在。恢复：更新示例路径，或建立 `paths` 映射脚本。
3. 断言过于宽松：断言只检查字段存在，未检查数值边界，导致真实延迟超标未被发现。诊断证据为成功率高但 p95 延迟持续升高。恢复：收紧断言阈值，引入趋势告警。
4. 外部依赖失效：模拟桩过期，真实服务返回新错误码。诊断证据为桩记录时间戳早于服务变更日期。恢复：重新录制桩，保留错误响应样本。
5. 并发容量击穿：并发 8 时句柄泄漏或内存增长。诊断证据为进程退出码非零、句柄数单调上升。恢复：限制并发数，添加背压与超时，文档中标注最大并发。

## 问答测试样例

1. 正向问题：在 Node.js 20.11.0 下如何运行 `examples/knowledge-query.ts`？回答需给出 `pnpm exec tsx examples/knowledge-query.ts` 并说明环境变量。
2. 正向问题：如何验证响应中延迟字段的格式？回答需指出输出为 `latencyMs` 数值，单位毫秒，且断言应检查 `< 50`。
3. 边界问题：文件路径不存在时示例会返回什么？回答需说明输出 JSON 中 `status: 'failure'` 与 `error` 字段。
4. 边界问题：版本锚点与 lock 文件不一致时是否应阻止合并？回答需给出是，并说明 CI 阻断规则。
5. 无证据拒答：当前示例是否支持 Python 运行时？若知识库无 Python 示例与测试证据，应拒绝回答，仅说明当前范围限于 TypeScript/Node.js。
6. 无证据拒答：生产环境中真实 provider 密钥如何轮转？若知识库未包含凭证管理示例，应拒绝回答，建议查阅安全运维文档。

## 维护、版本、来源与相邻关系

每篇包含代码示例的 Markdown 文件应在末尾标注版本来源：运行环境版本、示例最后验证时间、对应仓库路径。版本号优先采用 `package.json` 中的精确版本，而非“latest”。来源标注应链接到测试文件，如 `packages/pi-agent/__tests__/examples/knowledge-query.test.ts`。

与相邻主题的关系：代码示例隶属于“Markdown 知识写作”主题，与“Prompt 模板”相邻，后者关注文本结构而非可运行证据；与“Observability”相邻，后者关注运行时指标而非知识库示例版本；与“CI/CD”相邻，后者负责执行流程而非内容编写。

## 结论

事实：代码示例在 Markdown 知识库中可作为可执行证据，通过版本锚点、断言契约与观测点能够记录成功、失败、延迟、容量与恢复信息。推论：当示例纳入 CI 并按版本矩阵运行时，可显著降低版本漂移与接口变更导致的文档失效。未知：不同读者本地环境的微小差异（如文件系统挂载、网络代理、缓存策略）是否会导致同一示例出现不可复现的延迟，需要更多跨环境测试数据才能给出定量结论。
