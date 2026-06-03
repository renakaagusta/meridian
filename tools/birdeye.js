/**
 * tools/birdeye.js — keyless Birdeye "find-gems" velocity + holder signals.
 *
 * Birdeye's find-gems data (per-window price/volume velocity, unique wallets,
 * holder count, top-10 concentration) is far more reliable than DexScreener's
 * short-window fields, which the challenger repeatedly flags as fabricated for
 * thin memecoin pools. The data has no API key — but it sits behind Cloudflare,
 * so we fetch it through the stackbase scraper's CDP warm-tab (real Chrome over
 * a residential exit). See apps/scraper/src/scrapers/providers/birdeye/gems.ts.
 *
 * Each Meridian CLI command runs as a fresh process, so the gems list is cached
 * to a JSON file on disk with a short TTL. One scraper call (≈50 tokens) serves
 * many per-token velocity lookups within the TTL.
 *
 * Windows available: 1h / 4h / 24h (find-gems has no 5m granularity).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

// Diagnostics MUST go to stderr — Meridian CLI commands write their JSON result
// to stdout, which agents parse. Any stdout write here would corrupt that.
const logErr = (tag, msg) => console.error(`[birdeye] ${tag}: ${msg}`);

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, "..", "birdeye-gems-cache.json");

const SCRAPER_URL = (process.env.MERIDIAN_SCRAPER_URL || "https://scraper.stackbase.id").replace(/\/+$/, "");
const SCRAPER_SECRET = process.env.MERIDIAN_SCRAPER_SECRET || process.env.SCRAPER_SECRET || "";
const TTL_SEC = Number(process.env.MERIDIAN_BIRDEYE_TTL_SEC || 120);
const FETCH_TIMEOUT_MS = Number(process.env.MERIDIAN_BIRDEYE_TIMEOUT_MS || 120000);

const DEFAULTS = {
  chain: "solana",
  type: "trending",
  sort_by: "tf24h.volumeChangePercent",
  sort_type: "desc",
  offset: 0,
  limit: 50,
  shown_time_frame: "24h",
};

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return { entries: {} };
  }
}

function writeCache(cache) {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {
    logErr("cache_write_error", e.message);
  }
}

/** Condense a raw gems item to the fields the screener/challenger care about. */
function shapeItem(raw) {
  const win = (tf) => {
    if (!tf) return null;
    return {
      price_change_pct: tf.priceChangePercent ?? null,
      volume_usd: tf.volumeUSD ?? null,
      volume_change_pct: tf.volumeChangePercent ?? null,
      trades: tf.tradeCount ?? null,
      trades_change_pct: tf.tradeCountChangePercent ?? null,
      unique_wallets: tf.uniqueWallets ?? null,
    };
  };
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
    created_at: raw.createdAt ?? null,
    age_hours: createdMs ? Math.round((Date.now() - createdMs) / 36e5) : null,
    velocity: {
      "1h": win(raw.tf1h),
      "4h": win(raw.tf4h),
      "24h": win(raw.tf24h),
    },
  };
}

async function fetchGemsFromScraper(payload) {
  if (!SCRAPER_SECRET) throw new Error("MERIDIAN_SCRAPER_SECRET (or SCRAPER_SECRET) not set");
  const res = await withTimeout(
    fetch(`${SCRAPER_URL}/scrape/birdeye/gems`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SCRAPER_SECRET}` },
      body: JSON.stringify(payload),
    }),
    FETCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`scraper HTTP ${res.status}`);
  const data = await res.json();
  const items = data?.items;
  if (!Array.isArray(items)) throw new Error("scraper returned no items");
  return items;
}

/**
 * Fetch the Birdeye gems list (cached on disk, TTL-bounded). Returns shaped
 * items with per-window velocity + holder data. On a fetch failure, falls back
 * to the last cached copy marked `stale: true`; if no cache exists, returns
 * `{ error, stale: true, items: [] }` so callers can degrade gracefully.
 */
export async function getBirdeyeGems(opts = {}) {
  // No secret configured → feature not provisioned. Quietly no-op (no stderr
  // spam) so callers fall back to their existing source without noise.
  if (!SCRAPER_SECRET) {
    return { source: "birdeye-gems", stale: true, error: "not configured", count: 0, items: [] };
  }
  const payload = { ...DEFAULTS, ...opts };
  const key = JSON.stringify(payload);
  const cache = readCache();
  const entry = cache.entries?.[key];
  const now = Date.now();

  if (entry && now - entry.fetched_at < TTL_SEC * 1000) {
    return {
      source: "birdeye-gems",
      fetched_at: new Date(entry.fetched_at).toISOString(),
      age_sec: Math.round((now - entry.fetched_at) / 1000),
      stale: false,
      cached: true,
      count: entry.items.length,
      items: entry.items.map(shapeItem),
    };
  }

  try {
    const items = await fetchGemsFromScraper(payload);
    cache.entries = cache.entries || {};
    cache.entries[key] = { fetched_at: now, items };
    writeCache(cache);
    return {
      source: "birdeye-gems",
      fetched_at: new Date(now).toISOString(),
      age_sec: 0,
      stale: false,
      cached: false,
      count: items.length,
      items: items.map(shapeItem),
    };
  } catch (e) {
    logErr("gems_error", e.message);
    if (entry) {
      return {
        source: "birdeye-gems",
        fetched_at: new Date(entry.fetched_at).toISOString(),
        age_sec: Math.round((now - entry.fetched_at) / 1000),
        stale: true,
        cached: true,
        error: e.message,
        count: entry.items.length,
        items: entry.items.map(shapeItem),
      };
    }
    return { source: "birdeye-gems", stale: true, error: e.message, count: 0, items: [] };
  }
}

/**
 * Accurate per-token velocity (1h/4h/24h) + holders, looked up from the gems
 * list by mint. Returns `{ found: false }` if the token isn't in Birdeye's
 * trending set (the caller should then keep its existing source). Pull a wide
 * list (limit 100) so the lookup hit-rate is as high as possible.
 */
export async function getBirdeyeVelocity({ mint, chain = "solana" } = {}) {
  if (!mint) return { found: false, error: "mint is required" };
  const gems = await getBirdeyeGems({ chain, limit: 100 });
  const hit = gems.items.find((i) => i.mint === mint);
  if (!hit) {
    return { found: false, mint, source: "birdeye-gems", list_stale: !!gems.stale, list_age_sec: gems.age_sec ?? null };
  }
  return {
    found: true,
    source: "birdeye-gems",
    list_stale: !!gems.stale,
    list_age_sec: gems.age_sec ?? null,
    ...hit,
  };
}
