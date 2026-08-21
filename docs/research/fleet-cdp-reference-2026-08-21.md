# LangSmith Fleet 前端 CDP 抓取参考（复刻用）

> 抓取快照：2026-08-21（Asia/Shanghai）。本文所有数值均来自 ego-browser CDP 对已登录 Fleet 工作台的 `getComputedStyle()` 实测与 DOM 层级抓取，不是截图目测。原始 JSON 与全页截图存于 `.scratch/fleet-cdp/`。
>
> 抓取环境：视口 1496×846，浅色主题，页面 `eu.smith.langchain.com`（org `831f7197-…`）。Fleet 前端是 Tailwind v4（utility class + `:root` 设计变量，共 535 个 CSS 自定义属性）。

## 一句话结论

Fleet 是一个四栏工作台：固定 245px 左侧导航（白底 + 1px 右侧分隔线）＋ 可折叠会话收件箱列 ＋ 中央聊天列（`max-w-5xl` 居中内容）＋ 右侧 Files / Agent configuration 面板。视觉体系是「白底层级 + 极浅灰蓝表面（#f5f8fb / #edf2f7）+ 单一品牌蓝 #006ddd」，圆角体系 3/4/6/8/12px，字号体系 10/12/13/14/16/24px，间距为自定义语义刻度 4/8/12/16/24/32/40/48/64px。复刻时应先落地这套令牌，再按区域组装。

## 1. 设计令牌（实测值）

### 1.1 颜色（`:root` CSS 变量原值）

| 用途 | 变量 | 值 |
| --- | --- | --- |
| 页面/面板主背景 | `--bg-primary` / `--bg-elevated` | `#fff` |
| 一级灰蓝表面（卡片、hover） | `--bg-secondary` / `--bg-surface-level-2` | `#f5f8fb` |
| 一级 hover 加深 | `--bg-secondary-hover` / `--bg-surface-level-2-hover` | `#edf2f7` |
| 二级表面（进度条轨道等） | `--bg-tertiary` / `--bg-surface-level-3` | `#edf2f7` |
| 三级表面 | `--bg-surface-level-4` | `#e2e8f0` |
| 品牌主色（按钮、徽标、链接图标） | `--bg-brand` / `--bg-brand-primary` | `#006ddd` |
| 品牌 hover | `--bg-brand-hover` | `#1566b8` |
| 品牌浅底（active 导航） | `--bg-brand-secondary` | `#e5f4ff` |
| 品牌浅底 hover | `--bg-brand-secondary_hover` | `#cce9ff` |
| 品牌渐变底（用量条） | `--bg-brand-subtle-gradient` | `linear-gradient(to bottom right, #e5f4ff, #f2faff)` |
| 品牌深文字（active 导航文字） | `--text-brand-primary` | `#0d3d77` |
| 主文字 | `--text-primary` | `#0f172a` |
| 次文字 | `--text-secondary` | `#334155` |
| 三级文字 | `--text-tertiary` | `#475569` |
| 四级弱文字（组头、说明） | `--text-quaternary` | `#64748b` |
| 占位符 | `--text-placeholder` | `#94a3b8` |
| 禁用 | `--text-disabled` | `#cbd5e1` |
| 链接 | `--text-link` | `#0078f1` |
| 主边框 | `--border-default` / `--border-primary` | `#cbd5e1` |
| 次级边框（卡片描边，最常用） | `--border-secondary` / `--border-subtle` | `#e2e8f0` |
| 三级边框（侧边栏分隔线） | `--border-tertiary` | `#edf2f7` |
| 聚焦边框 | `--border-focus` | `#006ddd` |
| 成功文字 | `--text-success-primary` | `#047647` |
| 状态点 | `--border-status-green/orange/red/yellow` | `#0edc5e` / `#f9b072` / `#fda29b` / `#ffd268` |
| 品牌色阶 | `--brand-10…950` | `#f2faff … #101a30`（`--brand-400 = #006ddd`） |
| 语法高亮字符串 | `--syntax-string` | `#15803d` |

图标色：`--icon-primary #0f172a` / `--icon-secondary #334155` / `--icon-tertiary #64748b`。滚动条 thumb `--scrollbar-thumb: #0000004d`。

### 1.2 圆角 / 阴影 / 动效

| 令牌 | 值 | 典型用途 |
| --- | --- | --- |
| `--radius-xs` | 3px | 过滤器小按钮、迷你图标按钮 |
| `--radius-sm` | 4px | 导航项、agent 行、账户行、icon 按钮 |
| `--radius-md` | 6px | 用量条、下拉面板、New 按钮 |
| `--radius-lg` | 8px | 搜索框 |
| `--radius-xl` | 12px | composer 外框、配置卡片、用户消息气泡 |
| `--radius-full` | 9999px | 发送按钮、未读徽标、Auto/Ask 胶囊开关 |

阴影（浮层不用 `box-shadow`，用 `filter: drop-shadow` 组合模拟 1px 描边 + 柔和投影）：

- 下拉面板实测 class：`[filter:drop-shadow(0_1px_0_var(--border-secondary))_drop-shadow(0_-1px_0_...)_drop-shadow(1px_0_0_...)_drop-shadow(-1px_0_0_...)_drop-shadow(0_2px_3px_var(--shadow-color-subtle))_drop-shadow(0_6px_12px_var(--shadow-color-subtle))]`
- 令牌值：`--shadow-color-subtle: #1018280d`；`--shadow-sm: 0 1px 3px #1018281a, 0 1px 2px #1018280f`；`--shadow-md/lg` 同色系放大
- 实体按钮（如 New Thread）实测阴影：`rgba(16,24,40,0.05) 0px 1px 2px 0px`

动效：`--duration-fast: .1s` / `--duration-normal: .2s` / `--duration-slow: .3s` / `--duration-slower: .5s`；导航项 hover 用 `transition-colors duration-300 ease-in-out`；工具卡片入场 `animate-in fade-in slide-in-from-bottom-1 duration-200 ease-out`；侧边栏折叠 `transition-[width] duration-200`；composer 外框 `transition-all duration-200 ease-in-out`。

### 1.3 字号体系（class → 实测）

| class | 实测字号/行高/字距 | 用途 |
| --- | --- | --- |
| `text-[10px] uppercase tracking-wider` | 10px / 15px / +0.5px | EXPLORE、MY AGENTS 组头 |
| `text-xxs leading-[1.15]` | 12px / 13.8px | agent 名、会话计数、Recommended 徽标、副说明 |
| `text-xs leading-tight tracking-snug` | 13px / 15.6px / −0.26px | 用量条文字、账户名/邮箱、配置卡片标题 |
| `text-sm leading-normal` | 14px / 21px | composer 输入与 placeholder、模型选项名 |
| `text-sm leading-[1.15] tracking-tighter` | 14px / 16.1px / −0.56px | 工具调用名、按钮文字（lc-button sm） |
| `text-base leading-tight tracking-tight` | 16px / 19.2px / −0.48px | 面板大标题（Chat、Authenticate Google） |
| `text-base leading-relaxed` | 16px / 26px | 用户消息正文 |
| `text-2xl font-medium` | 24px / 32px | 「Ask anything」（无字距） |
| `text-2xl tracking-tighter` | 24px / 28.8px / −0.96px | 「Start a chat with …」 |

字重：400 正文 / 500 medium（导航 agent 名、次级标题）/ 600 semibold（active agent 名、卡片标题、账户名）/ 700 bold（会话行标题）。

全局字体：`Inter, -apple-system, "system-ui", "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", …`（body 实测）。

### 1.4 间距体系（`space-*` 自定义刻度，实测）

`space-1=4 · space-2=8 · space-3=12 · space-4=16 · space-5=24 · space-6=32 · space-7=40 · space-8=48 · space-9=64`（单位 px）。注意不是线性 4n：5 跳到 24，9 是 64。Tailwind 只编译用到的类，未用到的 `space-10+` 不在产物中。

常用外边距：页面级水平 padding 用 `px-2`(8px，侧边栏内层) / `px-space-4`(16px，主区) / `px-space-6`(32px，消息列)。

## 2. 整体布局

```
body (font: Inter) 
└─ div.h-screen
   └─ main.relative
      ├─ header.fixed.h-[100vh].w-[245px]     ← 侧边栏，bg-elevated(#fff)，border-r border-r-tertiary，pt-3 pb-3，gap-1.5
      └─ div.relative.min-w-0.flex-1          ← 主区（margin-left 245px，白底）
         ├─ div.flex.h-full.flex-col          ← 会话收件箱列（可折叠为只剩 ☰ 按钮）
         ├─ div.relative.min-w-0.flex-1       ← 中央聊天列
         │   ├─ 用量条容器 div.px-space-4.pt-space-4
         │   └─ 内容区（空态居中 / 消息流 max-w-5xl 居中 / composer 置底）
         ├─ div 右侧面板：Files（w-0 起，展开出现 border-l）
         └─ aside[role=complementary]「Agent configuration」（w-0 起，configure=true 时 479px）
```

- 侧边栏实测：245×846，固定定位，`border-right: 1px solid #edf2f7`，上下 padding 12px。
- 中央消息列内容容器：`div.relative.mx-auto.w-full.max-w-5xl.pb-space-9.pt-space-4.px-space-6`（最大宽 1024px 居中，上 16 / 下 64 / 左右 32）。
- 消息滚动容器：`div.flex.h-full.flex-col.overflow-y-auto.overflow-x-hidden.overscroll-contain`。
- 会话收件箱列折叠后只剩一个 ☰ 按钮（`hamburger`，26px 区域）；展开时含标题（agent 名或 "Chat"）、Hide inbox 按钮、All/Attention 过滤器、会话列表。

## 3. 侧边栏（从上到下）

### 3.1 工作区切换行（"Fleet ⌄"）

- 按钮：`button.lc-button`，68×26 @ (8,16)，`text-sm`（14px / 16.1px / −0.56px），padding 4px，gap 6px，圆角 4px，内含 Fleet 图标 svg + 下拉 chevron。
- 右侧折叠按钮：`button[aria-label="Collapse (⌘B)"]`，26×26，padding 4px，圆角 4px，图标色 `--icon-secondary`。

### 3.2 搜索框

- `flex h-[26px] items-center gap-2 rounded-lg bg-tertiary/60 px-2.5`：229×26，圆角 8px，背景 `#edf2f7` 60% 透明，文字/图标色 `--text-quaternary`(#64748b)，hover `bg-tertiary`（不透明）。
- 内含放大镜 svg + "Search..." + 右侧 `⌘ K` chip（kbd，inline-flex gap-4px，同色）。

### 3.3 导航项（Chat / Inbox / Usage / Settings / EXPLORE 子项同构）

- 行：`a.group.h-[26px].rounded-sm.px-2.5.py-1.transition-colors.duration-300.ease-in-out`，229×26，圆角 4px，padding 4px 10px。
- 图标 12×12（`h-3 w-3`，stroke 1.8px）。
- 默认态：透明底，`text-primary`(#0f172a)。
- hover 态：背景 `#f5f8fb`（`hover:bg-secondary`，实测 `color(srgb 0.9608 0.9725 0.9843)`）。
- active 态（Chat）：背景 `#e5f4ff`（`bg-brand-secondary`），文字/图标 `#0d3d77`（`text-brand-primary`），hover 保持同色。
- Inbox 未读徽标：14×14 圆形（`h-3.5 min-w-3.5 rounded-full`），背景 `#006ddd`，数字 8px / 500 / 白色（`text-xxs` 特例 `fontSize:8px`），padding 0 2px。

### 3.4 组头（EXPLORE / MY AGENTS）

- 行容器：`div.flex.items-center.px-2.5.py-1`（229×23；MY AGENTS 行 26px 高因含右侧 + 按钮）。
- 按钮 `flex flex-1 items-center gap-1`：chevron（6×3 path，色 64748b，可旋转）+ 文字 `text-[10px] font-medium uppercase tracking-wider text-quaternary`（10px / 15px / +0.5px / #64748b）。
- MY AGENTS 右侧 "New agent" 按钮：18×18，`rounded-xs`(3px)，背景 `#f5f8fb`，padding 2px，hover 背景 `#edf2f7` 且图标色变 `#334155`（实测 hoverNew）。

### 3.5 agent 行

- 行：`a.group.flex.h-[26px].items-center.gap-3.rounded-sm.px-2.5.py-1.hover:bg-secondary`，229×26，gap 12px。
- 图标 chip：18×18，圆角 5px（`rounded-[5px]`），1px 边框；自定义 agent（"PC"）实测背景 `rgba(124,58,237,0.12)` + 边框 `rgba(124,58,237,0.35)`，字母 8px/600/`#6d28d7`。内置 agent（Executive Assistant）用 svg 图标同色 chip 结构。
- 名称：`text-xxs`（12px/13.8px），默认 500，当前 agent 600，truncate。
- 右侧未读徽标同 Inbox（14×14 蓝底白字）。

### 3.6 底部账户区

- Usage / Settings 行同导航项规格（26px 高）。
- 账户按钮：229×52，`rounded-sm`，padding 8px 10px，gap 12px，hover `bg-secondary`。
  - 头像 36×36，圆角 4px，背景渐变 `linear-gradient(to right bottom, rgb(33,145,140), rgb(170,170,170))` 上叠加照片（`bg-cover`）。
  - 名称 `text-xs font-semibold text-primary`（13px/600/#0f172a）；邮箱 `text-xs text-quaternary`（13px/#64748b），均 `tracking-snug`。

## 4. 顶部用量条

- 外容器 `div.px-space-4.pt-space-4`（主区顶部，左右 16px、上 16px）。
- 条本体：1219×59.8，`rounded-md`(6px)，背景渐变 `linear-gradient(to right bottom, #e5f4ff, #f2faff)`，padding 12px 16px，`gap-space-2`(8px)，1px 透明边框。
- 左侧 Info 图标 16×16，色 `#5fbef8`（brand-100）。
- 文案 `text-xs font-medium text-primary`（13px/500/#0f172a），`mr-space-2`。
- 进度条：轨道高 8px、圆角 3px、背景 `#edf2f7`（`bg-surface-level-3`）；填充 `linear-gradient(to left, #5ba1ff, #b1d2ff)`，同圆角，`transition-[width] duration-normal ease-out`。
- 右侧计数 "13/50"：`text-xxs font-medium`（12px/13.8px/500）。

## 5. 空态欢迎区（无会话）

- 垂直居中：`div.flex.flex-1.flex-col.items-center.justify-center.px-space-4.pb-space-9`（左右 16、底部 64）。
- 内容列 `max-w-screen-sm`（640px）居中，内部 `gap-space-5`(24px)。
- 标题「Ask anything」：`h1.text-2xl.font-medium`（24px/32px/500/#0f172a）。
- 集成图标行：`div.relative.w-full.max-w-[40rem].overflow-hidden`，高 20px；22 个 svg 各 20×20（`size-5`），每个包在 `px-space-5`（左右各 24px）的 wrapper 里；视口外图标 opacity 0（实测 x=−114 的 wrapper）——是横向无限滚动 marquee，悬停整行可暂停/交互（`cursor-pointer transition-all duration-slow`）。
- 自定义 agent 变体（如 pi coding agent）：大号字母 chip + 标题「Start a chat with {name}」（24px/28.8px/−0.96px/500）+ Tip 框（"Tip!" 12px/600/#475569 + 说明文字），composer placeholder 变为 "Write your message..."，且无模型选择器（只有 Actions + Send）。

## 6. 输入框 composer

- 外框：`div.rounded-xl.border.bg-background.transition-all.duration-200.@container.border-subtle`，640×100，圆角 12px，1px 边框 `#e2e8f0`，白底，无阴影。**聚焦态实测边框/阴影均无变化**（`07-composer-focus.json`，focused=true 前后 border 均为 `1px solid #e2e8f0`）。
- 输入区：不是 `<input>`，是 `div[contenteditable][data-testid="chat-input"]`，`px-space-4 pb-space-2 pt-space-4`（16/8/16），`text-sm leading-6`（14px/24px），`min-h-12 max-h-[25vh] overflow-y-auto`，`outline-none`。
- placeholder：独立的 `aria-hidden` 绝对定位 div（`pointer-events-none select-none`），`text-sm leading-6 text-placeholder`（#94a3b8），与输入区同 padding。
- 底部工具条：`div.flex.items-center.justify-between.gap-space-2.px-space-4.pb-space-3.pt-2.5`（16/12/10）。
  - "+" Actions 按钮：26×26，padding 4px，圆角 4px，透明底，图标 16px stroke 1.5，色 #334155；hover `bg-elevated-hover/80`。
  - 模型选择器「Default ⌄」：`lc-button` 111.5×27，padding 4px 8px，gap 6px，圆角 4px，白底；图标 16px（LangChain 标，`#030710`）+ 文字 `text-sm`（14px/#334155）+ chevron 16px（#64748b）。
  - 发送按钮：26×26 圆形（`rounded-full`），禁用态背景 `#fafbfd`、箭头图标 16px 色 `#cbd5e1`；agent 运行中时被「Pause」按钮替代（同位）。

### 6.1 模型下拉（点 Default 弹出）

- 结构：`<dialog>` 内 `div.rounded-md.bg-popover.w-40`（160px 宽）+ listbox（`max-h-[18.75rem] p-1.5`，overflow-y-auto）。面板阴影用 drop-shadow 组合（见 §1.2），圆角 6px，白底。位置在触发按钮下方。
- 组标签：`text-xxs text-quaternary block px-2.5 pb-space-1 pt-0.5`（12px/#64748b），两组：Fleet / External。
- 选项行：`role=option`，148×33.6，`rounded-md`(6px)，padding 6px 10px，gap 8px；`aria-selected` 项背景 `#f5f8fb`，hover 同背景。
  - 内容：名称 `text-sm`（14px/#0f172a）+ 副标签（如 "Free" 13px/500/#047647 绿）+ 右侧 16px 选中勾（选中项 opacity-100）。
  - 选项：Fleet 组 Default(Free)/Fast/Pro/Max；External 组 Sonnet 4.6/Sonnet 5/Opus 4.8/Opus 4.7。
- Escape 或点外部关闭。

### 6.2 "/" 技能面板

- 触发：在空 composer 输入 `/`，面板**内联在输入框上方**（composer 内部、非浮层），容器 `div.relative.overflow-hidden.max-h-72`，实测 286×167。
- 顶部 "SKILLS" 标签（小字组头风格）+ 滚动列表（`max-h-[inherit] overflow-y-auto`）。
- 技能行 button：286×55.8，`flex items-center gap-space-3 px-space-3 py-space-2`（12px 横向、8px 纵向，gap 12px）；键盘选中项背景 `#f5f8fb`（`bg-surface-level-2`），其余透明，hover 同背景。
  - 行内：16px 图标（#64748b）+ 文字列（技能名 `email-drafting` 等 + 描述截断）。
- 清空输入框后面板消失（已验证还原）。

## 7. 会话视图（含消息）

### 7.1 会话列表（收件箱列）

- 分组标题："TODAY" / "YESTERDAY" / "THIS WEEK"（heading，小组头风格）。
- 会话行：button `flex min-w-0 flex-1 text-left` 高 20px，标题 `h3.text-sm.font-bold.truncate`（14px/20px/700/#0f172a）；带 skill 的会话前有 14×14 图标（#64748b）。
- 行尾 "Thread actions" 按钮：20×20，padding 2px，圆角 3px（`rounded-xs`）。
- 过滤器 All / Attention：`rounded-xs`(3px)，padding 2px 8px，gap 4px，高 19.6px；active 文字 #0f172a，inactive #334155（`hover:bg-surface-…`）。

### 7.2 会话头部与工具栏

- 线程打开后顶部右侧：「+ New Thread」（主按钮：背景 #006ddd、白字、圆角 4px、padding 4px 8px、边框 #1566b8、阴影 `0 1px 2px rgba(16,24,40,.05)`）、「Files」「Configure」（次级白底按钮，1px `#e2e8f0` 边框 + 同阴影，13px/−0.26px）。
- 线程标题区：标题（如 "Onboard"，heading）+ agent chip（svg + 名称）。标题动画：进入时按字母拆 span 逐个入场（实测标题容器为逐字母 span 结构）。

### 7.3 用户消息气泡

- 行容器：`div.flex.w-full.justify-end`（右对齐）；消息列 `div.group.max-w-[70%].flex-col.items-end`（最大宽 70%）。
- 气泡：`div.mt-space-4.rounded-xl.rounded-br-none.border.border-subtle`，背景 `#f5f8fb`，圆角 12px **右下角 0**，1px 边框 `#e2e8f0`，padding 8px 12px。
- 正文：`p.m-0.whitespace-pre-wrap.text-base.leading-relaxed`（16px/26px/#334155）。
- 长消息截断 + "See more ⌄" 按钮（`text-xs text-tertiary hover:text-primary`，13px/#475569）。
- 气泡下方右侧 "Copy" 图标按钮（26×26，hover 显现，group 机制）。

### 7.4 assistant 侧内容

- 折叠的工具执行摘要：button 183.8×24，圆角 6px；左侧堆叠工具图标（20×20 白底圆角 6px + 1px 边框的小 chip 叠放）+ "Read File"（14px/#475569）+ "+4 more"（#64748b）+ "Executed 5 actions"（`tracking-tighter`，#64748b）+ 右侧 12px chevron（平时 opacity-0，`group-hover` 显现）。状态图标路径色 `#cd6002`（橙）。
- 展开的单工具卡片：`div.flex.w-fit.max-w-full.flex-col.animate-in.fade-in.slide-in-from-bottom-1.duration-200`。
  - 头部 button（26px 高，gap 6px）：工具图标 + 状态图标 + 名称（`text-sm tracking-tighter text-tertiary`，14px/16.1px/−0.56px/#475569）。
  - "ARGUMENTS" / "RESULT" 标签：小字组头风格（大写、弱色）。
  - 参数 JSON 查看器：key 用 `.object-key`（13px/18px/+0.5px/#002b36），字符串值 `--syntax-string`(#15803d)，行内树形图标。
  - 结果块：`overflow-auto rounded-sm border border-default text-xs max-h-[15rem]`（圆角 3px、边框 #cbd5e1、最高 240px 滚动），带行号 + "Copy result" 图标按钮。
- 认证卡片（「Authenticate Google」）：标题行 16px 锁图标 + `h3.text-base.font-semibold`（16px/600/−0.48px）；副文本 "Tools: …"（13px/#64748b）；说明段；账号选择行（Google chip + "Not connected" 下拉按钮）+ 通栏「Resume」按钮（白底 bordered）。
- 任务进度条（composer 上方）：button 通栏 44px 高，`grid grid-cols-[auto_auto_1fr_auto] gap-space-3 px-space-4 py-space-3`；展开 chevron + 状态图标 + "Task 1 of 4"（14px/#0f172a）+ 当前任务标题（14px/#64748b truncate）。

### 7.5 队列中 composer

agent 运行中 placeholder 变为 "Send a message to queue it up..."，发送按钮变为「Pause」。

## 8. 右侧 Files 面板与 Agent configuration 面板

- Files 面板：默认 `w-0` 隐藏，展开后出现 `border-l`（#e2e8f0）。头部 "Files" 按钮 + Close panel；搜索框（无边框透明底，13px placeholder #94a3b8）；List/Grid view 切换（26×26 图标按钮）；「New」菜单按钮（白底 bordered 13px）。空态：居中图标 + "Your workspace is empty"（13px/500/#334155）+ 说明 + 「New file」（主按钮蓝）/「Upload」（次按钮白）。
- Agent configuration（`aside[role=complementary]`）：`configure=true` 时展开，宽 479px，白底，左侧有 4px 宽 splitter（`cursor-col-resize hover:bg-brand-100` #5fbef8）。
  - 头部：返回按钮（32×32 圆角 8px，禁用态 `cursor-not-allowed`）+ 标题 "Untitled agent"（13px/600/#0f172a）+ 「View ⌄」（13px 按钮）+ 关闭（26×26）。
  - 内容滚动区：`overflow-y-auto pb-space-4 [&>*+*]:border-t border-subtle`（section 之间 1px 分隔线）。
  - section 折叠头（Connections/Knowledge/Schedules/Advanced settings）：通栏 48px 高 button，padding 12px，gap 12px；左侧 16px 图标 + 标题（13px/600）+ 右侧 16px chevron（#64748b，`transition-transform`，hover 变 #475569）。
  - 内容卡片：`rounded-xl border border-subtle bg-surface-level-2`（圆角 12px、边框 #e2e8f0、底 #f5f8fb），卡片内左右 padding 12px。
  - 卡片标题 `text-xs font-semibold`（13px/600/#0f172a）；描述 `text-xxs text-tertiary leading-relaxed`（12px/19.5px/#475569）；空态文案（"No instructions yet." 等）13px/#475569，padding 12px。
  - "Input needed" 徽标：黄色系（`text-warning` 系，截图 #fef0c7 底 + #ac5305 文字风格）。"Recommended"：12px/500/#047647（绿文字无底色）。
  - Shared / Per-user 选项行：左侧 14px radio 图标（#334155）+ 标题（13px/500）+ 副说明（12px/#334155），右侧单选圆点。
  - Memory 区「Auto / Ask」胶囊开关：外层 `rounded-full border border-subtle bg-surface-level-1 p-space-1`（白底、圆角 9999、padding 4px，115×30）；选项 button 圆角 9999、padding 4px 8px、10px/600；选中项（Ask）白字深色/带色底（截图呈淡黄底），未选中 #64748b。

## 9. 交互行为汇总

| 交互 | 实测行为 |
| --- | --- |
| 导航项 / agent 行 hover | 背景 → `#f5f8fb`，300ms ease-in-out；active 项 hover 保持 `#e5f4ff` |
| "New agent" + hover | 背景 `#f5f8fb` → `#edf2f7`，图标色 #64748b → #334155 |
| 侧边栏折叠 | ⌘B 或 Collapse 按钮，`transition-[width] duration-200`；收件箱列可折叠为 ☰ |
| composer 聚焦 | 外框边框/阴影实测无变化（无聚焦 ring） |
| 模型选择器 | 点击弹出 160px 宽 dialog 下拉，Escape 关闭；选中项 `#f5f8fb` 底 + 右侧勾 |
| 输入 `/` | 输入框上方内联展开 SKILLS 面板（非浮层），清空即收起 |
| 工具卡片 | 入场 fade-in + slide-in-from-bottom-1 200ms；摘要行 chevron 仅 group-hover 显现 |
| 用户消息 Copy 按钮 | 仅 hover 消息行时显现（group 机制） |
| 线程标题 | 进入会话时标题逐字母入场动画 |
| 集成图标行 | 横向 marquee 无限滚动，视口外图标 opacity 0 |
| splitter | configuration 面板左缘 4px 拖拽条，hover 变 #5fbef8 |

## 10. 复刻要点清单

1. **先建令牌**：颜色（§1.1）、圆角 3/4/6/8/12/9999、字号 10/12/13/14/16/24（注意 xxs=12、xs=13 的非标映射）、间距 4/8/12/16/24/32/40/48/64、动效 0.1/0.2/0.3/0.5s。字体 Inter。
2. 侧边栏固定 245px 白底 + `#edf2f7` 右分隔线；导航行统一 26px 高、圆角 4px、padding 4px 10px；active = `#e5f4ff` 底 + `#0d3d77` 字。
3. 所有"组头"（EXPLORE / MY AGENTS / ARGUMENTS / RESULT / SKILLS）共用一种弱色小字风格：10–12px、500、`#64748b`、大写（10px 时 +0.5px 字距）。
4. 未读徽标统一 14px 蓝圆点（#006ddd + 8px 白字）。
5. composer 用 contenteditable + 独立 placeholder 层；外框 12px 圆角 + `#e2e8f0` 边框 + 无阴影；聚焦不改边框。发送按钮 26px 正圆，禁用态 `#fafbfd` 底 + `#cbd5e1` 图标。
6. 浮层面板（模型下拉）用 `bg-popover` + 6px 圆角 + drop-shadow 组模拟描边投影，不要用粗 box-shadow。
7. 用户消息气泡：`#f5f8fb` 底、12px 圆角右下去角、1px `#e2e8f0` 边框、右对齐 max-w-70%；assistant 内容无气泡，直接排版 + 工具卡片。
8. 用量条是渐变浅蓝横幅（6px 圆角）+ 8px 高渐变进度条（轨道 `#edf2f7`，填充 `#5ba1ff→#b1d2ff` 向左渐变）。
9. 配置面板是 479px 右侧内嵌面板（非遮罩抽屉），section 折叠头 48px + 12px 圆角灰蓝卡片（#f5f8fb）+ section 间 1px 分隔线。
10. 图标体系：线性 svg，常用 12/14/16/20px 四档，stroke 1.5–1.8px，弱色 `#64748b`。

## 附录：原始数据文件（`.scratch/fleet-cdp/`）

| 文件 | 内容 |
| --- | --- |
| `01-chat-empty.sidebar.json` | 侧边栏全部元素 + 535 个 `:root` CSS 变量 |
| `01-chat-empty.main.json` | 主区：用量条/空态/composer/Files 面板 |
| `01-chat-empty.hover.json` | 导航项、agent 行、New agent 的 hover 前后对比 |
| `01-chat-empty.model-dropdown.json` / `10-model-dropdown-container.json` | 模型下拉选项与浮层容器 |
| `01-chat-empty.skills-panel.json` | "/" 技能面板 |
| `02-configure.json` | Agent configuration 面板 |
| `03-thread-view.json` / `05-thread-messages.json` / `06-thread-auth-task.json` | 会话视图：列表行、用户消息、工具卡片、认证卡、任务条 |
| `04-pi-agent-empty.json` | 自定义 agent 空态变体 |
| `07-composer-focus.json` | composer 聚焦前后对比 |
| `08-misc-fixups.json` / `09-headers-usage.json` | composer 外框、组头、徽标 chip、头像等补抓 |
| `01-chat-empty.png` … `08-thread-auth-task.png` | 各状态全页截图（1496×846） |

## 未抓到 / 存疑项

- **assistant 纯文本回复气泡**：现有历史会话里没有一条普通 assistant 文字消息（线程都停在工具调用/认证等待/引导流程），无法实测其排版；从 DOM 推断 assistant 内容无气泡、直接左对齐排版。
- **启用态发送按钮**：未实际输入有效消息发送，启用态背景色未实测（按令牌推断为 `#006ddd`）。
- **"Fleet" 工作区切换菜单**、**Search ⌘K 面板**、**New agent 创建流程**：未展开，避免产生副作用（用量计数在抓取期间因线程打开从 13 涨到 15，属页面正常行为）。
- 时间戳：会话行与消息上均未渲染可见时间戳（分组靠 TODAY/YESTERDAY 标题承担）。
