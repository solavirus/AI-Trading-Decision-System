# Changelog

只记录重要里程碑，不是完整开发流水账。

## pre-ai-analysis-v2 (2026-08-19)

AI Analysis V2（AI 分析第二版）重构前的稳定基线。commit `8edcfd0b0fd43e089bccbde473faf946ec5031d1`。

此时系统已具备：11 数据源并行采集、Account Snapshot（账户快照）、统一 Manual / Automatic Analysis（手动 / 自动分析）引擎、Analysis Evidence（分析证据）全链路留痕、AnalysisRun（分析任务）生命周期安全对账、StrategyOrder（策略订单）、Risk Guard（风险守卫）、Binance Futures TESTNET（币安合约测试网）真实下单执行、RealTrade（真实交易）定期对账。

此后的 AI Analysis（AI 分析）重新设计以此提交为起点。

## 更早的里程碑（摘要）

- Manual（手动）与 Automatic（自动）分析统一为同一条 Analysis Engine（分析引擎）。
- Binance Futures TESTNET（币安合约测试网）下单 / 撤单 / 止损止盈能力落地，Risk Guard（风险守卫）与 Kill Switch（紧急停止开关）上线。
- Account / Position（账户 / 持仓）真实快照接入分析上下文。
- ETF 资金流数据库、清算数据采集和 11 类数据源逐步接入。

更早期、更细粒度的迭代记录请查看 Git History（Git 历史）与 `docs/archive/`。
