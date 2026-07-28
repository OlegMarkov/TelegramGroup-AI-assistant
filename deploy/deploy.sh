#!/usr/bin/env bash
#
# Pull the latest code and restart the bot.
# Run as the deploy user from the repo root:  ./deploy/deploy.sh
#
# Safe to re-run. Takes a database backup before touching anything, so a bad
# deploy is recoverable.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

if [ ! -f .env ]; then
  echo "ERROR: .env is missing. It is intentionally not in git — create it on" >&2
  echo "       the server from .env.example and fill in the real values." >&2
  exit 1
fi

echo "==> Backing up the database first"
./deploy/backup.sh || echo "    (no existing database to back up — first deploy?)"

echo "==> Fetching latest code"
git fetch --quiet origin
LOCAL="$(git rev-parse @)"
REMOTE="$(git rev-parse @{u})"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "    Already up to date at $(git rev-parse --short HEAD)"
else
  echo "    $(git rev-parse --short "$LOCAL") -> $(git rev-parse --short "$REMOTE")"
  git merge --ff-only "$REMOTE"
fi

echo "==> Rebuilding and restarting"
docker compose up -d --build

echo "==> Waiting for the health check to report healthy"
# The bot writes a heartbeat file every 30s; healthcheck.js reads it. Give the
# container its start-period plus a margin before deciding the deploy failed.
for i in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' \
    "$(docker compose ps -q bot)" 2>/dev/null || echo starting)"
  if [ "$status" = "healthy" ]; then
    echo "    healthy after ${i}0s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: bot did not become healthy. Recent logs:" >&2
    docker compose logs --tail 40 bot >&2
    exit 1
  fi
  sleep 10
done

echo "==> Deployed $(git rev-parse --short HEAD)"
docker compose ps
