# Pi Workbench 资源

这里是 Pi Coding Agent 的项目文件资源边界。Pi 官方会把项目资源视为需要审阅和信任的输入。

- `settings.json`：项目级 Pi 设置，包括 `.pi/sessions`、Thinking、compaction、retry 和主题；
- `APPEND_SYSTEM.md`：追加到 Pi 默认系统提示词的项目约束；
- `agents/`：本项目的自定义目录，文件定义的 Agent（Markdown + frontmatter），新增一个文件即新增一个 Agent；
- `skills/`：Pi 启动时发现、按需读取的 Agent Skills；
- `prompts/`：Web 输入框中可通过 `/name` 选择的 Prompt Template；
- `themes/`：Pi TUI 的 JSON 主题，不等同于 Web CSS；
- `extensions/`：可注册命令和生命周期处理器的 TypeScript 扩展，默认关闭，启用前必须审阅源码；
- `sessions/`：Pi 官方 JSONL Session 文件。

Agent 只是运行在 Pi `AgentSession` 上的角色定义；`.pi` 文件内容不能扩大工具权限。
