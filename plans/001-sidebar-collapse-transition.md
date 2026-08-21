# 001 — 侧栏收起/展开加过渡动画

- **Status**: DONE
- **Commit**: b7993df
- **Severity**: HIGH（高可见度的状态瞬移）
- **Category**: Missed opportunities
- **Estimated scope**: 2 files（`apps/web/src/App.tsx`、`apps/web/src/styles.css`），小改

## Problem

侧栏在展开（`--workspace-width: clamp(248px, 22vw, 300px)`）与收起（rail `--workspace-rail: 44px`）之间瞬间硬跳，rail 与面板内容也无任何交叉淡入。这是每次 ⌘B / 点切换按钮都会看到的 jarring change。

当前代码：

```tsx
// apps/web/src/App.tsx:842 附近 —— aside 二选一渲染，无过渡
<aside id="project-workspace" className={open ? 'workspace-panel' : 'workspace-panel workspace-panel-collapsed'} ...>
  {open ? (<div className="workspace-panel-content">…</div>) : (<nav className="workspace-rail">…</nav>)}
</aside>
```

```css
/* apps/web/src/styles.css —— 无 width 过渡 */
.workspace-panel { ... width: var(--workspace-width); min-width: 240px; max-width: 380px; ... }
.workspace-panel-collapsed { width: var(--workspace-rail); min-width: var(--workspace-rail); max-width: var(--workspace-rail); resize: none; }
```

注意：面板带 `resize: horizontal`，**不能**给 `.workspace-panel` 常驻 `transition: width`（拖resize手柄会卡顿）。

## Target

只在切换瞬间过渡宽度，用 drawer 曲线；rail / 面板内容进场带轻微淡入：

```css
/* 切换瞬间才挂的过渡类 */
.workspace-panel-animating { transition: width .2s var(--ease-drawer), min-width .2s var(--ease-drawer), max-width .2s var(--ease-drawer); }
/* 内容/rail 进场淡入 */
.workspace-panel-content { animation: workspace-fade-in .16s var(--ease-out); }
.workspace-rail { animation: workspace-fade-in .16s var(--ease-out); }
@keyframes workspace-fade-in { from { opacity: 0; } to { opacity: 1; } }
```

`--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`、`--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` 由计划 004 提供；若 004 未执行，先在 `:root` 内联这两个变量。

JS 侧：切换时挂 `.workspace-panel-animating`，220ms 后摘掉（`setTimeout`，清理 ref 防泄漏）。

## Repo conventions to follow

- 动画时长/曲线只用 CSS 变量令牌（计划 004 在 `:root` 定义 `--ease-*`）。
- 现有 reduced-motion 块在 `apps/web/src/styles.css:543` 附近，新动画必须在那里登记关闭。

## Steps

1. `apps/web/src/styles.css`：新增 `@keyframes workspace-fade-in`、`.workspace-panel-animating`、给 `.workspace-panel-content` 和 `.workspace-rail` 加 `animation: workspace-fade-in .16s var(--ease-out)`。
2. reduced-motion 媒体查询块内追加：`.workspace-panel-animating { transition: none !important; }`、`.workspace-panel-content, .workspace-rail { animation: none !important; }`。
3. `apps/web/src/App.tsx` `WorkbenchApp`：`toggleOpen` 包一层 —— 给 `#project-workspace` 元素 `classList.add('workspace-panel-animating')`，`setTimeout(() => classList.remove(...), 220)`；用 ref 存 timer，卸载时 clear。⌘B 快捷键与按钮点击都走同一入口（`setWorkspaceOpen` 的两处调用点合并为一个 `toggleWorkspace` 函数）。

## Boundaries

- 不动 rail / 面板内部结构与样式，只加过渡。
- 不引入新依赖。
- 若代码与 commit b7993df  drift 导致步骤对不上，停下报告，不要即兴发挥。

## Verification

- **Mechanical**: `pnpm typecheck && pnpm lint && pnpm test` 全绿。
- **Feel check**: 运行 `pnpm dev`，反复按 ⌘B / 点收起按钮：
  - 宽度在 ~200ms 内顺滑收缩/展开，无瞬跳；
  - 快速连按不会从 0 重启动画（CSS transition 可从中间态 retarget）；
  - 拖动 resize 手柄无粘滞感（确认 animating 类已摘除）；
  - Rendering 面板开 `prefers-reduced-motion`：宽度瞬间切换、无淡入。
- **Done when**: 上述全部成立。
