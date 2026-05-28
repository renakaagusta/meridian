#!/usr/bin/env node
/**
 * fabriq.trade portfolio scraper / benchmark fetcher.
 *
 * Pulls a wallet's full DLMM portfolio + performance from fabriq's backend
 * (apinew.fabriq.trade) so we can benchmark our agent against another trader.
 *
 * The API requires a Privy Bearer JWT (short-lived). Token resolution order:
 *   1. FABRIQ_TOKEN env var
 *   2. ./.fabriq-token  (gitignored)
 *   3. /tmp/fabriq_token.txt
 *
 * Refresh the token from a logged-in Chrome session (devctl/agent-browser, the
 * profile that can open fabriq.trade) with:
 *   node scripts/fabriq-bench.js --refresh-token            # uses CDP port 9223
 *   node scripts/fabriq-bench.js --refresh-token --port 9223
 *
 * Scrape a wallet:
 *   node scripts/fabriq-bench.js <walletAddress>
 *   node scripts/fabriq-bench.js                            # defaults to the benchmark wallet
 *
 * Output: benchmark/fabriq-<wallet>-<ISO>.json  +  a printed summary.
 */

import fs from "fs";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500); // Node 20 Happy-Eyeballs fix

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TOKEN_FILE = path.join(ROOT, ".fabriq-token");
const OUT_DIR = path.join(ROOT, "benchmark");

const API = "https://apinew.fabriq.trade";
const DEFAULT_WALLET = "Ew7KqcKM7B1fKjPcc9myP2A7QujAcn2gU51g2irFnoJf";
const TZ = "Asia/Jakarta";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };

// ── Token handling ──────────────────────────────────────────────
function readToken() {
  if (process.env.FABRIQ_TOKEN) return process.env.FABRIQ_TOKEN.trim();
  for (const p of [TOKEN_FILE, "/tmp/fabriq_token.txt"]) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim(); } catch { /* ignore */ }
  }
  return null;
}

/**
 * Pull a fresh Bearer token from a logged-in Chrome via agent-browser CDP:
 * records a HAR while reloading fabriq, then extracts the Authorization header.
 */
function refreshToken(port) {
  const url = `https://fabriq.trade/portfolio-beta?walletAddress=${DEFAULT_WALLET}`;
  const ab = (...a) => execFileSync("agent-browser", ["--cdp", String(port), ...a], { encoding: "utf8" });
  console.log(`Refreshing token via Chrome CDP :${port} (open ${url} in that profile first)...`);
  try { ab("open", url); } catch { /* may already be open */ }
  ab("network", "har", "start", "/tmp/fabriq-refresh.har");
  ab("reload");
  ab("wait", "7000");
  ab("network", "har", "stop");

  // agent-browser writes HAR to its own tmp dir; find the newest har file.
  const harDir = path.join(process.env.HOME, ".agent-browser/tmp/har");
  const newest = fs.readdirSync(harDir).filter((f) => f.endsWith(".har"))
    .map((f) => ({ f, t: fs.statSync(path.join(harDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  const har = JSON.parse(fs.readFileSync(path.join(harDir, newest.f), "utf8"));
  const entry = har.log.entries.find((e) =>
    e.request.url.includes("apinew.fabriq.trade") &&
    e.request.headers.find((h) => /^authorization$/i.test(h.name)));
  if (!entry) throw new Error("No authorized apinew.fabriq.trade request found — is the profile logged in?");
  const token = entry.request.headers.find((h) => /^authorization$/i.test(h.name)).value.replace(/^Bearer /i, "");
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  console.log(`Token saved to ${TOKEN_FILE} (len ${token.length}).`);
  return token;
}

// ── API client ──────────────────────────────────────────────────
function buildUrl(pathname, params = {}) {
  const u = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
    else if (v != null) u.searchParams.set(k, v);
  }
  return u.toString();
}

async function get(token, pathname, params) {
  const r = await fetch(buildUrl(pathname, params), {
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  if (r.status === 401) {
    throw new Error("401 Unauthorized — token expired. Refresh with: node scripts/fabriq-bench.js --refresh-token");
  }
  if (!r.ok) throw new Error(`${pathname} → HTTP ${r.status}`);
  return r.json();
}

async function getAllPages(token, pathname, params, limit = 50) {
  const out = [];
  let page = 1;
  for (;;) {
    const res = await get(token, pathname, { ...params, page, limit });
    const data = res.data || [];
    out.push(...data);
    if (!res.hasMore || data.length === 0 || page > 100) break;
    page += 1;
  }
  return out;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  if (flag("--refresh-token")) {
    refreshToken(Number(opt("--port", 9223)));
    return;
  }

  const wallet = args.find((a) => !a.startsWith("--") && a.length > 30) || DEFAULT_WALLET;
  let token = readToken();
  if (!token) {
    console.error("No token found. Run: node scripts/fabriq-bench.js --refresh-token (with Chrome logged in on CDP :9223)");
    process.exit(1);
  }

  // Auto-refresh once if the saved token is stale.
  const common = { timezone: TZ, sources: ["wallet", "hawkfi"] };
  let stats;
  try {
    stats = await get(token, `/portfolio/stats/${wallet}`, common);
  } catch (e) {
    if (String(e.message).startsWith("401") && !process.env.FABRIQ_TOKEN) {
      console.error("Token stale — attempting auto-refresh via CDP :9223...");
      token = refreshToken(Number(opt("--port", 9223)));
      stats = await get(token, `/portfolio/stats/${wallet}`, common);
    } else throw e;
  }

  const month = new Date().toISOString().slice(0, 7);
  const scopes = {
    pnlScope: "pool", lastCloseScope: "pool", durationScope: "pool",
    depositsScope: "pool", withdrawalsScope: "pool", feesScope: "pool",
  };

  const [dailyPnl, calendar, balance, pnlByPool, transactions] = await Promise.all([
    get(token, `/portfolio/daily-pnl/${wallet}`, { aggregate: "daily", ...common }),
    get(token, `/portfolio/calendar/${wallet}`, { month, ...common }),
    get(token, `/wallet/balance/${wallet}`, {}),
    getAllPages(token, `/history/${wallet}/pnl-by-pool`,
      { sortBy: "latest_close_ts", sortOrder: "desc", pnlCurrency: "USD", ...common, ...scopes }, 50),
    getAllPages(token, `/history/${wallet}/transactions`, { ...common }, 100),
  ]);

  const snapshot = {
    wallet,
    scraped_at: new Date().toISOString(),
    source: "apinew.fabriq.trade",
    stats: stats.data ?? stats,
    daily_pnl: dailyPnl.data ?? dailyPnl,
    calendar: calendar.data ?? calendar,
    balance: balance.data ?? balance,
    pnl_by_pool: pnlByPool,
    transactions,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `fabriq-${wallet}-${snapshot.scraped_at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2));

  // ── Summary ──
  const s = snapshot.stats || {};
  const n = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : "?");
  console.log(`\n===== FABRIQ BENCHMARK — ${wallet} =====`);
  console.log(`Net PnL:        $${n(s.netPnlUsd)}  (${n(s.netPnlSol, 4)} SOL)`);
  console.log(`Total fees:     $${n(s.totalFeesUsd)}  (${n(s.totalFeesSol, 4)} SOL)`);
  console.log(`Positions:      ${s.totalPositions ?? "?"} total`);
  console.log(`Avg add liq:    $${n(s.avgAddLiquidityUsd)}  (${n(s.avgAddLiquiditySol, 4)} SOL)`);
  console.log(`Total deposits: $${n(s.totalDepositsUsd)}  | withdrawals: $${n(s.totalWithdrawalsUsd)}`);
  console.log(`Position win %: ${n(s.positionWinUsd?.percentage, 1)}%  (${s.positionWinUsd?.wins ?? "?"}W/${s.positionWinUsd?.losses ?? "?"}L)`);
  console.log(`Day win %:      ${n(s.dayWinUsd?.percentage, 1)}%  (${s.dayWinUsd?.wins ?? "?"}W/${s.dayWinUsd?.losses ?? "?"}L)`);
  console.log(`Profit factor:  ${n(s.profitFactorUsd?.ratio)}`);
  console.log(`Avg win/loss:   ${n(s.avgWinLoss?.ratioUsd)}`);
  console.log(`\nPools traded:   ${pnlByPool.length}  | Transactions: ${transactions.length}`);
  console.log(`Saved full snapshot → ${path.relative(ROOT, outFile)}\n`);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
