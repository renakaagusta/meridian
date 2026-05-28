/**
 * Connectivity diagnostics — probes every external dependency FROM NODE
 * (the same network stack the bot uses) so unreachable services surface
 * immediately instead of as opaque "fetch failed" errors mid-cycle.
 *
 * Run standalone: `npm run diag`
 * On demand:      `/diag` (REPL or Telegram)
 * At startup:     called from index.js when WEB/diag enabled.
 */

import "dotenv/config";
import net from "net";
import dnsSync from "dns";
import dns from "dns/promises";
import { log } from "./logger.js";

// Match the bot's Happy-Eyeballs fix (see config.js) so diagnostics reflect runtime behavior.
try {
  net.setDefaultAutoSelectFamilyAttemptTimeout?.(Number(process.env.NET_FAMILY_ATTEMPT_TIMEOUT_MS) || 2500);
  dnsSync.setDefaultResultOrder?.("ipv4first");
} catch { /* best effort */ }

function describeErr(error) {
  const code = error?.cause?.code || error?.code;
  const addr = error?.cause?.address;
  return [code, addr ? `addr=${addr}` : null, error?.message].filter(Boolean).join(" ");
}

async function probe(name, url, opts = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t = Date.now();
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    const ms = Date.now() - t;
    // reachable = we got an HTTP response at all; auth/path issues are status>=400 but still "connected"
    return { name, reachable: true, status: r.status, ms, note: r.status >= 400 ? "connected (HTTP error / auth)" : "ok" };
  } catch (error) {
    return { name, reachable: false, status: null, ms: Date.now() - t, note: describeErr(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveHost(label, url) {
  try {
    const host = new URL(url).hostname;
    const addrs = await dns.lookup(host, { all: true });
    return `${label} ${host} → ${addrs.map((a) => a.address).join(", ")}`;
  } catch (e) {
    return `${label} DNS failed: ${e.message}`;
  }
}

/**
 * @returns {Promise<{results: object[], text: string}>}
 */
export async function runConnectivityCheck() {
  const llmBase = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
  const llmKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "";
  const llmModel = process.env.LLM_MODEL || "";
  const rpc = process.env.RPC_URL;

  const dnsLine = await resolveHost("LLM host", llmBase);

  const probes = [
    probe("LLM /models", `${llmBase.replace(/\/+$/, "")}/models`, {
      headers: llmKey ? { Authorization: `Bearer ${llmKey}` } : {},
    }),
    probe("LLM /chat (auth+tools)", `${llmBase.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${llmKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: llmModel, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }),
    }),
    rpc ? probe("Helius RPC", rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    }) : Promise.resolve({ name: "Helius RPC", reachable: false, status: null, ms: 0, note: "RPC_URL not set" }),
    probe("Meteora API", "https://dlmm.datapi.meteora.ag/pools?query=SOL&limit=1"),
    probe("Jupiter API", "https://lite-api.jup.ag/tokens/v2/search?query=SOL"),
    process.env.TELEGRAM_BOT_TOKEN
      ? probe("Telegram", `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`)
      : Promise.resolve({ name: "Telegram", reachable: false, status: null, ms: 0, note: "TELEGRAM_BOT_TOKEN not set" }),
  ];

  const results = await Promise.all(probes);

  const lines = results.map((r) => {
    const icon = r.reachable ? (r.status && r.status < 400 ? "✅" : "⚠️") : "❌";
    return `${icon} ${r.name.padEnd(22)} ${r.status ?? "—"}  ${r.ms}ms  ${r.note}`;
  });
  const text = ["🩺 CONNECTIVITY CHECK", dnsLine, "", ...lines].join("\n");

  for (const l of lines) log("diag", l.replace(/\s+/g, " ").trim());
  return { results, text };
}

// Standalone mode
if (process.argv[1] && process.argv[1].endsWith("diagnostics.js")) {
  const { text } = await runConnectivityCheck();
  console.log("\n" + text + "\n");
  process.exit(0);
}
