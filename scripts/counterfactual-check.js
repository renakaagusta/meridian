#!/usr/bin/env node
/**
 * Counterfactual calibration — "were the pools we SKIPPED / REJECTED actually bad?"
 *
 * Stages:
 *   1. LP-screener LLM-skipped candidates — pools that passed the hard filters
 *      but the *LP* screener (Scout) declined. (read from decision-traces.jsonl,
 *      whose candidates are LP-shaped: fee_active_tvl_ratio / active_pct / tvl)
 *   2. Pre-filter rejections — pools the hard filters killed before they ever
 *      became candidates. (read from benchmark/rejected-pools.jsonl) This is the
 *      bigger blind spot: it tells us whether the FILTERS themselves are too tight.
 *   3. Trade-stack (Hunter) spot misses — tokens HUNTER actually skipped, read
 *      from evonic decision_log (agent_id=meridian_trader_screener). (issue #49)
 *      THIS is the trade-stack's real missed-opportunity metric. Stages 1–2 grade
 *      the *LP screener's* (Scout's) universe through a spot lens and so must NOT
 *      be read as trade-stack misses — they belong to the LP stack (being sunset).
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
// Trade-stack (Hunter) decisions live in evonic's sqlite, not meridian's jsonl.
const EVONIC_DB = process.env.EVONIC_DB || "/root/evonic/shared/db/evonic.db";
const HUNTER_AGENT = process.env.HUNTER_AGENT_ID || "meridian_trader_screener";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const CYCLES = opt("--cycles", 12);
const MIN_AGE_H = opt("--minAgeH", 2);
const REJECT_HRS = opt("--rejectHrs", 48);
const SPOT_HRS = opt("--spotHrs", 48);  // Hunter-skip lookback window for Stage 3
const SPOT_MAX = opt("--spotMax", 60);  // cap Stage 3 tokens graded (most-recent first) — keeps runtime bounded

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Stage 3 source: tokens HUNTER skipped, from evonic decision_log. Returns a
// Map(mint → {name, base_mint, ts}) of distinct mints skipped within the window
// and old enough to judge, excluding any mint the trade stack later acted on
// (BUY/PROCEED). Degrades to an empty map (with a console note) if the DB or the
// node:sqlite module is unavailable — never aborts the run.
async function readHunterSkips({ sinceHrs, cutoffMs }) {
  if (!fs.existsSync(EVONIC_DB)) {
    console.log(`[counterfactual] Stage 3 skipped — evonic DB not found at ${EVONIC_DB}`);
    return new Map();
  }
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch {
    console.log("[counterfactual] Stage 3 skipped — node:sqlite unavailable (need Node ≥ 22.5)");
    return new Map();
  }
  const out = new Map();
  try {
    const db = new DatabaseSync(EVONIC_DB, { readOnly: true });
    // mints the trade stack actually traded — never count these as misses
    const bought = new Set(
      db.prepare(
        `select distinct asset_mint m from decision_log
         where agent_id in (?, ?) and decision in ('BUY','PROCEED') and asset_mint is not null`
      ).all(HUNTER_AGENT, "meridian_trader_manager").map((r) => r.m)
    );
    const rows = db.prepare(
      `select ts, asset_mint, asset_symbol from decision_log
       where agent_id = ? and decision = 'SKIP' and asset_mint is not null
         and ts > datetime('now', ?) order by ts desc`
    ).all(HUNTER_AGENT, `-${Math.round(sinceHrs)} hours`);
    db.close?.();
    const distinctInWindow = new Set(rows.map((r) => r.asset_mint)).size;
    if (distinctInWindow > SPOT_MAX) {
      console.log(`[counterfactual] Stage 3: ${distinctInWindow} distinct Hunter skips in ${SPOT_HRS}h — grading the ${SPOT_MAX} most recent (raise with --spotMax)`);
    }
    for (const r of rows) {
      if (out.size >= SPOT_MAX) break; // rows are DESC by ts → keep the most recent SPOT_MAX
      const tsMs = Date.parse(r.ts.replace(" ", "T") + "Z"); // decision_log ts is UTC
      if (!Number.isFinite(tsMs) || tsMs > cutoffMs) continue; // too fresh to judge
      const mint = r.asset_mint;
      if (bought.has(mint) || out.has(mint)) continue;
      out.set(mint, { name: r.asset_symbol || mint.slice(0, 6), base_mint: mint, ts: r.ts, fee0: 0, vol0: 0 });
    }
  } catch (e) {
    console.log(`[counterfactual] Stage 3 skipped — evonic DB read failed: ${e.message}`);
    return new Map();
  }
  return out;
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

  // ── Stage 3: trade-stack (Hunter) spot misses (from evonic decision_log) ──
  const hunterSkips = await readHunterSkips({ sinceHrs: SPOT_HRS, cutoffMs: cutoff });

  console.log(`[counterfactual] grading ${skipped.size} LP-skipped + ${rejected.size} pre-filter-rejected + ${hunterSkips.size} Hunter-skipped...`);

  const results = [];
  for (const [pool, info] of skipped) results.push(await gradePool(pool, info));

  const rejResults = [];
  for (const [pool, info] of rejected) {
    const g = await gradePool(pool, info);
    rejResults.push({ ...g, reject_reason: info.reason });
  }

  // Hunter tokens have no Meteora pool to grade for LP — only the spot verdict
  // (from birdeye velocity by mint) is meaningful here.
  const hunterResults = [];
  for (const [mint, info] of hunterSkips) hunterResults.push(await gradePool(mint, info));

  // ── Aggregate ──
  const lpMissed = results.filter((r) => r.lp === "missed");
  const lpJudged = results.filter((r) => r.lp === "missed" || r.lp === "correct"); // exclude 'gone'
  const spotMissed = results.filter((r) => r.spot === "missed");
  const spotJudged = results.filter((r) => r.spot === "missed" || r.spot === "blowoff" || r.spot === "correct"); // exclude unknown/gone
  const spotUnknown = results.filter((r) => r.spot === "unknown");
  const blowoff = results.filter((r) => r.spot === "blowoff");

  const fMissed = rejResults.filter((r) => r.lp === "missed" || r.spot === "missed");
  const fJudged = rejResults.filter((r) => r.lp !== "gone");

  // ── Stage 3 aggregate — the trade-stack's real spot miss rate ──
  const hMissed = hunterResults.filter((r) => r.spot === "missed");
  const hBlowoff = hunterResults.filter((r) => r.spot === "blowoff");
  const hJudged = hunterResults.filter((r) => r.spot === "missed" || r.spot === "blowoff" || r.spot === "correct");
  const hUnknown = hunterResults.filter((r) => r.spot === "unknown" || r.spot === "gone");
  const hunterSpotMissRate = rate(hMissed.length, hJudged.length);

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
    // Stage 3 — trade-stack (Hunter) spot misses (THE trade-stack metric)
    hunter_spot_evaluated: hunterResults.length,
    hunter_spot_missed: hMissed.length,
    hunter_spot_judged: hJudged.length,
    hunter_spot_unknown: hUnknown.length,
    hunter_blowoff_avoided: hBlowoff.length,
    hunter_spot_miss_rate_pct: hunterSpotMissRate,
    // back-compat
    miss_rate_pct: lpMissRate,
    detail: results,
    filter_detail: rejResults,
    hunter_detail: hunterResults,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `counterfactual-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(out, null, 2));

  const fmtVol = (v) => `$${Math.round(num(v)).toLocaleString("en-US")}`;
  const pc = (v) => (v == null ? "?" : `${v.toFixed(1)}%`);
  console.log(`\n===== COUNTERFACTUAL: were our skips & rejections right? =====`);
  console.log(`\n── [LP stack — Scout] LLM-skipped DLMM candidates: ${results.length} ──`);
  console.log(`LP miss rate: ${lpMissRate}% (${lpMissed.length}/${lpJudged.length})`);
  for (const m of lpMissed.slice(0, 8)) console.log(`  LP MISSED ${m.name?.slice(0, 16)} | fee ${m.fee0}→${m.feeNow} | vol ${m.vol0}→${m.volNow}`);
  // NOTE: this "spot" verdict is over Scout's DLMM candidate universe, NOT Hunter's
  // funnel — do NOT read it as a trade-stack miss. The trade-stack number is Stage 3.
  console.log(`Spot-on-LP-universe (informational, NOT Hunter): ${spotMissed.length} missed / ${spotJudged.length} judged · ${blowoff.length} blow-off avoided · ${spotUnknown.length} unknown`);

  console.log(`\n── [LP stack] Pre-filter rejected (filters killed before LLM): ${rejResults.length} ──`);
  console.log(`Filter miss rate: ${out.filter_miss_rate_pct}% (${fMissed.length}/${fJudged.length}) — high = filters too strict`);
  for (const m of fMissed.slice(0, 10)) console.log(`  FILTER MISSED ${m.name?.slice(0, 16)} | reason "${(m.reject_reason || "").slice(0, 40)}" | lp=${m.lp} spot=${m.spot} | 24h ${pc(m.birdeye?.price24h)} vol ${fmtVol(m.birdeye?.vol24h)}`);

  console.log(`\n── [TRADE STACK — Hunter] spot misses (from evonic decision_log): ${hunterResults.length} graded ──`);
  if (hunterResults.length === 0) {
    console.log(`(no Hunter skips in the last ${SPOT_HRS}h old enough to judge, or DB unavailable)`);
  } else {
    console.log(`Hunter spot miss rate: ${hunterSpotMissRate}% (${hMissed.length}/${hJudged.length}) · ${hBlowoff.length} blow-off avoided · ${hUnknown.length} unknown/gone`);
    for (const m of hMissed.slice(0, 12)) console.log(`  HUNTER MISSED ${m.name?.slice(0, 18)} | 24h ${pc(m.birdeye?.price24h)} 4h ${pc(m.birdeye?.price4h)} vol ${fmtVol(m.birdeye?.vol24h)}`);
  }

  const verdictRate = hunterResults.length ? hunterSpotMissRate : lpMissRate;
  console.log(verdictRate > 40
    ? `\n⚠️ High trade-stack spot miss rate (${verdictRate}%) — Hunter may be too strict.`
    : `\n✅ Low trade-stack spot miss rate (${verdictRate}%) — Hunter's skips genuinely drained.`);
  console.log(`\nSaved → benchmark/counterfactual-${new Date().toISOString().slice(0, 10)}.json\n`);
}

main().catch((e) => { console.error("counterfactual error:", e.message); process.exit(1); });
