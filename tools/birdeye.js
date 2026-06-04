/**
 * tools/birdeye.js — keyless Birdeye signals via the stackbase scraper.
 *
 * Birdeye's website backend (`birdeye.so/forge/*`) has rich token data with no
 * API key, but is Cloudflare-gated. We reach it through the stackbase scraper's
 * generic forge proxy (`POST /scrape/birdeye/forge`), which fetches any /forge/*
 * path via a real-Chrome residential CDP warm tab and caches results in Redis.
 *
 * Signals exposed:
 *   - getBirdeyeVelocity(mint)  → per-token price/volume/wallet velocity at
 *     30m/1h/2h/4h/24h with buy/sell split (overview/token). 30m is the shortest
 *     window Birdeye exposes keylessly — there is no 5m.
 *   - getBirdeyeSecurity(mint)  → mint/freeze authority, renounce, mutable meta,
 *     creator %, top-10 holder % (token/tokensecurity).
 *   - getBirdeyeGems(opts)      → trending candidate list (multichain/v3/gems).
 *
 * Diagnostics go to STDERR only — Meridian CLI writes its JSON result to stdout,
 * which the agent bridge parses.
 */
const SCRAPER_URL = (process.env.MERIDIAN_SCRAPER_URL || "https://scraper.stackbase.id").replace(/\/+$/, "");
const SCRAPER_SECRET = process.env.MERIDIAN_SCRAPER_SECRET || process.env.SCRAPER_SECRET || "";
// Bounded so a degraded Birdeye/NUC path can't stall an agent's get_dex_velocity
// cycle — on timeout the overlay is skipped and DexScreener data is used. A warm
// tab answers in ~2-5s; a cold warm-up in ~15-25s; both fit under 35s.
const FETCH_TIMEOUT_MS = Number(process.env.MERIDIAN_BIRDEYE_TIMEOUT_MS || 35000);

const logErr = (tag, msg) => console.error(`[birdeye] ${tag}: ${msg}`);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

/**
 * Fetch any Birdeye forge path through the scraper proxy. Returns the parsed
 * Birdeye response body (the proxy's `json`), or null on any failure.
 *
 * ALWAYS uncached (`ttl: 0`): trade/LP decisions must act on fresh data — the
 * scraper's Redis cache (incl. its 60s negative cache) was serving stale/empty
 * results and poisoning the candidate feed after a single transient failure.
 * `timeoutMs` is per-call (hot-path velocity stays tight; discovery gets longer).
 */
async function birdeyeForge(path, { method = "GET", body, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (!SCRAPER_SECRET) return null; // feature not provisioned — quiet no-op
  try {
    const res = await withTimeout(
      fetch(`${SCRAPER_URL}/scrape/birdeye/forge`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SCRAPER_SECRET}` },
        body: JSON.stringify({ path, method, body, ttl: 0 }),
      }),
      timeoutMs,
    );
    if (!res.ok) {
      logErr("forge_http", `${res.status} for ${path}`);
      return null;
    }
    const data = await res.json();
    return data?.json ?? null;
  } catch (e) {
    logErr("forge_error", `${e.message} for ${path}`);
    return null;
  }
}

/**
 * Raw OHLCV candles for a token (or pool) at any resolution Birdeye supports
 * (1s/5s/1m/5m/15m/1h/...). Returns `{ res, candles: [{t,o,h,l,c,v}] }` newest
 * last, or null. `v` is base-token volume; multiply by price for ~USD.
 */
export async function getBirdeyeOhlcv({ mint, chain = "solana", res = "5m", count = 60 } = {}) {
  if (!mint) return null;
  const path = `/forge/${chain}/amm/ohlcv_v2?addr=${mint}&cur=usd&res=${res}&outliers=true&cb=${count}&mc=false&scaled=false`;
  const resp = await birdeyeForge(path);
  const d = resp?.data;
  if (!d || !Array.isArray(d.t)) return null;
  const candles = d.t.map((t, i) => ({ t, o: d.o?.[i], h: d.h?.[i], l: d.l?.[i], c: d.c?.[i], v: d.v?.[i] }));
  return { res, count: candles.length, candles };
}

/**
 * True trailing 5-minute velocity, computed from 1m candles (Birdeye's overview/
 * gems only go down to 30m/1h). price_change_pct = last close vs the close ~5
 * minutes earlier; volume_usd ≈ Σ(base-volume × close) over the last 5 candles.
 */
async function compute5m({ mint, chain = "solana" }) {
  const o = await getBirdeyeOhlcv({ mint, chain, res: "1m", count: 6 });
  const c = o?.candles?.filter((x) => typeof x.c === "number" && x.c > 0) ?? [];
  if (c.length < 2) return null;
  const last = c[c.length - 1];
  const ref = c[0]; // ~5 candles back
  const window = c.slice(1); // up to 5 most-recent 1m candles
  const volUsd = window.reduce((s, x) => s + (typeof x.v === "number" ? x.v * x.c : 0), 0);
  return {
    price_change_pct: ref.c ? +(((last.c - ref.c) / ref.c) * 100).toFixed(4) : null,
    volume_usd: +volUsd.toFixed(2),
    candles: c.length,
    to_unix: last.t,
  };
}

const VEL_WINDOWS = ["30m", "1h", "2h", "4h", "24h"];

function shapeOverview(d) {
  if (!d) return null;
  const velocity = {};
  for (const w of VEL_WINDOWS) {
    velocity[w] = {
      price_change_pct: d[`priceChange${w}Percent`] ?? null,
      volume_usd: d[`v${w}USD`] ?? null,
      vbuy_usd: d[`vBuy${w}USD`] ?? null,
      vsell_usd: d[`vSell${w}USD`] ?? null,
      buys: d[`buy${w}`] ?? null,
      sells: d[`sell${w}`] ?? null,
      trades: d[`trade${w}`] ?? null,
      unique_wallets: d[`uniqueWallet${w}`] ?? null,
      unique_wallets_change_pct: d[`uniqueWallet${w}ChangePercent`] ?? null,
    };
  }
  return {
    symbol: d.symbol ?? null,
    name: d.name ?? null,
    price_usd: d.price ?? null,
    mcap: d.mc ?? null,
    liquidity_usd: d.liquidity ?? null,
    holder_count: d.holder ?? null,
    security_score: d.securityScore ?? null,
    last_trade_unix: d.lastTradeUnixTime ?? null,
    velocity,
  };
}

/**
 * Accurate per-token velocity (30m/1h/2h/4h/24h) with buy/sell split + unique
 * wallets, from Birdeye overview/token. Works for ANY token (not just trending).
 * Returns `{ found: false }` if the token has no overview (caller keeps its own
 * source). 30m is the shortest window — Birdeye exposes no 5m keylessly.
 */
export async function getBirdeyeVelocity({ mint, chain = "solana", with5m = true } = {}) {
  if (!mint) return { found: false, error: "mint is required" };
  // overview (30m+) and the computed 5m window run in parallel to bound latency.
  const [resp, fiveM] = await Promise.all([
    birdeyeForge(`/forge/${chain}/overview/token?address=${mint}`),
    with5m ? compute5m({ mint, chain }).catch(() => null) : Promise.resolve(null),
  ]);
  const d = resp?.data;
  if (!d || !d.address) return { found: false, mint, source: "birdeye-overview" };
  const shaped = shapeOverview(d);
  if (fiveM) shaped.velocity = { "5m": fiveM, ...shaped.velocity };
  return { found: true, source: "birdeye-overview", mint, ...shaped };
}

/**
 * Token security/risk from Birdeye tokensecurity (GoPlus-style). Returns shaped
 * authority + concentration flags, or `{ found: false }`.
 */
export async function getBirdeyeSecurity({ mint, chain = "solana" } = {}) {
  if (!mint) return { found: false, error: "mint is required" };
  const resp = await birdeyeForge(`/forge/${chain}/token/tokensecurity?token=${mint}`);
  const r = resp?.data?.result?.data;
  if (!r) return { found: false, mint, source: "birdeye-security" };
  const pct = (v) => (typeof v === "number" ? +(v * 100).toFixed(2) : null);
  return {
    found: true,
    source: "birdeye-security",
    mint,
    creator_address: r.creator_address ?? null,
    creator_pct: pct(r.creator_percent),
    owner_pct: pct(r.owner_percent),
    top10_holder_pct: pct(r.top10_holder_percent),
    mintable: r.mintable ?? null,
    mint_renounced: r.renounce ?? null,
    mutable_metadata: r.mutable_metadata ?? null,
    freezeable: r.freezeable ?? r.freeze_authority ?? null,
    non_transferable: r.non_transferable ?? null,
    transfer_fee_enable: r.transfer_fee_enable ?? null,
    is_token_2022: r.is_token_2022 ?? null,
    creation_time_unix: r.creation_time ?? null,
  };
}

const GEM_DEFAULTS = {
  chain: "solana",
  type: "trending",
  sort_by: "tf24h.volumeChangePercent",
  sort_type: "desc",
  offset: 0,
  limit: 50,
  shown_time_frame: "24h",
  filters: [], // required by Birdeye since 2026-06 — omitting it returns 400 "filters invalid format"
};

function shapeGem(raw) {
  const win = (tf) => (tf ? {
    price_change_pct: tf.priceChangePercent ?? null,
    volume_usd: tf.volumeUSD ?? null,
    volume_change_pct: tf.volumeChangePercent ?? null,
    trades: tf.tradeCount ?? null,
    unique_wallets: tf.uniqueWallets ?? null,
  } : null);
  const createdMs = raw.createdAt ? Date.parse(raw.createdAt) : null;
  return {
    symbol: raw.symbol ?? null,
    mint: raw.address ?? null,
    network: raw.network ?? null,
    price_usd: raw.price ?? null,
    mcap: raw.mc ?? null,
    fdv: raw.fdmc ?? null,
    liquidity_usd: raw.liquidity ?? null,
    holder_count: raw.holderCount ?? null,
    top10_holder_pct: raw.top10HolderPercent != null ? +(raw.top10HolderPercent * 100).toFixed(2) : null,
    age_hours: createdMs ? Math.round((Date.now() - createdMs) / 36e5) : null,
    velocity: { "1h": win(raw.tf1h), "4h": win(raw.tf4h), "24h": win(raw.tf24h) },
  };
}

/**
 * Momentum-tuned SPOT candidate list (Hunter's primary source). Sources the
 * keyless Birdeye trending gems, sorts by 1h price momentum, and filters:
 *   - 1h price change in [min_change, max_change] (positive momentum, reject blow-off)
 *   - liquidity >= min_tvl  (thin pools = slippage traps)
 *   - 24h volume >= min_volume
 * Hunter still does per-candidate 5m deep-research (get_dex_velocity → true 5m).
 */
export async function getMomentumCandidates({ limit = 5, min_change = 3, max_change = 80, min_tvl = 20000, min_volume = 0, chain = "solana" } = {}) {
  const gems = await getBirdeyeGems({ chain, limit: 50, sort_by: "tf1h.priceChangePercent", sort_type: "desc" });
  if (!gems.items?.length) return { source: "birdeye-momentum", count: 0, candidates: [], note: gems.error || "no gems data" };
  const candidates = gems.items.filter((c) => {
    const ch = c.velocity?.["1h"]?.price_change_pct;
    const vol = c.velocity?.["24h"]?.volume_usd ?? 0;
    return typeof ch === "number" && ch >= min_change && ch <= max_change
      && (c.liquidity_usd ?? 0) >= min_tvl && vol >= min_volume;
  }).slice(0, limit);
  return {
    source: "birdeye-momentum",
    filters: { min_change, max_change, min_tvl, min_volume },
    screened: gems.items.length,
    count: candidates.length,
    candidates,
  };
}

/** Trending candidate list with per-window velocity + holder data. */
export async function getBirdeyeGems(opts = {}) {
  const payload = { ...GEM_DEFAULTS, ...opts };
  // Discovery call (not hot-path): allow a cold warm-up since it's uncached.
  const resp = await birdeyeForge("/forge/multichain/v3/gems", { method: "POST", body: payload, timeoutMs: 90000 });
  const items = resp?.data?.items;
  if (!Array.isArray(items)) {
    return { source: "birdeye-gems", error: "no data", count: 0, items: [] };
  }
  return { source: "birdeye-gems", count: items.length, items: items.map(shapeGem) };
}
