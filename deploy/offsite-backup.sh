#!/usr/bin/env bash
#
# Push the newest local backup to object storage, encrypted.
#
# Called at the end of ./deploy/backup.sh, so it runs on the same schedule and
# there is nothing extra to remember in cron. Safe to run on its own too:
#   ./deploy/offsite-backup.sh
#
# Why this exists: backup.sh writes to the same server as the database, and
# pull-backups.ps1 copies to a workstation that has to be switched on. Lose the
# VPS while that machine has been off for a fortnight and the newest surviving
# copy is a fortnight old. This path depends on nothing being powered on.

set -euo pipefail

cd "$(dirname "$0")/.."

# The server's .env holds the credential. Never the repo: .dockerignore excludes
# .env and .env.* from the build context, and .gitignore keeps it out of git.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
OFFSITE_REMOTE="${OFFSITE_REMOTE:-}"
OFFSITE_PASSPHRASE="${OFFSITE_PASSPHRASE:-}"
OFFSITE_KEEP_DAILY="${OFFSITE_KEEP_DAILY:-7}"
OFFSITE_KEEP_WEEKLY="${OFFSITE_KEEP_WEEKLY:-4}"

if [ -z "$OFFSITE_REMOTE" ]; then
  echo "==> OFFSITE_REMOTE not set — skipping the off-site copy."
  echo "    See DEPLOY.md § Off-site copies to configure it."
  exit 0
fi

# Refused rather than defaulted. The database holds other people's message
# content, and the whole point of PRIVACY.md is that it is handled carefully;
# uploading it in the clear to a third party would undo that quietly.
if [ -z "$OFFSITE_PASSPHRASE" ]; then
  echo "ERROR: OFFSITE_REMOTE is set but OFFSITE_PASSPHRASE is empty." >&2
  echo "       Refusing to upload an unencrypted copy of other people's messages." >&2
  exit 1
fi

for tool in rclone openssl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: $tool is not installed. See DEPLOY.md § Off-site copies." >&2
    exit 1
  fi
done

NEWEST="$(ls -1t "${BACKUP_DIR}"/backup-*.db 2>/dev/null | head -n 1 || true)"
if [ -z "$NEWEST" ]; then
  echo "ERROR: no backup-*.db in ${BACKUP_DIR} to upload." >&2
  exit 1
fi

BASENAME="$(basename "$NEWEST")"
ENCRYPTED="${BACKUP_DIR}/${BASENAME}.enc"

# -pass env: keeps the passphrase out of the process list, where -k would put it
# in plain view of every user on the box. -pbkdf2 with a high iteration count is
# what makes a human-chosen passphrase survive an offline attack on a file
# sitting in someone else's storage; without it openssl falls back to a single
# MD5 round, which is not a meaningful defence.
export OFFSITE_PASSPHRASE
openssl enc -aes-256-cbc -md sha512 -pbkdf2 -iter 600000 -salt \
  -in "$NEWEST" -out "$ENCRYPTED" -pass env:OFFSITE_PASSPHRASE

# Decrypt the artifact we are actually about to upload and check it is a
# readable database. Encrypting the right file with the wrong passphrase, or
# with a flag combination that cannot be reversed, otherwise stays invisible
# until the day it matters.
VERIFY="$(mktemp)"
trap 'rm -f "$VERIFY"' EXIT
if ! openssl enc -d -aes-256-cbc -md sha512 -pbkdf2 -iter 600000 \
      -in "$ENCRYPTED" -out "$VERIFY" -pass env:OFFSITE_PASSPHRASE 2>/dev/null; then
  echo "ERROR: the encrypted copy could not be decrypted — not uploading it." >&2
  rm -f "$ENCRYPTED"
  exit 1
fi

if command -v sqlite3 >/dev/null 2>&1; then
  if ! sqlite3 "$VERIFY" 'PRAGMA integrity_check;' 2>/dev/null | grep -q '^ok$'; then
    echo "ERROR: the decrypted copy failed integrity_check — not uploading it." >&2
    rm -f "$ENCRYPTED"
    exit 1
  fi
  echo "    Round-trip verified: decrypts and passes integrity_check."
else
  echo "    (sqlite3 CLI not installed; verified decryption only)"
fi

echo "==> Uploading ${BASENAME}.enc to ${OFFSITE_REMOTE}/daily/"
rclone copyto "$ENCRYPTED" "${OFFSITE_REMOTE}/daily/${BASENAME}.enc"

# A weekly copy on a separate retention clock, so a problem noticed a month late
# still has something to restore from. Keyed on the ISO week rather than on a
# weekday, so a run missed on Monday still produces that week's copy.
ISO_WEEK="$(date -u +%G-W%V)"
if ! rclone lsf "${OFFSITE_REMOTE}/weekly/" 2>/dev/null | grep -q "^${ISO_WEEK}-"; then
  echo "==> No weekly copy for ${ISO_WEEK} yet — writing one"
  rclone copyto "$ENCRYPTED" "${OFFSITE_REMOTE}/weekly/${ISO_WEEK}-${BASENAME}.enc"
fi

rm -f "$ENCRYPTED"

echo "==> Pruning remote copies (daily ${OFFSITE_KEEP_DAILY}d, weekly ${OFFSITE_KEEP_WEEKLY}w)"
rclone delete --min-age "${OFFSITE_KEEP_DAILY}d" "${OFFSITE_REMOTE}/daily/"
rclone delete --min-age "$((OFFSITE_KEEP_WEEKLY * 7))d" "${OFFSITE_REMOTE}/weekly/"

# Recorded through the bot, into the same app_state table the retention sweep
# uses, because the bot is the only thing that is always running. A backup that
# silently stops happening is the standard way this goes wrong, and a cron job
# that never fires produces no output to notice the absence of — so the alarm
# has to live somewhere that keeps ticking. The bot warns after 48h and /stats
# shows the timestamp.
if docker compose exec -T bot node -e "
  const { setAppState } = require('./src/services/database');
  setAppState('offsite_backup_at', Date.now());
" >/dev/null 2>&1; then
  echo "==> Recorded the successful off-site backup for the staleness check."
else
  echo "    (could not record the timestamp — is the bot container running?)" >&2
fi

echo "==> Off-site backup complete."
echo "    Restore procedure: DEPLOY.md § Restoring from an off-site copy"
