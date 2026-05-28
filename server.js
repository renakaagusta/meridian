/**
 * Decision visualizer — a dependency-free local web server that renders the
 * agent's decision-making CHRONOLOGICALLY: deploys, skips, closes, lessons
 * learned, threshold/weight evolutions, evaluator proposals, challenger
 * verdicts and (log-mode) hivemind sends, all on one timeline.
 *
 * Reads the JSON/JSONL state files fresh on each request (low volume, no cache).
 * Start via index.js (config.web.enabled) or standalone: `npm run viz`.
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readTraceSummaries, getTrace } from "./decision-trace.js";
import { getLessonsForPrompt, listLessons, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// What each agent actually has in memory (what gets injected into its prompt + shared store).
function buildMemory() {
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  const agents = {
    SCREENER: {
      reads: "role-tagged lessons + recent decisions + Darwin signal weights + per-candidate pool memory",
      injected_lessons: safe(() => getLessonsForPrompt({ agentType: "SCREENER" })),
      recent_decisions: safe(() => getDecisionSummary(6)),
    },
    MANAGER: {
      reads: "role-tagged lessons (rule-executor — limited influence)",
      injected_lessons: safe(() => getLessonsForPrompt({ agentType: "MANAGER" })),
    },
    CHALLENGER: {
      reads: "per-pool history (recallForPool) + risk/loss lessons",
      injected_lessons: safe(() => getLessonsForPrompt({ agentType: "CHALLENGER" })),
    },
    EVALUATOR: {
      reads: "performance summary + all lessons + recent decisions + per-agent stats",
      performance: safe(() => getPerformanceSummary()),
      recent_decisions: safe(() => getDecisionSummary(8)),
    },
  };
  return {
    generated_at: new Date().toISOString(),
    agents,
    store: {
      lessons: safe(() => listLessons({ limit: 80 })?.lessons) || [],
      performance: safe(() => getPerformanceSummary()),
      pool_memory: readJson("pool-memory.json", { pools: {} }),
      proposals: readJsonl("evaluator-proposals.jsonl").slice(-10).reverse(),
    },
  };
}

function readJson(file, fallback) {
  try {
    const p = path.join(__dirname, file);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return fallback; }
}

function readJsonl(file) {
  try {
    const p = path.join(__dirname, file);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function clip(s, n = 400) {
  if (s == null) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function buildTimeline() {
  const events = [];

  // ── Structured decisions (deploy / skip / no_deploy / close / note) ──
  const dlog = readJson("decision-log.json", { decisions: [] });
  for (const d of dlog.decisions || []) {
    const detail = [
      d.summary,
      d.reason ? `Reason: ${d.reason}` : null,
      d.risks?.length ? `Risks: ${d.risks.join(", ")}` : null,
      d.rejected?.length ? `Rejected: ${d.rejected.join(" | ")}` : null,
    ].filter(Boolean).join("\n");
    events.push({
      ts: d.ts,
      type: d.type || "note",
      actor: d.actor || "—",
      title: `${d.type ? d.type.toUpperCase() : "NOTE"} ${d.pool_name || d.pool || ""}`.trim(),
      detail: clip(detail, 600),
    });
  }

  // ── Performance closes (ground-truth outcomes) ──
  const lessonsData = readJson("lessons.json", { lessons: [], performance: [] });
  for (const p of lessonsData.performance || []) {
    const pnl = Number(p.pnl_pct ?? 0);
    events.push({
      ts: p.recorded_at,
      type: "outcome",
      actor: "RESULT",
      title: `${pnl >= 0 ? "▲" : "▼"} ${p.pool_name || p.pool || "position"} ${pnl >= 0 ? "+" : ""}${pnl}%`,
      detail: clip(`fees $${p.fees_earned_usd ?? 0} | held ${p.minutes_held ?? "?"}m | in-range ${p.range_efficiency ?? "?"}% | reason: ${p.close_reason || "?"}`, 300),
    });
  }

  // ── Lessons learned + auto-evolutions ──
  for (const l of lessonsData.lessons || []) {
    const isEvo = (l.tags || []).includes("evolution") || (l.tags || []).includes("config_change");
    events.push({
      ts: l.created_at,
      type: isEvo ? "evolution" : "lesson",
      actor: "LEARN",
      title: isEvo ? "Threshold evolution" : `Lesson (${l.outcome || "?"}${l.samples > 1 ? `, ×${l.samples}` : ""})`,
      detail: clip(l.rule, 400),
    });
  }

  // ── Evaluator proposals ──
  for (const o of readJsonl("evaluator-proposals.jsonl")) {
    const sugg = (o.suggestions || []).map((s) => `${s.key}: ${s.current}→${s.proposed}`).join(", ");
    events.push({
      ts: o.ts,
      type: "evaluator",
      actor: "ORCH",
      title: `Meta-review${o.applied ? " (applied)" : ""}`,
      detail: clip([o.assessment, sugg ? `Suggested: ${sugg}` : "No changes"].filter(Boolean).join("\n"), 700),
    });
  }

  // ── HiveMind log-mode outbound (what WOULD have been sent) ──
  for (const h of readJsonl("hivemind-outbound.jsonl")) {
    const ev = h.payload?.event || {};
    events.push({
      ts: h.ts,
      type: "hivemind",
      actor: "HIVE",
      title: `would-send: ${h.kind}`,
      detail: clip(ev.pool ? `${ev.poolName || ev.pool} pnl ${ev.pnlPct}% fees $${ev.feesUsd}` : (h.kind || ""), 200),
    });
  }

  // ── Full cycle traces (clickable → /api/trace?id=) ──
  for (const t of readTraceSummaries({ limit: 200 })) {
    const bits = [
      t.candidates_considered != null ? `${t.candidates_considered} candidates seen` : null,
      t.candidates_filtered ? `${t.candidates_filtered} pre-filtered` : null,
      t.steps ? `${t.steps} LLM steps` : null,
      t.challenger_count ? `${t.challenger_count} challenger verdict(s)` : null,
    ].filter(Boolean).join(" · ");
    events.push({
      ts: t.ts,
      type: "cycle",
      actor: t.actor,
      title: `${t.cycle} cycle — ${t.decision_summary || t.decision_type || "?"}`,
      detail: clip(bits, 200),
      trace_id: t.id,
    });
  }

  events.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  return events;
}

const PAGE = path.join(__dirname, "public", "timeline.html");

export function startWebServer(port = 8420) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/timeline") {
      const body = JSON.stringify({ events: buildTimeline(), generated_at: new Date().toISOString() });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (url.pathname === "/api/trace") {
      const trace = getTrace(url.searchParams.get("id"));
      res.writeHead(trace ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(trace || { error: "not found" }));
      return;
    }
    if (url.pathname === "/api/history") {
      const rows = readJsonl("benchmark/history.jsonl");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ rows }));
      return;
    }
    if (url.pathname === "/api/memory") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(buildMemory()));
      return;
    }
    if (url.pathname === "/memory") {
      try {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(path.join(__dirname, "public", "memory.html"), "utf8"));
      } catch {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("memory.html not found");
      }
      return;
    }
    // default → serve the timeline page
    try {
      const html = fs.readFileSync(PAGE, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("timeline.html not found");
    }
  });
  server.listen(port, () => {
    console.log(`[web] Decision visualizer on http://localhost:${port}`);
  });
  server.on("error", (e) => {
    console.error(`[web] Failed to start on port ${port}: ${e.message}`);
  });
  return server;
}

// Standalone mode
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  startWebServer(Number(process.env.WEB_PORT || 8420));
}
