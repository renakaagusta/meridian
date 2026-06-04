# GMGN Data Gaps — Research Report

Date: 2026-06-04
Goal: enumerate GMGN token/trading data for a Solana DLMM + spot-trading agent; compare
against what the Evonic server already consumes; prioritize unused high-value signals.

Two distinct GMGN surfaces exist:

1. **Official OpenAPI** (`https://openapi.gmgn.ai`) — signed, API-key gated. **This is what
   the server currently uses** via the `gmgn-cli` npm package.
2. **Website internal API** (`https://gmgn.ai/{api,vas,defi/quotation,trs,mrwapi}/v1/...`) —
   Cloudflare-gated, no API key, powers gmgn.ai itself. **We do NOT use this.** It is much
   richer than the OpenAPI (this is where the wallet-tag breakdowns, sniper/insider/bundler
   counts, top-buyer status, dev fund-source, rug-vote, ATH, etc. live).

---

## Section 1 — Endpoints we currently use (Evonic server)

GMGN is NOT in the local `cuskeel` repo. The server (`152.53.225.25`) wraps the **official
GMGN OpenAPI CLI**. Each Python tool in `/root/evonic/skills/gmgn/backend/tools/` shells out
to `gmgn-cli` (`/root/.local/share/mise/.../node_modules/gmgn-cli`), authed with
`GMGN_API_KEY` from `/root/.config/gmgn/.env`. Base URL: `https://openapi.gmgn.ai`.

| Evonic tool | gmgn-cli command | OpenAPI path |
|---|---|---|
| `gmgn_trending` | `market trending --interval --limit` | `/v1/market/rank` |
| `gmgn_token_info` | `token info` | `/v1/token/info` |
| `gmgn_token_security` | `token security` | `/v1/token/security` |
| `gmgn_token_holders` | `token holders` | `/v1/market/token_top_holders` |
| `gmgn_token_traders` | `token traders` | `/v1/market/token_top_traders` |
| `gmgn_kol_trades` | `track kol` | `/v1/user/kol` |
| `gmgn_smart_money_trades` | `track smartmoney` | `/v1/user/smartmoney` |

Full set of OpenAPI paths the CLI exposes (only the 7 above are wired into Evonic tools):
`/v1/market/{rank,token_kline,token_signal,token_top_holders,token_top_traders}`,
`/v1/token/{info,pool_info,security,portfolio}`,
`/v1/user/{info,kol,smartmoney,created_tokens,wallet_activity,wallet_holdings,wallet_stats,wallet_token_balance}`,
`/v1/trade/{quote,swap,multi_swap,gas_price,follow_wallet,query_order,strategy/*}`,
`/v1/trenches`, `/v1/cooking/*`.

**Currently unused even within the OpenAPI we already pay for:** `token_signal` (buy/sell
signal feed), `token_kline`, `token/pool_info`, `user/wallet_stats` (per-wallet PnL/winrate),
`trenches` (new-pair feed). These need no new auth — just CLI flags.

The local `cuskeel` repo only reads pre-computed fallback fields produced upstream:
`gmgn_smart_wallets`, `gmgn_total_fee_sol`, `gmgn_top10_holder_pct`, `gmgn_bot_degen_pct`.

---

## Section 2 — GMGN website internal API (discovered live, no API key)

All captured live from gmgn.ai page XHR with the CDP browser (Cloudflare-cleared profile).
Sample token: `peg` (`3GDrBbgzMfokcYChDqBZijXS3ppwhEEmosFQbgbPpump`). All return
`{code:0, message/msg:"success", data:{...}}`.

### 2.1 `POST /trs/api/v1/trending_rank/sol/{interval}` — trending list
One compact row per token. Many fields we do not currently surface. Key fields (abbreviated keys):

| key | meaning | sample |
|---|---|---|
| `a`,`s`,`nm` | mint, symbol, name | BOOCAT |
| `p`,`pcp1m/5m/1h` | price, % change 1m/5m/1h | -38.0398 (5m) |
| `v`,`lq`,`mc`,`hhmc` | volume, liquidity, mcap, ATH-mcap | 310996 / 586607 |
| `ilq` | initial liquidity | 683.53 |
| `t10` | top-10 holder rate | 0.8397 |
| `sw`,`bu`,`se`,`hd` | swaps, buys, sells, holders | 30630/16062/14568/2087 |
| `snp`,`smt`,`kol` | sniper / smart-money / KOL counts | 0/0/0 |
| `bdc`,`bdr`,`bdrr` | bot-degen count/rate, bundler rate | 10 / 0.837 / 0.101 |
| `t70_shr` | top-70 sniper hold rate | 0 |
| `rat`,`etpr` | rat-trader %, entrapment-trader % | 0 |
| `d_ct`,`d_ts`,`cc` | dev wallet, dev status (`creator_close`), CTO flag | |
| `s_nm`,`s_blk`,`s_brs` | mint renounced, freeze renounced, burn status | 1/1/"none" |
| `rug`,`hl` | rug flag, honeypot-ish level | 0 / 3 |
| `gf` | "god flag"/score-ish gauge | 0.1729 |
| `img_dup` | duplicate-logo count (copycat signal) | "6" |
| `dx_ad`,`dx_ul`,`dx_bf`,`dx_tb` | DexScreener paid: ad / updated-link / boost / trending-bar | |
| `xcf`,`xcc`,`m_xctc` | twitter changed-flag, create-count, x-create-token-count | |
| `ot`,`ct` | open ts, create ts | |

### 2.2 `GET /api/v1/token_stat/sol/{mint}` — concentration & trader-quality stats
```
holder_count 638 · bluechip_owner_count 0 · bluechip_owner_percentage "0"
signal_count 0 · degen_call_count 0
top_rat_trader_percentage "0.0018" · top_bundler_trader_percentage "0.1833"
top_entrapment_trader_percentage "0.0237" · top_bot_degen_percentage "0.5459"
creator_created_count 137 · bot_degen_count 322 · bot_degen_rate "0.5459"
fresh_wallet_rate "0.0794" · top_10_holder_rate "0.231"
dev_team_hold_rate "0" · creator_hold_rate "0" · creator_token_balance "0"
private_vault_hold_rate "0.0078" · top70_sniper_hold_rate "0"
```

### 2.3 `GET /api/v1/mutil_window_token_security_launchpad/sol/{mint}` — security + launchpad
`security{}`: `top_10_holder_rate`, `renounced_mint` (bool), `renounced_freeze_account` (bool),
`burn_ratio` "1", `burn_status` "burn", `dev_token_burn_amount/ratio`, `is_open_source`,
`is_blacklist`, `is_honeypot`, `can_sell`/`can_not_sell`, `buy_tax`/`sell_tax`/`average_tax`/`high_tax`,
`flags[]`, `lock_summary{is_locked, lock_detail[{percent,pool,is_blackhole}], lock_percent}`,
`hide_risk`. `launchpad{}`: `launchpad` "pump", `launchpad_status`, `launchpad_progress` "1",
`launchpad_platform` "Pump.fun", `migrated_pool_exchange` "pump_amm", `launch_quote_address`.

### 2.4 `GET /api/v1/token_wallet_tags_stat/sol/{mint}` — wallet-cohort COUNTS (alert-bot data)
```
smart_wallets 4 · fresh_wallets 201 · renowned_wallets 3 · creator_wallets 1
sniper_wallets 6 · rat_trader_wallets 0 · whale_wallets 0 · top_wallets 48
following_wallets 0 · bundler_wallets 189
```

### 2.5 `GET /vas/api/v1/token_holder_stat/sol/{mint}` — holder-cohort COUNTS (variant of 2.4)
```
smart_degen_count 4 · renowned_count 3 · fresh_wallet_count 200 · dex_bot_count 853
insider_count 2 · following_count 0 · dev_count 4 · bluechip_owner_count 6
bundler_count 185 · sniper_count 12
```
(2.4 and 2.5 overlap; 2.5 adds `insider_count` and `dex_bot_count`.)

### 2.6 `GET /defi/quotation/v1/tokens/top_buyers/sol/{mint}` — early-buyer behaviour
`holders.statusNow{ hold, bought_more, sold_part, sold, transfered, bought_rate "0.563",
holding_rate "0.0129", smart_pos[ranks of smart buyers], top_10_holder_rate }`,
`top70_sniper_hold_rate`, plus `holderInfo[]` per early buyer:
`{status: hold|sold|sold_part|bought_more|transfered, wallet_address, tags[], maker_token_tags[("sniper")]}`.
→ Tells you how many of the first 70 buyers already dumped (here 67/70 sold).

### 2.7 `POST /api/v1/mutil_window_token_info` — full token + pool + dev profile
Token: `address,symbol,name,decimals,logo,banner,biggest_pool_address,open_timestamp,
migrated_timestamp,holder_count,circulating_supply,total_supply,max_supply,liquidity,creation_timestamp`.
`pool{}`: `pool_address,quote_address,quote_symbol,liquidity,base_reserve,quote_reserve,
initial_liquidity,initial_base/quote_reserve,base/quote_reserve_value,exchange "pump_amm",fee_ratio`.
`dev{}`: `creator_address`, `creator_token_balance`, `creator_token_status` "creator_close",
`top_10_holder_rate`, `cto_flag`, `twitter_name_change_history[]`, `twitter_del_post_token_count`,
`twitter_create_token_count`, `fund_from` + `fund_from_ts` (where dev was funded — sybil signal),
DexScreener paid-promo fields (`dexscr_ad`, `dexscr_update_link`, `dexscr_boost_fee`, `dexscr_trending_bar` + ts).

### 2.8 `GET /api/v1/token_pool_fee_info/sol/{mint}` — per-pool fee config (DLMM-relevant)
`list[]{ address, exchange "Pump AMM", liquidity, fee_ratio 0.011, is_dynamic_fee (bool),
pool_type, meteora_virtual_curve_fee_config, meteora_damm_v2_base_fee_config, fee_params }`.
→ Has explicit **Meteora** fee-config slots (DAMM v2 base fee, virtual-curve fee).

### 2.9 `GET /vas/api/v1/token_holders/sol/{mint}` — ranked holders w/ per-wallet PnL & tags
Per holder: `account_address, addr_type, exchange, balance, usd_value, amount_percentage,
wallet_tag_v2 ("TOP1"), profit, realized_profit, unrealized_profit, avg_cost, avg_sold,
buy/sell_volume_cur, netflow_usd, transfer_in (bool), is_new, is_suspicious, is_on_curve,
start_holding_at, last_active_timestamp, native_transfer`.

### 2.10 `GET /defi/quotation/v1/smartmoney/sol/wallet/{wallet}` — wallet scorecard
`realized_profit, pnl, pnl_1d/7d/30d, realized_profit_1d/7d/30d, winrate, all_pnl,
total_profit, buy/sell_1d/7d/30d, sol_balance, last_active_timestamp, tags[("axiom")],
followers_count, is_contract, avg_holding_peroid`. → Per-wallet quality score for any KOL/buyer.

### 2.11 `GET /api/v1/mutil_window_token_link_rug_vote/sol/{mint}` — socials + rug history + vote
`link{ twitter_username, website, telegram, discord, github, ... , verify_status }`,
`rug{ rug_ratio "0.068", holder_rugged_num, holder_token_num, rugged_tokens[] }` (how often
holders of this token got rugged before), `vote{ like, unlike }`.

### 2.12 `GET /api/v1/ath_info/sol/{wallet}` — dev's best previous launch
`ath_token, ath_mc "196018.38", token{address,symbol,name,creation_timestamp}`.
→ The dev's prior all-time-high token (track record).

### Other live endpoints observed (lower priority)
`token_mcap_candles` (OHLC for mcap chart), `token_fee_distribution`, `vas/.../similar_coin`
(copycats), `recommend_slippage`, `native_transfer/{wallet}` (dev funding trail),
`vas/api/v1/token_trades/{mint}` (live trade tape), `vas/api/v1/batch_handler` (batched),
`logo/logo_dup_detail` (logo-copycat), `live/token_preview`, `gas_price_list`, `dex_trades_polling`.

---

## Section 3 — GAP: prioritized unused high-value signals

Each tagged with the decision it improves: **LP** (DLMM screening), **SPOT** (spot entry),
**VETO** (risk veto), **EXIT** (exit/management).

### Tier 1 — adopt now (cheap, decisive)

1. **`token_wallet_tags_stat` / `token_holder_stat` cohort counts** — VETO, SPOT, LP.
   `sniper_wallets`, `bundler_wallets`, `insider_count`, `fresh_wallets`, `dex_bot_count`,
   `smart_wallets`, `whale_wallets`. We currently only get a coarse `gmgn_bot_degen_pct` and a
   smart-wallet list. Raw counts of snipers/bundlers/insiders are the single most predictive
   rug/dump filter and replace our heuristic bundler detection in `token.js`. **Free, keyless.**

2. **`top_buyers` early-buyer status** — EXIT, SPOT. `statusNow{sold, sold_part, hold}` and
   `bought_rate`/`holding_rate` tell you how many of the first 70 buyers already dumped (67/70
   in sample). A high already-sold rate = exhausted demand → veto entry / exit early. We have
   nothing equivalent today.

3. **`token_stat` concentration suite** — LP, VETO. `top70_sniper_hold_rate`,
   `private_vault_hold_rate`, `dev_team_hold_rate`, `creator_hold_rate`, `fresh_wallet_rate`,
   `top_entrapment_trader_percentage`, `top_rat_trader_percentage`. Richer than our single
   `gmgn_top10_holder_pct`. `top70_sniper_hold_rate` directly predicts dump overhang for LP.

4. **`token_pool_fee_info` Meteora fee config** — LP. `is_dynamic_fee`,
   `meteora_damm_v2_base_fee_config`, `meteora_virtual_curve_fee_config`, `fee_ratio`. Directly
   relevant to our DLMM fee/TVL screening; lets us read pool fee economics without our own SDK call.

5. **`market/token_signal` (OpenAPI — already paid for)** — SPOT, EXIT. A buy/sell signal feed
   we have CLI access to but never wired up. `token_stat.signal_count`/`degen_call_count`
   corroborate it. **Zero new auth — just add an Evonic tool.**

### Tier 2 — high value, slightly more work

6. **`mutil_window_token_info.dev` fund-source & history** — VETO. `fund_from` + `fund_from_ts`
   (who funded the dev — shared funder = sybil/serial-rugger), `twitter_name_change_history`,
   `twitter_create_token_count`, `cto_flag`. Strong serial-scammer detector.

7. **`ath_info` (dev track record)** — SPOT, VETO. The dev's prior best launch mcap. A dev
   whose previous tokens all died sub-$50k is a different bet than one with a $1M+ ATH.

8. **`smartmoney/wallet/{wallet}` scorecard + `user/wallet_stats` (OpenAPI)** — SPOT. Per-wallet
   `winrate`, `pnl_7d/30d`, `tags`. Lets us weight smart-money presence by *quality* instead of
   just counting wallets, and validate KOL signals before following.

9. **`token_link_rug_vote.rug`** — VETO. `rug_ratio` / `rugged_tokens[]` — historical rug
   exposure of this token's holder base. Cheap reputational veto.

10. **`security_launchpad.lock_summary` + burn fields** — LP, VETO. `is_locked`, `lock_percent`,
    `is_blackhole`, `burn_status`, `renounced_mint/freeze`, tax fields. Cleaner authority/lock
    read than scattering across multiple SDK calls.

### Tier 3 — opportunistic

11. **`trending_rank` rich row** (`pcp5m`, `img_dup`, `gf`, `dx_*` paid-promo flags, `etpr`) —
    LP/SPOT screening prefilter; `img_dup` (copycat logo) and `dx_boost`/`dx_trending_bar`
    (paid promo = often exit-liquidity) are useful negative signals.
12. **`trenches` / `token_kline`** (OpenAPI, already paid) — new-pair discovery + OHLC without
    a separate data source.
13. **`vas/token_holders` per-wallet PnL/`is_suspicious`/`is_on_curve`** — EXIT; granular but heavier.

---

## Cloudflare / access notes — CORRECTED (verified 2026-06-04)

> An earlier draft of this section claimed the website API returns 429 to scripted
> same-origin `fetch()` and must be read from organic XHR. **That was wrong** — the 429 was
> caused by calling the endpoint *without the required device params*, not by `fetch` itself.

**Verified working pattern (identical to the existing Birdeye `cdpFetch` scraper):**

1. Warm a tab on `https://gmgn.ai/?chain=sol` (Cloudflare challenge clears during nav, same as
   Birdeye). On first visit GMGN's JS mints and persists the session identity in **localStorage**:
   - `localStorage["key_device_id"]`  → `device_id`
   - `localStorage["key_fp_did"]`     → `fp_did`
2. Read those two, plus the build string `client_id` / `app_ver` (`gmgn_web_<date>-<build>`,
   available on any organic request or a page global).
3. In-page `fetch(path + '?' + params, {credentials:'include'})` where `params` =
   `device_id, fp_did, client_id, from_app=gmgn, app_ver, tz_name, tz_offset, app_lang, os=web`.
   **There is NO per-request signature** — the params are session-stable, so one warm tab can
   fetch ANY endpoint for ANY mint.

**Proven:** in-page fetch of `gas_price_list` → 200; and `token_wallet_tags_stat/sol/<mintA>`
captured for one token, then re-fetched with the **mint swapped to a different token** + reused
params → **200** with full cohort payload (`smart_wallets, fresh_wallets, sniper_wallets,
whale_wallets, …`). So GMGN drops onto the existing NUC real-browser scraper as a new provider
module — no new infra, no organic-XHR-replay needed.

- No hard 403/challenge page was hit (profile was CF-cleared). The real Chrome + residential
  exit on the NUC is what clears CF, exactly as for Birdeye forge.
- The **official OpenAPI** (`openapi.gmgn.ai`, what we already use) is the clean path but is a
  strict subset: it lacks the cohort counts (sniper/bundler/insider), top-buyer status,
  dev fund-source, rug-vote, and `img_dup` that only the website API exposes.
