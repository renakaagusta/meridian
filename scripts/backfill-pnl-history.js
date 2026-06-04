#!/usr/bin/env node
/**
 * One-time backfill for reports/pnl/HISTORY.md so the daily report's wallet-Δ
 * (1d/3d/7d) works immediately instead of waiting days to accumulate snapshots.
 *
 * Reconstructs, per UTC day across the trading window:
 *   - Wallet net worth — end-of-day SOL balance (on-chain: last tx that day →
 *     post-balance) × that day's SOL price (CoinGecko daily). Tokens were
 *     negligible historically (wallet round-trips to SOL), so SOL-only.
 *   - LP realized (cumulative) — exact, from lessons.json close timestamps.
 *   - Trade realized (cumulative) — from backup swap timestamps + baseline.
 *
 *   node --env-file=.env scripts/backfill-pnl-history.js
 *
 * Idempotent: upserts rows into HISTORY.md (won't duplicate dates).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "reports", "pnl");
const EVONIC_DIR = process.env.EVONIC_DIR || "/root/evonic";
const TRADE_BASELINE_NET = -0.2995; // SOL, pre-reset (see daily-pnl.js)

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const usd = (v) => `$${n(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const dstr = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wallet() {
  let pk = process.env.WALLET_PRIVATE_KEY;
  try { return Keypair.fromSecretKey(bs58.decode(pk)).publicKey; }
  catch { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(pk))).publicKey; }
}

async function solDailyPrices(days) {
  // CoinGecko free daily close, no key.
  const url = `https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const r = await fetch(url);
  const j = await r.json();
  const byDate = {};
  for (const [ms, price] of (j.prices || [])) byDate[dstr(ms)] = price;
  return byDate;
}

async function endOfDayBalances(conn, owner, sinceMs) {
  // Pull signatures (newest first), keep the LAST (latest blockTime) per UTC day.
  let before = undefined, all = [];
  for (let page = 0; page < 6; page++) {
    const sigs = await conn.getSignaturesForAddress(owner, { limit: 1000, before });
    if (!sigs.length) break;
    all.push(...sigs);
    before = sigs[sigs.length - 1].signature;
    if ((sigs[sigs.length - 1].blockTime || 0) * 1000 < sinceMs) break;
    await sleep(200);
  }
  const lastPerDay = {};
  for (const s of all) {
    if (!s.blockTime) continue;
    const ms = s.blockTime * 1000;
    if (ms < sinceMs) continue;
    const day = dstr(ms);
    if (!lastPerDay[day] || s.blockTime > lastPerDay[day].blockTime) lastPerDay[day] = s;
  }
  const balByDay = {};
  for (const [day, s] of Object.entries(lastPerDay)) {
    try {
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      const keys = tx?.transaction?.message?.accountKeys || [];
      const idx = keys.findIndex((k) => (k.pubkey?.toString?.() || k.toString?.()) === owner.toString());
      if (idx >= 0 && tx?.meta?.postBalances?.[idx] != null) balByDay[day] = tx.meta.postBalances[idx] / 1e9;
    } catch { /* skip */ }
    await sleep(200);
  }
  return balByDay;
}

function lpCumByDay() {
  const L = (JSON.parse(fs.readFileSync(path.join(ROOT, "lessons.json"), "utf8")).performance) || [];
  L.sort((a, b) => new Date(a.recorded_at) - new Date(b.recorded_at));
  return (day) => {
    const upto = L.filter((r) => (r.recorded_at || "").slice(0, 10) <= day);
    return { pnl: upto.reduce((s, r) => s + n(r.pnl_usd), 0), closes: upto.length };
  };
}

function tradeCumByDay() {
  // Reconstruct cumulative SOL net flow up to each day from backup + live swaps.
  const SOL = new Set(["So11111111111111111111111111111111111111112", "So11111111111111111111111111111111111111111"]);
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const PY = `
import sqlite3, json, sys
dbs=sys.argv[1:]
SOL=set(["So11111111111111111111111111111111111111112","So11111111111111111111111111111111111111111"])
USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
ev=[]
for db in dbs:
    try: con=sqlite3.connect(db)
    except Exception: continue
    try: rows=con.execute("SELECT content,tool_calls,tool_call_id,created_at FROM chat_messages ORDER BY id").fetchall()
    except Exception: continue
    cm=set()
    for content,tc,tcid,ts in rows:
        if tc:
            try: arr=json.loads(tc)
            except Exception: arr=[]
            for c in (arr if isinstance(arr,list) else []):
                if c.get("id") and (c.get("function") or {}).get("name")=="swap_token": cm.add(c["id"])
    for content,tc,tcid,ts in rows:
        if tcid in cm and content:
            try: d=json.loads(content)["data"]
            except Exception: continue
            if not d.get("success"): continue
            ai,ao=int(d["amount_in"]),int(d["amount_out"]); flow=0.0
            if d["input_mint"] in SOL: flow=-ai/1e9
            elif d["output_mint"] in SOL: flow=ao/1e9
            elif d["output_mint"]==USDC: flow=(ao/1e6)/75
            ev.append((ts[:10],flow))
print(json.dumps(ev))
`;
  const dbs = [
    ...fsGlob(`${EVONIC_DIR}/backups`, "hunter-reset-*/chat.db"),
    `${EVONIC_DIR}/agents/meridian_trader_manager/chat.db`,
    `${EVONIC_DIR}/agents/meridian_trader_screener/chat.db`,
  ];
  let ev = [];
  try { ev = JSON.parse(execFileSync("python3", ["-c", PY, ...dbs], { encoding: "utf8", timeout: 30000 }).trim()); } catch { /* */ }
  // ev already includes the pre-reset swaps (from the backup db), so summing
  // flows up to `day` reproduces the baseline without double-counting it.
  return (day) => ev.filter(([d]) => d <= day).reduce((s, [, f]) => s + f, 0);
}
function fsGlob(dir, pat) {
  try {
    const base = pat.split("/")[0].replace("*", "");
    return fs.readdirSync(dir).filter((f) => f.startsWith(base)).map((f) => path.join(dir, f, pat.split("/").slice(1).join("/")));
  } catch { return []; }
}

function upsertRows(rows) {
  const file = path.join(OUT_DIR, "HISTORY.md");
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const map = new Map();
  for (const l of prev.split("\n")) { const m = l.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/); if (m) map.set(m[1], l.trim()); }
  for (const r of rows) map.set(r.date, r.line);
  const sorted = [...map.keys()].sort().map((k) => map.get(k));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(file, ["# Daily PnL history", "", "| Date | Wallet USD | SOL | LP realized (cum) | Trade realized SOL (cum) | LP open | Notes |", "|---|---|---|---|---|---|---|", ...sorted, ""].join("\n"));
}

async function main() {
  const rpc = (process.env.RPC_URLS || process.env.RPC_URL || "").split(",")[0].trim();
  const conn = new Connection(rpc, "confirmed");
  const owner = wallet();
  const days = 9;
  const sinceMs = Date.now() - days * 86400_000;
  console.log("Reconstructing wallet balances for", owner.toString(), "since", dstr(sinceMs));
  const [bal, prices] = await Promise.all([endOfDayBalances(conn, owner, sinceMs), solDailyPrices(days)]);
  const lp = lpCumByDay(), tr = tradeCumByDay();
  const rows = [];
  const yesterday = dstr(Date.now() - 86400_000);
  let lastSol = null, lastPx = null;
  for (let d = new Date(dstr(sinceMs)); dstr(d.getTime()) <= yesterday; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = dstr(d.getTime());
    // Carry forward the last known balance on idle days (no tx = balance unchanged).
    const sol = bal[day] ?? lastSol;
    const px = prices[day] ?? lastPx;
    if (sol == null) continue; // before any on-chain activity → nothing to anchor
    lastSol = sol; if (px != null) lastPx = px;
    const usdv = px != null ? sol * px : null;
    const l = lp(day), t = tr(day);
    const line = `| ${day} | ${usdv == null ? "n/a" : usd(usdv)} | ${n(sol).toFixed(3)} | ${usd(l.pnl)} | ${n(t).toFixed(3)} | 0 | backfilled |`;
    rows.push({ date: day, line });
    console.log(line);
  }
  upsertRows(rows);
  console.log(`\nBackfilled ${rows.length} day(s) into HISTORY.md`);
}
main().catch((e) => { console.error("backfill error:", e.message); process.exit(1); });
