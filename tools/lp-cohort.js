/**
 * tools/lp-cohort.js — Aggregate PnL view of every LP in a given DLMM pool.
 *
 * Method:
 *   1. getProgramAccounts(DLMM_PROGRAM, filter=lb_pair=<pool>) to fetch every
 *      open Position account in the pool.
 *   2. Decode each position's owner (32 bytes at offset 40 in the account data).
 *   3. For each *unique* owner, call the Meteora DLMM PnL API to fetch their
 *      open positions in this pool (the existing fetchDlmmPnlForPool helper
 *      requires a user filter).
 *   4. Aggregate: count, % profitable, median / p25 / p75 / best / worst.
 *
 * This is *the* signal we lacked: "are most LPs in this pool actually making
 * money?" If 70% are profitable with median +5%, the pool is genuinely
 * earning. If 80% are negative with median -8%, it's a trap regardless of
 * how good the surface metrics look.
 */

import { PublicKey } from "@solana/web3.js";
import { log } from "../logger.js";
import { getConnection } from "./rpc.js";

const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

const FETCH_TIMEOUT_MS = 12000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

async function fetchOwnerPnl(poolAddress, walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await withTimeout(fetch(url), FETCH_TIMEOUT_MS);
    if (!res.ok) return [];
    const data = await res.json();
    const positions = data.positions || data.data || [];
    return positions
      .map((p) => p.pnlPctChange)
      .filter((v) => v !== null && v !== undefined && !Number.isNaN(parseFloat(v)))
      .map((v) => parseFloat(v));
  } catch (e) {
    return [];
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
  return sorted[idx];
}

export async function getPoolLpCohort({ pool_address, max_owners_sampled = 60 } = {}) {
  if (!pool_address) return { error: "pool_address is required" };
  const t0 = Date.now();

  try {
    const connection = getConnection();

    // Step 1: every open Position account in this pool
    const accounts = await connection.getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 8, bytes: pool_address } }],
      encoding: "base64",
    });

    const totalPositions = accounts.length;
    if (totalPositions === 0) {
      return {
        pool: pool_address,
        total_positions: 0,
        total_lps: 0,
        sample_size: 0,
        message: "no open positions in pool — empty or non-existent",
      };
    }

    // Step 2: decode owner per position (offset 40, 32 bytes after the 8-byte
    // discriminator + 32-byte lb_pair)
    const ownerToPositions = new Map();
    for (const acc of accounts) {
      try {
        const owner = new PublicKey(acc.account.data.slice(40, 72)).toBase58();
        if (!ownerToPositions.has(owner)) ownerToPositions.set(owner, []);
        ownerToPositions.get(owner).push(acc.pubkey.toBase58());
      } catch (e) {
        // Skip un-decodable
      }
    }

    const uniqueOwners = [...ownerToPositions.keys()];
    const totalLps = uniqueOwners.length;

    // Step 3: fetch PnL per unique owner, capped + parallel.
    // Sort owners by position count desc so the most-significant LPs are
    // always in the sample.
    uniqueOwners.sort((a, b) =>
      (ownerToPositions.get(b)?.length || 0) - (ownerToPositions.get(a)?.length || 0));
    const sample = uniqueOwners.slice(0, max_owners_sampled);

    const pnlBatches = await Promise.all(
      sample.map((owner) => fetchOwnerPnl(pool_address, owner)),
    );

    const allPnls = [];
    for (const arr of pnlBatches) {
      for (const v of arr) allPnls.push(v);
    }

    const sample_size = allPnls.length;
    if (sample_size === 0) {
      return {
        pool: pool_address,
        total_positions: totalPositions,
        total_lps: totalLps,
        sampled_owners: sample.length,
        sample_size: 0,
        elapsed_ms: Date.now() - t0,
        message: "no PnL data returned from Meteora API for any sampled owner",
      };
    }

    const sorted = [...allPnls].sort((a, b) => a - b);
    const profitable = allPnls.filter((p) => p > 0);
    const avg = allPnls.reduce((s, x) => s + x, 0) / allPnls.length;

    // Top 10 by size = top 10 owners with most positions; aggregate THEIR PnL
    const top10Owners = uniqueOwners.slice(0, 10);
    const top10Pnls = top10Owners.flatMap((owner, i) => i < pnlBatches.length ? pnlBatches[i] : []);
    const top10Avg = top10Pnls.length
      ? top10Pnls.reduce((s, x) => s + x, 0) / top10Pnls.length
      : null;

    return {
      pool: pool_address,
      total_positions: totalPositions,
      total_lps: totalLps,
      sampled_owners: sample.length,
      sample_size,
      elapsed_ms: Date.now() - t0,
      profitable_count: profitable.length,
      profitable_pct: Math.round((profitable.length / sample_size) * 10000) / 100,
      median_pnl_pct: percentile(sorted, 0.5),
      p25_pnl_pct: percentile(sorted, 0.25),
      p75_pnl_pct: percentile(sorted, 0.75),
      avg_pnl_pct: Math.round(avg * 100) / 100,
      best_pnl_pct: sorted[sorted.length - 1],
      worst_pnl_pct: sorted[0],
      top10_by_size_avg_pnl_pct: top10Avg !== null ? Math.round(top10Avg * 100) / 100 : null,
      verdict_hint:
        profitable.length / sample_size >= 0.6 && percentile(sorted, 0.5) > 3 ? "STRONG_GREEN" :
        profitable.length / sample_size >= 0.5 ? "neutral_positive" :
        profitable.length / sample_size <= 0.3 ? "STRONG_RED — cohort is losing" :
        "neutral_negative",
    };
  } catch (e) {
    log("lp_cohort_error", e.message);
    return { error: e.message, elapsed_ms: Date.now() - t0 };
  }
}
