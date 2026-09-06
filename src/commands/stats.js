const config = require('../config');
const { getFunnelReport, getRetentionReport } = require('../services/analytics');
const { getAppState, getSummaryFeedbackCounts } = require('../services/database');
const { describeBudget } = require('../services/aiBudget');

const DEFAULT_DAYS = 30;

function isAdmin(userId) {
  return config.adminUserIds.includes(userId);
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function padLeft(value, width) {
  return String(value).padStart(width);
}

function formatPct(pct) {
  return pct === null ? '  -' : `${pct.toFixed(0)}%`;
}

async function statsHandler(ctx) {
  // Silently ignore for non-admins rather than revealing this command exists.
  if (!isAdmin(ctx.from.id)) return;

  const args = ctx.message.text.split(' ').slice(1);
  const requested = Number(args[0]);
  const days = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_DAYS;

  const funnel = getFunnelReport(days);
  const { curve, cohorts, dailyActive } = getRetentionReport();

  if (funnel.counts.length === 0) {
    return ctx.reply(`📊 No events recorded in the last ${days} days.`);
  }

  const sections = [`📊 *Analytics — last ${days} days*`];

  // Event names contain underscores (summary_blocked_daily_limit), which
  // Telegram's Markdown treats as italic delimiters. Code blocks disable
  // entity parsing inside, so no escaping is needed and columns stay aligned.
  const eventRows = funnel.counts
    .map((c) => `${pad(c.event_type, 30)}${padLeft(c.count, 6)}${padLeft(c.unique_users, 7)}`)
    .join('\n');
  sections.push(`\`\`\`\n${pad('event', 30)}${padLeft('count', 6)}${padLeft('users', 7)}\n${eventRows}\n\`\`\``);

  // Retention is a promise in PRIVACY.md, and the way it fails is silently —
  // the bot keeps working while nothing is being deleted. This is the one
  // place that answers "is it actually running?" without reading logs.
  const sweptAt = Number(getAppState('retention_swept_at'));
  const sweptAgo = Number.isFinite(sweptAt) && sweptAt > 0 ? Math.round((Date.now() - sweptAt) / 60000) : null;

  // Backups fail silently by default — a cron job that stops firing produces
  // no output to notice. Reported in hours, because the interesting question
  // is "was it today", not "was it in the last few minutes".
  const backedUpAt = Number(getAppState('offsite_backup_at'));
  const backedUpAgo =
    Number.isFinite(backedUpAt) && backedUpAt > 0 ? Math.round((Date.now() - backedUpAt) / 3600000) : null;

  const budget = describeBudget();
  const budgetLine =
    budget.hardLimit === null
      ? `🤖 *AI today*: ${budget.completions} completions (no cap set)`
      : `🤖 *AI today*: ${budget.completions}/${budget.hardLimit} completions${budget.blocked ? ' ⛔ BLOCKED' : ''}`;

  sections.push(
    [
      budgetLine,
      sweptAgo === null
        ? '🧹 *Retention*: no sweep has completed yet'
        : `🧹 *Retention*: last swept ${sweptAgo} min ago`,
      backedUpAgo === null
        ? '💾 *Off-site backup*: never (not configured?)'
        : `💾 *Off-site backup*: ${backedUpAgo}h ago${backedUpAgo > 48 ? ' ⚠️' : ''}`,
    ].join('\n')
  );

  const conversionPct =
    funnel.paywallHitUsers > 0 ? ((funnel.convertedFromPaywall / funnel.paywallHitUsers) * 100).toFixed(1) : '0.0';
  sections.push(
    `💰 *Paywall → purchase*: ${funnel.convertedFromPaywall}/${funnel.paywallHitUsers} (${conversionPct}%)\n` +
      `🧾 Total purchasers: ${funnel.totalPurchasers}`
  );

  // Whether expiry reminders actually save subscriptions, which is the only
  // question that decides if they are worth sending.
  const reminderPct =
    funnel.remindedUsers > 0 ? ((funnel.renewedAfterReminder / funnel.remindedUsers) * 100).toFixed(1) : '0.0';
  sections.push(`🔔 *Reminder → renewal*: ${funnel.renewedAfterReminder}/${funnel.remindedUsers} (${reminderPct}%)`);

  // Whether the summaries are any good, which nothing measured before. Split
  // by language because the prompt is language-specific: an average across both
  // hides the thing worth seeing when a prompt change is being judged.
  const feedback = getSummaryFeedbackCounts(days);
  if (feedback.length > 0) {
    const totals = feedback.reduce((acc, row) => ({ up: acc.up + row.up, down: acc.down + row.down }), {
      up: 0,
      down: 0,
    });
    const perLanguage = feedback.map((row) => `${row.language || '?'} ${row.up}/${row.down}`).join('   ');
    sections.push(`👍 *Summary feedback*: ${totals.up} up / ${totals.down} down\n\`\`\`\n${perLanguage}\n\`\`\``);
  }

  // Rolling retention: of users old enough to have returned, how many did.
  const curveRows = curve
    .map((r) => `D${pad(r.days, 4)}${padLeft(formatPct(r.pct), 5)}   ${r.retained}/${r.eligible}`)
    .join('\n');
  sections.push(
    `🔁 *Retention* (rolling; only users old enough to qualify are counted)\n` +
      `\`\`\`\n${curveRows}\n\`\`\``
  );

  if (cohorts.length > 0) {
    const cohortRows = cohorts
      .map((c) => {
        const d1 = c.eligible_d1 > 0 ? `${Math.round((c.retained_d1 / c.eligible_d1) * 100)}%` : '-';
        const d7 = c.eligible_d7 > 0 ? `${Math.round((c.retained_d7 / c.eligible_d7) * 100)}%` : '-';
        return `${pad(c.cohort_start, 12)}${padLeft(c.size, 5)}${padLeft(d1, 7)}${padLeft(d7, 7)}`;
      })
      .join('\n');
    sections.push(
      `👥 *Weekly cohorts* (week joined)\n` +
        `\`\`\`\n${pad('week of', 12)}${padLeft('new', 5)}${padLeft('D1', 7)}${padLeft('D7', 7)}\n${cohortRows}\n\`\`\``
    );
  }

  if (dailyActive.length > 0) {
    const activeRows = dailyActive
      .slice(0, 14)
      .map((d) => `${pad(d.day, 12)}${padLeft(d.active_users, 7)}${padLeft(d.events, 8)}`)
      .join('\n');
    sections.push(
      `📈 *Daily activity*\n` +
        `\`\`\`\n${pad('day', 12)}${padLeft('users', 7)}${padLeft('events', 8)}\n${activeRows}\n\`\`\``
    );
  }

  return ctx.reply(sections.join('\n\n'), { parse_mode: 'Markdown' });
}

module.exports = (bot) => {
  bot.command('stats', statsHandler);
};
