/**
 * Pre-deploy challenger — a devil's-advocate LLM pass that argues AGAINST a
 * proposed deploy before any SOL moves. Runs inside the executor's deploy gate.
 *
 * Design choices:
 *  - Fail-OPEN: if the challenger errors or times out, the deploy proceeds.
 *    The challenger is additive protection, not a hard gate — provider downtime
 *    must never freeze all trading.
 *  - Self-contained: gathers its own fresh pool snapshot via dynamic imports so
 *    it works for both the screener cron path and manual deploys.
 */

import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { config } from "./config.js";
import { log } from "./logger.js";
import { appendDecision } from "./decision-log.js";
import { recallForPool } from "./pool-memory.js";
import { getLessonsForPrompt } from "./lessons.js";
import { notifyChallenger } from "./telegram.js";

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 90 * 1000,
});

const VETO_CONFIDENCE = 0.6;

function stripThink(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function parseVerdict(raw) {
  const clean = stripThink(raw);
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    try {
      return JSON.parse(jsonrepair(match[0]));
    } catch {
      return null;
    }
  }
}

async function gatherSnapshot(args) {
  const snapshot = {};
  try {
    const { getPoolDetail } = await import("./tools/screening.js");
    if (typeof getPoolDetail === "function" && args.pool_address) {
      const detail = await getPoolDetail({ pool_address: args.pool_address }).catch(() => null);
      if (detail) snapshot.pool = detail;
    }
  } catch { /* screening module shape changed — proceed without snapshot */ }
  return snapshot;
}

/**
 * @returns {{veto: boolean, confidence: number, reason: string}}
 */
export async function challengeDeploy(args) {
  if (!config.screening.challengerEnabled) return { veto: false, confidence: 0, reason: "challenger disabled" };

  const snapshot = await gatherSnapshot(args);
  const facts = {
    pool_address: args.pool_address,
    pool_name: args.pool_name ?? snapshot.pool?.name ?? null,
    amount_sol: args.amount_y ?? args.amount_sol ?? null,
    bins_below: args.bins_below ?? null,
    strategy: args.strategy ?? null,
    volatility: args.volatility ?? snapshot.pool?.volatility ?? null,
    pool_snapshot: snapshot.pool ?? "unavailable",
  };

  // ── Memory: this pool's own history + learned risk/loss lessons ──
  const poolMemory = (() => { try { return recallForPool(args.pool_address); } catch { return null; } })();
  const riskLessons = (() => { try { return getLessonsForPrompt({ agentType: "CHALLENGER", maxLessons: 6 }); } catch { return null; } })();
  const memoryBlock = [
    poolMemory ? `POOL HISTORY (we have traded this pool before — weigh it heavily):\n${typeof poolMemory === "string" ? poolMemory : JSON.stringify(poolMemory).slice(0, 600)}` : null,
    riskLessons ? `LEARNED RISK LESSONS (past losses/vetoes — avoid repeating):\n${riskLessons}` : null,
  ].filter(Boolean).join("\n\n");

  const system = `You are a skeptical risk reviewer for an autonomous Solana Meteora DLMM liquidity bot.
A screener has decided to deploy real SOL into the pool described below. Your job is to argue AGAINST it and find the single most disqualifying risk.
If POOL HISTORY shows we lost or repeatedly went out-of-range here, or LEARNED RISK LESSONS match this setup, weigh that heavily toward a veto.

VETO (veto=true) ONLY for concrete, serious problems, e.g.:
- rug/honeypot signals, dev still holding large supply, extreme holder concentration
- wash/fake volume (real fee generation will not materialize)
- volume already collapsing or fees too low to offset impermanent loss
- volatility so high the range will be abandoned almost immediately

Do NOT veto for ordinary speculative risk — these are memecoin pools and some risk is expected.
Respond with ONLY a JSON object, no prose:
{"veto": true|false, "confidence": 0.0-1.0, "reason": "one concise sentence"}`;

  const user = `PROPOSED DEPLOY:\n${JSON.stringify(facts, null, 2)}${memoryBlock ? `\n\n${memoryBlock}` : ""}`;

  try {
    const response = await client.chat.completions.create({
      model: config.llm.challengerModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 2048,
    });
    const verdict = parseVerdict(response.choices?.[0]?.message?.content);
    if (!verdict) {
      log("challenger_warn", "Could not parse challenger verdict — failing open");
      return { veto: false, confidence: 0, reason: "unparseable verdict (fail-open)" };
    }
    const confidence = Number(verdict.confidence) || 0;
    const veto = Boolean(verdict.veto) && confidence >= VETO_CONFIDENCE;
    const reason = String(verdict.reason || "").slice(0, 300);
    log("challenger", `${veto ? "VETO" : "pass"} (conf=${confidence}) ${reason}`);
    recordVerdict(facts, { veto, confidence, reason });
    return { veto, confidence, reason };
  } catch (error) {
    log("challenger_warn", `Challenger call failed — failing open: ${error.message}`);
    const fallback = { veto: false, confidence: 0, reason: `challenger error (fail-open): ${error.message}` };
    recordVerdict(facts, fallback);
    return fallback;
  }
}

function recordVerdict(facts, verdict) {
  try {
    appendDecision({
      type: "challenger",
      actor: "CHALLENGER",
      pool: facts.pool_address || null,
      pool_name: facts.pool_name || null,
      summary: verdict.veto ? "VETO deploy" : "passed deploy",
      reason: verdict.reason,
      metrics: { confidence: verdict.confidence },
    });
  } catch { /* never let logging break the deploy path */ }
  // Send a standalone [CHALLENGER] Telegram message on vetoes (notable risk event).
  if (verdict.veto) {
    notifyChallenger({ pool: facts.pool_name || facts.pool_address, confidence: verdict.confidence, reason: verdict.reason })
      .catch(() => { /* best-effort */ });
  }
}
