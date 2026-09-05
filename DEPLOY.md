# Deploying to a VPS

Target: a fresh Ubuntu 22.04 / 24.04 server. Everything runs as two Docker
containers (the bot and Redis) managed by `docker compose`.

## What this needs

The bot talks to Telegram over **long polling** — it dials out and never
accepts inbound connections. So there is **no domain, no TLS certificate, no
nginx and no open port except SSH**. That removes most of the usual deploy
work.

Sizing, measured against the real schema at 90-day retention:

| Groups tracked | Retained message data |
|---|---|
| 10 | ~22 MB |
| 100 | ~216 MB |
| 500 | ~1 GB |

RAM: Node ~150 MB + Redis ~50 MB. **1 vCPU / 1–2 GB / 20 GB disk is ample** —
the entry tier at any provider. The workload is I/O-bound waiting on the
DeepSeek API, not CPU-bound.

## 1. Server setup (once)

SSH in as root, then:

```bash
curl -fsSL -o bootstrap.sh https://raw.githubusercontent.com/OlegMarkov/TelegramGroup-AI-assistant/main/deploy/bootstrap.sh
```

For a private repo that URL won't work unauthenticated — simplest is to copy
the file up from your machine instead:

```bash
scp deploy/bootstrap.sh root@<server-ip>:/root/
```

Then on the server:

```bash
bash bootstrap.sh deploy
```

This installs Docker, creates a non-root `deploy` user in the `docker` group,
enables a firewall allowing only SSH, and turns on unattended security
upgrades.

**Then harden SSH — carefully.** The script deliberately does *not* do this,
because a mistake locks you out of the box permanently. Follow the instructions
it prints: verify key login as `deploy` in a second terminal *first*, and keep
a session open while you change `sshd_config`.

## 2. Give the server read access to the private repo

Generate a deploy key **on the server** as the `deploy` user:

```bash
ssh-keygen -t ed25519 -C "vps-deploy" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Add that public key to the repo on GitHub under
**Settings → Deploy keys → Add deploy key**. Leave *"Allow write access"*
unchecked — the server only ever pulls.

A deploy key is scoped to this one repository, unlike a personal access token,
so a compromised server can't reach the rest of your account.

## 3. Clone and configure

```bash
git clone git@github.com:OlegMarkov/TelegramGroup-AI-assistant.git
cd TelegramGroup-AI-assistant
```

Create `.env` on the server — it is **not** in git and never should be:

```bash
cp .env.example .env
nano .env
```

Fill in `BOT_TOKEN`, `DEEPSEEK_API_KEY`, and `ADMIN_USER_IDS` (your Telegram
user ID, so `/stats` works). Leave `REDIS_HOST`/`REDIS_PORT` alone —
`docker-compose.yml` overrides them to reach the Redis container.

```bash
chmod 600 .env
```

**Create the data directory with the right ownership before the first start:**

```bash
mkdir -p data && sudo chown 1000:1000 data
```

The container runs as the non-root `node` user (uid 1000). On Linux, a
bind-mounted directory owned by root leaves that user unable to write the
database. Docker Desktop on Windows/Mac papers over this, so it only shows up
on a real server.

## 4. Start it

```bash
docker compose up -d --build
docker compose ps
```

Both services should report `healthy`. Then:

```bash
docker compose logs -f bot
```

Expect `Bot launched as @<name>`. Message the bot on Telegram to confirm.

## 5. Updating

```bash
./deploy/deploy.sh
```

Backs up the database, fast-forwards to `origin/main`, rebuilds, restarts, and
waits for the health check — failing loudly with logs if the new version never
becomes healthy.

## 6. Backups

The SQLite file is the only copy of your data; there is no replication.

```bash
./deploy/backup.sh
```

Uses `VACUUM INTO`, which snapshots a live WAL-mode database consistently. A
plain `cp` of `bot.db` is **not** safe — recent writes may still be in
`bot.db-wal` and would be silently missing.

Schedule it (`crontab -e` as `deploy`). Use an absolute path — cron runs with a
minimal environment and no shell expansion of `~`:

```
0 3 * * * cd /home/deploy/TelegramGroup-AI-assistant && ./deploy/backup.sh >> /home/deploy/backup.log 2>&1
```

`bootstrap.sh` installs and enables `cron` and sets the clock to UTC, since
minimal Ubuntu cloud images ship without cron and often default to a timezone
with DST — which would silently shift this job by an hour twice a year.

To confirm cron actually fires for the `deploy` user (worth doing once, since
a cron job that never runs looks identical to one that runs successfully):

```bash
(crontab -l; echo "* * * * * date -u > ~/.cron-alive") | crontab -
# wait ~70s, then:
cat ~/.cron-alive && crontab -l | grep -v cron-alive | crontab -
```

### Off-site copies

The backups above sit on the same server as the data they protect, which covers
a bad deploy or an accidental delete but not losing the VPS itself.

There are two off-site paths, and only one of them needs somebody to be awake.

#### Object storage (encrypted, no workstation needed)

`deploy/offsite-backup.sh` runs at the end of every `backup.sh`, so it is on the
same cron schedule and there is nothing extra to remember. It encrypts the
newest snapshot, uploads it, and prunes old remote copies.

Install `rclone` on the server and configure one remote — Backblaze B2, any
S3-compatible bucket, or anything else rclone speaks:

```bash
sudo apt-get install -y rclone
rclone config          # create a remote called e.g. "b2"
```

Then set these in the server's `.env` (never in the repo — `.dockerignore`
excludes `.env` and `.env.*` from the build context, and `.gitignore` keeps it
out of git):

```
OFFSITE_REMOTE=b2:my-bucket/telegram-bot
OFFSITE_PASSPHRASE=<a long random passphrase>
OFFSITE_KEEP_DAILY=7
OFFSITE_KEEP_WEEKLY=4
```

**Keep a copy of `OFFSITE_PASSPHRASE` somewhere other than this server.** It is
the only thing that can decrypt those uploads; losing it with the VPS loses the
backups too, which would defeat the entire point.

Encryption is `openssl enc -aes-256-cbc` with PBKDF2 at 600,000 iterations,
applied before anything leaves the box. The passphrase is passed via the
environment rather than the command line, so it does not appear in `ps`. An
empty passphrase is **refused** rather than treated as "upload in the clear":
the database holds other people's message content, and PRIVACY.md promises it
is handled carefully.

Each run writes `daily/backup-<stamp>.db.enc`, plus `weekly/<iso-week>-…` if
that week has no copy yet — keyed on the ISO week rather than on a weekday, so
a run missed on Monday still produces that week's copy. Daily copies are pruned
after 7 days and weekly after 4 weeks.

Before uploading, the script decrypts what it is about to send and checks it is
a readable database. Encrypting the right file in a way that cannot be reversed
otherwise stays invisible until the day it matters.

#### Restoring from an off-site copy

```bash
./deploy/restore-offsite.sh --list      # what is in the bucket
./deploy/restore-offsite.sh             # fetch the newest, verify, change nothing
./deploy/restore-offsite.sh --install   # and put it live
```

Without `--install` it touches nothing: it downloads, decrypts, and opens the
file in a **scratch container** using the same `node:sqlite` build the bot runs,
then prints `integrity_check`, row counts per table, and the newest message
timestamp. Verifying with whatever sqlite happens to be on the host would prove
less — the question is whether *the bot* can open this file. The row counts
matter as much as the integrity check: an empty well-formed database passes
`integrity_check` and is not a backup of anything.

**Run it without `--install` occasionally.** A backup nobody has restored is a
hypothesis, not a backup, and this costs nothing to check.

With `--install` it asks for confirmation, stops the bot, moves the current
database aside (kept, not deleted), removes the stale `-wal` and `-shm` files —
leaving those next to a restored database is how a "successful" restore comes
back with the wrong contents — copies the restored file into place, and starts
the bot again.

#### Noticing when backups stop

A cron job that stops firing produces no output, so the absence is invisible.
Each successful upload records a timestamp in `app_state` through the bot, and
the bot — the only always-running process — logs a warning if no off-site backup
has succeeded in 48 hours. `/stats` shows the age of the last one, flagged with
a ⚠️ past that threshold. It stays quiet until a backup has succeeded at least
once, so an unconfigured install is not warned at hourly intervals about a
feature it never switched on.

#### Workstation pull

From a Windows machine:

```bash
powershell -ExecutionPolicy Bypass -File deploy\pull-backups.ps1
```

It downloads only files it doesn't already have (backup filenames are
timestamped and immutable), verifies every bundle with `git bundle verify` and
every database with `PRAGMA integrity_check`, and refuses to prune anything if a
file fails — an unverified backup is not a backup. Local retention defaults to
90 days, deliberately longer than the server's 14, because the off-site copy is
the one that has to survive a problem noticed late.

Register it to run daily:

```bash
powershell -ExecutionPolicy Bypass -Command "Register-ScheduledTask -TaskName TelegramBot-PullBackups -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -ExecutionPolicy Bypass -File \"C:\path\to\deploy\pull-backups.ps1\"') -Trigger (New-ScheduledTaskTrigger -Daily -At 04:00) -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable)"
```

`-StartWhenAvailable` matters on a laptop: without it, a run missed because the
machine was asleep is skipped entirely rather than retried.

Note that **`rsync` is not present on either side** (neither Git Bash nor the
Ubuntu image ships it), which is why this uses `scp`. At ~85 KB per file the
lack of delta transfer is irrelevant.

To restore from a local or pulled copy, `git clone` a bundle for the source, and
copy a `backup-*.db` over `data/bot.db` with the bot stopped — removing
`bot.db-wal` and `bot.db-shm` first. For the object-storage copy, use
`deploy/restore-offsite.sh`, which does all of that and verifies the result.

## What "healthy" means

`docker compose ps` reporting `healthy` means the bot is **still consuming
Telegram updates**, not merely that the process exists.

The bot refreshes a heartbeat file every 30s, but only while Telegraf's polling
loop is running; `healthcheck.js` fails once that file is more than 90s old. If
polling stops, two things happen: the heartbeat goes stale (container reports
unhealthy) and the process exits non-zero, so `restart: unless-stopped` brings
it back automatically.

This distinction matters because the earlier heartbeat fired on a plain timer,
which meant a bot that had silently stopped receiving updates looked exactly
like a healthy bot with no traffic.

Residual gap worth knowing: this detects a poller that has **stopped**, not one
that is **wedged** mid-request without ever returning. If users report silence
while the container claims healthy, compare `docker compose logs bot` against
Telegram — a bot that is genuinely polling logs `Handled …` lines as traffic
arrives.

## Security notes

- **Redis is bound to `127.0.0.1`** in `docker-compose.yml`, and the bot
  reaches it over the internal Docker network. Never publish it as
  `"6379:6379"` — that binds all interfaces, and an unauthenticated Redis on a
  public IP is among the most heavily scanned targets on the internet.

- **ufw does not protect Docker-published ports.** This is the dangerous part
  of the point above. Docker writes its own iptables rules into the `DOCKER`
  chain, which are evaluated *before* ufw's, so a container port published on
  `0.0.0.0` is reachable from the internet even with `ufw default deny
  incoming` and the port absent from `ufw status`. The loopback binding is
  therefore the actual protection here, not the firewall — do not assume ufw
  is a safety net if you ever change that mapping. To restrict a genuinely
  public container port, add rules to the `DOCKER-USER` chain instead.

- **Verify exposure from somewhere you trust.** A plain TCP connect test can
  lie: some ISPs and corporate networks run middleboxes that complete
  connections to *any* port, so a "port is open" result may be entirely
  fabricated. Sanity-check by probing a port nothing listens on (e.g. 9999) —
  if that also looks open, your vantage point is untrustworthy. Testing from
  the server against its own public IP, or using an external port scanner,
  gives a real answer.
- **Do not open any inbound port other than SSH.** Long polling needs none.
- Docker log output is capped (10 MB × 3 files per container) so logs can't
  fill the disk.
- `.env` holds live credentials: keep it `chmod 600`, and rotate the tokens via
  @BotFather / the DeepSeek console if the server is ever compromised.

## Data residency

You are storing personal data of (largely) Russian users — message text,
display names, Telegram IDs. Russian law 152-ФЗ generally requires such data to
be stored on servers located in Russia. This is worth confirming with someone
qualified before scaling up, since migrating a live database later is far more
painful than choosing the right jurisdiction now. Nothing in this repo depends
on the hosting location.
