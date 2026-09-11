# Trading Decision System

Architecture

Version 1.1

Status: Active Direction

---

# One Sentence

This is not a trading terminal.

This is a Trading Decision System（交易决策系统）.

---

# Core Idea

Traditional trading products mainly help users access data, charts, signals, or execution tools.

This project explores a different question:

**Can an AI system continuously transform market information, account context, and risk constraints into structured trading decisions that can be traced, validated, executed, and reviewed?**

The system does not compete primarily on market-data breadth.

It competes on the quality and integrity of the decision process.

---

# Decision Loop

External Data（外部数据）

↓

Market Facts（市场事实）

↓

AI Judgment（AI 判断）

↓

Trading Strategy（交易策略）

↓

Account / Position Context（账户 / 持仓状态）

↓

Final Decision（最终决策）

↓

Risk Guard（风险守卫）

↓

Execution（执行）

↓

Monitoring / Reconciliation（监控 / 对账）

↓

Trade Result（交易结果）

↓

Attribution / Learning（归因 / 学习，未来）

---

# Core Object

Trade Decision（交易决策）

A trade is not treated as an isolated AI answer.

A complete decision should preserve:

- Inputs（输入）
- Market Facts（市场事实）
- AI Judgment（AI 判断）
- Strategy（策略）
- Account Context（账户上下文）
- Risk Checks（风险检查）
- Execution（执行）
- Result（结果）

The purpose is to make every decision traceable and reproducible enough for later review.

---

# Why Data Exists

Data is not the product by itself.

It provides the evidence layer used to construct a decision.

The current system collects 11 categories of market information and combines them with account and position state before analysis.

---

# Why AI Analysis Exists

AI Analysis（AI 分析） is responsible for converting structured inputs into market understanding and a proposed trading decision.

The target structure for AI Analysis V2（AI 分析第二版） is:

Market Facts（市场事实）

↓

Market Judgment（市场判断）

↓

Trading Strategy（交易策略）

↓

Account / Position Adaptation（账户 / 持仓适配）

↓

Final Decision（最终决策）

The goal is not to create a longer Prompt（提示词）.

The goal is to define a clearer reasoning and decision contract between AI and the execution system.

---

# Why Validation Exists

AI output cannot be treated as executable simply because it is syntactically valid text.

The system validates structured output before it can become a StrategyOrder（策略订单）.

This creates a boundary between model generation and system execution.

---

# Why Risk Guard Exists

Risk Guard（风险守卫） is independent from the AI recommendation.

Its purpose is to enforce deterministic execution constraints before an order reaches the exchange.

AI proposes.

The system decides whether the proposal is allowed to execute.

---

# Why Execution Exists

Execution turns a structured decision into a real exchange action.

Current write operations are hard-limited to Binance Futures TESTNET（币安合约测试网）.

LIVE（实盘） execution is not available as a casual configuration switch.

---

# Why Monitoring and Reconciliation Exist

A trading decision does not end when an order is submitted.

Orders and positions can remain active, change state, partially fill, or diverge from local records.

Monitoring（持续监控） tracks the lifecycle.

Reconciliation（对账） compares local state with exchange state and converges inconsistencies.

---

# Why Evidence Exists

Each analysis preserves its Payload（输入数据）、Prompt（提示词）、raw AI response（AI 原始响应） and parsed result（解析结果）.

Failure does not erase the evidence.

This makes the system inspectable and gives future Attribution / Learning（归因 / 学习） a factual basis.

---

# Relationship to Quantitative Trading

The system uses Quantitative Methods（量化方法） such as structured market data, technical indicators, statistical information, and rule-based risk control.

However, it is not positioned as a traditional Quant System（量化系统） centered on factor research, statistical arbitrage, high-frequency trading, or backtest optimization.

Its primary research object is the AI-assisted trading decision process itself.

---

# Future

Attribution（归因）

↓

Decision Review（决策复盘）

↓

Weight / Context Optimization（权重 / 上下文优化）

↓

Decision Model Evolution（决策模型演进）

The long-term moat is not simply access to AI or market data.

It is the accumulated structure, evidence, and feedback around how decisions are made.

---

# Analysis Snapshot Integrity

For a given analysis, market inputs should be collected as one consistent Snapshot（快照）, rather than read opportunistically from a changing Dashboard（仪表盘） cache.

The successful input package is frozen for that analysis so that the decision can later be inspected against the exact evidence available at that moment.

This principle supports reproducibility and evidence integrity across the full decision chain.
