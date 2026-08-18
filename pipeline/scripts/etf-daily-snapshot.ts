// Entry point for Windows Task Scheduler (or manual `npm run etf:snapshot`). Kept as a plain
// script rather than folded into server.ts, per the 2026-08-05 decision to trigger this via an
// OS-level scheduled task rather than an in-process timer — this runs, does its work, and exits,
// regardless of whether the local server is up.
import { loadEnvFile } from '../src/util/env.js';
loadEnvFile();
import { runDailySnapshot } from '../src/etf/snapshot.js';

async function main() {
  console.log(`[${new Date().toISOString()}] running ETF daily snapshot...`);
  const outcomes = await runDailySnapshot();
  console.table(outcomes);
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length) {
    console.log(`\n${failed.length}/${outcomes.length} 个 ticker 本次没有拿到数据（多数是因为对应发行商的 adapter 还没实现，见 src/etf/issuers/）`);
  }
}

main().catch((err) => {
  console.error('etf snapshot failed:', err);
  process.exit(1);
});
