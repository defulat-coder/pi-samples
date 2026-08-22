# 009 — Composer 提示词面板改为单元素可重定向动画

- **Status**: DONE
- **Commit**: 2cf299c
- **Severity**: MEDIUM
- **Category**: Interruptibility
- **Estimated scope**: 1 file（apps/web/src/components/Composer.tsx），约 10 行

## Problem

`apps/web/src/components/Composer.tsx:141-173` 的提示词面板是 `AnimatePresence` 条件挂载的 height 手风琴，而 `panelOpen` 由**每次击键**派生（`promptQueryFromInput(text)`）。输入/删除 `/` 前缀高频切换时：exit 中途再触发是「旧副本继续退出 + 新副本从 height 0 重新入场」，不是从当前高度重定向；退出期两个副本同时占位造成布局跳变。

```tsx
// apps/web/src/components/Composer.tsx:141-149 — current
<AnimatePresence>
  {panelOpen && (
    <motion.div
      className="prompt-panel"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: MOTION_EASE }}
    >
```

## Target

改为**始终挂载单个元素**，用 `animate` 的值切换驱动开合——motion 对同一元素的动画天然从当前值重定向，不会从零重启：

```tsx
// target — 无 AnimatePresence、无条件挂载、无 exit
<motion.div
  className="prompt-panel"
  initial={false}
  animate={{ opacity: panelOpen ? 1 : 0, height: panelOpen ? 'auto' : 0 }}
  transition={{ duration: 0.2, ease: MOTION_EASE }}
  style={{ overflow: 'hidden', pointerEvents: panelOpen ? 'auto' : 'none' }}
  aria-hidden={!panelOpen}
>
  {/* 内部 JSX 原样保留（label + listbox + 空态），不再包在条件里 */}
</motion.div>
```

要点：
- `initial={false}`：首渲染直接落在当前 animate 值，无入场闪动。
- `height: 0 ↔ 'auto'` 同一元素上切换，motion 支持且会从当前高度平滑重定向。
- `pointerEvents` 和 `aria-hidden` 必须随 panelOpen 切换——收起后面板仍在 DOM，不能挡住下方 textarea 的点击/被读屏读出。
- `overflow: 'hidden'` 是 height 动画期间不溢出的前提；若 `.prompt-panel` 样式里已有 `overflow: hidden`，改为内联补齐或确认 CSS 已有均可。

## Repo conventions to follow

- 曲线/时长不动：`duration: 0.2, ease: MOTION_EASE`（`apps/web/src/lib/motion.ts`）。
- 参照 ConfigPanel 折叠节（`apps/web/src/components/ConfigPanel.tsx:50-55`）的 height 动画参数——但注意那里是条件挂载，本计划的模式（单元素 animate 切换）与它不同，不要照抄结构。

## Steps

1. `apps/web/src/components/Composer.tsx`：删掉包着提示词面板的 `<AnimatePresence>` 和 `{panelOpen && (...)}` 条件，把 `motion.div` 提为始终渲染，按 Target 改写 props；面板内部内容（label、listbox、空态）原样保留。
2. 确认 `AnimatePresence` 在该文件还有 ModelMenu 一处使用（约 :198-207）——不要动它；若移除面板后 `AnimatePresence` 仍被 ModelMenu 使用，import 保留。
3. 检查 `.prompt-panel` 的 CSS（styles.css 中 grep）：若无 `overflow: hidden`，内联 style 已补则无需改 CSS。

## Boundaries

- 不要改面板的过滤/选中/键盘导航逻辑（`onKeyDown`、`applyPrompt`、`activePrompt` 等一律不动）。
- 不要动 ModelMenu 的 AnimatePresence。
- 不要给面板加 scale——height+opacity 即可。

## Verification

- **Mechanical**: `pnpm --filter @pi-workbench/web typecheck && pnpm --filter @pi-workbench/web lint && pnpm --filter @pi-workbench/web test` 全绿。
- **Feel check**: `pnpm dev` 后在输入框里快速输入/删除 `/a`、`/ab`、`/`——面板开合应始终从当前高度平滑过渡，**绝不**从 0 高度重新展开；快速连打时没有双副本占位造成的布局跳变。Esc 收起后马上再输入 `/`，面板从收起中途直接反向展开。收起状态下面板区域可以点击穿透到 textarea。
- **Reduced-motion**: DevTools 模拟 `prefers-reduced-motion: reduce`，面板开合变为瞬时（MotionConfig 负责），opacity 淡入保留。
- **Done when**: 高频击键下面板动画永不从零重启，且 aria/pointer 语义正确。
