#!/usr/bin/env bash
#
# StickyPrinter installation/deployment script for Debian/Ubuntu.
# Installs Node.js, nginx and certbot, deploys the app under a dedicated
# system user, and configures nginx + Let's Encrypt for HTTPS.
#
# Usage (run as root from a checkout of this repository):
#   sudo DOMAIN=stickies.basisadresse.de CERTBOT_EMAIL=you@example.com deploy/install.sh
#
# Safe to re-run: re-running redeploys the app (new code, npm ci, service
# restart) without touching the existing database, session secret or
# certificate.
set -euo pipefail

DOMAIN="${DOMAIN:-stickies.basisadresse.de}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
APP_USER="${APP_USER:-stickyprinter}"
APP_DIR="${APP_DIR:-/opt/stickyprinter}"
APP_PORT="${APP_PORT:-3000}"
NODE_MAJOR="${NODE_MAJOR:-22}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { echo -e "\n\033[1;32m==> $*\033[0m"; }
warn() { echo -e "\033[1;33mWARNING: $*\033[0m"; }

if [[ $EUID -ne 0 ]]; then
  echo "This script must be run as root (sudo)." >&2
  exit 1
fi

if [[ -z "$CERTBOT_EMAIL" ]]; then
  warn "CERTBOT_EMAIL not set — Let's Encrypt registration will be skipped." \
       "Re-run with CERTBOT_EMAIL=you@example.com to obtain a certificate."
fi

log "Installing prerequisites"
apt-get update -y
apt-get install -y curl gnupg ca-certificates rsync build-essential python3 sqlite3

log "Installing Node.js ${NODE_MAJOR}.x (NodeSource)"
# Follows the official NodeSource deb822 setup (nodesource/distributions
# scripts/deb/setup_22.x), reproduced here instead of piping their script
# straight into bash.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed -E 's/^v([0-9]+).*/\1/')" -lt "$NODE_MAJOR" ]]; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  chmod 644 /usr/share/keyrings/nodesource.gpg
  ARCH="$(dpkg --print-architecture)"
  cat > /etc/apt/sources.list.d/nodesource.sources <<EOF
Types: deb
URIs: https://deb.nodesource.com/node_${NODE_MAJOR}.x
Suites: nodistro
Components: main
Architectures: ${ARCH}
Signed-By: /usr/share/keyrings/nodesource.gpg
EOF
  apt-get update -y
  apt-get install -y nodejs
else
  log "Node.js $(node -v) already satisfies >= ${NODE_MAJOR}, skipping"
fi
NODE_BIN="$(command -v node)"

log "Installing nginx and certbot"
apt-get install -y nginx certbot python3-certbot-nginx

log "Creating system user and directories"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data"

log "Deploying application code to $APP_DIR"
rsync -a --delete \
  --exclude node_modules \
  --exclude data \
  --exclude .git \
  --exclude deploy \
  --exclude .env \
  "$REPO_DIR/" "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "Installing npm dependencies (production only)"
sudo -u "$APP_USER" env PATH="$PATH" npm --prefix "$APP_DIR" ci --omit=dev

ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Generating .env (first install)"
  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=${APP_PORT}
SESSION_SECRET=${SESSION_SECRET}
DB_PATH=${APP_DIR}/data/stickyprinter.db
EOF
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  log ".env already exists, leaving it untouched (edit $ENV_FILE manually if needed)"
fi

log "Installing systemd service"
sed \
  -e "s#__APP_USER__#${APP_USER}#g" \
  -e "s#__APP_DIR__#${APP_DIR}#g" \
  -e "s#__NODE_BIN__#${NODE_BIN}#g" \
  "$REPO_DIR/deploy/systemd/stickyprinter.service.template" > /etc/systemd/system/stickyprinter.service
systemctl daemon-reload
systemctl enable stickyprinter
systemctl restart stickyprinter

log "Configuring nginx for $DOMAIN"
sed \
  -e "s#__DOMAIN__#${DOMAIN}#g" \
  -e "s#__APP_PORT__#${APP_PORT}#g" \
  "$REPO_DIR/deploy/nginx/stickies.conf.template" > "/etc/nginx/sites-available/${DOMAIN}.conf"
ln -sf "/etc/nginx/sites-available/${DOMAIN}.conf" "/etc/nginx/sites-enabled/${DOMAIN}.conf"
nginx -t
systemctl reload nginx

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  log "ufw detected — allowing Nginx Full"
  ufw allow "Nginx Full" || true
fi

if [[ -n "$CERTBOT_EMAIL" ]]; then
  log "Requesting/renewing Let's Encrypt certificate for $DOMAIN"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect
else
  warn "Skipped certbot. Once DNS for $DOMAIN points at this server, run:" \
       "  sudo certbot --nginx -d $DOMAIN --agree-tos -m you@example.com --redirect"
fi

log "Done."
echo "  App directory : $APP_DIR"
echo "  Service       : systemctl status stickyprinter"
echo "  Logs          : journalctl -u stickyprinter -f"
echo "  Nginx site    : /etc/nginx/sites-available/${DOMAIN}.conf"
echo "  URL           : https://${DOMAIN}"
