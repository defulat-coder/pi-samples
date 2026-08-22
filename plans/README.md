# Animation Plans

审计基线 commit：`b7993df`。规则目录：`.agents/skills/improve-animations/AUDIT.md`。

| # | 标题 | 严重度 | 状态 |
|---|------|--------|------|
| 001 | 侧栏收起/展开加过渡动画 | HIGH | DONE |
| 002 | 数字人下拉从触发点缩放进场 | MEDIUM | DONE |
| 003 | 会话回合与欢迎建议的入场动画 | MEDIUM | DONE |
| 004 | 统一 easing 令牌并清除 ease-in 退出 | MEDIUM | DONE |
| 005 | 按钮按压反馈与 rail tooltip 进场 | LOW | DONE |
| 006 | ExploreAgents 卡片按压反馈修复（whileTap 补偿） | MEDIUM | DONE |
| 007 | reduced-motion 保留颜色/透明度反馈，只中立化位移 | MEDIUM | DONE |
| 008 | Composer 焦点可见性（:focus-within 边框高亮） | MEDIUM | DONE |
| 009 | Composer 提示词面板改为单元素可重定向动画 | MEDIUM | DONE |
| 010 | 侧栏导航行 hover 时长收敛到 --duration-normal | MEDIUM | DONE |

第二轮审计基线 commit：`2cf299c`（006-010）。

## 推荐执行顺序

1. **004 先行** —— 它提供 `--ease-out` 令牌和 JS 侧统一曲线（`MOTION_EASE`），其余计划都引用这些令牌。
2. 001 → 002 → 003 → 005 任意顺序。
3. 第二轮（006-010）彼此无依赖，任意顺序；006/008/010 都是一行级修复，009 改动最大建议单独执行。

## 依赖关系

- 001、002、005 依赖 004 的 CSS 令牌（若 004 未执行，各计划内写了内联兜底）。
- 003 依赖 004 的 JS 侧 `motionEase` 新值（计划内已内联目标数组 `[0.23, 1, 0.32, 1]`，可独立执行）。
- 006-010 全部自包含（令牌与目标值已内联），无外部依赖。

## 明确不做（审计结论，勿反复）

- 命令面板（⌘K）无开关动画 —— 高频键盘交互，遵循 Raycast 规则。
- 高频列表行的按压反馈统一为 `:active scale(0.97)` + `--duration-fast`，覆盖 P4 定案；不再视其为禁区。
- `@keyframes pulse` / `spin` 的 `ease-in-out`/`linear` 是常量动画，保持原样。
- 侧栏/收件箱列的 `width` 收起动画 —— 刻意布局动画，触发偶尔（⌘B/按钮），已定案。
- 视图淡入（.view-body）无 exit —— 避免双子树共存撑开布局，已定案。
- reduced-motion 下 spinner 降速旋转（2.4s）——gentler 语义是定案，勿改成禁掉。
