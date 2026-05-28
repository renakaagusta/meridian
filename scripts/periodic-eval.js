#!/usr/bin/env node
/**
 * Periodic configuration evaluation — answers "are our parameters working, and
 * do they still match how winners trade?" Writes a dated report and (optionally)
 * a Telegram summary. Scheduled weekly by PM2 (ecosystem → meridian-eval).
 *
 * It checks four things:
 *   1. DEPLOY FUNNEL   — cycles vs deploys vs no-deploys vs challenger vetoes,
 *                        and the top rejection reasons (is the screener too tight?)
 *   2. OUR PERFORMANCE — realized PnL/win-rate from closed positions (lessons.json)
 *   3. CONFIG vs WINNERS — our key params next to the latest studied performer medians
 *   4. EVALUATOR    — if >=3 closes, an evidence-based param-change proposal
 *
 *   node scripts/periodic-eval.js
 */

import fs from "fs";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { getPerformanceSummary } from "../lessons.js";
import { getRecentDecisions } from "../decision-log.js";

net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "benchmark");

function readJsonl(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function readJson(file, fb) { try { const p = path.join(ROOT, file); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fb; } catch { return fb; } }
function latest(prefix) { if (!fs.existsSync(OUT_DIR)) return null; const f = fs.readdirSync(OUT_DIR).filter((x) => x.startsWith(prefix)).sort().pop(); return f ? readJson(path.join("benchmark", f), null) : null; }
const med = (a) => { const x = a.filter(Number.isFinite).sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : null; };

function deployFunnel() {
  const decisions = readJson("decision-log.json", { decisions: [] }).decisions;
  const counts = {};
  const reasons = {};
  for (const d of decisions) {
    counts[d.type] = (counts[d.type] || 0) + 1;
    if (d.type !== "deploy") {
      const r = (d.reason || "").slice(0, 50);
      if (r) reasons[r] = (reasons[r] || 0) + 1;
    }
  }
  const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return { counts, topReasons, total: decisions.length };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function main() {
  const date = new Date().toISOString().slice(0, 10);
  // Refresh the counterfactual calibration first so section 8 is current.
  try {
    const { execFileSync } = await import("child_process");
    execFileSync("node", [path.join(ROOT, "scripts/counterfactual-check.js"), "--minAgeH", "2"], { cwd: ROOT, stdio: "ignore", timeout: 120000 });
  } catch { /* best-effort */ }
  const lines = [`# Meridian config evaluation — ${date}`, ""];

  // 1. Deploy funnel
  const f = deployFunnel();
  lines.push("## 1. Deploy funnel (last ~100 decisions)");
  lines.push("```");
  lines.push("counts: " + JSON.stringify(f.counts));
  lines.push("deploy rate: " + (((f.counts.deploy || 0) / (f.total || 1)) * 100).toFixed(1) + "%");
  lines.push("top rejection reasons:");
  for (const [r, n] of f.topReasons) lines.push(`  ${n}×  ${r}`);
  lines.push("```");
  if (!f.counts.deploy) lines.push("> ⚠️ Zero deploys — inspect the dominant rejection reason above. If a single screener filter dominates, it is likely too tight for the current market.");

  // 2. Our performance
  const perf = getPerformanceSummary();
  lines.push("\n## 2. Our realized performance");
  lines.push(perf ? "```\n" + JSON.stringify(perf, null, 1) + "\n```" : "No closed positions yet.");

  // 3. Config vs winners
  const study = latest("study-performers-");
  const m = config.management, s = config.screening;
  lines.push("\n## 3. Our config vs studied winners");
  lines.push("```");
  lines.push(`OURS  size~${(config.management.deployAmountSol)}◎  recenter=${m.recenterEnabled}  stop=${m.stopLossPct}%  trail=${m.trailingTriggerPct}%  oorWait=${m.outOfRangeWaitMinutes}m`);
  lines.push(`      screener: botMax=${s.maxBotHoldersPct}%  organicMin=${s.minOrganic}  feesMin=${s.minTokenFeesSol}◎  binStep=[${s.minBinStep},${s.maxBinStep}]`);
  if (study?.wallets?.length) {
    const w = study.wallets;
    lines.push(`WINNERS (median of ${w.length}): PF=${med(w.map(x => x.profitFactor))?.toFixed(1)}  win=${med(w.map(x => x.winPct))?.toFixed(0)}%  hold=${med(w.map(x => x.medianHoldH))?.toFixed(1)}h  size=${med(w.map(x => x.avgAddSol))?.toFixed(1)}◎`);
  } else {
    lines.push("WINNERS: run `npm run bench:explore` (with Chrome logged in) to refresh.");
  }
  lines.push("```");

  // 4. Evaluator proposal (evidence-based, only with data)
  lines.push("\n## 4. Evaluator proposal");
  if (perf && (perf.total_positions_closed ?? 0) >= 3) {
    lines.push("Run `/evaluator` (REPL/Telegram) for an evidence-based param-change proposal; apply with `/evaluator apply`.");
  } else {
    lines.push("Skipped — need ≥3 closed positions for an evidence-based proposal.");
  }

  // ── 5. Cost / IL drag (gross fees vs net realized) ──
  const ldata = readJson("lessons.json", { performance: [] });
  const perfRecs = ldata.performance || [];
  lines.push("\n## 5. Cost / IL drag");
  if (perfRecs.length) {
    const grossFees = perfRecs.reduce((s, r) => s + num(r.fees_earned_usd), 0);
    const netPnl = perfRecs.reduce((s, r) => s + num(r.pnl_usd), 0);
    const drag = grossFees - netPnl; // fees we earned but lost to IL + slippage + (gas not captured)
    const writeTxs = (deployFunnel().counts.deploy || 0) * 3; // ~deploy+close+swap per round-trip
    lines.push("```");
    lines.push(`gross fees earned:  $${grossFees.toFixed(2)}`);
    lines.push(`net realized PnL:   $${netPnl.toFixed(2)}`);
    lines.push(`IL + slippage drag: $${drag.toFixed(2)}  (${grossFees > 0 ? Math.round((drag / grossFees) * 100) : 0}% of fees)`);
    lines.push(`~write txs:         ${writeTxs} (est gas ~$${(writeTxs * 0.01).toFixed(2)})`);
    lines.push("```");
    if (drag > grossFees * 0.5) lines.push("> ⚠️ IL/slippage is eating >50% of fees — favor bigger/fewer/longer-held positions over churn.");
  } else lines.push("No closed positions yet.");

  // ── 6. Capital utilization ──
  lines.push("\n## 6. Capital utilization");
  try {
    const { getMyPositions } = await import("../tools/dlmm.js");
    const { getWalletBalances } = await import("../tools/wallet.js");
    const [pos, bal] = await Promise.all([getMyPositions({ force: true }).catch(() => null), getWalletBalances({}).catch(() => null)]);
    const deployedUsd = (pos?.positions || []).reduce((s, p) => s + num(p.total_value_usd), 0);
    const liquidUsd = num(bal?.sol_usd);
    const total = deployedUsd + liquidUsd;
    const utilPct = total > 0 ? Math.round((deployedUsd / total) * 100) : 0;
    lines.push("```");
    lines.push(`deployed: $${deployedUsd.toFixed(2)} (${pos?.positions?.length ?? 0} positions) | idle SOL: $${liquidUsd.toFixed(2)} | utilization: ${utilPct}%`);
    lines.push("```");
    if (utilPct < 30) lines.push("> ⚠️ Most capital is idle (earning 0). If good pools exist, consider more concurrent positions / higher positionSizePct.");
  } catch (e) { lines.push("(could not fetch live balances)"); }

  // ── 7. Range efficiency by volatility band ──
  lines.push("\n## 7. Range efficiency by volatility (tune bins_below)");
  if (perfRecs.length) {
    const band = (v) => (!Number.isFinite(Number(v)) ? "?" : Number(v) < 2 ? "low(<2)" : Number(v) < 5 ? "mid(2-5)" : "high(5+)");
    const groups = {};
    for (const r of perfRecs) { const b = band(r.volatility); (groups[b] ||= []).push(num(r.range_efficiency)); }
    lines.push("```");
    for (const [b, arr] of Object.entries(groups)) {
      const avg = arr.reduce((s, x) => s + x, 0) / arr.length;
      lines.push(`${b.padEnd(9)} n=${arr.length}  avg in-range ${avg.toFixed(0)}%  ${avg < 50 ? "→ widen bins_below" : avg > 85 ? "→ could tighten for more fees" : "→ ok"}`);
    }
    lines.push("```");
  } else lines.push("No closed positions yet.");

  // ── 8. Counterfactual (were our skips right?) ──
  const cf = latest("counterfactual-");
  lines.push("\n## 8. Counterfactual (skipped-pool calibration)");
  if (cf) {
    lines.push("```");
    lines.push(`skipped evaluated: ${cf.skipped_evaluated} | correct: ${cf.correct_skips} | missed: ${cf.missed_opportunities} | miss rate ${cf.miss_rate_pct}%`);
    lines.push(cf.miss_rate_pct > 40 ? "⚠️ filters likely TOO STRICT — loosen" : "✅ filters mostly correct");
    lines.push("```");
  } else lines.push("Run `npm run bench:counterfactual` first.");

  lines.push("\n## Recommended cadence");
  lines.push("- **Daily** (auto): `meridian-snapshot` records both wallets → trend chart.");
  lines.push("- **Weekly** (auto): this report + refresh top pools (`npm run bench:top`).");
  lines.push("- **Weekly** (manual, Chrome): `npm run bench:vet --add` + `npm run bench:explore` to refresh followed winners & playbook.");
  lines.push("- **After ≥3 closes**: `/evaluator` to propose data-driven param changes.");

  const report = lines.join("\n");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `eval-${date}.md`);
  fs.writeFileSync(file, report);
  console.log(report);
  console.log(`\n[periodic-eval] saved → benchmark/eval-${date}.md`);
}

main().catch((e) => { console.error("periodic-eval error:", e.message); process.exit(1); });
