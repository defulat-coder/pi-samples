# 003 — 会话回合与欢迎建议的入场动画

- **Status**: DONE
- **Commit**: b7993df
- **Severity**: MEDIUM
- **Category**: Missed opportunities + Cohesion（stagger）
- **Estimated scope**: 1 file（`apps/web/src/App.tsx`），小改

## Problem

`ConversationStream`（`apps/web/src/App.tsx:476`）里用户消息、`AgentTurn` 回合都是瞬现 —— 每发一条消息都有一次硬切。欢迎屏建议问题（`apps/web/src/App.tsx:1290` `.welcome-suggestions`）成组同时出现，缺 30–80ms 的 stagger。

要求：**只给新出现的回合做动画**。切换历史会话时整批消息不能逐个重放（一次几十条会很糟）。

## Target

- 新回合 mount：`opacity 0 → 1`、`translateY(4px) → 0`，180ms，ease `cubic-bezier(0.23, 1, 0.32, 1)`（JS 侧数组 `[0.23, 1, 0.32, 1]`）。
- 首屏已存在的消息：`initial={false}`，不动画。
- 欢迎建议：`y: 6 → 0` + fade，180ms，逐项 `delay: index * 0.05`。

## Repo conventions to follow

- 已装 `motion@13.1.0`（`motion/react`），现有用例：`apps/web/src/App.tsx:687` 会话行 `motion.div` + `AnimatePresence`；`App.tsx:70` 有 `motionEase` 常量（计划 004 会把退出缓动统一成 `[0.23, 1, 0.32, 1]`，本计划直接用该数组常量，若 004 已执行则用它的新常量名）。
- 根上已有 `<MotionConfig reducedMotion="user">`（`App.tsx:1350`），无需另写媒体查询。

## Steps

1. `apps/web/src/App.tsx` `ConversationStream`：给每个回合根节点包 `motion.div`（key 用消息 id），`animate={{ opacity: 1, y: 0 }}`，`transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}`。
2. 用 `useRef` 记录首次渲染时已存在的消息 id 集合（effect 前 snapshot），首屏存在的传 `initial={false}`，之后新增的传 `initial={{ opacity: 0, y: 4 }}`。组件内部加 `useEffect` 把新 id 补进集合。
3. 欢迎建议按钮（`App.tsx:1290` 附近）：换成 `motion.button`，`initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, delay: index * 0.05, ease: [0.23, 1, 0.32, 1] }}`。

## Boundaries

- 只加 mount 动画，不动消息结构、流式渲染逻辑、`stream-process.ts`。
- 不给命令面板、tab 切换、树行加动画（高频，规范禁止）。
- 不引入新依赖。

## Verification

- **Mechanical**: `pnpm typecheck && pnpm lint && pnpm test` 全绿。
- **Feel check**: `pnpm dev` 后发一条消息 —— 用户气泡与数字人回合轻微上浮淡入；切换到一个长历史会话 —— 所有消息直接呈现，无逐个重放；新开会话看欢迎屏 —— 建议项逐个错开浮现（50ms 间隔）；`prefers-reduced-motion` 下无位移（MotionConfig 生效）。
- **Done when**: 上述成立。
