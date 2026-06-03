/**
 * tools/external-signals.js — read-only signals from external APIs.
 *
 * No on-chain writes, no SOL movement. Used by the screener/challenger for
 * additional research beyond Meteora + Jupiter:
 *   - DexScreener  → 5m/1h/6h/24h price + volume velocity, txns by direction
 *   - RugCheck     → token risk score, high-level flags
 *   - Pump.fun     → bonding-curve status (graduated vs pre-grad)
 *
 * All functions return shaped, condensed JSON optimised for LLM consumption.
 */

import { log } from "../logger.js";

const FETCH_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

// ─── DexScreener ─────────────────────────────────────────────────
export async function getDexscreenerPair({ pool_address }) {
  if (!pool_address) return { error: "pool_address is required" };
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${pool_address}`;
    const res = await withTimeout(fetch(url), FETCH_TIMEOUT_MS);
    if (!res.ok) {
      return { error: `DexScreener HTTP ${res.status}` };
    }
    const data = await res.json();
    const p = (data.pairs || [{}])[0];
    if (!p.priceUsd) {
      return { pool: pool_address, error: "no pair data returned" };
    }

    const pc1h = p.priceChange?.h1 ?? null;
    const pc6h = p.priceChange?.h6 ?? null;
    const v6h = p.volume?.h6 ?? 0;
    const v1h = p.volume?.h1 ?? 0;
    const v5m = p.volume?.m5 ?? 0;

    // Derived signals: high-level booleans the LLM can pattern-match
    const isCollapsing1h = pc1h !== null && pc1h < -15;
    const isCollapsing6h = pc6h !== null && pc6h < -30;
    // Volume "dying" if last 1h is < 30% of an even slice of 6h
    const vBaseline1h = v6h / 6;
    const isVolumeDying = v6h > 0 && v1h < vBaseline1h * 0.3;
    const isVolumeStalled = v5m === 0 && v1h < 10;

    const result = {
      pool: pool_address,
      base_symbol: p.baseToken?.symbol,
      base_mint: p.baseToken?.address,
      quote_symbol: p.quoteToken?.symbol,
      price_usd: parseFloat(p.priceUsd),
      fdv: p.fdv ?? null,
      market_cap: p.marketCap ?? null,
      liquidity_usd: p.liquidity?.usd ?? null,
      price_change: {
        "5m": p.priceChange?.m5 ?? null,
        "1h": pc1h,
        "6h": pc6h,
        "24h": p.priceChange?.h24 ?? null,
      },
      volume: {
        "5m": v5m,
        "1h": v1h,
        "6h": v6h,
        "24h": p.volume?.h24 ?? null,
      },
      txns: {
        "5m": p.txns?.m5 ? `${p.txns.m5.buys}b/${p.txns.m5.sells}s` : null,
        "1h": p.txns?.h1 ? `${p.txns.h1.buys}b/${p.txns.h1.sells}s` : null,
        "6h": p.txns?.h6 ? `${p.txns.h6.buys}b/${p.txns.h6.sells}s` : null,
        "24h": p.txns?.h24 ? `${p.txns.h24.buys}b/${p.txns.h24.sells}s` : null,
      },
      signals: {
        is_collapsing_1h: isCollapsing1h,
        is_collapsing_6h: isCollapsing6h,
        is_volume_dying: isVolumeDying,
        is_volume_stalled: isVolumeStalled,
      },
      // DexScreener's short-window fields (esp. 5m) are unreliable for thin
      // pools — the challenger repeatedly catches them fabricated. Default the
      // velocity source label to dexscreener; overlay accurate Birdeye 1h/4h/24h
      // windows below when the token is in Birdeye's trending set.
      velocity_source: "dexscreener",
    };

    // Overlay accurate Birdeye find-gems velocity (keyless, via scraper) when
    // available. Non-fatal: any failure leaves the DexScreener result intact.
    try {
      const { getBirdeyeVelocity } = await import("./birdeye.js");
      const be = await getBirdeyeVelocity({ mint: result.base_mint });
      if (be && be.found) {
        result.birdeye_velocity = {
          "1h": be.velocity?.["1h"] ?? null,
          "4h": be.velocity?.["4h"] ?? null,
          "24h": be.velocity?.["24h"] ?? null,
          holder_count: be.holder_count ?? null,
          top10_holder_pct: be.top10_holder_pct ?? null,
          stale: !!be.list_stale,
          age_sec: be.list_age_sec ?? null,
        };
        result.velocity_source = "birdeye";
        result.velocity_note =
          "Prefer birdeye_velocity (real on-chain windows) over the price_change/volume/txns fields, which are DexScreener short-window estimates and unreliable for thin pools. Birdeye has no 5m window — use 1h as the shortest trustworthy interval.";
      }
    } catch (e) {
      // stderr only — stdout carries the tool's JSON result.
      console.error(`[birdeye] overlay_error: ${e.message}`);
    }

    return result;
  } catch (e) {
    log("dexscreener_error", e.message);
    return { error: e.message };
  }
}

// ─── RugCheck ────────────────────────────────────────────────────
export async function getRugcheckReport({ mint }) {
  if (!mint) return { error: "mint is required" };
  try {
    const url = `https://api.rugcheck.xyz/v1/tokens/${mint}/report`;
    const res = await withTimeout(fetch(url), FETCH_TIMEOUT_MS);
    if (!res.ok) {
      return { error: `RugCheck HTTP ${res.status}` };
    }
    const d = await res.json();

    const risks = d.risks || [];
    const danger = risks.filter((r) => r.level === "danger");
    const warn = risks.filter((r) => r.level === "warn");

    const topHolders = d.topHolders || [];
    const top10 = topHolders.slice(0, 10);
    const top10Pct = top10.reduce((s, h) => s + (h.pct || 0), 0);

    return {
      mint,
      score: d.score,                    // 0-100, lower = better
      rugged: !!d.rugged,
      risk_summary: {
        total: risks.length,
        danger_count: danger.length,
        warn_count: warn.length,
        danger_names: danger.map((r) => r.name),
        warn_names: warn.map((r) => r.name),
      },
      risks_top: risks.slice(0, 5).map((r) => ({
        name: r.name,
        level: r.level,
        description: (r.description || "").slice(0, 140),
        value: r.value,
      })),
      holder_concentration: {
        top_10_pct: Math.round(top10Pct * 100) / 100,
        insider_network_count: (d.insiderNetworks || []).length,
      },
      verdict_hint:
        d.rugged ? "RUGGED — hard veto" :
        d.score >= 80 ? "high_risk" :
        d.score >= 50 ? "moderate_risk" :
        "low_risk",
    };
  } catch (e) {
    log("rugcheck_error", e.message);
    return { error: e.message };
  }
}

// ─── Pump.fun (v3 frontend API) ──────────────────────────────────
export async function getPumpfunStatus({ mint }) {
  if (!mint) return { error: "mint is required" };
  try {
    const url = `https://frontend-api-v3.pump.fun/coins/${mint}`;
    const res = await withTimeout(fetch(url), FETCH_TIMEOUT_MS);
    if (!res.ok) {
      return { error: `pump.fun HTTP ${res.status}` };
    }
    const d = await res.json();
    if (!d || !d.mint) {
      return { mint, error: "not a pump.fun token" };
    }

    return {
      mint,
      name: d.name,
      symbol: d.symbol,
      graduated: !!d.complete,           // true once it migrates off the bonding curve
      is_live: !!d.is_currently_live,
      usd_market_cap: d.usd_market_cap ?? null,
      created_at_unix: d.created_timestamp ? Math.floor(d.created_timestamp / 1000) : null,
      age_hours: d.created_timestamp ? Math.round((Date.now() - d.created_timestamp) / 36e5) : null,
      creator: d.creator,
      virtual_sol_reserves: d.virtual_sol_reserves ?? null,
      real_sol_reserves: d.real_sol_reserves ?? null,
      reply_count: d.reply_count ?? null,
      socials: {
        twitter: d.twitter || null,
        website: d.website || null,
        telegram: d.telegram || null,
      },
      // Derived
      verdict_hint:
        !d.complete ? "PRE-GRADUATION — high rug risk" :
        d.age_hours != null && d.age_hours < 6 ? "very_fresh_post_grad" :
        "graduated",
    };
  } catch (e) {
    log("pumpfun_error", e.message);
    return { error: e.message };
  }
}
