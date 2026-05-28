#!/usr/bin/env node
/**
 * Benchmark comparison — our agent vs another trader, measured by the SAME
 * fabriq.trade yardstick (apples-to-apples), plus our internal performance.
 *
 * Reads the latest fabriq snapshot per wallet from benchmark/ (run
 * `node scripts/fabriq-bench.js <wallet>` first for each), and our agent's
 * own closed-position stats from lessons.json.
 *
 *   node scripts/bench-compare.js                 # us=our wallet, them=default target
 *   node scripts/bench-compare.js --us <w> --them <w>
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPerformanceSummary } from "../lessons.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "benchmark");

const OUR_WALLET = "EZB11yLPaywhRiw1eUmKM8Lxy6oCBQamXXmQ6kwy4CGR";
const TARGET_WALLET = "Ew7KqcKM7B1fKjPcc9myP2A7QujAcn2gU51g2irFnoJf";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const us = opt("--us", OUR_WALLET);
const them = opt("--them", TARGET_WALLET);

function latestSnapshot(wallet) {
  if (!fs.existsSync(OUT_DIR)) return null;
  const files = fs.readdirSync(OUT_DIR)
    .filter((f) => f.startsWith(`fabriq-${wallet}-`) && f.endsWith(".json"))
    .sort();
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(OUT_DIR, files[files.length - 1]), "utf8"));
}

function metrics(snap) {
  const s = snap?.stats || {};
  return {
    netPnlUsd: s.netPnlUsd ?? 0,
    netPnlSol: s.netPnlSol ?? 0,
    totalFeesUsd: s.totalFeesUsd ?? 0,
    positions: s.totalPositions ?? 0,
    pools: snap?.pnl_by_pool?.length ?? 0,
    txns: snap?.transactions?.length ?? 0,
    winPct: s.positionWinUsd?.percentage ?? 0,
    wins: s.positionWinUsd?.wins ?? 0,
    losses: s.positionWinUsd?.losses ?? 0,
    profitFactor: s.profitFactorUsd?.ratio ?? 0,
    avgWinLoss: s.avgWinLoss?.ratioUsd ?? 0,
    totalDepositsUsd: s.totalDepositsUsd ?? 0,
    roiPct: (s.totalDepositsUsd > 0) ? (s.netPnlUsd / s.totalDepositsUsd) * 100 : 0,
  };
}

const ourSnap = latestSnapshot(us);
const themSnap = latestSnapshot(them);

if (!themSnap) {
  console.error(`No snapshot for target ${them}. Run: node scripts/fabriq-bench.js ${them}`);
  process.exit(1);
}

const a = metrics(ourSnap);
const b = metrics(themSnap);
const f = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : "?");

const rows = [
  ["Net PnL (USD)", `$${f(a.netPnlUsd)}`, `$${f(b.netPnlUsd)}`],
  ["Net PnL (SOL)", f(a.netPnlSol, 4), f(b.netPnlSol, 4)],
  ["ROI %", `${f(a.roiPct, 2)}%`, `${f(b.roiPct, 2)}%`],
  ["Total fees (USD)", `$${f(a.totalFeesUsd)}`, `$${f(b.totalFeesUsd)}`],
  ["Positions", a.positions, b.positions],
  ["Pools traded", a.pools, b.pools],
  ["Transactions", a.txns, b.txns],
  ["Win %", `${f(a.winPct, 1)}% (${a.wins}W/${a.losses}L)`, `${f(b.winPct, 1)}% (${b.wins}W/${b.losses}L)`],
  ["Profit factor", f(a.profitFactor), f(b.profitFactor)],
  ["Avg win/loss", f(a.avgWinLoss), f(b.avgWinLoss)],
  ["Total deposited", `$${f(a.totalDepositsUsd)}`, `$${f(b.totalDepositsUsd)}`],
];

const W1 = 18, W2 = 26, W3 = 26;
const line = (c1, c2, c3) => `${String(c1).padEnd(W1)}│ ${String(c2).padEnd(W2)}│ ${String(c3)}`;
console.log("\n══════════ BENCHMARK: OUR AGENT vs TARGET ══════════\n");
console.log(line("Metric", `OURS (${us.slice(0, 6)}…)`, `TARGET (${them.slice(0, 6)}…)`));
console.log("─".repeat(W1) + "┼" + "─".repeat(W2 + 1) + "┼" + "─".repeat(W3));
for (const [m, x, y] of rows) console.log(line(m, x, y));

// Internal agent performance (closed positions tracked by our own engine)
const perf = getPerformanceSummary();
console.log("\n── Our agent's internal record (lessons.json) ──");
if (!perf) {
  console.log("No closed positions yet — agent is freshly deployed. Comparison becomes meaningful after it trades.");
} else {
  console.log(JSON.stringify(perf, null, 1));
}

if (!ourSnap || a.positions === 0) {
  console.log("\nNote: our wallet has no fabriq-visible trading history yet, so the head-to-head is not meaningful until the agent opens/closes real positions.");
}
console.log();
