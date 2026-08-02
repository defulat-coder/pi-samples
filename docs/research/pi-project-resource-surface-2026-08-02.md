# Pi 项目资源能力补全记录（2026-08-02）

## 结论

本项目此前只把 `.pi/skills`、`.pi/prompts`、`.pi/knowledge` 和 `.pi/sessions` 当作项目资源。Pi 官方的项目资源面还包括：项目设置、追加系统提示词、主题和 TypeScript 扩展。此次补全把这些资源做成文件，并让 SDK 的 `DefaultResourceLoader` 负责发现 Skills、Prompt Templates、Themes、Context Files、系统提示词和追加提示词；Web 只接收元数据和只读资源预览，不接触 Pi SDK 或 Provider 凭据。

官方边界：Pi 把 `.pi/settings.json`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md`、`.pi/extensions`、`.pi/skills`、`.pi/prompts` 和 `.pi/themes` 视为需要项目 trust 的资源；扩展可以执行宿主进程代码，因此必须审阅后启用。参考 [Using Pi](https://pi.dev/docs/latest/usage)、[Security](https://pi.dev/docs/latest/security) 和 [Extensions](https://pi.dev/docs/latest/extensions)。

## 资源到实现的映射

| 官方资源 | 当前项目落地 | Web/API 行为 |
| --- | --- | --- |
| `.pi/settings.json` | Session 目录、minimal thinking、compaction、retry、Skill commands、主题 | 文件树可查看；资源快照报告加载结果 |
| `.pi/APPEND_SYSTEM.md` | 文件优先的安全和证据约束 | 由 `DefaultResourceLoader` 追加到默认系统提示词 |
| `.pi/skills/**/SKILL.md` | Session 观测、资源治理、知识问答三个项目 Skill | Agent 按需发现；API 只返回名称、描述和路径 |
| `.pi/prompts/*.md` | `inspect-pi`、`review-session`、`knowledge-answer` | Agent 可通过 Pi Prompt Template 机制展开；API 只返回元数据 |
| `.pi/themes/*.json` | `pi-workbench-neutral` 中性 TUI 主题 | Pi CLI/RPC 可发现；不替代 Web CSS |
| `.pi/extensions/*.ts` | `pi-workbench-status` 只读状态命令和 TUI 状态栏 | Web 默认关闭，`PI_PROJECT_EXTENSIONS_ENABLED=true` 才加载 |
| `.pi/sessions/*.jsonl` | 官方 Session JSONL 加 `pi-workbench.*` custom 指标/反馈 entry | Web 提供结构化时间线和原始 JSONL 切换 |
| `.pi/knowledge/**/*.md` | OKF-compatible Markdown 知识源 | 只能由 `search_knowledge` 作为 Pi 工具调用 |

## SDK 事实与约束

Pi SDK 的 `createAgentSession()` 使用 `ResourceLoader` 提供 extensions、skills、prompt templates、themes 和 context files。`DefaultResourceLoader` 的公共接口可以读取加载结果、诊断、系统提示词来源和追加系统提示词来源，详见 [Pi SDK](https://pi.dev/docs/latest/sdk)。

Skills 采用 Agent Skills 规范，Pi 启动时只把名称和描述放入系统提示词，匹配任务后再用 `read` 读取完整 `SKILL.md`，这是渐进披露机制，详见 [Skills](https://pi.dev/docs/latest/skills)。Prompt Templates 是带 frontmatter 的 Markdown 文件，通过 `/name` 展开并支持 `$1`、`$@` 等参数，详见 [Prompt Templates](https://pi.dev/docs/latest/prompt-templates)。Themes 是 JSON 文件，项目位置为 `.pi/themes/*.json`，详见 [Themes](https://pi.dev/docs/latest/themes)。

本项目保留 `tools: ['read', 'search_knowledge']` allowlist。即使扩展注册了其他工具，SDK 也只会把 allowlist 内的工具放入 Agent 工具注册表；扩展自身仍然是宿主代码，所以默认关闭并在配置中明确标记为 opt-in。项目 Markdown、Skill 或检索结果不能扩大该 allowlist。

## 验证

- `loadPiResourceSnapshot()` 可返回 extensions、skills、prompts、themes、context files、系统提示词来源、追加提示词来源和资源诊断。
- `/api/v1/agent/workspace` 返回 `pi` 资源快照和 `resources` 文件树；Web 左侧显示 Skills、Prompts、Themes、Extensions 开关状态。
- `PI_PROJECT_EXTENSIONS_ENABLED=false` 时，扩展文件仍可在 `.pi` 文件树查看，但不会加载执行。
- `PI_PROJECT_EXTENSIONS_ENABLED=true` 时，只加载已审阅的项目扩展；工具 allowlist 仍然保持只读。
- 通过项目 TypeScript、Lint、Test、Build 后，再用 API `/health` 和浏览器文件树核验资源可见性。

## 未覆盖的边界

Pi 包管理（`pi install`、`packages` 和 `.pi/npm` / `.pi/git`）仍未接入 Web 自动安装流程。原因是包和扩展具有宿主权限，自动安装会扩大外部状态和供应链风险；如需引入，应先审阅来源、固定版本，再通过项目设置显式配置。参考 [Pi Packages](https://pi.dev/docs/latest/packages)。
