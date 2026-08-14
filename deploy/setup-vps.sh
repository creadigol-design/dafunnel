#!/usr/bin/env bash
# vedrí funnel — one-shot VPS setup. Idempotent: safe to re-run.
#
# Usage (as a normal user with sudo, on Debian/Ubuntu):
#   git clone https://github.com/creadigol-design/dafunnel.git ~/vedri-funnel
#   cd ~/vedri-funnel && bash deploy/setup-vps.sh
#
# What it does:
#   1. Installs Node 22 (via nvm if node is absent) + pnpm (via corepack)
#   2. Installs dependencies and runs the test suite
#   3. Creates .env from .env.example if missing (then STOPS so you can fill it)
#   4. Installs two cron entries: hourly cycle + daily doctor
#   5. Runs the doctor + one cycle to prove the installation
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
echo "vedrí funnel setup in $APP_DIR"

# ── 1. Node + pnpm ──────────────────────────────────────────────────────────
if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 22 ]; then
  echo "Installing Node 22 via nvm..."
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm alias default 22
fi
command -v pnpm >/dev/null || { corepack enable && corepack prepare pnpm@latest --activate; }
echo "node $(node -v) · pnpm $(pnpm -v)"

# ── 2. Dependencies + tests ─────────────────────────────────────────────────
pnpm install --frozen-lockfile
pnpm test

# ── 3. Environment ──────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "══════════════════════════════════════════════════════════════════"
  echo "  .env created from the template. Fill in the secrets, then re-run"
  echo "  this script. Required for shadow mode:"
  echo "    HUBSPOT_PRIVATE_APP_TOKEN, ANTHROPIC_API_KEY, MAIL_PASS,"
  echo "    SLACK_BOT_TOKEN, SLACK_URGENT_DM_USER,"
  echo "    SENDER_POSTAL_ADDRESS, BOOKING_LINK"
  echo "  Leave DRY_RUN=true — that IS shadow mode."
  echo "══════════════════════════════════════════════════════════════════"
  exit 0
fi

# ── 4. Cron ─────────────────────────────────────────────────────────────────
NODE_BIN="$(dirname "$(command -v node)")"
CYCLE_LINE="10 * * * * cd $APP_DIR && PATH=$NODE_BIN:\$PATH pnpm run cycle >> output/logs/cron.log 2>&1"
DOCTOR_LINE="0 7 * * * cd $APP_DIR && PATH=$NODE_BIN:\$PATH pnpm run doctor >> output/logs/doctor.log 2>&1"
mkdir -p output/logs
( crontab -l 2>/dev/null | grep -v 'pnpm run cycle' | grep -v 'pnpm run doctor'; echo "$CYCLE_LINE"; echo "$DOCTOR_LINE" ) | crontab -
echo "cron installed: cycle hourly at :10, doctor daily at 07:00"

# ── 5. Prove it ─────────────────────────────────────────────────────────────
pnpm run doctor || true
pnpm run cycle
echo ""
echo "Setup complete. Shadow mode is running — check output/dashboard.html and Slack."
