# Quant Assistant

一个"给 AI 一笔资金，AI 自主分析市场、做出可解释交易决策、安全执行、持续管理仓位"的量化交易助手系统。

## 当前阶段

稳定基线：`pre-ai-analysis-v2`，准备进入 **AI Analysis V2** 重新设计阶段。
详见 [PROJECT_STATUS.md](PROJECT_STATUS.md)（当前状态）、[ROADMAP.md](ROADMAP.md)（优先级排期）、[ARCHITECTURE.md](ARCHITECTURE.md)（架构）、[CHANGELOG.md](CHANGELOG.md)（里程碑）。

## 如何启动

后端（数据采集 + 分析引擎 + 策略/执行 API，全部功能都在这一个服务里）：

```bash
cd pipeline
npm install
npm run serve        # 常驻本地服务，默认 http://localhost:8787
# 或
npm run dev          # 同上，文件变更自动重启（tsx watch）
```

前端：直接用浏览器打开 `prototype/index.html`（默认指向 `http://localhost:8787`，无需单独构建/安装）。

其他常用命令：

```bash
cd pipeline
npm run typecheck    # TypeScript 类型检查，不编译
npm run fetch        # 一次性拉取全部数据源，写 out/context-package.json（数据源验证用）
npm run etf:snapshot # 手动跑一次 ETF 资金流快照
```

## 技术栈

- **后端**：Node.js + TypeScript（`tsx` 直接运行 `.ts`，无编译构建步骤），无 Web 框架，原生 `http` 模块
- **存储**：本地 JSON 文件（带跨进程写锁的安全持久化原语）+ SQLite（`node:sqlite`，Node 内置模块，无需原生依赖）
- **前端**：单文件 HTML（无框架、无构建流程）
- **交易所**：Binance Futures（USDT 本位合约）
- **AI**：可插拔多 Provider（OpenAI / Anthropic / Google / DeepSeek / 自定义 OpenAI-compatible 中转）

## 目录结构

```
量化/
├── pipeline/                        # 后端：数据采集 + 分析引擎 + 策略/执行/风控 + HTTP API
│   ├── src/
│   │   ├── server.ts                # HTTP 入口
│   │   ├── sources/ connectors/ normalize/ fetchers.ts   # 11 个数据源
│   │   ├── analysis/                # 统一分析引擎（Snapshot→Payload→Prompt→AI→Validation→Record）
│   │   ├── ai/                      # AI Provider 抽象层
│   │   ├── exchange/                # Binance Futures 适配器
│   │   ├── strategy/                # StrategyOrder / Risk Guard / 执行 / Kill Switch / 自动化调度 / 监控
│   │   └── etf/ util/ db.ts         # 支撑模块
│   └── data/                        # 运行时数据（不在版本控制中）
├── prototype/index.html             # 前端（单文件 Dashboard）
├── *_SPEC.md                        # 各层的冻结契约文档
├── docs/                            # 架构索引等参考资料
└── analysis_evidence/、test-fixtures/、handoff_package/   # 历史样本/交接快照
```

## TESTNET / LIVE 状态

- 交易所写操作（下单/撤单/止损止盈/杠杆调整）**代码层面硬性限制为 Binance Futures TESTNET only**；对 `LIVE` 环境提交写请求会被直接拒绝并返回明确错误，不会静默放行。
- 账户/持仓读取支持配置为 `TESTNET` 或 `LIVE`，但目前实际使用与验证均在 TESTNET 上进行。
- 转向真实 LIVE 交易需要显式的后续开发与审查，当前不存在任何"顺手切换"的开关。

## 文档入口

| 文档 | 用途 |
|---|---|
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | 项目当前状态、已完成能力、当前优先级、已知问题 —— **最重要，优先读这份** |
| [ROADMAP.md](ROADMAP.md) | NOW / NEXT / LATER 优先级排期 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 真实架构与代码目录说明 |
| [CHANGELOG.md](CHANGELOG.md) | 重要里程碑记录 |
| `AI_RESPONSE_SPEC.md` / `ANALYSIS_PAYLOAD_SPEC.md` / `PROMPT_BUILDER_SPEC.md` / `EXECUTION_SPEC.md` / `DATA_SOURCE_SPEC.md` | 各层冻结契约，代码实现必须遵守 |
| `pipeline/README.md` | 数据源采集层的详细技术记录（历史较早，聚焦数据源本身） |
