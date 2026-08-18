import { mkdirSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from './util/env.js';
loadEnvFile();

import type { ContextPackage, SourceKey, SourceResult, WeightConfig } from './types.js';
import { DEFAULT_WEIGHTS, WEIGHT_DEFS } from './weights.js';
import { GLOBAL_TOKEN_BUDGET } from './caps.js';
import { applyBudget } from './filter.js';
import { FETCHERS } from './fetchers.js';

/** --weights=technical:0,news:0 overrides individual weights from the CLI, e.g. to demo that a
 * zero-weight source gets hard-excluded, without editing code. Anything not listed keeps its default. */
function parseWeightOverrides(argv: string[]): Partial<Record<SourceKey, number>> {
  const arg = argv.find((a) => a.startsWith('--weights='));
  if (!arg) return {};
  const out: Partial<Record<SourceKey, number>> = {};
  for (const pair of arg.slice('--weights='.length).split(',')) {
    const [k, v] = pair.split(':');
    if (k && v !== undefined) out[k as SourceKey] = Number(v);
  }
  return out;
}

async function main() {
  const overrides = parseWeightOverrides(process.argv.slice(2));
  const weights: WeightConfig[] = DEFAULT_WEIGHTS.map((w) => ({
    key: w.key,
    weight: overrides[w.key] ?? w.weight,
  }));
  const totalWeight = weights.reduce((s, w) => s + w.weight, 0);

  console.log(`\n采集 ${weights.length} 个数据源（多采集）...\n`);

  const results = await Promise.all(
    weights.map(async (w) => {
      const t0 = Date.now();
      const result = await FETCHERS[w.key]();
      return { result, weight: w.weight, ms: Date.now() - t0 };
    })
  );

  const budgeted = results.map(({ result, weight }) => applyBudget(result, weight, totalWeight));

  const pkg: ContextPackage = {
    asset: 'BTC/USDT',
    generatedAt: Date.now(),
    totalTokenBudget: GLOBAL_TOKEN_BUDGET,
    totalTokensEstimated: budgeted.reduce((s, b) => s + b.tokensEstimated, 0),
    sources: budgeted,
  };

  printReport(results, budgeted);

  mkdirSync('out', { recursive: true });
  const outPath = `out/context-package.json`;
  writeFileSync(outPath, JSON.stringify(pkg, null, 2), 'utf8');
  console.log(`\n完整结果（少输入后的最终结果，供下一步摘要/策略使用）已写入 ${outPath}`);
  console.log(`总计 tokens：${pkg.totalTokensEstimated} / ${pkg.totalTokenBudget}（预算内 ${pkg.totalTokensEstimated <= pkg.totalTokenBudget ? '✓' : '✗ 超出'}）`);
}

function printReport(
  results: { result: SourceResult; weight: number; ms: number }[],
  budgeted: ReturnType<typeof applyBudget>[]
) {
  const labelOf = (key: SourceKey) => WEIGHT_DEFS.find((w) => w.key === key)?.label ?? key;
  const rows = results.map(({ result, weight, ms }) => {
    const b = budgeted.find((x) => x.key === result.key)!;
    return {
      来源: labelOf(result.key),
      权重: weight,
      状态: result.status,
      原始条数: result.itemsRaw.length,
      采纳条数: b.itemsIncluded.length,
      预算tokens: b.tokenBudget,
      实际tokens: b.tokensEstimated,
      正反证据保留: weight > 0 ? (b.counterEvidencePreserved ? '✓' : '✗') : '-',
      耗时ms: ms,
      备注: result.note ?? b.note ?? '',
    };
  });
  console.table(rows);

  const failed = budgeted.filter((b) => b.status !== 'ok');
  if (failed.length) {
    console.log('\n未产出真实数据的来源：');
    for (const f of failed) {
      console.log(`  - ${labelOf(f.key)}（${f.status}）：${f.note ?? ''}`);
    }
  }
}

main().catch((err) => {
  console.error('pipeline run failed:', err);
  process.exit(1);
});
