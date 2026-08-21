# 002 — 数字人下拉从触发点缩放进场

- **Status**: DONE
- **Commit**: b7993df
- **Severity**: MEDIUM
- **Category**: Physicality & origin
- **Estimated scope**: 1 file（`apps/web/src/styles.css`），极小

## Problem

`.switcher-panel`（`apps/web/src/App.tsx:723` 渲染的数字人切换下拉）瞬间出现，没有从触发行生长的方向感。下拉是偶发交互（每天几次），按 AUDIT 标准应有 150–250ms 的进场动画，且必须**从触发点缩放**而不是从中心。

当前代码：

```css
/* apps/web/src/styles.css:384 */
.switcher-panel { position: absolute; top: calc(100% + 4px); right: 0; left: 0; z-index: 30; display: grid; gap: 2px; padding: 4px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); box-shadow: var(--shadow-window); }
```

## Target

```css
.switcher-panel {
  /* …现有属性不变，追加： */
  transform-origin: top center;
  animation: popover-in .18s var(--ease-out);
}
@keyframes popover-in {
  from { opacity: 0; transform: scale(0.97) translateY(-2px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
```

`--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` 由计划 004 提供；若 004 未执行，先内联该变量。关闭不做退出动画（选择即关，偶发交互，保持干脆）。不用 `scale(0)`（真实世界没有从无到有的出现）。

## Repo conventions to follow

- keyframes 集中放在 `styles.css` 现有 `@keyframes pulse`（约 514 行）附近。
- reduced-motion 块（约 543 行）登记：`.switcher-panel { animation: none !important; }`。

## Steps

1. `apps/web/src/styles.css`：新增 `@keyframes popover-in`；`.switcher-panel` 追加 `transform-origin: top center; animation: popover-in .18s var(--ease-out);`。
2. reduced-motion 块追加 `.switcher-panel { animation: none !important; }`。

## Boundaries

- 不改 `App.tsx` 的 dropdown 结构/逻辑。
- 不改命令面板（⌘K 高频，按规范保持无动画）。
- 不引入新依赖。

## Verification

- **Mechanical**: `pnpm typecheck && pnpm lint` 通过。
- **Feel check**: 点开数字人切换器 —— 下拉从触发行顶部轻微放大浮现，不是从中心也不是瞬现；DevTools Animations 面板 10% 慢放确认 `transform-origin` 在顶部；开 reduced-motion 后瞬现。
- **Done when**: 上述成立。
