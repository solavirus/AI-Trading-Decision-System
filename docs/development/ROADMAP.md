# Roadmap

不使用 Sprint（冲刺）编号，只按 NOW / NEXT / LATER（当前 / 下一步 / 后续）排列优先级。已完成能力见 `PROJECT_STATUS.md`。

## NOW

设计并实现 **AI Analysis V2（AI 分析第二版）**：

```text
市场事实 → 市场判断 → 交易策略 → 账户 / 持仓适配 → 最终决策
```

顺序原则：先 AI Analysis（AI 分析）→ Output Schema（输出结构）→ Prompt（提示词）→ 最后重新审视 Risk Guard（风险守卫）。

## NEXT

- AI Output Contract（AI 输出契约）定稿
- Prompt V2（提示词第二版）落地
- 用真实 AI 样本验证新 Schema（结构）/ Prompt（提示词）
- Position Management（仓位管理）决策闭环端到端验证
- TESTNET（测试网）连续无人值守运行
- 完成至少一个经过脱敏的公开 Case Study（案例研究）

## LATER

- Monitoring / Trade List UX（监控 / 交易列表用户体验）
- Attribution / Learning（归因 / 学习）
- 数据源权重动态调整
- 更多交易对 / 更多交易所
- LIVE（实盘）—— 当前写操作仍硬性限制为 TESTNET（测试网）
