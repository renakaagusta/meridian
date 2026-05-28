#!/usr/bin/env node
/**
 * Study top performers via fabriq — pulls each top-performer wallet's rich
 * fabriq profile (profit factor, win rate, avg win/loss, sizing, per-pool hold
 * times) and synthesizes WHAT THE WINNERS DO, with parameter implications for
 * our agent.
 *
 * Reads the latest benchmark/top-performers-*.json, studies the top N wallets.
 * Needs a fresh fabriq token in .fabriq-token (the API JWT expires in minutes,
 * so run right after refreshing it). Fetches in parallel to beat expiry.
 *
 *   node scripts/study-performers.js [--top 10]
 */

import fs from "fs";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";

net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "benchmark");
const API = "https://apinew.fabriq.trade";
const TZ = "Asia/Jakarta";

const args = process.argv.slice(2);
const TOPN = Number((() => { const i = args.indexOf("--top"); return i >= 0 ? args[i + 1] : 10; })());

const token = (() => {
  for (const p of [path.join(ROOT, ".fabriq-token"), "/tmp/fabriq_token.txt"]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  return process.env.FABRIQ_TOKEN || null;
})();
if (!token) { console.error("No .fabriq-token — refresh it first (open a fabriq portfolio page in the logged-in Chrome)."); process.exit(1); }

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const H = { accept: "application/json", authorization: `Bearer ${token}` };

function url(p, params = {}) {
  const u = new URL(API + p);
  for (const [k, v] of Object.entries(params)) Array.isArray(v) ? v.forEach((x) => u.searchParams.append(k, x)) : u.searchParams.set(k, v);
  return u.toString();
}
async function getJson(p, params) {
  const r = await fetch(url(p, params), { headers: H });
  if (r.status === 401) throw new Error("401 token expired");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function studyWallet(wallet) {
  const common = { timezone: TZ, sources: ["wallet", "hawkfi"] };
  const [stats, pools] = await Promise.all([
    getJson(`/portfolio/stats/${wallet}`, common),
    getJson(`/history/${wallet}/pnl-by-pool`, { page: 1, limit: 50, sortBy: "latest_close_ts", sortOrder: "desc", pnlCurrency: "USD", ...common, pnlScope: "pool", lastCloseScope: "pool", durationScope: "pool", depositsScope: "pool", withdrawalsScope: "pool", feesScope: "pool" }),
  ]);
  const s = stats.data || {};
  const poolRows = pools.data || [];
  const durs = poolRows.map((p) => num(p.duration)).filter((d) => d > 0).sort((a, b) => a - b);
  const medianDurH = durs.length ? durs[Math.floor(durs.length / 2)] / 3600 : null;
  return {
    wallet,
    netPnlUsd: num(s.netPnlUsd),
    totalFeesUsd: num(s.totalFeesUsd),
    feesPctOfPnl: num(s.netPnlUsd) ? (num(s.totalFeesUsd) / num(s.netPnlUsd)) * 100 : null,
    totalPositions: s.totalPositions ?? null,
    avgAddSol: num(s.avgAddLiquiditySol),
    winPct: s.positionWinUsd?.percentage ?? null,
    profitFactor: s.profitFactorUsd?.ratio ?? null,
    avgWinUsd: s.avgWinLoss?.avgWinUsd ?? null,
    avgLossUsd: s.avgWinLoss?.avgLossUsd ?? null,
    winLossRatio: s.avgWinLoss?.ratioUsd ?? null,
    poolsTraded: poolRows.length,
    medianHoldH: medianDurH,
  };
}

const median = (a) => { const x = a.filter((v) => Number.isFinite(v)).sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : null; };
const avg = (a) => { const x = a.filter((v) => Number.isFinite(v)); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; };

async function main() {
  const lbFile = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith("top-performers-")).sort().pop();
  if (!lbFile) { console.error("No top-performers leaderboard — run npm run bench:top first."); process.exit(1); }
  const lb = JSON.parse(fs.readFileSync(path.join(OUT_DIR, lbFile), "utf8")).leaderboard.slice(0, TOPN);
  console.log(`\n[study-performers] studying top ${lb.length} wallets via fabriq...`);

  const results = [];
  const settled = await Promise.allSettled(lb.map((w) => studyWallet(w.wallet)));
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") { results.push({ ...r.value, leaderboard: lb[i] }); }
    else console.error(`  ✗ ${lb[i].wallet.slice(0, 8)}: ${r.reason.message}`);
  });

  if (!results.length) { console.error("No wallets studied (token likely expired — refresh and retry)."); process.exit(1); }

  // ── Synthesize "what the winners do" ──
  const learnings = {
    studied: results.length,
    median_profit_factor: median(results.map((r) => r.profitFactor)),
    median_win_pct: median(results.map((r) => r.winPct)),
    median_win_loss_ratio: median(results.map((r) => r.winLossRatio)),
    median_hold_hours: median(results.map((r) => r.medianHoldH)),
    median_avg_add_sol: median(results.map((r) => r.avgAddSol)),
    median_pools_traded: median(results.map((r) => r.poolsTraded)),
    median_fees_pct_of_pnl: median(results.map((r) => r.feesPctOfPnl)),
    avg_loss_usd: avg(results.map((r) => r.avgLossUsd)),
    avg_win_usd: avg(results.map((r) => r.avgWinUsd)),
  };

  const out = { generated_at: new Date().toISOString(), learnings, wallets: results };
  const file = path.join(OUT_DIR, `study-performers-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log(`\n===== TOP PERFORMERS — fabriq profiles (${results.length}) =====`);
  console.log("wallet        PnL$     PF    win%  W/L    holdH  add◎   pools");
  for (const r of results) {
    console.log(
      r.wallet.slice(0, 12) + "  " +
      ("$" + Math.round(r.netPnlUsd)).padStart(7) + " " +
      num(r.profitFactor).toFixed(1).padStart(5) + " " +
      (r.winPct ?? 0).toFixed(0).padStart(4) + "  " +
      num(r.winLossRatio).toFixed(1).padStart(5) + " " +
      (r.medianHoldH ?? 0).toFixed(1).padStart(6) + " " +
      num(r.avgAddSol).toFixed(2).padStart(5) + "  " +
      r.poolsTraded
    );
  }
  const L = learnings, f2 = (v) => (v == null ? "?" : Number(v).toFixed(2));
  console.log(`\n===== WHAT THE WINNERS DO (medians) =====`);
  console.log(`Profit factor:   ${f2(L.median_profit_factor)}   (winners run; losers cut)`);
  console.log(`Win rate:        ${f2(L.median_win_pct)}%`);
  console.log(`Win/loss ratio:  ${f2(L.median_win_loss_ratio)}   (avg win $${f2(L.avg_win_usd)} vs avg loss $${f2(L.avg_loss_usd)})`);
  console.log(`Median hold:     ${f2(L.median_hold_hours)}h`);
  console.log(`Position size:   ${f2(L.median_avg_add_sol)} SOL`);
  console.log(`Pools traded:    ${f2(L.median_pools_traded)}`);
  console.log(`Fees % of PnL:   ${f2(L.median_fees_pct_of_pnl)}%   (>80% = fee-driven, not price bets)`);
  console.log(`\nSaved → ${path.relative(ROOT, file)}\n`);
}

main().catch((e) => { console.error("study-performers error:", e.message); process.exit(1); });
