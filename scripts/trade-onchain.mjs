/**
 * On-chain trade-stack PnL — full-history reconstruction from the chain.
 *
 * Replaces the old chat.db method (which lost pre-2026-06-04 history and leaned
 * on a fabricated −0.2995 SOL baseline). We read every wallet tx, isolate
 * SOL<->token swaps, FIFO cost-basis them in SOL, and classify each mint:
 *   • spot   — genuine meme buy→sell (THE trade stack)
 *   • LP-base — token that Scout LP'd (pool-memory.json); its sells are LP
 *               cleanup with zero cost basis → belong to the LP stack, excluded
 *   • stable — USDC/USDT treasury conversions → excluded from the trade number
 *
 * Returns the same field shape daily-pnl.js's renderer already consumes, so the
 * report wiring barely changes — but every figure is now full-history and real.
 *
 * Batch JSON-RPC needs a paid Helius plan, so we fetch one tx at a time and keep
 * an incremental signature cache (reports/pnl/.tx-cache.json) — first run is
 * ~1-2 min, later runs only fetch new txs.
 */
import fs from "node:fs";

const WSOL = "So11111111111111111111111111111111111111112";
const WSOL2 = "So11111111111111111111111111111111111111111";
const SOL_MINTS = new Set([WSOL, WSOL2]);
const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildEndpoints() {
  const urls = (process.env.RPC_URLS || process.env.RPC_URL || "").split(/[,\s]+/).filter(Boolean);
  const keys = (process.env.HELIUS_API_KEYS || process.env.HELIUS_API_KEY || "").split(/[,\s]+/).filter(Boolean);
  const cand = [...new Set([...urls, ...keys.map((k) => `https://mainnet.helius-rpc.com/?api-key=${k}`)])];
  return cand.length ? cand : ["https://api.mainnet-beta.solana.com"];
}

export async function computeTradeStack({ wallet, poolMemoryPath, lessonsPath, cachePath, solPrice = 0, now } = {}) {
  let W = wallet || process.env.WALLET_PUBKEY;
  if (!W && process.env.WALLET_PRIVATE_KEY) {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    W = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toString();
  }
  if (!W) throw new Error("no wallet pubkey (set WALLET_PUBKEY or WALLET_PRIVATE_KEY)");
  const NOW = now || Math.floor(Date.now() / 1000);
  const endpoints = buildEndpoints();
  let epi = 0;
  const nextEp = () => endpoints[epi++ % endpoints.length];

  async function rpc(method, params, tries = 8) {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(nextEp(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const j = await r.json();
        if (j.error) { await sleep(400 * (i + 1)); continue; }
        return j.result;
      } catch { await sleep(400 * (i + 1)); }
    }
    return null;
  }

  // signatures (newest→oldest, paginate via before)
  let sigs = [];
  let before = null;
  for (let p = 0; p < 12; p++) {
    const res = await rpc("getSignaturesForAddress", [W, before ? { limit: 1000, before } : { limit: 1000 }]);
    if (!res || !res.length) break;
    sigs.push(...res);
    before = res[res.length - 1].signature;
    if (res.length < 1000) break;
  }
  const wantSigs = sigs.filter((s) => !s.err).map((s) => s.signature);

  // incremental tx cache
  let cache = {};
  if (cachePath && fs.existsSync(cachePath)) { try { cache = JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch { cache = {}; } }
  const missing = wantSigs.filter((s) => !(s in cache));
  const CONC = 4;
  for (let i = 0; i < missing.length; i += CONC) {
    const chunk = missing.slice(i, i + CONC);
    const got = await Promise.all(chunk.map((s) => rpc("getTransaction", [s, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }])));
    chunk.forEach((s, k) => { cache[s] = got[k] || null; }); // null = fetched-but-empty, don't refetch
    await sleep(200);
  }
  if (cachePath) { try { fs.writeFileSync(cachePath, JSON.stringify(cache)); } catch {} }

  // LP base mints — union of the permanent close ledger (lessons.json, the same
  // source the LP stack uses) and the deploy-history (pool-memory.json, which can
  // prune/cooldown). Any swap of these mints is LP-stack economics, never a trade.
  const LP = new Set();
  try { const pm = JSON.parse(fs.readFileSync(poolMemoryPath, "utf8")); for (const k in pm) if (pm[k]?.base_mint) LP.add(pm[k].base_mint); } catch {}
  try { const ls = JSON.parse(fs.readFileSync(lessonsPath, "utf8")); for (const p of (ls.performance || [])) if (p?.base_mint) LP.add(p.base_mint); } catch {}

  // parse each tx into a single SOL<->token swap leg
  const parse = (tx) => {
    if (!tx?.meta || tx.meta.err) return null;
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
    const wIdx = keys.indexOf(W);
    if (wIdx < 0) return null;
    const solDelta = (tx.meta.postBalances[wIdx] - tx.meta.preBalances[wIdx]) / 1e9;
    const byMint = {};
    for (const b of (tx.meta.preTokenBalances || [])) if (b.owner === W) byMint[b.mint] = (byMint[b.mint] || 0) - Number(b.uiTokenAmount.uiAmount || 0);
    for (const b of (tx.meta.postTokenBalances || [])) if (b.owner === W) byMint[b.mint] = (byMint[b.mint] || 0) + Number(b.uiTokenAmount.uiAmount || 0);
    const moved = Object.entries(byMint).filter(([m, d]) => !SOL_MINTS.has(m) && Math.abs(d) > 1e-9);
    if (moved.length !== 1) return null;
    const [mint, tokDelta] = moved[0];
    if (Math.abs(solDelta) < 1e-7) return null;
    const isBuy = tokDelta > 0 && solDelta < 0;
    const isSell = tokDelta < 0 && solDelta > 0;
    if (!isBuy && !isSell) return null;
    return { ts: tx.blockTime, mint, tokDelta, solDelta, isBuy };
  };

  const swaps = Object.values(cache).map((t) => t && parse(t)).filter(Boolean).sort((a, b) => a.ts - b.ts);

  // FIFO cost-basis per mint, realize on sells
  const lots = {};
  const realized = []; // {ts, mint, solPnl, cls}
  const clsOf = (m) => (STABLES.has(m) ? "stable" : LP.has(m) ? "lp" : "spot");
  for (const s of swaps) {
    lots[s.mint] = lots[s.mint] || [];
    if (s.isBuy) { lots[s.mint].push({ qty: s.tokDelta, cost: -s.solDelta }); continue; }
    let need = -s.tokDelta, costMatched = 0;
    while (need > 1e-12 && lots[s.mint].length) {
      const lot = lots[s.mint][0];
      const take = Math.min(need, lot.qty);
      const part = take / lot.qty;
      costMatched += part * lot.cost;
      lot.qty -= take; lot.cost -= part * lot.cost; need -= take;
      if (lot.qty <= 1e-12) lots[s.mint].shift();
    }
    realized.push({ ts: s.ts, mint: s.mint, solPnl: s.solDelta - costMatched, cls: clsOf(s.mint) });
  }

  const inWin = (arr, d) => arr.filter((r) => r.ts >= NOW - d * 86400);
  const sum = (arr) => arr.reduce((a, r) => a + r.solPnl, 0);
  const spot = realized.filter((r) => r.cls === "spot");
  const stable = realized.filter((r) => r.cls === "stable");
  const lp = realized.filter((r) => r.cls === "lp");
  const spotBuys = swaps.filter((s) => s.isBuy && clsOf(s.mint) === "spot").length;
  const spotSells = spot.length;
  const wins = spot.filter((r) => r.solPnl > 0).length;
  const todayStr = new Date(NOW * 1000).toISOString().slice(0, 10);
  const today = spot.filter((r) => new Date(r.ts * 1000).toISOString().slice(0, 10) === todayStr).length;
  const open_bags = Object.entries(lots).filter(([m]) => clsOf(m) === "spot").flatMap(([m, ls]) => ls.filter((l) => l.qty > 1e-9).map((l) => ({ token: m, qty: l.qty, sol_cost: Number(l.cost.toFixed(6)) })));

  const windows = {
    d1: { net: sum(inWin(spot, 1)), n: inWin(spot, 1).length },
    d3: { net: sum(inWin(spot, 3)), n: inWin(spot, 3).length },
    d7: { net: sum(inWin(spot, 7)), n: inWin(spot, 7).length },
  };
  const cum = sum(spot);
  return {
    source: "on-chain",
    cum_net_sol: cum,
    cum_buys: spotBuys,
    cum_sells: spotSells,
    windows,
    post: { realized_sol: cum, buys: spotBuys, sells: spotSells, closed: spotSells, wins, today, orphan_recovered_sol: 0, open_bags },
    info: {
      stable_sol: Number(sum(stable).toFixed(6)),
      lp_cleanup_sol: Number(sum(lp).toFixed(6)),
      swaps: swaps.length,
      txs: Object.values(cache).filter(Boolean).length,
      oldest: swaps[0] ? new Date(swaps[0].ts * 1000).toISOString().slice(0, 10) : null,
    },
  };
}
