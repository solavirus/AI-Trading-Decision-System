# Roadmap

不使用 Sprint 编号，只按 NOW / NEXT / LATER 排列优先级。详细的"已完成"清单见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

## NOW

设计并实现 **AI Analysis V2**：

```
市场事实 → 市场判断 → 交易策略 → 账户/持仓适配 → 最终决策
```

顺序原则：先 AI Analysis 设计 → 再 Output Schema → 再 Prompt → 最后重新审视 Risk Guard。

## NEXT

- AI Output Contract（AI 输出契约）定稿
- Prompt V2 落地
- 用真实 AI 样本验证新 Schema/Prompt
- 仓位管理（Position Management）决策闭环端到端验证
- TESTNET 连续无人值守运行，观察真实稳定性

## LATER

- Monitoring / Trade List 的用户体验打磨
- Attribution / Learning —— 分析结果与实际交易表现的归因分析
- 数据源权重从静态配置改为可动态调整
- 支持更多交易对 / 更多交易所
- LIVE（实盘）—— 当前代码在写操作层面仍硬性限制为 TESTNET only，见 [ARCHITECTURE.md](ARCHITECTURE.md)
