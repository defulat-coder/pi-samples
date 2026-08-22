# 007 — reduced-motion 保留颜色/透明度反馈，只中立化位移

- **Status**: DONE
- **Commit**: 2cf299c
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 1 file（apps/web/src/styles.css），约 10 行

## Problem

`apps/web/src/styles.css:877-881` 的 reduced-motion 块用 `!important` 把**所有**过渡压到 0.01ms——hover 变色、focus 边框变色这类纯颜色反馈也一起被杀死，`:active scale(0.97)` 变成瞬时跳变而非被移除。reduced-motion 的正确语义是「保留 opacity/color 反馈，去掉位移」。

```css
/* apps/web/src/styles.css:877-881 — current */
@media (prefers-reduced-motion: reduce) {
  /* 所有过渡压到近瞬时；循环动画降速变缓（gentler），不完全禁掉以保留状态反馈 */
  *, *::before, *::after { transition-duration: 0.01ms !important; }
  .assistant-body.streaming::after, .thinking-dot.active { animation-duration: 2.4s; }
  .message-retry .spinning, .spinning { animation-duration: 2.4s; }
}
```

## Target

```css
/* target — 颜色/透明度反馈保留正常时长；只把位移类动画中立化 */
@media (prefers-reduced-motion: reduce) {
  /* 位移反馈在 reduced 下移除：按压不再缩放，布局宽度/箭头旋转瞬时完成 */
  .icon-button:active, .nav-row:active, .agent-row:active, .session-row:active,
  .send-button:active, .suggestion-button:active, .mini-button:active, .header-button:active,
  .model-button:active, .agent-card:active, .skill-card:active, .inbox-row:active,
  .prompt-row:active, .model-option:active, .session-tab:active, .workspace-button:active,
  .group-add-button:active, .inbox-refresh:active, .toggle:active,
  .thinking-block summary:active { transform: none; }
  .sidebar, .inbox-column,
  .group-header-chevron, .config-section-chevron,
  .thinking-block summary .caret, .toggle-thumb {
    transition-duration: 0.01ms !important;
  }
  /* 循环动画降速变缓（gentler），不完全禁掉以保留状态反馈 */
  .assistant-body.streaming::after, .thinking-dot.active { animation-duration: 2.4s; }
  .message-retry .spinning, .spinning { animation-duration: 2.4s; }
}
```

注意：删掉 `*, *::before, *::after { transition-duration: 0.01ms !important; }` 这条总规则——它是问题本身。background/color/border-color/opacity 过渡在 reduced 下保持原时长（这是刻意目标，不是遗漏）。

## Repo conventions to follow

- 按压类的选择器清单直接复用 `apps/web/src/styles.css:82-87` 的既有分组选择器，保持两处同步。
- 注释用中文，风格跟随文件内既有注释。

## Steps

1. `apps/web/src/styles.css` 的 `@media (prefers-reduced-motion: reduce)` 块：删除 `*` 总规则，按 Target 添加两组规则（`:active` transform 移除 + 位移类 transition 瞬时），保留两条 keyframes 降速规则并更新注释。

## Boundaries

- 只改这一个 media 块；不要动 media 块外的任何规则。
- 不要改 JS 侧（`MotionConfig reducedMotion="user"` 已正确处理 motion 元素的位移/尺寸中立化，已核实 motion 13.1.1 源码）。
- 不要禁掉 keyframes（降速语义是定案）。

## Verification

- **Mechanical**: `pnpm --filter @pi-workbench/web lint` 全绿（CSS 改动无类型影响）。
- **Feel check**: DevTools Rendering 面板模拟 `prefers-reduced-motion: reduce`：
  - hover 侧栏行/按钮——背景色仍有 0.2s 过渡（不是瞬时）；
  - 按压按钮——**不**缩放（直接无位移，而非瞬时跳变）；
  - ⌘B 收起侧栏、展开「探索」组——瞬时完成；
  - 加载 spinner 仍在转但更慢（2.4s）。
- **Done when**: reduced 下颜色反馈有过渡、位移反馈被移除，非 reduced 下行为与当前完全一致。
