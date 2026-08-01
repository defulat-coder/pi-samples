# 面向 Claude Code 的 Markdown 本地知识库方案

> 调研快照：2026-08-01（Asia/Shanghai）。热度与活跃度来自 GitHub 当日仓库/API 快照；能力判断以各项目官方 README、文档和发布记录为准。GitHub Stars 会持续变化。

## 一句话结论

有，而且已经形成了几条相当清楚的路线：

- **已有一批 Markdown，想得到最像 CodeGraph 的“本地索引 + MCP/插件 + Claude Code 检索”体验：首选 [QMD](https://github.com/tobi/qmd)。**
- **希望 Markdown 不只是被搜索，而是由人和 Claude 共同读写、链接、长期积累：首选 [Basic Memory](https://github.com/basicmachines-co/basic-memory)。**
- **已经重度使用 Obsidian，想要一套会整理双链、MOC、证据和维护流程的 Claude Code 工作流：看 [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian)。**
- **真正的问题是 Claude Code 跨会话遗忘，而不是一般文档检索：看 [memsearch](https://github.com/zilliztech/memsearch)。**

`obsidian-skills` 和 Claudian 虽然很热门，但它们解决的是“让 Agent 正确操作 Obsidian 格式”和“把 Claude Code 放进 Obsidian”，**本身不是知识库索引或 RAG 引擎**。这一点不能只看 Stars 就混在一起。

## 先澄清：CodeGraph 是什么，和这里要找的东西有什么关系

如果你说的是 [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)，它确实属于代码知识图谱/代码智能索引：读取代码库，建立符号和关系索引，再通过 MCP 等接口给 Agent 使用。它不是通用 Markdown 知识库。

但它的产品形态很适合拿来类比：

```text
CodeGraph
代码文件 → 本地派生索引/图 → MCP → Claude Code

本文要找的 Markdown 版本
Markdown 文件 → 本地全文/向量/链接索引 → MCP、插件或 Skill → Claude Code
```

这里最重要的设计边界是：**Markdown 是否仍是权威数据，索引是否只是可删除、可重建的派生层。** QMD、Basic Memory、memsearch 都较接近这个方向，但三者分别偏“文档搜索”“可写知识网络”和“Agent 会话记忆”。

## Claude Code 集成等级怎么判断

“支持 MCP”不等于“有 Claude Code 原生集成”。Claude Code 官方支持通过 `claude mcp add ...` 连接本地 stdio 或远程 HTTP MCP Server，因此任何合规 MCP Server 理论上都能接入；项目是否另外提供安装说明、插件、Skills 或 Hooks，是另一层成熟度。[Claude Code MCP 官方文档](https://code.claude.com/docs/en/mcp)

本文使用以下分级：

1. **原生插件/工作流**：项目提供 Claude Code 插件市场安装、Skills、Hooks 或专门命令，接入后不仅有工具，还会改变工作流。
2. **明确的 Claude Code MCP**：项目 README 直接给出 `claude mcp add` 或 Claude Code 配置。
3. **标准 MCP 可接入**：只有通用 MCP Server；Claude Code 能接，但需要用户自行配置和治理。
4. **宿主集成**：把 Claude Code 放进 Obsidian 等宿主，未必提供独立索引能力。

Claude Code 插件可以把 Skills、Hooks、Agents 和 MCP Server 打成一个可安装单元；因此“插件”通常比“一个裸 MCP Server”覆盖面更大。[Claude Code 插件官方文档](https://code.claude.com/docs/en/discover-plugins)

## 推荐顺序

### 1. QMD：最像“Markdown 版 CodeGraph”的检索基础设施

[QMD](https://github.com/tobi/qmd)（快照：28,476 Stars，MIT，最后推送 2026-06-24）面向本地 Markdown、会议记录和文档目录建立 SQLite 索引。检索管线不只是向量相似度，而是组合了：

- SQLite FTS5/BM25 全文检索；
- 本地向量检索与 `sqlite-vec`；
- query expansion；
- Reciprocal Rank Fusion；
- 本地模型 rerank。

它提供 `query`、`get`、`multi_get`、`status` 等 MCP 工具，并在官方 README 中给出 Claude Code 插件安装，也可以直接运行 `qmd mcp`。[QMD：Using with AI agents](https://github.com/tobi/qmd#using-with-ai-agents) · [QMD：How it works](https://github.com/tobi/qmd#how-it-works)

**为什么排第一：** 对已有 Markdown 仓库侵入小，检索栈完整，热度显著领先，而且“源文件 + 可重建索引 + MCP”的形态与 CodeGraph 最接近。

**边界：** 它是高质量检索器，不是由 relations、entities 和事务语义组成的可写知识图谱；首次使用需要下载本地模型，Node/Bun 版本和磁盘占用也要纳入评估。

### 2. Basic Memory：最像“人和 Claude 共同维护的 Markdown 知识库”

[Basic Memory](https://github.com/basicmachines-co/basic-memory)（快照：3,543 Stars，AGPL-3.0，最后推送 2026-08-01）明确把 Markdown 文件作为知识的权威来源；SQLite、全文和向量数据是索引层。它通过 Markdown wikilinks、observations 和 relations 形成可遍历的语义连接，并支持全文与 FastEmbed 向量混合检索。

它官方给出 Claude Code 的 stdio MCP 接法：

```bash
claude mcp add basic-memory -- uvx basic-memory mcp
```

新版仓库还提供 Claude Code 插件，可加入 session-start briefing、压缩前 checkpoint 和显式记忆捕获等工作流。[Basic Memory README](https://github.com/basicmachines-co/basic-memory#works-with-the-tools-you-already-use) · [Claude Code plugin](https://github.com/basicmachines-co/basic-memory#claude-code-plugin)

**为什么排第二：** 它不只“搜文档”，还允许 Claude 写回普通 Markdown，Obsidian 等工具仍能直接打开；链接与关系层也更符合用户对知识图谱的直觉。

**边界：** 它的知识图谱主要建立在 Markdown 链接和结构化关系上，不应等同于完整的企业级图数据库；AGPL-3.0 对嵌入商业产品的团队需要先做许可证评估。

### 3. claude-obsidian：最完整但更有主张的 Obsidian 工作流

[claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian)（快照：10,204 Stars，MIT，最后推送 2026-07-31）是 Claude Code 原生插件，提供一组 Skills 与 Hooks，让 Agent 在 Obsidian vault 内完成收集、整理、建立双链、生成 MOC/Canvas、查询和维护。

项目的重要优点是把能力边界写得比较诚实：默认检索是本地、确定性的 BM25；上下文前缀和部分模型增强能力需要显式许可；PDF/EPUB 等格式并不会神奇地获得完整语义抽取。[claude-obsidian：Honest capability boundaries](https://github.com/AgriciDaniel/claude-obsidian#honest-capability-boundaries)

**适合：** 已有 Obsidian vault，希望 Claude 不只回答问题，还能按一套可审计流程持续整理知识。

**边界：** 它比 QMD 更重、更有方法论；双链图是 Markdown/Obsidian 的链接网络，不代表它内置了通用图数据库或强向量检索引擎。

### 4. memsearch：Claude Code 的跨会话记忆，不是通用资料库

[memsearch](https://github.com/zilliztech/memsearch)（快照：2,407 Stars，MIT，最后推送 2026-07-31）明确把每日 Markdown 记忆文件作为 source of truth，把 Milvus/Milvus Lite 当作可重建的 shadow index。检索组合 dense vector、BM25 sparse 与 RRF。

它提供 Claude Code 原生插件，通过 Hooks 捕获会话、写入或压缩记忆，再通过 Skill 在后续会话中召回；官方说明这条集成不依赖额外 MCP sidecar。[memsearch Claude Code plugin](https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/README.md)

**适合：** 让 Claude Code 记住过去讨论、决策、偏好和任务上下文。

**边界：** 数据模型以 Agent 会话记忆为中心，不是面向大量精心维护的项目文档、读书笔记或企业知识资料。默认本地 embedding 模型和 Milvus Lite 也会带来模型下载与索引成本。

### 5. obsidian-skills：很热门，但它是“操作说明书”，不是搜索引擎

[obsidian-skills](https://github.com/kepano/obsidian-skills)（快照：43,830 Stars，MIT，最后推送 2026-06-08）是本次候选里 Stars 最高的项目。它向 Claude Code 等 Agent 提供 Obsidian Markdown、Bases、JSON Canvas 和 Obsidian CLI 的 Skills，并提供 Claude Code 插件安装方式。

它能让 Agent 更正确地生成 wikilinks、properties、callouts、Bases 和 Canvas，但没有自己的全文索引、向量库、知识图谱、MCP Server 或持久记忆层。[obsidian-skills README](https://github.com/kepano/obsidian-skills)

**正确定位：** 它非常适合作为 QMD、Basic Memory 或已有 Obsidian vault 的上层配套；不要因为 Stars 高就把它当成 RAG/索引后端。

### 6. Claudian：把 Claude Code 放进 Obsidian，而不是给 Claude 增加索引

[Claudian](https://github.com/YishenTu/claudian)（快照：14,471 Stars，MIT，最后推送 2026-08-01）是 Obsidian 插件，把 Claude Code/Codex 等编码 Agent 嵌入 Obsidian；vault 成为工作目录，Agent 可以读写、搜索文件并运行工作流。

**适合：** 想留在 Obsidian UI 内使用 Claude Code，而不是在终端与 Obsidian 之间切换。

**边界：** Claudian 本身没有独立的向量索引、混合检索或知识图谱引擎。它改变的是交互入口与宿主环境，底层知识检索质量仍取决于文件搜索、另装的知识库引擎或 Agent 自身工具。[Claudian README](https://github.com/YishenTu/claudian)

## 核心对比表

| 项目 | 主要定位 | Markdown 是权威数据吗 | 本地优先 | 检索/结构 | Claude Code 集成 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| [QMD](https://github.com/tobi/qmd) | 本地文档检索层 | **基本是**；SQLite 是派生索引 | **是** | BM25 + 向量 + query expansion + RRF + rerank；无知识图谱 | **原生插件 + MCP** | 现有 Markdown 文档库首选 |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | 可读写长期知识库 | **明确是** | **是**；另有可选云服务 | 全文 + 向量 + wikilinks/relations 图 | **明确 MCP + 原生插件** | 共同维护知识网络首选 |
| [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) | Obsidian 知识工作流 | **是** | **是** | 本地 BM25 + 双链/MOC/Canvas；可选增强 | **原生插件、Skills、Hooks** | Obsidian 重度用户首选 |
| [memsearch](https://github.com/zilliztech/memsearch) | Agent 跨会话记忆 | **明确是** | **是** | Dense + BM25 + RRF；无通用知识图谱 | **原生插件、Hooks、Skill** | 会话记忆首选 |
| [obsidian-skills](https://github.com/kepano/obsidian-skills) | Obsidian 格式/CLI Skills | 直接操作 vault | **是** | **没有独立索引** | **原生插件/Skills** | 应作为上层配套 |
| [Claudian](https://github.com/YishenTu/claudian) | Obsidian 内的 Agent UI | 直接操作 vault | **是** | **没有独立索引** | **宿主集成** | 解决 UI，不解决 RAG |

## 两个补充候选：混合格式资料库

如果你的“知识库”并不以 Markdown 为主，还包括 PDF、DOCX、TXT 等文件，可以再看：

- [mcp-local-rag](https://github.com/shinpr/mcp-local-rag)（快照：358 Stars，MIT，最后推送 2026-07-31）：本地 Transformers.js embedding、LanceDB 向量与全文索引、混合检索；README 直接给出 `claude mcp add`，还可安装 Claude Code Skills。[Quick start](https://github.com/shinpr/mcp-local-rag#quick-start) · [How it works](https://github.com/shinpr/mcp-local-rag#how-it-works)
- [knowledge-rag](https://github.com/lyonzin/knowledge-rag)（快照：240 Stars，MIT，最后推送 2026-08-01）：支持 Markdown 在内的多种格式，本地 ONNX、BM25 + 向量 + cross-encoder、ChromaDB，并给出 Claude Code MCP 命令。[knowledge-rag README](https://github.com/lyonzin/knowledge-rag)

它们都更像“本地文档 RAG 服务”，而不是“Markdown 是可由人持续维护的知识网络”；因此没有排进前四。

## 按需求直接选

| 你的真实需求 | 建议 |
| --- | --- |
| 我已经有很多 Markdown，只想让 Claude Code 搜得准 | **QMD** |
| 我希望 Claude 也能写回，而且文件仍能被 Obsidian/编辑器正常管理 | **Basic Memory** |
| 我需要的是链接、MOC、Canvas 和日常整理方法 | **claude-obsidian** |
| 我只想解决 Claude Code 跨会话失忆 | **memsearch** |
| 我已有 Obsidian，只想让 Agent 更懂其文件格式 | **obsidian-skills**，最好搭配 QMD/Basic Memory |
| 我想直接在 Obsidian 里面运行 Claude Code | **Claudian**，需要时再加检索后端 |
| 资料里 PDF/DOCX 比 Markdown 多 | **mcp-local-rag** 或 **knowledge-rag** |

## 建议的试用顺序

不要一开始把所有项目都装进同一个 vault。多个插件、Hooks 和索引器会产生重叠工具、重复索引以及不清楚的写入责任。

建议先用一份可丢弃的 Markdown 副本做两个小实验：

1. **QMD 路线**：只读索引 100–1,000 篇真实文档，测试精确关键词、同义问题、跨文档综合和引用定位。
2. **Basic Memory 路线**：让 Claude 新建、修改、链接 20–50 条笔记，观察 Markdown 可读性、链接质量、冲突处理和重建索引能力。

如果你已明确选择 Obsidian 工作流，再分别叠加 `obsidian-skills` 或换成更完整的 `claude-obsidian`；不要在不知道谁负责写入时同时启用多个自动整理 Hook。

## 证据边界与风险

- 本文没有在本仓库实际安装或跑性能基准，检索能力描述来自项目官方文档；“最好”是按产品形态、公开能力和项目热度给出的选型判断，不是复现后的 benchmark 结论。
- Stars 只能反映关注度，不能替代维护质量、安全性和与你数据规模的匹配度。
- MCP/插件获得写权限后可能修改或删除笔记。应先用副本、只读权限或版本控制验证，再接真实 vault。
- 本地优先不等于零外部通信：可选 embedding/rerank provider、自动更新、遥测或插件宿主都要按项目配置逐项检查。
- “wikilink 图”与“知识图谱数据库”不是同一个概念；如果你需要实体消歧、schema/ontology、图查询语言或严格 provenance，需要额外评估。
- Claude Code 的 MCP、插件和 Skills 能力会演进；最终安装命令应以 [Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp) 和各项目当前 README 为准。

## 主要来源

- Claude Code：[MCP](https://code.claude.com/docs/en/mcp) · [Discover and install plugins](https://code.claude.com/docs/en/discover-plugins)
- QMD：[repository](https://github.com/tobi/qmd) · [AI agent integration](https://github.com/tobi/qmd#using-with-ai-agents)
- Basic Memory：[repository](https://github.com/basicmachines-co/basic-memory)
- claude-obsidian：[repository](https://github.com/AgriciDaniel/claude-obsidian)
- memsearch：[repository](https://github.com/zilliztech/memsearch) · [Claude Code plugin](https://github.com/zilliztech/memsearch/blob/main/plugins/claude-code/README.md)
- obsidian-skills：[repository](https://github.com/kepano/obsidian-skills)
- Claudian：[repository](https://github.com/YishenTu/claudian)
- mcp-local-rag：[repository](https://github.com/shinpr/mcp-local-rag)
- knowledge-rag：[repository](https://github.com/lyonzin/knowledge-rag)
