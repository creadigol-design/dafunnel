#!/usr/bin/env bash
# vedrí funnel — install the web viewer as an always-on service.
# Run after bootstrap:  bash deploy/setup-viewer.sh
# Idempotent. Generates VIEWER_PASSWORD on first run and prints the URL + login.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

# ── password ────────────────────────────────────────────────────────────────
if ! grep -q '^VIEWER_PASSWORD=' .env 2>/dev/null; then
  PW="$(openssl rand -hex 8)"
  printf 'VIEWER_PORT=8080\nVIEWER_PASSWORD=%s\n' "$PW" >> .env
else
  PW="$(grep '^VIEWER_PASSWORD=' .env | cut -d= -f2-)"
fi

# ── node path for systemd (nvm installs outside the default PATH) ──────────
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
NODE_BIN="$(dirname "$(command -v node)")"

# ── systemd unit ────────────────────────────────────────────────────────────
cat > /etc/systemd/system/vedri-viewer.service <<UNIT
[Unit]
Description=vedri funnel web viewer
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PATH=$NODE_BIN:/usr/bin:/bin
Environment=COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ExecStart=$NODE_BIN/node $APP_DIR/node_modules/tsx/dist/cli.mjs src/viewer/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now vedri-viewer
systemctl restart vedri-viewer

# ── firewall ────────────────────────────────────────────────────────────────
if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port=8080/tcp >/dev/null
  firewall-cmd --reload >/dev/null
  echo "firewall: port 8080 opened"
fi

IP="$(curl -fsS -4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
sleep 1
systemctl is-active --quiet vedri-viewer && STATUS="running" || STATUS="NOT RUNNING — check: journalctl -u vedri-viewer -n 20"

echo ""
echo "──────────────────────────────────────────────────────"
echo "  Viewer service: $STATUS"
echo ""
echo "  Open in your browser:   http://$IP:8080"
echo "  Username:               vedri"
echo "  Password:               $PW"
echo ""
echo "  Pages: /  (dashboard) · /drafts (review + flag)"
echo "──────────────────────────────────────────────────────"
