# 010 — 侧栏导航行 hover 时长收敛到 --duration-normal

- **Status**: DONE
- **Commit**: 2cf299c
- **Severity**: MEDIUM
- **Category**: Easing & duration（+ Cohesion）
- **Estimated scope**: 1 file（apps/web/src/styles.css），1 个值

## Problem

`apps/web/src/styles.css:182` 的侧栏行（`.nav-row, .agent-row, .session-row`）hover 背景过渡用 `--duration-slow`（0.3s）——顶着「UI 动画 <300ms」上限，且与全站其他行/按钮 hover 的 `--duration-normal`（0.2s，如 styles.css:135、:241、:347）不一致。这些是每天点数十次的高频导航行，0.3s 的 hover 拖尾会让整个侧栏显得肉。

```css
/* apps/web/src/styles.css:180-183 — current */
.nav-row, .agent-row, .session-row {
  /* … */
  transition: background var(--duration-slow) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
```

## Target

```css
transition: background var(--duration-normal) var(--ease-out), transform var(--duration-fast) var(--ease-out);
```

`transform`（按压反馈）的 `--duration-fast` 不动。

## Repo conventions to follow

- 时长 token 体系：`--duration-fast: 0.1s`（按压/微反馈）、`--duration-normal: 0.2s`（hover/常规 UI）、`--duration-slow: 0.3s`（仅保留给真正需要更慢的场景，如面板级过渡）——本计划执行后 grep `--duration-slow` 确认剩余使用点都是合理的低频场景，如有其他高频 hover 误用一并指出（但只改这一条规则，其他另行汇报）。

## Steps

1. `apps/web/src/styles.css:182`：`var(--duration-slow)` → `var(--duration-normal)`。

## Boundaries

- 只改这一个声明值；不要动 `.sidebar` width 过渡（刻意布局动画，已定案）。
- 不要新增 token。

## Verification

- **Mechanical**: `pnpm --filter @pi-workbench/web lint` 全绿。
- **Feel check**: `pnpm dev` 后在侧栏会话/导航行上快速滑动鼠标——hover 背景响应应明显更跟手，与收件箱行、按钮的 hover 手感一致。DevTools Animations 面板可对比 0.2s vs 0.3s 的差异。
- **Done when**: 侧栏行 hover 为 0.2s，与全站其他行一致。
