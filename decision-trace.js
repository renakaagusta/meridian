/**
 * Full decision-trace store.
 *
 * One JSONL record per screening/management cycle, capturing EVERYTHING the
 * agent saw and did so the learning process can mine the complete history:
 *   - inputs:   every candidate considered (incl. pre-LLM filtered ones), wallet
 *               state, strategy, signal weights, position data
 *   - transcript: the full agentLoop run (assistant reasoning incl. <think>,
 *               every tool call with raw args, and raw tool results)
 *   - challenger: every verdict produced this cycle
 *   - decision: the structured outcome (deploy / no_deploy / skip / actions)
 *
 * Append-only, trimmed to the most recent MAX_TRACES to bound disk use.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRACE_PATH = path.join(__dirname, "decision-traces.jsonl");
const MAX_TRACES = 5000;          // hard cap — oldest trimmed beyond this
const MAX_FIELD_CHARS = 200_000;  // guard against a single pathological record

function safeStringify(value) {
  try {
    const s = JSON.stringify(value);
    return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}…[truncated]` : s;
  } catch {
    return null;
  }
}

/**
 * Append a full cycle trace. Returns the trace id.
 */
export function appendTrace(trace) {
  const record = {
    id: trace.id || `trace_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ts: trace.ts || new Date().toISOString(),
    cycle: trace.cycle || "unknown",        // "screening" | "management" | "health" | ...
    actor: trace.actor || "AGENT",
    decision: trace.decision || null,        // structured outcome
    inputs: trace.inputs || null,            // everything the agent saw
    transcript: trace.transcript || [],      // full step-by-step LLM run
    challenger: trace.challenger || [],      // verdicts this cycle
    final_content_raw: trace.final_content_raw ?? null,
    final_content: trace.final_content ?? null,
    error: trace.error ?? null,
  };

  const line = safeStringify(record);
  if (!line) {
    log("trace_warn", "Failed to serialize decision trace — skipping");
    return null;
  }

  try {
    fs.appendFileSync(TRACE_PATH, `${line}\n`);
    trimIfNeeded();
  } catch (error) {
    log("trace_warn", `Failed to write decision trace: ${error.message}`);
    return null;
  }
  return record.id;
}

function trimIfNeeded() {
  try {
    const raw = fs.readFileSync(TRACE_PATH, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length <= MAX_TRACES) return;
    fs.writeFileSync(TRACE_PATH, `${lines.slice(-MAX_TRACES).join("\n")}\n`);
  } catch { /* best-effort */ }
}

export function readTraces({ limit = 50 } = {}) {
  if (!fs.existsSync(TRACE_PATH)) return [];
  const lines = fs.readFileSync(TRACE_PATH, "utf8").split("\n").filter(Boolean);
  return lines.slice(-limit).reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function getTrace(id) {
  if (!fs.existsSync(TRACE_PATH)) return null;
  const lines = fs.readFileSync(TRACE_PATH, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]);
      if (rec.id === id) return rec;
    } catch { /* skip */ }
  }
  return null;
}

/** Lightweight summaries for the timeline (no heavy transcript payload). */
export function readTraceSummaries({ limit = 100 } = {}) {
  return readTraces({ limit }).map((t) => ({
    id: t.id,
    ts: t.ts,
    cycle: t.cycle,
    actor: t.actor,
    candidates_considered: t.inputs?.candidates_considered ?? null,
    candidates_filtered: Array.isArray(t.inputs?.filtered) ? t.inputs.filtered.length : null,
    decision_type: t.decision?.type ?? null,
    decision_summary: t.decision?.summary ?? null,
    challenger_count: Array.isArray(t.challenger) ? t.challenger.length : 0,
    steps: Array.isArray(t.transcript) ? t.transcript.length : 0,
  }));
}
