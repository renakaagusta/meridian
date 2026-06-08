#!/usr/bin/env node
/**
 * Trade-stack scoreboard — the before/after read for the entry-unblock work
 * (graduated top10 gate #39 + feed cleanup). One command emits the whole funnel
 * so a snapshot taken now can be compared against one taken in a week.
 *
 * Sections:
 *   1. Hunter funnel       — screen PROCEED vs SKIP + daily PROCEED rate (decision_log)
 *   2. SKIP reason mix     — which filter is killing candidates (top10 / bundler / vol / other)
 *   3. Skeptic calibration — deduped veto outcomes: saved vs missed runners (veto_outcomes)
 *   4. Entries             — Hands actions in window + live trade:<mint> bags (proves Atlas wakes Hands)
 *   5. Trade PnL           — realized SOL via on-chain reconstruction (trade-onchain.mjs)
 *
 * Reads the shared Evonic db (decision_log, veto_outcomes, meridian_shared_memory).
 *   node scripts/trade-stack-report.js [--days 7] [--no-pnl]
 */

import path from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVONIC_DIR = process.env.EVONIC_DIR || "/root/evonic";
const DB_PATH = process.env.EVONIC_DB || path.join(EVONIC_DIR, "shared", "db", "evonic.db");
const OUT_DIR = process.env.PNL_OUT_DIR || path.join(ROOT, "reports", "pnl");

const flags = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith("--") ? [[a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]] : [])
);
const DAYS = flags.days ? parseInt(flags.days) : 7;
const WITH_PNL = !flags["no-pnl"];
const SCREENER = "meridian_trader_screener";

const f0 = (x) => (x == null ? 0 : x);
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

function bucketSkip(reason) {
  const s = (reason || "").toLowerCase();
  if (/top.?10|concentration|holder_pct/.test(s)) return "top10>cap";
  if (/bundler|5tzfki|cluster|funder/.test(s)) return "bundler/cluster";
  if (/wrong chain|ethereum|\bbsc\b|base chain|evm/.test(s)) return "wrong-chain";
  if (/vol .* below|volume.*\$?\d.*below|< ?\$5k|5m vol/.test(s)) return "low/zero volume";
  if (/parabolic|blow.?off|crash|reversing|negative|rolling over/.test(s)) return "momentum gone";
  if (/fabricat|stale|disagree|inverted/.test(s)) return "stale/fabricated";
  if (/rugcheck|lp unlocked|honeypot|mint|freeze|authority/.test(s)) return "rug/authority";
  if (/tvl|liquid/.test(s)) return "liquidity/tvl";
  if (/mcap|market cap|fdv|age|old|distribution-phase/.test(s)) return "mcap/age";
  if (/memory|cycle|same as|repeat/.test(s)) return "repeat/memory";
  return "other";
}

function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const since = `datetime('now','-${DAYS} days')`;
  console.log(`\n===== TRADE-STACK REPORT · last ${DAYS}d · ${new Date().toISOString().slice(0, 16)}Z =====`);

  // 1. Hunter funnel
  console.log(`\n## 1. Hunter funnel (${SCREENER})`);
  const totals = db.prepare(
    `SELECT decision, count(*) n FROM decision_log WHERE agent_id=? AND phase IN ('screen','skip') AND ts>${since} GROUP BY decision`
  ).all(SCREENER);
  const proceed = f0(totals.find((r) => r.decision === "PROCEED")?.n);
  const skip = totals.filter((r) => r.decision !== "PROCEED").reduce((s, r) => s + r.n, 0);
  console.log(`   PROCEED ${proceed} / SKIP ${skip}  →  PROCEED rate ${pct(proceed, proceed + skip)}%`);
  console.log("   by day:");
  for (const r of db.prepare(
    `SELECT date(ts) d, sum(decision='PROCEED') proceed, count(*) seen FROM decision_log
     WHERE agent_id=? AND ts>${since} GROUP BY d ORDER BY d`
  ).all(SCREENER)) {
    console.log(`     ${r.d}  proceed=${f0(r.proceed)}  seen=${r.seen}`);
  }

  // 2. SKIP reason mix
  console.log(`\n## 2. SKIP reason mix (${DAYS}d)`);
  const skips = db.prepare(
    `SELECT primary_reason pr FROM decision_log WHERE agent_id=? AND decision='SKIP' AND ts>${since}`
  ).all(SCREENER);
  const buckets = {};
  for (const r of skips) { const b = bucketSkip(r.pr); buckets[b] = (buckets[b] || 0) + 1; }
  for (const [b, n] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${b.padEnd(18)} ${n}  (${pct(n, skips.length)}%)`);
  }

  // 3. Skeptic veto calibration (deduped latest per verdict)
  console.log(`\n## 3. Skeptic veto calibration (deduped, latest per verdict)`);
  const rows = db.prepare(`
    WITH latest AS (
      SELECT verdict_key, classification, symbol, return_since_veto_pct,
             ROW_NUMBER() OVER (PARTITION BY verdict_key ORDER BY checked_at DESC) rn
      FROM veto_outcomes WHERE agent_id='skeptic')
    SELECT classification, symbol, return_since_veto_pct r FROM latest WHERE rn=1`).all();
  let saved = 0, missed = 0, won = 0, lost = 0;
  const missedList = [];
  for (const r of rows) {
    const c = r.classification || "";
    if (c.startsWith("saved")) saved++;
    else if (c.startsWith("missed")) { missed++; missedList.push(r); }
    else if (c.startsWith("proceed_won")) won++;
    else if (c.startsWith("proceed_lost")) lost++;
  }
  const vetos = saved + missed;
  console.log(`   unique verdicts: ${rows.length}`);
  console.log(`   VETOs ${vetos}: saved ${saved} (${pct(saved, vetos)}%) · MISSED ${missed} (${pct(missed, vetos)}%)`);
  console.log(`   PROCEEDs: won ${won} · lost ${lost}   ← watch lost not spiking (= letting rugs in)`);
  if (missedList.length) {
    console.log("   missed runners:");
    for (const m of missedList.sort((a, b) => f0(b.r) - f0(a.r)).slice(0, 8))
      console.log(`     ${(m.symbol || "?").padEnd(12)} ${f0(m.r) > 0 ? "+" : ""}${Math.round(f0(m.r))}%  ${m.classification}`);
  }

  // 4. Entries
  console.log(`\n## 4. Entries`);
  const handsActs = db.prepare(
    `SELECT decision, count(*) n FROM decision_log WHERE agent_id='meridian_trader_manager' AND ts>${since} GROUP BY decision`
  ).all();
  console.log(`   Hands actions (${DAYS}d): ${handsActs.map((r) => `${r.decision}=${r.n}`).join(" ") || "none"}`);
  const bags = db.prepare(`SELECT key FROM meridian_shared_memory WHERE key LIKE 'trade:%'`).all();
  console.log(`   live trade:<mint> bags now: ${bags.length}${bags.length ? " → " + bags.map((b) => b.key.slice(6, 14)).join(",") : " (Hands idle by design)"}`);

  db.close();

  // 5. Trade PnL (optional, on-chain)
  if (!WITH_PNL) { console.log(`\n## 5. Trade PnL — skipped (--no-pnl)\n`); return; }
  console.log(`\n## 5. Trade PnL (on-chain reconstruction)`);
  return tradePnl().then((t) => {
    if (t.error) { console.log(`   unavailable: ${t.error} (run scripts/daily-pnl.js)`); }
    else {
      console.log(`   realized net: ${t.post.realized_sol >= 0 ? "+" : ""}${t.post.realized_sol.toFixed(4)} SOL` +
        `  (closed ${t.post.closed}, wins ${t.post.wins})`);
      console.log(`   windows: 1d ${fmt(t.windows.d1)} · 3d ${fmt(t.windows.d3)} · 7d ${fmt(t.windows.d7)}`);
    }
    console.log("");
  });
}
const fmt = (w) => `${f0(w?.net) >= 0 ? "+" : ""}${f0(w?.net).toFixed(3)} SOL (${f0(w?.n)})`;

async function tradePnl() {
  try {
    const { computeTradeStack } = await import("./trade-onchain.mjs");
    let wallet = process.env.WALLET_PUBKEY;
    let solPrice = 0;
    if (!wallet) { try { const w = await import("../tools/wallet.js"); const b = await w.getWalletBalances(); wallet = w.getWallet().publicKey.toString(); solPrice = Number(b.sol_price) || 0; } catch {} }
    return await computeTradeStack({
      wallet,
      poolMemoryPath: path.join(ROOT, "pool-memory.json"),
      lessonsPath: path.join(ROOT, "lessons.json"),
      cachePath: path.join(OUT_DIR, ".tx-cache.json"),
      solPrice,
    });
  } catch (e) { return { error: e.message }; }
}

const r = main();
if (r && typeof r.then === "function") await r;
