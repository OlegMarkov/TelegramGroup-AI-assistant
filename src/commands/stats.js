const config = require('../config');
const { getFunnelReport } = require('../services/analytics');

const DEFAULT_DAYS = 30;

function isAdmin(userId) {
  return config.adminUserIds.includes(userId);
}

async function statsHandler(ctx) {
  // Silently ignore for non-admins rather than revealing this command exists.
  if (!isAdmin(ctx.from.id)) return;

  const args = ctx.message.text.split(' ').slice(1);
  const requested = Number(args[0]);
  const days = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_DAYS;

  const report = getFunnelReport(days);

  if (report.counts.length === 0) {
    return ctx.reply(`📊 No events recorded in the last ${days} days.`);
  }

  const lines = report.counts.map((c) => `${c.event_type}: ${c.count} (${c.unique_users} unique)`);
  const conversionPct =
    report.paywallHitUsers > 0 ? ((report.convertedFromPaywall / report.paywallHitUsers) * 100).toFixed(1) : '0.0';

  return ctx.reply(
    `📊 *Analytics — last ${days} days*\n\n${lines.join('\n')}\n\n` +
      `💰 *Paywall → purchase*: ${report.convertedFromPaywall}/${report.paywallHitUsers} users who hit a limit converted (${conversionPct}%)\n` +
      `🧾 Total purchasers: ${report.totalPurchasers}`,
    { parse_mode: 'Markdown' }
  );
}

module.exports = (bot) => {
  bot.command('stats', statsHandler);
};
