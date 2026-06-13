import fs from "fs";
import { log } from "./logger.js";
import { appendDecisionTrace } from "./tools/decision-trace.js";

const DECISION_LOG_FILE = "./decision-log.json";
const MAX_DECISIONS = 100;

// ── Swarmscope mirror (additive, fire-and-forget) ───────────────────────────
// Sends close/deploy/claim decisions — incl. WHY (reason) + pnl — to the
// observability service. Never awaited, never throws into the decision path.
const SWARMSCOPE_URL = process.env.SWARMSCOPE_URL || "";
const SWARMSCOPE_KEY = process.env.SWARMSCOPE_KEY || "";
function emitSwarmscope(path, body) {
  if (!SWARMSCOPE_URL || !SWARMSCOPE_KEY) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    fetch(`${SWARMSCOPE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": SWARMSCOPE_KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).catch(() => {}).finally(() => clearTimeout(t));
  } catch { /* observability must never break decisions */ }
}

function load() {
  if (!fs.existsSync(DECISION_LOG_FILE)) {
    return { decisions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DECISION_LOG_FILE, "utf8"));
  } catch (error) {
    log("decision_log_warn", `Invalid ${DECISION_LOG_FILE}: ${error.message}`);
    return { decisions: [] };
  }
}

function save(data) {
  fs.writeFileSync(DECISION_LOG_FILE, JSON.stringify(data, null, 2));
}

function sanitize(value, maxLen = 280) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLen) || null;
}

export function appendDecision(entry) {
  const data = load();
  const decision = {
    id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    type: entry.type || "note",
    actor: entry.actor || "GENERAL",
    pool: entry.pool || null,
    pool_name: sanitize(entry.pool_name || entry.pool, 120),
    position: entry.position || null,
    summary: sanitize(entry.summary),
    reason: sanitize(entry.reason, 500),
    risks: Array.isArray(entry.risks) ? entry.risks.map((r) => sanitize(r, 140)).filter(Boolean).slice(0, 6) : [],
    metrics: entry.metrics || {},
    rejected: Array.isArray(entry.rejected) ? entry.rejected.map((r) => sanitize(r, 180)).filter(Boolean).slice(0, 8) : [],
  };
  data.decisions.unshift(decision);
  data.decisions = data.decisions.slice(0, MAX_DECISIONS);
  save(data);
  // Mirror deploys to the append-only decision trace so the counterfactual
  // checker can exclude pools we actually entered from the "skipped" set (#11).
  if (decision.type === "deploy" && decision.pool) {
    appendDecisionTrace({ cycle: "deploy", decision: { pool: decision.pool } });
  }
  // Mirror close/deploy/claim (with WHY + pnl) to swarmscope observability.
  if (["close", "deploy", "claim"].includes(decision.type) && decision.pool) {
    const m = decision.metrics || {};
    const isMgmt = decision.type !== "deploy";
    const key = (decision.position || decision.pool).slice(0, 8);
    emitSwarmscope("/v1/decisions", { namespace: "meridian-dlmm",
      trace_id: `md:${decision.type}:${decision.ts}:${key}`,
      ts: decision.ts,
      agent: decision.actor === "MANAGER" ? "Manager" : "Screener",
      kind: isMgmt ? "management" : "screening",
      decision_type: decision.type,
      summary: decision.summary || `${decision.type} ${decision.pool_name || ""}`.trim(),
      reasoning: decision.reason || null,
      deployed_pool: decision.type === "deploy" ? decision.pool : undefined,
      positions: [{
        ref: decision.pool,
        label: decision.pool_name,
        pnl: m.pnl_pct ?? null,
        status: decision.type === "close" ? "closed" : decision.type === "deploy" ? "open" : "active",
        rule: decision.type.toUpperCase(),
        detail: { reason: decision.reason, risks: decision.risks, ...m },
      }],
    });
    emitSwarmscope("/v1/agents/heartbeat", { namespace: "meridian-dlmm", name: decision.actor === "MANAGER" ? "Manager" : "Screener", role: "meta", status: "online" });
  }
  return decision;
}

export function getRecentDecisions(limit = 10) {
  const data = load();
  return (data.decisions || []).slice(0, limit);
}

export function getDecisionSummary(limit = 6) {
  const decisions = getRecentDecisions(limit);
  if (!decisions.length) return "No recent structured decisions yet.";
  return decisions.map((d, i) => {
    const bits = [
      `${i + 1}. [${d.actor}] ${d.type.toUpperCase()} ${d.pool_name || d.pool || "unknown pool"}`,
      d.summary ? `summary: ${d.summary}` : null,
      d.reason ? `reason: ${d.reason}` : null,
      d.risks?.length ? `risks: ${d.risks.join(", ")}` : null,
      d.rejected?.length ? `rejected: ${d.rejected.join(" | ")}` : null,
    ].filter(Boolean);
    return bits.join(" | ");
  }).join("\n");
}
