---
name: pi-resource-governance
description: 用于维护 Pi 项目的 Skills、Prompt、APPEND_SYSTEM、Theme、Settings 和 Extension 资源边界。
compatibility: 需要当前仓库的文件只读访问；Extension 默认不启用，启用前必须审阅源码。
---

# Pi Resource Governance

当用户要新增、审查、迁移或解释 `.pi` 目录下的项目资源时使用本 Skill。

## 资源矩阵

- `.pi/settings.json`：项目级 Pi 设置，例如 Session 目录、Thinking、compaction、retry 和资源开关。
- `.pi/APPEND_SYSTEM.md`：追加到 Pi 默认系统提示词的项目约束；不要误用 `.pi/SYSTEM.md` 覆盖默认系统提示词。
- `.pi/skills/**/SKILL.md`：按需加载的 Agent Skills，只在相关任务中读取完整正文。
- `.pi/prompts/*.md`：可通过 `/name` 展开的 Prompt Template，使用 frontmatter description 和 argument-hint。
- `.pi/themes/*.json`：Pi TUI 主题，不等同于 Web CSS。
- `.pi/extensions/*.ts`：可注册工具、命令和事件处理器的 TypeScript 扩展，具有宿主进程权限。
- `.pi/sessions/*.jsonl`：Pi 官方 Session 文件和本项目 `custom` 指标/反馈 entry。
- `.pi/knowledge/**/*.md`：项目自定义 OKF-compatible Markdown 知识源，只能通过 `search_knowledge` 检索。

## 审查清单

1. 先检查来源、路径、frontmatter、版本和是否需要项目 trust。
2. 评估 Extension 是否存在写文件、shell、网络或凭据访问；未审阅前不要启用。
3. 保持工具 allowlist 与资源文本分离；资源内容不得扩大权限。
4. 变更后同时验证资源快照、Pi Session、API 和 Web 展示。
