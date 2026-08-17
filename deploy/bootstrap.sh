#!/usr/bin/env bash
# vedrí funnel — zero-knowledge-required bootstrap.
#
# On a fresh VPS (AlmaLinux/Rocky/RHEL or Debian/Ubuntu), the operator types:
#     dnf install -y git        (or: apt-get install -y git)
#     git clone https://github.com/creadigol-design/dafunnel funnel
#     bash funnel/deploy/bootstrap.sh
# …enters the passphrase when asked, and everything else is automatic:
# prerequisites, decrypting .env from deploy/env.enc, Node + pnpm, dependencies,
# the full test suite, cron (hourly cycle + daily doctor), the doctor, the first
# cycle, and the live IMAP/SMTP mail check. Idempotent — safe to re-run.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
echo ""
echo "── vedrí funnel bootstrap ─────────────────────────────────────────"
echo "   directory: $APP_DIR"

# Self-update so a re-run always uses the latest fixes, then re-exec the fresh
# copy of this script (editing a running bash script in place is unsafe).
if [ -z "${VEDRI_BOOTSTRAP_UPDATED:-}" ]; then
  BEFORE="$(git rev-parse HEAD 2>/dev/null || echo none)"
  git pull --ff-only 2>/dev/null || true
  AFTER="$(git rev-parse HEAD 2>/dev/null || echo none)"
  if [ "$BEFORE" != "$AFTER" ]; then
    echo "── updated to $(git rev-parse --short HEAD) — restarting bootstrap…"
    VEDRI_BOOTSTRAP_UPDATED=1 exec bash "$APP_DIR/deploy/bootstrap.sh"
  fi
fi

# ── 1. OS prerequisites ─────────────────────────────────────────────────────
if command -v dnf >/dev/null; then
  echo "── installing prerequisites (dnf)…"
  dnf install -y -q git curl gcc-c++ make python3 tar cronie openssl || true
  systemctl enable --now crond
elif command -v apt-get >/dev/null; then
  echo "── installing prerequisites (apt)…"
  apt-get update -qq && apt-get install -y -qq git curl build-essential python3 tar cron openssl
  systemctl enable --now cron
fi

# ── 2. Secrets ──────────────────────────────────────────────────────────────
if [ -f .env ]; then
  echo "── .env already present — keeping it."
else
  if [ ! -f deploy/env.enc ]; then
    echo "!! deploy/env.enc missing — cannot continue." >&2
    exit 1
  fi
  echo ""
  read -r -s -p "Enter the deployment passphrase: " VP_PASS
  echo ""
  export VP_PASS
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in deploy/env.enc -pass env:VP_PASS > .env 2>/dev/null; then
    rm -f .env
    echo "!! Wrong passphrase — nothing written. Run the script again." >&2
    exit 1
  fi
  unset VP_PASS
  chmod 600 .env
  if ! grep -q '^DRY_RUN=' .env; then
    rm -f .env
    echo "!! Decrypted file failed validation — aborting." >&2
    exit 1
  fi
  echo "── secrets decrypted → .env ($(grep -c '=' .env) settings, shadow mode ON)"
fi

# ── 3. Node, dependencies, tests, cron, doctor, first cycle ────────────────
bash deploy/setup-vps.sh

# ── 4. Live mail check (needs node on PATH from setup) ─────────────────────
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
echo ""
echo "── live mail check (IMAP + SMTP against the cPanel mailbox)…"
pnpm run mail-doctor || true

echo ""
echo "───────────────────────────────────────────────────────────────────"
echo "  Bootstrap finished. If the doctor and mail checks above are green,"
echo "  the 14-day shadow run is LIVE: cycles run hourly, drafts collect in"
echo "  output/drafts/, the daily digest posts to Slack at 08:00 UK."
echo "  Nothing sends and HubSpot is not written to while DRY_RUN=true."
echo "───────────────────────────────────────────────────────────────────"
