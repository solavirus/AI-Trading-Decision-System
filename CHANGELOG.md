# Changelog

只记录重要里程碑，不是完整的开发流水账。

## pre-ai-analysis-v2 (2026-08-19)

AI Analysis V2 重构前的稳定基线。commit `8edcfd0b0fd43e089bccbde473faf946ec5031d1`。

此时系统已具备：11 数据源并行采集、Account Snapshot、统一 Manual/Automatic Analysis 引擎、Analysis Evidence 全链路留痕、AnalysisRun 生命周期安全对账、StrategyOrder、Risk Guard、Binance Futures TESTNET 真实下单执行、RealTrade 定期对账。详见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

此后的 AI Analysis 重新设计（新 Output Schema / Prompt V2）以此提交为起点。

## 更早的里程碑（摘要）

- 统一分析引擎（Manual 与 Automatic 分析合并为同一条 Analysis Engine，替代此前两套独立实现）
- Binance Futures TESTNET 下单/撤单/止损止盈能力落地，Risk Guard 与 Kill Switch 上线
- Account/Position 真实快照接入分析上下文
- ETF 资金流自建数据库、清算数据采集、11 个数据源全部接入真实数据（早期为程序化采集 + 本地计算，无 LLM 调用）

更早期、更细粒度的迭代记录未在此复原，如需追溯请查看 Git 历史或 `product-docs/archive/`。
