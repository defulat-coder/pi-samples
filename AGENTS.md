# Agent 操作说明

## 仓库范围

- 本仓库在 `.agents/skills/` 中保存项目级 Agent Skills。
- `skills-lock.json` 是已安装技能来源和哈希的权威记录。
- `README.md` 记录项目名称；仓库定位发生变化时同步更新。

## 技能管理

| 操作 | 命令 |
|------|---------|
| 列出项目技能 | `npx skills list --json` |
| 从锁文件恢复 | `npx skills experimental_install` |
| 添加一个项目技能 | `npx skills add <owner/repo> --skill <name> -a universal -y` |

## 约定

- 通过 Skills CLI 安装、移除和更新第三方技能，确保 `skills-lock.json` 保持同步。
- 每个技能放在 `.agents/skills/<skill-name>/` 下，并以 `SKILL.md` 作为入口。
- 上游随技能提供 `SPEC.md`、`SOURCES.md`、参考资料、脚本或资源时，完整保留这些文件。
- 除非仓库有意维护本地分支，否则不要手动修改引入的技能内容。
- 在相应项目配置出现前，不要添加构建、检查或测试命令。

## 验证

- 修改已安装技能后运行 `npx skills list --json`。
- 提交前运行 `git diff --check`。
- 检查 `git status --short`，仅暂存当前任务涉及的文件。
