#!/usr/bin/env python3
"""VETO outcome tracker — Stage 1 observability for Skeptic + Argus VETOs.

Runs every 6h via system cron. Reads all trade_verdict:* and dlmm_verdict:*
entries from workspace, fetches CURRENT token price via gmgn-cli, computes
forward returns at the time elapsed since the verdict, and writes to
veto_outcomes table.

The goal: after 30+ samples we have ground truth on whether VETOs were
prescient (token dropped) or over-cautious (token pumped).
"""
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone

DB_PATH = "/root/evonic/shared/db/evonic.db"
GMGN_CLI = "/root/.local/share/mise/installs/node/24.11.0/bin/gmgn-cli"
ENV_FILE = "/root/.config/gmgn/.env"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS veto_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  verdict_key TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  verdict TEXT NOT NULL,
  confidence REAL,
  veto_ts TEXT NOT NULL,
  veto_reason TEXT,
  checked_at TEXT NOT NULL,
  hours_elapsed REAL,
  price_now REAL,
  price_at_veto REAL,
  return_since_veto_pct REAL,
  return_1h_pct REAL,
  return_6h_pct REAL,
  return_24h_pct REAL,
  classification TEXT,
  UNIQUE(verdict_key, checked_at)
);
CREATE INDEX IF NOT EXISTS idx_veto_outcomes_mint ON veto_outcomes(mint);
CREATE INDEX IF NOT EXISTS idx_veto_outcomes_verdict ON veto_outcomes(verdict, classification);
"""


def env_for_gmgn():
    env = os.environ.copy()
    try:
        for ln in open(ENV_FILE):
            if "=" in ln and not ln.lstrip().startswith("#"):
                k, _, v = ln.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return env


def fetch_token_price(mint: str) -> dict | None:
    try:
        proc = subprocess.run(
            [GMGN_CLI, "token", "info", "--chain", "sol", "--address", mint],
            capture_output=True, text=True, timeout=20, env=env_for_gmgn(),
        )
    except subprocess.TimeoutExpired:
        return None
    if proc.returncode != 0:
        return None
    try:
        d = json.loads(proc.stdout)
        p = d.get("price") or {}
        def n(x):
            try: return float(x) if x not in (None, "") else None
            except Exception: return None
        return {
            "symbol": d.get("symbol"),
            "now": n(p.get("price")),
            "p1h": n(p.get("price_1h")),
            "p6h": n(p.get("price_6h")),
            "p24h": n(p.get("price_24h")),
        }
    except Exception:
        return None


def classify(return_pct: float | None, verdict: str) -> str:
    """Was the verdict good or bad?"""
    if return_pct is None:
        return "unknown"
    # Use absolute thresholds independent of verdict direction
    if verdict.upper() == "VETO":
        # Forward return is the OPPORTUNITY we declined
        if return_pct >= 50: return "missed_huge"     # >50% missed
        if return_pct >= 20: return "missed_winner"
        if return_pct >= 5:  return "missed_minor"
        if return_pct >= -5: return "neutral"
        if return_pct >= -20: return "saved_minor"     # would have lost
        return "saved_big"
    else:  # PROCEED
        if return_pct >= 20: return "proceed_won_big"
        if return_pct >= 5:  return "proceed_won"
        if return_pct >= -5: return "proceed_neutral"
        if return_pct >= -20: return "proceed_lost"
        return "proceed_lost_big"


def main():
    con = sqlite3.connect(DB_PATH, timeout=10.0)
    con.row_factory = sqlite3.Row
    for stmt in _SCHEMA.split(";"):
        s = stmt.strip()
        if s: con.execute(s)
    con.commit()

    now = datetime.now(timezone.utc)
    now_iso = now.strftime("%Y-%m-%d %H:%M:%S")
    checked = 0
    inserted = 0

    # Pull every trade_verdict:* and dlmm_verdict:* entry
    rows = list(con.execute("""
        SELECT key, value, created_at FROM meridian_shared_memory
        WHERE key LIKE 'trade_verdict:%' OR key LIKE 'dlmm_verdict:%'
        ORDER BY created_at DESC
    """))

    for r in rows:
        d = dict(r)
        try:
            v = json.loads(d["value"])
        except Exception:
            continue

        verdict = (v.get("verdict") or "").upper()
        if verdict not in ("VETO", "PROCEED"):
            continue

        mint = v.get("mint") or d["key"].split(":", 1)[1]
        if not mint:
            continue

        agent = "skeptic" if d["key"].startswith("trade_verdict:") else "argus"
        veto_ts = d["created_at"]
        try:
            veto_dt = datetime.strptime(veto_ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            hours_elapsed = (now - veto_dt).total_seconds() / 3600
        except Exception:
            hours_elapsed = None

        # Only check verdicts that are at least 1h old (need price movement) and
        # at most 7 days old (older data isn't actionable for tuning)
        if hours_elapsed is None or hours_elapsed < 1 or hours_elapsed > 168:
            continue

        prices = fetch_token_price(mint)
        if not prices or prices["now"] is None:
            continue

        # Approximate price_at_veto: use the historical bucket nearest to elapsed hours
        if hours_elapsed <= 1.5:
            p_at_veto = prices["p1h"]
        elif hours_elapsed <= 8:
            p_at_veto = prices["p6h"]
        else:
            p_at_veto = prices["p24h"]

        ret_since = None
        if p_at_veto and prices["now"]:
            ret_since = (prices["now"] / p_at_veto - 1) * 100

        ret_1h = ret_6h = ret_24h = None
        if prices["p1h"] and prices["now"]:
            ret_1h = (prices["now"] / prices["p1h"] - 1) * 100
        if prices["p6h"] and prices["now"]:
            ret_6h = (prices["now"] / prices["p6h"] - 1) * 100
        if prices["p24h"] and prices["now"]:
            ret_24h = (prices["now"] / prices["p24h"] - 1) * 100

        cls = classify(ret_since, verdict)

        try:
            con.execute(
                """INSERT OR IGNORE INTO veto_outcomes
                (agent_id, verdict_key, mint, symbol, verdict, confidence,
                 veto_ts, veto_reason, checked_at, hours_elapsed,
                 price_now, price_at_veto, return_since_veto_pct,
                 return_1h_pct, return_6h_pct, return_24h_pct, classification)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    agent, d["key"], mint, prices.get("symbol") or v.get("symbol"),
                    verdict, v.get("confidence"),
                    veto_ts, (v.get("reason") or "")[:500],
                    now_iso, round(hours_elapsed, 2),
                    prices["now"], p_at_veto, ret_since,
                    ret_1h, ret_6h, ret_24h, cls,
                ),
            )
            if con.total_changes:
                inserted += con.total_changes
        except Exception as e:
            print(f"  insert err {mint}: {e}", file=sys.stderr)
        checked += 1

    con.commit()
    con.close()

    print(f"[{now_iso}] checked={checked} inserted={inserted}")


if __name__ == "__main__":
    main()
