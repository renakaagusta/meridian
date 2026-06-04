# Keyless Data Enrichment — Implementation Notes (#19 #20 #21)

Shipped to the **production server runtime** (`/root/meridian` + `/root/evonic`) and the
**stackbase scraper** (deployed to the NUC) on 2026-06-04. This file documents every change so
it can be consolidated back into clean repo branches (the server `main` is a dirty runtime —
see the branch-fragmentation note).

## Status: LIVE & TESTED end-to-end

- Scraper `POST /scrape/gmgn` — deployed via stackbase PR #232 (merged to main, CI green).
- 6 new Meridian tools — CLI + Evonic bridge verified returning real data.
- Hunter 5m-floor → liveness gate — applied, Evonic restarted clean.

---

## #20 — stackbase scraper (COMMITTED to renakaagusta/stackbase, PR #232)

- `apps/scraper/src/scrapers/providers/gmgn/web.ts` — new GMGN website-API fetcher. Mirrors
  `birdeye/forge.ts`: residential CDP warm tab, but harvests GMGN's session/device params
  (`device_id`/`fp_did`/`client_id`/`app_ver`) from the warm tab's `performance` resource
  entries (localStorage fallback for the two device ids). No per-request signature; daily
  build-string rotation handled. `gmgnWeb(path, {method, body})` — path restricted to
  `/api/`,`/vas/`,`/defi/`.
- `apps/scraper/src/index.ts` — `POST /scrape/gmgn` route (path/method/body/ttl). Trading
  data → **no cache by default** (ttl 0).

## #19 — Birdeye tools (server `/root/meridian`, NOT yet in repo birdeye.js/cli.js)

`tools/birdeye.js` — three new exports (self-contained, use existing `birdeyeForge`):
- `getBirdeyeTokenStats({mint, timeframe})` → `overview/token_stats`: **native price_change
  {5m,30m,1h,2h,4h,8h,24h}** + buy/sell split + uniqueTraders + markets + liquidity + launchpad
  + pump.fun bonding-curve. The multi-TF liveness read.
- `getBirdeyeHolders({mint, size})` → `token/holders`: ranked owner/rank/ui_amount/alias.
- `getBirdeyeMarkets({mint})` → `amm/market_lite`: per-pool name/source/liquidity/volume24h.

`cli.js` — subcommands `birdeye-token-stats`, `birdeye-holders`, `birdeye-markets` (+ `size`
flag). (Trade-tape `amm/v2/txs/token` deferred — POST body needs reverse-engineering; GMGN
`token_wallet_tags_stat` covers the walletTags/cohort need.)

## #20 — GMGN tools (server `/root/meridian/tools/gmgn.js` — committed in THIS branch)

`tools/gmgn.js` — mirrors `birdeye.js`'s scraper-fetch pattern against `POST /scrape/gmgn`:
- `getGmgnWalletTags({mint})` → cohort counts (smart/renowned/fresh/sniper/bundler/creator/
  rat_trader/whale/top/following).
- `getGmgnTopBuyers({mint})` → early-buyer dump status (sold/holding_rate/bought_rate/
  top10_holder_rate/top70 sniper hold rate/smart-money positions).
- `getGmgnPoolFee({mint})` → per-pool fee config (incl. Meteora DAMM v2 / virtual-curve).

`cli.js` — subcommands `gmgn-wallet-tags`, `gmgn-top-buyers`, `gmgn-pool-fee`.

### Evonic registration (server `/root/evonic/skills/meridian`)
For all 6 tools: entry in `tools.json` (now 45 tools), argv mapping in
`backend/tools/_lib.py`, handler `backend/tools/get_<tool>.py`, and `agent_tools` DB rows
assigning each to: `meridian_{challenger, general, screener, trader_challenger,
trader_manager, trader_screener}`.

## #21 — Hunter 5m-floor → multi-TF liveness gate (server `/root/evonic/agents/meridian_trader_screener/SYSTEM.md`)

- Removed the `## CRITICAL — 5m volume hard floor` section.
- Added `## CRITICAL — Multi-timeframe liveness gate`: trust `get_birdeye_token_stats` native
  5m/8h + `get_gmgn_wallet_tags` cohorts; hard-SKIP only if genuinely dead
  (`liquidity < $20k` OR (`1h vol < $10k` AND `5m vol < $1k` AND no fresh 1m)); quiet 5m =
  CONCERN not SKIP (Skeptic's 0.80 floor adjudicates); anti-fabrication = >3× source
  disagreement / dexscreener-fallback only.
- Deduped the doubled `## CRITICAL — Pre-Skeptic signal floor` block.
- Downside bounded by Hands' existing hard stop (-15%) — the #8 dependency is satisfied on the
  spot side.

## Consolidation TODO
The server `/root/meridian` is a dirty `main` carrying prior uncommitted work (momentum
candidates, agent-health, notify, etc.). `tools/birdeye.js` and `cli.js` additions above are
mixed into that runtime. To bring into the repo cleanly, reconcile the server runtime → repo
(the standing branch-fragmentation effort), then drop these additions onto the consolidated
`tools/birdeye.js` / `cli.js`. `tools/gmgn.js` is standalone and committed here.
