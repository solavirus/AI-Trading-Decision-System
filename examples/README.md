# Examples（展示案例）

这里用于存放经过脱敏、可公开复核的真实运行案例。

## 已公开案例

- [`btc-4h-short-decision/`](btc-4h-short-decision/) — 一笔真实 BTC 4H（4小时）分析案例，展示 Market Facts（市场事实）→ AI Judgment（AI 判断）→ Structured Decision（结构化决策）→ Validation（校验）。该历史样本没有保存可公开对应的 TESTNET Execution（测试网执行）记录，因此案例中明确不把“系统具备执行能力”混同为“这笔样本已执行”。

## 公开案例标准

- 不包含 API Key（接口密钥）、账户标识、私人 URL（网址）或其他凭证。
- 不暴露不必要的真实账户余额、仓位规模或个人信息。
- 保留足够的 Decision Evidence（决策证据）：输入摘要、AI 判断、结构化决策与 Validation（校验）；如果存在 Risk Guard（风险守卫）和 TESTNET（测试网）执行记录，再继续保留对应结果。
- 清楚区分事实、AI 判断和系统执行结果，不把模型输出包装成既定事实。
- 不为了“看起来更完整”而补写不存在的执行记录。

历史开发期 `analysis_evidence` 不直接作为公开作品案例使用；只有经过脱敏与事实核对后的样本才进入本目录。
