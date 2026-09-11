# 接管说明（Handoff README）

本文件只陈述当前源码的客观事实，不包含任何新的产品设计或 Sprint 规划建议。生成时间：2026-08-10。

---

## 1. 当前项目启动方式

后端（`pipeline/` 目录下执行）：

```
npm install        # 首次
npm run dev         # 开发模式，tsx watch，源码改动自动重启（Sprint 3.6A 新增）
npm run serve        # 单次运行，不自动重启
npm run typecheck    # tsc --noEmit
```

前端没有构建步骤——`prototype/index.html` 是单文件、无打包器，直接用浏览器打开，或用任意静态文件服务器托管。

---

## 2. 前端入口

`prototype/index.html`（单文件，约 8800+ 行，内嵌一个 `<script>`，无框架、无打包器）。路由用 `location.hash`（如 `#/dashboard`、`#/trades/:id`、`#/account`、`#/settings`），核心分发函数是 `render()`。

---

## 3. 后端入口

`pipeline/src/server.ts`——一个不依赖框架的 Node `http.createServer`，手写路径匹配（无 Express/Koa）。启动后会打印完整路由清单到控制台。

---

## 4. 当前本地后端端口

`8787`（`pipeline/src/server.ts` 内 `PORT = Number(process.env.PORT) || 8787`）。前端通过 `const BACKEND_URL='http://localhost:8787'`（`prototype/index.html`）连接。

---

## 5. 核心数据存储位置

**后端（`pipeline/data/`，本包未包含，见第 7 节安全说明）**：
- `exchange_connections.json` —— 真实交易所连接（含 API Key/Secret，明文存储）
- `ai_connections.json` / `ai_provider_config.json` / `ai_role_config.json` —— AI 网关连接配置
- `etf_flows.sqlite` —— ETF 流向数据
- `evidence_parse_cache.json` —— 图片证据解析缓存

**前端（浏览器 `localStorage`，无后端持久化）**：

| Key | 内容 |
|---|---|
| `qa_analysis_payloads` | Analysis Payload（冻结快照） |
| `qa_prompt_records` | Prompt Record |
| `qa_ai_raw_results` | AI 原始响应（可能有多次尝试） |
| `qa_ai_response_records` | 已校验的 `AIResponseRecord`（含 `scenarioPlans`） |
| `qa_execution_drafts` | `ExecutionDraft` |
| `qa_orders` | `RealOrder`（真实订单，含 ENTRY / STOP_LOSS / TAKE_PROFIT） |
| `qa_trades_real` | `RealTrade`（真实交易，real-v1） |
| `qa_positions` | `RealPosition`（真实持仓镜像，只从交易所同步） |
| `qa_position_allocations` | `PositionAllocation`（Sprint 3.6A 新增，仓位归因） |
| `qa_risk_settings` | Risk Guard 本地设置（含选定的 exchangeConnectionId） |
| `qa_trades` / `qa_draft` | 旧版 mock 数据模型，与真实交易链路无关，仍存在于代码中但不影响真实链路 |

真实交易所凭证从不写入 `localStorage`——`Settings` 表单只在内存中持有一份草稿，保存/取消后即丢弃。

---

## 6. 当前 Exchange Adapter（交易所适配器）位置

`pipeline/src/exchange/binanceFuturesAdapter.ts`——唯一直接对 Binance USDT-M Futures REST API 签名请求的模块。上层依次是：

```
prototype/index.html（前端 UI/业务逻辑）
  → pipeline/src/server.ts（HTTP 路由）
    → pipeline/src/exchange/exchangeService.ts（连接解析 + TESTNET 二次校验层）
      → pipeline/src/exchange/binanceFuturesAdapter.ts（真实签名请求）
```

辅助模块：`binanceSign.ts`（HMAC 签名 + 服务器时间偏移）、`orderSizing.ts`（数量取整/校验，只向下取整从不向上）、`exchangeConnectionStore.ts`（连接 CRUD，明文 JSON 存储）、`userDataStreamManager.ts`（Sprint 3.6A，`listenKey` 生命周期 + WebSocket 桥接，供实时更新用）。

---

## 7. 当前 Binance Futures 连接方式

- 每个连接是一条 `ExchangeConnection` 记录（`id, name, exchange:'binance-futures', environment:'LIVE'|'TESTNET', enabled, apiKey, apiSecret`），存于后端 `pipeline/data/exchange_connections.json`（明文，`.gitignore` 已排除）。
- 前端从不直接持有真实 API Key/Secret——所有请求经后端代理；前端拿到的连接对象一律经过 `toSafeExchangeConnectionView()`，`apiKey` 只以掩码形式出现，`apiSecret` 从不出现在任何响应里。
- 签名：`buildSignedQuery()`（`binanceSign.ts`），HMAC-SHA256，查询字符串签名；`listenKey` 相关的三个端点例外——只需要 `X-MBX-APIKEY` 请求头，不需要签名（已核实）。
- Base URL：`LIVE → https://fapi.binance.com`；`TESTNET → https://testnet.binancefuture.com`（`binanceFuturesAdapter.ts` 内 `BASE_URLS`）。

---

## 8. 当前已经存在的真实交易能力（真实会请求 Binance 的能力）

只读：
- 账户快照（余额、持仓、账户风险摘要）——`GET /fapi/v2/account` + `GET /fapi/v2/positionRisk`
- 单个订单查询——`GET /fapi/v1/order`
- 全部当前挂单查询——`GET /fapi/v1/openOrders`（Sprint 3.6A 新增）
- 保护单/条件单查询——`GET /fapi/v1/openAlgoOrders`、`GET /fapi/v1/algoOrder`
- 实时账户/订单事件流（User Data Stream，只读，SSE 中继，Sprint 3.6A 新增）

写（**全部仅限 TESTNET**，共 5 个，逐一在 `exchangeService.ts`/`binanceFuturesAdapter.ts`/`server.ts` 三层各自重复校验环境）：
1. 提交入场订单——`POST /fapi/v1/order`（Sprint 3.5D-B）
2. 撤销入场订单——`DELETE /fapi/v1/order`（Sprint 3.5D-D）
3. 提交止损/止盈保护单——`POST /fapi/v1/algoOrder`（Sprint 3.5D-E）
4. 撤销保护单——`DELETE /fapi/v1/algoOrder`（Sprint 3.5D-E，后端路由存在，但当前 UI 未接入撤销按钮，是刻意决定）
5. 调整杠杆——`POST /fapi/v1/leverage`（Sprint 3.6A，只能从"杠杆不一致"确认弹窗触发，没有独立入口）

---

## 9. 当前明确不存在/禁止的能力

- 订单改单（amend/replace）——不存在
- 保证金模式切换（`setMarginType`）——不存在
- 持仓模式切换（单向/双向，Hedge Mode）——不存在
- 资金划转/提现（`transfer`/`withdraw`）——不存在
- 自动平仓/加仓/减仓/反手（ADD/REDUCE/CLOSE/REVERSE）——不存在，Account 页面只有三个只读操作（查看详情/查看保护/查看归因）
- `AUTO` 执行模式——`ExecutionMode` 类型里没有这个值，从未被任何代码路径生成
- 任何自动重试写请求——超时/网络失败一律返回"结果未知"，从不自动重试
- 任何后台自动轮询——所有同步都是用户手动点击触发（除 `NOTIFY` 的 Trigger Monitor 和 SSE 实时更新，两者都只读、不下单）

---

## 10. 当前 TESTNET / LIVE / AUTO 安全边界

- **TESTNET**：所有 5 个写能力的唯一允许环境。每个写函数在三层独立代码位置各自检查 `environment==='TESTNET'`（后端 service 层、adapter 层、前端点击前），互不信任，任何一层单独失败都会阻止请求。
- **LIVE**：只允许只读操作（账户快照、订单查询、实时事件流）。任何写请求遇到 LIVE 连接会在到达网络前直接返回 `live_*_not_supported` 错误。
- **AUTO**：完全未实现。`EXECUTION_SPEC.md` 明确保留了未来扩展边界（需要账户连接+Risk Guard+机器可判断触发条件+用户显式逐笔授权），但当前无任何代码路径通向它。

---

## 11. 当前主要数据对象

全部定义/实现在 `prototype/index.html`（前端，无后端数据库表）：

- **`ScenarioPlan`**：AI 输出的一个可执行方案（entry/stopLoss/takeProfit/triggerStructured/reviewHorizon 等），契约见 `AI_RESPONSE_SPEC.md`，不可变。
- **`ExecutionDraft`**：用户对某个 `ScenarioPlan` 的执行意图（`MANUAL`/`NOTIFY`，`userOverrides`），契约见 `EXECUTION_SPEC.md`，可变。
- **`RealOrder`**：真实订单（`role: ENTRY|STOP_LOSS|TAKE_PROFIT`，`status` 生命周期 `DRAFT→SUBMITTED→PARTIALLY_FILLED→FILLED` 或终止态），存于 `qa_orders`。
- **`RealTrade`**：真实交易（`status: PLANNED|OPENING|OPEN|CANCELLED`，`protectionStatus`），存于 `qa_trades_real`。
- **`RealPosition`**：真实持仓镜像，只从交易所同步写入，存于 `qa_positions`；Sprint 3.6A 新增 `PositionAllocation`（存于 `qa_position_allocations`）用于多笔 `RealTrade` 共享同一交易所净仓位时的归因。
- **`RiskGuardResult`**：`evaluateRiskGuard()` 的输出（PASS/BLOCKED + 每条规则结果），本地 6 条规则 + 3 条依赖真实账户快照的规则。

---

## 12. 当前真实交易链路概览

```
Strategy（AI ScenarioPlan，不可变）
  → Execution（ExecutionDraft，用户手动确认）
    → 风险检查（Risk Guard，每次写操作前必须重新检查一次，PASS 才能继续）
      → 提交入场订单（POST /fapi/v1/order，仅 TESTNET）
        → 真实成交 / Position Sync（读取真实持仓，从不臆造）
          → 自动建立止损/止盈保护单（POST /fapi/v1/algoOrder，仅 TESTNET，数量永远来自真实成交/持仓，从不来自计划仓位大小）
            → 保护状态校验（真实只读查询确认，从不只信任写请求的响应）
```

撤单（`DELETE /fapi/v1/order`）、调整杠杆（`POST /fapi/v1/leverage`）都是独立的手动触发分支，不在上面这条主链路的自动流程里。

---

## 13. 当前主要测试文件及用途

测试文件位于 `handoff_package/tests/`。这些文件是历史 Sprint 验证时产生的真实测试脚本；按照本项目约定，测试文件在验证通过后会从正式源码树（`pipeline/src/exchange/__test_*.ts`）中删除，只在会话临时目录保留副本，因此**它们目前不存在于项目正式源码树中**——本包是把与当前真实交易链路直接相关的副本重新收集出来。运行方式统一是 `node xxx.js` 或 `npx tsx xxx.ts`；`.ts` 文件设计为放在 `pipeline/src/exchange/` 目录下运行（相对 import 路径 `./xxx.js`），`.js` 文件设计为从项目根目录附近运行并硬编码了 `prototype/index.html` 的绝对路径——**放进新环境前需要按需调整路径**，本包不保证开箱即跑。

| 文件 | 覆盖范围 |
|---|---|
| `v3_4c_order_trade_test.js` | `RealOrder`/`RealTrade` 基础创建/生命周期 |
| `v3_5a_risk_guard_test.js` | Risk Guard 9 条规则 |
| `v3_5b_exchange_frontend_test.js` | Exchange Connection 选择/前端交互 |
| `v3_5c_position_normalization_test.ts` | 持仓数据归一化（后端） |
| `v3_5c_frontend_test.js` | Account Snapshot 渲染（前端） |
| `v3_5c1_timestamp_hotfix_test.ts` | 时间戳偏移 / Binance 签名 |
| `v3_5c2_backend_test.ts` / `v3_5c2_frontend_test.js` | 账户快照读取超时/挂起修复 |
| `v3_5d_a_order_query_test.ts` / `v3_5d_a_order_lifecycle_test.js` | 订单只读同步生命周期 |
| `v3_5d_b_submission_test.ts` / `v3_5d_b_frontend_test.js` | TESTNET 入场订单提交 |
| `v3_5d_b1_numeric_scenario_test.js` / `v3_5d_b1_ui_test.js` | 执行就绪门槛（数值完整性） |
| `cancel_backend_test.ts` / `cancel_frontend_test.js` | 订单撤销 |
| `protection_backend_test.ts` / `protection_frontend_test.js` | 止损/止盈保护单（Algo Order） |
| `symbol_hotfix_test.ts` | Symbol 归一化（`BTC/USDT`→`BTCUSDT`） |
| `connection_isolation_test.ts` / `connection_selection_test.js` | 交易所连接隔离/选择 |
| `v3_5d_c_position_sync_test.js` | Position Sync + 归因链接 |
| `v3_6a_backend_test.ts` | 杠杆调整 / 全部挂单读取 / listenKey 生命周期（当前 Sprint） |
| `v3_6a_frontend_test.js` | PositionAllocation / Account 页面 / 杠杆同步流程 / SSE 实时更新（当前 Sprint） |

未收录：`v3_5b_exchange_backend_test.ts`（历史上已确认过时——3.5C 之前的函数签名、非 ESM `require()`，本身已不可运行）；`v3_5b1_hotfix_live_frontend_check.js`（会对真实运行中的后端发起真实 HTTP 请求并假设连接列表为空，不是可重复运行的合成测试）；早期与 Strategy/Trigger Monitor 相关但与真实交易所链路无直接关系的测试（如 `v2_1_parser_fixtures.js`、`v3_4a_execution_test.js`、`v3_4b_monitor_test.js`）。

---

## 14. 新对话建议优先阅读文件顺序

1. `PROJECT.md` —— 项目全貌、当前 Sprint、产品状态表
2. `EXECUTION_SPEC.md` —— `ExecutionDraft`/`RealOrder`/`RealTrade`/`RealPosition`/`PositionAllocation` 的完整契约（本项目最重要的单一文档）
3. `pipeline/src/exchange/types.ts` —— 所有交易所相关类型定义，读完能快速建立整体数据形状的心智模型
4. `pipeline/src/exchange/binanceFuturesAdapter.ts` —— 真实签名请求实现，含每个 Before-Coding 研究结论的行内注释
5. `pipeline/src/exchange/exchangeService.ts` —— 路由到 adapter 之间的连接解析 + TESTNET 二次校验层
6. `pipeline/src/server.ts` —— 完整路由清单（文件底部 `console.log` 块是最快的路由总览）
7. `prototype/index.html` —— 前端实现；建议先用编辑器搜索 `/* ---------- Sprint` 标记跳读各 Sprint 区块，而不是从头读到尾（文件很大）
8. `AI_RESPONSE_SPEC.md` —— 仅在需要理解 `ScenarioPlan` 上游契约时读
9. `handoff_package/tests/` —— 需要验证某个具体行为的真实预期时查阅对应测试文件
