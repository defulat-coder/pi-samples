# 008 — Composer 焦点可见性（:focus-within 边框高亮）

- **Status**: DONE
- **Commit**: 2cf299c
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 1 file（apps/web/src/styles.css），1 条规则

## Problem

`apps/web/src/styles.css:454-456` 的 `.composer textarea` 是 `outline: none`，而全文件没有任何 `.composer:focus-within` 规则——输入框获得焦点时没有任何视觉指示。`.composer` 容器（`apps/web/src/styles.css:448-452`）的 transition 已预留 `border-color`，说明焦点高亮是设计意图但规则缺失。

```css
/* apps/web/src/styles.css:448-456 — current */
.composer {
  position: relative; border-radius: var(--radius-xl); border: 1px solid var(--border-subtle);
  background: var(--bg-primary);
  transition: border-color var(--duration-normal) var(--ease-out), background var(--duration-normal) var(--ease-out), box-shadow var(--duration-normal) var(--ease-out);
}
.welcome-composer .composer { width: 100%; }
.composer textarea {
  display: block; width: 100%; border: none; outline: none; resize: none; background: none;
```

## Target

```css
/* 紧跟 .composer 规则之后新增 */
.composer:focus-within { border-color: var(--border-default); }
```

## Repo conventions to follow

- 项目内既有先例：`.sidebar-search:focus-within`、`.palette-input` 等输入框均用 `:focus`/`:focus-within` 的 border-color 变化做焦点指示（参见 `apps/web/src/styles.css:285`、`:576` 附近）；token 用 `--border-default`（`styles.css:26`），与既有 focus 态一致——写之前 grep 一处既有 focus 规则核对色值，保持一致。
- 过渡无需新加：`.composer` 的 transition 已含 `border-color var(--duration-normal) var(--ease-out)`，新规则会自动获得 0.2s 过渡。

## Steps

1. `apps/web/src/styles.css`：在 `.composer { ... }` 规则后插入 `.composer:focus-within { border-color: var(--border-default); }`（色值以既有 focus 规则为准，若既有规则用的是别的 border token 则跟随它）。

## Boundaries

- 不要给 textarea 加回 outline；不要动 `.composer` 的既有规则。
- 不要改任何组件代码。

## Verification

- **Mechanical**: `pnpm --filter @pi-workbench/web lint` 全绿。
- **Feel check**: `pnpm dev` 后点击输入框——composer 外框颜色应平滑变深（0.2s）；Tab 离开输入框后恢复。对比 Fleet/ChatGPT 的输入框焦点手感。
- **Done when**: 键盘和鼠标聚焦输入框时都有可见的边框高亮。
