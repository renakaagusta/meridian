/**
 * tools/agent-health.js — per-agent health snapshot for the Atlas orchestrator.
 *
 * Atlas tunes cadence from portfolio state but is otherwise blind to whether its
 * agents can actually WORK. This reports, per Evonic agent: schedule enabled,
 * minutes since last activity, LLM errors in the last 24h (+ types), recent
 * broken-tool signatures, and a verdict (healthy | idle-ok | degraded | stalled
 * | dead) so Atlas can ALERT on problems (Hunter context-overflow, a candidate
 * source returning "Unknown command"/400, a stranded manager, etc.).
 *
 * Reads Evonic state (sqlite + pm2 log) via python3 — no node:sqlite dependency.
 * Detection only; remediation policy lives in Atlas's prompt.
 */
import { execFileSync } from "node:child_process";

const EVONIC_DIR = process.env.EVONIC_DIR || "/root/evonic";

const PY = `
import sqlite3, json, os, re, datetime
EV = os.environ.get("EVONIC_DIR", "/root/evonic")
DB = EV + "/shared/db/evonic.db"
now = datetime.datetime.now(datetime.timezone.utc)
def parse(ts):
    try: return datetime.datetime.fromisoformat(ts.replace(" ", "T").replace("Z", "+00:00") + ("" if ("+" in ts or "Z" in ts) else "+00:00"))
    except Exception: return None

AGENTS = ["meridian_screener","meridian_manager","meridian_trader_screener","meridian_trader_manager","meridian_challenger","meridian_trader_challenger","meridian_evaluator","meridian_compressor","meridian"]

sch = {}
try:
    for owner_id, enabled, last in sqlite3.connect(DB).execute("SELECT owner_id, enabled, last_run_at FROM schedules"):
        sch[owner_id] = {"enabled": bool(enabled), "last_run_at": last}
except Exception: pass

# LLM errors per agent from pm2-out.log, split into 24h (context) and 2h (recency).
errs = {}
cut24 = now - datetime.timedelta(hours=24)
cut2 = now - datetime.timedelta(hours=2)
try:
    lines = open(EV + "/logs/pm2-out.log", errors="ignore").read().splitlines()[-12000:]
    for l in lines:
        m = re.search(r"for agent (meridian[a-z_]*)", l)
        if not m: continue
        if not re.search(r"LLM API error: 4|context window exceeds|invalid function arguments|Fallback model.*also failed", l): continue
        t = parse(l[:19])
        if t and t < cut24: continue
        a = m.group(1); d = errs.setdefault(a, {"count": 0, "count2h": 0, "types": set(), "types2h": set()})
        d["count"] += 1
        recent = (t is None) or (t >= cut2)
        if recent: d["count2h"] += 1
        if "context window" in l: ty = "context-overflow"
        elif "invalid function" in l: ty = "invalid-args"
        elif "Fallback" in l: ty = "fallback-failed"
        else: ty = "api-4xx"
        d["types"].add(ty)
        if recent: d["types2h"].add(ty)
except Exception: pass

out = []
for a in AGENTS:
    cdb = EV + "/agents/" + a + "/chat.db"
    last = None; tool_errs = []
    if os.path.exists(cdb):
        try:
            cc = sqlite3.connect(cdb)
            last = cc.execute("SELECT max(created_at) FROM chat_messages").fetchone()[0]
            for (content,) in cc.execute("SELECT content FROM chat_messages WHERE role='tool' ORDER BY id DESC LIMIT 40"):
                if not content: continue
                mm = re.search(r"Unknown command|filters invalid|no data|invalid params|Birdeye forge returned no data|HTTP 4\\d\\d", content)
                if mm: tool_errs.append(mm.group(0))
        except Exception: pass
    mins = None
    if last:
        t = parse(last)
        if t: mins = round((now - t).total_seconds() / 60)
    s = sch.get(a, {}); e = errs.get(a, {"count": 0, "count2h": 0, "types": set(), "types2h": set()})
    enabled = s.get("enabled")
    types = sorted(e["types"]); types2h = sorted(e["types2h"]); broken = sorted(set(tool_errs))[:5]
    # verdict — recency-aware so fixed issues clear within a couple hours
    if enabled is False:
        v = "idle-ok"                                   # disabled by design (no work)
    elif enabled and (mins is None or mins > 30):
        v = "stalled"                                   # scheduled but not cycling
    elif "context-overflow" in types2h or e["count2h"] >= 5:
        v = "dead"                                      # actively failing right now
    elif e["count2h"] >= 2 or broken:
        v = "degraded"                                  # recent errors / broken tool signatures
    elif e["count"] >= 5:
        v = "recovering"                                # was failing in last 24h, now quiet
    else:
        v = "healthy"
    out.append({"agent": a, "enabled": enabled, "mins_since_active": mins, "llm_errors_24h": e["count"], "llm_errors_2h": e["count2h"], "error_types": types, "broken_tools": broken, "verdict": v})
print(json.dumps({"generated_at": now.isoformat(), "agents": out}))
`;

export async function getAgentHealth() {
  try {
    const out = execFileSync("python3", ["-c", PY], { encoding: "utf8", timeout: 30000, env: { ...process.env, EVONIC_DIR } });
    const data = JSON.parse(out.trim());
    // Convenience: surface the agents that need attention first.
    data.unhealthy = data.agents.filter((a) => ["dead", "stalled", "degraded"].includes(a.verdict));
    return data;
  } catch (e) {
    return { error: e.message, agents: [], unhealthy: [] };
  }
}
