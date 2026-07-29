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

These copies sit on the same server, which protects against a bad deploy but
not against losing the VPS. Pull them down periodically:

```bash
rsync -avz deploy@<server-ip>:~/TelegramGroup-AI-assistant/backups/ ./vps-backups/
```

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
