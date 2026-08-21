---
name: Pi 工作台（Fleet 复刻）
description: Fleet 风格多 Agent 聊天工作台的视觉系统，令牌全部来自 Fleet 页面 CDP 实测
colors:
  primary: "#006ddd"
  primary-hover: "#1566b8"
  primary-secondary: "#e5f4ff"
  primary-secondary-hover: "#cce9ff"
  primary-gradient: "linear-gradient(to right bottom, #e5f4ff, #f2faff)"
  info-icon: "#5fbef8"
  text-brand: "#0d3d77"
  text-primary: "#0f172a"
  text-secondary: "#334155"
  text-tertiary: "#475569"
  text-quaternary: "#64748b"
  text-placeholder: "#94a3b8"
  text-disabled: "#cbd5e1"
  bg-primary: "#ffffff"
  bg-secondary: "#f5f8fb"
  bg-secondary-hover: "#edf2f7"
  bg-tertiary: "#edf2f7"
  bg-quaternary: "#e2e8f0"
  border-default: "#cbd5e1"
  border-subtle: "#e2e8f0"
  border-tertiary: "#edf2f7"
  warning-bg: "#fef0c7"
  warning-text: "#cd6002"
  error-bg: "#fef3f2"
  error-border: "#fecdca"
  error-text: "#b42318"
typography:
  display:
    fontFamily: "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.96px"
  headline:
    fontFamily: "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.48px"
  title:
    fontFamily: "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.26px"
  body:
    fontFamily: "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    letterSpacing: "0.5px"
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "40px"
  "8": "48px"
  "9": "64px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.full}"
    size: "26px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    size: "26px"
  button-ghost-hover:
    backgroundColor: "{colors.bg-secondary}"
  nav-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "4px 10px"
    height: "26px"
  nav-row-active:
    backgroundColor: "{colors.primary-secondary}"
    textColor: "{colors.text-brand}"
  card:
    backgroundColor: "{colors.bg-primary}"
    rounded: "{rounded.xl}"
    padding: "24px"
  card-hover:
    backgroundColor: "{colors.bg-secondary}"
  input-field:
    backgroundColor: "{colors.bg-primary}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "0 10px"
  chip-agent:
    backgroundColor: "rgba(124, 58, 237, 0.12)"
    textColor: "#6d28d7"
    rounded: "5px"
    size: "18px"
  capsule-switch:
    backgroundColor: "{colors.bg-primary}"
    textColor: "{colors.text-quaternary}"
    rounded: "{rounded.full}"
    padding: "4px"
  capsule-switch-active:
    backgroundColor: "{colors.primary-secondary}"
    textColor: "{colors.text-brand}"
---

# Design System: Pi 工作台（Fleet 复刻）

## Overview

**Creative North Star: "安静控制台"（The Quiet Console）**

这是一套为高密度操作而生的工具界面：它平静、精确、克制，把全部表达欲让给内容本身。所有视觉决策都以 Fleet（LangSmith 工作台）页面的 CDP 实测值为唯一准绳（`docs/research/fleet-cdp-reference-2026-08-21.md`），不自由发挥配色、密度或圆角。界面是 Operate 模式的工具——扫读性、一致性和平台直觉永远优先于个性表达。

品牌感不住在装饰里，而住在精确的细节中：唯一的信号蓝、统一的 26px 行高节奏、0.5px 字距的全大写标签。它的气质是"打开就会用，用久不觉得累"。

**Key Characteristics:**

- 高密度但平静：12–14px 字号、26px 导航行、4px 基准间距刻度
- 单一品牌色纪律：信号蓝只标记"可行动/已选中"，全屏占比 ≤10%
- 扁平为默认：层次靠背景色阶，投影只属于浮层
- 中文界面 + Inter 字体栈，标题负字距

## Colors

调色板是一套克制的"单品牌色 + 冷灰中性阶"系统，所有色值为 Fleet 实测。

### Primary

- **信号蓝 Signal Blue**（#006ddd）：唯一的行动色。发送按钮、active 导航、聚焦边框、链接、账户徽标渐变终点。它出现即意味着"这里可以行动"。
- **信号蓝·悬停**（#1566b8）：primary 的 hover 加深态，也用作 primary 按钮的 border-color。
- **信号浅底 Signal Wash**（#e5f4ff）：active 导航行 / 选中胶囊的底色，配品牌深蓝文字。
- **信号浅底·悬停**（#cce9ff）：wash 的 hover 加深。
- **品牌深蓝**（#0d3d77）：active 态文字色，永远与信号浅底成对出现。
- **信息青**（#5fbef8）：用量条信息图标、账户徽标渐变起点。

### Neutral

- **纸面白**（#ffffff）：主表面、卡片、输入框底色。
- **雾灰·一级**（#f5f8fb）：hover 底、次级表面、表头底。
- **雾灰·二级**（#edf2f7）：再深一层的表面与侧边栏搜索框。
- **雾灰·三级**（#e2e8f0）：最深层背景与微妙边框共用值。
- **墨色正文**（#0f172a）：一级文字。
- **岩灰阶梯**（#334155 / #475569 / #64748b）：二/三/四级文字，逐级退后。
- **占位灰**（#94a3b8）与**禁用灰**（#cbd5e1）：placeholder 与禁用态。
- **边框三阶**（#cbd5e1 默认 / #e2e8f0 微妙 / #edf2f7 最浅）：输入框用默认，卡片与分隔用微妙，面板间用最浅。

### 状态色

- **警示琥珀**（底 #fef0c7 / 文 #cd6002）：收件箱状态胶囊、重试提示（§11.1 实测）。
- **错误红**（底 #fef3f2 / 边 #fecdca / 文 #b42318）：错误卡片（按同一令牌风格推断，非实测）。

### Named Rules

**The One Voice Rule.** 信号蓝在任意一屏的占比 ≤10%。它的稀有性就是它的意义——如果三个元素同时是蓝的，就删掉两个。

**The Paired Active Rule.** active 态永远是"信号浅底 + 品牌深蓝文字"成对出现，不允许白底蓝字或蓝底白字当 active。

## Typography

**Display / Body / Label Font:** Inter（fallback：-apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif）
**Mono（仅路径/代码）:** ui-monospace, SFMono-Regular, Menlo, monospace

**Character:** 单一无衬线家族打天下，靠字重（400/500/600/700）和负字距标题建立层级；中文界面文案与 Inter 混排，行高取 1.5 保证中英混排呼吸感。

### Hierarchy

- **Display**（500, 24px, 1.2, -0.96px）：欢迎态主标题、探索区页面大标题。全应用最大字，只出现在页面级头部。
- **Headline**（600, 16px, 1.2, -0.48px）：收件箱标题、卡片标题、弹窗标题。
- **Title**（600, 13px, 1.5, -0.26px）：配置面板标题、区块小标题、用量条文字。
- **Body**（400, 14px, 1.5）：默认正文；assistant 消息用 15px/1.75 提升长文可读性。
- **Label**（500, 10px, +0.5px 字距，全大写）：分组头、区块标签（如 "我的 AGENT"、"EXPLORING"）。小、灰、疏，是它的全部。

### Named Rules

**The Shrinking Label Rule.** 层级越低的标签越小越灰越疏——Label 永远是 10px/全大写/+0.5px/四级灰，不许加粗到 600、不许上色。

## Layout

Fleet 是四栏壳层：左侧固定 245px 侧边栏（收起后 44px，导航项变 32×32 纯图标），主区内含可折叠的会话收件箱列（收起只剩 ☰ 按钮）与中央聊天列，右侧按需出现 Files 面板与 479px 配置面板（内嵌式，非遮罩抽屉，左缘 4px splitter）。主内容列居中，对话/表格/网格统一最大宽度 1024px（max-w-5xl），欢迎态输入框 640–672px。

间距节奏是严格的自定义刻度（4/8/12/16/24/32/40/48/64，非线性：space-5 跳到 24、space-9 是 64），组件内距多用 4–16px，页面级留白用 24–64px。列表行高 26px（导航/会话）与 44px（收件箱）两档；配置分节头通栏 48px。密度是设计语言的一部分：不许为了"透气"擅自加大行高。

## Elevation & Depth

扁平为默认：静态表面零投影，层次完全靠背景色阶（纸面白 → 雾灰一级 → 二级 → 三级）和 1px 边框表达。唯一的例外是浮层与弹窗。

### Shadow Vocabulary

- **浮层描边投影**（多层 drop-shadow：四向 1px `border-subtle` 描边 + `0 2px 3px` / `0 6px 12px` 的 5% 黑）：模型菜单等 popover，用 `filter: drop-shadow()` 组实现，描边与投影一体。
- **按钮微影**（`0 1px 2px rgba(16,24,40,0.05)`）：带边框的工具按钮、建议胶囊、active 页签的极浅投影，仅用于把白底控件从白底上托起。
- **弹窗投影**（`0 8px 24px rgba(16,24,40,0.16)`）：模态框专用，配 30% 墨色遮罩。

### Named Rules

**The Flat-By-Default Rule.** 表面静止时必须是平的。投影只作为状态响应出现（浮层、弹窗），卡片默认无影。

## Shapes

小圆角语言：控件 3–4px（按钮、标签页、导航行），输入框 6px，卡片与输入面板 8–12px，胶囊与头像类元素用全圆角。没有直角与超大圆角的极端——几何上是"温和的工具"。Agent 徽标是标志性的 5px 圆角小方块（18×18），大号版本放大到 56×56/12px 圆角。边框统一 1px，绝不加粗。

## Components

### Buttons

- **Shape:** 工具按钮微圆角（4px），发送按钮全圆角（9999px）
- **Primary:** 信号蓝底白字，26×26 圆形（发送）或带边框的 26px 高矩形（头部按钮）；hover 加深为 #1566b8
- **Ghost / Icon:** 透明底、二级灰图标，26×26，hover 雾灰一级底——侧边栏与工具栏的全部图标按钮都长这样
- **禁用:** 极浅灰底（#fafbfd）+ 禁用灰图标，无投影

### Chips

- **Agent 徽标:** 每个 Agent 有专属标识色的小方块 chip，5px 圆角（18px）；Fleet 实测自定义 agent 为紫色系（12% 紫底 `rgba(124,58,237,0.12)` + 35% 紫描边 + `#6d28d7` 字符），内置 agent 用同结构 svg 图标 chip。新增 Agent 时按标识色生成，不许一律用信号蓝
- **状态胶囊:** 全圆角，警示琥珀底+字（收件箱状态）；计数徽标为信号蓝底白字全圆角（14px 高、8px 字）
- **页签:** 3px 圆角、2px padding 的内联 segmented 组（Inbox/Chat 过滤），active 页签白底 + 按钮微影

### Cards / Containers

- **Corner Style:** 温和圆角（12px；技能卡 8px；设置卡 6px）
- **Background:** 纸面白
- **Shadow Strategy:** 默认无影（Flat-By-Default）；探索区 agent 卡的极浅环境影（`0 1px 3px rgba(16,24,40,.1), 0 1px 2px rgba(16,24,40,.06)`）是 Fleet 实测映射，不泛化到其他卡片
- **Border:** 1px 微妙边框（#e2e8f0）
- **Internal Padding:** 页面卡 24px，技能卡 16px
- **直角例外:** Usage 统计卡条是直角无圆角的通栏白条（`overflow-hidden border border-subtle`，卡间以右边框分隔）——Fleet 实测如此，不要给它加圆角

### Inputs / Fields

- **Style:** 1px 默认边框（#cbd5e1）、白底、6px 圆角、30px 高
- **Focus:** 边框变信号蓝，无发光环
- **Composer:** 12px 圆角大输入面板，1px 微妙边框，内嵌工具栏与圆形发送钮；**聚焦时边框与阴影均无变化**（Fleet 实测，无聚焦 ring）；运行中发送钮原位变 Pause，placeholder 变 "Send a message to queue it up..."

### Navigation

- 侧边栏导航行 26px 高、4px 圆角、12px 字；默认透明底墨色字，hover 雾灰一级，active 信号浅底 + 品牌深蓝字 + 500 字重（Paired Active Rule）
- 分组头为 10px 全大写 Label
- 侧边栏整体 245px↔44px 收起展开（0.2s 宽度过渡），收起后导航项 32×32 纯图标、未读徽标仍渲染

### Command Palette（⌘K）

- 顶部对齐弹层（距顶约 18vh）、560px 宽、popover 阴影、大圆角；输入行 44px 高 + 底部分隔线
- 列表分组头沿用 10px 全大写 Label；行 13px，active 行雾灰底；右侧 hint 用四级灰弱提示
- ↑↓ 移动、Enter 执行、Esc 关闭；过滤命中 label 或 hint（大小写不敏感）

### Capsule Switch（签名组件）

- 全圆角白底胶囊组，4px 内边距、2px 间距；选项 10px/600 字，active 项信号浅底 + 品牌深蓝。用于配置面板的二元切换（Thinking 开/关）

## Do's and Don'ts

### Do:

- **Do** 一切视觉数值以 `docs/research/fleet-cdp-reference-2026-08-21.md` 实测为准；新增页面先查该文档再动手。
- **Do** 用背景色阶表达层次：白 → #f5f8fb → #edf2f7 → #e2e8f0，不许发明中间色。
- **Do** active 态遵守 Paired Active Rule（#e5f4ff 底 + #0d3d77 字）。
- **Do** 保持 4px 间距刻度与 26px/44px/48px 三档行高。
- **Do** 动效用 motion 库，时长 0.1/0.2/0.3s 三档，缓动 ease-in-out 或 cubic-bezier(0.23, 1, 0.32, 1)。
- **Do** 浮层用多层 drop-shadow 组（描边 + 投影一体），不要 box-shadow + border 双写。

### Don't:

- **Don't** 发明新品牌色、渐变或强调色；信号蓝是唯一的声音（One Voice Rule）。
- **Don't** 给静态卡片、面板加投影（Flat-By-Default Rule）。
- **Don't** 把 Label 标签加粗、上色或放大——它永远 10px/500/全大写/四级灰。
- **Don't** 使用大于 12px 的圆角（全圆角胶囊除外），没有"圆润可爱"的余地。
- **Don't** 为"透气"降低信息密度；这是工具，不是营销页。
- **Don't** 引入 Inter 之外的界面字体；等宽仅限路径与代码（ui-monospace 栈）。
