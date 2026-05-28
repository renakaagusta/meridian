# Meridian Setup TODO

Checklist to get the autonomous DLMM agent running. Work top to bottom.

## 1. Prerequisites
- [ ] Install Node.js 18+ (`node -v`)
- [ ] Have a Solana wallet ready to export (base58 or JSON-array private key)
- [ ] Fund the wallet with SOL (≥ `minSolToOpen` default 0.55 + gas reserve; ~1 SOL recommended)

## 2. Get API keys
- [ ] **OpenRouter** API key — https://openrouter.ai (`OPENROUTER_API_KEY`)
- [ ] **Helius** API key — https://helius.xyz (`HELIUS_API_KEY` + used in `RPC_URL`)
- [ ] **LPAgent** API key — LPAgent docs (`LPAGENT_API_KEY`)
- [ ] *(optional)* Telegram bot via @BotFather → `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS`

## 3. Install & configure
- [ ] `npm install`
- [ ] `cp .env.example .env` and fill in:
  - [ ] `WALLET_PRIVATE_KEY`
  - [ ] `RPC_URL` (paste your Helius key into the URL)
  - [ ] `OPENROUTER_API_KEY`
  - [ ] `HELIUS_API_KEY`
  - [ ] `LPAGENT_API_KEY`
  - [ ] Telegram vars (optional)
  - [ ] Keep `DRY_RUN=true` for now
- [ ] `npm run setup` — wizard generates `user-config.json` (pick a risk preset)

## 4. Safe first run (no on-chain txs)
- [ ] `npm run dev` (forces `DRY_RUN=true`)
- [ ] In the REPL, verify APIs work:
  - [ ] `/status`
  - [ ] `/candidates`
  - [ ] `/thresholds`
  - [ ] `/balance`
- [ ] Watch a screening + management cycle complete without errors

## 5. Go live
- [ ] Set `DRY_RUN=false` in `.env`
- [ ] `npm start` (autonomous loop + REPL)
- [ ] Confirm Telegram notifies on deploy/close (if configured)

## 6. (Optional) Run under PM2
- [ ] `npm run pm2:start`
- [ ] `npm run pm2:logs` to tail
- [ ] `npm run pm2:restart` after config changes

## Notes
- Tune thresholds in `user-config.json` (see `CLAUDE.md` → Config System table).
- Local LLM instead of OpenRouter: set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` in `.env`.
- `ALLOW_SELF_UPDATE=false` — leave disabled unless you know what you're doing.
