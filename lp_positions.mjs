import { Connection, PublicKey } from "@solana/web3.js";
const RPC = "https://mainnet.helius-rpc.com/?api-key=e8252302-cdec-44d0-80d2-3efac7c0b50c";
const OWNER = "HsiXqHS9fsB344ES9ZKDUiE5TqqZgV31nEN7PysAASBT";
const conn = new Connection(RPC, "confirmed");
const mod = await import("@meteora-ag/dlmm");
const DLMM = mod.default?.default || mod.default || mod;
const fn = DLMM.getAllLbPairPositionsByUser || DLMM.default?.getAllLbPairPositionsByUser;
console.log("fetching positions for", OWNER);
const res = await fn(conn, new PublicKey(OWNER));
const entries = [...res.entries()];
console.log("open lbPair groups:", entries.length);
let totalSolLocked = 0, totalFeesSol = 0, count = 0;
for (const [pair, info] of entries) {
  const lb = info.lbPair;
  const xMint = lb.tokenXMint.toBase58(), yMint = lb.tokenYMint.toBase58();
  const SOL = "So11111111111111111111111111111111111111112";
  const yIsSol = yMint === SOL, xIsSol = xMint === SOL;
  for (const p of info.lbPairPositionsData) {
    count++;
    const d = p.positionData;
    const xAmt = Number(d.totalXAmount) / 1e9;  // approx, decimals vary
    const yAmt = Number(d.totalYAmount) / 1e9;
    const feeX = Number(d.feeX) / 1e9, feeY = Number(d.feeY) / 1e9;
    const solAmt = yIsSol ? yAmt : (xIsSol ? xAmt : 0);
    const feeSol = yIsSol ? feeY : (xIsSol ? feeX : 0);
    totalSolLocked += solAmt; totalFeesSol += feeSol;
    console.log(`  pos ${p.publicKey.toBase58().slice(0,8)} pair=${pair.slice(0,8)} xMint=${xMint.slice(0,6)} yMint=${yMint.slice(0,6)} x=${xAmt.toFixed(4)} y=${yAmt.toFixed(4)} feeX=${feeX.toFixed(5)} feeY=${feeY.toFixed(5)} solSide~${solAmt.toFixed(4)}`);
  }
}
console.log(`\nTOTAL open positions: ${count}`);
console.log(`Approx SOL-side locked: ${totalSolLocked.toFixed(4)} SOL  (+ unclaimed fees ~${totalFeesSol.toFixed(5)} SOL on SOL side)`);
console.log("NOTE: token-side value not priced; xAmount uses 9-decimals assumption.");
