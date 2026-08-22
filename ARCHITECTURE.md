# Architecture

只描述当前真实存在的架构，不描述尚未实现的设计。

## 数据/决策流水线

```
Data Sources（11 个数据源，并行采集）
      ↓
Snapshot（Snapshot Acquisition：数据源快照 + Account/Position 快照）
      ↓
AnalysisPayload（结构化输入，供 Prompt 使用）
      ↓
Prompt（Prompt Builder）
      ↓
AI（AI Engine，调用已配置的 AI Provider）
      ↓
Validation（AI Response Validator：schema 校验 + 交叉规则）
      ↓
StrategyOrder（策略订单：AI 决策的结构化落地）
      ↓
Risk Guard（下单前规则校验）
      ↓
Execution（Binance Futures TESTNET 下单/撤单/止损止盈）
      ↓
Position / RealTrade（持仓与真实交易记录 + 定期对账）
      ↓
Monitoring（持续监控）
```

每个箭头都有真实代码对应，不是设计意图。AnalysisRun（进度/生命周期）与 AnalysisRecord（最终业务结果）是两条并行、通过同一个 `analysisId` 关联的记录，分别用于"正在发生什么"和"结论是什么"。

## 代码目录

### `pipeline/` —— 后端（Node + TypeScript，单进程，无框架）

| 目录 | 职责 |
|---|---|
| `src/server.ts` | 唯一 HTTP 入口，所有 `/api/*` 路由 |
| `src/sources/`、`src/connectors/`、`src/normalize/` | 11 个数据源的采集、Provider 适配、结构化归一化 |
| `src/fetchers.ts` | 数据源统一注册表 |
| `src/analysis/` | 统一分析引擎：Snapshot Acquisition → Payload Builder → Prompt Builder → Response Validator → AnalysisRun/AnalysisRecord 存储 + 生命周期对账 |
| `src/ai/` | AI Provider 抽象层（OpenAI/Anthropic/Google/DeepSeek/自定义 OpenAI-compatible 中转），连接与角色配置 |
| `src/exchange/` | Binance Futures 适配器（签名、下单、持仓/账户读取），环境仅支持 `TESTNET`/`LIVE` 两种标记，写操作硬编码只允许 `TESTNET` |
| `src/strategy/` | StrategyOrder 存储、Risk Guard、执行准入（Execution Readiness/Guard）、Kill Switch、自动化调度（Autonomous Scheduler）、持仓监控（Monitor Engine）、订单/保护单/交易对账 |
| `src/etf/` | 自建 ETF 资金流数据库（SQLite） |
| `src/util/`、`src/db.ts` | 安全 JSON 持久化原语、HTTP 工具、SQLite 封装等 |

### `prototype/index.html` —— 前端

单文件 Dashboard，向后端 `pipeline/` 发起所有请求（默认 `http://localhost:8787`）。当前项目**没有独立的前端工程/构建流程**——这一个 HTML 文件就是整个前端。

### 其他

- `AI_RESPONSE_SPEC.md` / `ANALYSIS_PAYLOAD_SPEC.md` / `PROMPT_BUILDER_SPEC.md` / `EXECUTION_SPEC.md` / `DATA_SOURCE_SPEC.md` —— 各层的冻结契约文档，是代码实现必须遵守的规范来源
- `docs/` —— 架构索引、交易所能力矩阵等参考资料
- `analysis_evidence/` —— 保留下来的历史分析证据样本，用于回归验证
- `test-fixtures/`、`handoff_package/`、`quant-assistant-wizard-prototype/` —— 历史遗留的测试样本/交接快照/独立前端实验，非当前主干开发路径

## 数据与状态

后端所有持久化状态落在 `pipeline/data/`（SQLite + 若干 JSON store），该目录**不在版本控制中**（包含真实运行数据与 API Key），见根目录 `.gitignore`。
