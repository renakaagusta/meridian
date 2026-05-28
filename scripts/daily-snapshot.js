#!/usr/bin/env node
/**
 * Daily benchmark snapshot — UNATTENDED-SAFE.
 *
 * Records our agent's wallet and the target trader's wallet daily so the gap
 * can be tracked over time. Uses Meteora's OPEN datapi (no auth, no Cloudflare)
 * — the same source the bot uses — because fabriq's API needs a short-lived
 * Privy JWT whose refresh gets Cloudflare-challenged and can't run unattended.
 * (For the richer fabriq-computed metrics — profit factor, win rate, full
 * history — run `npm run bench:fabriq <wallet>` manually with Chrome open.)
 *
 * Scheduled by PM2 (cron_restart in ecosystem.config.cjs → meridian-snapshot)
 * or run manually:  node scripts/daily-snapshot.js
 */

import fs from "fs";
import path from "path";
import net from "net";
import { fileURLToPath } from "url";
import { getPerformanceSummary } from "../lessons.js";

net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "benchmark");
const HISTORY = path.join(OUT_DIR, "history.jsonl");
const DATAPI = "https://dlmm.datapi.meteora.ag";

const WALLETS = [
  { label: "ours",   wallet: "EZB11yLPaywhRiw1eUmKM8Lxy6oCBQamXXmQ6kwy4CGR" },
  { label: "target", wallet: "Ew7KqcKM7B1fKjPcc9myP2A7QujAcn2gU51g2irFnoJf" },
];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function fetchOpen(wallet) {
  const r = await fetch(`${DATAPI}/portfolio/open?user=${wallet}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`datapi HTTP ${r.status}`);
  return r.json();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const ts = new Date().toISOString();
  console.log(`\n[daily-snapshot] ${ts}`);

  const rows = [];
  for (const { label, wallet } of WALLETS) {
    try {
      const j = await fetchOpen(wallet);
      const t = j.total || {};
      const row = {
        date, ts, label, wallet, source: "meteora-datapi",
        openPositions: j.totalPositions ?? 0,
        balanceUsd: num(t.balances),
        balanceSol: num(t.balancesSol),
        unclaimedFeesUsd: num(t.unclaimedFees),
        unrealizedPnlUsd: num(t.pnl),
        unrealizedPnlPct: num(t.pnlPctChange),
      };
      if (label === "ours") {
        const perf = getPerformanceSummary();
        if (perf) {
          row.realized = {
            closed: perf.total_positions ?? perf.totalPositions ?? null,
            netPnlUsd: perf.total_pnl_usd ?? perf.net_pnl_usd ?? null,
            winRate: perf.win_rate ?? perf.winRate ?? null,
          };
        }
      }
      fs.appendFileSync(HISTORY, JSON.stringify(row) + "\n");
      rows.push(row);
      console.log(`[daily-snapshot] ${label.padEnd(6)} ${wallet.slice(0, 6)}… → ${row.openPositions} open | $${row.balanceUsd.toFixed(2)} | fees $${row.unclaimedFeesUsd.toFixed(2)} | unrealized ${row.unrealizedPnlPct.toFixed(2)}%`);
    } catch (e) {
      console.error(`[daily-snapshot] FAILED ${label}: ${e.message}`);
    }
  }

  // Compact side-by-side for today
  if (rows.length === 2) {
    const [a, b] = rows;
    console.log(`\n  metric            ${a.label.padEnd(14)} ${b.label}`);
    const line = (m, x, y) => console.log(`  ${m.padEnd(18)}${String(x).padEnd(14)} ${y}`);
    line("open positions", a.openPositions, b.openPositions);
    line("balance USD", `$${a.balanceUsd.toFixed(2)}`, `$${b.balanceUsd.toFixed(2)}`);
    line("unclaimed fees", `$${a.unclaimedFeesUsd.toFixed(2)}`, `$${b.unclaimedFeesUsd.toFixed(2)}`);
    line("unrealized %", `${a.unrealizedPnlPct.toFixed(2)}%`, `${b.unrealizedPnlPct.toFixed(2)}%`);
  }

  const count = fs.existsSync(HISTORY) ? fs.readFileSync(HISTORY, "utf8").trim().split("\n").filter(Boolean).length : 0;
  console.log(`\n[daily-snapshot] history → ${path.relative(ROOT, HISTORY)} (${count} rows)\n`);
}

main().catch((e) => { console.error("daily-snapshot error:", e.message); process.exit(1); });
