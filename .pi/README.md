# Pi Workbench 资源

这里是 Pi Coding Agent 的项目文件资源边界，风格与 Claude Code 的 `.claude/` 目录接近。Pi 官方会把项目资源视为需要审阅和信任的输入；本项目的 Web 网关仍然保留独立的只读工具 allowlist。

- `settings.json`：项目级 Pi 设置，包括 `.pi/sessions`、Thinking、compaction、retry 和主题；
- `APPEND_SYSTEM.md`：追加到 Pi 默认系统提示词的项目约束；
- `skills/`：Pi 启动时发现、按需读取的 Agent Skills；
- `prompts/`：可通过 `/name` 展开的 Prompt Template；
- `themes/`：Pi TUI 的 JSON 主题，不等同于 Web CSS；
- `extensions/`：可注册命令和生命周期处理器的 TypeScript 扩展，Web 网关默认关闭，启用前必须审阅源码；
- `digital-humans/`：数字人的姓名、职业、人设和能力档案引用；不能直接定义工具；
- `sessions/`：Pi 官方 JSONL Session 文件，包含原生消息和本项目指标/反馈 custom entries；
- `knowledge/`：带 OKF-compatible frontmatter 的 Agent Markdown 概念，通过 `search_knowledge` 读取。

Pi 运行时按宿主能力档案启用只读工具：`project-knowledge` 使用 `read/search_knowledge`，`business-analytics` 使用 `read/query_business_data`。数字人只是运行在 Pi `AgentSession` 上的角色定义；`.pi` 文件和第三方 Skill 内容都不能扩大工具权限。
