# AI Trading Decision System

一个让 AI 基于多源市场信息、账户状态与风险约束，自主完成市场分析、交易决策、执行与持续管理的实验系统。

它不是传统意义上的因子量化、统计套利或高频交易系统。这个项目更关注一个问题：**如何把交易者原本依赖人工完成的“获取信息 → 形成判断 → 制定策略 → 执行 → 管理”过程，结构化为 AI 可以持续运行、可验证、可约束的决策链路。**

## 一笔决策如何产生

```text
Market Data（市场数据）
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
Monitoring / Reconciliation（持续监控 / 对账）
```

项目当前正在重构 **AI Analysis V2（AI 分析第二版）**，核心目标是把“市场事实、市场判断、交易策略、账户适配、最终决策”拆成更清晰的认知与执行层，而不是单纯继续堆叠 Prompt（提示词）。

## 已经真实跑通的能力

以下能力均有真实代码支撑，不是设计稿：

- **11 类市场数据并行采集** —— 行情、技术指标、宏观、新闻、ETF 资金流、链上、情绪、衍生品、稳定币、清算、期权
- **Account Snapshot（账户快照）** —— 读取真实 Binance 账户与持仓，并纳入分析上下文
- **Manual / Automatic Analysis（手动 / 自动分析）** —— 手动触发与自动调度共用同一条 Analysis Engine（分析引擎）
- **Analysis Evidence（分析证据）** —— Payload（输入数据）、Prompt（提示词）、AI 原始响应、解析结果全链路留痕
- **AnalysisRun Lifecycle（分析任务生命周期）** —— 支持进度、取消、异常任务对账，确保分析任务最终进入明确终态
- **StrategyOrder（策略订单）** —— 将 AI 决策转换为结构化订单对象
- **Risk Guard（风险守卫）** —— 在交易执行前进行规则校验
- **TESTNET Execution（测试网执行）** —— 真实调用 Binance Futures TESTNET（币安合约测试网）完成下单、撤单、止损止盈
- **RealTrade Reconciliation（真实交易对账）** —— 本地交易记录与交易所状态定期对账
- **Kill Switch（紧急停止开关）** —— 支持暂停自动化策略执行
- **Monitoring（持续监控）** —— 持续跟踪持仓和订单状态

## 这个项目重点解决什么

### 1. 把非结构化判断变成可执行决策

AI 不是直接读取一堆市场数据后自由输出文本，而是经过 Snapshot（快照）、Analysis Payload（分析输入）、Prompt（提示词）、Validation（校验）和 StrategyOrder（策略订单）逐层收敛，最终形成可被系统理解和执行的结果。

### 2. AI 不能直接拥有无限执行权

AI 输出与真实交易执行之间存在独立的 Risk Guard（风险守卫）和执行准入层。当前所有交易写操作在代码层面硬性限制为 Binance Futures TESTNET（币安合约测试网），不会静默切换到 LIVE（实盘）。

### 3. AI 的过程必须可追踪

系统保留每次分析的输入、Prompt（提示词）、原始响应、解析结果和最终业务记录。即使分析失败，证据也不会被直接丢弃。

### 4. 自动系统必须处理状态不一致

真实交易系统不能只关心“下单成功”。项目实现了分析任务生命周期、订单 / 持仓监控以及 RealTrade Reconciliation（真实交易对账），处理本地状态与交易所状态之间可能出现的偏差。

## Architecture（系统架构）

```text
Data Sources（11 类数据源）
        ↓
Snapshot Acquisition（数据快照）
        ↓
AnalysisPayload（结构化分析输入）
        ↓
Prompt Builder（提示词构建）
        ↓
AI Provider（AI 模型）
        ↓
Validation（结果校验）
        ↓
StrategyOrder（策略订单）
        ↓
Risk Guard（风险守卫）
        ↓
Execution（测试网执行）
        ↓
Position / RealTrade（持仓 / 真实交易记录）
        ↓
Monitoring / Reconciliation（监控 / 对账）
```

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 当前阶段

稳定基线：`pre-ai-analysis-v2`

当前最高优先级：**AI Analysis V2（AI 分析第二版）**。

```text
市场事实 → 市场判断 → 交易策略 → 账户 / 持仓适配 → 最终决策
```

设计顺序：

```text
AI Analysis（AI 分析）
→ Output Schema（输出结构）
→ Prompt（提示词）
→ Risk Guard（风险守卫）重新审视
```

详见 [PROJECT_STATUS.md](PROJECT_STATUS.md) 和 [ROADMAP.md](ROADMAP.md)。

## Safety Boundary（安全边界）

- 所有交易所写操作（下单、撤单、止损止盈、杠杆调整）目前**硬性限制为 Binance Futures TESTNET（币安合约测试网）**。
- 对 `LIVE` 环境提交写请求会被代码直接拒绝。
- 账户 / 持仓读取可配置 `TESTNET` 或 `LIVE`，但当前实际使用与验证均以 TESTNET 为主。
- 转向真实 LIVE（实盘）交易需要显式开发与重新审查，不存在“一键切换实盘”的路径。

## 技术实现

- **后端**：Node.js + TypeScript（TypeScript：JavaScript 的类型化语言），原生 `http` 模块
- **存储**：本地 JSON + SQLite（轻量级关系型数据库）
- **前端**：单文件 HTML Dashboard（仪表盘），无独立构建流程
- **交易所**：Binance Futures（币安 USDT 本位合约）
- **AI**：支持 OpenAI / Anthropic / Google / DeepSeek / OpenAI-compatible（兼容 OpenAI 接口）Provider（模型提供方）

## 如何运行

后端：

```bash
cd pipeline
npm install
npm run serve
# 或开发模式
npm run dev
```

默认服务地址：`http://localhost:8787`

前端：直接用浏览器打开 `prototype/index.html`。

其他命令：

```bash
cd pipeline
npm run typecheck
npm run fetch
npm run etf:snapshot
```

## 目录结构

```text
├── pipeline/                         # 后端：采集、分析、策略、执行、风控、监控
│   ├── src/
│   │   ├── server.ts                 # HTTP API 入口
│   │   ├── sources/ connectors/      # 数据源与 Provider（提供方）适配
│   │   ├── normalize/ fetchers.ts    # 数据归一化与统一注册
│   │   ├── analysis/                 # AI 分析引擎
│   │   ├── ai/                       # AI Provider 抽象层
│   │   ├── exchange/                 # Binance Futures 适配器
│   │   ├── strategy/                 # 策略订单、风控、执行、自动化、监控、对账
│   │   └── etf/ util/ db.ts          # 支撑模块
│   └── data/                         # 运行时数据，不进入版本控制
├── prototype/index.html              # 当前前端
├── *_SPEC.md                         # 工程契约文档
├── docs/                             # 架构与参考资料
└── analysis_evidence/                # 历史分析证据样本
```

## 文档入口

| 文档 | 用途 |
|---|---|
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | 当前真实状态、已完成能力、优先级、已知问题 |
| [Trading Decision System.md](Trading%20Decision%20System.md) | 产品决策系统理念与长期方向 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前真实系统架构 |
| [ROADMAP.md](ROADMAP.md) | NOW / NEXT / LATER 开发优先级 |
| [CHANGELOG.md](CHANGELOG.md) | 重要里程碑 |
| `AI_RESPONSE_SPEC.md` / `ANALYSIS_PAYLOAD_SPEC.md` / `PROMPT_BUILDER_SPEC.md` / `EXECUTION_SPEC.md` / `DATA_SOURCE_SPEC.md` | 各层冻结工程契约 |

## 关于“量化”

这个项目会使用程序化数据处理、技术指标、统计信息和规则风控等 Quantitative Methods（量化方法），但它的核心目标不是复制传统 Quant System（量化系统）。

项目真正探索的是：**AI 能否在有数据、有上下文、有约束、有证据链的前提下，承担更完整的交易决策过程。**
