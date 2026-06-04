# 5m Volume Floor → Multi-Timeframe Liveness (Hunter)

**Status:** Proposed · **Owner:** Hunter (`meridian_trader_screener`) · **Date:** 2026-06-04
**Depends on:** #8 (hard spot stop-loss) — see *Hard dependency* below.

---

## Problem

Hunter's SYSTEM.md (added 2026-06-02) enforces a **$5,000 hard 5m-volume floor**:

> `## CRITICAL — 5m volume hard floor`
> If `volume_5m_usd < 5000` on a candidate, do NOT propose to Skeptic. Mark SKIP with
> `primary_reason="5m volume $X below $5K floor"`.
> Why: 5m signals on sub-$5K volume are unreliable — the RICH cycle on 2026-06-02 flagged
> this as a concern but proposed anyway; Skeptic VETOed at 1.0 because the underlying 5m
> data was **fabricated** (buys 0→92.9% claimed, price direction inverted, volume 9× overstated).

The floor was a **band-aid for fabricated 5m data** from the old aggregator. That root cause
is now fixed: `get_dex_velocity` overlays **`birdeye_velocity`** (true 5m computed from
on-chain 1m OHLCV, `velocity_source: "birdeye"`). On-chain candles can't be fabricated the
way the aggregator was.

## Evidence (data-driven, not asserted)

Forward returns of 5 tokens Hunter HARD-skipped on the $5K floor, measured from the
rejection timestamp via Birdeye `ohlcv_v2 res=15m`:

| Token  | 5m vol @ skip | peak +6h | low +6h | peak +24h | close +24h |
|--------|--------------:|---------:|--------:|----------:|-----------:|
| KINS   |        $525   |   +27%   |  −14%   |    +87%   |    +39%    |
| JARS   |        $530   |   +46%   |  −15%   |    +51%   |    −22%    |
| three  |         $67   |    +9%   |  −22%   |   +107%   |    +89%    |
| WLM    |        $650   |   +48%   |  −24%   |   +407%   |   +106%    |
| Magpie |       $3011   |   +29%   |  −53%   |    +30%   |    +19%    |

**Conclusion:** the rule is over-strict — **5/5 ran +27–48% peak6h, +30–407% peak24h.**
**Caveat:** all had a **−14% to −53% drawdown first** → loosening entry *requires* a hard stop.

---

## Decision: combine (a) + (b) into one rule

(a) and (b) are not alternatives — they're two halves of the same fix, and either alone
leaves a hole:

- **(a) alone:** you trust the accurate Birdeye 5m, but the `$5K` hard floor still fires →
  the trust is moot and grail still gets skipped.
- **(b) alone:** you loosen the gate, but on the dexscreener *fallback* (Birdeye down) you've
  removed the only guard against the fabricated data the floor originally caught.

So they ship together as **one unified rule** (below). The "support shorter timeframes"
requirement reframes it further: the right abstraction is not a *5m volume floor* but a
**multi-timeframe liveness read**.

## Unified rule — multi-timeframe liveness (replaces the $5K 5m floor)

**Data:** Birdeye `amm/ohlcv_v2` gives accurate `1s / 5s / 1m / 5m / 15m`; the overview gives
`30m / 1h / 2h / 4h / 24h`. All on-chain → not fabrication-prone the way the old aggregator was.

**Timeframe division of labor:**

| Timeframe | Role |
|-----------|------|
| `1m`      | earliest burst / entry timing (catches a move before 5m prints) |
| `5m`      | base liveness read (current rule's window) |
| `1h`      | trend confirmation (alive vs dead, not just a momentary lull) |
| liquidity | tradability (slippage both ways) |

**The rule:**

1. **Trust on-chain data; scope fallback caution.**
   - `velocity_source == "birdeye"` → trust the multi-TF read regardless of any single
     window's dollar volume (real swaps from OHLCV). No hard-skip on a thin 5m.
   - `velocity_source == "dexscreener"` (Birdeye down) → keep the old caution: thin/low-vol =
     low-confidence; verify before proposing. *(Fabrication guard survives exactly where needed.)*
2. **Liveness gate (replaces `5m < $5K → SKIP`).** Hard-SKIP for thinness only if the token is
   *genuinely dead across short TFs AND illiquid/quiet on 1h*:
   - liquidity `< $20K` (already a hard rule), **OR**
   - `1h vol < $10K` **AND** `5m vol < $1K` **AND** `1m` shows no fresh activity (no print/buys).
   A token alive on **any** of {`1m`, `5m`} **or** with `≥$20K liq` + `≥$10K 1h vol` passes —
   that's the grail case ($120K liq, $28K 1h, quiet $357 5m).
3. **Demote thin-5m from hard-SKIP to an advisory "concern"** to Skeptic with lower conviction
   — let Skeptic's 0.80 floor adjudicate, not Hunter pre-killing it.
4. **Replace the volume-proxy with a real anomaly check** — flag genuine fabrication only when
   two sources disagree **>3×** (the actual RICH symptom).
5. **Config-tunable thresholds** (liq floor, 1h-vol floor, short-TF activity) so we tighten/
   loosen from data; optionally enforce the same pre-qualification in `getMomentumCandidates`
   (`tools/birdeye.js`, already takes `min_tvl` / `min_volume`).

**Data plumbing for shorter TFs:** `get_dex_velocity` currently surfaces `birdeye_velocity.5m`
(computed from `res=1m` OHLCV) + 30m/1h/… from the overview. To expose `1m` as its own field,
add a `birdeye_velocity.1m` from the same OHLCV pull (last candle) — no extra fetch. (5s/15m
are available too but 1m+5m+1h is the useful set for Hunter.)

**Net:** removes the false-positive floor; keeps fabrication protection scoped to the
fallback path; gives Hunter earlier (1m) and confirmatory (1h) signal instead of one brittle
5m dollar threshold.

---

## Hard dependency — #8 spot stop-loss

The runners had **−14% to −53% drawdowns before the runup.** Loosening entry without a
spot-side hard stop means we trade more runners *and eat the drawdowns*.
**Do not ship (a)/(b) without #8 in place.**

## Validation

1. **Backtest first** — run the forward-return harness over a *larger* set of past 5m-floor
   rejections to confirm the +EV holds beyond the 5/5 sample before changing anything.
   (Harness: `ohlcv_v2 res=15m` from rejection ts → peak/low/close at +6h/+24h.)
2. **Then measure** — after the change:
   - counterfactual `spot_missed` should **drop** (fewer clean runners skipped),
   - realized spot PnL should **improve net of drawdown** (daily-pnl report),
   - watch Hunter's Skeptic-**VETO rate** (the original "wasted cycles" worry) — with accurate
     data it should fall, not rise.

## Rollout

- Both are **Hunter SYSTEM.md edits** (`/root/evonic/agents/meridian_trader_screener/SYSTEM.md`)
  — no Meridian code change required.
- Backup SYSTEM.md (`.bak`), apply edits, **restart Evonic** to reload the prompt.
- While editing, **dedupe** the copy-pasted "Pre-Skeptic signal floor" block (it appears twice).
- **Start conservative:** ship the demote-to-concern + liveness gate first (reversible —
  Skeptic still gatekeeps), watch a day, then add the `1m`-burst path and relax further if the
  data supports it.

## Risks

| Risk | Mitigation |
|------|------------|
| Looser entry → more drawdown exposure | #8 hard stop (hard dependency) |
| Small sample (5 tokens) | Backtest larger set first; ship conservative variant |
| Birdeye path degrades → stale 5m | Plan (a) keeps dexscreener-fallback caution intact |
| More cycles to Skeptic | Skeptic 0.80 floor still gatekeeps; monitor VETO rate |
