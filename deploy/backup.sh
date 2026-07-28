#!/usr/bin/env bash
#
# Back up the SQLite database without stopping the bot, and prune old copies.
# Run from the repo root:  ./deploy/backup.sh
#
# Suitable for cron:
#   0 3 * * * cd /home/deploy/TelegramGroup-AI-assistant && ./deploy/backup.sh >> /var/log/bot-backup.log 2>&1

set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TARGET="backup-${STAMP}.db"

if [ ! -f ./data/bot.db ]; then
  echo "No database at ./data/bot.db — nothing to back up."
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# VACUUM INTO produces a consistent snapshot of a live WAL-mode database.
# A plain `cp` of bot.db is NOT safe here: recent writes may still be sitting
# in bot.db-wal and would be silently missing from the copy.
#
# Run it inside the container so it uses the same node:sqlite build as the app,
# and writes through the same bind mount.
docker compose exec -T bot node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('./data/bot.db');
  db.exec(\"VACUUM INTO './data/${TARGET}'\");
  db.close();
"

mv "./data/${TARGET}" "${BACKUP_DIR}/${TARGET}"
echo "Wrote ${BACKUP_DIR}/${TARGET} ($(du -h "${BACKUP_DIR}/${TARGET}" | cut -f1))"

# Verify the backup is readable and not truncated before trusting it enough to
# prune older ones. An unverified backup is not a backup.
if ! sqlite3 "${BACKUP_DIR}/${TARGET}" 'PRAGMA integrity_check;' 2>/dev/null | grep -q '^ok$'; then
  if command -v sqlite3 >/dev/null 2>&1; then
    echo "ERROR: integrity check failed on ${TARGET} — keeping all older backups." >&2
    exit 1
  fi
  echo "    (sqlite3 CLI not installed; skipping integrity verification)"
fi

echo "==> Pruning backups older than ${KEEP_DAYS} days"
find "$BACKUP_DIR" -name 'backup-*.db' -type f -mtime "+${KEEP_DAYS}" -print -delete

echo "==> Current backups:"
ls -lh "$BACKUP_DIR" | tail -n +2 | awk '{print "    "$9"  "$5}'

cat <<'EOF'

NOTE: these copies live on the same server as the database. That protects you
from a bad deploy or an accidental delete, but NOT from losing the VPS itself.
Copy them off the box regularly, e.g. from your local machine:

    rsync -avz deploy@<server-ip>:~/TelegramGroup-AI-assistant/backups/ ./vps-backups/
EOF
