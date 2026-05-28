/**
 * EVALUATOR — a propose-only meta-reviewer.
 *
 * It periodically (or on demand) reviews the bot's performance, lessons,
 * parameters, and recent decisions, then emits a REPORT + suggested config
 * diffs. It NEVER applies changes on its own — proposals are written to
 * evaluator-proposals.jsonl for a human to approve via applyProposal().
 *
 * Rationale: letting an LLM silently rewrite its own trading parameters
 * compounds risk and makes failures un-attributable. Advice, not autonomy.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { config, reloadScreeningThresholds } from "./config.js";
import { log } from "./logger.js";
import { getPerformanceSummary, listLessons, addLesson } from "./lessons.js";
import { getRecentDecisions } from "./decision-log.js";

const AGENT_ROLES = new Set(["SCREENER", "MANAGER", "CHALLENGER"]);

// Per-agent behavioral stats so the evaluator can evaluate each agent.
function agentStats() {
  let decisions = [];
  try { decisions = JSON.parse(fs.readFileSync(path.join(__dirname, "decision-log.json"), "utf8")).decisions || []; } catch { /* none */ }
  const screener = { deploys: 0, no_deploys: 0, skips: 0, reasons: {} };
  const challenger = { vetoes: 0, passes: 0, reasons: {} };
  for (const d of decisions) {
    if (d.actor === "SCREENER") {
      if (d.type === "deploy") screener.deploys++;
      else if (d.type === "no_deploy") { screener.no_deploys++; const r = (d.reason || "").slice(0, 40); if (r) screener.reasons[r] = (screener.reasons[r] || 0) + 1; }
      else if (d.type === "skip") screener.skips++;
    } else if (d.actor === "CHALLENGER") {
      if (/veto/i.test(d.summary || "")) { challenger.vetoes++; const r = (d.reason || "").slice(0, 40); if (r) challenger.reasons[r] = (challenger.reasons[r] || 0) + 1; }
      else challenger.passes++;
    }
  }
  const perf = getPerformanceSummary();
  return {
    SCREENER: { ...screener, deploy_rate_pct: screener.deploys + screener.no_deploys > 0 ? Math.round((screener.deploys / (screener.deploys + screener.no_deploys)) * 100) : 0, top_reject: Object.entries(screener.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3) },
    CHALLENGER: { ...challenger, veto_rate_pct: challenger.vetoes + challenger.passes > 0 ? Math.round((challenger.vetoes / (challenger.vetoes + challenger.passes)) * 100) : 0, top_veto: Object.entries(challenger.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3) },
    MANAGER: { closed_positions: perf?.total_positions_closed ?? 0, win_rate_pct: perf?.win_rate_pct ?? null, avg_pnl_pct: perf?.avg_pnl_pct ?? null, avg_range_efficiency_pct: perf?.avg_range_efficiency_pct ?? null },
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROPOSALS_PATH = path.join(__dirname, "evaluator-proposals.jsonl");
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

// Keys the evaluator is allowed to propose changes to (whitelist — never
// let it touch wallet, RPC, model, or hivemind keys).
const TUNABLE_KEYS = new Set([
  "minFeeActiveTvlRatio", "minTvl", "maxTvl", "minVolume", "minOrganic",
  "minHolders", "minMcap", "maxMcap", "minBinStep", "maxBinStep", "maxVolatility",
  "minTokenFeesSol", "maxBundlePct", "maxBotHoldersPct", "maxTop10Pct",
  "deployAmountSol", "positionSizePct", "maxPositions", "outOfRangeWaitMinutes",
  "takeProfitPct", "stopLossPct", "minFeePerTvl24h", "trailingTriggerPct", "trailingDropPct",
]);

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 120 * 1000,
});

function stripThink(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function parseJson(raw) {
  const clean = stripThink(raw);
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); }
  catch { try { return JSON.parse(jsonrepair(match[0])); } catch { return null; } }
}

function gatherState() {
  // Your OWN recent reviews — read them so your reasoning is CONTINUOUS across runs
  // (assessment + what you suggested + whether you applied it + lessons you wrote).
  const priorReviews = readProposals().slice(-5).reverse().map((p) => ({
    ts: p.ts,
    assessment: p.assessment,
    suggested: (p.suggestions || []).map((s) => `${s.key}: ${s.current}→${s.proposed}`),
    applied: !!p.applied,
    lessons_written: (p.agent_lessons_written || []).map((l) => `${l.agent}: ${l.lesson}`),
  }));
  return {
    performance: getPerformanceSummary(),
    agent_stats: agentStats(),
    recent_decisions: getRecentDecisions(15),
    lessons: listLessons({ limit: 25 }),
    prior_reviews: priorReviews,
    current_config: {
      screening: config.screening,
      management: config.management,
      risk: config.risk,
      schedule: config.schedule,
    },
  };
}

/**
 * Run a meta-review. Writes a proposal record and returns a human-readable summary.
 * @returns {Promise<{summary: string, proposal: object|null}>}
 */
export async function runEvaluatorReview({ trigger = "manual" } = {}) {
  const state = gatherState();

  if (!state.performance || (state.performance.total_positions_closed ?? 0) < 3) {
    const summary = "Evaluator: not enough closed positions yet (need ≥3) for a meaningful review.";
    log("evaluator", summary);
    return { summary, proposal: null };
  }

  const system = `You are the EVALUATOR for an autonomous Solana Meteora DLMM liquidity bot. You do NOT trade.
Review the bot's performance, lessons, current parameters, and recent decisions, then advise.

Be conservative: only suggest changes backed by clear evidence in the data. Prefer small adjustments.
You may ONLY propose changes to these config keys: ${[...TUNABLE_KEYS].join(", ")}.

CONTINUITY — state.prior_reviews holds YOUR last reviews. Read them first and stay consistent:
- Do NOT re-propose a change you already suggested unless it was applied and you have new evidence.
- Do NOT contradict a recent suggestion (e.g. proposing the opposite direction) without explicitly explaining in 'assessment' why your view changed.
- Honor PINNED lessons in state.lessons — they encode validated conclusions; do not propose changes they explicitly warn against (e.g. if a pinned lesson says low PnL is from IL/OOR and to NOT change takeProfitPct or loosen filters, respect that until re-centering has produced data).
- In each suggestion's 'rationale', reference the specific metric/evidence that justifies it.

You also EVALUATE EACH AGENT (SCREENER, MANAGER, CHALLENGER) from agent_stats and may write a short lesson into that agent's memory — a concrete, durable instruction it will see on every future run. Base each lesson on evidence in the data (deploy/veto rates, win rate, rejection reasons). Keep ≤1 lesson per agent, only if clearly warranted.

Respond with ONLY a JSON object:
{
  "assessment": "2-4 sentence honest read of how the bot is doing and why",
  "suggestions": [{"key": "<one of the allowed keys>", "current": <value>, "proposed": <value>, "rationale": "evidence-based reason"}],
  "agent_lessons": [{"agent": "SCREENER|MANAGER|CHALLENGER", "lesson": "one concrete actionable instruction", "tags": ["risk","entry",...]}],
  "prompt_notes": ["short observations, if any"]
}
Return empty arrays where nothing is warranted.`;

  const user = `BOT STATE:\n${JSON.stringify(state, null, 2)}`;

  let parsed;
  try {
    const response = await client.chat.completions.create({
      model: config.llm.evaluatorModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
      max_tokens: 3072,
    });
    parsed = parseJson(response.choices?.[0]?.message?.content);
  } catch (error) {
    const summary = `Evaluator review failed: ${error.message}`;
    log("evaluator_warn", summary);
    return { summary, proposal: null };
  }

  if (!parsed) {
    const summary = "Evaluator: could not parse review output.";
    log("evaluator_warn", summary);
    return { summary, proposal: null };
  }

  // Keep only suggestions that touch whitelisted keys.
  const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
    .filter((s) => s && TUNABLE_KEYS.has(s.key))
    .slice(0, 12);

  // Evaluate each agent → write a role-tagged lesson into that agent's memory.
  // A guaranteed role-tag ensures getLessonsForPrompt({agentType}) surfaces it.
  const ROLE_TAG = { SCREENER: "screening", MANAGER: "management", CHALLENGER: "risk" };
  const writtenLessons = [];
  for (const a of (Array.isArray(parsed.agent_lessons) ? parsed.agent_lessons : []).slice(0, 6)) {
    const agent = String(a?.agent || "").toUpperCase();
    const lesson = String(a?.lesson || "").trim();
    if (!AGENT_ROLES.has(agent) || lesson.length < 8) continue;
    const tags = [...new Set([ROLE_TAG[agent], "evaluator", ...(Array.isArray(a.tags) ? a.tags.map((t) => String(t).slice(0, 24)) : [])])].filter(Boolean);
    try {
      addLesson(`[EVALUATOR→${agent}] ${lesson}`, tags, { role: agent });
      writtenLessons.push({ agent, lesson, tags });
    } catch (e) { log("evaluator_warn", `Failed to write lesson for ${agent}: ${e.message}`); }
  }

  const proposal = {
    id: `eval_${Date.now()}`,
    ts: new Date().toISOString(),
    trigger,
    assessment: String(parsed.assessment || "").slice(0, 1200),
    suggestions,
    agent_lessons_written: writtenLessons,
    prompt_notes: (Array.isArray(parsed.prompt_notes) ? parsed.prompt_notes : []).map((n) => String(n).slice(0, 300)).slice(0, 8),
    applied: false,
  };

  try {
    fs.appendFileSync(PROPOSALS_PATH, `${JSON.stringify(proposal)}\n`);
  } catch (error) {
    log("evaluator_warn", `Failed to write proposal: ${error.message}`);
  }

  const lines = [
    `🧭 [EVALUATOR] REVIEW (${proposal.id})`,
    "",
    proposal.assessment,
  ];
  if (suggestions.length) {
    lines.push("", "SUGGESTED CHANGES (not applied — review then /evaluator apply <id>):");
    for (const s of suggestions) {
      lines.push(`• ${s.key}: ${s.current} → ${s.proposed} — ${s.rationale}`);
    }
  } else {
    lines.push("", "No parameter changes suggested.");
  }
  if (writtenLessons.length) {
    lines.push("", "LESSONS WRITTEN TO AGENT MEMORY:");
    for (const l of writtenLessons) lines.push(`• → ${l.agent}: ${l.lesson}`);
  }
  if (proposal.prompt_notes.length) {
    lines.push("", "NOTES:");
    for (const n of proposal.prompt_notes) lines.push(`• ${n}`);
  }

  log("evaluator", `Review complete (${proposal.id}) — ${suggestions.length} suggestion(s), ${writtenLessons.length} lesson(s) written`);
  return { summary: lines.join("\n"), proposal };
}

function readProposals() {
  if (!fs.existsSync(PROPOSALS_PATH)) return [];
  return fs.readFileSync(PROPOSALS_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

export function getLatestProposal() {
  const all = readProposals();
  return all.length ? all[all.length - 1] : null;
}

/**
 * Apply a previously-generated proposal's suggestions to user-config.json.
 * Manual, explicit action — never called automatically.
 * @param {string} [proposalId] - defaults to the latest proposal
 */
export function applyEvaluatorProposal(proposalId = null) {
  const all = readProposals();
  if (!all.length) return { ok: false, message: "No proposals exist yet." };
  const proposal = proposalId ? all.find((p) => p.id === proposalId) : all[all.length - 1];
  if (!proposal) return { ok: false, message: `Proposal ${proposalId} not found.` };
  if (!proposal.suggestions?.length) return { ok: false, message: "Proposal has no suggestions to apply." };

  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  const applied = [];
  for (const s of proposal.suggestions) {
    if (!TUNABLE_KEYS.has(s.key)) continue;
    if (typeof s.proposed !== "number" && typeof s.proposed !== "boolean") continue;
    userConfig[s.key] = s.proposed;
    applied.push(`${s.key}=${s.proposed}`);
  }
  if (!applied.length) return { ok: false, message: "No applicable numeric/boolean suggestions found." };

  userConfig._lastEvaluatorApply = new Date().toISOString();
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
  reloadScreeningThresholds();

  log("evaluator", `Applied proposal ${proposal.id}: ${applied.join(", ")}`);
  return { ok: true, message: `Applied: ${applied.join(", ")}`, applied };
}
