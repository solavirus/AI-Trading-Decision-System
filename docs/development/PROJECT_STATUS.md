# Project Status

> 当前真实状态与已知问题。第一次了解项目请先读根目录 `README.md`。

## Product Goal

将交易者原本依赖人工完成的“获取市场信息 → 形成判断 → 制定策略 → 结合账户状态做最终决策 → 执行 → 持续管理”过程，逐步结构化为一套 AI 可以持续运行、可追踪、可约束的 Trading Decision System（交易决策系统）。

当前系统目标链路：

用户提供资金与风险边界 →
AI 自主分析市场 →
形成可解释的交易决策 →
通过规则风控 →
在测试网执行 →
持续管理仓位与订单 →
保留完整分析与交易证据。

> 项目使用程序化数据处理、技术指标、统计信息和规则风控等 Quantitative Methods（量化方法），但它不是以因子挖掘、统计套利、高频交易或纯回测为核心的传统 Quant System（量化系统）。

## Current Stage

当前稳定基线：`pre-ai-analysis-v2`
commit: `8edcfd0b0fd43e089bccbde473faf946ec5031d1`

当前阶段：准备进入 **AI Analysis V2（AI 分析第二版）** 设计与实现。

## Completed

以下均为真实已跑通、有代码支撑的能力：

- **多数据源并行采集** —— 11 个数据源（市场行情 / 技术指标 / 宏观 / 新闻 / ETF 资金流 / 链上 / 情绪 / 衍生品 / 稳定币 / 清算 / 期权），带重试与并发调度。
- **Account Snapshot（账户快照）** —— 真实 Binance 账户 / 持仓读取，接入分析上下文。
- **Manual / Automatic Analysis（手动 / 自动分析）** —— 手动触发与自动调度共享同一条 Analysis Engine（分析引擎）。
- **Analysis Evidence（分析证据）** —— Payload（输入数据） / Prompt（提示词） / AI 原始响应 / 解析结果全链路留痕。
- **AnalysisRun Lifecycle（分析任务生命周期）** —— 进度追踪、取消、僵尸任务对账。
- **StrategyOrder（策略订单）** —— AI 决策落地为结构化订单对象。
- **Risk Guard（风险守卫）** —— 下单前规则校验。
- **TESTNET Execution（测试网执行）** —— Binance Futures TESTNET（币安合约测试网）下单 / 撤单 / 止损止盈。
- **RealTrade Reconciliation（真实交易对账）** —— 本地记录与交易所真实状态定期对账。
- **Kill Switch（紧急停止开关）** —— 自动化调度全局暂停。
- **Monitoring（持续监控）** —— 持仓 / 订单状态持续追踪。

## Current Decision Pipeline

```text
Data Sources（市场数据）
      ↓
Snapshot（数据 + 账户 / 持仓快照）
      ↓
AnalysisPayload（结构化输入）
      ↓
Prompt（提示词）
      ↓
AI Judgment（AI 判断）
      ↓
Validation（结果校验）
      ↓
StrategyOrder（策略订单）
      ↓
Risk Guard（风险守卫）
      ↓
Execution（执行）
      ↓
Monitoring / Reconciliation（监控 / 对账）
```

## NOW

当前最高优先级：**设计 AI Analysis V2（AI 分析第二版）**。

```text
市场事实 → 市场判断 → 交易策略 → 账户 / 持仓适配 → 最终决策
```

当前原则：**先设计 AI Analysis（AI 分析）→ Output Schema（输出结构）→ Prompt（提示词）→ 再重新审视 Risk Guard（风险守卫）。**

## Known Issues

- ETF 资金流数据库：9 个 ticker 中仅 iShares（IBIT）份额数据源已接通，多个发行商份额数据源尚未实现，对应资金流仍有 stub（占位实现）。
- 清算数据：CoinGlass 连接器代码已写好但未激活，字段映射仍需真实付费请求验证。
- 权重配置目前存在前后端两份手工同步副本，尚未合并为单一配置源。
- 一份历史回归脚本引用了已重命名函数，需要小幅更新，不影响生产代码。

## NEXT

- AI Output Contract（AI 输出契约）
- Prompt V2（提示词第二版）
- 真实 AI 样本验证
- 仓位管理闭环验证
- TESTNET（测试网）连续运行
- 选择一笔真实 TESTNET 交易整理为经过脱敏的 Case Study（案例研究）

## LATER

- Monitoring / Trade List UX（监控 / 交易列表用户体验）
- Attribution / Learning（归因 / 学习）
- 动态数据源权重
- 更多交易对 / 交易所
- LIVE（实盘）
