# 004 — 统一 easing 令牌并清除 ease-in 退出

- **Status**: DONE
- **Commit**: b7993df
- **Severity**: MEDIUM
- **Category**: Easing & duration + Cohesion & tokens
- **Estimated scope**: 2 files（`apps/web/src/styles.css`、`apps/web/src/App.tsx`），机械替换为主

## Problem

1. `cubic-bezier(.4, 0, .2, 1)` 在 `styles.css` 里手写了约 20 处（hover/颜色过渡），与 JS 侧 `App.tsx:70` 的 `motionEase = [0.22, 0.61, 0.36, 1]` 割裂 —— 五份手感两份体系。
2. 退出动画用了 `easeIn`：`App.tsx:646`（resource viewer exit）、`App.tsx:1279`（conversation exit）、`App.tsx:1316`（toast exit）。AUDIT 规则：**UI 上 ease-in 永远是 finding**，进场/出场都应用强 ease-out。

## Target

```css
/* styles.css :root 追加 */
--ease-ui: cubic-bezier(.4, 0, .2, 1);       /* hover/颜色等状态过渡，保持现有手感 */
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);  /* 强 ease-out，UI 进出场 */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1); /* 抽屉/面板滑动 */
```

- `styles.css` 全部 `cubic-bezier(.4, 0, .2, 1)` → `var(--ease-ui)`。
- `App.tsx`：`motionEase` 改为 `[0.23, 1, 0.32, 1]`（与 `--ease-out` 同曲线，注释注明对应关系）；三处 `ease: 'easeIn'` 退出改为 `ease: motionEase`（时长不变：0.08 / 0.08 / 0.12）。

## Repo conventions to follow

- `:root` 令牌区在 `styles.css` 约 39 行（`--workspace-width` 附近），新令牌加在那里。
- 改完全局搜 `cubic-bezier(` 确认只剩 `:root` 三处定义。

## Steps

1. `styles.css` `:root` 加三个 `--ease-*` 变量。
2. `styles.css` 全量替换 `cubic-bezier(.4, 0, .2, 1)` → `var(--ease-ui)`（约 20 处，可用编辑器的全局替换；逐条确认只替换该曲线）。
3. `App.tsx:70` `motionEase` 值改为 `[0.23, 1, 0.32, 1]`，注释更新为「对齐 --ease-out」。
4. `App.tsx` 三处 `ease: 'easeIn'` → `ease: motionEase`。

## Boundaries

- 不改任何时长、不改 hover 的目标颜色值。
- 不动 `@keyframes pulse` / `spin` 的缓动（`ease-in-out` 循环脉冲是常量动画，正确）。
- 不引入新依赖。

## Verification

- **Mechanical**: `pnpm typecheck && pnpm lint && pnpm test` 全绿；`grep -n "cubic-bezier(" apps/web/src/styles.css` 只剩 `:root` 三行。
- **Feel check**: 触发 resource viewer 开合、错误 toast 出现/关闭 —— 退出不再「慢起步」，收得干脆；hover 手感与改前一致。
- **Done when**: 上述成立。
