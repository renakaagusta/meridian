#!/usr/bin/env node
/**
 * Counterfactual calibration — "were the pools we SKIPPED actually bad?"
 *
 * We veto/skip most candidates but never check what happened to them. This reads
 * the decision traces, finds candidates we did NOT deploy into, re-fetches their
 * current metrics, and scores whether each pool SUSTAINED good fee generation
 * (a missed opportunity → filters too strict) or COLLAPSED (a correct skip).
 *
 * Output: a precision read on the screener+challenger, saved to
 * benchmark/counterfactual-<date>.json. Run weekly (and pulled into bench:eval).
 *
 *   node scripts/counterfactual-check.js [--cycles 12] [--minAgeH 2]
 */

import fs from "fs";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";
import { getPoolDetail } from "../tools/screening.js";

net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "benchmark");
const TRACES = path.join(ROOT, "decision-traces.jsonl");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const CYCLES = opt("--cycles", 12);
const MIN_AGE_H = opt("--minAgeH", 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function readTraces() {
  if (!fs.existsSync(TRACES)) return [];
  const lines = fs.readFileSync(TRACES, "utf8").split("\n").filter(Boolean);
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function main() {
  const all = readTraces();
  const traces = all.filter((t) => t.cycle === "screening" && Array.isArray(t.inputs?.candidates)).slice(-CYCLES);
  // Pools we actually entered — never count these as "skipped".
  const deployedPools = new Set(all.filter((t) => t.cycle === "deploy" && t.decision?.pool).map((t) => t.decision.pool));

  // Collect skipped candidates (considered but not deployed), old enough to judge.
  const cutoff = Date.now() - MIN_AGE_H * 3600_000;
  const skipped = new Map(); // pool -> { name, base_mint, ts, fee0, vol0 }
  for (const t of traces) {
    if (new Date(t.ts).getTime() > cutoff) continue; // too fresh to judge outcome
    for (const c of t.inputs.candidates) {
      if (!c.pool || deployedPools.has(c.pool)) continue;
      if (!skipped.has(c.pool)) {
        skipped.set(c.pool, { name: c.name, base_mint: c.base_mint || null, ts: t.ts, fee0: num(c.fee_active_tvl_ratio), vol0: num(c.volume_window) });
      }
    }
  }

  if (skipped.size === 0) {
    console.log("[counterfactual] no judge-able skipped candidates yet (need traces older than " + MIN_AGE_H + "h).");
    return;
  }

  console.log(`[counterfactual] re-checking ${skipped.size} skipped pools...`);
  const { getBirdeyeVelocity } = await import("../tools/birdeye.js");
  const results = [];
  for (const [pool, info] of skipped) {
    let now = null;
    try { now = await getPoolDetail({ pool_address: pool }); } catch { /* delisted / gone */ }
    await sleep(150);

    // Birdeye token-level cross-check: did the TOKEN keep trading (24h volume +
    // not price-collapsed)? Catches missed runners even when the specific Meteora
    // pool drained (LPs rotate pools; the token can still be a fee opportunity).
    let be = null;
    if (info.base_mint) {
      try {
        const v = await getBirdeyeVelocity({ mint: info.base_mint });
        if (v?.found) {
          const d = v.velocity?.["24h"] || {};
          be = { vol24h: num(d.volume_usd), price24h: num(d.price_change_pct), holders: num(v.holder_count) };
        }
      } catch { /* scraper/CF hiccup — fall back to Meteora-only */ }
      await sleep(150);
    }

    if (!now && !be) { results.push({ pool, name: info.name, lp: "gone", spot: "gone", note: "delisted — correct skip" }); continue; }

    const feeNow = now ? num(now.fee_active_tvl_ratio) : 0;
    const volNow = now ? num(now.volume_window ?? now.volume) : 0;
    // ── LP miss: did the METEORA POOL keep earning fees? (the only thing an LP cares about) ──
    const feeHeld = info.fee0 > 0 ? feeNow >= info.fee0 * 0.6 : feeNow >= 0.3;
    const volHeld = info.vol0 > 0 ? volNow >= info.vol0 * 0.5 : volNow >= 1000;
    const lp = feeHeld && volHeld ? "missed" : "correct";
    // ── Spot miss: did the TOKEN trade a CLEAN runner Hunter could've caught? ──
    //   missed   = sustained volume + a tradeable up move (not a blow-off)
    //   blowoff  = up >50% (Hunter correctly avoids buying the top) — NOT counted as missed
    //   correct  = faded / illiquid
    let spot = "correct";
    if (be && be.vol24h >= 50_000) {
      if (be.price24h > 50) spot = "blowoff";
      else if (be.price24h >= 10) spot = "missed";
    }
    results.push({ pool, name: info.name, lp, spot, fee0: info.fee0, feeNow, vol0: info.vol0, volNow, birdeye: be });
  }

  const judged = results.filter((r) => r.lp !== "gone");
  const lpMissed = results.filter((r) => r.lp === "missed");
  const spotMissed = results.filter((r) => r.spot === "missed");
  const blowoff = results.filter((r) => r.spot === "blowoff");
  const lpMissRate = judged.length ? Math.round((lpMissed.length / judged.length) * 100) : 0;

  const out = {
    generated_at: new Date().toISOString(),
    skipped_evaluated: results.length,
    lp_missed: lpMissed.length,
    lp_correct: results.length - lpMissed.length,
    lp_miss_rate_pct: lpMissRate,
    spot_missed: spotMissed.length,
    blowoff_avoided: blowoff.length,
    // back-compat: keep miss_rate_pct = the honest LP number
    miss_rate_pct: lpMissRate,
    detail: results,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `counterfactual-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(out, null, 2));

  const fmtVol = (v) => `$${Math.round(num(v)).toLocaleString("en-US")}`;
  console.log(`\n===== COUNTERFACTUAL: were our skips right? =====`);
  console.log(`Skipped pools evaluated: ${results.length}`);
  console.log(`\nLP (did the pool keep earning fees?): ${lpMissed.length} missed → miss rate ${lpMissRate}%`);
  for (const m of lpMissed.slice(0, 8)) console.log(`  MISSED ${m.name?.slice(0, 16)} | fee ${m.fee0}→${m.feeNow} | vol ${m.vol0}→${m.volNow}`);
  console.log(`\nSpot (clean runner Hunter could've caught): ${spotMissed.length} missed · ${blowoff.length} blow-offs correctly avoided`);
  for (const m of spotMissed.slice(0, 8)) console.log(`  MISSED ${m.name?.slice(0, 16)} | 24h ${m.birdeye?.price24h?.toFixed?.(1)}% vol ${fmtVol(m.birdeye?.vol24h)}`);
  for (const m of blowoff.slice(0, 5)) console.log(`  blow-off ${m.name?.slice(0, 16)} | 24h +${m.birdeye?.price24h?.toFixed?.(0)}% vol ${fmtVol(m.birdeye?.vol24h)} (avoided)`);
  console.log(lpMissRate > 40
    ? "\n⚠️ High LP miss rate — screener may be too strict."
    : "\n✅ Low LP miss rate — skipped pools genuinely drained.");
  console.log(`\nSaved → benchmark/counterfactual-${new Date().toISOString().slice(0, 10)}.json\n`);
}

main().catch((e) => { console.error("counterfactual error:", e.message); process.exit(1); });
