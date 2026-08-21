# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

团队内部成员。在本地开发环境中使用的多智能体聊天工作台：选择 Agent、发起会话、流式对话、查看用量与管理提示词/技能。local 模式，无鉴权。

## Product Purpose

**核心目标是复刻 Fleet**：以 `docs/research/fleet-cdp-reference-2026-08-21.md` 的 CDP 实测为蓝本，把 Fleet（LangSmith 工作台）的功能与视觉端到端搬进本项目，底层运行时由 Pi Coding Agent 承载。Fleet 有什么，我们就有什么——凡是 Fleet 页面存在的布局、组件、交互，默认都应在本项目中出现，除非它依赖 Fleet 云端语义（付费墙、真实集成连接、Schedules 等）而无本地对应。成功 = 并排打开两个产品，功能结构与视觉表现难以区分。

## Positioning

Fleet 复刻品 × Pi Coding Agent 运行时。差异化不在"重新设计"，而在"同一套 Fleet 体验运行在本地 Pi 运行时之上"：会话 JSONL 持久化、Agent 以 Markdown 定义、项目技能/提示词资源、ModelRuntime 目录热切换。

## Operating Context

- 本地 monorepo，`pnpm dev` 起 Web + API（portless 域名 `pi-workbench.localhost` / `api.pi-workbench.localhost`）。
- 用户在侧边栏切换 Agent 与会话，在主区流式对话；通过模板页创建新 Agent（写 `.pi/agents/*.md`）。
- 通过 CDP 实测 Fleet/LangSmith 页面获取设计与功能参照，截图与 JSON 存于 `.scratch/`（不入库）。

## Capabilities and Constraints

长期约束（用户确认，未来设计与开发不得违背）：

1. **视觉权威**：`docs/research/fleet-cdp-reference-2026-08-21.md` 的 Fleet CDP 实测令牌是绑定性视觉规范。
2. **Agent 能力边界**：Agent 纯聊天、无工具、不写文件；唯一例外是模板页用户主动创建 Agent 定义文件。绝不让 Agent 文件声明或扩展工具。
3. **运行边界**：仅本地运行，local 模式无鉴权；Provider 密钥只留在 API 进程，浏览器只消费 SSE 契约。
4. **Pi 集成契约**：Web 不直接 import Pi SDK；会话经 `createAgentSession()` + `SessionManager` JSONL 持久化；每个会话绑定不可变 `agentId`；逐轮模型选择走 `model` 字段 + `session.setModel()` 热切换。
5. 不做向后兼容设计，不新增非必要依赖；动效统一用已安装的 `motion`。

功能清单：会话/收件箱、Agent 探索与模板创建、技能浏览、用量统计、设置（界面偏好）、聊天（流式、thinking、重试、模型选择、"/" 提示词）、配置面板（按 Agent 的 Thinking 开关）。

## Brand Commitments

- 视觉语言严格复刻 Fleet（LangSmith 工作台），以其 CDP 实测值为准，不自由发挥配色与密度。
- 产品文案中文界面为主（与现有实现一致）。

## Evidence on Hand

- `docs/research/fleet-cdp-reference-2026-08-21.md`：Fleet 设计令牌与页面结构的 CDP 实测记录（权威）。
- `.scratch/fleet-cdp/`：CDP 抓取的原始 JSON 与截图（未提交，仅作参考）。
- 无真实用户评价/数据；不得虚构 testimonial、benchmark 或配额数字。

## Product Principles

1. **Fleet 是唯一蓝本**：功能与视觉默认向 Fleet 看齐；新增页面先查 CDP 实测文档，没有实测值的宁缺毋滥。
2. 运行时归 Pi，界面归工作台——API 不做语义预路由，语义决策都在 Pi 侧。
3. 信息密度服务于操作效率：这是工具（Operate），不是展示页。
4. 本地优先、密钥不出 API 进程；一切外部输入按不可信处理。
5. 简单压倒灵活：不造兼容层，不加投机性配置。
