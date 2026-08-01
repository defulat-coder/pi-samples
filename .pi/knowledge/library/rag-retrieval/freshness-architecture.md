---
type: concept
title: 新鲜度：架构视角
description: 从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。用更新时间、过期时间和发布状态避免旧资料覆盖新事实
resource: .pi/knowledge/library/rag-retrieval/freshness-architecture.md
tags: [Pi, Agent, Kimi, 知识库, rag-retrieval, freshness, architecture]
status: active
verified: true
updated: 2026-08-01
generated_by: kimi
generator_provider: kimi-coding
generator_model: kimi-for-coding
domain: rag-retrieval
topic: freshness
variant: architecture
---

# RAG 检索新鲜度：用时间边界阻止过期事实覆盖当前答案

摘要与问题边界

RAG 系统的风险不只是“找不到”，而是“找到了但已经过时的答案，并且因为语义相近而排在最前面”。新鲜度问题的核心不是让知识库永远最新，而是把每条文档的“可信时间区间”显式建模，并在检索阶段作为硬边界使用。本文从架构视角出发，先定义概念、责任边界和可替换接口，再讨论实现。目标读者是负责检索边界、长期演进和跨团队协作的设计者。范围限定在索引元数据、检索过滤策略与可观测性，不展开具体向量化模型或提示工程。

核心概念与数据模型

1. 记录时间三元组。updated_at 表示内容最后变更，created_at 表示首次入库，published_at 表示对外发布。三者不能混用；检索策略通常以 published_at 或 updated_at 作为排序轴，具体选择取决于业务对“首次公开”还是“最后修订”更敏感。

2. 业务有效期。effective_from 与 effective_until 描述规则在真实世界中的生效区间。它与物理删除无关，过期文档仍可被保留用于审计或历史查询角色，但默认检索应被排除。

3. 发布状态机。draft、published、deprecated、archived 必须构成单向或有限回退的状态机。关键边界是：draft 不应被外部检索器召回；deprecated 可被显式历史查询召回；archived 仅供审计。

4. 版本关系图。每条文档携带 version_id、replaces、replaced_by，形成有向无环图。循环必须被校验器拒绝，否则回滚与覆盖逻辑会失效。

5. 新鲜度衰减函数。当过期时间未知或作为弱提示时，可用单调递减函数 f(t) 把“离现在越久”映射为排序惩罚。该函数必须是确定性的，避免同一查询两次结果不一致。

6. 来源同步指纹。source_system、last_sync_at、sync_signature 用于验证时间戳不是本地抽取管道凭空生成，而是可以追溯到上游系统的一次写入。

7. 可替换策略接口。FreshnessPolicy 接收候选文档与查询时间，返回 include、score_penalty、reason。检索服务只依赖该接口，不硬编码业务规则，从而允许不同租户或角色注入不同策略。

设计决策与取舍

谁来负责生成时间

源系统拥有业务语义的权威，应提供原始 updated_at 与 publish_status；抽取管道负责格式规范化、时区转换和合法性校验；检索层只消费标准化字段，不回写时间。边界例外：如果源系统不输出时间，管道可以填充 ingestion_time 作为 fallback，但必须打上 fallback 标签并告警，否则会把入库时间误当作内容更新时间。

过期时间是强契约还是弱提示

强契约意味着 effective_until 或 expires_at 之后文档不可召回，适用于医疗、金融等监管领域。弱提示仅降低排序分，适用于内容推荐等容忍历史结果的场景。架构上应同时支持两种模式，通过策略配置切换，而不是在检索服务里写死。

发布状态过滤放在索引前还是检索后

索引前过滤会永久删除某些状态的向量，无法响应历史查询或审计需求；检索后过滤保留完整索引，但增加每次查询的过滤开销。建议状态字段参与索引过滤，但保留原始文档的全量副本在对象存储中。这样默认查询走过滤索引，审计查询回退到全量副本。

静态 TTL 与动态衰减

静态 TTL 简单、可预测、便于缓存；动态衰减能结合查询语义，例如“最新实验结果”自动加重近因。动态衰减的问题在于可能引入非单调行为，导致结果不可重复。推荐默认静态 TTL，仅在明确需要“近因优先”且可接受轻微抖动的场景启用动态衰减。

时间精度与时区

索引层统一使用 UTC 毫秒整数或带 Z 的 ISO 8601 字符串。展示层再转换本地时区。绝不在索引中存储“2024-03-01 00:00:00”这种没有偏移的字符串，否则夏令时切换会产生重复或断档。

版本回滚的边界条件

回滚不是物理删除新版本，而是把旧版本状态改为 published 并把新版本标记为 archived 或 deprecated。必须保证同一时刻只有一个 published 版本处于生效区间，否则检索会出现并列答案。回滚操作应通过版本关系图校验，防止循环依赖。

可执行的实施流程

1. 在文档 schema 中增加 updated_at、published_at、effective_from、effective_until、publish_status、version_id、replaced_by 七个标准字段。

2. 修改所有写入端，包括文件同步、CMS 发布、API 导入，确保每次写入至少携带 updated_at 与 publish_status。

3. 在 ETL 或 embedding 管道中增加时间校验：effective_until 必须大于等于 effective_from；published 状态的文档必须有 published_at；状态转换必须符合状态机。

4. 扩展向量索引与文本索引，把 publish_status、effective_from、effective_until 注册为可过滤字段；状态机枚举值应使用整数编码以减少索引大小。

5. 定义 FreshnessPolicy 接口，提供默认的 CurrentPublishedPolicy，仅返回 published 且处于有效期内的文档。

6. 在检索服务中把 policy 作为请求级参数注入，允许按角色或租户覆盖；例如审计员可使用 HistoricalPolicy。

7. 建立回归测试集，覆盖“过期文档被过滤”“新版本覆盖旧版本”“draft 不可召回”“过渡期多版本共存”四个场景。

8. 接入可观测性，统计过期命中率、时间戳缺失率、状态不一致告警，并在策略变更时提供灰度开关与一键回滚。

贴近本地文件知识库的示例

下面是一个 TypeScript 函数，用于处理本地 Markdown/Markdoc 文件知识库。假设文件 frontmatter 已解析为 rawMeta，函数负责统一时间字段并执行默认新鲜度策略。

    type DocMeta = {
      id: string;
      updatedAt: number;
      expiresAt: number | null;
      status: "draft" | "published" | "deprecated" | "archived";
      replaces?: string[];
    };

    interface FreshnessPolicy {
      evaluate(doc: DocMeta, queryTime: number): {
        include: boolean;
        scorePenalty: number;
        reason: string;
      };
    }

    const currentPublishedPolicy: FreshnessPolicy = {
      evaluate(doc, now) {
        if (doc.status !== "published") {
          return { include: false, scorePenalty: 1, reason: "status_not_published" };
        }
        if (doc.expiresAt !== null && now > doc.expiresAt) {
          return { include: false, scorePenalty: 1, reason: "expired" };
        }
        return { include: true, scorePenalty: 0, reason: "ok" };
      }
    };

    function filterCandidates(docs: DocMeta[], now: number) {
      return docs
        .map(d => ({ doc: d, verdict: currentPublishedPolicy.evaluate(d, now) }))
        .filter(r => r.verdict.include);
    }

输入是本地文件解析得到的元数据数组，字段可能来自 frontmatter 或文件系统 mtime；处理阶段把状态与过期时间同查询时间比较；输出是仍然有效的文档列表，供后续向量化或重排序使用。关键边界是：如果 frontmatter 缺失 expiresAt，函数不会默认拒绝，而是视为“无明确过期”，这需要在索引监控中单独统计。

性能、质量与可观测性指标

1. 过期文档命中率。在检索日志中统计被召回但又被 freshness policy 过滤的文档占总召回的比例。目标不是降到零，而是稳定且可解释；突然升高通常意味着源系统批量产生错误时间戳。

2. 时间戳缺失率。定期扫描索引，统计缺少 updated_at 或 effective_from 的文档比例。超过阈值应触发告警，而不是默默依赖 fallback。

3. 新鲜度加权精确率。准备人工标注的测试集，每个问题标注正确答案应依据的时间区间。计算召回结果中 relevant 且未过期的比例，并按问题难度分层。

4. 检索延迟增量。对比开启时间过滤前后的 p99 延迟。如果过滤字段已建立索引，增量应控制在 5% 以内；若超过，则需检查是否把过滤放在了重排序之后。

5. 状态不一致告警数。同一 id 在源系统、索引、向量存储中的 publish_status 不一致的次数。该指标反映同步管道健康度，而非检索层本身。

6. 版本回滚平均恢复时间。从状态变更提交到检索结果符合预期的时间。该指标应通过端到端探测持续测量，而不是只看索引刷新延迟。

失败模式、诊断证据与恢复动作

1. 时间戳缺失导致旧文档上浮。诊断证据：检索结果中排名靠前的文档 updated_at 为空，或同一主题存在多个版本时旧版本胜出。恢复：为缺失文档填充 sentinel 时间并置底，同时要求源系统补录；在索引中标记 fallback_until。

2. 过期时间设置错误。诊断证据：expiresAt 显著大于内容的合理生命周期，或大量文档集中在同一未来时间点过期。恢复：建立领域级最大 TTL 校验；对异常值批次重新导入。

3. 状态机流转死锁。诊断证据：业务规则已上线，但文档长期停留在 draft；或 deprecated 文档被错误召回。恢复：把状态转换守卫条件写入 schema 校验与 CI；运行时增加状态不一致探测任务。

4. 时区与夏令时错误。诊断证据：本地时间字符串被解析为 UTC，导致内容提前或延后数小时生效；或每年夏令时切换期间出现重复或缺失。恢复：强制使用 ISO 8601 带 Z 或显式偏移；在管道中拒绝无时区字符串。

5. 版本关系循环。诊断证据：通过 replaces/replaced_by 构建的图出现环，回滚操作失败或返回多个 published 版本。恢复：写入前执行拓扑排序校验，发现环则拒绝整批写入并告警。

6. TTL 与业务事件不同步。诊断证据：业务公告已提前失效，但知识库仍按原 TTL 保留文档。恢复：让业务系统通过 webhook 或消息队列主动推送状态变更，而不是仅依赖定时扫描。

问答测试样例

1. 正向问题：当前退款政策的最长处理时效是多少？期望返回 publish_status 为 published、effective_until 未过期文档中的答案。

2. 边界问题：2023 年 12 月签署的老客户合同，过渡期条款何时失效？期望返回 effective_from <= 2023-12 < effective_until 的历史版本，并在答案中标注生效区间。

3. 无证据拒答：2025 年第三季度的定价策略是什么？若当前没有 published 且 future 区间匹配的文档，应回答“无已发布资料”，而不是返回最近的旧版本。

4. 边界问题：一份 deprecated 的技术方案是否仍可作为历史参考？当查询角色为审计员或策略显式允许历史召回时返回，并在答案顶部标注“已废弃”。

5. 正向问题：功能 X 的废弃公告是什么时候发布的？期望返回对应版本文档的 published_at，而不是某篇博客的 updated_at。

6. 无证据拒答：某篇仅处于 draft 的内部备忘录内容是什么？应回答“该资料尚未发布，无法引用”，即使向量相似度很高。

维护、版本、来源与相邻主题的关系

时间 schema 应独立版本化，例如 freshness_schema_v2，升级时通过迁移脚本回填旧文档的缺失字段，而不是直接改字段语义。来源审计字段必须与访问控制协同：freshness 不能绕过权限让受限文档被召回。与相邻主题“重排序”的边界是：freshness policy 决定候选集和时间分，重排序模型决定语义相关分，两者通过可组合分数相加。与“来源可信度”的关系是：即使来源可靠，过期文档仍应被过滤；可信度影响的是排序，不是时间有效性。与“缓存”的关系是：检索结果缓存 TTL 必须小于被引用文档的最小剩余有效期，否则可能把过期答案返回给用户。

结论

事实：在 RAG 检索中引入 updated_at、expires_at 或 effective_until 以及 publish_status 三类字段，可以在架构层面显式屏蔽过期或未发布文档，避免旧事实覆盖新事实。

推论：把 FreshnessPolicy 抽象为可替换接口，能够让同一套索引服务不同业务域和角色；但该推论成立的前提是源系统提供可信时间戳，并且管道中的校验与审计能够持续捕获异常。

未知：不同业务领域对“过期”的语义差异有多大、用户查询中隐含的时间意图能否被可靠识别、动态衰减函数对长期用户体验的真实影响，都需要在生产环境中通过 A/B 测试和日志分析进一步验证。
