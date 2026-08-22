# Animation Plans

审计基线 commit：`b7993df`。规则目录：`.agents/skills/improve-animations/AUDIT.md`。

| # | 标题 | 严重度 | 状态 |
|---|------|--------|------|
| 001 | 侧栏收起/展开加过渡动画 | HIGH | DONE |
| 002 | 数字人下拉从触发点缩放进场 | MEDIUM | DONE |
| 003 | 会话回合与欢迎建议的入场动画 | MEDIUM | DONE |
| 004 | 统一 easing 令牌并清除 ease-in 退出 | MEDIUM | DONE |
| 005 | 按钮按压反馈与 rail tooltip 进场 | LOW | DONE |

## 推荐执行顺序

1. **004 先行** —— 它提供 `--ease-out` 令牌和 JS 侧统一曲线（`MOTION_EASE`），其余计划都引用这些令牌。
2. 001 → 002 → 003 → 005 任意顺序。

## 依赖关系

- 001、002、005 依赖 004 的 CSS 令牌（若 004 未执行，各计划内写了内联兜底）。
- 003 依赖 004 的 JS 侧 `motionEase` 新值（计划内已内联目标数组 `[0.23, 1, 0.32, 1]`，可独立执行）。

## 明确不做（审计结论，勿反复）

- 命令面板（⌘K）无开关动画 —— 高频键盘交互，遵循 Raycast 规则。
- 会话行、树行、tab 等高频列表不加按压 scale。
- `@keyframes pulse` / `spin` 的 `ease-in-out`/`linear` 是常量动画，保持原样。
