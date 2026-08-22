# 006 — ExploreAgents 卡片按压反馈修复（whileTap 补偿）

- **Status**: DONE
- **Commit**: 2cf299c
- **Severity**: MEDIUM
- **Category**: Performance（motion 内联 transform 覆盖 CSS :active）
- **Estimated scope**: 1 file, 1 line

## Problem

`apps/web/src/components/ExploreAgents.tsx:26-35` 的 Agent 卡片是 `motion.button`，入场动画落地后 motion 在元素上留下内联 `transform: none`，优先级压过样式表里的 `.agent-card:active { transform: scale(0.97) }`（`apps/web/src/styles.css:83`）——按压缩放永远不生效。InboxView 已为同款 bug 补过 `whileTap`（`apps/web/src/components/InboxView.tsx:62`），ExploreAgents 漏了。

```tsx
// apps/web/src/components/ExploreAgents.tsx:26-35 — current
<motion.button
  type="button"
  role="listitem"
  key={agent.id}
  className="agent-card"
  initial={{ opacity: 0, y: 6 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.25, ease: MOTION_EASE, delay: index * 0.04 }}
  onClick={() => onOpenChat(agent.id)}
>
```

## Target

```tsx
// target — 仅新增一行 whileTap
<motion.button
  type="button"
  role="listitem"
  key={agent.id}
  className="agent-card"
  initial={{ opacity: 0, y: 6 }}
  animate={{ opacity: 1, y: 0 }}
  whileTap={{ scale: 0.97 }}
  transition={{ duration: 0.25, ease: MOTION_EASE, delay: index * 0.04 }}
  onClick={() => onOpenChat(agent.id)}
>
```

## Repo conventions to follow

- 参照已有修复：`apps/web/src/components/InboxView.tsx:62` 的 `whileTap={{ scale: 0.97 }}`。
- 按压强度与全站 CSS `:active { transform: scale(0.97) }`（`apps/web/src/styles.css:82-87`）一致，不要改数值。

## Steps

1. `apps/web/src/components/ExploreAgents.tsx`：在 `animate` 之后、`transition` 之前给 `motion.button` 加一行 `whileTap={{ scale: 0.97 }}`。

## Boundaries

- 不要改 styles.css；不要动 TemplatesView/SkillsView 卡片（它们的 `:active` 是否被内联 transform 覆盖需各自实测，本计划只覆盖已确认的 agent-card）。
- 不要加新依赖。

## Verification

- **Mechanical**: `pnpm --filter @pi-workbench/web typecheck && pnpm --filter @pi-workbench/web lint` 全绿。
- **Feel check**: `pnpm dev` 后打开探索页 Agents 视图，按住任一 Agent 卡片——卡片应有可见的 0.97 压缩；松开弹回。DevTools Animations 面板 10% 速度确认缩放在按下瞬间发生。
- **Done when**: agent-card 按下时 scale 生效，且与 InboxView 行的按压手感一致。
