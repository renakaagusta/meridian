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

    if (!now && !be) { results.push({ pool, name: info.name, verdict: "gone", note: "delisted — correct skip" }); continue; }

    const feeNow = now ? num(now.fee_active_tvl_ratio) : 0;
    const volNow = now ? num(now.volume_window ?? now.volume) : 0;
    // Meteora-pool sustain (fee + volume held vs entry snapshot)
    const feeHeld = info.fee0 > 0 ? feeNow >= info.fee0 * 0.6 : feeNow >= 0.1;
    const volHeld = info.vol0 > 0 ? volNow >= info.vol0 * 0.5 : volNow >= 1000;
    const poolSustained = feeHeld && volHeld;
    // Birdeye token sustain: still >$50k/24h volume and not down >40%.
    const tokenSustained = be ? (be.vol24h >= 50_000 && be.price24h > -40) : false;
    const sustained = poolSustained || tokenSustained;
    results.push({
      pool, name: info.name,
      verdict: sustained ? "sustained(MISSED)" : "collapsed(correct)",
      fee0: info.fee0, feeNow, vol0: info.vol0, volNow,
      birdeye: be,
    });
  }

  const judged = results.filter((r) => r.verdict !== "gone");
  const missed = judged.filter((r) => r.verdict.startsWith("sustained"));
  const correct = results.length - missed.length; // collapsed + gone = correct skips
  const missRate = judged.length ? Math.round((missed.length / judged.length) * 100) : 0;

  const out = {
    generated_at: new Date().toISOString(),
    skipped_evaluated: results.length,
    correct_skips: correct,
    missed_opportunities: missed.length,
    miss_rate_pct: missRate,
    detail: results,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `counterfactual-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(out, null, 2));

  console.log(`\n===== COUNTERFACTUAL: were our skips right? =====`);
  console.log(`Skipped pools evaluated: ${results.length}`);
  console.log(`Correct skips (collapsed/gone): ${correct}`);
  console.log(`Missed opportunities (sustained): ${missed.length}  →  miss rate ${missRate}%`);
  if (missed.length) {
    console.log("\nPools we skipped that kept earning (review why we rejected):");
    for (const m of missed.slice(0, 10)) console.log(`  ${m.name?.slice(0, 16)} | fee ${m.fee0}→${m.feeNow} | vol ${m.vol0}→${m.volNow}`);
  }
  console.log(missRate > 40
    ? "\n⚠️ High miss rate — the screener/challenger may be TOO strict for this market."
    : "\n✅ Low miss rate — filters are mostly rejecting genuinely bad pools.");
  console.log(`\nSaved → benchmark/counterfactual-${new Date().toISOString().slice(0, 10)}.json\n`);
}

main().catch((e) => { console.error("counterfactual error:", e.message); process.exit(1); });
