# Daily PnL Report — Runbook

How any agent/session generates the daily LP + trade PnL report and stores it in
this repo. The tooling is already committed, so this is just the procedure.

## TL;DR
```bash
# 1. Generate on the server (the runtime data lives there, not in the repo)
ssh -o StrictHostKeyChecking=no -i ~/.ssh/id_ed25519 root@152.53.225.25 \
  'cd /root/meridian && node --env-file=.env scripts/daily-pnl.js'   # add --date YYYY-MM-DD for a past day

# 2. Pull the two generated files into a CLEAN checkout of renakaagusta/meridian
#    (do NOT commit from /root/meridian — it's the dirty runtime dir: .env, state.json, etc.)
D=$(date -u +%F)
ssh -i ~/.ssh/id_ed25519 root@152.53.225.25 "cat /root/meridian/reports/pnl/$D.md"      > reports/pnl/$D.md
ssh -i ~/.ssh/id_ed25519 root@152.53.225.25 "cat /root/meridian/reports/pnl/HISTORY.md" > reports/pnl/HISTORY.md

# 3. Commit
git add reports/pnl/$D.md reports/pnl/HISTORY.md
git commit -m "report: daily PnL $D" && git push
```

## What it produces
- `reports/pnl/<date>.md` — full report: wallet net worth, **period table (1d/3d/7d/all)**,
  LP stack, trade stack, missed opportunities (counterfactual + Birdeye), implementation health.
- `reports/pnl/HISTORY.md` — rolling one-row-per-day table (upserted; safe to re-run).

## Context
- Server (the only place with the data): `152.53.225.25` (`root`, key `~/.ssh/id_ed25519`).
  "Local" = this machine; the data is on the server, so the script runs there.
- Repo: `renakaagusta/meridian` (this is **origin**; `upstream` = yunus-0x/meridian).
- Scripts: `scripts/daily-pnl.js` (report), `scripts/backfill-pnl-history.js` (one-time history seed — already run).
- Wallet: `EZB11yLPaywhRiw1eUmKM8Lxy6oCBQamXXmQ6kwy4CGR`.

## Data sources
- LP realized → `/root/meridian/lessons.json` (closed-position records, timestamped).
- LP open/unrealized → `getMyPositions()`.
- Trade realized → Evonic trader chat.db swaps (`/root/evonic/agents/meridian_trader_*`)
  + a fixed pre-reset baseline (Hunter's pre-2026-06-04 buys live only in
  `/root/evonic/backups/hunter-reset-*/chat.db` — the reset cleared the live db).
- Wallet net worth → RPC (SOL) + Helius/Birdeye (token value).
- Missed opps → latest `benchmark/counterfactual-*.json` (refreshed by a 6h cron + `bench:eval`).
- Health → `decision-traces.jsonl`, Evonic agent dbs + `logs/pm2-out.log`.

## Caveats (already noted in the report body)
- **Wallet USD = liquid SOL + tokens.** Days with open LP positions understate net worth
  (capital is deployed, not liquid). Recent days are flat (0 open) so accurate.
- **Wallet-Δ includes SOL price moves** — for pure trading skill, read the LP-realized and
  trade-net columns; wallet-Δ is bottom-line account value.
- **Trade per-window shows the SOL flow** (approx; ignores cross-window round-trips); the
  pre-reset baseline only appears in the "All" row.
- **Counterfactual** needs traces aged ≥2h; the 6h cron keeps `benchmark/` fresh.

## Optional: live monitors (recreate if a session needs them)
Three persistent monitors were used during the rollout (auto-reconnect SSH tails):
1. Agent errors + real actions — `tail -F /root/evonic/logs/pm2-out.log pm2-error.log | grep -E 'context window exceeds|LLM API error: [0-9]+|MiniMax code|Fallback model|deploy_position|close_position|swap_token executed|trade_open'`
2. Scraper Birdeye failures — `docker logs -f stackbase-scraper | grep -E 'all CDP endpoints failed|could not clear Cloudflare|Birdeye forge returned no data'`
3. Perf pulse — poll `python3 /root/meridian/scripts/perf_pulse.py` every ~10m; emit on change + 2h heartbeat.
