#!/usr/bin/env node
/**
 * Daily PnL report — LP stack + Trade stack, rendered to markdown and written
 * into reports/pnl/ (write-only; no git). Run on demand:
 *
 *   node --env-file=.env scripts/daily-pnl.js            # today (UTC)
 *   node --env-file=.env scripts/daily-pnl.js --date 2026-06-04
 *
 * Sources:
 *   LP realized   → lessons.json (closed-position performance records)
 *   LP open       → getMyPositions() (mark-to-market unrealized)
 *   Trade realized→ trader-agent swap logs (Evonic chat.db) + a fixed pre-reset
 *                   baseline (Hunter's pre-2026-06-04 buy history was cleared
 *                   during the context-overflow fix; preserved here as a const)
 *   Wallet        → getWalletBalances() (SOL + holdings, ground-truth net worth)
 *   Missed opps   → latest benchmark/counterfactual-*.json
 *   Health        → decision-traces.jsonl, Evonic agent dbs + logs
 *
 * Each section is wrapped so a single failure never aborts the report.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "reports", "pnl");
const EVONIC_DIR = process.env.EVONIC_DIR || "/root/evonic";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DATE = flag("--date") || new Date().toISOString().slice(0, 10);

// Pre-reset trade baseline (swap-logged, from the 2026-06-04 reconstruction).
const TRADE_BASELINE = { net_sol: -0.2995, buys: 8, sells: 7, note: "pre-2026-06-04 reset (buys recovered from backup)" };
const RESET_TS = "2026-06-04T01:44:00Z"; // post-cutoff live swaps are added to the baseline

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const usd = (v) => `$${n(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const pct = (v) => `${n(v).toFixed(2)}%`;
function safe(fn, d) { try { return fn(); } catch { return d; } }

// ───────────────────────── LP stack ─────────────────────────
function lpStack() {
  const L = safe(() => JSON.parse(fs.readFileSync(path.join(ROOT, "lessons.json"), "utf8")).performance, []) || [];
  const today = L.filter((r) => (r.recorded_at || "").slice(0, 10) === DATE);
  const agg = (rows) => {
    const wins = rows.filter((r) => n(r.pnl_usd) > 0), losses = rows.filter((r) => n(r.pnl_usd) < 0);
    const gp = wins.reduce((s, r) => s + n(r.pnl_usd), 0), gl = Math.abs(losses.reduce((s, r) => s + n(r.pnl_usd), 0));
    return {
      count: rows.length,
      pnl: rows.reduce((s, r) => s + n(r.pnl_usd), 0),
      fees: rows.reduce((s, r) => s + n(r.fees_earned_usd), 0),
      wins: wins.length, losses: losses.length,
      win_rate: rows.length ? (100 * wins.length) / rows.length : 0,
      pf: gl ? gp / gl : (gp ? Infinity : 0),
    };
  };
  const cum = agg(L), tod = agg(today);
  const sorted = [...L].sort((a, b) => n(a.pnl_usd) - n(b.pnl_usd));
  const worst = sorted[0], best = sorted[sorted.length - 1];
  // exit reasons
  const byReason = {};
  for (const r of L) { const k = (r.close_reason || "?").slice(0, 30); (byReason[k] ??= { n: 0, pnl: 0 }); byReason[k].n++; byReason[k].pnl += n(r.pnl_usd); }
  return { cum, tod, worst, best, byReason };
}

// ───────────────────────── Trade stack ─────────────────────────
// chat.db lives in Evonic (python-written sqlite). Read it via python3 — always
// present on the host — instead of node:sqlite (version/flag-dependent).
const PY_TRADE = `
import sqlite3, json, sys
RESET_TS, DATE = sys.argv[1], sys.argv[2]
dbs = sys.argv[3:]
SOL = {"So11111111111111111111111111111111111111112","So11111111111111111111111111111111111111111"}
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
sb=ss=us=buys=sells=today=0
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
        if tcid in cm and content and ts and ts>RESET_TS:
            try: d=json.loads(content)["data"]
            except Exception: continue
            if not d.get("success"): continue
            ai,ao=int(d["amount_in"]),int(d["amount_out"])
            if d["input_mint"] in SOL: sb+=ai/1e9; buys+=1
            elif d["output_mint"] in SOL: ss+=ao/1e9; sells+=1
            elif d["output_mint"]==USDC: us+=ao/1e6; sells+=1
            if ts[:10]==DATE: today+=1
print(json.dumps({"spent_sol":sb,"recovered_sol":ss,"recovered_usdc":us,"buys":buys,"sells":sells,"today":today}))
`;
function tradeStack() {
  const dbs = ["meridian_trader_screener", "meridian_trader_manager"].map((a) => path.join(EVONIC_DIR, "agents", a, "chat.db"));
  let post = { spent_sol: 0, recovered_sol: 0, recovered_usdc: 0, buys: 0, sells: 0, today: 0 };
  try {
    const out = execFileSync("python3", ["-c", PY_TRADE, RESET_TS, DATE, ...dbs], { encoding: "utf8", timeout: 20000 });
    post = JSON.parse(out.trim());
  } catch { /* python/db unavailable — baseline only */ }
  const postNet = post.recovered_sol - post.spent_sol + post.recovered_usdc / 75;
  return {
    baseline: TRADE_BASELINE,
    post: { ...post, net_sol: postNet },
    cum_net_sol: TRADE_BASELINE.net_sol + postNet,
    cum_buys: TRADE_BASELINE.buys + post.buys,
    cum_sells: TRADE_BASELINE.sells + post.sells,
  };
}

// ───────────────────────── Wallet (ground truth) ─────────────────────────
async function walletState() {
  try {
    const { getWalletBalances } = await import("../tools/wallet.js");
    const w = await getWalletBalances();
    return { sol: n(w.sol), sol_price: n(w.sol_price), sol_usd: n(w.sol_usd), total_usd: n(w.total_usd), tokens: (w.tokens || []).filter((t) => n(t.balance) > 0 && (t.usd == null || n(t.usd) > 0.01)) };
  } catch (e) { return { error: e.message }; }
}

// ───────────────────────── Open positions (unrealized) ─────────────────────────
async function openPositions() {
  try {
    const { getMyPositions } = await import("../tools/dlmm.js");
    const p = await getMyPositions({ force: true, silent: true });
    const positions = p.positions || [];
    const unreal = positions.reduce((s, x) => s + n(x.pnl_usd ?? x.pnl ?? 0), 0);
    return { count: positions.length, unreal, positions };
  } catch (e) { return { count: 0, unreal: 0, error: e.message }; }
}

// ───────────────────────── Missed opportunities ─────────────────────────
function missedOpps() {
  const files = safe(() => fs.readdirSync(path.join(ROOT, "benchmark")).filter((f) => f.startsWith("counterfactual-")).sort(), []) || [];
  if (!files.length) return null;
  const cf = safe(() => JSON.parse(fs.readFileSync(path.join(ROOT, "benchmark", files[files.length - 1]), "utf8")), null);
  if (!cf) return null;
  return {
    file: files[files.length - 1],
    generated_at: cf.generated_at,
    miss_rate: cf.miss_rate_pct,
    evaluated: cf.skipped_evaluated,
    missed: (cf.detail || []).filter((d) => (d.verdict || "").startsWith("sustained")),
  };
}

// ───────────────────────── Health ─────────────────────────
function health() {
  const traces = safe(() => fs.readFileSync(path.join(ROOT, "decision-traces.jsonl"), "utf8").split("\n").filter(Boolean).length, 0);
  let hunter = 0;
  try {
    const db = path.join(EVONIC_DIR, "agents", "meridian_trader_screener", "chat.db");
    hunter = parseInt(execFileSync("python3", ["-c", "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('SELECT count(*) FROM chat_messages').fetchone()[0])", db], { encoding: "utf8", timeout: 10000 }).trim()) || 0;
  } catch { /* */ }
  let errors24h = 0;
  try {
    const log = fs.readFileSync(path.join(EVONIC_DIR, "logs", "pm2-out.log"), "utf8").split("\n").slice(-4000);
    const cutoff = Date.now() - 24 * 3600_000;
    errors24h = log.filter((l) => /LLM API error: 400|context window exceeds|invalid function arguments/.test(l) && safe(() => new Date(l.slice(0, 19)).getTime() > cutoff, true)).length;
  } catch { /* */ }
  return { traces, hunter, errors24h };
}

// ───────────────────────── Render ─────────────────────────
function render(d) {
  const L = d.lp, T = d.trade, W = d.wallet, O = d.open, M = d.missed, H = d.health;
  const pf = (v) => (v === Infinity ? "∞" : n(v).toFixed(2));
  const lines = [];
  lines.push(`# Meridian Daily PnL — ${DATE}`);
  lines.push(`_Generated ${new Date().toISOString()} · realized + mark-to-market · figures in USD unless noted_`);
  lines.push("");
  // Summary
  lines.push("## Summary");
  if (!W.error) {
    lines.push(`- **Wallet net worth:** ${usd(W.total_usd)} (${n(W.sol).toFixed(4)} SOL @ ${usd(W.sol_price)} = ${usd(W.sol_usd)}${W.tokens.length ? ` + ${W.tokens.length} token(s)` : ""})`);
  } else lines.push(`- **Wallet:** unavailable (${W.error})`);
  lines.push(`- **LP realized (cumulative):** ${usd(L.cum.pnl)} over ${L.cum.count} closed · fees ${usd(L.cum.fees)}`);
  lines.push(`- **Trade realized (cumulative):** ${T.cum_net_sol >= 0 ? "+" : ""}${T.cum_net_sol.toFixed(4)} SOL over ${T.cum_buys} buys / ${T.cum_sells} sells`);
  lines.push(`- **Open positions:** ${O.count} LP (${usd(O.unreal)} unrealized)${W.tokens?.length ? ` · ${W.tokens.length} spot holding(s)` : ""}`);
  lines.push(`- **Today:** ${L.tod.count} LP closes (${usd(L.tod.pnl)}) · ${T.post.today} trade swaps`);
  lines.push("");
  // LP
  lines.push("## 💧 LP stack (Scout)");
  lines.push(`| | Today | Cumulative |`);
  lines.push(`|---|---|---|`);
  lines.push(`| Closed | ${L.tod.count} | ${L.cum.count} |`);
  lines.push(`| Realized PnL | ${usd(L.tod.pnl)} | ${usd(L.cum.pnl)} |`);
  lines.push(`| Fees earned | ${usd(L.tod.fees)} | ${usd(L.cum.fees)} |`);
  lines.push(`| Win rate | ${pct(L.tod.win_rate)} | ${pct(L.cum.win_rate)} |`);
  lines.push(`| Profit factor | ${pf(L.tod.pf)} | ${pf(L.cum.pf)} |`);
  lines.push("");
  if (L.best && L.worst) {
    lines.push(`- Best: **${L.best.pool_name}** ${usd(L.best.pnl_usd)} (${pct(L.best.pnl_pct)}) · Worst: **${L.worst.pool_name}** ${usd(L.worst.pnl_usd)} (${pct(L.worst.pnl_pct)})`);
  }
  const topReasons = Object.entries(L.byReason).sort((a, b) => a[1].pnl - b[1].pnl).slice(0, 5);
  if (topReasons.length) {
    lines.push(`- Exit reasons (net): ${topReasons.map(([k, v]) => `${k} ${usd(v.pnl)} (×${v.n})`).join(" · ")}`);
  }
  if (O.count) {
    lines.push(`- Open: ${O.positions.map((p) => `${p.pool_name || p.pool?.slice(0, 6)} ${usd(p.pnl_usd ?? p.pnl ?? 0)}`).join(" · ")}`);
  }
  lines.push("");
  // Trade
  lines.push("## 📈 Trade stack (Hunter→Skeptic→Hands)");
  lines.push(`- **Cumulative realized:** ${T.cum_net_sol >= 0 ? "+" : ""}${T.cum_net_sol.toFixed(4)} SOL (${T.cum_buys} buys / ${T.cum_sells} sells)`);
  lines.push(`- Baseline (pre-reset): ${T.baseline.net_sol} SOL · ${T.baseline.note}`);
  lines.push(`- Since reset: ${T.post.buys} buys / ${T.post.sells} sells · spent ${T.post.spent_sol.toFixed(4)} SOL · recovered ${T.post.recovered_sol.toFixed(4)} SOL${T.post.recovered_usdc ? ` + ${usd(T.post.recovered_usdc)} USDC` : ""}`);
  lines.push(`- Today: ${T.post.today} swaps`);
  if (W.tokens?.length) lines.push(`- Open spot holdings: ${W.tokens.map((t) => `${t.symbol} (${t.usd != null ? usd(t.usd) : t.balance})`).join(" · ")}`);
  lines.push("");
  // Missed opps
  lines.push("## 🕳️ Missed opportunities (counterfactual)");
  if (M) {
    lines.push(`- Skip miss-rate: **${M.miss_rate}%** of ${M.evaluated} evaluated (from \`${M.file}\`, ${(M.generated_at || "").slice(0, 16)})`);
    if (M.missed.length) {
      lines.push(`- Skipped pools that kept earning:`);
      for (const m of M.missed.slice(0, 8)) lines.push(`  - **${m.name}** — fee ${n(m.fee0).toFixed(2)}→${n(m.feeNow).toFixed(2)}${m.birdeye ? ` · birdeye 24h vol ${usd(m.birdeye.vol24h)} / ${pct(m.birdeye.price24h)}` : ""}`);
    } else lines.push(`- No sustained skips — filters rejected genuinely bad pools.`);
    lines.push(`- _Note: "sustained" = token kept trading; ignores IL risk, so this overstates LP-relevant misses._`);
  } else lines.push(`- No counterfactual report yet (run \`node scripts/counterfactual-check.js --minAgeH 2\`).`);
  lines.push("");
  // Health
  lines.push("## 🩺 Implementation health");
  lines.push(`- Decision traces logged: ${H.traces} · Hunter session msgs: ${H.hunter} · agent LLM errors (24h): ${H.errors24h}`);
  lines.push("");
  return lines.join("\n");
}

function upsertHistory(d) {
  const file = path.join(OUT_DIR, "HISTORY.md");
  const row = `| ${DATE} | ${d.wallet.error ? "n/a" : usd(d.wallet.total_usd)} | ${d.wallet.error ? "n/a" : n(d.wallet.sol).toFixed(3)} | ${usd(d.lp.cum.pnl)} | ${d.trade.cum_net_sol.toFixed(3)} | ${d.open.count} | ${d.lp.tod.count} closes today |`;
  // Collect existing data rows (lines starting with "| YYYY-MM-DD"), upsert today, rebuild.
  const prev = safe(() => fs.readFileSync(file, "utf8"), "") || "";
  const rows = new Map();
  for (const l of prev.split("\n")) {
    const m = l.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/);
    if (m) rows.set(m[1], l.trim());
  }
  rows.set(DATE, row);
  const sorted = [...rows.keys()].sort().map((k) => rows.get(k));
  const out = [
    "# Daily PnL history",
    "",
    "| Date | Wallet USD | SOL | LP realized (cum) | Trade realized SOL (cum) | LP open | Notes |",
    "|---|---|---|---|---|---|---|",
    ...sorted,
    "",
  ].join("\n");
  fs.writeFileSync(file, out);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = {
    lp: safe(lpStack, { cum: {}, tod: {}, byReason: {} }),
    trade: safe(tradeStack, { baseline: TRADE_BASELINE, post: {}, cum_net_sol: TRADE_BASELINE.net_sol, cum_buys: 8, cum_sells: 7 }),
    wallet: await walletState(),
    open: await openPositions(),
    missed: safe(missedOpps, null),
    health: safe(health, { traces: 0, hunter: 0, errors24h: 0 }),
  };
  const md = render(d);
  const outFile = path.join(OUT_DIR, `${DATE}.md`);
  fs.writeFileSync(outFile, md);
  upsertHistory(d);
  console.log(`Wrote ${path.relative(ROOT, outFile)} and updated HISTORY.md`);
  console.log("\n" + md);
}

main().catch((e) => { console.error("daily-pnl error:", e.message); process.exit(1); });
