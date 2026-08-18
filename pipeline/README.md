# Quant Pipeline — 数据源采集层

这是"真实跑通"的第一步：只做数据源的采集、聚合、程序侧过滤与权重预算控制。**不调用任何 LLM**——摘要层和策略层留到下一步。

## 架构原则（对应本次讨论的约定）

1. **多采集，少输入**：`sources/*.ts` 里的 fetcher 尽量把能拿到的都拿到（`itemsRaw`），是否精简只发生在 `filter.ts` 这一层，且只受权重驱动。
2. **新闻按事件聚合，不按文章输入**：`news/cluster.ts` 用关键词重叠做去重聚类，把"3 家媒体报道同一件事"合并成 1 条 event，而不是 3 条重复的文章标题。
3. **权重同时影响策略贡献和上下文预算**：`weights.ts` 的 `computeTokenBudget()` 就是这个约定的落点——同一份 `weight` 数字，将来在策略页驱动贡献分数，这里驱动 token 预算，两处应该读同一个权重配置（目前 pipeline 用的是自己的 `DEFAULT_WEIGHTS`，和 prototype 的权重是手工保持一致，还没打通成同一份配置，见下方"已知欠账"）。
4. **主 AI 每次分析原则上只调用一次**：本阶段体现为——所有来源最终汇总成*一个* `ContextPackage` JSON（`out/context-package.json`），而不是每个来源各发一次请求。真正接主模型时，应该是拿着这一份包一次性调用。
5. **程序负责计算和过滤，轻量模型负责摘要，主模型负责策略**：本阶段只做了"程序计算和过滤"（`filter.ts` + 各 `sources/*.ts` 里的指标计算，比如技术面 RSI/MACD 是本地算的，没有调用第三方指标 API）。摘要层、策略层是下一步，接口边界已经留出来了（`ContextPackage` 就是要喂给摘要层的输入）。
6. **所有输入都有数量、长度、Token 上限**：`caps.ts` 的 `SOURCE_CAPS`（每源最大条数、每条最大字符数）+ `GLOBAL_TOKEN_BUDGET`（全局 token 预算）。
7. **必须保留反方向证据**：`filter.ts` 的 `orderByPolarityRoundRobin()`——按 bullish/bearish/neutral 轮询排序后再截断，保证"只有 3 条名额但两边都存在信号"时不会被裁成清一色。`counterEvidencePreserved` 字段可以直接检验这条有没有被满足。
8. **低权重减少输入，零权重不进入分析**：`filter.ts` 里 `weight <= 0` 直接返回空结果并标注"权重为 0，不进入分析"；权重越低，`computeTokenBudget()` 分到的预算越少（有一个 `MIN_TOKENS_IF_NONZERO_WEIGHT` 下限，避免权重很低但非零的源被四舍五入成 0）。

## 数据源目录（11 个，对应 prototype 首页的 11 张卡片）

| 数据源 | 提供方 | 是否需要 Key | 本次状态 |
|---|---|---|---|
| 市场行情 | Binance 公开行情 API，失败自动退到 OKX | 不需要 | ✅ 真实数据 |
| 技术指标 | Binance K线 + 本地计算 RSI/MACD/SMA，失败自动退到 OKX K线 | 不需要 | ✅ 真实数据（指标是程序算的，不调用第三方指标API） |
| 市场情绪 | Alternative.me Fear & Greed Index | 不需要 | ✅ 真实数据 |
| 衍生品数据 | Binance 合约公开 API（资金费率/持仓量/多空比），失败自动退到 OKX | 不需要 | ✅ 真实数据 |
| 稳定币数据 | DefiLlama Stablecoins API | 不需要 | ✅ 真实数据 |
| 期权数据 | Deribit 公开 API（BTC/ETH 期权） | 不需要 | ✅ 真实数据 |
| 新闻资讯 | Cointelegraph / CoinDesk / Decrypt 官方 RSS | 不需要 | ✅ 真实数据（按事件聚合） |
| 链上数据 | BTC 半边：mempool.space（不需要 key）<br>ETH 半边：Etherscan | BTC 不需要，ETH 需要免费 Key | ✅ 真实数据（Etherscan Key 已配好） |
| 宏观经济 | FRED（CPI、联邦基金利率）+ Xoomar（经济日历：FOMC/CPI/NFP/GDP 等事件日期与影响等级） | 两个都需要免费 Key，都已配好 | ✅ 真实数据 |
| ETF 资金流 | 自建 SQLite（Δ份额×NAV，见下方"ETF 资金流数据库"）+ Xoomar `/etf-flows`（补充 ticker） | 自建部分不需要 Key；Xoomar 已配好 | 🟡 IBIT/BITB/ETHW 真实数据，其余 6 个 ticker 还没有份额数据源 |
| 清算数据 | 之前的自建 WebSocket 采集方案已删除（2026-08-05），见下方"清算数据"一节，方案重新设计中 | — | ⚪ 暂未接入，等新方案 |

**你需要做的事（可选，不做也能跑，只是那些源会是 stub）：**
- ~~注册 FRED / Etherscan / Xoomar 免费 Key~~ 已完成，`.env` 里都配好了
- 注册 [Coinglass](https://www.coinglass.com/pricing)（确认清算历史接口在哪个价位）→ 填入 `.env` 的 `COINGLASS_API_KEY`；第一次用真 Key 跑 `npm run fetch` 时如果 `liquidation` 变成 `error` 而不是 `ok`，大概率是 `sources/liquidation.ts` 里猜的字段名跟实际返回对不上，把报错内容发我就能改

## Xoomar（2026-08-05 评估记录）

用户找到的一个第三方聚合 API（xoomar.com/developers），免费、不注册也能用（30次/分钟/IP），注册后 120次/分钟。评估结论——**不是整体可信或整体不可信，是逐个接口验证**：

- ✅ `funding-rates`：和我们自己独立验证过的 Binance 数据交叉核对，数字对得上，可信。
- ✅ `calendar`：经济日历（FOMC/CPI/非农/GDP 等），日期看着合理，已接入 `sources/macro.ts`。
- 🟡 `etf-flows`：结构合理，但目前只覆盖 2 个 ticker（BITB、ETHW）且资金流字段一直是 null，已接入 `sources/etf.ts` 作为补充，覆盖面有限。
- ❌ `liquidations`：返回 24 小时全网爆仓 **484 亿美元**，这个数量级不合常理（正常应该是几千万到几亿，极端行情也就一两亿到十几亿）；用 API Key 认证后重新请求、加 `period` 参数都拿到几乎一样的数字，说明不是随机故障，是他们那边这个指标本身有问题。**故意没有接入任何地方**，见 `src/util/xoomar.ts` 里的说明。

以后如果要用 Xoomar 的其他接口，请重复这个"跟已知可信数据源交叉核对"的验证流程，不要因为其中几个接口验证通过就默认整个 API 都可信。

## 已知欠账（留给你确认，我没有擅自做主）

- **权重配置目前是两份**：`prototype/index.html` 的 `WEIGHT_DEFS` 和这里的 `weights.ts` 手工保持一致，还没有抽成一份共享配置。如果以后这两个项目要合并成一个真实应用，这里需要打通。
- **`DEFAULT_WEIGHTS` 是我按原型的默认值抄过来的**，不是从真实的 Research Input 页面读取的——目前 pipeline 是独立可运行的命令行工具，还没有和 prototype 的用户操作打通。
- **摘要层、策略层完全没有实现**，`ContextPackage` 就是设计给它们用的输入，但目前只是写到一个 JSON 文件里，没有下一步动作。

## 怎么跑

```bash
cd pipeline
npm install
npm run fetch                              # 用默认权重跑一次，控制台打印报表 + 写 out/context-package.json
npm run fetch -- --weights=news:0          # 演示"零权重不进入分析"：新闻源会被完全排除
npm run fetch -- --weights=technical:1     # 演示"低权重压缩输入"：技术面条数/token 会被压得很小
npm run typecheck                          # 仅类型检查
```

## 本地服务（供 prototype/ 前端使用）

`npm run fetch` 是一次性命令行工具，用于验证数据源本身。`prototype/index.html` 的首页卡片走的是另一条路——一个常驻的本地 HTTP 服务：

```bash
cd pipeline
npm run serve       # 默认监听 http://localhost:8787
```

**为什么前端不直接调交易所/RSS**：一是部分接口（RSS 新闻源、FRED）没开 CORS，浏览器直接调用会被拦截；二是任何写进静态页面的 API Key 都会被任何打开页面的人在 devtools 里看到；三是如果 Binance 在你的网络/地区被墙，那是网络层面的限制，浏览器端和本地后端调用会遇到一样的问题——只有换供应商（比如 OKX）才能绕开，而不是"是否经过后端"。所以现在 `market`/`technical`/`derivatives` 三个来源会先试 Binance，失败了自动退到 OKX（同样免 Key），并在返回里标注实际用的是哪个供应商。

**接口**：
- `GET /health`
- `GET /api/sources` — 全部 11 个来源的 `SourceResult`（`prototype/` 首页用这个）
- `GET /api/sources/:key` — 单个来源
- `GET /api/prices` — 精简的 `{symbol, price, changePct}[]`，供前端同步 `ASSETS`（交易相关计算要用到真实价格，不只是首页卡片展示）

内存缓存 20 秒，避免每次前端刷新都把 11 个来源全部重新打一遍上游接口。

**前端这边**：`prototype/index.html` 里 `BACKEND_URL` 常量写死指向 `http://localhost:8787`；后端没启动时，11 张卡片会诚实地显示"⚠ 连接失败"+ 真实报错文字，不会用编好的数字顶替（这是特意做的，不是没做完）。

## ETF 资金流数据库（2026-08-05 新增）

Farside/SoSoValue 都走不通（见上表），改成自建：每天定时拉一次「份额数」+「NAV/收盘价」，自己算资金流，存本地 SQLite（`node:sqlite`，Node 内置模块，不需要装 better-sqlite3 之类的原生依赖，Windows 上不会遇到编译问题）。

**计算方法**：`资金流 = (今天份额数 - 昨天份额数) × 今天收盘价`。这是业内通用算法，Farside 等第三方追踪器用的也是这个思路。第一次给某个 ticker 建快照时没有"昨天"可比，那天的 `fund_flow_usd` 是 `NULL`，不是 0——0 意味着"今天没有资金流入流出"，那是一个真实的数据陈述，跟"我们还没有可比数据"是两回事，不能混着来。

**目前覆盖**：9 个 ticker 已注册（`src/etf/tickers.ts`），份额数据源（`src/etf/issuers/`）只接通了 iShares（IBIT 已验证跑通）。Fidelity、Grayscale、ARK、Bitwise、VanEck 的份额数据在哪个页面、什么格式，2026-08-05 当天没有逐个查完，先留空，返回时会诚实报告"这个 ticker 的发行商 adapter 还没实现"，不是拿旧数据充数。要接通某个发行商：找到它官网基金页面里 Shares Outstanding 的位置，写一个新的 `src/etf/issuers/<issuer>.ts`，参考 `ishares.ts` 的模式。

**NAV 用收盘价代理**：没有直接调用官方 NAV 接口，用的是 Yahoo Finance 的收盘价（`src/etf/yahooFinance.ts`，直接调 `query1.finance.yahoo.com`，没有引入 Python/yfinance，保持整个项目单一运行时）。真实 NAV 和收盘价会有微小溢价/折价，但套利机制让两者非常接近，这也是大多数第三方资金流统计的做法。

**每日定时**：Windows 任务计划程序，任务名 `QuantPipeline-EtfSnapshot`，每天 22:00 跑一次 `npm run etf:snapshot`，已经注册并手动触发验证过真的能跑通、能写库。查看/修改：

```powershell
Get-ScheduledTask -TaskName "QuantPipeline-EtfSnapshot"
Get-ScheduledTaskInfo -TaskName "QuantPipeline-EtfSnapshot"   # 看上次运行结果
Unregister-ScheduledTask -TaskName "QuantPipeline-EtfSnapshot" -Confirm:$false   # 要删掉的话
```

**手动跑一次**：`npm run etf:snapshot`（不用等到 22:00，随时可以手动补一次当天的快照）。

数据库文件在 `pipeline/data/etf_flows.sqlite`，已加入 `.gitignore`。

## 中文翻译（2026-08-05 新增）

新闻标题、经济日历事件名原本都是英文（RSS 源和 Xoomar 都是英文）。`src/util/translate.ts` 用一个免费但非官方的 Google 翻译端点（很多"免费翻译"库底层用的就是这个，没有 Key，也没有官方 SLA，可能随时被限流/失效）做翻译，失败时直接返回原文，不会让整张卡片挂掉。有内存缓存，同一段文字同一进程生命周期内只翻一次。

- 新闻：`sources/news.ts` 只翻译聚类后的事件标题（聚类本身仍然用原始英文关键词匹配，翻译发生在那之后），`detail` 字段里保留了英文原文方便核对。
- 宏观日历：`sources/macro.ts` 先查一个小词典（`EVENT_NAME_CN`，覆盖 FOMC/CPI/非农等常见项，即时且不依赖网络），词典没有的才走翻译接口。

## TOTAL MKT CAP（2026-08-05 新增）

首页右上角原来是写死的模拟数字，现在接了 CoinGecko 的 `/api/v3/global`（免费、不需要 Key）。新增了一个独立的 `/api/marketcap` 接口（`server.ts`），跟 11 个数据源分开，因为这不是仪表盘卡片，是首页顶部那个单独的 ticker。同样遵守"连不上就诚实显示失败，不残留假数字"的规则。

## 新闻源管理（2026-08-06 新增，同日两次跟进：内置列表接真实数据 → 全量真实 CRUD 后端）

首页"新闻资讯"卡片右上角加了个设置齿轮按钮，打开新闻源管理弹窗（列表 + 添加新闻源向导）。**现在整个模块都是真实的**：增/删/改/启用禁用/抓取频率，全部真实写入后端 SQLite（`db.ts` 的 `news_sources` 表），不再有任何 localStorage 兜底。

**存储**：`news_sources` 表（复用 `data/etf_flows.sqlite`，跟 `snapshots`/`liquidation_events` 同一个库）。字段：`id/name/url/type/category/origin/enabled/fetch_interval_minutes/lookback_hours/created_at/last_fetched_at/last_status/last_item_count/last_error`。`origin`（`builtin`|`custom`）只是前端展示"内置"徽章用的信息位，不限制任何操作——用户明确要求内置源也要能真删除。首次启动时用 `sources/news.ts` 的 `BUILTIN_SEED`（Cointelegraph/CoinDesk/Decrypt）播种一次，之后表非空就不会再覆盖用户的增删改。

**接口**（`server.ts`）：
- `GET /api/news-sources` — 真实列表（含 `last_status`/`last_item_count`/`last_fetched_at`，来自实际抓取，不是自己单独造的假状态）
- `POST /api/news-sources` — 新增；`isSourceFetchable(type,url)` 为真时，落库前会真的抓一次（`fetchArticlesForSource()`，RSS 或对应的交易所解析器），跟"测试并保存"同一套逻辑，测试失败直接拒绝，不会保存一个测试不通过的源
- `PATCH /api/news-sources/:id` — 编辑；只要请求体带了 `url` 或 `type`（即向导的"测试并保存"提交），同样会重新真实测试一次；只改 `enabled`（表格上的开关）不会触发测试，避免每次开关都多一次网络往返
- `DELETE /api/news-sources/:id` — 真删除，内置源也不例外
- `GET /api/news-sources/test?url=` 保留，用于向导内的独立预检

**真正被抓取的是哪些**：`sources/news.ts` 导出 `isSourceFetchable(type, url)` 作为唯一判断标准——`rss`/`official` 永远可抓（走通用 RSS/Atom 解析）；`api` 只有当 url 命中已知的交易所适配器才可抓；`scrape` 永远不可抓。`fetchNews()` 用这个函数筛出真正会被拉取的行，按各自的 `fetch_interval_minutes` 节流（进程内 `Map` 缓存，不跨重启持久化）、按各自的 `lookback_hours` 过滤新闻新鲜度，聚合进首页新闻流。

**三个交易所公告的真实解析器（2026-08-06 同日跟进）**：用户给了一份"预设新闻源"清单（10 个），实测后发现 Binance/Coinbase/OKX/Bybit 都没有公开 RSS；进一步实测找到 Binance/OKX/Bybit 各自真实可用的 JSON 公告接口（Coinbase 博客被 Cloudflare 拦截，没找到），于是写了 3 个专用解析器（`fetchBinanceAnnouncements`/`fetchOkxAnnouncements`/`fetchBybitAnnouncements`），按 url 特征匹配路由：
- Binance：`binance.com/bapi/composite/v1/public/cms/article/list/query?...`（CMS 公告 JSON，非官方文档但公开可用）
- OKX：`okx.com/api/v5/support/announcements`（官方 v5 公开 API）
- Bybit：`api.bybit.com/v5/announcements/index?...`（官方 v5 公开 API）

这 3 个不是通过 `type` 字段判断是否可抓，而是 `isSourceFetchable()` 直接用 url 特征匹配——同样声明 `type:'api'` 的其它自定义地址依然诚实地"暂不支持抓取"，不会被误判为可抓。真实验证过：新闻流里能看到这 3 个源的真实文章（`来源：Binance Announcements` 等）。

**预设源目录**（`prototype/index.html` 的 `NEWS_SOURCE_PRESETS`，前端静态数组）：10 个手工实测过的候选源（CoinDesk/Cointelegraph/The Block/Decrypt/SEC/Federal Reserve/Binance/OKX/Bybit + 一个明确标"未找到真实接口"的 Coinbase Blog 占位），"浏览预设源"入口点开是一个勾选列表，点"添加"直接触发真实 POST（不需要走三步向导，因为源信息已知），已添加的显示"已添加"禁止重复添加。**没有为这个目录单开后端接口**——纯前端静态列表 + 复用现有的 `POST /api/news-sources`，因为列表内容是精心策划的展示型内容，不是需要动态查询的数据。

**故意没做的**：向导原本有个"保留历史"下拉框，去掉了——新闻现在完全是实时聚合，从来没有逐条持久化存储，"保留历史"没有东西可依附，留着就是"UI 有但不生效"的问题，所以直接删掉而不是假装它管用。`api`/`scrape` 两种类型除了这 3 个交易所之外仍然没有通用抓取方案（网页结构/接口格式因站点而异），继续诚实标"暂不支持抓取"。

## Ticker 数字自动刷新（2026-08-06 新增）

首页顶部那 3 张 ticker 卡片（BTC/ETH/TOTAL MKT CAP）现在每 20 秒自动刷新一次数字，不用再手动点"刷新实时数据"。范围刻意收得很窄——按用户原话"只要数字跳动就可以了"：

- 只更新 `#ticker-strip` 这一小块 DOM（`prototype/index.html` 的 `refreshTickerPrices()` + `renderTickerStrip()`），不调用 `render()`，不会打断用户在别处的操作（打开的弹窗、正在输入的搜索框都不受影响，jsdom 验证过）
- 迷你走势图（sparkline）不跟着动——只重画数字本身，图表刷新是单独的、更大的工作量，这次不做
- 复用已有的 `/api/prices` + `/api/marketcap`，没有新增后端接口；这两个接口后端已经各自有独立缓存，前端 20 秒轮询不会导致额外的外部 API 压力
- 离开 Dashboard 路由（`#ticker-strip` 不存在）或标签页切到后台（`document.hidden`）时自动跳过，不做无意义请求

## Connector → Normalize → Snapshot 架构（2026-08-05 新增，DATA_SOURCE_SPEC.md）

项目根目录新增了一份冻结 spec `DATA_SOURCE_SPEC.md`，要求把 Dashboard 每个模块都升级成 Overview Card + Detail Page + 结构化 Snapshot + 历史图表，并且"任何 API 响应都必须先变成结构化对象，UI/Research/AI 都只读这个对象，不直接依赖某个具体 provider"（Golden Rule）。跟你确认后：**先在 Market 模块上把这套架构跑通，作为其他模块的样板；Snapshot 复用现有 `data/etf_flows.sqlite`，不新开数据库文件。**

分层：
- **Connector**（`src/connectors/`）：只管"怎么从某个 provider 拿原始数据"，返回类型化但未加工的字段。`connectors/types.ts` 定义了 `MarketConnector` 接口（`fetchTicker24h`/`fetchKlines`），`connectors/binanceMarketConnector.ts` 是目前唯一实现。以后要加 OKX/Bybit 作为 Market 的另一个 provider，只需要新写一个实现同一接口的文件，不用改 `sources/market.ts` 或前端。
- **Normalize**（`src/normalize/market.ts`）：把 Connector 的原始字段转成固定形状的 `MarketSnapshot`（`source/symbol/timestamp/status` + 价格/涨跌幅/成交量/最高最低/买一卖一），以及本地计算的 `computeVolatilitySeries()`（14 周期滚动收益率标准差，K线数据本地算，不调用任何指标 API，跟"技术指标"模块的原则一致）。
- **Snapshot 存储**（`db.ts` 新增 `snapshots` 表，字段 `source/symbol/timestamp/status/data(JSON)`，通用表，不是 Market 专用）：`sources/market.ts` 每次拉 ticker 时，对每个 symbol 顺手 `insertSnapshot('market', symbol, ts, 'ok', snapshot)`。这是我们自己的历史序列，从服务启动那一刻开始积累（跟 ETF 快照库、清算采集器一样，诚实地"从现在开始"而不是假装有更早的数据）。

**Market Detail Page**（点首页"市场行情"卡片的"查看详情"）：
- 新增 `GET /api/market/detail?symbol=BTCUSDT&interval=1h&limit=100`（`sources/marketDetail.ts`），一次返回 `overview`（现价/涨跌幅/24h量/买一卖一等）、`klines`（Binance 原生历史K线，K线图和成交量图直接用它，不用等自己攒数据）、`volatility`（本地算的波动率序列）、`snapshotHistory`（自己攒的 Snapshot 历史，读 `snapshots` 表）。
- 前端 `prototype/index.html` 新增 `openMarketDetail()`：6 个币种 tab 切换、手写 SVG K线图（`candlestickChart()`）、成交量柱状图（`volumeBarsChart()`）、波动率折线（`lineChartFromSeries()`），对应 spec 里 Detail Page 的 Overview→Historical Charts→Statistics→Latest Updates→Raw Values 结构。用真实本地后端（jsdom + Node 原生 fetch 打真实的 `localhost:8787`）验证过整个流程和币种切换，没有伪造数据。

**Liquidation Detail Page**（点首页"清算数据"卡片的"查看详情"，第二个套上这套架构的模块）：
- 新增 `GET /api/liquidation/detail`（`sources/liquidationDetail.ts`），纯读 `liquidation_events` 表（不发网络请求，WebSocket 采集器在后台常驻写入），一次返回 1H/24H 清算总额、多空清算额、最大单笔、1H/4H/24H 分桶历史、资产分布、交易所分布、最近 30 条事件。
- 前端 `openLiquidationDetail()`：无币种 tab（Binance 的 forceOrder 流本身就是全币种），柱状图历史（`barChart()`）+ 排名条形列表（`distRows()`，用于资产/交易所分布），同样 Overview→Historical Charts→Statistics→Latest Updates→Raw Values 结构。

**其余 9 个模块**（Technical/Macro/News/ETF/On-chain/Sentiment/Derivatives/Stablecoin/Options）还是原来的通用列表 Detail 弹窗——按 spec 的 "Binance First" 优先级，下一步理论上是 Technical → Derivatives，但还没有确认具体顺序，做之前应该先问。

## 清算数据（2026-08-05 重建为 Binance-only WS；2026-08-06 加 CoinGlass 作为预留升级项）

**现状**：默认走 Binance Futures WebSocket（`!forceOrder@arr`，全币种合并流），跟之前一样。新增了一个 CoinGlass REST 连接器（`connectors/coinglassLiquidationConnector.ts`），但**只是代码预留，没有激活**——`.env` 的 `COINGLASS_API_KEY` 留空，`collectors/liquidationCollector.ts` 在没有 key 的情况下会自动退回 Binance WS，跟这次改动之前完全一样。等你决定订阅 CoinGlass 时，把 key 填进 `.env` 重启服务即可切换，不用改代码。

**为什么设计成"两个连接器 + 按 key 有无切换"，而不是直接换掉**：CoinGlass 目前已确认没有免费额度（最低 Hobbyist 档 $29/月，30 请求/分钟），你明确说了"暂时还不付费"——所以把它做成可随时开关的备选项，而不是破坏现在能用的 Binance 数据源。

**CoinGlass 连接器细节**（`connectors/coinglassLiquidationConnector.ts`）：
- 真实验证过的接口（不是照文档猜的）：`GET https://open-api-v4.coinglass.com/api/futures/liquidation/order`，需要 `exchange`/`symbol`/`min_liquidation_amount` 参数，认证走 `CG-API-KEY` 请求头。用无 key 和假 key 各测过一次，确认了真实的错误响应格式：`{"code":"401","msg":"API key missing."}` 和 `{"code":"400","msg":"Invalid API key provided"}`，HTTP 状态码都是 200——真实状态在 body 的 `code` 字段里，不是 HTTP 状态码，代码里判断的是这个
- 轮询制而非推流：CoinGlass 这个接口是按 `symbol` 查询的 REST 接口，不像 Binance 的 WS 是全币种一条流。轮询 `sources/assets.ts` 的 6 个币种，每轮间隔 20 秒（Hobbyist 档 30 请求/分钟的安全余量），首次启动会用 `start_time` 回溯拉近 24 小时，之后每轮只拉增量，不会重复插入
- **有一处没法验证、标在代码顶部的假设**：CoinGlass 文档只说 `side` 字段是"1: Buy, 2: Sell"，没说这是"清算方向"还是"强平订单自身方向"。按 Binance 连接器已验证过的同一套逻辑推断（强平订单是平仓单，Sell 平的是多头、Buy 平的是空头），代码里把 `side:2(Sell)→LONG`、`side:1(Buy)→SHORT`。这只是合理推断，不是确认过的事实——**等真的开通付费 key 后，第一件事应该是拿几笔真实清算跟其它数据源（比如 Binance 自己的 WS）对照验证一下这个映射对不对**，如果反了，只需要改 `coinglassLiquidationConnector.ts` 顶部的 `SIDE_MAP` 一行
- 没做过完整的真实付费请求验证（没有付费 key），只验证到了"请求格式对、错误处理对、无 key 时完全不影响现有行为"这一步

**删除前（2026-08-05）验证过的历史结论，留着供以后需要时参考**：
- OKX `liquidation-orders` 频道最扎实，25 秒内就抓到真实事件；`instId` 订阅过滤参数会被静默忽略，只能收全量后客户端按 symbol 过滤
- Binance `btcusdt@forceOrder`/`ethusdt@forceOrder` 官方标准接口，连接没问题，但 BTC/ETH 清算本身是稀疏事件
- Bybit 正确频道是 `allLiquidation.<SYMBOL>`（不是文档常见的旧版 `liquidation.<SYMBOL>`），订阅确认成功但没等到真实事件验证字段
- 三家交易所 `symbol` 写法不统一（`BTCUSDT` vs `BTC-USDT`），没做归一化
- Xoomar 的 `/liquidations` 接口报的 24h 全网爆仓数量级不合理（~484 亿美元），评估后判定不可信，没接
