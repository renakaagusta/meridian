#!/usr/bin/env node
/**
 * Explore HOW the vetted top performers trade — pulls each wallet's per-pool
 * history and full transaction stream from fabriq and reverse-engineers the
 * playbook: pool/token selection, bin steps, hold times, position layering,
 * entry/exit cadence, fee-harvesting, sizing.
 *
 * Uses the live in-page fabriq token (60s) via Chrome CDP :9223 (must be on a
 * logged-in fabriq portfolio page). Run after `npm run bench:vet`.
 *
 *   node scripts/explore-trades.js [--wallets w1,w2,...]
 */

import fs from "fs";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "benchmark");
const CDP = "9223";
const ab = (...a) => execFileSync("agent-browser", ["--cdp", CDP, ...a], { encoding: "utf8" });

const args = process.argv.slice(2);
const optWallets = (() => { const i = args.indexOf("--wallets"); return i >= 0 ? args[i + 1].split(",") : null; })();

function defaultWallets() {
  const f = fs.readdirSync(OUT_DIR).filter((x) => x.startsWith("vetted-")).sort().pop();
  const vetted = f ? JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")).vetted.map((v) => v.wallet) : [];
  const target = "Ew7KqcKM7B1fKjPcc9myP2A7QujAcn2gU51g2irFnoJf";
  return [...new Set([...vetted, target])];
}

const TRIGGER = "Ew7KqcKM7B1fKjPcc9myP2A7QujAcn2gU51g2irFnoJf";

// Capture a fresh fabriq Bearer (60s-lived) by doing a REAL navigation via
// devctl (passes Cloudflare with the logged-in profile) and reading the
// Authorization header off the resulting apinew request in the HAR.
function captureToken() {
  ab("network", "har", "start", "/tmp/explore.har");
  execFileSync("devctl", ["chrome", "open", `https://fabriq.trade/portfolio-beta?walletAddress=${TRIGGER}`], { encoding: "utf8" });
  ab("wait", "8000");
  ab("network", "har", "stop");
  const dir = path.join(process.env.HOME, ".agent-browser/tmp/har");
  const newest = fs.readdirSync(dir).filter((f) => f.endsWith(".har"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  const har = JSON.parse(fs.readFileSync(path.join(dir, newest.f), "utf8"));
  const e = har.log.entries.find((x) => x.request.url.includes("apinew.fabriq.trade") &&
    x.request.headers.find((h) => /^authorization$/i.test(h.name)));
  if (!e) return null;
  return e.request.headers.find((h) => /^authorization$/i.test(h.name)).value.replace(/^Bearer /i, "");
}

async function nodeFetchDetail(wallets, token) {
  const q = "timezone=Asia%2FJakarta&sources=wallet&sources=hawkfi";
  const H = { accept: "application/json", authorization: `Bearer ${token}` };
  const out = {};
  await Promise.all(wallets.map(async (w) => {
    try {
      const [pr, tr] = await Promise.all([
        fetch(`https://apinew.fabriq.trade/history/${w}/pnl-by-pool?page=1&limit=50&sortBy=latest_close_ts&sortOrder=desc&pnlCurrency=USD&${q}&pnlScope=pool&lastCloseScope=pool&durationScope=pool&depositsScope=pool&withdrawalsScope=pool&feesScope=pool`, { headers: H }),
        fetch(`https://apinew.fabriq.trade/history/${w}/transactions?page=1&limit=100&sources=wallet&sources=hawkfi`, { headers: H }),
      ]);
      const pj = await pr.json(); const tj = await tr.json();
      const pools = (pj.data || []).map((p) => ({
        sym: p.pool?.tokenX?.symbol || "?",
        binStep: p.pool?.params ? (p.pool.params.bin_step || p.pool.params.binStep || null) : null,
        posCount: p.position_count, addUsd: +p.total_add_usd, pnlUsd: +p.total_pnl_usd,
        pnlPct: +p.total_pnl_pct_usd, feeUsd: +p.total_fee_usd, durH: p.duration ? +(p.duration / 3600).toFixed(2) : null,
      }));
      const txns = (tj.data || []).map((t) => ({ type: t.type, ts: t.created_at, usd: +t.total_in_usd || 0 }));
      out[w] = { pools, txns, txnTotal: tj.total || txns.length };
    } catch (e) { out[w] = { error: String(e.message).slice(0, 50) }; }
  }));
  return out;
}

function fetchDetail(wallets) {
  const q = "timezone=Asia%2FJakarta&sources=wallet&sources=hawkfi";
  const code = `(async()=>{const tok=window.__tok;if(!tok)return{error:'no token'};const ws=${JSON.stringify(wallets)};const q='${q}';const out={};for(const w of ws){try{
    const pr=await fetch('https://apinew.fabriq.trade/history/'+w+'/pnl-by-pool?page=1&limit=50&sortBy=latest_close_ts&sortOrder=desc&pnlCurrency=USD&'+q+'&pnlScope=pool&lastCloseScope=pool&durationScope=pool&depositsScope=pool&withdrawalsScope=pool&feesScope=pool',{headers:{accept:'application/json',authorization:tok}});
    const pj=await pr.json();
    const pools=(pj.data||[]).map(p=>({sym:(p.pool&&p.pool.tokenX&&p.pool.tokenX.symbol)||'?',binStep:(p.pool&&p.pool.params)?(p.pool.params.bin_step||p.pool.params.binStep||null):null,baseFee:(p.pool&&p.pool.params)?(p.pool.params.base_fee_pct||p.pool.params.base_fee||null):null,posCount:p.position_count,addUsd:+p.total_add_usd,pnlUsd:+p.total_pnl_usd,pnlPct:+p.total_pnl_pct_usd,feeUsd:+p.total_fee_usd,durH:p.duration?+(p.duration/3600).toFixed(2):null}));
    const tr=await fetch('https://apinew.fabriq.trade/history/'+w+'/transactions?page=1&limit=100&sources=wallet&sources=hawkfi',{headers:{accept:'application/json',authorization:tok}});
    const tj=await tr.json();
    const txns=(tj.data||[]).map(t=>({type:t.type,ts:t.created_at,usd:+t.total_in_usd||0}));
    out[w]={pools,txns,txnTotal:tj.total||txns.length};
  }catch(e){out[w]={error:String(e).slice(0,50)};}}return out;})()`;
  const raw = ab("eval", code, "--json");
  const d = JSON.parse(raw);
  return (d.data && d.data.result) || d.result || d;
}

const median = (a) => { const x = a.filter(Number.isFinite).sort((p, q) => p - q); return x.length ? x[Math.floor(x.length / 2)] : null; };
const f2 = (v) => (v == null ? "?" : Number(v).toFixed(2));

function analyze(wallet, data) {
  if (data.error) return { wallet, error: data.error };
  const pools = data.pools || [];
  const txns = data.txns || [];
  const closed = pools.filter((p) => Number.isFinite(p.pnlPct));
  const wins = closed.filter((p) => p.pnlUsd > 0);
  const types = {};
  for (const t of txns) types[t.type] = (types[t.type] || 0) + 1;
  const binSteps = pools.map((p) => p.binStep).filter(Boolean);
  const sizes = pools.map((p) => p.addUsd).filter((v) => v > 0);
  const opens = types.POSITION_OPEN || 0;
  return {
    wallet,
    pools_traded: pools.length,
    median_hold_h: median(pools.map((p) => p.durH)),
    median_positions_per_pool: median(pools.map((p) => p.posCount)),
    layering: pools.filter((p) => p.posCount > 1).length / (pools.length || 1), // % pools with >1 position
    win_rate_pool: closed.length ? wins.length / closed.length : null,
    median_pool_size_usd: median(sizes),
    bin_steps: [...new Set(binSteps)].sort((a, b) => a - b),
    median_bin_step: median(binSteps),
    txn_types: types,
    claims_per_open: opens ? (types.FEE_CLAIM || 0) / opens : null,
    rebalance_ratio: opens ? (types.ADD_LIQUIDITY || 0) / opens : null, // adds per open (>1 = re-adds/layering)
    top_tokens: [...new Set(pools.map((p) => p.sym))].slice(0, 8),
  };
}

async function main() {
  const wallets = optWallets || defaultWallets();
  console.log(`[explore] capturing fabriq token (via real navigation), then studying ${wallets.length} wallets...`);
  const token = captureToken();
  if (!token) { console.error("[explore] no token — ensure Chrome :9223 is logged into fabriq (devctl profile)."); process.exit(1); }
  const raw = await nodeFetchDetail(wallets, token);
  const analyses = wallets.map((w) => analyze(w, raw[w] || { error: "no data" })).filter((a) => !a.error);

  fs.writeFileSync(path.join(OUT_DIR, `trades-${new Date().toISOString().slice(0, 10)}.json`),
    JSON.stringify({ generated_at: new Date().toISOString(), raw, analyses }, null, 2));

  console.log(`\n===== HOW THE VETTED WINNERS TRADE =====`);
  for (const a of analyses) {
    console.log(`\n● ${a.wallet.slice(0, 8)}…  (${a.pools_traded} pools, pool win ${(a.win_rate_pool * 100 || 0).toFixed(0)}%)`);
    console.log(`   hold: ${f2(a.median_hold_h)}h median | size: $${f2(a.median_pool_size_usd)}/pool | positions/pool: ${a.median_positions_per_pool} | layering: ${(a.layering * 100).toFixed(0)}% of pools`);
    console.log(`   bin steps: ${a.bin_steps.join(", ") || "?"} (median ${a.median_bin_step})`);
    console.log(`   cadence: ${Object.entries(a.txn_types).map(([k, v]) => k.replace("_LIQUIDITY", "").replace("POSITION_", "") + ":" + v).join("  ")}`);
    console.log(`   adds/open: ${f2(a.rebalance_ratio)} (>1 = re-centering) | claims/open: ${f2(a.claims_per_open)} | tokens: ${a.top_tokens.join(", ")}`);
  }

  // ── Aggregate playbook ──
  const agg = (fn) => median(analyses.map(fn).filter((v) => v != null));
  console.log(`\n===== PLAYBOOK (medians across winners) =====`);
  console.log(`Hold time:        ${f2(agg((a) => a.median_hold_h))}h`);
  console.log(`Positions/pool:   ${f2(agg((a) => a.median_positions_per_pool))}  (layering ${(agg((a) => a.layering) * 100).toFixed(0)}% of pools)`);
  console.log(`Bin step:         ${f2(agg((a) => a.median_bin_step))}`);
  console.log(`Adds per open:    ${f2(agg((a) => a.rebalance_ratio))}  (re-centering frequency)`);
  console.log(`Claims per open:  ${f2(agg((a) => a.claims_per_open))}  (fee-harvest frequency)`);
  console.log(`Pool win rate:    ${(agg((a) => a.win_rate_pool) * 100).toFixed(0)}%`);
  console.log(`\nSaved → benchmark/trades-${new Date().toISOString().slice(0, 10)}.json\n`);
}

main().catch((e) => { console.error("explore-trades error:", e.message); process.exit(1); });
