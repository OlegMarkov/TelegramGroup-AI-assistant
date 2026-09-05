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

# --- source history ------------------------------------------------------
# A git bundle is a single file containing the full repository history, so the
# code survives losing both this machine and access to the upstream host.
# Added after GitHub disabled the repository under trade-control restrictions,
# which left history in only two places, one of them revocable by a third party.
if git rev-parse --git-dir >/dev/null 2>&1; then
  HEAD_SHA="$(git rev-parse --short HEAD)"

  if ls "${BACKUP_DIR}"/repo-*-"${HEAD_SHA}".bundle >/dev/null 2>&1; then
    echo "==> Repo unchanged since last bundle (${HEAD_SHA}) — skipping"
  else
    BUNDLE="repo-${STAMP}-${HEAD_SHA}.bundle"
    # --all captures every branch and tag, not just the checked-out one.
    if git bundle create "${BACKUP_DIR}/${BUNDLE}" --all >/dev/null 2>&1 &&
       git bundle verify "${BACKUP_DIR}/${BUNDLE}" >/dev/null 2>&1; then
      echo "Wrote ${BACKUP_DIR}/${BUNDLE} ($(du -h "${BACKUP_DIR}/${BUNDLE}" | cut -f1))"
    else
      echo "ERROR: git bundle failed verification — removing it." >&2
      rm -f "${BACKUP_DIR}/${BUNDLE}"
    fi
  fi
else
  echo "==> Not a git repository — skipping source bundle"
fi

echo "==> Pruning backups older than ${KEEP_DAYS} days"
find "$BACKUP_DIR" -name 'backup-*.db' -type f -mtime "+${KEEP_DAYS}" -print -delete
# Bundles are tiny and deduplicated by commit, but prune them on the same
# schedule so the directory cannot grow without bound.
find "$BACKUP_DIR" -name 'repo-*.bundle' -type f -mtime "+${KEEP_DAYS}" -print -delete

# Same schedule, nothing extra to remember in cron. It is a no-op until
# OFFSITE_REMOTE is configured, and a failure here must not make a successful
# local backup look failed - the local copy has already been written and
# verified by this point.
if ! ./deploy/offsite-backup.sh; then
  echo "WARNING: the off-site copy failed. The local backup above is fine." >&2
fi

echo "==> Current backups:"
ls -lh "$BACKUP_DIR" | tail -n +2 | awk '{print "    "$9"  "$5}'

cat <<'EOF'

NOTE: the copies in ./backups live on the same server as the database and the
repo. That protects you from a bad deploy or an accidental delete, but NOT from
losing the VPS itself. Two things cover that, and only one of them needs
somebody to be awake:

  * ./deploy/offsite-backup.sh, run above, pushes an encrypted copy to object
    storage. Set OFFSITE_REMOTE and OFFSITE_PASSPHRASE in .env to enable it.
  * deploy/pull-backups.ps1 copies to a Windows workstation, which has to be
    powered on for it to happen.

To restore the database from the off-site copy:

    ./deploy/restore-offsite.sh            # verify only, changes nothing
    ./deploy/restore-offsite.sh --install  # and put it live

To restore from a bundle (recovers full history with no upstream host):

    git clone repo-<stamp>-<sha>.bundle recovered-repo
EOF
