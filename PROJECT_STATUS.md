# Project Status

> 给 AI / 新协作者的第一份文件。如果只能读一份文档，读这份。

## Product Goal

用户给 AI 一笔资金 →
AI 自主分析市场 →
做出可解释交易决策 →
安全执行 →
持续管理仓位 →
用户看到结果。

## Current Stage

当前稳定基线：`pre-ai-analysis-v2`
commit: `8edcfd0b0fd43e089bccbde473faf946ec5031d1`

当前阶段：准备进入 **AI Analysis V2**（AI 分析第二版）设计与实现。

## Completed

只列核心能力，均为真实已跑通、有代码支撑的部分（非设计稿）：

- **多数据源并行采集** —— 11 个数据源（市场行情/技术指标/宏观/新闻/ETF资金流/链上/情绪/衍生品/稳定币/清算/期权），带重试与并发调度（`pipeline/src/analysis/snapshotAcquisition.ts`）
- **Account Snapshot（账户快照）** —— 真实 Binance 账户/持仓读取，接入分析上下文
- **Manual / Automatic Analysis（手动/自动分析）** —— 手动触发与自动调度共享同一条 Analysis Engine（`pipeline/src/analysis/analysisEngine.ts`），不是两套逻辑
- **Analysis Evidence（分析证据）** —— Payload/Prompt/AI 原始响应/解析结果全链路留痕，失败也不丢证据
- **AnalysisRun Lifecycle（分析任务生命周期）** —— 进度追踪、取消、僵尸任务对账（启动时 + 运行时两套对账），保证任一分析最终都会到达终态
- **StrategyOrder（策略订单）** —— AI 决策落地为结构化订单对象
- **Risk Guard（风险守卫）** —— 下单前的规则校验层
- **TESTNET Execution（测试网执行）** —— 真实调用 Binance Futures TESTNET 下单/撤单/止损止盈
- **RealTrade Reconciliation（真实交易对账）** —— 本地记录与交易所真实状态定期对账，孤儿/僵尸交易自动识别与收敛
- **Kill Switch / 自动化策略开关** —— 自动化调度的全局暂停开关
- **Monitoring（持仓监控）** —— 持仓/订单状态的持续追踪

## NOW

当前最高优先级：**设计 AI Analysis V2**

```
市场事实 → 市场判断 → 交易策略 → 账户/持仓适配 → 最终决策
```

当前原则：**先设计 AI Analysis（AI 分析）→ Output Schema（输出结构）→ Prompt（提示词）→ 再重新审视 Risk Guard（风险守卫）。**
不要反过来先改 Risk Guard 再回头凑 Prompt。

## Known Issues

只记录仍真实存在且已确认的问题，未经验证的推测不写在这里：

- ETF 资金流数据库：9 个 ticker 中仅 iShares（IBIT）份额数据源已接通，Fidelity/Grayscale/ARK/Bitwise/VanEck 等 6 个发行商的份额数据源尚未实现，对应资金流长期为 stub。
- 清算数据：CoinGlass 连接器代码已写好但未激活（未订阅付费 key），当前生产环境仍是 Binance WS-only；CoinGlass 的 `side` 字段方向映射是推断值，未经真实付费请求验证。
- 权重配置存在两份手工同步的副本：`prototype/index.html` 的 `WEIGHT_DEFS` 与 `pipeline/src/weights.ts` 的 `DEFAULT_WEIGHTS`，尚未合并为单一配置源。
- 回归测试脚本 `test_sprint39_position_and_history.mts` 中的一个用例引用了已重命名的函数（`runManualAutonomousCycle` → 现为 `runAutonomousCycleForSymbol`），该脚本本身需要小幅更新，不影响生产代码。

## NEXT

- AI Output Contract（AI 输出契约）
- Prompt V2（提示词第二版）
- 真实 AI 样本验证
- 仓位管理闭环验证
- TESTNET 连续运行

## LATER

- Monitoring / Trade List UX（监控/交易列表体验）
- Attribution / Learning（归因/学习）
- 动态数据源权重
- 更多交易对/交易所
- LIVE（实盘）
