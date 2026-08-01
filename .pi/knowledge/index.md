---
type: index
title: Pi Workbench Knowledge
description: Pi Agent 验证工作台的文件优先知识 bundle。
resource: .pi/knowledge/index.md
status: active
verified: true
updated: 2026-08-01
---

# Pi Workbench Knowledge

本 bundle 由 OKF-compatible Markdown 组成。每个 concept 文件都包含可审阅的 frontmatter 和长篇正文，供本地检索器、Pi Agent 和评测脚本使用。

- 长文测试文档：450 篇
- 项目基线文档：5 篇
- 总 concept 文档：455 篇
- 文章最低正文长度：2000 个非空白字符
- 生成方式：Luna low 配置下的本地子进程模板生成（保留已有 Kimi 文档）
- 校验脚本：`scripts/knowledge/validate.mjs`
- 基准脚本：`scripts/knowledge/benchmark.mjs`

## 主题域

- [Pi Agent 运行时](./library/pi-runtime/index.md)：围绕 Pi Coding Agent 的 session、模型、工具和事件循环，说明如何把一个可嵌入的 Agent 变成可观察、可测试的服务能力。
- [Agent 设计范式](./library/agent-design/index.md)：把 Agent 看成由模型决策、能力边界、证据回传和人机协作组成的系统，而不是一个隐藏在路由层后的字符串函数。
- [RAG 与检索](./library/rag-retrieval/index.md)：从知识源整理、分块、索引、召回、排序到引用回答，建立一条可以测量召回质量与延迟的本地检索链路。
- [OKF 知识治理](./library/okf-governance/index.md)：用 Markdown 与 YAML frontmatter 作为可审阅知识事实源，再把校验、来源、链接、状态和发布流程交给消费层治理。
- [Markdown 知识写作](./library/markdown-knowledge/index.md)：让 Markdown 文章同时适合人阅读、工具解析和 Agent 引用，重点处理结构、示例、术语、操作步骤与维护责任。
- [SQLite 与本地数据](./library/sqlite-data/index.md)：用本地数据库保存可验证事实，用清晰的 schema、事务、索引、备份和查询计划支撑 Agent 的结构化问答。
- [Web 流式交互](./library/web-streaming/index.md)：把 Pi 的事件模型适配成浏览器可以消费的 SSE 流，同时处理连接生命周期、事件完整性、重连和可视化检查器。
- [TypeScript 工程实践](./library/typescript-engineering/index.md)：用严格类型、稳定模块边界和可测试的异步代码承载 Agent、检索与 Web 协议，减少运行时才发现的契约漂移。
- [Monorepo 协作](./library/monorepo/index.md)：通过 pnpm workspace、任务编排和清晰的包边界，让 Agent 平台的 Web、API、契约、领域与运行时可以独立演进。
- [Agent 评测与基准](./library/evaluation/index.md)：把知识问答拆成数据集、检索质量、答案 groundedness、流式延迟和并发稳定性，形成可重复的离线与在线评测。
- [Agent 安全与权限](./library/security/index.md)：把 prompt、工具、文件、模型输出和凭据都视为不可信输入，在宿主权限、审计和数据生命周期层建立真实安全边界。
- [运行与可观测性](./library/operations/index.md)：让 Agent 服务在启动、调用、流式输出、错误和容量变化时都可诊断，形成从日志到指标、追踪和运行手册的闭环。
- [产品知识场景](./library/product-knowledge/index.md)：将产品规则、用户流程、账号权限、集成和故障排查写成 Agent 可以检索并引用的长文知识，而不是只放一份 FAQ。
- [工程协作流程](./library/engineering-process/index.md)：把需求、ADR、API 设计、代码评审、测试、发布和事故复盘变成可以被搜索、引用与持续更新的工程知识。
- [Agent 应用模式](./library/application-patterns/index.md)：用不同应用场景验证同一套 Agent 核心：入口保持简单，能力通过工具注入，知识和结构化数据分别提供证据。

## 项目基线

- [Agent 回答契约](./agent/answer-contract.md)
- [本地降级模式](./agent/local-fallback.md)
- [项目资源加载](./agent/resource-loading.md)
- [Pi Session 生命周期](./agent/session-lifecycle.md)
- [工具权限边界](./agent/tool-policy.md)
