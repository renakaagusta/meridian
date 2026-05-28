#!/usr/bin/env node
// One-shot LIVE verification: screening → management → close.
// Spends real SOL. Temporary script — delete after verification.
import "dotenv/config";
import { runScreeningCycle, runManagementCycle } from "../index.js";
import { getMyPositions } from "../tools/dlmm.js";
import { executeTool } from "../tools/executor.js";

const line = (s) => console.log(s);

line("\n===== LIVE VERIFICATION =====");
line(`DRY_RUN=${process.env.DRY_RUN} | model=${process.env.LLM_MODEL} @ ${process.env.LLM_BASE_URL}\n`);

line("--- PHASE 1: SCREENING (may deploy real SOL) ---");
const before = await getMyPositions({ force: true }).catch(() => null);
line(`positions before: ${before?.positions?.length ?? "?"}`);
const sr = await runScreeningCycle({ silent: false });
line("\n[screening report]\n" + (sr || "(none)"));

const after = await getMyPositions({ force: true }).catch(() => null);
const positions = after?.positions || [];
line(`\npositions after screening: ${positions.length}`);

if (positions.length === 0) {
  line("\nNo position opened (no candidate qualified, challenger veto, or filters). Positioning produced a NO-DEPLOY decision (still a valid pipeline result). Closing verification skipped.");
} else {
  line("\n--- PHASE 2: MANAGEMENT ---");
  const mr = await runManagementCycle({ silent: false });
  line("\n[management report]\n" + (mr || "(none)"));

  const after2 = await getMyPositions({ force: true }).catch(() => null);
  const pos2 = after2?.positions || [];
  if (pos2.length === 0) {
    line("\nPosition already closed by management rules — close path exercised.");
  } else {
    const p = pos2[0];
    line(`\n--- PHASE 3: CLOSE (verifying close path on ${p.pair} ${p.position}) ---`);
    const cr = await executeTool("close_position", { position_address: p.position, reason: "live verification test close" });
    line("\n[close result]\n" + JSON.stringify(cr, null, 1).slice(0, 800));
    const after3 = await getMyPositions({ force: true }).catch(() => null);
    line(`\npositions after close: ${after3?.positions?.length ?? "?"}`);
  }
}

line("\n===== DONE =====");
process.exit(0);
