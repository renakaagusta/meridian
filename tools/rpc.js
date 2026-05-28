/**
 * tools/rpc.js — Single source for Solana RPC + Helius REST connections.
 *
 * Supports a rotating list of URLs / keys with automatic failover on 429
 * ("max usage reached") or transient network errors. Each call starts at
 * URL[0]; on failure, it advances down the list before surfacing the error
 * to the caller.
 *
 * Env vars (comma-separated lists; whitespace tolerated):
 *   RPC_URLS         e.g. "https://mainnet.helius-rpc.com/?api-key=K1,
 *                          https://mainnet.helius-rpc.com/?api-key=K2,
 *                          https://api.mainnet-beta.solana.com"
 *   HELIUS_API_KEYS  e.g. "K1,K2,K3" — for api.helius.xyz REST endpoints.
 *                    Keys are also auto-extracted from helius URLs in RPC_URLS,
 *                    so a single RPC_URLS list usually suffices.
 *
 * Backward-compat: if the plural form is unset, the singular RPC_URL /
 * HELIUS_API_KEY is used as a one-element list.
 */
import { Connection } from "@solana/web3.js";
import { log } from "../logger.js";

let _proxy = null;
let _urls = null;
let _heliusKeys = null;

function parseList(envName) {
  const plural = process.env[envName + "S"];
  if (plural && plural.trim()) {
    return plural.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const single = process.env[envName];
  if (single && single.trim()) return [single.trim()];
  return [];
}

function extractHeliusKey(url) {
  const m = /[?&]api-key=([^&#]+)/.exec(url || "");
  return m ? decodeURIComponent(m[1]) : null;
}

function maskUrl(url) {
  if (!url) return "(empty)";
  return url.replace(/(api-key=)[^&#]+/i, "$1***");
}

export function getRpcUrls() {
  if (_urls === null) {
    _urls = parseList("RPC_URL");
  }
  return _urls;
}

export function getHeliusKeys() {
  if (_heliusKeys === null) {
    const explicit = parseList("HELIUS_API_KEY");
    const fromUrls = getRpcUrls().map(extractHeliusKey).filter(Boolean);
    const seen = new Set();
    _heliusKeys = [...explicit, ...fromUrls].filter((k) => {
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return _heliusKeys;
}

function isRateLimitOrTransientError(err) {
  if (!err) return false;
  if (err.code === -32429) return true;
  if (err.status === 429) return true;
  const msg = String(err.message || err);
  return /\b429\b|max usage reached|rate.?limit|too many requests|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg);
}

function buildRotatingProxy(connections, urls) {
  // The Proxy targets connections[0] but intercepts every method call to
  // rotate through the full list on 429/transient failure.
  return new Proxy(connections[0], {
    get(_target, prop, _receiver) {
      const value = Reflect.get(connections[0], prop, connections[0]);
      if (typeof value !== "function") return value;
      return async function rotatingCall(...args) {
        let lastErr;
        for (let i = 0; i < connections.length; i++) {
          try {
            const fn = connections[i][prop];
            return await fn.apply(connections[i], args);
          } catch (err) {
            lastErr = err;
            if (!isRateLimitOrTransientError(err) || i === connections.length - 1) {
              throw err;
            }
            log("rpc_fallback",
              `URL[${i}] ${maskUrl(urls[i])} failed on ${String(prop)} (${err.message || err.code || "error"}); trying URL[${i + 1}]`);
          }
        }
        throw lastErr;
      };
    },
  });
}

/**
 * Get a rotating Connection. First call constructs the list from env;
 * subsequent calls return the same Proxy.
 */
export function getConnection() {
  if (_proxy) return _proxy;
  const urls = getRpcUrls();
  if (urls.length === 0) {
    throw new Error("No RPC URL configured. Set RPC_URL or RPC_URLS.");
  }
  // `disableRetryOnRateLimit: true` lets us fail over after the FIRST 429,
  // skipping web3.js's built-in ~7s exponential retry that just wastes time
  // when the upstream account is hard-quota-exhausted.
  const connections = urls.map((u) => new Connection(u, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  }));
  log("rpc_init", `Configured ${urls.length} RPC URL(s): ${urls.map((u, i) => `[${i}] ${maskUrl(u)}`).join(", ")}`);
  _proxy = buildRotatingProxy(connections, urls);
  return _proxy;
}

/**
 * Fetch a Helius REST URL, rotating through HELIUS_API_KEYS on 429.
 *
 * @param {(key: string) => string} buildUrl - function returning the URL given an api key
 * @returns {Promise<Response>}
 */
export async function fetchWithHeliusKeyRotation(buildUrl) {
  const keys = getHeliusKeys();
  if (keys.length === 0) {
    throw new Error("No Helius API key configured. Set HELIUS_API_KEY or HELIUS_API_KEYS.");
  }
  let lastErr;
  for (let i = 0; i < keys.length; i++) {
    try {
      const res = await fetch(buildUrl(keys[i]));
      if (res.status === 429 && i < keys.length - 1) {
        log("helius_fallback", `Helius key[${i}] returned 429; trying key[${i + 1}]`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (!isRateLimitOrTransientError(err) || i === keys.length - 1) throw err;
      log("helius_fallback", `Helius key[${i}] errored (${err.message}); trying key[${i + 1}]`);
    }
  }
  throw lastErr || new Error("All Helius keys failed");
}

/** Test helper — clears the singleton so tests can re-read env. */
export function _resetForTests() {
  _proxy = null;
  _urls = null;
  _heliusKeys = null;
}
