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
 */

const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const { db, getSummaryFeedbackCounts } = require('../src/services/database');
const { getFunnelReport, getRetentionReport } = require('../src/services/analytics');

const DEFAULT_DAYS = 30;
const DEFAULT_OUT = path.join(path.dirname(path.resolve(config.database.path)), 'usage-snapshot.md');

// Below this, the numbers are anecdote wearing a table's clothing. The figure
// is not statistical — it is the point where a single enthusiastic tester can
// move a conversion rate by ten points, which is what makes a snapshot
// actively misleading rather than merely thin.
const THIN_DATA_EVENTS = 500;

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

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

const days = Number(arg('days', DEFAULT_DAYS)) || DEFAULT_DAYS;
const out = path.resolve(arg('out', DEFAULT_OUT));

const dbPath = path.resolve(config.database.path);
const totalUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const totalEvents = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;

const funnel = getFunnelReport(days);
const { curve, cohorts, dailyActive } = getRetentionReport();
const feedback = getSummaryFeedbackCounts(days);

const thin = totalEvents < THIN_DATA_EVENTS;

const sections = [];

sections.push(`# Usage snapshot

Generated ${new Date().toISOString()} from \`${dbPath}\`, covering the last ${days} days.
Regenerate with \`node --experimental-sqlite scripts/usage-snapshot.js --days=${days}\`.

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

process.stdout.write(`Wrote ${out} (${totalUsers} users, ${totalEvents} events${thin ? ', FLAGGED AS THIN' : ''})\n`);
