# SELF-REPAIR PIPELINE (L3) - spec, top build priority
Goal: the machine redeploys its own last-known-good code with no human.
Pieces (all present now): canonical worker source = worker/foreman.js;
DEPLOY_PAT secret sealed; CF_ACCOUNT/CF_TOKEN/CF_VIEWS_KV +
FOREMAN_KEY/GUMROAD_TOKEN/TELEGRAM_TOKEN/OWNER_CHAT_ID sealed.
To build (next session): tools/deploy-worker.py (copy gumroad-shop/
tools/cf_foreman.py, swap .secrets file reads for env secrets) +
.github/workflows/self-repair.yml (workflow_dispatch) + a worker
action self_repair that dispatches it + the crash handler
auto-triggers after 2 consecutive crashes (state counter).
Until then: crashes chain the beat, alert Telegram, wait for the
deep agent. L1/L2 fully automated, L3 one session away, L4
(novel code) stays human.
