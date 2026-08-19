# React 页面动效方案调研（2026-08-19）

## 结论

这份调研讨论的是 React 网页/产品界面的组件进出场、布局变化、列表增删、手势、滚动和页面切换，不包括 Remotion 或视频生成。

对当前 `pi-samples`，建议以 **Motion（包名 `motion`，原 Framer Motion）作为唯一主引擎**，保留现有 CSS transition 处理简单 hover、focus、press；只有将来出现复杂滚动叙事、SVG/Canvas/WebGL 或长时间线时，再按页面引入 GSAP。AutoAnimate 可以作为列表场景的极简备选，但没有必要和 Motion 同时进入首轮 PoC。

综合推荐顺序：

1. **Motion**：新 React 产品界面的默认选择。
2. **GSAP + `@gsap/react`**：复杂时间线、ScrollTrigger、SVG/Canvas/WebGL 的专项选择。
3. **react-spring**：物理弹簧和连续交互很强，但一般产品 UI 的接入心智高于 Motion。
4. **AutoAnimate**：只想让列表增删/排序自然移动时，成本最低。
5. **Anime.js**：优秀的通用 JS 动画引擎，适合命令式时间线、SVG 和非 React 复用，不是 React 生命周期的首选抽象。
6. **原生 View Transition API / React Router View Transitions**：适合页面级切换，值得跟进，但 React 自带 `<ViewTransition>` 截至本次核验仍是 Canary/Experimental。
7. **React Transition Group**：适合维护存量，不建议新项目作为主方案。

## 热度数据快照

数据在 2026-08-19 读取。GitHub Star、最近 push 和许可证来自 GitHub REST API；npm 下载量来自 npm 官方 `downloads/point/last-month` API，区间为 2026-07-20 至 2026-08-18。下载量包含直接安装和传递依赖，不能单独代表新项目主动选择。

| 方案 | GitHub Star | npm 近 30 日下载 | 当前版本/活跃信号 | 定位 |
| --- | ---: | ---: | --- | --- |
| [Motion](https://github.com/motiondivision/motion) | 33,284 | [70,072,402](https://api.npmjs.org/downloads/point/last-month/motion) | `motion@13.1.0`，2026-08-10 修改；仓库当天仍有 push | React 声明式 UI 动效全能主引擎 |
| [react-spring](https://github.com/pmndrs/react-spring) | 29,133 | [23,003,597](https://api.npmjs.org/downloads/point/last-month/%40react-spring%2Fweb) | `@react-spring/web@10.1.2`，官方 v10 文档明确面向 React 19 | 物理弹簧、连续交互、多渲染目标 |
| [GSAP](https://github.com/greensock/GSAP) | 27,835 | [18,256,717](https://api.npmjs.org/downloads/point/last-month/gsap)；[`@gsap/react` 5,298,876](https://api.npmjs.org/downloads/point/last-month/%40gsap%2Freact) | `gsap@3.15.0`；插件现已免费，但使用 GSAP Standard License | 复杂时间线、滚动、SVG/Canvas/WebGL |
| [AutoAnimate](https://github.com/formkit/auto-animate) | 13,901 | [5,302,591](https://api.npmjs.org/downloads/point/last-month/%40formkit%2Fauto-animate) | `0.10.0`，2026-07-10 修改 | 列表/布局变化的一行式增强 |
| [Anime.js](https://github.com/juliangarnier/anime) | 72,247 | [4,614,717](https://api.npmjs.org/downloads/point/last-month/animejs) | `4.5.0`，2026-08-17 修改 | 框架无关、命令式时间线、SVG/WAAPI |
| [React Transition Group](https://github.com/reactjs/react-transition-group) | 10,229 | [235,344,110](https://api.npmjs.org/downloads/point/last-month/react-transition-group) | npm 最新版 `4.4.5` 发布于 2023-06；只管理 transition state/class | 存量 React 进出场控制器 |

`react-transition-group` 的下载量非常高，但 npm 下载 API 无法区分直接安装和依赖树带入；结合三年未发版及其“不是动画引擎”的官方定位，不能把该数字解释为 2026 年新项目首选。

## 核心候选

### 1. Motion：当前项目首选

[Motion for React 官方文档](https://motion.dev/docs/react)覆盖 `motion.*`、`AnimatePresence`、手势、滚动、SVG 和布局动画；`layout`/`layoutId` 可以让 React render 引起的位置和尺寸变化通过 transform 动画完成，[官方布局文档](https://motion.dev/docs/react-layout-animations)还说明了共享元素、可中断性和滚动容器处理。

适合当前项目的能力：

- `AnimatePresence`：聊天视图与文件预览、toast、菜单、空状态的 enter/exit。
- `layout` / `layoutId`：会话列表增删、活动 tab 指示、文件树展开后的重排。
- React 状态驱动：不需要手动查询 DOM 或维护清理逻辑。
- `MotionConfig reducedMotion="user"`：官方提供全局 reduced-motion 策略；transform 和 layout 动效会在用户偏好降低动效时关闭，参见[无障碍文档](https://motion.dev/docs/react-motion-config)。
- `motion@13.1.0` 的 npm peer dependency 明确接受 React 18 或 19，和当前 React 19.1.1 兼容。

限制：完整 API 比纯 CSS 更重；不应把每一个 hover 都改成 Motion，也不应在流式 token 每次追加时触发布局测量。

### 2. GSAP：复杂场景专项引擎

GSAP 的优势是命令式控制、timeline 和跨 DOM/SVG/Canvas/WebGL 的统一能力。官方 [React 指南](https://gsap.com/resources/React/)建议使用 `@gsap/react` 的 `useGSAP()`，由 `gsap.context()` 自动清理组件卸载时的动画；[ScrollTrigger](https://gsap.com/docs/v3/Plugins/ScrollTrigger/)支持 pin、scrub、snap 和复杂滚动时间线。

适合：营销页、沉浸式 onboarding、长滚动叙事、SVG 路径、Canvas/WebGL、需要精确同步的多段 timeline。

不适合当前首轮：Pi Workbench 是稳定的单屏 PC 产品界面，不是滚动叙事站。用 GSAP 处理普通 React 状态切换会引入 refs、scope、cleanup 和命令式同步成本。GSAP 现在全部插件可免费商用，但不是 MIT，而是[标准 no-charge license](https://gsap.com/standard-license/)，法务口径应单独记录。

### 3. react-spring：物理交互强项

[react-spring v10 文档](https://react-spring.dev/docs)把它定位为交互式、数据驱动动画库；[安装页](https://react-spring.dev/docs/getting-started)明确 React 19 使用 `@react-spring/web` v10。它还能覆盖 Three.js 和 React Native 风格的渲染目标。

适合：弹簧物理、可拖动/可中断交互、数值连续变化、需要在 web/three/native 间保持相似模型的团队。

对当前项目，它没有明显胜过 Motion 的场景；若只是列表、面板和消息进出场，API 心智和动画状态管理会更重。

### 4. AutoAnimate：列表增强最省事

[AutoAnimate 官方文档](https://auto-animate.formkit.com/)说明 React 可通过 `@formkit/auto-animate/react` 的 `useAutoAnimate` 把 ref 放到父元素上；直接子元素的增加、删除和移动会自动过渡。它会自动尊重 `prefers-reduced-motion`。

优点是成本极低，适合会话列表、标签、表单校验消息和简单 accordion。限制也很明确：只观察父元素的直接子元素；复杂 flex 尺寸、精确编排、离场语义和跨组件共享元素不如 Motion。

### 5. Anime.js：优秀但不是 React-first

Anime.js v4 的[官方 React 指南](https://animejs.com/documentation/getting-started/using-with-react/)要求在 `useEffect()` 中创建 `createScope()`；Scope 能统一清理并处理 media queries，[官方 Scope 文档](https://animejs.com/documentation/scope/)也提供 reduced-motion 模式。其模块化 API、timeline、SVG、WAAPI 和 draggable 能力很强。

如果同一套动画要跨 React 与 Vanilla JS 复用，或主要对象是 SVG/DOM timeline，Anime.js 很有吸引力；如果主要对象是 React 条件渲染和布局变化，Motion 更直接。

### 6. View Transition：观察，不作为当前基线

React Router 已提供 `Link`/`NavLink`/`Form` 的 `viewTransition` 开关和 `useNavigate({viewTransition: true})`，参见[官方指南](https://reactrouter.com/how-to/view-transitions)。但当前仓库没有 React Router。

React 自带的 [`<ViewTransition>`](https://react.dev/reference/react/ViewTransition) 可以覆盖 enter/exit/shared element/Suspense，但官方页面截至本次核验仍标注 **Canary**。当前项目使用 React 19.1.1 stable，不应为了动效切换到 Canary。

### 7. React Transition Group：只用于存量

[官方文档](https://reactcommunity.org/react-transition-group/)明确说它不是动画库，只暴露组件进出场阶段、管理 class 和 DOM 生命周期。它仍可用于已有 CSS transition 体系，但缺少 Motion 的布局、手势、滚动和共享元素抽象。结合 npm 最新发布停在 2023 年，不建议作为新接入的主方案。

## “很热门的组件库”不是动效引擎

| 项目 | GitHub Star | 形态 | 当前项目判断 |
| --- | ---: | --- | --- |
| [React Bits](https://github.com/DavidHDev/react-bits) | 45,802 | 165+ 动画组件，按 JS/TS、CSS/Tailwind 复制代码；MIT + Commons Clause | 可挑单个 CSS/TS 组件借鉴；不是统一 runtime，且需检查 Commons Clause 边界 |
| [Magic UI](https://github.com/magicuidesign/magicui) | 22,001 | 面向 React/Next/shadcn/Tailwind 的 copy-paste 动画组件，MIT | 当前项目不用 Tailwind/shadcn，不适合整套接入；可参考个别效果 |
| [Motion Primitives](https://github.com/ibelick/motion-primitives) | 6,010 | 基于 Motion 的可复制 UI primitives，MIT | 比营销型特效库更接近产品 UI，可作为实现参考，但主依赖仍是 Motion |

这些仓库能说明“哪些效果正在流行”，不能替代对底层引擎、包体、许可和无障碍的选择。

## X 平台信号

X 搜索页在本次访问中强制登录，因此没有把站内搜索排序或互动量当成完整样本。公开索引到的帖子只作为定性补充：

- Motion 官方仍在持续发布动画开发工具，例如 [Motion Studio 帖子](https://x.com/motiondotdev/status/1991850490762764453)。
- React 社区的新项目/提示词中已出现明确使用新包名 `motion/react` 的案例，例如[该 React Router 多页面动效案例](https://x.com/Aurelien_Gz/status/2036183052460716315)。
- GSAP 的公开案例更集中在沉浸式导航、3D、parallax、ScrollTrigger 和 pinned section，例如[官方 showcase](https://x.com/greensock/status/1967619880087416952)与[社区 React/ScrollTrigger 案例](https://x.com/rupesh30_21/status/1949086734270050696)。

这与 GitHub/官方能力边界一致：Motion 更像日常 React UI 基础设施，GSAP 更像高控制力的复杂场景引擎。

## `pi-samples` 集成建议

当前 `apps/web` 是 React 19.1.1 + Vite 7.1.3，未使用 Router、Tailwind 或 shadcn。`styles.css` 已经有大量 180–240ms 的 hover/focus/press transition、侧栏 grid transition、pulse/spin keyframes，并完整处理了 `prefers-reduced-motion`。因此应增量接入，不重写现有 CSS。

### 推荐的首轮 PoC

安装：

```bash
pnpm --filter @pi-workbench/web add motion
```

在应用根部设置：

```tsx
import { MotionConfig } from 'motion/react';

<MotionConfig reducedMotion="user">
  <App />
</MotionConfig>
```

只改四类状态切换：

1. `ResourceViewer` 与 `conversation-stage` 的切换：`AnimatePresence mode="wait"`，160–220ms fade + 4–8px 位移。
2. `SessionList` 的新增/删除/当前项变化：列表项 `layout`，离场用 `AnimatePresence`。
3. 工作区“会话/项目文件”tab：共享 `layoutId` 的活动背景或下划线。
4. `error-toast`、composer 菜单、文件树 children：短 enter/exit，避免内容突然出现或消失。

继续用 CSS 的部分：button hover/active、颜色、border、focus ring、刷新 icon、typing dots、侧栏 grid 宽度。不要给 Markdown 流式文本、thinking delta 或 tool event 的每次追加套 `layout`，否则高频 render 会导致不必要的测量和视觉抖动。

### 验收标准

- 不改变现有业务状态和 SSE 流协议。
- reduced-motion 下不发生大位移或 layout transform；内容仍立即可用。
- 动画可被连续点击打断，不残留透明、禁用或 pointer-events 状态。
- 会话流式输出期间不掉帧、不改变自动滚动行为。
- PC 视口优先验证；当前仓库默认不扩展移动端适配范围。

## 最终选择

如果现在就集成：**安装 `motion`，做一个集中在视图切换与列表布局的薄 PoC；不要同时引入 GSAP、react-spring 或完整动画组件库。** 这能覆盖当前最明显的产品动效缺口，并保留以后按单页加入 GSAP 的空间。
