# Quant Assistant — Wizard Notebook 原型还原包

本目录用于让 Claude Code 按 `reference-master.png` 实现高保真产品原型。

## 使用方法

1. 将本目录复制到现有前端项目根目录，或只复制 `docs/`、`src/styles/` 与 `public/assets/`。
2. 在 Claude Code 中发送：

   > 阅读 `docs/CLAUDE_CODE_IMPLEMENTATION.md`、`docs/PIXEL_SPEC.md` 和 `docs/COMPONENT_SPEC.md`，以 `reference-master.png` 为唯一视觉母版。保持现有模块、数据接口、字段、路由和业务逻辑不变，只重构表现层。先完成第一阶段，再截图对比，不要一次性自由发挥。

3. 先让 Claude 只完成 Design Tokens（设计变量）和基础容器，再逐模块实现。

## 核心原则

- 图片是最终设计，不是灵感图。
- 不修改模块内容、数据源、字段和业务逻辑。
- 不随机增加装饰。
- 不使用 Emoji（表情符号）充当正式图标。
- 采用真实 HTML（超文本标记语言）与 CSS（层叠样式表），不要把整张页面做成背景图。
- 小型插画可使用 SVG（可缩放矢量图形），图表与数据必须继续由现有组件渲染。
