# Agent SDK + Markdown 知识库问答的低延迟方案

> 调研日期：2026-08-01

## 核心判断

当前慢的根因不是 Markdown 本身，而是让模型执行低层文件检索：模型决定查哪个知识库，调用 glob/grep/read，读取结果后再次决定是否继续，然后才生成答案。每一次客户端工具调用都需要应用执行并把结果放回下一次模型请求；SDK 可以自动管理这个循环，但不会消除模型往返。

Anthropic 官方工具调用文档将流程描述为：模型返回 `tool_use`，应用执行工具，再把 `tool_result` 发送回下一次请求。Managed Agents 文档也建议使用更少、更强的工具来减少工具选择歧义。

来源：

- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works>
- <https://platform.claude.com/docs/en/managed-agents/tools>

## 目标架构

把“文件检索”从 Agent 决策链中移出：

```text
Markdown 知识库
  -> 离线解析和增量索引
  -> 常驻 Knowledge Search Service
  -> 一次检索返回少量片段
  -> 一次模型生成并流式输出
```

Agent 只处理复杂问题：多跳推理、实时 API、数据库查询、动作执行或检索失败后的查询改写。

## 最快可落地方案：先做 lexical fast path

### 离线索引

扫描所有 `.md`，解析标题、段落、代码块和列表，写入 SQLite FTS5 或 PostgreSQL FTS。每条索引记录至少包含：

```text
chunk_id, kb_id, file_path, heading_path,
content, start_line, end_line,
version, language, updated_at, permission_scope
```

索引应由后台任务或服务启动时加载，查询时不能重新遍历文件系统。

### 统一检索接口

```http
POST /knowledge/search
```

请求：

```json
{
  "query": "如何配置 webhook 重试？",
  "knowledge_base_ids": ["product-docs", "runbooks"],
  "top_k": 5,
  "max_chars": 8000,
  "language": "zh-CN"
}
```

返回：

```json
{
  "results": [
    {
      "chunk_id": "product-docs/webhook#retry",
      "knowledge_base_id": "product-docs",
      "title": "Webhook 重试",
      "path": "webhooks/retry.md",
      "start_line": 42,
      "end_line": 68,
      "content": "...",
      "score": 0.91,
      "version": "2026-07-30"
    }
  ],
  "took_ms": 12
}
```

不要把 `glob`、`grep`、`read` 暴露为普通问答的主要知识工具。Agent 如果确实需要补充内容，只提供 `knowledge_read(chunk_id)`，而不是让它重新搜索目录。

## Fast path 与 slow path

### Fast path

适用于大多数事实型问题：

1. 应用层接收用户问题。
2. 直接调用检索服务，不先启动 Agent thinking。
3. 返回 top 3～5 个证据片段。
4. 用一次快速模型请求生成答案。
5. 立即流式返回并附文件、章节和行号引用。

### Slow path

仅当满足以下条件才启动 Agent：

- 需要跨知识库组合多个答案；
- 需要实时查询业务系统；
- 需要执行操作；
- 检索置信度低；
- 用户明确要求深入分析。

## 多个知识库的处理

不要让模型逐个知识库查找。优先选择以下一种：

- 建立一个统一索引，用 `knowledge_base_id` 做过滤；
- 已知产品、租户、页面上下文时，由应用层直接限定知识库；
- 无法判断时，在服务端并行查询多个索引后合并结果。

权限过滤必须在检索服务内完成，不能只依赖模型遵守提示词。

## 第二阶段：混合检索

如果纯 FTS 的召回不够，再增加 embedding：

```text
BM25/FTS + vector search 并行
        -> RRF 合并
        -> 可选 rerank
        -> top 3～5 片段
```

不要一开始就把所有内容迁移到向量库。对 API 名、错误码、版本号和配置项，关键词检索通常更快也更准确。向量检索主要解决自然语言改写和同义表达。

## 缓存与延迟优化

- 缓存键包含规范化后的问题、知识库版本、语言和权限范围。
- 热门问题可以缓存检索结果或完整答案。
- Markdown 更新时按文件哈希增量更新索引，不重建整个库。
- 检索结果限制总字符数，避免把整篇文件送进模型。
- 统一使用流式输出，减少用户感知等待。
- 记录 `retrieval_ms`、`model_calls`、`tool_calls`、`file_reads`、`input_tokens`、`time_to_first_token` 和 `total_ms`。

建议目标是检索 p95 小于 100ms，普通问题只产生一次模型调用，首 token 尽量控制在 2 秒内。实际目标应以真实历史问题集压测为准。

## 推荐实施顺序

1. 给现有流程加埋点，确认每个模型请求、文件查找和工具调用耗时。
2. 实现 Markdown → SQLite FTS5 的增量索引器。
3. 实现 `/knowledge/search`，返回片段、路径和行号。
4. 新增 `ask_fast`：检索后只调用一次模型。
5. 保留现有 Agent 作为 `ask_deep` 回退路径。
6. 用历史问题集评估命中率、引用正确率和 p95 延迟。
7. 只有召回质量不足时，才增加向量检索和 rerank。

## 需要避免的方案

- 只通过提示词要求模型“少查几个文件”；
- 每次问答重新扫描全部 Markdown；
- 用一个巨大的 Markdown 文件代替索引；
- 所有问题都启动 Agent thinking；
- 让模型自行判断权限和可访问知识库；
- 在没有测量 lexical 召回率前就直接上复杂向量基础设施。

## 关于“Cloud Agent SDK”名称

如果这里指的是 Claude Agent SDK，上述工具调用结论有 Anthropic 官方文档直接支持。如果是其他厂商的 Cloud Agent SDK，SDK 名称可能不同，但只要其工作方式是模型决定工具、应用执行工具、结果再回传模型，上述低延迟架构同样适用。
