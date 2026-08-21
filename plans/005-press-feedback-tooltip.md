# 005 — 按钮按压反馈与 rail tooltip 进场

- **Status**: DONE
- **Commit**: b7993df
- **Severity**: LOW
- **Category**: Physicality & origin
- **Estimated scope**: 1 file（`apps/web/src/styles.css`），极小

## Problem

1. 主要按钮无按压反馈（`:active` 无变化）：`.send-button`、`.new-session-button`、`.composer-tool-button`、`.rail-item`、`.switcher-option`、`.workspace-search-trigger`。
2. rail tooltip（`styles.css:377` `.rail-item[data-tip]:hover::after`）瞬间出现，无 125–200ms 的进场。

## Target

按压反馈（AUDIT 标准值：`scale(0.97)`、`160ms ease-out`）：

```css
.send-button, .new-session-button, .composer-tool-button, .rail-item, .switcher-option, .workspace-search-trigger {
  /* 各选择器现有 transition 列表末尾追加 transform .16s var(--ease-out) */
}
.send-button:active, .new-session-button:active, .composer-tool-button:active, .rail-item:active, .switcher-option:active, .workspace-search-trigger:active {
  transform: scale(0.97);
}
```

tooltip 进场：

```css
@keyframes tooltip-in {
  from { opacity: 0; transform: translate(-3px, -50%); }
  to { opacity: 1; transform: translate(0, -50%); }
}
.rail-item[data-tip]:hover::after { animation: tooltip-in .14s var(--ease-out); }
```

注意：tooltip 的 `transform: translateY(-50%)` 是定位用的，keyframes 里必须保持 `-50%` 的 Y 分量。`.rail-item:active` 的 scale 会带着 tooltip 一起缩 0.97，属预期、足够微妙。

## Repo conventions to follow

- 缓动用计划 004 的 `var(--ease-out)`；若 004 未执行，先内联 `--ease-out: cubic-bezier(0.23, 1, 0.32, 1);`。
- keyframes 放现有 `@keyframes pulse`（约 514 行）附近。
- reduced-motion 块（约 543 行）追加：按压 scale 与 tooltip 动画都 `none !important`（tooltip 保留瞬现即可）。

## Steps

1. `styles.css`：给六个选择器的 `transition` 列表各追加 `transform .16s var(--ease-out)`；新增合并的 `:active { transform: scale(0.97); }` 规则。
2. 新增 `@keyframes tooltip-in`；`.rail-item[data-tip]:hover::after` 追加 `animation: tooltip-in .14s var(--ease-out);`。
3. reduced-motion 块追加关闭规则。
4. hover 动效确认包在 `@media (hover: hover) and (pointer: fine)` 内或保持现状（tooltip 是纯展示，无位移反馈，可豁免；按压 `:active` 触屏上同样合理，保留）。

## Boundaries

- 不给高频列表行（`.session-row-shell`、`.tree-row`、`.workspace-tab`）加按压 scale —— 每天几十次点击，保持安静。
- 不改按钮颜色/尺寸。
- 不引入新依赖。

## Verification

- **Mechanical**: `pnpm lint` 通过；`git diff --check` 干净。
- **Feel check**: 按住发送按钮/新建会话/rail 图标 —— 有轻微下沉感，松手回弹干脆；hover rail 图标 —— tooltip 从左侧 3px 处淡入；DevTools 10% 慢放确认 tooltip 位移方向；reduced-motion 下两者都静止。
- **Done when**: 上述成立。
