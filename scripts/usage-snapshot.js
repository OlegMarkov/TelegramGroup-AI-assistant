/**
 * Write an aggregate usage snapshot the business-analyst agent can read.
 *
 * That agent is deliberately read-only and has no shell, so it cannot query
 * SQLite itself. Handing it the database would be the wrong fix twice over: it
 * would need shell access, and bot.db holds other people's message content.
 * This writes the numbers out instead, so the agent reads a file and the
 * private data never leaves the server. (The agent definitions themselves live
 * in .claude/, which is not committed — this script stands on its own.)
 *
 * Every figure comes from the same report functions /stats calls. That is the
 * point — a second implementation would drift, and it would drift silently
 * toward whichever version nobody was reading. No new SQL here except the two
 * provenance counts, which exist to answer "is this enough data to reason
 * from?" rather than to measure the product.
 *
 *   node --experimental-sqlite scripts/usage-snapshot.js [--days=30] [--out=path]
 *   node --experimental-sqlite scripts/usage-snapshot.js --db=~/TelegramBot-Backups/backup-20260909-030001.db
 *
 * --db reads a database file from elsewhere — a snapshot pulled off the VPS by
 * deploy/pull-backups.ps1, most usefully, since the working data/bot.db on a
 * development machine is a handful of test rows. It is copied to a temp file
 * first and the copy is what gets opened. That is not caution for its own
 * sake: services/database.js opens read-write and runs schema migrations on
 * import, so reading a backup in place would rewrite it — and
 * pull-backups.ps1 is built on backups being immutable, verifying them with
 * PRAGMA integrity_check against exactly that assumption.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DAYS = 30;

// Repo-relative rather than next to whichever database was read: the agent is
// told to look in data/, and a --db run must not scatter snapshots into the
// temp dir where nothing will ever find them.
const DEFAULT_OUT = path.join(__dirname, '..', 'data', 'usage-snapshot.md');

// Below this, the numbers are anecdote wearing a table's clothing. The figure
// is not statistical — it is the point where a single enthusiastic tester can
// move a conversion rate by ten points, which is what makes a snapshot
// actively misleading rather than merely thin.
const THIN_DATA_EVENTS = 500;

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// -- everything to here runs before src/ is imported, on purpose -------------
// config.js reads process.env at import time and database.js opens the file at
// import time, so a --db copy has to be in place before either is required.

const days = Number(arg('days', DEFAULT_DAYS)) || DEFAULT_DAYS;
const out = path.resolve(expandHome(arg('out', DEFAULT_OUT)));
const sourceArg = arg('db', null);

let tempCopy = null;
let sourceLabel = null;

if (sourceArg) {
  const source = path.resolve(expandHome(sourceArg));
  if (!fs.existsSync(source)) {
    process.stderr.write(`No such database: ${source}\n`);
    process.exit(1);
  }

  tempCopy = path.join(os.tmpdir(), `usage-snapshot-${crypto.randomUUID()}.db`);
  fs.copyFileSync(source, tempCopy);

  // A VACUUM INTO snapshot is one self-contained file, but a database copied
  // while its bot was running is not: leaving the WAL behind would silently
  // drop every transaction that had not been checkpointed yet.
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, tempCopy + suffix);
  }

  // dotenv does not override variables that are already set, so this wins over
  // whatever .env says.
  process.env.DATABASE_PATH = tempCopy;
  sourceLabel = source;
}

const config = require('../src/config');
const { db, getSummaryFeedbackCounts } = require('../src/services/database');
const { getFunnelReport, getRetentionReport } = require('../src/services/analytics');

if (!sourceLabel) sourceLabel = path.resolve(config.database.path);

// On exit rather than after the report, so a throw on the way cannot leave a
// copy of the production database sitting in the temp directory.
process.on('exit', () => {
  if (!tempCopy) return;
  try {
    db.close();
  } catch {
    // Already closed, or never opened. The unlink below is the part that matters.
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(tempCopy + suffix, { force: true });
    } catch (error) {
      // Windows refuses to unlink a file something still holds open. Say so
      // rather than failing the run: the snapshot is already written, and a
      // stray copy of the database is worth knowing about.
      process.stderr.write(`Could not remove temp copy ${tempCopy}${suffix}: ${error.message}\n`);
    }
  }
});

function pct(part, whole) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—';
}

function table(headers, rows) {
  if (rows.length === 0) return '_No rows._';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const totalEvents = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;

const funnel = getFunnelReport(days);
const { curve, cohorts, dailyActive } = getRetentionReport();
const feedback = getSummaryFeedbackCounts(days);

const thin = totalEvents < THIN_DATA_EVENTS;

const sections = [];

sections.push(`# Usage snapshot

Generated ${new Date().toISOString()} from \`${sourceLabel}\`${
  tempCopy ? ' (read from a temp copy; the source was not modified)' : ''
}, covering the last ${days} days.
Regenerate with \`node --experimental-sqlite scripts/usage-snapshot.js --days=${days}${
  sourceArg ? ` --db=${sourceArg}` : ''
}\`.

**${totalUsers} ${totalUsers === 1 ? 'user' : 'users'}, ${totalEvents} events recorded all-time.**`);

if (thin) {
  sections.push(`> ⚠️ **Not enough data to conclude from.** Under ${THIN_DATA_EVENTS} events all-time
> means one active tester moves any rate below by several points. Treat every
> percentage here as an illustration of the shape of the funnel, not evidence
> about it. If this is a development database rather than the production VPS,
> say so in your analysis instead of reporting these numbers as usage.`);
}

sections.push(`## Events (last ${days} days)

Counts and the number of distinct users behind them. A high count against a low
user total is one person leaning on a feature, not adoption.

${table(
  ['event', 'count', 'users'],
  funnel.counts.map((c) => [c.event_type, c.count, c.unique_users])
)}`);

sections.push(`## Conversion (last ${days} days)

${table(
  ['funnel', 'converted', 'reached', 'rate'],
  [
    ['Paywall → purchase', funnel.convertedFromPaywall, funnel.paywallHitUsers, pct(funnel.convertedFromPaywall, funnel.paywallHitUsers)],
    ['Trial → paid', funnel.convertedFromTrial, funnel.trialUsers, pct(funnel.convertedFromTrial, funnel.trialUsers)],
    ['Reminder → renewal', funnel.renewedAfterReminder, funnel.remindedUsers, pct(funnel.renewedAfterReminder, funnel.remindedUsers)],
  ]
)}

Total purchasers in the window: ${funnel.totalPurchasers}.`);

sections.push(`## Retention

Rolling: of the users old enough to have come back, how many did.

${table(
  ['window', 'retained', 'eligible', 'rate'],
  curve.map((r) => [`D${r.days}`, r.retained, r.eligible, r.pct === null ? '—' : `${r.pct.toFixed(0)}%`])
)}`);

if (cohorts.length > 0) {
  sections.push(`## Weekly cohorts

${table(
    ['week of', 'new users', 'D1', 'D7'],
    cohorts.map((c) => [
      c.cohort_start,
      c.size,
      c.eligible_d1 > 0 ? pct(c.retained_d1, c.eligible_d1) : '—',
      c.eligible_d7 > 0 ? pct(c.retained_d7, c.eligible_d7) : '—',
    ])
  )}`);
}

if (dailyActive.length > 0) {
  sections.push(`## Daily activity

${table(
    ['day', 'active users', 'events'],
    dailyActive.map((d) => [d.day, d.active_users, d.events])
  )}`);
}

if (feedback.length > 0) {
  sections.push(`## Summary feedback (last ${days} days)

Split by language because the prompt is language-specific; an average hides
the thing worth seeing.

${table(
    ['language', '👍', '👎'],
    feedback.map((f) => [f.language || '?', f.up, f.down])
  )}`);
}

sections.push(`## What is NOT in here

Reaching for one of these means saying so rather than guessing:

- **No message content, usernames or user ids.** Aggregates only, by design.
- **No per-feature configuration counts** — how many people have a digest
  scheduled right now, or follow more than one channel. The event log records
  that they configured it once, never that they still have it.
- **No support tickets, reviews or churn interviews.** Nothing in this repo
  records why anyone left.
- **No revenue.** Stars payouts live in Telegram's statements, not here, and
  the payout rates in \`src/models/subscription.js\` are still unverified
  estimates.`);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${sections.join('\n\n')}\n`, 'utf8');

process.stdout.write(
  `Wrote ${out} (${totalUsers} ${totalUsers === 1 ? 'user' : 'users'}, ${totalEvents} events${
    thin ? ', FLAGGED AS THIN' : ''
  })\n`
);
