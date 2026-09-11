# Backend Engineering Notes（后端工程说明）

`pipeline/` 是 AI Trading Decision System（AI 交易决策系统）的后端主路径。

它负责：多源市场数据采集、账户 / 持仓快照、AI Analysis（AI 分析）、结构化结果校验、StrategyOrder（策略订单）生成、Risk Guard（风险守卫）、Binance Futures TESTNET（币安合约测试网）执行、Monitoring（持续监控）与 Reconciliation（对账）。

> 早期版本的这个目录只负责数据采集，因此历史文档中可能仍出现 `Quant Pipeline` 或“尚未接入 LLM（大语言模型）”的描述。那已经不是当前真实状态。项目当前状态以根目录 `README.md` 与 `docs/development/PROJECT_STATUS.md` 为准。

## Current backend flow（当前后端链路）

```text
Data Sources（市场数据）
      ↓
Snapshot Acquisition（数据 + 账户 / 持仓快照）
      ↓
AnalysisPayload（结构化分析输入）
      ↓
Prompt Builder（提示词构建）
      ↓
AI Provider（AI 模型提供方）
      ↓
Validation（结果校验）
      ↓
StrategyOrder（策略订单）
      ↓
Risk Guard（风险守卫）
      ↓
Execution（测试网执行）
      ↓
Monitoring / Reconciliation（持续监控 / 对账）
```

## Main modules（主要模块）

- `src/analysis/` — Analysis Engine（分析引擎）、Snapshot（快照）、Payload（输入结构）、Prompt（提示词）、Response Validation（响应校验）与任务生命周期。
- `src/ai/` — OpenAI / Anthropic / Google / DeepSeek / OpenAI-compatible（兼容 OpenAI 接口）的 Provider（模型提供方）抽象层。
- `src/sources/`、`src/connectors/`、`src/normalize/` — 11 类数据源的采集、适配与归一化。
- `src/exchange/` — Binance Futures（币安合约）账户、订单、签名与交易所适配。
- `src/strategy/` — StrategyOrder（策略订单）、Risk Guard（风险守卫）、自动化调度、Kill Switch（紧急停止开关）、Monitoring（监控）与 Reconciliation（对账）。
- `src/etf/` — ETF 资金流相关 SQLite（轻量级关系型数据库）能力。

## Data sources（数据源）

当前系统覆盖 11 类信息：市场行情、技术指标、宏观、新闻、ETF 资金流、链上、市场情绪、衍生品、稳定币、清算与期权。

并非所有来源都要求 API Key（接口密钥）。缺少可选 Key 时，对应来源会明确进入未配置 / 占位状态，而不是静默伪造数据。配置项见 `.env.example`。

## Run locally（本地运行）

```bash
npm install
npm run serve
```

默认监听：`http://localhost:8787`

开发模式：

```bash
npm run dev
```

类型检查：

```bash
npm run typecheck
```

单次数据源验证：

```bash
npm run fetch
```

ETF 快照：

```bash
npm run etf:snapshot
```

## Safety boundary（安全边界）

交易所写操作目前在代码层面硬性限制为 Binance Futures TESTNET（币安合约测试网）。LIVE（实盘）不是一个可以随手打开的配置开关。

## Public repository note（公开仓库说明）

运行时数据、`.env`、日志与本地状态不进入版本控制。公开仓库只保留代码、空配置模板、经过筛选的展示素材与工程文档。

更完整的产品定位、系统架构和开发状态，请从仓库根目录 `README.md` 开始阅读。
