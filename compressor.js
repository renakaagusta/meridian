/**
 * COMPRESSOR — a memory-maintenance agent.
 *
 * As each agent (SCREENER / MANAGER / CHALLENGER) accumulates lessons, the list
 * grows noisy and redundant. The compressor semantically MERGES a role's lessons
 * into a smaller, high-signal set — preserving every distinct risk/insight while
 * dropping duplication and stale specifics. It only runs for a role once its
 * compressible lessons exceed a threshold.
 *
 * SAFETY: never touches pinned lessons, auto-evolution lessons, or other roles.
 * Compressed lessons are tagged `compressed` so they're traceable on the memory page.
 *
 *   compressIfNeeded()        — compress every role over threshold (used on a schedule / after eval)
 *   compressAgentMemory(role) — force-compress one role
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { config } from "./config.js";
import { log } from "./logger.js";
import { compressibleLessons, replaceAgentLessons } from "./lessons.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.join(__dirname, "memory-backups");
const ROLES = ["SCREENER", "MANAGER", "CHALLENGER"];

// Snapshot a role's pre-compression lessons to memory-backups/[ROLE]-[timestamp].log
// so a compression can always be reviewed / restored.
function backupMemory(role, lessons, compressedTo) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(BACKUP_DIR, `${role}-${ts}.log`);
    fs.writeFileSync(file, JSON.stringify({
      role, timestamp: new Date().toISOString(),
      original_count: lessons.length, compressed_count: compressedTo.length,
      original_lessons: lessons,
      compressed_lessons: compressedTo,
    }, null, 2));
    log("compressor", `Backed up ${role} memory (${lessons.length} lessons) → memory-backups/${role}-${ts}.log`);
    return file;
  } catch (e) {
    log("compressor_warn", `Backup failed for ${role}: ${e.message}`);
    return null;
  }
}

const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 120 * 1000,
});

function stripThink(t) { return String(t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim(); }
function parseJson(raw) {
  const m = stripThink(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { try { return JSON.parse(jsonrepair(m[0])); } catch { return null; } }
}

/**
 * @returns {Promise<{role,removed,added}|{role,skipped:true,count}>}
 */
export async function compressAgentMemory(role, { force = false } = {}) {
  const threshold = config.compressor?.lessonThreshold ?? 10;
  const target = config.compressor?.targetCount ?? 6;
  const lessons = compressibleLessons(role);
  if (!force && lessons.length < threshold) {
    return { role, skipped: true, count: lessons.length };
  }
  if (lessons.length < 2) return { role, skipped: true, count: lessons.length };

  const system = `You compress an autonomous trading agent's memory. You are given the ${role} agent's accumulated lessons.
Merge them into AT MOST ${target} consolidated lessons. Rules:
- Preserve EVERY distinct, actionable insight or risk warning — only remove redundancy and stale one-off specifics (pool names, dates).
- Keep each lesson concrete and imperative (something the agent can act on).
- Resolve contradictions by keeping the more evidence-backed / recent guidance.
- Do NOT invent new advice not supported by the input lessons.
Respond with ONLY JSON: {"lessons":[{"rule":"...","tags":["..."]}]}`;

  const user = `${role} LESSONS (${lessons.length}):\n` +
    lessons.map((l, i) => `${i + 1}. [${l.outcome || "?"}] ${l.rule}`).join("\n");

  let parsed;
  try {
    const r = await client.chat.completions.create({
      model: config.llm.compressorModel || config.llm.evaluatorModel,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.2,
      max_tokens: 2048,
    });
    parsed = parseJson(r.choices?.[0]?.message?.content);
  } catch (e) {
    log("compressor_warn", `${role} compression call failed: ${e.message}`);
    return { role, skipped: true, error: e.message };
  }

  const out = (parsed?.lessons || []).filter((l) => l && typeof l.rule === "string" && l.rule.trim().length > 8).slice(0, target);
  if (!out.length) { log("compressor_warn", `${role}: no usable compressed lessons — leaving memory unchanged`); return { role, skipped: true }; }

  // Snapshot BEFORE replacing — compression must always be reversible.
  const backup = backupMemory(role, lessons, out);
  const res = replaceAgentLessons(role, out);
  log("compressor", `${role}: ${res.removed} → ${res.added} lessons (backup: ${backup ? path.basename(backup) : "FAILED"})`);
  return { ...res, backup };
}

/** Compress every role whose compressible lesson count exceeds the threshold. */
export async function compressIfNeeded() {
  const results = [];
  for (const role of ROLES) {
    const r = await compressAgentMemory(role);
    if (!r.skipped) results.push(r);
  }
  return results;
}
