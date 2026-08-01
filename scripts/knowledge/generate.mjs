import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const projectRoot = resolve(process.cwd());
const knowledgeRoot = join(projectRoot, '.pi', 'knowledge');
const generatedRoot = join(knowledgeRoot, 'library');
const updated = '2026-08-01';

const makeDomain = (id, title, summary, topicText, axes, artifacts, metrics, risks) => ({
  id,
  title,
  summary,
  topics: topicText.map((value) => {
    const [topicId, topicTitle, focus] = value.split('|');
    return { id: topicId, title: topicTitle, focus };
  }),
  axes,
  artifacts,
  metrics,
  risks,
});

const domains = [
  makeDomain(
    'pi-runtime',
    'Pi Agent 运行时',
    '围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。',
    [
      'session|Session 生命周期|从资源加载、创建 session、提交 turn 到关闭的状态变化',
      'prompt|Prompt 与 turn|一次 prompt 如何进入模型回合，以及排队、跟随和中止语义',
      'events|事件流|文本、thinking、tool call 与生命周期事件如何保持顺序和可追踪性',
      'thinking|Thinking level|不同思考级别对可见事件、成本和回答稳定性的影响',
      'tools|工具执行|Pi 如何根据工具契约选择工具，并把参数与执行结果纳入回合',
      'resources|资源加载|AGENTS、skills、prompts 与项目目录如何形成 Agent 上下文',
      'models|ModelRuntime|provider、model、凭据和模型能力如何在 API 端被安全配置',
      'rpc|RPC 与 JSONL|进程内 SDK、RPC 和 JSONL 模式的边界以及 Web 适配方式',
      'state|Session 状态|多轮会话、历史消息、恢复和并发请求之间的状态一致性',
      'retries|中止与重试|模型重试、工具失败、客户端断开和最终收敛的处理策略',
    ],
    ['资源快照与 cwd 绑定', '事件顺序和 backpressure', '模型能力与 thinking 配置', '工具参数和结构化结果', 'session 关闭与错误收敛'],
    ['SessionManager 注册表', 'DefaultResourceLoader', 'AgentSessionEvent 归一化器', '模型配置快照', '可回放的 turn 记录'],
    ['首个事件延迟', '首个文本 token 延迟', '单工具执行耗时', 'turn 完成耗时', '断开后的资源回收率'],
    ['重复 prompt 造成并发 turn', '资源变更未 reload', 'thinking 事件被错误当作答案', '工具结果超出上下文预算', '重试后重复发送 done'],
  ),
  makeDomain(
    'agent-design',
    'Agent 设计范式',
    '把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。',
    [
      'loop|Agent Loop|模型观察上下文、选择行动、接收结果并继续回合的闭环',
      'boundary|决策边界|应用提供能力，模型决定是否使用能力，二者不互相越权',
      'context|上下文预算|系统提示、工具说明、检索片段和历史消息如何共同消耗预算',
      'evidence|证据回答|回答必须能回到实际使用的文件、数据库记录或工具结果',
      'clarify|澄清问题|信息不足时如何提出最少且有价值的澄清，而不是猜测',
      'fallback|降级回答|没有模型、工具失败或证据不足时如何保持诚实且可操作',
      'multiturn|多轮对话|将前一轮事实、用户修正和新证据合并为下一轮上下文',
      'prompts|提示层次|系统约束、项目上下文、工具指南和用户问题如何分工',
      'capability|能力注入|只给 Agent 当前任务需要的最小能力，避免无限工具集合',
      'review|人工复核|高风险答案如何在流式体验中保留审核、拒绝和追问入口',
    ],
    ['模型决策和宿主职责', '事实、推论和未知状态', '用户意图与能力授权', '单轮速度和长期可维护性', '自动化与人工复核'],
    ['Agent contract', 'context snapshot', 'evidence envelope', 'capability registry', 'human review record'],
    ['证据覆盖率', '无证据拒答率', '澄清后解决率', '工具选择准确率', '人工复核通过率'],
    ['把关键词路由伪装成 Agent', '把检索结果当作指令', '把模型输出当作权限', '把未知写成肯定答案', '让 fallback 冒充真实模型决策'],
  ),
  makeDomain(
    'rag-retrieval',
    'RAG 与检索',
    '从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。',
    [
      'ingest|语料摄取|将 Markdown、结构化记录和来源元数据转换为可检索概念',
      'chunking|分块策略|在保持上下文完整的同时控制片段大小和上下文成本',
      'lexical|字面检索|使用标题、标签、正文和中文关键词建立确定性召回',
      'bm25|BM25 排序|利用词频、逆文档频率和字段权重排序候选片段',
      'vector|向量检索|在需要语义相似时引入 embedding，并记录模型与版本',
      'hybrid|混合检索|将字面命中与语义命中融合，避免单一检索方式的盲区',
      'rerank|重排序|在候选集较小的情况下提高相关性，但控制额外模型延迟',
      'rewrite|查询改写|扩展同义词、实体和约束，同时避免改变用户真正意图',
      'citation|引用与证据|让每个回答结论都能回指文件、片段和版本信息',
      'freshness|新鲜度|用更新时间、过期时间和发布状态避免旧资料覆盖新事实',
    ],
    ['召回范围与上下文预算', '字段权重与排序策略', '离线索引与在线查询', '相关性和延迟的取舍', '证据版本和新鲜度'],
    ['concept manifest', 'chunk manifest', 'query trace', 'ranked result set', 'citation map'],
    ['Recall@K', 'Precision@K', 'MRR', 'NDCG', '检索 p95 延迟'],
    ['片段切断关键条件', '同义词扩展改变意图', '热门文档压制少数事实', '过期文档仍被召回', '上下文过长导致答案漂移'],
  ),
  makeDomain(
    'okf-governance',
    'OKF 知识治理',
    '用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。',
    [
      'frontmatter|Frontmatter|用稳定字段描述 concept 类型、标题、资源、标签和状态',
      'concept-id|Concept ID|通过目录路径形成稳定标识，支持链接、引用和增量索引',
      'bundle-index|Bundle 导航|用 index 文件表达目录结构和渐进式披露，而非假装倒排索引',
      'provenance|来源追踪|记录原始来源、生成过程、验证人和证据时间',
      'status|生命周期状态|区分 active、draft、deprecated 和过期内容的消费策略',
      'links|知识链接|维护 concept 之间的关系、反向链接和引用完整性',
      'schema|规范校验|在发布前检查 frontmatter、路径、链接和必填字段',
      'versioning|版本管理|用 Git diff 审阅知识变更，并保留可回滚的发布快照',
      'publishing|发布流程|把作者草稿、验证、索引编译和线上切换分成清晰阶段',
      'migration|格式迁移|从旧字段或旧目录迁移时保持 ID、引用和内容语义稳定',
    ],
    ['可读性和机器可解析性', '事实来源和计算来源', '内容状态和消费权限', '链接关系和孤立节点', '发布可回滚性'],
    ['OKF bundle', 'frontmatter schema', 'provenance record', 'validation report', 'release manifest'],
    ['frontmatter 校验通过率', '孤立 concept 数量', '过期 concept 比例', '发布回滚耗时', '引用可解析率'],
    ['把 OKF 当成检索引擎', 'index.md 被误当成倒排索引', 'ID 随文件重命名变化', '草稿进入生产召回', '外部链接没有版本证据'],
  ),
  makeDomain(
    'markdown-knowledge',
    'Markdown 知识写作',
    '让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。',
    [
      'authoring|文章编写|先定义读者、问题边界和事实来源，再组织可检索正文',
      'headings|标题层级|用稳定的 H1 到 H3 结构帮助摘要、分块和导航',
      'tables|表格表达|用表格呈现字段、决策、状态和对比，避免把关键事实藏在长段落里',
      'examples|代码示例|让配置、请求和响应示例可运行、可解释并标明版本',
      'glossary|术语表|为同义词、缩写和领域词提供统一定义，降低查询歧义',
      'faq|FAQ 组织|把真实问题、边界答案和拒答条件组织成可复用问答单元',
      'runbook|运行手册|将触发条件、诊断步骤、恢复动作和验证证据写成顺序流程',
      'policy|政策说明|明确适用范围、例外、审批人和不允许的解释空间',
      'changelog|变更记录|让内容读者知道何时、为什么、由谁改变了事实',
      'translation|多语言内容|保持术语映射、数字和条件一致，而不是逐句机械翻译',
    ],
    ['读者任务和文章结构', '事实密度和可扫描性', '示例可复制性', '术语一致性', '维护频率和责任人'],
    ['文章大纲', '术语映射表', '步骤检查表', '示例请求响应', '变更日志'],
    ['首屏找到答案时间', '关键字段覆盖率', '示例可执行率', '术语冲突数', '文章过期率'],
    ['标题漂亮但没有边界', '示例缺少环境前提', '表格与正文互相矛盾', '翻译遗漏条件', '长文没有可跳转结构'],
  ),
  makeDomain(
    'sqlite-data',
    'SQLite 与本地数据',
    '用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。',
    [
      'schema|Schema 设计|为实体、状态、时间和来源建立可演进的本地数据模型',
      'fts5|SQLite FTS5|用全文索引减少重复扫描，并保留可解释的匹配字段',
      'transaction|事务边界|让写入、索引更新和状态变化在一个一致性边界内完成',
      'migration|迁移脚本|在本地数据库迭代时兼顾旧数据、回滚和开发环境重建',
      'backup|备份恢复|验证 WAL、快照、导出和恢复后的数据完整性',
      'query-plan|查询计划|从 EXPLAIN、索引选择和扫描行数定位慢查询',
      'pagination|分页与排序|稳定地返回大列表，避免 offset 抖动和重复数据',
      'cache|查询缓存|对稳定读取复用结果，但在数据变更时准确失效',
      'consistency|一致性|区分数据库事实、派生统计和模型生成解释',
      'fixtures|测试夹具|用确定性样本覆盖边界状态、空集、异常和时间窗口',
    ],
    ['事实表和派生表', '读取性能和写入一致性', '迁移安全和恢复能力', '查询结果和证据引用', '测试数据的可重复性'],
    ['schema migration', 'FTS5 index', 'query plan snapshot', 'backup manifest', 'fixture dataset'],
    ['查询 p50/p95', '扫描行数', '事务提交耗时', '备份恢复成功率', '缓存命中率'],
    ['没有稳定排序导致重复', '索引与数据没有同步', '迁移只在空库可用', '缓存返回过期事实', '测试夹具掩盖真实空值'],
  ),
  makeDomain(
    'web-streaming',
    'Web 流式交互',
    '把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。',
    [
      'sse|SSE 通道|定义 start、thinking、text、tool、done 和 error 的可消费事件',
      'envelope|事件信封|让每个事件都带 session、turn、序号和时间，便于重建过程',
      'reconnect|断线重连|区分可恢复的连接断开、已完成 turn 和不可重放的流',
      'backpressure|背压|防止快速模型事件淹没浏览器渲染和网络缓冲',
      'cancel|取消|将用户停止、浏览器离开和 API 中止传递到 Agent session',
      'inspector|Inspector|把 thinking、工具输入输出和错误以可读方式呈现',
      'typing|输入状态|在回答生成、工具执行和等待重试之间给出准确状态',
      'errors|错误事件|保留可诊断错误，同时避免把内部凭据和堆栈泄露给浏览器',
      'security|浏览器安全|保持 key、内部路径和宿主能力只在服务端可见',
      'accessibility|可访问性|让流式文本、状态和事件在键盘与屏幕阅读器中可理解',
    ],
    ['事件顺序和幂等', '浏览器渲染和网络缓冲', '取消与资源回收', '诊断细节和安全脱敏', '视觉反馈和可访问性'],
    ['SSE event envelope', 'turn sequence', 'reconnect cursor', 'inspector timeline', 'redaction policy'],
    ['首事件耗时', '首文本 delta 耗时', '事件丢失率', '断开资源回收率', '浏览器渲染帧耗时'],
    ['done 先于最后文本', '重连重复渲染', '工具输出没有截断', '错误泄露内部路径', 'thinking 与答案混在一起'],
  ),
  makeDomain(
    'typescript-engineering',
    'TypeScript 工程实践',
    '用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。',
    [
      'strict|Strict 模式|让 null、unknown、联合类型和异步返回值在编译期暴露问题',
      'contracts|共享契约|用 DTO、schema 和事件联合类型连接 API、Agent 与前端',
      'validation|输入校验|在边界验证请求和工具参数，内部逻辑使用已收窄类型',
      'modules|模块边界|通过 package exports 和依赖方向避免 Web 直接依赖运行时细节',
      'async|异步控制|管理 Promise、取消、超时和事件订阅的生命周期',
      'errors|错误建模|区分用户错误、能力错误、上游错误和不可恢复故障',
      'testing|测试策略|用单元、契约、集成和流式快照覆盖系统的不同风险',
      'config|配置管理|将环境变量解析成一次性的不可变配置，并在启动时失败',
      'build|构建输出|保持 ESM、类型声明、source map 和 workspace 构建顺序一致',
      'dependencies|依赖治理|控制第三方包的版本、边界、许可证和升级节奏',
    ],
    ['类型安全和运行时验证', '模块依赖和公开 API', '异步资源和取消', '错误分类和观测', '构建产物和环境差异'],
    ['TypeScript interface', 'TypeBox schema', 'error envelope', 'test fixture', 'build artifact'],
    ['编译错误数量', '契约测试通过率', '未处理 Promise 数', '构建耗时', '依赖升级回归数'],
    ['类型断言掩盖未知值', 'schema 与类型定义漂移', '订阅没有 unsubscribe', '错误被 catch 后丢失', '开发和生产 module resolution 不同'],
  ),
  makeDomain(
    'monorepo',
    'Monorepo 协作',
    '通过 pnpm workspace、任务编排和清晰的包边界，让 Agent 平台的 Web、API、契约、领域与运行时可以独立演进。',
    [
      'workspace|Workspace 依赖|用 workspace protocol 连接包，并明确源码与构建产物边界',
      'pnpm|pnpm 管理|保持 lockfile、脚本和 node_modules 链接行为可重复',
      'turbo|任务编排|用依赖图调度 build、typecheck、test 和 lint，并理解缓存命中',
      'boundary|包边界|禁止 Web 越过 contracts 直接读取 API 或 Pi 实现',
      'package-api|包公开 API|用 exports、类型声明和文档控制可消费表面',
      'cache|任务缓存|区分真实缓存命中和旧构建产物，避免用缓存掩盖问题',
      'ci|持续集成|在干净环境安装、构建、测试和检查，复现本地验证路径',
      'release|发布版本|协调包版本、变更说明和可回滚的部署产物',
      'ownership|责任边界|让目录、包和关键契约都有维护人和变更规则',
      'docs|文档协作|将架构决策、运行手册和实验报告放在靠近代码的位置',
    ],
    ['依赖图和任务图', '源码、产物和缓存', '包的消费边界', '本地和 CI 一致性', '变更责任和发布顺序'],
    ['workspace manifest', 'turbo pipeline', 'package exports', 'CI verification log', 'release checklist'],
    ['缓存命中率', '干净构建耗时', '跨包契约失败数', 'CI 失败恢复时间', '未拥有目录数量'],
    ['直接引用内部源码', '缓存掩盖未构建代码', 'lockfile 漂移', '循环依赖逐渐形成', '文档更新不随代码发布'],
  ),
  makeDomain(
    'evaluation',
    'Agent 评测与基准',
    '把知识问答拆成数据集、检索质量、答案 groundedness、流式延迟和并发稳定性，形成可重复的离线与在线评测。',
    [
      'golden-set|黄金问题集|覆盖事实查询、组合问题、无答案问题和边界问题',
      'recall|召回率|衡量正确证据是否出现在 Top-K 候选中',
      'precision|精确率|衡量返回的候选是否真正与问题相关，避免噪声上下文',
      'mrr|MRR 排名|关注第一个正确结果的位置，适合单事实问答',
      'ndcg|NDCG|按相关性等级评价多个候选的排序质量',
      'grounding|答案依据|检查答案结论是否由检索证据支持，而非模型常识补写',
      'latency|延迟预算|分别测量加载、检索、工具回合、首 token 和最终完成',
      'load|负载测试|用并发请求观察 CPU、内存、文件读取和尾延迟',
      'regression|回归检测|知识、提示、模型或排序变化后自动比较历史结果',
      'human|人工复核|为难例建立标注准则和抽样审核，而不是只看自动分数',
    ],
    ['离线相关性和在线体验', '正确证据和自然语言答案', '平均值和长尾', '自动指标和人工判断', '基准可重复和成本可控'],
    ['golden query set', 'retrieval judgment', 'latency trace', 'answer rubric', 'regression report'],
    ['Recall@5', 'Groundedness', '首 token p50/p95', '完整回答 p95', '并发错误率'],
    ['黄金集只覆盖热门问题', '把语言流畅当成正确', '只报告平均延迟', '测试数据没有版本', '人工标注标准随人变化'],
  ),
  makeDomain(
    'security',
    'Agent 安全与权限',
    '把 prompt、工具、文件、模型输出和凭据都视为不可信输入，在宿主权限、审计和数据生命周期层建立真实安全边界。',
    [
      'trust|项目信任|区分资源加载信任、用户身份和操作权限，不把它们混为一谈',
      'injection|提示注入|识别来自文档、网页和用户文本的越权指令',
      'tool-auth|工具授权|在工具执行前验证调用者、参数、资源和操作级权限',
      'secrets|秘密管理|让 API key、数据库凭据和内部路径只存在于必要进程',
      'pii|个人信息|识别、最小化、脱敏和审计回答中可能出现的敏感数据',
      'sandbox|沙箱隔离|理解工具 allowlist 不是 OS 沙箱，必要时使用容器或 VM',
      'audit|审计记录|保留谁在何时调用了什么工具、得到什么结果和采取什么动作',
      'threat|威胁建模|从资产、入口、信任边界和攻击路径分析 Agent 系统',
      'retention|数据留存|为会话、日志、检索片段和备份定义保存与删除策略',
      'incident|事件响应|准备密钥泄露、越权工具、数据外泄和模型异常的处置流程',
    ],
    ['模型建议和真实授权', '内容可信度和执行权限', '用户数据和日志留存', '诊断能力和秘密脱敏', '方便调试和隔离边界'],
    ['threat model', 'capability policy', 'redaction rule', 'audit event', 'incident runbook'],
    ['越权调用拦截率', '敏感字段脱敏率', '审计事件完整率', '密钥轮换耗时', '事件发现时间'],
    ['把 AGENTS 当权限授予', '文档注入工具参数', '日志泄露 API key', '只读工具仍能间接写入', 'trust 被误解为 sandbox'],
  ),
  makeDomain(
    'operations',
    '运行与可观测性',
    '让 Agent 服务在启动、调用、流式输出、错误和容量变化时都可诊断，形成从日志到指标、追踪和运行手册的闭环。',
    [
      'logging|结构化日志|记录 request、session、turn 和 tool 维度，避免只打印自然语言',
      'metrics|运行指标|用计数器、直方图和 gauges 描述流量、延迟、错误和资源',
      'tracing|分布式追踪|连接浏览器请求、API、检索、模型和工具执行的时间线',
      'health|健康检查|区分进程存活、依赖可用、模型配置和知识索引状态',
      'deployment|部署策略|保证环境变量、构建产物、知识快照和回滚版本匹配',
      'environment|环境隔离|明确开发、测试和生产的数据、密钥与日志差异',
      'flags|功能开关|渐进发布模型、检索器、thinking 和实验性工具',
      'alerts|告警|为长尾延迟、错误突增、召回下降和资源泄露设置可行动阈值',
      'runbook|运行手册|让值班人员能够按照证据而不是猜测恢复服务',
      'capacity|容量规划|估算文件数、正文大小、并发、内存和模型成本的增长曲线',
    ],
    ['可观测性字段和隐私', '故障检测和用户体验', '部署一致性和回滚', '指标阈值和行动', '容量趋势和成本'],
    ['request log schema', 'metrics dashboard', 'trace span map', 'health contract', 'incident runbook'],
    ['请求成功率', '工具错误率', '模型首 token p95', '内存峰值', '知识加载耗时'],
    ['日志没有 session 关联', '健康检查只看端口', '告警不可行动', '回滚漏掉知识快照', '容量增长没有基线'],
  ),
  makeDomain(
    'product-knowledge',
    '产品知识场景',
    '将产品规则、用户流程、账号权限、集成和故障排查写成 Agent 可以检索并引用的长文知识，而不是只放一份 FAQ。',
    [
      'overview|产品总览|解释产品对象、价值、边界、角色和主要流程',
      'faq|常见问题|覆盖真实用户表达、必要条件、答案和不适用情况',
      'onboarding|新手引导|把从注册到第一次成功完成任务的路径拆成可验证步骤',
      'account|账号管理|描述身份、登录、资料、生命周期和恢复路径',
      'billing|计费规则|说明套餐、额度、周期、发票、退款和异常扣费处理',
      'permissions|权限模型|解释角色、资源范围、审批和被拒绝时的诊断方法',
      'integration|集成连接|覆盖 API、Webhook、OAuth、同步方向和失败重试',
      'troubleshooting|故障排查|按现象、证据、原因、恢复和升级路径组织内容',
      'roadmap|路线图|区分已发布、实验中、计划中和明确不会支持的能力',
      'terms|产品术语|统一界面名称、内部名称、旧名称和用户口语的映射',
    ],
    ['用户目标和产品边界', '前置条件和成功标准', '规则解释和例外', '界面动作和后台事实', '当前版本和未来计划'],
    ['product concept', 'user journey', 'permission matrix', 'troubleshooting tree', 'release note'],
    ['一次解决率', '引导完成率', '答案引用率', '故障升级率', '术语命中率'],
    ['把路线图说成已发布', '忽略版本和地区差异', '权限拒绝没有下一步', '退款规则缺少例外', '用户口语无法命中术语'],
  ),
  makeDomain(
    'engineering-process',
    '工程协作流程',
    '把需求、ADR、API 设计、代码评审、测试、发布和事故复盘变成可以被搜索、引用与持续更新的工程知识。',
    [
      'requirements|需求分析|把用户目标、约束、非目标和验收证据写清楚',
      'adr|架构决策|记录背景、候选方案、决策、取舍和未来复审条件',
      'api|API 设计|定义输入输出、错误、幂等、版本和兼容策略',
      'review|代码评审|从正确性、安全、可维护性、测试和回滚角度提出可行动意见',
      'tdd|测试驱动|先表达行为和失败案例，再用最小实现通过并持续重构',
      'release|发布检查|确认代码、配置、知识、迁移、监控和回滚全部可验证',
      'incident|事故复盘|还原时间线、影响、检测缺口、根因和可追踪行动',
      'change|变更管理|评估风险、依赖、灰度、通知、验证和撤回条件',
      'documentation|文档维护|让文档拥有者、更新时间和代码验证入口清晰可见',
      'onboarding|工程入职|让新成员通过一条安全、可运行、可验证的路径理解系统',
    ],
    ['决策背景和可逆性', '行为验收和证据', '变更风险和回滚', '团队知识和个人记忆', '文档与实现同步'],
    ['requirements brief', 'ADR record', 'API contract', 'review checklist', 'release evidence'],
    ['需求验收通过率', '评审缺陷逃逸率', '变更回滚率', '事故行动关闭率', '新成员首个成功任务耗时'],
    ['ADR 只有结论没有背景', '测试验证了实现没有验证行为', '发布清单只勾选不留证据', '复盘变成人员追责', '文档没人负责更新'],
  ),
  makeDomain(
    'application-patterns',
    'Agent 应用模式',
    '用不同应用场景验证同一套 Agent 核心：入口保持简单，能力通过工具注入，知识和结构化数据分别提供证据。',
    [
      'internal|内部助手|在组织内部用权限范围内的文件和数据回答日常问题',
      'docs|文档助手|围绕版本化文档、示例和变更记录生成有引用的解释',
      'support|支持 Agent|根据知识和工单上下文诊断问题并决定是否升级人工',
      'analytics|分析 Agent|组合指标查询、维度筛选、时间窗口和结果解释',
      'data|数据 Agent|安全地把自然语言问题转换成受限的只读数据查询',
      'ops|运维 Agent|读取日志、指标和运行手册，给出可验证的排障路径',
      'research|研究 Agent|整理多份来源、比较观点、标记不确定性和引用出处',
      'coding|代码 Agent|读取仓库结构、规范和测试结果，提出最小变更建议',
      'compliance|合规 Agent|用政策、控制项和证据记录检查流程是否满足要求',
      'workflow|工作流 Agent|将复杂任务拆成可审批、可重试和可审计的步骤',
    ],
    ['场景目标和风险级别', '知识证据和结构化事实', '只读查询和可执行动作', '自动化收益和人工接管', '可审计和可回放'],
    ['scenario contract', 'tool capability map', 'evidence bundle', 'approval checkpoint', 'outcome record'],
    ['任务完成率', '证据覆盖率', '人工接管率', '错误动作拦截率', '流程回放成功率'],
    ['场景边界没有写清', '工具权限随场景膨胀', '摘要掩盖原始证据', '审批点放在不可逆动作之后', '失败无法从记录中重放'],
  ),
];

const variants = [
  {
    id: 'architecture',
    label: '架构视角',
    audience: '负责边界和长期演进的设计者',
    instruction: '先建立概念、责任边界和可替换接口，再决定具体实现。',
    questionStyle: '如果未来替换模型、索引或 Web 传输，哪些事实必须保持不变？',
  },
  {
    id: 'implementation',
    label: '实现视角',
    audience: '需要把方案落成 TypeScript 代码的开发者',
    instruction: '优先写出输入、输出、错误、生命周期和验证步骤，再开始编码。',
    questionStyle: '在本地仓库中如何用最小可运行样例证明这条链路真的工作？',
  },
  {
    id: 'operations',
    label: '验证与运维视角',
    audience: '需要观察性能、稳定性和故障恢复的工程师',
    instruction: '把成功、失败、延迟、容量和恢复证据都记录下来，避免只看一次成功请求。',
    questionStyle: '在压力、断连、旧数据或依赖失败时，系统应留下什么可诊断证据？',
  },
];

const legacy = [
  { path: 'agent/answer-contract.md', title: 'Agent 回答契约', description: '一个可验证的 Agent 回答包含文本、实际工具决策、来源和运行状态。', topic: { id: 'answer-contract', title: '回答契约', focus: '文本、工具决策、来源和运行状态如何组成可验证的最终回答' }, domain: domains.find((item) => item.id === 'agent-design') },
  { path: 'agent/local-fallback.md', title: '本地降级模式', description: '没有模型凭据时，用本地 consumer 和规则回答验证 Agent 外壳。', topic: { id: 'local-fallback', title: '本地降级', focus: '没有模型、工具失败或证据不足时如何保持诚实且可测试的回答' }, domain: domains.find((item) => item.id === 'agent-design') },
  { path: 'agent/resource-loading.md', title: '项目资源加载', description: 'Pi 官方资源发现与项目 Markdown 知识工具之间的边界。', topic: { id: 'resource-loading', title: '项目资源加载', focus: 'Pi 官方资源发现规则与项目自定义 Markdown 知识 bundle 的边界' }, domain: domains.find((item) => item.id === 'pi-runtime') },
  { path: 'agent/session-lifecycle.md', title: 'Pi Session 生命周期', description: 'Agent session 从创建、加载资源、提交 turn 到结束的基本流程。', topic: { id: 'session-lifecycle', title: 'Session 生命周期', focus: '从创建、资源加载、提交 turn、接收事件到关闭的状态变化' }, domain: domains.find((item) => item.id === 'pi-runtime') },
  { path: 'agent/tool-policy.md', title: '工具权限边界', description: '只读工具、能力注入和模型决策之间的安全边界。', topic: { id: 'tool-policy', title: '工具权限边界', focus: '只读工具、能力注入和模型决策之间的安全边界' }, domain: domains.find((item) => item.id === 'security') },
];

const pick = (values, seed, offset = 0) => values[(seed + offset) % values.length];
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const nonWhitespaceLength = (value) => Array.from(value).filter((char) => !/\s/u.test(char)).length;

function renderArticle({ domain, topic, variant, resource, serial, legacyPath = false }) {
  const seed = serial * 17 + topic.id.length;
  const tagList = [...new Set(['Pi', 'Agent', '知识库', domain.id, topic.id, variant.id, ...domain.title.split(' ')])];
  const axis = (offset) => pick(domain.axes, seed, offset);
  const artifact = (offset) => pick(domain.artifacts, seed, offset);
  const metric = (offset) => pick(domain.metrics, seed, offset);
  const risk = (offset) => pick(domain.risks, seed, offset);
  const related = domain.topics.filter((item) => item.id !== topic.id).slice(0, 3);
  const title = legacyPath ? topic.title : `${topic.title}：${variant.label}`;
  const description = legacyPath ? `${domain.summary}${topic.focus}。` : `${domain.summary}${topic.focus}，本文从${variant.label}展开。`;
  const resourcePath = `.pi/knowledge/${resource}`;
  const scenarioCode = `scenario: ${slug(domain.id)}-${slug(topic.id)}-${variant.id}\nquestion: "${variant.questionStyle}"\nevidence:\n  source: "${resourcePath}"\n  status: active\n  required_fields:\n    - ${artifact(0)}\n    - ${artifact(1)}\nverification:\n  metric: ${metric(0)}\n  owner: knowledge-benchmark`;

  const coreItems = Array.from({ length: 7 }, (_, index) => {
    const itemAxis = axis(index);
    const itemArtifact = artifact(index);
    return `${index + 1}. **${itemAxis}**：围绕“${topic.focus}”定义一个可检查的边界。落地时要产生 \`${itemArtifact}\`，并说明它来自哪一层事实、由谁维护、在什么条件下失效。`;
  }).join('\n');

  const decisionItems = Array.from({ length: 6 }, (_, index) => {
    const itemAxis = axis(index + 2);
    const itemMetric = metric(index + 1);
    return `### 决策 ${index + 1}：把${itemAxis}变成可验证选择\n不能只写“支持”或“性能好”。应该先写出适用范围，再列出一个反例和一个退出条件；例如在${variant.audience}看来，${itemAxis}必须能被 ${itemMetric} 观察到，超过预算时要回到上一级方案重新判断。`;
  }).join('\n\n');

  const implementationSteps = [
    ['识别问题', '把用户问题改写成一个可以被证据回答的任务，但不要改变原始意图。'],
    ['确认范围', `确认本篇内容只覆盖“${topic.title}”，并把相邻主题 ${related.map((item) => item.title).join('、')} 作为可能的后续引用。`],
    ['准备事实', `加载或查询 ${artifact(0)}，检查状态、版本、更新时间和必要的权限条件。`],
    ['执行主流程', `按照 ${axis(1)} 的顺序执行，不把模型猜测、用户输入和工具返回混在同一个不可审计的字符串中。`],
    ['记录事件', `在关键节点记录 ${artifact(2)}，至少能还原开始、成功、失败、重试和取消五种状态。`],
    ['处理异常', `遇到 ${risk(0)} 时先停止扩大影响，返回已知证据、缺失信息和下一步，而不是为了完整而补写未知事实。`],
    ['验证结果', `用 ${metric(2)} 和一条人工可读的检查结论确认结果，必要时让另一个人复核边界案例。`],
    ['发布维护', `将文章、索引、测试样例和变更记录一起发布，下一次 ${axis(4)} 变化时重新运行本篇的验证。`],
  ].map(([name, detail], index) => `${index + 1}. **${name}**：${detail}`).join('\n');

  const qualityItems = Array.from({ length: 6 }, (_, index) => {
    const itemMetric = metric(index);
    const itemRisk = risk(index + 1);
    return `- **${itemMetric}**：先建立当前基线，再观察 ${variant.label} 变更后的差异。若出现“${itemRisk}”，应把这次结果标为不可比较，补齐输入、版本或环境信息后再测。`;
  }).join('\n');

  const failureItems = Array.from({ length: 6 }, (_, index) => {
    const itemRisk = risk(index);
    const itemArtifact = artifact(index + 3);
    return `### 失败模式 ${index + 1}：${itemRisk}\n常见原因不是单一代码错误，而是边界没有落到 ${itemArtifact}。排查时先保留原始请求和实际事件，再确认哪一个条件未满足；如果无法确认，就输出未知并进入人工或下一步诊断。`;
  }).join('\n\n');

  const questions = [
    `用户问“${topic.title}最重要的边界是什么？”时，答案是否同时引用了 \`${artifact(0)}\` 和 \`${artifact(1)}\`？`,
    `用户把“${topic.focus}”与 ${related[0]?.title ?? '相邻主题'} 混在一起时，Agent 能否先澄清范围？`,
    `当 ${risk(0)} 发生时，回答是否明确区分已知事实、推论和未知？`,
    `如果把 ${metric(0)} 提高一倍，系统是否会改变上下文、成本或安全预算？`,
    `一次成功调用能否从 ${artifact(2)} 还原，而不是只剩最终自然语言？`,
    `这篇文章中的例子是否给出了输入、处理、输出和验证证据，而不是只有概念描述？`,
    `内容更新后，旧的引用、链接和索引是否仍能解析到同一个稳定主题？`,
    `${variant.questionStyle}`,
  ].map((question, index) => `${index + 1}. ${question}\n   预期：回答应回到本文证据，并在缺少条件时明确说明不能直接下结论。`).join('\n');

  return `---
type: concept
title: ${title}
description: ${description}
resource: ${resourcePath}
tags: [${tagList.join(', ')}]
status: active
verified: true
updated: ${updated}
domain: ${domain.id}
topic: ${topic.id}
variant: ${variant.id}
---

# ${title}

## 摘要

本文服务于${variant.audience}。它讨论的不是一个孤立的 API，而是“${topic.focus}”在一个可观察 Agent 系统中的完整边界：什么由用户提供，什么由模型判断，什么必须由程序验证，什么只能作为未知返回。文章采用文件优先的知识方式，所有结论都应该能够回到本文件的结构、示例、指标和验证问题；如果读者需要更细的实现细节，应沿着文末的相关知识继续阅读，而不是把本篇当成没有版本的永久真理。

本篇的使用方式是先读摘要和问题边界，再根据任务跳到核心模型、实施流程或失败模式。对于线上问答，检索器可以使用标题、标签和正文召回本篇，Agent 仍然需要判断返回内容是否真的回答了用户问题。对于性能测试，本篇的长度、段落结构、重复术语和交叉链接会模拟真实知识库中的长文差异，便于比较文件扫描、索引和模型上下文的成本。

## 问题边界

“${topic.title}”属于“${domain.title}”这个主题域。主题域的目标是${domain.summary}本篇聚焦“${topic.focus}”，不负责替代相邻主题的完整规范，也不把一个示例提升为所有项目都必须采用的规则。${variant.instruction}

需要特别区分三类信息。第一类是可直接检查的事实，例如文件路径、字段、事件、数据库记录或测试输出；第二类是结合事实得出的推论，例如某个延迟可能来自多次工具往返；第三类是还缺少证据的未知，例如模型是否在另一种 provider 上产生同样的 thinking 事件。问答时如果三类信息混在一起，文章即使很长也会制造错误确定性。

这篇文章还把${axis(0)}作为第一层边界，把${axis(1)}作为第二层边界。前者回答“系统允许观察或操作什么”，后者回答“发生变化时谁负责验证”。只有当两层边界都写清楚，${topic.title}才适合进入 Agent 的检索上下文；否则它更像一段容易被误读的意见。

## 核心模型

${coreItems}

以上模型可以压缩成一条可追踪链路：问题进入后先确定范围，再取得事实，之后由 Agent 或应用选择下一步，最后生成带证据的回答。任何一步缺失，都应该在事件或回答中留下缺口，而不是用一句“系统已处理”掩盖。对于${variant.label}，最值得保留的是“问题—证据—决策—结果—验证”这五个连接点。

## 设计决策

${decisionItems}

这些决策的共同原则是可替换。知识源可以从 Markdown 换成 SQLite FTS5 或其他索引，Web 可以从 SSE 换成别的传输，模型也可以更换 provider，但 ${artifact(0)}、${artifact(1)} 和 ${artifact(2)} 中记录的事实不能随着技术替换而消失。这样做的价值不是提前猜中未来，而是给未来留下一个可以比较的基线。

## 实施流程

${implementationSteps}

在实现时不要把所有步骤塞进一个超长函数。可以让边界模块负责解析和验证，让检索或数据模块负责返回证据，让 Agent 适配层负责 session 与事件，让 API 层负责身份、流式传输和取消。这样每个模块都能用独立夹具测试，发生失败时也能知道是事实缺失、能力错误、模型行为还是传输问题。

## 可运行示例

下面的配置不是生产权限声明，而是一个用于验证本主题的最小场景描述。它把主题、证据、指标和负责人放在一起，便于测试脚本或 Agent 在回答后检查是否遗漏关键信息。

\`\`\`yaml
${scenarioCode}
\`\`\`

在这个场景中，输入应当包含一个明确问题和必要范围；处理过程应当能找到至少一个真实文件或数据证据；输出应当带有来源、状态和验证指标。如果只返回一段看似流畅的文字，却不能解释为什么选择这个证据，测试应该判定为“语言完成但证据不完整”。反过来，如果证据不足，合格的回答可以短一些，但必须明确告诉用户缺了什么。

## 性能与质量验证

${qualityItems}

性能不能只看单次命令的平均耗时。文件数增加后，目录遍历、打开文件、解析 frontmatter、正文扫描和结果序列化可能分别成为瓶颈；模型调用则还会叠加 thinking、工具往返、上下文长度和生成时间。建议至少记录冷启动、热缓存、空结果、单命中、多命中、长文和并发六种条件，并把本篇的资源路径、文章长度、检索 query 和版本写进基准报告。

质量也不能只看命中数量。真正有用的结果需要同时满足相关性、覆盖关键条件、状态有效、引用可打开和不会把文档里的普通文本当成执行指令。对于“${topic.title}”，如果 Top-K 中有很多相邻主题但没有本篇，应该检查标题与标签权重；如果召回本篇却答错，应该检查片段切分、证据阅读和最终回答的 groundedness。

## 失败模式与恢复

${failureItems}

恢复流程必须留下可复盘记录：原始问题、检索 query、候选来源、实际读取的文件、工具事件、模型配置、最终答案和人工修正。只有这样，下一次改写文章或索引时才能判断是知识缺口、召回缺口、模型解释错误还是前端展示遗漏。恢复不是把所有错误都重试一次；当输入没有权限或知识确实不存在时，重试只会增加延迟和误导。

## 问答测试样例

${questions}

执行这些问题时，测试记录应保存 query、Top-K 文件、首个相关结果的排名、返回字符数、耗时和最终答案是否引用实际来源。对于没有答案的问题，还应加入一条负向期望：Agent 不得从相似文章拼接出不存在的事实。这样，长文档不仅是模型上下文，也是可量化的测试夹具。

## 维护与变更

文章发布后，至少要维护标题、资源路径、状态、更新时间、标签和相关链接。事实变化时先更新正文，再更新验证问题与示例中的指标；如果只有措辞变化，也应在变更记录中说明是否影响检索词和答案依据。建议通过自动校验检查每篇文章的 frontmatter、最小长度、重复标题和悬空链接，并在基准测试中保留本次数据集的文件数与总字符数。

${variant.label}最容易忽略的是维护成本。长文不是越长越好，新增内容必须带来新的边界、例外、证据或验证价值；如果一段文字不能帮助读者做决策、定位故障或判断答案，它就应该被删除或移动到更合适的主题。保持这种纪律，才能让四五百篇知识真正提高问答覆盖，而不是只增加扫描和上下文负担。

## 相关知识

${related.map((item) => `- [${item.title}](/.pi/knowledge/${domain.id}/${item.id}-architecture.md)：从同一主题域的相邻角度补充“${item.focus}”。`).join('\n')}

## 结论

围绕“${topic.title}”的可靠回答，最终要回到三个问题：证据在哪里，决策由谁做，结果如何验证。本文提供的是一份可检索、可引用、可压测的长文样本；真实系统仍应以当前代码、版本化知识源和运行时观测结果为准。任何无法由这些证据支持的结论，都应该被标为推论或未知，而不是因为文章篇幅足够长就获得额外的可信度。
`;
}

function writeDocument(path, content) {
  const absolutePath = join(knowledgeRoot, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

if (process.env.KNOWLEDGE_GENERATOR_LIBRARY_ONLY !== '1') {
  rmSync(generatedRoot, { recursive: true, force: true });
  mkdirSync(generatedRoot, { recursive: true });

  let serial = 0;
  for (const domain of domains) {
    const domainRoot = join('library', domain.id);
    const links = [];
    for (const topic of domain.topics) {
      for (const variant of variants) {
        serial += 1;
        const path = join(domainRoot, `${topic.id}-${variant.id}.md`);
        writeDocument(path, renderArticle({ domain, topic, variant, resource: path, serial }));
        links.push(`- [${topic.title}：${variant.label}](./${topic.id}-${variant.id}.md)`);
      }
    }
    writeDocument(`${domainRoot}/index.md`, `# ${domain.title}\n\n${domain.summary}\n\n本主题域包含 ${domain.topics.length * variants.length} 篇长文，分别从架构、实现、验证与运维视角描述同一组概念。\n\n${links.join('\n')}\n`);
  }

  for (const item of legacy) {
    serial += 1;
    const variant = { id: 'canonical', label: '项目基线', audience: '维护 Pi Workbench 项目知识的工程师', instruction: '优先与当前项目代码和官方 Pi 文档交叉验证。', questionStyle: '这条项目约束是否能从当前代码、事件或官方文档中复核？' };
    writeDocument(item.path, renderArticle({ domain: item.domain, topic: item.topic, variant, resource: item.path, serial, legacyPath: true }));
  }

  const domainLinks = domains.map((domain) => `- [${domain.title}](./library/${domain.id}/index.md)：${domain.summary}`).join('\n');
  writeDocument('index.md', `# Pi Workbench 知识库索引\n\n本 bundle 由 OKF-compatible Markdown 组成。每个 concept 文件都包含完整 frontmatter 和长篇正文，供本地 consumer、索引器和 Agent 评测使用。\n\n- 长文测试文档：${domains.length * 10 * variants.length} 篇\n- 项目基线文档：${legacy.length} 篇\n- 文章最低正文长度：2000 个非空白字符\n- 生成脚本：\`scripts/knowledge/generate.mjs\`\n- 校验脚本：\`scripts/knowledge/validate.mjs\`\n- 基准脚本：\`scripts/knowledge/benchmark.mjs\`\n\n## 主题域\n\n${domainLinks}\n`);

  const generatedCount = domains.length * 10 * variants.length;
  console.log(JSON.stringify({ generatedCount, legacyCount: legacy.length, totalConcepts: generatedCount + legacy.length, root: relative(projectRoot, knowledgeRoot) }, null, 2));
}

export { domains, variants, legacy, renderArticle, writeDocument };
