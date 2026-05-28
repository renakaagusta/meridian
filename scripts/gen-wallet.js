#!/usr/bin/env node
// Generates a fresh Solana keypair and writes the private key straight into .env.
// Only the PUBLIC address is printed — the private key never leaves this process.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function b58(buf) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let d = [0];
  for (const byte of buf) {
    let c = byte;
    for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; }
    while (c) { d.push(c % 58); c = (c / 58) | 0; }
  }
  let z = 0;
  for (const byte of buf) { if (byte === 0) z++; else break; }
  return "1".repeat(z) + d.reverse().map((x) => A[x]).join("");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

// Refuse to clobber an existing wallet unless --force is passed.
let env = "";
if (fs.existsSync(envPath)) {
  env = fs.readFileSync(envPath, "utf8");
  const m = env.match(/^WALLET_PRIVATE_KEY=(.*)$/m);
  const hasKey = m && m[1].trim() && !m[1].includes("your_base58_private_key_here");
  if (hasKey && !process.argv.includes("--force")) {
    console.error("Refusing to overwrite existing WALLET_PRIVATE_KEY in .env. Re-run with --force to replace it.");
    process.exit(1);
  }
} else if (fs.existsSync(examplePath)) {
  env = fs.readFileSync(examplePath, "utf8");
} else {
  env = "WALLET_PRIVATE_KEY=\n";
}

const { privateKey } = crypto.generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const seed = Buffer.from(jwk.d, "base64url");
const pub = Buffer.from(jwk.x, "base64url");
const secret = b58(Buffer.concat([seed, pub])); // 64-byte Solana secretKey, base58
const address = b58(pub);

const line = `WALLET_PRIVATE_KEY=${secret}`;
if (/^WALLET_PRIVATE_KEY=.*$/m.test(env)) {
  env = env.replace(/^WALLET_PRIVATE_KEY=.*$/m, line);
} else {
  env += (env.endsWith("\n") || env === "" ? "" : "\n") + line + "\n";
}

fs.writeFileSync(envPath, env, { mode: 0o600 });

console.log("New wallet written to .env (WALLET_PRIVATE_KEY).");
console.log("Public address:", address);
console.log("Fund this address with SOL, then run `npm run dev`.");
