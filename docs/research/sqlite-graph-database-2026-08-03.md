# SQLite 是否支持图数据库？

> 调研日期：2026-08-03
>
> 资料口径：只采用 SQLite 官方文档和 SQLite 官方源码树。这里把“原生图数据库”理解为数据库内核直接提供图模型和图遍历语言；“能把图存进数据库并查询”则是更宽的能力。

## 结论先行

**SQLite 原生不是图数据库，但可以很好地承载一部分图数据和图查询。** SQLite 官方将自己定义为嵌入式、无服务器的 SQL 数据库引擎；SQLite 的应用文件格式文档还明确称其为“完整的关系数据库引擎”。这决定了它的核心抽象仍然是表、列、索引、约束和 SQL，而不是独立的节点/边图模型。来源：<https://www.sqlite.org/about.html>、<https://www.sqlite.org/appfileformat.html>

与此同时，SQLite 官方 `WITH` 文档明确提供“Queries Against A Graph”示例：用 `edge(aa, bb)` 关系表保存边，用递归 CTE 遍历连通节点，并用 `UNION` 防止含环图无限递归。也就是说，答案不是“SQLite 不能做图”，而是：**用关系模型建图 + 递归 SQL 查询是内置能力；把 SQLite 当成原生图数据库则不准确。** 来源：<https://www.sqlite.org/lang_with.html#queries_against_a_graph>

如果需求是本地、单文件、有限深度的层级/依赖/链接关系，SQLite 加节点表、边表和递归 CTE 通常足够。若需求依赖图原生数据模型、专门的图查询语言、持续的大规模多跳遍历或分布式图计算，应评估专用图数据库或专门图引擎；这属于工程选型建议，不是 SQLite 官方对性能边界的承诺。

## SQLite 原生能力的边界

### 1. 核心是关系/SQL 引擎，不是图内核

SQLite 官方 About 页面把 SQLite 描述为“self-contained, serverless, transactional SQL database engine”，并说明一个数据库文件可包含多个表、索引、触发器和视图。官方应用文件格式文档进一步直接使用“complete relational database engine”这一表述。来源：

- <https://www.sqlite.org/about.html>
- <https://www.sqlite.org/appfileformat.html>

因此，“原生不是图数据库”是基于官方产品定义和核心对象的分类结论。SQLite 官方没有一句“SQLite 不支持图数据库”的否定性口号；更严谨的说法是：**官方核心文档把它定义为关系/SQL 引擎，同时通过 SQL 能力让应用自行表达图结构。**

### 2. 递归 CTE 是内置的图遍历手段

SQLite `WITH` 文档说明：普通 CTE 类似只在单条语句期间存在的临时视图；递归 CTE 可以进行树和图的层级/递归查询。它还给出以下事实：

- 无向图可以用 `edge(aa, bb)` 表保存边；
- 两个递归分支分别沿 `bb -> aa` 和 `aa -> bb` 方向前进；
- 用 `UNION` 而不是 `UNION ALL` 可以丢弃已经出现的节点，避免图中有环时无限循环；
- `ORDER BY` 可以影响树的深度优先/广度优先处理顺序；递归查询也可配合 `LIMIT` 或深度条件控制工作量。

来源：<https://www.sqlite.org/lang_with.html#queries_against_a_graph>、<https://www.sqlite.org/lang_with.html#controlling_depth_first_versus_breadth_first_search_of_a_tree_using_order_by>

### 3. 外键可以约束节点和边的引用完整性，但不是图遍历功能

SQLite 外键文档把外键定义为“子表中的值必须对应父表中的一行”，并以 `trackartist REFERENCES artist(artistid)` 说明这种跨表存在性约束。节点/边建模时，可以让 `edge.src`、`edge.dst` 分别引用 `node.id`，从而避免悬空边。

注意：外键约束在 SQLite 中需要库支持且要由应用对**每个数据库连接**执行 `PRAGMA foreign_keys = ON`；官方文档说明默认关闭（出于向后兼容）。来源：<https://www.sqlite.org/foreignkeys.html#fk_basics>、<https://www.sqlite.org/foreignkeys.html#fk_enable>

外键只负责数据完整性，不会自动提供可达性、最短路径、中心性或路径去重等图算法。

## 推荐的关系表建模方式

对有向属性图，最小可用模式可以是：

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE node (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE edge (
  src  INTEGER NOT NULL REFERENCES node(id),
  dst  INTEGER NOT NULL REFERENCES node(id),
  kind TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
);

CREATE INDEX edge_src ON edge(src);
CREATE INDEX edge_dst ON edge(dst);
```

这里的 `node` 行是节点，`edge` 行是有向边，`kind` 是关系类型或边属性。`PRIMARY KEY` 防止同一关系重复；两个边索引让“从某个节点出发/反向查找”有可用索引。SQLite 官方图查询示例也明确指出，`edge` 两个方向的索引不是语法必需，但对较大图有性能帮助。来源：<https://www.sqlite.org/lang_with.html#queries_against_a_graph>

一个有深度上限的可达性查询如下：

```sql
WITH RECURSIVE reachable(id, depth) AS (
  VALUES (:start_id, 0)
  UNION
  SELECT e.dst, r.depth + 1
    FROM edge AS e
    JOIN reachable AS r ON e.src = r.id
   WHERE r.depth < :max_depth
)
SELECT n.id, n.name, reachable.depth
  FROM reachable
  JOIN node AS n ON n.id = reachable.id
 ORDER BY reachable.depth, n.id;
```

这是 SQLite 官方“Queries Against A Graph”模式的有向图变体。这里的 `depth` 上限保证递归在已知范围内停止；由于 `depth` 也属于 CTE 输出列，`UNION` 并不会自动把不同深度的同一节点合并掉。若要严格按节点去重或阻止一条路径重复经过节点，必须另行设计 visited/path 记录（或改成只递归节点列的可达性查询），不能盲目把 `UNION` 改成 `UNION ALL`。官方还建议在已知上界时给递归设置安全边界。来源：<https://www.sqlite.org/lang_with.html#queries_against_a_graph>、<https://www.sqlite.org/lang_with.html#recursive_query_examples>

## 能力矩阵

| 能力 | SQLite 核心是否具备 | 准确口径 |
| --- | --- | --- |
| 保存节点和边 | 是 | 用普通 SQL 表保存，边表是关系模型中的一类表 |
| 节点/边引用完整性 | 是 | 外键可约束 `edge.src`/`edge.dst`，但每个连接要显式开启外键 |
| 树/图递归遍历 | 是 | 递归 CTE；官方文档有树、无向图和 DAG 示例 |
| 环检测、路径去重、深度限制 | 可由查询实现 | `UNION`、深度条件、`LIMIT` 等由应用/SQL 负责，不是独立图算法 API |
| 原生节点/边/属性图数据模型 | 否（分类结论） | 官方核心定义是关系/SQL 引擎；节点/边需要自行映射到表 |
| 原生图查询语言和图专用索引 | 未见 SQLite 核心提供 | 官方 SQL/CTE 文档没有把它定义成独立图语言或图索引层；这是基于官方能力表面的范围判断 |
| 通过扩展加入自定义图能力 | 机制上可以 | 虚拟表/运行时扩展可加入外部存储、计算或 SQL 功能，但模块由应用提供 |

## 扩展生态与成熟度：不要把 `closure.c` 当成生产图数据库

SQLite 官方源码树的 `ext/misc/README.md` 将 `ext/misc` 定义为“一组较小的可加载扩展”，每个扩展通常是单个 C 源文件；它不是 SQLite 核心图子系统。来源：<https://sqlite.org/src/raw?filename=ext/misc/README.md&ci=a67bff640c9e4ffd>

官方源码树里确实有与图遍历相邻的 `ext/misc/closure.c`，其文件头描述了 `transitive_closure` 虚拟表，可以对父子关系求传递闭包。但同一文件也明确写出：

1. 它是“Experimental and obsolete”；
2. 它诞生于递归 CTE 之前，递归 CTE 是更好、更可移植的解决方案；
3. 因为仅用于实验/测试，除非用 `-DSQLITE_TEST=1` 编译，否则代码会被停用；
4. 标注为“DEMONSTRATION AND TESTING USE ONLY”。

来源：<https://sqlite.org/src/raw?filename=ext/misc/closure.c&ci=a67bff640c9e4ffd>

这给出比“网上有某个 sqlite-graph 包”更可靠的成熟度判断：**SQLite 有可扩展机制，也有官方源码树中的图邻近实验代码，但官方并没有把它作为内置、生产级图数据库层来维护。**

### 虚拟表/运行时扩展意味着什么

SQLite 官方虚拟表文档把虚拟表定义为“看起来像表、但实际由外部存储或计算引擎提供”的接口；模块必须通过 `sqlite3_create_module()` 注册。运行时扩展文档说明扩展可以加入 SQL 函数、虚拟表等能力，但出于安全原因扩展加载默认关闭，需要应用显式开启或静态链接。来源：

- <https://www.sqlite.org/lang_createvtab.html>
- <https://www.sqlite.org/vtab.html>
- <https://www.sqlite.org/loadext.html#overview>
- <https://www.sqlite.org/loadext.html#loading_an_extension>

因此，某个扩展可以让 SQLite“呈现出”图查询接口，但那是额外模块的能力、供应链和部署责任，不等于 SQLite 核心本身变成图数据库。

## 选型建议

### 适合 SQLite + 关系建模的场景

- 单机或嵌入式应用，需要单文件和事务；
- 文档链接、依赖关系、组织层级、权限继承、Git-like DAG 等图规模可控的场景；
- 主要查询是有限深度的可达性、祖先/后代、邻居和简单路径过滤；
- 希望继续使用普通 SQL、现有 ORM 和 SQLite 生态。

### 应谨慎或考虑专用图引擎的场景

- 业务核心就是任意深度多跳遍历，而不是少量递归查询；
- 需要大量图算法（最短路、中心性、社区发现、相似性等）和专门的执行计划；
- 需要图原生查询语言、图可视化/分析工具链或分布式图存储；
- 需要把图查询性能与数据规模、并发和扩展能力作为首要指标。

这些是基于建模和运维成本的工程判断；在采用前，应针对真实节点数、边数、最大深度、环比例、并发和查询分布做基准测试。

## 最终回答

如果问题是“SQLite 能不能存和查图”：**能，官方就用递归 CTE 演示了图查询。**

如果问题是“SQLite 是不是像 Neo4j 那样的原生图数据库”：**不是。它是关系/SQL 引擎；图能力来自节点/边表的关系建模、递归 SQL，以及可选扩展。** 官方 `closure.c` 还明确属于过时的实验/测试代码，不应作为生产级图数据库能力的依据。
