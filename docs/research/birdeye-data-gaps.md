# Birdeye "forge" Data — Gap Analysis

What rich fields/endpoints the keyless Birdeye `forge/*` backend exposes that the
Meridian agent does **not** currently consume.

- **Method for every endpoint:** `POST {SCRAPER_URL}/scrape/birdeye/forge` with body
  `{ path, method, body, ttl }`. The `path` is the `/forge/...` path below; `method`/`body`
  match the real Birdeye call. Response is unwrapped to `data.json` (then `data.result`
  is a JSON string for most forge paths).
- **Sample token:** `Tqj8yFmagrg7oorpQkVGYR52r96RFTamvWfth9bpump` (KINS / Kintara), a
  graduated pump.fun token, ~$1.2M mc, 4754 holders, 13 markets.
- **Source of "USED":** `tools/birdeye.js` (`getBirdeyeVelocity`, `getBirdeyeSecurity`,
  `getBirdeyeGems`, `getBirdeyeOhlcv`) and `tools/external-signals.js` (only
  `getBirdeyeVelocity` is wired into a live agent tool, via `get_dex_velocity` overlay).
  Agents referenced: **Scout** (LP pool screening), **Hunter** (spot entry),
  **Skeptic** (risk veto), **Helm/Hands** (position/exit management).

---

## 1. Executive summary — top unused signals

1. **`overview/token_stats` native 5m / 8h priceChange** — a single GET returns
   `priceChange.{5m,30m,1h,2h,4h,8h,24h}` plus buy/sell vol split, uniqueTraders,
   trade counts, `markets`, and `bondingCurveData`. The native **5m is a simpler,
   atomic replacement for our manual 1m-OHLCV compute5m** (one call vs. an OHLCV fetch
   + client-side reduce). It also gives **8h**, which our overview shaping drops.
2. **Trade tape `amm/v2/txs/token`** — live per-trade stream with `side`
   (buy/sell/add/remove), `volumeUSD`, `owner`, `walletTags` (sniper/insider/fresh),
   per-trade `pnl`, `soldPercentage`, `platform`, and **Meteora LP add/remove events**.
   This is the single highest-value unused source: smart-money confirmation,
   sniper/insider detection, and live LP-flow (other LPs entering/exiting your pool).
3. **`token/holders` live holder list** — ranked owners with `amount`/`owner`/`alias`,
   enabling **live concentration & dump-risk** (top-1 / top-5 share, whale tracking,
   pool-vs-human split) rather than the static `top10_holder_percent`.
4. **`overview/token` 6h/8h/12h windows + history prices** — already fetched, but our
   `VEL_WINDOWS` drops 6h/8h/12h and all `history{N}Price` anchors. Free trend context.
5. **`token/tokensecurity` unused fields** — `top10_user_percent` (humans, **excludes
   pools** — the *real* concentration number), `lock_info`, `pre_market_holder`,
   `transfer_fee_data`, `creator_balance`, `is_true_token`/`fake_token`,
   `metaplex_update_authority`. We only read ~12 of ~40 fields.
6. **`amm/market_lite` multi-market list** — every pool for the token with
   `liquidity` / `volume24h` / `source`. Lets **Scout pick the best venue** and detect
   liquidity fragmentation; today we screen Meteora API only.
7. **`overview/token_verified`** — `jupiterVerified` / `birdeyeVerified` booleans, a
   cheap Skeptic trust gate.
8. **`multichain/amm/large_trade` whale tape** — cross-pool trades >$10k with
   `owner` + `volumeUSD`, a discovery/smart-money feed (note: sample skewed to other
   chains; pass a Solana filter).

---

## 2. Per-endpoint field inventory

### A. `overview/token` — `/forge/solana/overview/token?address=<mint>`  [USED, partially]
Shaped by `shapeOverview` over `VEL_WINDOWS = [30m,1h,2h,4h,24h]`.

| Field group | Status | Notes |
|---|---|---|
| `symbol,name,price,mc,liquidity,holder,securityScore,lastTradeUnixTime` | USED | |
| `priceChange{30m,1h,2h,4h,24h}Percent` | USED | |
| `v/vBuy/vSell{...}USD`, `buy/sell/trade{...}`, `uniqueWallet{...}` + `ChangePercent` | USED | for the 5 windows |
| **`priceChange{6h,8h,12h}Percent`** | **UNUSED** | longer trend; 8h non-null in sample |
| **`v/vBuy/vSell{6h,8h,12h}USD`, `buy/sell/trade{6h,8h,12h}`, `uniqueWallet{6h,8h,12h}`** | **UNUSED** | mid-horizon momentum |
| **`history{30m,1h,2h,4h,6h,8h,12h,24h}Price`** | **UNUSED** | exact anchor prices → derive any custom-window %|
| **`buyHistory{N}` / `sellHistory{N}` / `tradeHistory{N}`** | **UNUSED** | cumulative counts → acceleration |
| **`createdAt`, `numberMarkers`, `numberMarkers`/`daysOver100M`** | **UNUSED** | age + venue count |
| **`extensions.{twitter,website,telegram,...}`** | **UNUSED** | socials inline |

### B. `overview/token_stats` — `/forge/solana/overview/token_stats?address=<mint>&time_frame=24h`  [NEW]
| Field | Sample | Value to agent |
|---|---|---|
| **`priceChange.{5m,30m,1h,2h,4h,8h,24h}`** | 5m=+2.72, 8h=+2.90 | **native 5m & 8h** (see §3a) |
| `markets` | 13 | venue count |
| `holder` | 4754 | |
| `mc,fdv,circulatingSupply,supply,price,priceInNative` | | |
| `uniqueTraders` | 2145 | 24h unique |
| `trade,buy,sell` | 10784/5467/5317 | buy/sell imbalance |
| `volume.{buy,sell,total}` / `volumeUSD.{buy,sell,total}` / `tradeCount.{buy,sell,total}` | | clean split objects |
| `liquidity,source` | 180421, pump.fun | |
| **`bondingCurveData.{complete,percent}`** | true,100 | **graduation state** (Hunter/Skeptic) |
| `creationTime` | 1779471284 | |

### C. `amm/v2/txs/token` — `/forge/solana/amm/v2/txs/token`  [NEW] (live trade tape)
Body parsed at `/tmp/tok/amm_v2_txs_token.body.json`; `data.items[]`, `data.hasNext`.
Per item: `id, txHash, txType, side, volumeUSD, blockUnixTime, slot, address(pool),
owner, signers[], source, platform, walletTags[], pnl, soldPercentage, pricePair,
tokenPrice, mc, from{address,symbol,amount,uiAmount,uiChangeAmount,price,preAmount},
to{...}`.
- `txType ∈ {swap, mint_add_liquidity, burn_remove_liquidity}`; `side ∈ {buy,sell,add,remove}`.
- `platform ∈ {Jupiter, OKX, Dflow, ...}`, `source ∈ {Pump AMM, Meteora Dlmm}`.
- **`walletTags`** — array; documented values sniper/insider/fresh (empty in this mature
  token, populated on fresh launches).
- **`pnl`** — per-trader realized PnL (null here; populated for tracked wallets).
- **`soldPercentage`** — 100 on full exits → capitulation / full-dump detector.
- **Meteora `add`/`remove` rows** — live LP entries/exits *in your pool* with SOL amount.
ALL UNUSED.

### D. `token/holders` — `/forge/solana/token/holders?token=<mint>&offset=0&size=10`  [NEW]
`data.result[]`: `{address, amount, decimals, owner, rank, alias}`. Ranked top holders;
`alias` labels known entities. UNUSED. (We only have aggregate `top10_holder_percent`.)

### E. `token/tokensecurity` — `/forge/solana/token/tokensecurity?token=<mint>`  [USED, partially]
~40 fields; we read ~12. Notable UNUSED:
| Field | Sample | Value |
|---|---|---|
| **`top10_user_percent`** | 0.169 | **top-10 excluding pools** = true human concentration (vs `top10_holder_percent`=0.202 which includes the LP vault) |
| `top10_user_balance` / `top10_holder_balance` | | |
| **`lock_info`** | null | LP/supply lock status |
| **`pre_market_holder`** | [] | snipers/pre-launch wallets |
| **`creator_balance`, `creator_owner_address`** | 0 | creator still holding? |
| **`metaplex_update_authority(_*)`** | null | metadata mutability path |
| **`transfer_fee_data`** | null | actual fee schedule for token-2022 |
| **`is_true_token`, `fake_token`** | null | spoof detection |
| **`creation_tx, creation_slot, mint_tx, mint_time, mint_slot`** | | forensics |
| `jup_strict_list` | true | (also in token_verified) |
| USED already | creator_address, creator_percent, owner_percent, top10_holder_percent, mintable, renounce, mutable_metadata, freeze_able/freeze_authority, non_transferable, transfer_fee_enable, is_token_2022, creation_time |

### F. `amm/market_lite` — `/forge/solana/amm/market_lite?address=<mint>&sort_by=volume24h`  [NEW]
`data.items[]` (14 in sample): `{address(pool), name, source, liquidity, volume24h}`.
Full per-venue liquidity/volume registry. UNUSED.

### G. `account` — `/forge/solana/account?address=<mint>`  [NEW]
`{account, ownerProgram, type(token2022), decimals, supply, network,
extensions[]{kind,authority,metadataAddress}, tokenInfo{...full socials..., supply}}`.
`extensions[].kind` (e.g. MetadataPointer) + `authority` = on-chain token-2022 config.
UNUSED.

### H. `token/meta` — `/forge/solana/token/meta?token=<mint>`  [NEW]
Full socials: `name,symbol,decimals,icon,banner,coingeckoId,coinmarketcapId,website,
twitter,telegram,github,discord,facebook,instagram,medium,substack,tiktok,reddit,
gitlab,bitbucket,whitePaper,description,email,jupStrict`. UNUSED.

### I. `overview/token_verified` — `/forge/solana/overview/token_verified?address=<mint>`  [NEW]
`{jupiterVerified, birdeyeVerified}`. UNUSED. Tiny, cheap trust gate.

### J. `token/total_holder` — `/forge/solana/token/total_holder?address=<mint>`  [NEW]
`{total}` (4754). Exact live holder count. UNUSED.

### K. `token/total_security_issues` — `/forge/solana/token/total_security_issues?token=<mint>`  [NEW]
`{total}` (1). Count of flagged security issues. UNUSED.

### L. `v2/trending/token` — `/forge/solana/v2/trending/token`  [NEW]
`data.items[]`: `{token, price, liquidity, network, realMc, createdAt, trendingScore,
tokenData{name,symbol,decimals,icon,website,jupStrict},
tf24h{priceChangePercent,volumeUSD,volumeChangePercent,tradeCount},
tf1h.priceChangePercent, tf4h.priceChangePercent}`. Solana-native trending +
`trendingScore`. UNUSED (we use multichain `v3/gems`).

### M. `multichain/amm/large_trade`  [NEW]
`data.items[]`: `{txHash, volumeUSD, owner, network, networkInfo{...}, from{...}, to{...},
blockUnixTime}`. Whale trades >$10k across chains. UNUSED. (Sample dominated by
hyperevm/bsc — needs a Solana filter param.)

### N. `multichain/v2/trending/token`, `multichain/v2/gems/top_tokens`, `cex_top_market`, `multichain/amm/all`  [NEW]
- `multichain/v2/trending/token`: as (L) but cross-chain, adds `tf24h.viewCount`.
- `multichain/v2/gems/top_tokens`: `{symbol,address,name,network,price,logoURI,jupStrict,
  tf24h{volumeUSD,volumeChangePercent,priceChangePercent}}` (top by 24h vol; SOL/majors).
- `cex_top_market`: CEX-listed majors `{symbol,name,cid,network,address,price,marketCap,
  liquidity,priceChange24hPercent}` — macro/BTC-beta context.
- `multichain/amm/all`: chain/DEX registry `{source,website,icon,token_address,symbol,summary}`.
All UNUSED; mostly low-priority for a Solana DLMM bot.

---

## 3. Specific call-outs

### (a) Native 5m / 8h vs. our manual OHLCV-computed 5m
`overview/token_stats` returns `priceChange.5m` and `priceChange.8h` directly in one GET.
Today `getBirdeyeVelocity` computes 5m via `compute5m()`, which fetches `amm/ohlcv_v2`
at `res=1m,count=6` and reduces client-side — **an extra network round-trip + arithmetic
that can return null** when <2 valid candles. **token_stats is the simpler/better 5m
source** for the price-change number (atomic, no candle gaps), and it adds 8h, buy/sell
volume split, uniqueTraders, and bonding-curve state in the same call. Caveat:
token_stats gives 5m *price change* only; our compute5m also yields a 5m *volume_usd*,
which token_stats does not expose at 5m granularity — so keep OHLCV if 5m volume is
needed, but prefer token_stats for the 5m/8h % moves. Recommend: fetch token_stats in
`getBirdeyeVelocity`, use its native 5m/8h, and drop the compute5m round-trip unless 5m
volume is explicitly required.

### (b) `walletTags` + per-trade `pnl` (sniper / insider / smart-money)
The `amm/v2/txs/token` tape carries `walletTags` (sniper/insider/fresh) and per-trade
`pnl` and `owner`. On fresh launches this enables: **Skeptic** veto when early buyers are
tagged sniper/insider or concentrated in few `owner`s; **Hunter** confirmation when
tagged profitable/smart wallets are net buying. Cross-referencing `owner` against
`smart-wallets.json` gives live smart-money confirmation per pool. `soldPercentage:100`
rows flag full-exit capitulation. The Meteora `add`/`remove` rows let **Helm/Hands** see
other LPs entering/leaving the same pool in real time.

### (c) Holder-list concentration as a live dump-risk signal
`token/holders` returns ranked owners with `amount`. Computing top-1 / top-5 share (and
filtering out the pool vault `owner` via `amm/market_lite` pool addresses) gives a **live**
concentration read that updates as whales accumulate or distribute — strictly better than
the static `top10_holder_percent` snapshot. Pair with `top10_user_percent` from
tokensecurity (humans, pools excluded) as the canonical concentration metric for the
Skeptic dump-risk veto.

---

## 4. Prioritized GAP table

| Pri | Endpoint (path, method) | Key params | Adds (fields) | Improves | Why it matters |
|---|---|---|---|---|---|
| P0 | `overview/token_stats` GET | `address`, `time_frame` | native `priceChange.5m/8h`, buy/sell vol split, `uniqueTraders`, `bondingCurveData`, `markets` | Hunter, Scout, Helm | Atomic 5m/8h (no OHLCV round-trip), graduation state, clean buy/sell imbalance |
| P0 | `amm/v2/txs/token` GET | token/pool addr | `side`, `volumeUSD`, `owner`, `walletTags`, `pnl`, `soldPercentage`, Meteora add/remove | Skeptic, Hunter, Helm/Hands | Sniper/insider detection, smart-money confirmation, live LP-flow + capitulation |
| P0 | `token/holders` GET | `token`, `offset`, `size` | ranked `owner/amount/alias` | Skeptic, Helm | Live top-1/top-5 concentration → real-time dump-risk |
| P1 | `token/tokensecurity` (extra fields) GET | `token` | `top10_user_percent`, `lock_info`, `pre_market_holder`, `creator_balance`, `transfer_fee_data`, `is_true_token` | Skeptic | True human concentration (pools excluded), LP-lock, pre-launch snipers |
| P1 | `overview/token` 6h/8h/12h + `history{N}Price` GET | `address` | longer windows + anchor prices + cumulative counts | Scout, Hunter | Free mid-horizon trend; already fetching this body |
| P1 | `amm/market_lite` GET | `address`, `sort_by=volume24h` | per-pool `liquidity/volume24h/source` (all markets) | Scout | Pick best venue; detect liquidity fragmentation |
| P2 | `overview/token_verified` GET | `address` | `jupiterVerified`, `birdeyeVerified` | Skeptic | Cheap trust gate |
| P2 | `token/total_holder` GET | `address` | exact `total` | Scout, Skeptic | Precise live holder count + growth |
| P2 | `account` GET | `address` | token-2022 `extensions[].kind/authority`, ownerProgram | Skeptic | Deep token-2022 config (transfer-hook/fee authority) |
| P2 | `token/meta` GET | `token` | full socials | Scout, Skeptic | Social presence as legitimacy signal |
| P3 | `v2/trending/token` GET | — | Solana trending + `trendingScore` | Scout, Hunter | Solana-native discovery (vs multichain gems) |
| P3 | `multichain/amm/large_trade` GET | (needs SOL filter) | whale trades >$10k + `owner` | Hunter | Cross-pool whale/smart-money discovery |
| P3 | `token/total_security_issues` GET | `token` | issue `total` | Skeptic | One-number risk pre-filter |
| P4 | `multichain/v2/gems/top_tokens`, `cex_top_market`, `multichain/amm/all` | — | majors/CEX/registry | — | Macro/registry context; low value for SOL DLMM |
