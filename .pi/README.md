# Pi Workbench 资源

这里是 Pi Coding Agent 的项目文件资源边界，风格与 Claude Code 的 `.claude/` 目录接近。Pi 官方会把项目资源视为需要审阅和信任的输入；本项目的 Web 网关仍然保留独立的只读工具 allowlist。

- `settings.json`：项目级 Pi 设置，包括 `.pi/sessions`、Thinking、compaction、retry 和主题；
- `APPEND_SYSTEM.md`：追加到 Pi 默认系统提示词的项目约束；
- `skills/`：Pi 启动时发现、按需读取的 Agent Skills；
- `prompts/`：可通过 `/name` 展开的 Prompt Template；
- `themes/`：Pi TUI 的 JSON 主题，不等同于 Web CSS；
- `extensions/`：可注册命令和生命周期处理器的 TypeScript 扩展，Web 网关默认关闭，启用前必须审阅源码；
- `sessions/`：Pi 官方 JSONL Session 文件，包含原生消息和本项目指标/反馈 custom entries；
- `knowledge/`：带 OKF-compatible frontmatter 的 Agent Markdown 概念，通过 `search_knowledge` 读取。

Agent 运行时默认只启用 `read` 和 `search_knowledge`，不会在这些文件或仓库里执行写入和 shell 命令。`.pi` 文件内容不能扩大工具权限。
