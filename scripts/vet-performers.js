#!/usr/bin/env node
/**
 * Vet top-performer candidates through fabriq's FULL account history, then
 * (optionally) add the genuinely-sharp ones to the agent's smart-wallet list.
 *
 * WHY: the per-pool "top LPer" leaderboard (top-performers.js) is misleading —
 * many high-volume wallets in hot pools are net LOSERS overall. Real quality is
 * only visible in full-account stats (profit factor, net PnL), which fabriq
 * computes. We vet by:  profitFactor >= minPF  AND  netPnl > 0  AND positions >= minPos.
 *
 * fabriq's API JWT lives 60s, so we capture it live inside the logged-in Chrome
 * (CDP :9223, must be on a fabriq portfolio page) and batch-fetch in-page.
 *
 *   node scripts/vet-performers.js [--top 25] [--minPF 2] [--minPos 5] [--add]
 *   --add  also writes the vetted wallets to smart-wallets.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { addSmartWallet } from "../smart-wallets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "benchmark");
const CDP = "9223";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const TOPN = Number(opt("--top", 25));
const MIN_PF = Number(opt("--minPF", 2));
const MIN_POS = Number(opt("--minPos", 5));
const DO_ADD = args.includes("--add");

const ab = (...a) => execFileSync("agent-browser", ["--cdp", CDP, ...a], { encoding: "utf8" });

function loadCandidates() {
  const f = fs.readdirSync(OUT_DIR).filter((x) => x.startsWith("top-performers-")).sort().pop();
  if (!f) throw new Error("No top-performers leaderboard — run `npm run bench:top` first.");
  return JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")).leaderboard.slice(0, TOPN).map((w) => w.wallet);
}

function captureToken(seedWallet) {
  // Persistent fetch/XHR hook → window.__tok
  ab("eval", "(()=>{const _f=window.fetch;window.fetch=function(u,o){try{let a=o&&o.headers&&(o.headers.authorization||o.headers.Authorization);if(a&&/Bearer/.test(a))window.__tok=a;}catch(e){}return _f.apply(this,arguments)};const _s=XMLHttpRequest.prototype.setRequestHeader;XMLHttpRequest.prototype.setRequestHeader=function(k,v){try{if(/authorization/i.test(k)&&/Bearer/.test(String(v)))window.__tok=v;}catch(e){}return _s.apply(this,arguments)};window.__tok=null;return 'hooked'})()");
  // Trigger an authed request via the in-app wallet search (client-side nav, no Cloudflare)
  try { ab("find", "placeholder", "Search for other wallets", "fill", seedWallet); } catch { /* fallback below */ }
  try { ab("press", "Enter"); } catch { /* */ }
  ab("wait", "5000");
  const got = JSON.parse(ab("eval", "({got:!!window.__tok})") || "{}");
  return got.got === true || /"got":true/.test(JSON.stringify(got));
}

function batchFetch(wallets) {
  const q = "timezone=Asia%2FJakarta&sources=wallet&sources=hawkfi";
  const code = `(async()=>{const tok=window.__tok;if(!tok)return{error:'no token'};const ws=${JSON.stringify(wallets)};const out=[];for(const w of ws){try{const r=await fetch('https://apinew.fabriq.trade/portfolio/stats/'+w+'?${q}',{headers:{accept:'application/json',authorization:tok}});const j=await r.json();const s=j.data||{};out.push({wallet:w,status:r.status,netPnlUsd:s.netPnlUsd||0,pf:(s.profitFactorUsd&&s.profitFactorUsd.ratio)||0,winPct:(s.positionWinUsd&&s.positionWinUsd.percentage)||0,winLoss:(s.avgWinLoss&&s.avgWinLoss.ratioUsd)||0,positions:s.totalPositions||0,avgAddSol:s.avgAddLiquiditySol||0,feesUsd:s.totalFeesUsd||0});}catch(e){out.push({wallet:w,error:String(e).slice(0,40)});}}return{results:out};})()`;
  const raw = ab("eval", code, "--json");
  const d = JSON.parse(raw);
  const v = (d.data && d.data.result) || d.result || d;
  if (v.error) throw new Error(v.error);
  return v.results || [];
}

function main() {
  const candidates = loadCandidates();
  console.log(`[vet] ${candidates.length} candidates from leaderboard; capturing live fabriq token...`);
  if (!captureToken(candidates[0])) {
    console.error("[vet] Could not capture a fabriq token. Ensure Chrome (CDP :9223) is logged in and on a fabriq.trade portfolio page.");
    process.exit(1);
  }
  console.log("[vet] token captured — batch-fetching full-account stats...");
  const rows = batchFetch(candidates).filter((r) => !r.error && r.status === 200);

  const vetted = rows
    .filter((r) => r.pf >= MIN_PF && r.netPnlUsd > 0 && r.positions >= MIN_POS)
    .sort((a, b) => b.pf - a.pf);

  console.log(`\n===== VETTED SHARP WINNERS (PF>=${MIN_PF}, netPnl>0, positions>=${MIN_POS}) =====`);
  if (!vetted.length) console.log("(none passed — try lowering --minPF or --minPos)");
  for (const r of vetted) {
    console.log(`${r.wallet}  PF ${r.pf.toFixed(1)} | win ${r.winPct.toFixed(0)}% | PnL $${Math.round(r.netPnlUsd)} | ${r.positions} pos | ${r.avgAddSol.toFixed(2)}◎`);
  }

  const rejected = rows.filter((r) => !(r.pf >= MIN_PF && r.netPnlUsd > 0 && r.positions >= MIN_POS));
  console.log(`\n[vet] rejected ${rejected.length}/${rows.length} (low PF, net loss, or too few positions — incl. would-be misleading 'top LPers')`);

  fs.writeFileSync(path.join(OUT_DIR, `vetted-${new Date().toISOString().slice(0, 10)}.json`),
    JSON.stringify({ generated_at: new Date().toISOString(), criteria: { minPF: MIN_PF, minPos: MIN_POS }, vetted, rejected }, null, 2));

  if (DO_ADD && vetted.length) {
    console.log("\n[vet] adding vetted wallets to smart-wallets.json...");
    for (const r of vetted) {
      const res = addSmartWallet({ name: `fabriq-PF${r.pf.toFixed(0)}-${r.wallet.slice(0, 4)}`, address: r.wallet, category: "alpha", type: "lp" });
      console.log(`  ${res.success ? "+ added" : "· skip"} ${r.wallet.slice(0, 8)} ${res.error || ""}`);
    }
  } else if (!DO_ADD) {
    console.log("\n[vet] dry run — re-run with --add to write these to smart-wallets.json");
  }
  console.log();
}

main();
