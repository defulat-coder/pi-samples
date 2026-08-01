# Claude Code 项目配置到 Pi Coding Agent 的路径映射

> 调研快照：2026-08-01（Asia/Shanghai）。Claude Code 侧仅引用 `code.claude.com/docs`；Pi 侧仅引用 `pi.dev` 与 `earendil-works/pi` 官方文档。

## 结论先行

不能把整个 `.claude/` 目录原样复制成 `.pi/`。两边只有 **`SKILL.md` 内容格式**和**项目根 `CLAUDE.md`**具有较高复用度；settings、agents、commands、hooks、MCP 的加载路径或运行协议都不同。

迁移时应使用三种标签：

- **可直接兼容**：同一个文件放在两边都认可的位置，内容不需要 host 专用语义。
- **概念等价但需迁移**：解决同类问题，但路径、schema 或执行 API 不兼容。
- **Pi 无原生支持**：Pi Coding Agent 当前没有对应的一等机制，需要 extension、第三方 package 或外部编排。

## 核心映射表

| Claude Code 项目配置 | Claude Code 作用 | Pi Coding Agent 对应 | 兼容判断 | 迁移动作 |
| --- | --- | --- | --- | --- |
| `CLAUDE.md`（项目根） | 始终加载的项目指令 | 项目根 `CLAUDE.md` 或更推荐 `AGENTS.md` | **可直接兼容** | 根 `CLAUDE.md` 可由两边共同读取；若以 `AGENTS.md` 为主，Claude 官方建议让 `CLAUDE.md` import 或 symlink 到它 |
| `.claude/CLAUDE.md` | 项目指令的另一合法位置 | 无 `.pi/CLAUDE.md` 对位；Pi 读取 cwd/父目录的 `AGENTS.md` 或 `CLAUDE.md` | **需移动** | 移到项目根 `CLAUDE.md`/`AGENTS.md`；不要只保留在 `.claude/` |
| `.claude/settings.json` | 团队共享的 settings、permissions、hooks、plugins 等 | `.pi/settings.json` | **概念等价但 schema 不兼容** | 按 Pi settings 字段逐项重写，不能改目录名后直接使用 |
| `.claude/settings.local.json` | 当前项目的个人、gitignored 覆盖 | Pi 没有文档化的 `settings.local.json` 同层文件 | **无直接对应** | 使用全局 `~/.pi/agent/settings.json`、CLI/env 临时覆盖，或自行 gitignore 一个单独方案；不要假设 Pi 会自动读取它 |
| `.claude/agents/*.md` | 自定义 subagent 定义 | 官方 Pi 默认没有 subagents | **Pi 无原生支持** | 用 `.pi/extensions/*.ts` 注册编排工具、独立 `pi --mode rpc` worker，或选第三方 Pi package |
| `.claude/skills/<name>/SKILL.md` | 按需工作流/知识包 | `.pi/skills/<name>/SKILL.md` 或 `.agents/skills/<name>/SKILL.md` | **内容高度兼容，路径不直接兼容** | 可复制/移动；也可在 `.pi/settings.json` 用 `"skills": ["../.claude/skills"]` 让 Pi 显式加载原目录 |
| `.claude/commands/<name>.md` | 旧式 custom command；当前 Claude 已并入 Skills | `.pi/prompts/<name>.md`（prompt template），或改造成 Pi Skill | **概念等价但需迁移** | 简单 `/command` 改为 prompt template；带资源、自动触发或复杂流程的改为 Skill |
| `.claude/settings.json` 中的 `hooks` | lifecycle hook 配置；可运行 command/HTTP 等 handler | `.pi/extensions/*.ts` 的 `pi.on(...)` 事件处理器 | **概念等价但协议不兼容** | 将 matcher、输入输出和 decision 逻辑重写为 TypeScript extension |
| `.claude/hooks/` | 可用于存放 hook 脚本；真正的项目 hook 注册仍在 settings 的 `hooks` 字段 | `.pi/extensions/` 是可自动发现的执行扩展目录 | **不能按目录直接复制** | 脚本可复用，注册和事件适配必须重写；不要把 `.claude/hooks/` 当作独立自动发现配置 |
| 项目根 `.mcp.json` | 团队共享的 project-scope MCP servers | Pi 官方默认无 MCP | **Pi 无原生支持** | 安装/开发 MCP extension/package，或把 MCP 客户端能力放在平台层；`.mcp.json` 不能被 Pi 原生读取 |
| `.claude/rules/**/*.md` | 模块化、可按路径生效的项目规则 | `AGENTS.md`/`CLAUDE.md`、Skills 或 extension | **部分语义可迁移** | 无条件规则并入根指令；按任务加载的改 Skill；需要路径级确定性控制的改 extension |
| `.claude/output-styles/*.md` | 修改 Claude 的系统提示词、角色、语气与输出格式 | `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md` 更接近行为层；`.pi/themes/` 只控制 TUI 视觉 | **概念等价但无同协议** | 不要迁到 `.pi/themes/`；按需要改写为 SYSTEM/APPEND_SYSTEM 或 extension |
| `.claude/settings.json` 的 plugin 配置 | 启用/分发 skills、agents、hooks、MCP 等组件 | `.pi/settings.json` 的 `packages`，以及 Pi package 的 extensions/skills/prompts/themes | **概念等价但包格式不兼容** | 重新打成 Pi package 或逐项迁移资源；Claude plugin 不能直接安装为 Pi package |
| Claude auto memory | Claude 自动写入、按仓库保存的学习笔记 | Pi 当前文档化核心没有同形态的项目 auto-memory 目录 | **Pi 无原生支持** | 平台自行持久化，或用 extension/第三方 package 实现；不要与 session JSONL 或 AGENTS.md 混为一谈 |

Claude Code 的项目 scope 表明确列出 settings 为 `.claude/settings.json`、subagents 为 `.claude/agents/`，而 project-scope MCP 位于**项目根 `.mcp.json`**，不在 `.claude/` 内。[Claude Code settings](https://code.claude.com/docs/en/configuration)

Pi 的项目 settings 是 `.pi/settings.json`，其中可配置 `packages`、`extensions`、`skills`、`prompts` 和 `themes` 路径；项目资源只有在项目 trust 通过后加载。[Pi Settings](https://pi.dev/docs/latest/settings)

## 1. 项目指令：优先收敛到根 `AGENTS.md` / `CLAUDE.md`

Claude Code 接受项目根 `CLAUDE.md` 或 `.claude/CLAUDE.md`。它不原生读取 `AGENTS.md`，官方建议用根 `CLAUDE.md` import `@AGENTS.md`，或者用 symlink 共享一份内容。[Claude memory](https://code.claude.com/docs/en/memory#agentsmd)

Pi 则会从 cwd 向父目录读取 `AGENTS.md` 或 `CLAUDE.md` 并拼接，用于项目约定与常用命令。[Pi Coding Agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#context-files)

因此跨工具最稳的仓库布局是：

```text
AGENTS.md              # 共享规则的权威文件，Pi 直接读取
CLAUDE.md              # @AGENTS.md，或指向 AGENTS.md 的 symlink
.claude/               # Claude 专用配置
.pi/                   # Pi 专用配置
```

这里的“直接兼容”仅指普通 Markdown 指令。Claude 专用的 import、工具名、permission 或 hook 语义不能假设 Pi 会解释。

### `.claude/rules/` 不是 Pi 的 `AGENTS.md` 分片机制

Claude Code 会递归发现 `.claude/rules/*.md`，还可用 frontmatter 将规则限定到特定路径。[Claude memory: rules](https://code.claude.com/docs/en/memory#organize-rules-with-clauderules)

Pi 官方文档没有同名、同语义的 path-scoped rules 目录：

- 总是需要的规则放进 `AGENTS.md`/`CLAUDE.md`；
- 只在某类任务需要的说明改成 Skill；
- 必须确定执行、按路径阻断的策略改成 extension 的 `tool_call` handler。

## 2. Settings：目录对位，schema 完全不同

Claude Code：

- `.claude/settings.json`：项目共享配置；
- `.claude/settings.local.json`：个人项目覆盖，通常 gitignored；
- settings 可包含 permissions、hooks、env、plugins、sandbox 等大量 Claude Code 专用字段。[Claude Code settings](https://code.claude.com/docs/en/configuration#settings-files)

Pi：

- `.pi/settings.json`：项目配置；
- `~/.pi/agent/settings.json`：全局配置；
- 项目配置覆盖全局配置，嵌套 object 合并；
- `packages`、`extensions`、`skills`、`prompts`、`themes` 数组用于扩展资源发现。[Pi Settings](https://pi.dev/docs/latest/settings)

所以：

```text
.claude/settings.json  --不能直接改名-->  .pi/settings.json
```

必须逐字段重建。尤其不要把 Claude 的 `permissions` 或 `sandbox` 字段复制到 Pi 后误以为获得安全边界；Pi 官方没有对应的内建权限 schema。

## 3. Skills：最容易复用，但不是零配置兼容

Claude Code 与 Pi 都使用 `SKILL.md` capability package，并都遵循 Agent Skills 思路。Claude 项目技能位于 `.claude/skills/<name>/SKILL.md`；Pi 自动发现的项目位置是：

- `.pi/skills/`；
- `.agents/skills/`（cwd 与祖先目录，受 repo/root 边界约束）；
- Pi package 的 `skills/`；
- `.pi/settings.json` 的 `skills` 数组。[Claude Skills](https://code.claude.com/docs/en/skills) · [Pi Skills](https://pi.dev/docs/latest/skills)

Pi 官方还专门给出复用 Claude Code 项目 Skills 的方式：

```json
{
  "skills": ["../.claude/skills"]
}
```

把它放入 `.pi/settings.json` 后，Pi 才会显式扫描原 `.claude/skills`。[Pi Skills: Using Skills from Other Harnesses](https://pi.dev/docs/latest/skills#using-skills-from-other-harnesses)

但只能把它称为“内容高兼容”：Claude 扩展的 frontmatter、subagent execution、Claude 专用工具名或环境变量仍需检查。

## 4. Commands：迁到 `.pi/prompts` 或 Skills

Claude Code 已把 custom commands 合并进 Skills；旧 `.claude/commands/deploy.md` 仍可创建 `/deploy`，但官方推荐新能力使用 `.claude/skills/deploy/SKILL.md`。[Claude Skills](https://code.claude.com/docs/en/skills)

Pi 的最近邻有两种：

- `.pi/prompts/*.md`：可通过 `/name` 展开的 prompt template；
- `.pi/skills/*/SKILL.md`：可按描述自动加载、可带脚本/引用的能力包。

Pi prompt templates 的项目自动发现路径是 `.pi/prompts/*.md`，通过 project trust 后加载。[Pi Prompt Templates](https://pi.dev/docs/latest/prompt-templates)

选择规则：

- 只是把一段提示词绑定到 `/name`：迁到 `.pi/prompts/<name>.md`；
- 有 frontmatter、支持文件、脚本或希望 agent 自动选用：迁到 Pi Skill。

## 5. Hooks：Claude settings 配置要重写为 Pi extension

Claude 项目 hook 的权威注册点是 `.claude/settings.json` 内的 `hooks` 字段。`PreToolUse`、`PostToolUse` 等事件按照 Claude hook schema 接收输入并返回 decision；项目中可以把实际脚本放在 `.claude/hooks/`，但目录本身不是可替代 settings 注册的通用自动发现协议。[Claude Hooks](https://code.claude.com/docs/en/hooks)

Pi 的对应机制是 `.pi/extensions/*.ts` 或 `.pi/extensions/*/index.ts`。Extension 使用 `pi.on(event, handler)`，例如 `tool_call` 可修改输入或返回 `{ block: true }`，`tool_result` 可修改结果；extension 还能注册工具、命令和 UI。[Pi Extensions](https://pi.dev/docs/latest/extensions)

因此迁移形态是：

```text
.claude/settings.json hooks + hook script
              ↓ 重新实现事件与 decision 适配
.pi/extensions/policy.ts
```

不能直接复制 JSON matcher。还要注意 Pi extension 以当前用户的完整系统权限运行，可执行任意代码；它是扩展点，不是自动获得的 OS sandbox。[Pi Extensions security](https://pi.dev/docs/latest/extensions#extension-locations)

## 6. Agents：Pi 默认不读取 `.claude/agents/`

Claude Code 的 `.claude/agents/*.md` 是正式的项目 subagent 定义位置，可定义独立 prompt、tools、model、skills、MCP、hooks、permission mode 等。[Claude Subagents](https://code.claude.com/docs/en/sub-agents)

官方 Pi Coding Agent 明确选择不内建 subagents。它建议通过 extension、多个 Pi 实例或第三方 package 实现。[Pi philosophy](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy)

所以 `.claude/agents/*.md`：

- Pi 不会自动发现；
- 不能改名为 `.pi/agents/*.md`，官方没有该目录协议；
- Pi SDK 中的 `agentsFiles` 指 `AGENTS.md` context files，不是 Claude-style subagent definitions，不要混淆。

平台迁移需要明确新的 orchestration contract，例如 extension 工具启动一个独立 `pi --mode rpc` worker，并自己管理 cwd、工具、凭据、预算、取消和结果汇总。

## 7. MCP：`.mcp.json` 不在 `.claude/`，Pi 也不原生读取

Claude Code 的 project-scope MCP 配置位于项目根 `.mcp.json`，而不是 `.claude/mcp.json`。Local/user scope 则保存在 `~/.claude.json` 的相应位置。[Claude MCP](https://code.claude.com/docs/en/mcp#mcp-installation-scopes)

Pi 官方默认明确 **No MCP**；可以通过 extension 或第三方 package 加入 MCP 支持。[Pi philosophy](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#philosophy)

因此 `.mcp.json` 的判断是 **Pi 无原生支持**，而不是“路径需改成 `.pi/mcp.json`”。若要迁移，需另外实现：

- MCP transport 与进程生命周期；
- OAuth/headers/secret 注入；
- tool schema 与结果转换；
- 工具 allowlist、审批和审计；
- 断线、超时和重试。

## 8. Pi 自己的项目资源目录

完整迁移后，Pi 项目侧通常形成：

```text
AGENTS.md                     # 项目指令；也可使用根 CLAUDE.md
.pi/
├── settings.json             # Pi settings 与资源清单
├── SYSTEM.md                 # 替换默认 system prompt（慎用）
├── APPEND_SYSTEM.md          # 追加 system prompt
├── skills/
│   └── <name>/SKILL.md       # Pi Skills
├── prompts/
│   └── <name>.md             # /name prompt templates
├── extensions/
│   └── <name>.ts             # 工具、事件、策略、命令、UI
└── themes/                   # Pi TUI 视觉主题

.agents/
└── skills/
    └── <name>/SKILL.md       # 跨支持 Agent Skills 的工具共享
```

`.pi/themes/` 只对应终端视觉主题，不对应 Claude 的 output styles；后者会改变系统提示词与响应角色。Pi 官方文档将 themes 与 skills、prompts、extensions 分成不同资源类型。[Pi Coding Agent customization](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#customization)

## 推荐迁移顺序

1. 把共享项目规则收敛到根 `AGENTS.md`，用 `CLAUDE.md` import/symlink 共享。
2. 新建 `.pi/settings.json`，不要复制 Claude settings schema。
3. 先通过 `.pi/settings.json` 显式引用 `.claude/skills`，逐个审计后再决定是否迁入共享 `.agents/skills`。
4. 将 `.claude/commands` 分流到 `.pi/prompts` 或 Pi Skills。
5. 把 Claude hooks 重写为 `.pi/extensions`，并单独建立真正的 sandbox/容器边界。
6. 对 `.claude/agents` 和 `.mcp.json` 做架构级迁移，不做文件名替换。
7. 最后迁移 output style、plugin packaging 等非核心体验层。

## 官方来源

### Claude Code

- [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory)
- [Claude Code settings](https://code.claude.com/docs/en/configuration)
- [Memory, CLAUDE.md and rules](https://code.claude.com/docs/en/memory)
- [Skills and legacy commands](https://code.claude.com/docs/en/skills)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [MCP](https://code.claude.com/docs/en/mcp)
- [Output styles](https://code.claude.com/docs/en/output-styles)

### Pi

- [Pi Coding Agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Pi Settings](https://pi.dev/docs/latest/settings)
- [Pi Skills](https://pi.dev/docs/latest/skills)
- [Pi Prompt Templates](https://pi.dev/docs/latest/prompt-templates)
- [Pi Extensions](https://pi.dev/docs/latest/extensions)
- [Pi Packages](https://pi.dev/docs/latest/packages)
