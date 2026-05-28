#!/usr/bin/env node
/**
 * Top Meteora LP performers — discovers the best-performing LP wallets and
 * ranks them, so we have a pool of benchmark traders to track and learn from.
 *
 * Pipeline (all open APIs the bot already uses — no fabriq auth, no Cloudflare):
 *   1. pool-discovery-api.datapi.meteora.ag/pools  → top/active pools
 *   2. studyTopLPers({pool}) (Agent Meridian / LPAgent) → top LP wallets per pool
 *   3. aggregate by wallet, rank by realized PnL / ROI / win rate
 *
 * Run:  node scripts/top-performers.js [--pools 20] [--perPool 8] [--sort pnl|roi|winrate]
 * Out:  benchmark/top-performers-<date>.json  +  printed leaderboard
 */

import fs from "fs";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";
import { studyTopLPers } from "../tools/study.js";

net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "benchmark");
const DISCOVERY = "https://pool-discovery-api.datapi.meteora.ag/pools";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const POOLS = Number(opt("--pools", 20));
const PER_POOL = Number(opt("--perPool", 8));
const SORT = opt("--sort", "pnl"); // pnl | roi | winrate

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function topPools(limit) {
  // Active, real pools: sort by volume; the best LPers concentrate where there's flow.
  const url = `${DISCOVERY}?sortBy=volume&sortOrder=desc&limit=${limit}`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`pool-discovery HTTP ${r.status}`);
  const j = await r.json();
  const pools = Array.isArray(j) ? j : (j.data || j.pools || []);
  return pools
    .filter((p) => !p.is_blacklisted && (p.pool_type ? /dlmm/i.test(p.pool_type) : true))
    .map((p) => ({ pool: p.pool_address, name: p.name, fee_tvl: num(p.fee_tvl_ratio), volume: num(p.volume) }));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`\n[top-performers] scanning top ${POOLS} pools × ${PER_POOL} LPers...`);
  const pools = await topPools(POOLS);
  console.log(`[top-performers] ${pools.length} pools to study`);

  const byWallet = new Map();
  for (const p of pools) {
    try {
      const res = await studyTopLPers({ pool_address: p.pool, limit: PER_POOL });
      for (const l of res.lpers || []) {
        const s = l.summary || {};
        const w = l.owner;
        if (!w) continue;
        const prev = byWallet.get(w) || {
          wallet: w, pools: new Set(), total_pnl_usd: 0, roi: 0, win_rate: 0,
          total_positions: 0, avg_hold_hours: 0, balance_usd: 0,
          preferred_strategy: s.preferred_strategy, preferred_range_style: s.preferred_range_style,
        };
        prev.pools.add(p.name || p.pool);
        // these are owner-level aggregates from LPAgent — keep the richest seen
        prev.total_pnl_usd = Math.max(prev.total_pnl_usd, num(s.total_pnl_usd));
        prev.roi = Math.max(prev.roi, num(s.roi));
        prev.win_rate = Math.max(prev.win_rate, num(s.win_rate));
        prev.total_positions = Math.max(prev.total_positions, num(s.total_positions));
        prev.avg_hold_hours = num(s.avg_hold_hours) || prev.avg_hold_hours;
        prev.balance_usd = Math.max(prev.balance_usd, num(s.total_balance_usd));
        byWallet.set(w, prev);
      }
    } catch (e) {
      console.error(`[top-performers] skip ${p.name}: ${e.message}`);
    }
    await sleep(200); // be polite to the API
  }

  const sorters = {
    pnl: (a, b) => b.total_pnl_usd - a.total_pnl_usd,
    roi: (a, b) => b.roi - a.roi,
    winrate: (a, b) => (b.win_rate - a.win_rate) || (b.total_pnl_usd - a.total_pnl_usd),
  };
  const ranked = [...byWallet.values()]
    .map((w) => ({ ...w, pools: [...w.pools], pool_count: w.pools.size }))
    .sort(sorters[SORT] || sorters.pnl)
    .slice(0, 25);

  const out = {
    generated_at: new Date().toISOString(),
    sorted_by: SORT,
    pools_scanned: pools.length,
    wallets_found: byWallet.size,
    leaderboard: ranked,
  };
  const file = path.join(OUT_DIR, `top-performers-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log(`\n===== TOP METEORA LP PERFORMERS (by ${SORT}) =====`);
  console.log("rank  wallet                                        PnL$      ROI%   win%  pos  pools  strat");
  ranked.slice(0, 20).forEach((w, i) => {
    console.log(
      String(i + 1).padStart(3) + "  " +
      w.wallet.padEnd(45) + " " +
      ("$" + w.total_pnl_usd.toFixed(0)).padStart(8) + " " +
      (w.roi * 100).toFixed(1).padStart(6) + " " +
      (w.win_rate * 100).toFixed(0).padStart(5) + " " +
      String(w.total_positions).padStart(4) + " " +
      String(w.pool_count).padStart(5) + "  " +
      (w.preferred_strategy || "?")
    );
  });
  console.log(`\nSaved → ${path.relative(ROOT, file)}  (${byWallet.size} unique wallets across ${pools.length} pools)\n`);
}

main().catch((e) => { console.error("top-performers error:", e.message); process.exit(1); });
