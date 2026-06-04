/**
 * tools/gmgn.js — keyless GMGN website-API signals via the stackbase scraper.
 *
 * GMGN's website backend (`gmgn.ai/{api,vas,defi/quotation}/v1/...`) exposes the
 * alert-bot-grade signals — wallet cohorts (sniper/bundler/insider/fresh), early-
 * buyer dump status, Meteora pool fee config — with no API key but behind
 * Cloudflare. We reach it through the scraper's `POST /scrape/gmgn` proxy, which
 * drives a real-Chrome residential CDP warm tab, harvests GMGN's session/device
 * params from the page's own XHRs, and fetches any /api,/vas,/defi path.
 *
 * Diagnostics go to STDERR only — the Meridian CLI writes its JSON result to
 * stdout, which the agent bridge parses.
 */
const SCRAPER_URL = (process.env.MERIDIAN_SCRAPER_URL || "https://scraper.stackbase.id").replace(/\/+$/, "");
const SCRAPER_SECRET = process.env.MERIDIAN_SCRAPER_SECRET || process.env.SCRAPER_SECRET || "";
// GMGN's warm-tab path can need a cold Cloudflare clear + SPA hydration on the
// first call, so allow more headroom than Birdeye's forge fetch.
const FETCH_TIMEOUT_MS = Number(process.env.MERIDIAN_GMGN_TIMEOUT_MS || 90000);

const logErr = (tag, msg) => console.error(`[gmgn] ${tag}: ${msg}`);
const num = (v) => (v == null || v === "" ? null : +Number(v).toFixed(6));

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

/**
 * Fetch any GMGN website-API path through the scraper proxy. Returns GMGN's
 * `data` object (envelope unwrapped), or null on any failure. Trading data is
 * never cached (ttl 0).
 */
async function gmgnWeb(path, { method = "GET", body, ttl = 0 } = {}) {
  if (!SCRAPER_SECRET) return null; // feature not provisioned — quiet no-op
  try {
    const res = await withTimeout(
      fetch(`${SCRAPER_URL}/scrape/gmgn`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SCRAPER_SECRET}` },
        body: JSON.stringify({ path, method, body, ttl }),
      }),
      FETCH_TIMEOUT_MS,
    );
    if (!res.ok) {
      logErr("http", `${res.status} for ${path}`);
      return null;
    }
    const data = await res.json();
    const j = data?.json;
    // GMGN envelope: { code, message|msg, data }. code 0 = success.
    if (j && typeof j.code === "number" && j.code !== 0) {
      logErr("api", `code ${j.code} ${j.message || j.msg || ""} for ${path}`);
      return null;
    }
    return j?.data ?? null;
  } catch (e) {
    logErr("error", `${e.message} for ${path}`);
    return null;
  }
}

/**
 * Wallet-cohort counts for a token — the single best rug/dump filter. Counts of
 * smart / renowned / fresh / sniper / bundler / creator / rat-trader / whale /
 * top / following wallets currently holding. High sniper+bundler+fresh vs low
 * smart+renowned = trap.
 */
export async function getGmgnWalletTags({ mint, chain = "sol" } = {}) {
  if (!mint) return { found: false, error: "mint is required" };
  const d = await gmgnWeb(`/api/v1/token_wallet_tags_stat/${chain}/${mint}`);
  if (!d) return { found: false, mint, source: "gmgn-wallet-tags" };
  return {
    found: true,
    source: "gmgn-wallet-tags",
    mint,
    smart_wallets: d.smart_wallets ?? null,
    renowned_wallets: d.renowned_wallets ?? null,
    fresh_wallets: d.fresh_wallets ?? null,
    sniper_wallets: d.sniper_wallets ?? null,
    bundler_wallets: d.bundler_wallets ?? null,
    creator_wallets: d.creator_wallets ?? null,
    rat_trader_wallets: d.rat_trader_wallets ?? null,
    whale_wallets: d.whale_wallets ?? null,
    top_wallets: d.top_wallets ?? null,
    following_wallets: d.following_wallets ?? null,
  };
}

/**
 * Early-buyer dump status — of the first ~70 buyers, how many already sold, the
 * holding rate, top-10 holder rate and top-70 sniper hold rate. A high sold /
 * low holding_rate = early money already gone (exit/avoid signal).
 */
export async function getGmgnTopBuyers({ mint, chain = "sol" } = {}) {
  if (!mint) return { found: false, error: "mint is required" };
  const d = await gmgnWeb(`/defi/quotation/v1/tokens/top_buyers/${chain}/${mint}`);
  const h = d?.holders;
  if (!h) return { found: false, mint, source: "gmgn-top-buyers" };
  const s = h.statusNow || {};
  return {
    found: true,
    source: "gmgn-top-buyers",
    mint,
    holder_count: h.holder_count ?? null,
    top70_sniper_hold_rate: num(h.top70_sniper_hold_rate),
    early_buyers_sold: s.sold ?? null,
    early_buyers_hold: s.hold ?? null,
    early_buyers_sold_part: s.sold_part ?? null,
    bought_rate: num(s.bought_rate),
    holding_rate: num(s.holding_rate),
    top10_holder_rate: s.top_10_holder_rate ?? null,
    smart_money_positions: Array.isArray(s.smart_pos) ? s.smart_pos.length : null,
  };
}

/**
 * Per-pool fee config for a token — exchange, liquidity, fee ratio, dynamic-fee
 * flag, and Meteora DAMM v2 / virtual-curve fee configs. Directly DLMM-relevant
 * for Scout when sizing fee yield.
 */
export async function getGmgnPoolFee({ mint, chain = "sol" } = {}) {
  if (!mint) return { found: false, error: "mint is required" };
  const d = await gmgnWeb(`/api/v1/token_pool_fee_info/${chain}/${mint}`);
  const list = d?.list;
  if (!Array.isArray(list)) return { found: false, mint, source: "gmgn-pool-fee" };
  return {
    found: true,
    source: "gmgn-pool-fee",
    mint,
    count: list.length,
    pools: list.map((p) => ({
      pool_address: p.address ?? null,
      exchange: p.exchange ?? null,
      liquidity_usd: p.liquidity ?? null,
      fee_ratio: p.fee_ratio ?? null,
      is_dynamic_fee: p.is_dynamic_fee ?? null,
      pool_type: p.pool_type ?? null,
      meteora_damm_v2_base_fee_config: p.meteora_damm_v2_base_fee_config ?? null,
      meteora_virtual_curve_fee_config: p.meteora_virtual_curve_fee_config ?? null,
    })),
  };
}
