/**
 * tools/decision-trace.js — append-only decision traces for counterfactual
 * calibration (issue #11).
 *
 * Each screening cycle logs the candidate set it evaluated; each deploy logs the
 * pool it entered. scripts/counterfactual-check.js reads these to score whether
 * the pools we SKIPPED actually sustained (missed opportunity) or collapsed
 * (correct skip). Append-only JSONL so it survives restarts and is cheap to write.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../logger.js";

const TRACE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "decision-traces.jsonl");
const MAX_LINES = 5000; // keep the file bounded — trim oldest when exceeded

export function appendDecisionTrace(entry) {
  try {
    fs.appendFileSync(TRACE_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    // Opportunistic trim (cheap, infrequent): if the file grows past MAX_LINES,
    // keep the most recent MAX_LINES.
    const stat = fs.statSync(TRACE_FILE);
    if (stat.size > 4_000_000) {
      const lines = fs.readFileSync(TRACE_FILE, "utf8").split("\n").filter(Boolean);
      if (lines.length > MAX_LINES) {
        fs.writeFileSync(TRACE_FILE, lines.slice(-MAX_LINES).join("\n") + "\n");
      }
    }
  } catch (e) {
    log("decision_trace_error", e.message);
  }
}
