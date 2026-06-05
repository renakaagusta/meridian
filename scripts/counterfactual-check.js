#!/usr/bin/env node
/**
 * Counterfactual calibration — "were the pools we SKIPPED / REJECTED actually bad?"
 *
 * Two stages (issue #35):
 *   1. LLM-skipped candidates — pools that passed the hard filters but the
 *      screener/challenger declined. (read from decision-traces)
 *   2. Pre-filter rejections — pools the hard filters killed before they ever
 *      became candidates. (read from benchmark/rejected-pools.jsonl) This is the
 *      bigger blind spot: it tells us whether the FILTERS themselves are too tight.
 *
 * For each, we re-fetch current metrics and score whether it SUSTAINED fee
 * generation / kept running (a missed opportunity) or COLLAPSED (a correct skip).
 *
 * Spot classification distinguishes a *sustained* runner (still liquid + volume +
 * not collapsed from its peak → MISSED) from a blow-off that dumped (correct
 * avoid) — instead of blindly calling every >50% move an "avoid". Missing data is
 * reported as `unknown`, never silently counted as `correct`.
 *
 *   node scripts/counterfactual-check.js [--cycles 12] [--minAgeH 2] [--rejectHrs 48]
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
const REJECT_LOG = path.join(ROOT, "benchmark", "rejected-pools.jsonl");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const CYCLES = opt("--cycles", 12);
const MIN_AGE_H = opt("--minAgeH", 2);
const REJECT_HRS = opt("--rejectHrs", 48);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

let _getVelocity = null;
async function fetchSignals(pool, base_mint) {
  let now = null;
  try { now = await getPoolDetail({ pool_address: pool }); } catch { /* delisted / gone */ }
  await sleep(150);
  let be = null;
  if (base_mint && _getVelocity) {
    try {
      const v = await _getVelocity({ mint: base_mint });
      if (v?.found) {
        const d = v.velocity?.["24h"] || {};
        be = {
          vol24h: num(d.volume_usd),
          price24h: numOrNull(d.price_change_pct),
          price4h: numOrNull(v.velocity?.["4h"]?.price_change_pct),
          price1h: numOrNull(v.velocity?.["1h"]?.price_change_pct),
          holders: num(v.holder_count),
        };
      }
    } catch { /* scraper/CF hiccup — be stays null → spot 'unknown' */ }
    await sleep(150);
  }
  return { now, be };
}

// Grade one pool given its at-decision snapshot {name, base_mint, fee0, vol0}.
async function gradePool(pool, info) {
  const { now, be } = await fetchSignals(pool, info.base_mint);
  if (!now && !be) return { pool, name: info.name, lp: "gone", spot: "gone", note: "delisted — correct skip" };

  // ── LP: did the Meteora pool keep earning fees? ──
  const feeNow = now ? num(now.fee_active_tvl_ratio) : 0;
  const volNow = now ? num(now.volume_window ?? now.volume) : 0;
  let lp;
  if (!now) {
    lp = "correct"; // pool gone from Meteora → nothing to LP → correct skip
  } else {
    const feeHeld = info.fee0 > 0 ? feeNow >= info.fee0 * 0.6 : feeNow >= 0.3;
    const volHeld = info.vol0 > 0 ? volNow >= info.vol0 * 0.5 : volNow >= 1000;
    lp = feeHeld && volHeld ? "missed" : "correct";
  }

  // ── Spot: sustained runner (MISSED) vs blow-off that dumped (correct avoid) ──
  //   unknown  = no token data → cannot judge (NOT counted as correct)
  //   correct  = illiquid / faded (didn't run)
  //   missed   = ran (≥10% / 24h) AND still holding — not collapsing from the top
  //   blowoff  = ran but is dumping hard from peak (we correctly avoided the top)
  let spot;
  if (!be) {
    spot = "unknown";
  } else if (be.vol24h < 50_000 || (be.price24h ?? 0) < 10) {
    spot = "correct";
  } else {
    const dumping = (be.price4h != null && be.price4h <= -25) || (be.price1h != null && be.price1h <= -15);
    spot = dumping ? "blowoff" : "missed";
  }

  return { pool, name: info.name, lp, spot, fee0: info.fee0, feeNow, vol0: info.vol0, volNow, birdeye: be };
}

function rate(missed, judged) { return judged ? Math.round((missed / judged) * 100) : 0; }

async function main() {
  _getVelocity = (await import("../tools/birdeye.js")).getBirdeyeVelocity;

  // ── Stage 1: LLM-skipped candidates (from decision-traces) ──
  const all = readJsonl(TRACES);
  const traces = all.filter((t) => t.cycle === "screening" && Array.isArray(t.inputs?.candidates)).slice(-CYCLES);
  const deployedPools = new Set(all.filter((t) => t.cycle === "deploy" && t.decision?.pool).map((t) => t.decision.pool));
  const cutoff = Date.now() - MIN_AGE_H * 3600_000;
  const skipped = new Map();
  for (const t of traces) {
    if (new Date(t.ts).getTime() > cutoff) continue;
    for (const c of t.inputs.candidates) {
      if (!c.pool || deployedPools.has(c.pool)) continue;
      if (!skipped.has(c.pool)) {
        skipped.set(c.pool, { name: c.name, base_mint: c.base_mint || null, ts: t.ts, fee0: num(c.fee_active_tvl_ratio), vol0: num(c.volume_window) });
      }
    }
  }

  // ── Stage 2: pre-filter rejections (from rejected-pools.jsonl) ──
  const rejCut = Date.now() - REJECT_HRS * 3600_000;
  const rejected = new Map();
  for (const r of readJsonl(REJECT_LOG)) {
    if (!r.pool || !r.base_mint) continue;                 // need a mint to judge the token
    if (new Date(r.ts).getTime() < rejCut) continue;       // only recent rejections
    if (new Date(r.ts).getTime() > cutoff) continue;       // old enough to judge outcome
    if (deployedPools.has(r.pool) || skipped.has(r.pool)) continue; // don't double-count
    if (!rejected.has(r.pool)) {
      rejected.set(r.pool, { name: r.name, base_mint: r.base_mint, ts: r.ts, reason: r.reason, fee0: num(r.fee_active_tvl_ratio), vol0: num(r.volume_window) });
    }
  }

  console.log(`[counterfactual] grading ${skipped.size} LLM-skipped + ${rejected.size} pre-filter-rejected pools...`);

  const results = [];
  for (const [pool, info] of skipped) results.push(await gradePool(pool, info));

  const rejResults = [];
  for (const [pool, info] of rejected) {
    const g = await gradePool(pool, info);
    rejResults.push({ ...g, reject_reason: info.reason });
  }

  // ── Aggregate ──
  const lpMissed = results.filter((r) => r.lp === "missed");
  const lpJudged = results.filter((r) => r.lp === "missed" || r.lp === "correct"); // exclude 'gone'
  const spotMissed = results.filter((r) => r.spot === "missed");
  const spotJudged = results.filter((r) => r.spot === "missed" || r.spot === "blowoff" || r.spot === "correct"); // exclude unknown/gone
  const spotUnknown = results.filter((r) => r.spot === "unknown");
  const blowoff = results.filter((r) => r.spot === "blowoff");

  const fMissed = rejResults.filter((r) => r.lp === "missed" || r.spot === "missed");
  const fJudged = rejResults.filter((r) => r.lp !== "gone");

  const lpMissRate = rate(lpMissed.length, lpJudged.length);

  const out = {
    generated_at: new Date().toISOString(),
    // Stage 1 — LLM skips
    skipped_evaluated: results.length,
    lp_missed: lpMissed.length,
    lp_correct: lpJudged.length - lpMissed.length,
    lp_miss_rate_pct: lpMissRate,
    spot_missed: spotMissed.length,
    spot_judged: spotJudged.length,
    spot_unknown: spotUnknown.length,
    spot_miss_rate_pct: rate(spotMissed.length, spotJudged.length),
    blowoff_avoided: blowoff.length,
    // Stage 2 — pre-filter rejections (are the FILTERS too strict?)
    filter_evaluated: rejResults.length,
    filter_missed: fMissed.length,
    filter_miss_rate_pct: rate(fMissed.length, fJudged.length),
    // back-compat
    miss_rate_pct: lpMissRate,
    detail: results,
    filter_detail: rejResults,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `counterfactual-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(out, null, 2));

  const fmtVol = (v) => `$${Math.round(num(v)).toLocaleString("en-US")}`;
  const pc = (v) => (v == null ? "?" : `${v.toFixed(1)}%`);
  console.log(`\n===== COUNTERFACTUAL: were our skips & rejections right? =====`);
  console.log(`\n── LLM-skipped (passed filters, then declined): ${results.length} ──`);
  console.log(`LP miss rate: ${lpMissRate}% (${lpMissed.length}/${lpJudged.length})`);
  for (const m of lpMissed.slice(0, 8)) console.log(`  LP MISSED ${m.name?.slice(0, 16)} | fee ${m.fee0}→${m.feeNow} | vol ${m.vol0}→${m.volNow}`);
  console.log(`Spot: ${spotMissed.length} missed / ${spotJudged.length} judged · ${blowoff.length} blow-off avoided · ${spotUnknown.length} unknown (no data)`);
  for (const m of spotMissed.slice(0, 8)) console.log(`  SPOT MISSED ${m.name?.slice(0, 16)} | 24h ${pc(m.birdeye?.price24h)} 4h ${pc(m.birdeye?.price4h)} vol ${fmtVol(m.birdeye?.vol24h)}`);

  console.log(`\n── Pre-filter rejected (filters killed before LLM): ${rejResults.length} ──`);
  console.log(`Filter miss rate: ${out.filter_miss_rate_pct}% (${fMissed.length}/${fJudged.length}) — high = filters too strict`);
  for (const m of fMissed.slice(0, 10)) console.log(`  FILTER MISSED ${m.name?.slice(0, 16)} | reason "${(m.reject_reason || "").slice(0, 40)}" | lp=${m.lp} spot=${m.spot} | 24h ${pc(m.birdeye?.price24h)} vol ${fmtVol(m.birdeye?.vol24h)}`);

  console.log(lpMissRate > 40 || out.filter_miss_rate_pct > 40
    ? "\n⚠️ High miss rate — screener/filters may be too strict."
    : "\n✅ Low miss rate — skipped & rejected pools genuinely drained.");
  console.log(`\nSaved → benchmark/counterfactual-${new Date().toISOString().slice(0, 10)}.json\n`);
}

main().catch((e) => { console.error("counterfactual error:", e.message); process.exit(1); });
