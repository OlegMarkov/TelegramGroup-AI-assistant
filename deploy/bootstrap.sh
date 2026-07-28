#!/usr/bin/env bash
#
# One-time server setup for a fresh Ubuntu 22.04/24.04 VPS.
# Run as root:  bash bootstrap.sh <username>
#
# Installs Docker, creates a non-root deploy user, and applies a minimal
# firewall. Deliberately does NOT touch SSH password authentication — see the
# note at the end, because getting that wrong locks you out of the box.

set -euo pipefail

DEPLOY_USER="${1:-deploy}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this as root (or with sudo)." >&2
  exit 1
fi

echo "==> Updating packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq

echo "==> Installing prerequisites"
# sqlite3 is not needed by the app (it uses node:sqlite), but backup.sh uses it
# to verify each backup with PRAGMA integrity_check before pruning older ones.
apt-get install -y -qq ca-certificates curl gnupg git ufw unattended-upgrades sqlite3

echo "==> Installing Docker Engine + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
else
  echo "    Docker already installed, skipping"
fi

systemctl enable --now docker

echo "==> Creating deploy user '$DEPLOY_USER'"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

# Carry root's authorized_keys over so you can log in as the deploy user with
# the same key you used to reach the box.
if [ -f /root/.ssh/authorized_keys ]; then
  install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
    /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/authorized_keys"
  echo "    Copied root's authorized_keys to $DEPLOY_USER"
else
  echo "    WARNING: /root/.ssh/authorized_keys not found — add a key for $DEPLOY_USER before locking SSH down"
fi

echo "==> Configuring firewall"
# The bot uses Telegram long polling: it dials out and accepts no inbound
# connections. Nothing but SSH needs to be reachable. Redis is bound to
# 127.0.0.1 in docker-compose.yml and must never be opened here.
ufw allow OpenSSH
ufw --force enable
ufw status verbose

echo "==> Enabling unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

cat <<EOF

==> Done.

Next steps (in this order):

  1. From your LOCAL machine, confirm key-based login works as the new user:
         ssh $DEPLOY_USER@<server-ip>

  2. ONLY after that succeeds, harden SSH. Keep your current session open in
     another terminal while you do this, so a mistake doesn't lock you out:
         sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
         sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
         sudo systemctl reload ssh
     Then open a THIRD terminal and verify you can still log in before closing
     the others.

  3. Continue with DEPLOY.md to clone the repo and start the bot.

EOF
