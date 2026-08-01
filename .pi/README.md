# Pi Workbench 资源

这里是 Pi Coding Agent 的项目文件资源边界，风格与 Claude Code 的 `.claude/` 目录接近：

- `skills/`：Pi 启动时发现的通用 Agent 行为；
- `prompts/`：可复用的对话提示模板；
- `knowledge/`：带 OKF-compatible frontmatter 的 Agent Markdown 概念。

Agent 运行时只启用 `read`，不会在这些文件或仓库里执行写入和 shell 命令。
