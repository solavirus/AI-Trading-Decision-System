# Public Release Checklist（公开发布检查清单）

这个仓库准备转为 Public（公开）前，必须完成以下检查。

## 1. Current tree（当前文件）

- 确认 `.env`、运行时数据库、日志、本地账户状态没有进入版本控制。
- 检查 `pipeline/.env.example` 只包含空占位符，不包含真实 Key（密钥）。
- 检查 `examples/` 里的案例已经脱敏。
- 不把未经审查的 `analysis_evidence` 直接作为公开案例提交。

## 2. Git history（Git 历史）

仅删除当前文件**不等于**从历史中删除敏感数据。公开前必须在本地完整克隆仓库后扫描整个历史。

建议至少搜索：

```bash
git log -p --all -- . ':!package-lock.json'
git rev-list --objects --all
```

并使用 Secret Scanner（密钥扫描工具），例如 Gitleaks（Git 密钥扫描工具）或同类工具，对整个 Git History（Git 历史）扫描。

重点检查：

- Binance API Key / Secret（币安接口密钥）
- OpenAI / Anthropic / Google / DeepSeek API Key（模型接口密钥）
- FRED / Etherscan / CoinGlass / Xoomar Key（数据源密钥）
- 私有 Gateway / Relay URL（网关 / 中转地址）
- 账户标识、邮箱、真实余额和仓位信息
- 临时调试文件、导出的 `.env`、日志、数据库和 ZIP（压缩包）

如果历史里曾经出现真实密钥：

1. 先立即 Rotate / Revoke（轮换 / 吊销）对应密钥。
2. 再使用 `git filter-repo` 或等价工具清理 Git History（Git 历史）。
3. 清理后重新扫描，确认历史中不再包含敏感值。

## 3. Portfolio evidence（作品证据）

公开仓库建议至少保留：

- 一张真实产品截图。
- 一份当前架构说明。
- 一份经过脱敏的 Decision Case（决策案例）。
- 可运行的 CI（持续集成）检查。
- 清楚的 TESTNET / LIVE（测试网 / 实盘）安全边界。

## 4. Licensing（授权）

公开代码前明确 LICENSE（许可证）策略。不要因为仓库公开就默认允许他人复制、修改或商用。

这是需要项目所有者主动做出的法律 / 开源策略选择，因此当前仓库暂不自动添加许可证。
