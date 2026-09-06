# Telegram Assistant Bot

A Telegram bot powered by [DeepSeek](https://api-docs.deepseek.com/) that summarizes activity in group chats, lets users search past messages, and offers premium subscriptions paid with Telegram Stars.

## Features

- `/start` — welcome message and main menu
- `/help` — the full guide: how to connect a group or a channel, what each command does, and what the free plan covers
- `/summary [hours]` — AI-generated summary of a group's recent activity. Run inside a group to summarize it directly, or in DM to pick from your linked groups.
- `/find <query>` — search a group's message history (or across all your linked groups, from DM)
- `/filter` — pick topics, and add keywords of your own, that get highlighted as a separate "matches your filters" block in summaries. Topics are toggles and free for everyone; keywords are a second screen (1 on the free plan, 20 with premium) where ➕ takes a whole list in one message (one per line or comma separated, phrases included) and 🗑 removes whatever you tick. Keywords match as stems, so `release` also finds `releases`
- `/channels` — follow public Telegram channels and summarize them alongside your groups (1 on the free plan, 20 with premium). The list is a keyboard: tap channels to select them, 🗑 removes the selection, ➕ asks for the next one by @name or link. `/addchannel` and `/removechannel` still take a handle directly.
- `/digest` — premium: configure an automatic daily digest, delivered by DM at a chosen hour. Set a timezone once and all 24 hours are offered in your own clock; leave it unset and the original four UTC hours are still what you get
- `/subscribe` — buy a premium plan with Telegram Stars (native `XTR` payments, no external provider needed)
- `/status` — your plan and expiry, summaries used today, and how many groups, channels and keywords are active against your allowance, with anything past it marked locked
- `/language` — switch interface language (English / Русский)
- `/privacy` — what the bot stores, who sees it, and how long it's kept
- `/forgetme` — permanently delete your own stored messages and settings, and opt out of future collection in the same step
- `/pause` / `/resume` — **group admins only**: stop and restart message collection for a whole chat, without removing the bot
- `/stats [days]` — admin-only: usage, free→paid and reminder→renewal conversion (default 30 days)
- `/refund <charge_id>` — admin-only: refund a Stars payment and mark that subscription refunded
- `/grant <user_id> <days>` — admin-only: comp someone a subscription
- `/revoke <user_id>` — admin-only: take back every active subscription a user has
- `/spend` — admin-only: today's DeepSeek usage against the daily cap; `/spend allow <n>` adds room for today, `/spend reset` zeroes the counter

Everything except the admin commands is published to Telegram's "/" menu at startup by `publishCommandMenu()` in [`src/bot.js`](src/bot.js), in each supported language, with descriptions from the `commands.*` translations. `/stats`, `/refund`, `/grant` and `/revoke` are left out on purpose, and reply with nothing at all to a non-admin: not advertising them is what keeps their existence undiscoverable.

The user-facing copy lives entirely in [`src/locales/en.js`](src/locales/en.js) and [`src/locales/ru.js`](src/locales/ru.js). Every limit it quotes is interpolated from `FREE_LIMITS` / `PREMIUM_LIMITS` rather than typed into the sentence, so the instructions cannot drift from what the code actually allows. Tests in [`test/i18n.test.js`](test/i18n.test.js) hold the two locales to the same keys and placeholders, check that every command named in the greeting or the guide is one the bot really answers, and check that the guide still fits in a single Telegram message with balanced Markdown.

## Free vs. premium

| | Free | Premium |
|---|---|---|
| `/summary` calls per day | 3 | Unlimited |
| Lookback window | up to 24h | up to 72h |
| Groups you can run commands in | 1 | Unlimited |
| Public channels you can summarize | 1 | 20 |
| Scheduled daily digest (`/digest`) | ❌ | ✅ |

Limits are defined in [`src/models/subscription.js`](src/models/subscription.js) (`FREE_LIMITS` / `PREMIUM_LIMITS`) and enforced per-requester in [`src/commands/summary.js`](src/commands/summary.js), [`src/commands/find.js`](src/commands/find.js), and [`src/commands/digest.js`](src/commands/digest.js). Daily usage resets at 00:00 UTC. If a user's subscription lapses, their scheduled digest is silently skipped (not deleted) until they resubscribe.

**Channels use the same rule as groups, on a separate allowance**: the earliest N a user added are the ones they can summarize, so a lapsed subscriber keeps their first channel rather than losing all 20 at once. The rest stay saved and come back on resubscribe. Because free is 1 rather than 0, `maxChannels === 0` is **not** a premium test — access is decided per channel by `isChannelWithinLimit`.

**Keywords follow that rule too, and are enforced on the way out**: the earliest N a user added are the ones that match (`allowedKeywords` in [`src/models/filter.js`](src/models/filter.js)), applied in [`src/services/digest.js`](src/services/digest.js) at the single point where a stored filter becomes a matcher — a subscription that lapsed between adding a keyword and running a summary has to be noticed there, not at the screen where it was typed. The `/filter` screen marks the locked ones and keeps them tappable, since removing one is how you get back under the allowance. Topic categories are not gated at all.

**Group-count limit specifics**: a free user's "first group" is whichever tracked group they were *first active in* (earliest `chat_members.joined_at`), not the first one they happen to run a command in. This only gates which chats a given user can personally query — **message ingestion keeps tracking every group the bot is in for every member, regardless of any individual member's plan**, since the group may belong to other, possibly premium, members who still need it working.

## Keyword alerts

Opt-in, off by default, premium-only, and switched on or off with one tap on the `/filter` keywords screen. When a message in a group you are in matches one of your live keywords, the bot DMs you the quoted message with a link back to it.

This is the one feature that changes what the bot is — from something you ask to something that messages you — so everything about it is shaped by not becoming spam: never for your own messages, at most **10 an hour** per person, with a single message explaining the silence when that cap is hit and nothing further until the hour rolls over. Suppressed matches are counted, so the noise is measurable.

**Why this is not a queue job.** The naive shape is O(members × keywords) on every group message. The cheap fix is not BullMQ, it is arithmetic: alerts are opt-in *and* premium, so the set of people who want them is small and usually empty. `keywordAlerts.js` caches that whole set, and the common case costs one `Set` lookup and returns. A queue would move the same work off the request path while making a paid feature depend on Redis being up — worth it if the work were unavoidable, and it is not. Sending is fire-and-forget so ingestion never waits on a Telegram round trip.

`allowedKeywords` is applied on the way out, exactly as `digest.js` does it and for the same reason: a subscription can lapse between adding a keyword and a message arriving. Quoted text goes through `escapeMarkdown` with a plain-text retry — it is written by strangers. A 403 switches that user's alerts off rather than retrying for ever.

## Spend cap

Per-user limits bound what one person can do; `DEEPSEEK_DAILY_WARN_COMPLETIONS` and `DEEPSEEK_DAILY_MAX_COMPLETIONS` bound the **total**. Both optional and both off by default — a cap nobody has chosen is worse than no cap, because it stops the product working at an arbitrary number.

Counted per UTC day in `ai_usage`, keyed by date like `daily_usage`, so it resets at midnight with no job to run. Enforced in `chatCompletion` **before** the request, since the point is not to spend the money, and that is the one choke point every AI call passes through. The warning DMs admins once a day rather than once a call.

Hitting the cap makes `/summary` answer honestly (and not consume the user's daily allowance), and makes the scheduler skip a digest without marking the hour done, so the next tick can still deliver it. `/spend allow <n>` grants room for **today only**.

Counted in completions rather than tokens because that is the unit an operator can reason about; tokens are recorded and reported so the two can be calibrated against each other.

**The test suite cannot reach the real API.** Under `NODE_ENV=test` the DeepSeek base URL points at a closed port, so an un-stubbed call fails fast instead of quietly succeeding against the developer `.env` in the repo root. Tests that mean to exercise that path stub the exported `client.post`; patching axios's prototype does **not** work, because `axios.create()` binds its methods.

## Timezones

Users can store a **fixed UTC offset** (`users.tz_offset_minutes`), offered from `/digest` beside the times rather than in front of them — it is a convenience, not a required setting, so an unset offset still shows exactly the four UTC hours it always did.

**The scheduler never sees it.** `scheduled_digests.hour_utc` remains the stored value and the only thing the hourly tick compares; the offset decides what a button is labelled and which `hour_utc` a tap corresponds to. Changing timezone therefore relabels an existing digest without moving it.

Fixed offsets rather than IANA zones, deliberately: with a named zone a stored `hour_utc` would silently mean a different local time twice a year, and every row would need rewriting on each DST transition — or the tick would have to resolve the zone per digest at send time. The price is that someone in a DST-observing country is an hour out for part of the year and changes it themselves. [`src/utils/timezone.js`](src/utils/timezone.js) carries that decision in a comment.

Half-hour offsets are included and handled exactly, because the picker enumerates *from* `hour_utc` and labels each with the local time it lands on. At UTC+05:30 the options really are 08:30, 09:30 and so on — offering "09:00" would promise a delivery time the hourly tick cannot produce.

## DeepSeek response caching

The actual DeepSeek call in [`src/services/digest.js`](src/services/digest.js) is cached per `(chat, lookback hours)`, keyed by a fingerprint of the newest message id + message count in that window — so it invalidates automatically the moment a new message arrives or one ages out of the window, with no TTL to tune. This means concurrent `/summary` requests for the same chat (or a scheduled digest landing on a window a user already summarized) reuse the cached text instead of paying for a second API call. Per-user highlight filters are never cached — they're computed fresh every time since they depend on the requester's own `/filter` settings.

## Usage/conversion analytics

Every meaningful funnel moment — `/start`, a new group getting linked, a summary request, a paywall block (daily limit / group limit / premium-only feature), a scheduled digest delivery, viewing `/subscribe`, and a completed purchase — is logged to an `events` table by [`src/services/analytics.js`](src/services/analytics.js). Instrumentation is fire-and-forget: `track()` swallows and logs its own errors so a broken analytics write can never break the feature it's measuring.

Run `/stats` (restricted to the Telegram user IDs in `ADMIN_USER_IDS`) to get a report in DM: event counts with unique-user counts, plus the number that matters most for pricing decisions — **of the users who ever hit a paywall (daily limit, group limit, or a premium-only command), how many went on to actually subscribe**. Non-admins get no reply at all rather than an "unauthorized" message, so the command's existence isn't discoverable.

## How group tracking works

1. Add the bot to a group. It registers the chat and posts a setup message.
2. **Disable privacy mode** for the bot via [@BotFather](https://t.me/BotFather) → `/setprivacy` → *Disable*. Without this, Telegram only forwards the bot messages that mention/reply to it, so it can't see general chat activity to summarize.
3. Anyone who sends a message in the group gets linked to it, so they can also run `/summary` and `/find` from a private DM with the bot.
4. **Captions count as messages.** A photo, video or file posted with a caption stores the caption text (never the file), flagged with `messages.is_caption` and rendered in the AI transcript behind a `[media] ` prefix so the model reads it as describing an image. The flag is a column rather than part of the text, so that marker never appears in `/find` results or filter highlights. Media with no caption is not stored at all.
4. Removing the bot from a group (or it being kicked) deactivates tracking for that chat, and its stored messages are purged after a grace period (see below).

## How channel summaries work

A bot cannot see a channel it hasn't been added to, and cannot enumerate what a user subscribes to — Telegram exposes neither through the Bot API. So `/addchannel` reads a channel's own public web preview (`https://t.me/s/<name>`), which is the only unauthenticated, first-party view of a public channel. This is why **only public channels work**: private ones would require holding a user's Telegram session, which is an account-takeover credential this project deliberately does not store.

Posts are fetched at request time and **never written to the database** ([`src/services/channelSource.js`](src/services/channelSource.js) → [`src/services/digest.js`](src/services/digest.js)). Only the generated summary is cached, using the same fingerprint scheme as groups. That keeps third-party content out of every backup, and means `/find` covers groups only — there is no channel history to search.

Two constraints worth knowing if you change this code:

- **Handles are validated before any fetch** (`normalizeHandle`), because the value is interpolated into a URL the server requests. Redirects are not followed, which is both the SSRF control and how a private/nonexistent channel is detected (Telegram answers `302`).
- **Channel rows get synthetic positive IDs** from `CHANNEL_ID_BASE`, while real Telegram group/channel IDs are always negative. A collision would serve one chat's content to another chat's members, so the two ID spaces are kept disjoint by construction and asserted in `test/channels.test.js`.

## Localization

The bot ships with English and Russian (`src/locales/`). A new user's language is seeded from their Telegram client's `language_code` on first contact, so their very first reply is already localized; `/language` overrides it and the choice is stored on `users.language`.

**Summaries are generated in the user's language**, not the chat's — a Russian speaker in an English-language group gets a Russian summary. This is why `digest_cache` is keyed by `(chat_id, hours, language)`: the same conversation summarized for two languages is two different artifacts, and without language in the key they would overwrite each other.

Adding a language:

1. Copy `src/locales/en.js` to `src/locales/<code>.js` and translate the values. Keep `aiPromptLanguage` as the language's **English** name — it goes into the DeepSeek prompt.
2. Register it in the `LOCALES` map in [`src/utils/i18n.js`](src/utils/i18n.js).

`npm test` then enforces that the new locale defines every key the English one does, and that no string drops a `{placeholder}` — a missing key falls back to English, and a missing key entirely renders as the key itself so gaps are visible rather than silent.

Two things to be careful about when touching translations:

- **Reply-keyboard buttons** are matched by their text, so handlers register `allTranslations('menu.x')` rather than a single string. A user who switches language still has the old keyboard rendered client-side until it's replaced, so every variant must keep working.
- **Filter category keys** (`Tech`, `Business`, …) stay English in the database and are only translated for display — switching language must not silently drop a user's saved filters. What each category *matches* is a bilingual vocabulary in [`src/services/filterMatcher.js`](src/services/filterMatcher.js), not the category's own name: it is the message language that decides a match, not the interface language, since someone reading the bot in Russian may well sit in an English-speaking group. User keywords are stored verbatim as typed and matched as stems.

## Privacy & data retention

Full policy: [PRIVACY.md](PRIVACY.md). Users can run `/privacy` in Telegram for a summary, and `/forgetme` to delete their own data.

This bot stores other people's group messages and sends them to a third-party AI service, so the retention rules are enforced in code, not just documented:

- Group messages are deleted after `MESSAGE_RETENTION_DAYS` (default **90**). Summaries only ever look back 72h, so this window exists purely to keep `/find` useful — shorten it if search history matters less to you than holding less data.
- When the bot is removed from a group, that chat's messages are purged after `PURGE_AFTER_REMOVAL_DAYS` (default **7**). The grace period means an accidental removal doesn't destroy history; re-adding the bot within it cancels the pending purge.
- Both sweeps run hourly on a plain `setInterval` inside the bot process (`startRetentionSweeps` in `src/services/scheduler.js`), plus once at startup. **They do not depend on Redis** — a promise made in a privacy policy should not stop being kept because a cache is down, and that failure is invisible from the outside: the bot answers normally the whole time. The Redis-backed hourly tick still calls the sweep too, but a five-minute gap guard makes the second caller a no-op.
- The timestamp of the last successful sweep is stored in `app_state` and shown in `/stats`, so "is retention actually running?" has an answer that isn't grepping logs. If no sweep has succeeded in 24 hours, the bot logs a warning.
- `/forgetme` deletes a user's messages, group links, filters, digests, and usage counters, and anonymizes their analytics events. It deliberately keeps their subscription record so billing history and remaining paid time survive, and it invalidates cached summaries for affected chats so deleted text doesn't live on inside a cached summary.

The bot posts a data-collection notice when it joins a group, again when new members join (throttled to once per 24h per group so an active group is not spammed), and puts a one-line footer naming itself and linking `/privacy` under every group summary. Members can stop the bot storing their own messages anywhere from `/privacy`; group admins can `/pause` collection for the whole chat. The member opt-out and the paused-chat flag are checked in `src/services/ingestionPolicy.js` before every `saveMessage`, cached in memory because that runs on every group message the bot sees. If you change the retention defaults, update [PRIVACY.md](PRIVACY.md) to match — the `/privacy` command reads the live config, but the policy file does not.

## Stack

- [Telegraf](https://telegraf.js.org/) — Telegram Bot API framework
- [`node:sqlite`](https://nodejs.org/api/sqlite.html) — built-in SQLite storage (no native build step required; needs Node.js >= 22.5, run with `--experimental-sqlite` on Node < 24)
- [BullMQ](https://docs.bullmq.io/) + Redis — background job queue and the hourly scheduler that delivers daily digests (`src/services/scheduler.js`). Redis must be running for scheduled digests to fire; if it's down, on-demand `/summary` and `/find` keep working, they just don't depend on it.
- [Zod](https://zod.dev/) — schema validation
- [Winston](https://github.com/winstonjs/winston) — logging

## Getting started

1. Copy `.env.example` to `.env` and fill in:
   - `BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
   - `DEEPSEEK_API_KEY` — from the DeepSeek platform
2. Install dependencies:

   ```bash
   npm install
   ```

3. Start Redis (required for the job queue):

   ```bash
   docker compose up -d redis
   ```

4. Run the bot:

   ```bash
   npm start
   ```

   Or with auto-reload during development:

   ```bash
   npm run dev
   ```

## Tests

```bash
npm test
```

Uses Node's built-in test runner (`node:test`) — no extra dependencies. Every test file spins up its own throwaway SQLite database in the OS temp dir and stubs the DeepSeek/Telegram network calls, so the suite needs no real credentials, Redis, or network access, and is safe to run repeatedly. Covers the database layer, digest caching/invalidation, the free-vs-premium gating rules (daily limit, lookback cap, group-count limit) exercised through the real command handlers, the scheduler's due-digest logic including subscription lapse handling, the analytics event log including the paywall→purchase conversion calculation and the `/stats` admin gate, and the localization layer (locale key parity, placeholder parity, and menu-button detection).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request:

- **Tests** on Node 22.x and 24.x. 22.x is what the Dockerfile runs; 24.x is there to catch breakage early as `node:sqlite` graduates out of experimental.
- **Docker build**, which also asserts the image runs as the non-root `node` user and that no `.env` was baked into it — a `.dockerignore` regression would otherwise silently ship secrets into an image layer.

The test job deliberately needs **no secrets**: no `BOT_TOKEN`, no `DEEPSEEK_API_KEY`, no Redis, no network. If it ever starts requiring one, that means a stub has stopped covering a real call.

Note that `.gitattributes` forces LF line endings. This is load-bearing rather than cosmetic: the repo is developed on Windows, and a multi-line `run: |` block checked out with CRLF fails on a Linux runner with `$'\r': command not found`.

## Running with Docker Compose

```bash
docker compose up -d --build
```

This starts Redis and the bot together. The SQLite database is persisted to `./data/bot.db` on the host.

**Production hardening in place** (all verified against a real build/run, not just reviewed):

- The image runs as the non-root `node` user, installs via `npm ci` for reproducible builds, and `.dockerignore` keeps `.env`, `node_modules`, `test/`, and `.git` out of the build context entirely — a local `.env` sitting next to the Dockerfile can never end up baked into an image layer.
- `NODE_ENV` is forced to `production` in `docker-compose.yml` regardless of what your local `.env` says, so logs are always structured JSON (winston) rather than the dev-friendly colorized format.
- Since this bot has no HTTP server (long-polling only), Docker can't health-check a port. Instead the running process touches a heartbeat file every 30s (`src/utils/heartbeat.js`), and `healthcheck.js` is what Docker's `HEALTHCHECK` actually runs — `docker compose ps` will show `unhealthy` if the event loop ever wedges without crashing outright, not just if the process exits.
- `redis`'s own healthcheck gates the bot's startup (`depends_on: condition: service_healthy`) — the bot won't start racing against a Redis that's still booting.
- `stop_grace_period: 15s` gives BullMQ's worker shutdown and Telegraf's polling stop room to finish cleanly on `docker compose stop`/`down` before Docker sends `SIGKILL`.

**Known caveat — bind-mount permissions on Linux hosts**: `./data` is bind-mounted into the container so `bot.db` stays accessible on the host. On Docker Desktop (Windows/Mac) this "just works" because of how those platforms translate bind-mount permissions. On a native Linux host, if `./data` doesn't already exist (or is owned by root) before the first `docker compose up`, the non-root container user (`node`, uid 1000) may not be able to write to it. Fix once, before first run:

```bash
mkdir -p data && sudo chown 1000:1000 data
```

**Backups**: the SQLite database is the only copy of your data — there's no replication. Since it runs in WAL mode, a plain file copy of `bot.db` alone can miss data still sitting in `bot.db-wal`. Take a consistent backup without stopping the bot using SQLite's own `VACUUM INTO` (verified working):

```bash
docker compose exec bot node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('./data/bot.db'); db.exec(\"VACUUM INTO './data/backup.db'\"); db.close();"
```

or simply stop the bot briefly and copy `bot.db`, `bot.db-wal`, and `bot.db-shm` together.

## Deploying to a server

### First-time setup

1. **Provision** a small Linux VPS (1 vCPU / 1 GB RAM is plenty — the workload is one Node process plus Redis) and install Docker with the Compose plugin.

2. **Copy the project** across (`git clone`, or `rsync` the directory excluding `node_modules` and `data`).

3. **Create the data directory with the right owner** — do this *before* the first `docker compose up`, or the non-root container user won't be able to write to it:

   ```bash
   mkdir -p data && sudo chown 1000:1000 data
   ```

4. **Create `.env`** from `.env.example` and fill in `BOT_TOKEN`, `DEEPSEEK_API_KEY`, and `ADMIN_USER_IDS` (your own Telegram user ID, so `/stats` works). Lock it down: `chmod 600 .env`.

5. **Configure the bot in [@BotFather](https://t.me/BotFather)**:
   - `/setprivacy` → **Disable** (required — without it the bot can't see group messages)
   - `/setcommands` — paste the list below so commands autocomplete for users
   - `/setdescription` and `/setabouttext` — mention that the bot reads group messages, and link your privacy policy

   ```
   start - Get started and see the main menu
   summary - AI summary of recent group activity
   find - Search past messages
   filter - Choose keywords to highlight
   digest - Set up a daily digest (premium)
   subscribe - Unlock premium features
   language - Change language / Сменить язык
   privacy - What I store and how to delete it
   forgetme - Delete my stored data
   ```

   BotFather also supports per-language command lists — you can repeat `/setcommands` with the Russian locale selected to give Russian-language clients localized command descriptions.

6. **Start it**:

   ```bash
   docker compose up -d --build
   docker compose ps          # both services should read (healthy)
   docker compose logs -f bot
   ```

`restart: unless-stopped` is already set on both services, so they come back automatically after a reboot or crash.

### Updating

```bash
git pull
docker compose up -d --build
```

The bot handles `SIGTERM` cleanly and schema migrations run automatically at startup, so this is a safe in-place update. Take a backup first (see above) if the release touches the schema.

### Verifying a deploy

```bash
docker compose ps                                    # both (healthy)
docker compose logs bot | grep "Bot launched"        # confirms Telegram connection
docker compose exec redis redis-cli ZRANGE bull:scheduler-jobs:repeat 0 -1 WITHSCORES
```

The last command should print a timestamp for the next top-of-the-hour tick — that job drives scheduled digests, so if it's missing, they will not be delivered. Retention no longer depends on it; check the last sweep time in `/stats` instead.

### Operational notes

- **Logs** are written to stdout and captured by Docker's json-file driver, which grows without bound by default. Cap it in `/etc/docker/daemon.json` (`"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}`) and restart Docker, or logs will eventually fill the disk.
- **Backups** should be automated — a daily cron running the `VACUUM INTO` command above, copied off the box. The SQLite file is the only copy of your data.
- **Redis** holds only the job queue, not durable product data. Losing it costs you the repeatable-job registration, which is re-created on the next bot start.
- **Monitoring**: the healthcheck marks the container unhealthy if the heartbeat goes stale, but nothing acts on that by itself. For real alerting, watch `docker inspect --format '{{.State.Health.Status}}'` from an external uptime check, or add a restart policy watcher.

## Project structure

```
healthcheck.js        Standalone script run by Docker's HEALTHCHECK (checks heartbeat freshness)
src/
├── bot.js            Bot initialization & launch
├── config.js         Environment variables
├── commands/         Command handlers (start, summary, find, filter, subscribe, digest, stats, privacy, language)
├── locales/           Translations (en, ru)
├── keyboards/         Inline/reply keyboards
├── middleware/        Auth, request logging, rate limiting, group message ingestion
├── services/           DeepSeek client, SQLite database, BullMQ queue + hourly digest scheduler, Telegram Stars payments, analytics event log
├── models/             Zod schemas
└── utils/              Logger, formatting helpers, heartbeat writer, i18n
```

## Telegram Stars payments

Subscriptions use Telegram's native Stars payments (currency `XTR`), so no external payment provider or `provider_token` is required. Plans are defined in [`src/models/subscription.js`](src/models/subscription.js).

**Expiry reminders.** Three DMs ride the hourly tick — three days out, one day out, and on the day it lapses — each with a Renew button. Delivery is recorded per (subscription, stage) in `subscription_reminders`, so a retried tick cannot re-notify, and each new period runs its own set. Someone who has already renewed is skipped, as is a comped row with no expiry. `/stats` reports the reminder→renewal rate.

**Refunds and comps.** `/refund` calls Telegram's `refundStarPayment` and only marks the row `refunded` if Telegram accepted — marking first would take away access on a call that might fail. `/grant` writes a comped row with a **NULL** `telegram_charge_id`; a placeholder id there collides with the next comp on the partial unique index, which is exactly how the live database ended up unable to create that index. `getActiveSubscription` filters on `status = 'active'`, so `refunded` and `revoked` rows stop granting access the moment they are written while surviving as billing history.
