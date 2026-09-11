# Component Spec（组件规格）

## NotebookShell（手账页面容器）

负责：背景纸张、页面栅格、纹理、响应式。

## NotebookSidebar（手账侧边栏）

Props（属性）：`items`, `activeKey`, `account`, `darkMode`。

禁止改变现有路由与点击逻辑。

## DoodleCard（手绘卡片）

统一包装现有模块。

Variants（变体）：
- `default`
- `tall`
- `dashed`
- `ticker`

必须支持：`title`, `subtitle`, `icon`, `status`, `footer`, `decoration`。

## EventPanel（事件面板）

现有事件数据原样传入；只改变容器样式。

## TickerCard（行情摘要卡）

沿用后端字段与现有迷你图表组件；禁止使用静态假数据覆盖。

## DataSourceCard（数据模块卡）

用于市场行情、技术指标、宏观、ETF、链上、情绪、衍生品、稳定币、清算、期权。

内容区域由原组件原样渲染，外层负责统一视觉。

## NewsCard（新闻卡）

保持列表长度、标题、来源、时间与跳转行为。卡片允许更高，但禁止截断现有数据逻辑。

## DoodleIcon（手绘图标）

使用本地 SVG（可缩放矢量图形）；不使用 Emoji（表情符号）。

## MagicDecoration（魔法装饰）

仅接受枚举位置：`header-cat`, `sidebar-cat`, `sidebar-bottom`, `etf-coin`, `sentiment-orb`, `derivatives-wand`, `add-book`。

禁止随机生成位置。
