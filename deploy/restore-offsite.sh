#!/usr/bin/env bash
#
# Fetch an off-site backup, decrypt it, and check it is a working database.
#
#   ./deploy/restore-offsite.sh                 # newest daily, verify only
#   ./deploy/restore-offsite.sh --list          # what is in the bucket
#   ./deploy/restore-offsite.sh backup-20260905-030000.db.enc
#   ./deploy/restore-offsite.sh --install       # ...and put it live
#
# A backup nobody has restored is a hypothesis, not a backup. Run this without
# --install every so often; it touches nothing that is live, so there is no
# reason not to.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

OFFSITE_REMOTE="${OFFSITE_REMOTE:-}"
OFFSITE_PASSPHRASE="${OFFSITE_PASSPHRASE:-}"

if [ -z "$OFFSITE_REMOTE" ] || [ -z "$OFFSITE_PASSPHRASE" ]; then
  echo "ERROR: OFFSITE_REMOTE and OFFSITE_PASSPHRASE must be set in .env." >&2
  exit 1
fi

if [ "${1:-}" = "--list" ]; then
  echo "==> daily/"
  rclone lsl "${OFFSITE_REMOTE}/daily/" || true
  echo "==> weekly/"
  rclone lsl "${OFFSITE_REMOTE}/weekly/" || true
  exit 0
fi

INSTALL=0
WANTED=""
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    *) WANTED="$arg" ;;
  esac
done

if [ -z "$WANTED" ]; then
  # rclone lsf sorts lexically, and the names are UTC timestamps, so the last
  # line is the newest.
  WANTED="$(rclone lsf "${OFFSITE_REMOTE}/daily/" | sort | tail -n 1)"
  if [ -z "$WANTED" ]; then
    echo "ERROR: nothing in ${OFFSITE_REMOTE}/daily/ to restore." >&2
    exit 1
  fi
  echo "==> Newest daily copy: ${WANTED}"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SOURCE="${OFFSITE_REMOTE}/daily/${WANTED}"
if ! rclone lsf "$SOURCE" >/dev/null 2>&1; then
  SOURCE="${OFFSITE_REMOTE}/weekly/${WANTED}"
fi

echo "==> Downloading ${SOURCE}"
rclone copyto "$SOURCE" "${WORK}/restore.db.enc"

echo "==> Decrypting"
export OFFSITE_PASSPHRASE
if ! openssl enc -d -aes-256-cbc -md sha512 -pbkdf2 -iter 600000 \
      -in "${WORK}/restore.db.enc" -out "${WORK}/restore.db" -pass env:OFFSITE_PASSPHRASE 2>/dev/null; then
  echo "ERROR: decryption failed. Wrong OFFSITE_PASSPHRASE, or a corrupt object." >&2
  exit 1
fi

# Checked inside a throwaway container, using the same node:sqlite build the app
# runs. Verifying with whatever sqlite happens to be on the host proves less:
# the question is whether the bot can open this file, not whether some sqlite
# can. Nothing live is touched — the file is mounted read-only under /verify.
echo "==> Verifying in a scratch container"
docker compose run --rm --no-deps \
  -v "${WORK}:/verify" \
  --entrypoint node bot -e "
    const { DatabaseSync } = require('node:sqlite');
    try {
      const db = new DatabaseSync('/verify/restore.db');

      // The column is named after the pragma, not 'result'. Reading the wrong
      // key yields undefined, which compares unequal to 'ok' and would fail
      // every restore regardless of whether the file was fine.
      const [row] = db.prepare('PRAGMA integrity_check').all();
      if (!row || row.integrity_check !== 'ok') {
        console.error('  integrity_check:', row && row.integrity_check);
        process.exit(1);
      }

      // Row counts, because integrity_check passing only says the file is a
      // well-formed database. An empty well-formed database is also one of
      // those, and is not a backup of anything.
      const count = (t) => db.prepare(\`SELECT COUNT(*) c FROM \${t}\`).get().c;
      console.log('  integrity_check: ok');
      for (const t of ['users', 'chats', 'messages', 'subscriptions', 'events']) {
        console.log(\`  \${t.padEnd(15)} \${count(t)}\`);
      }
      const newest = db.prepare('SELECT MAX(created_at) m FROM messages').get().m;
      console.log('  newest message :', newest || '(none)');
      db.close();
    } catch (error) {
      // A truncated or partially uploaded object fails on open, not on the
      // pragma. Reported as a failed restore rather than a stack trace.
      console.error('  NOT RESTORABLE:', error.message);
      process.exit(1);
    }
  "

if [ "$INSTALL" != "1" ]; then
  cat <<EOF

==> Verified. Nothing was changed.
    To actually put this copy live, re-run with --install.
EOF
  exit 0
fi

cat <<EOF

==> About to REPLACE ./data/bot.db with ${WANTED}.
    The bot will be stopped, and the current database moved aside (not deleted).
EOF
read -r -p "    Type 'restore' to continue: " CONFIRM
[ "$CONFIRM" = "restore" ] || { echo "Aborted."; exit 1; }

docker compose stop bot

if [ -f ./data/bot.db ]; then
  ASIDE="./data/bot.db.replaced-$(date -u +%Y%m%d-%H%M%S)"
  mv ./data/bot.db "$ASIDE"
  # The WAL and shared-memory files belong to the database being replaced.
  # Leaving them next to a restored file is how a "successful" restore comes
  # back with the wrong contents.
  rm -f ./data/bot.db-wal ./data/bot.db-shm
  echo "==> Previous database kept at ${ASIDE}"
fi

cp "${WORK}/restore.db" ./data/bot.db
docker compose start bot

echo "==> Restored. Watch it come back healthy:"
echo "    docker compose ps && docker compose logs -f bot"
