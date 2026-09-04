const {
  getSummaryUsageToday,
  getUserGroups,
  getUserChannels,
  getAllowedUserChats,
  getAllowedUserChannels,
  getUserFilters,
  getUserScheduledDigests,
} = require('../services/database');
const { getLimits } = require('../models/subscription');
const { allowedKeywords } = require('../models/filter');
const { planLabel } = require('../keyboards');
const { escapeMarkdown, isGroupChat } = require('../utils/formatters');
const { t } = require('../utils/i18n');
const { subscribeHandler } = require('./subscribe');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

/**
 * PREMIUM_LIMITS holds real Infinity values, and interpolating one prints the
 * literal string "Infinity" at the user. Every limit that reaches copy goes
 * through here.
 */
function renderLimit(lang, limit) {
  return Number.isFinite(limit) ? String(limit) : t(lang, 'status.unlimited');
}

/**
 * One "N of M" line, with the overflow marked.
 *
 * Free limits are allowances, not switches: a lapsed subscriber keeps all
 * twenty channels and the earliest one stays live. The count that matters is
 * therefore how many are *working*, with the rest shown as locked rather than
 * quietly missing — the same convention /channels and /filter already use.
 */
function allowanceLine(lang, key, { allowed, total, limit }) {
  const locked = Math.max(0, total - allowed);
  return t(lang, key, {
    allowed,
    limit: renderLimit(lang, limit),
    locked: locked > 0 ? t(lang, 'status.lockedSuffix', { count: locked }) : '',
  });
}

function formatHour(hourUtc) {
  return `${String(hourUtc).padStart(2, '0')}:00 UTC`;
}

function buildStatus(ctx) {
  const lang = ctx.state.lang;
  const userId = ctx.from.id;
  const subscription = ctx.state.subscription;
  const limits = getLimits(subscription);

  const groups = getUserGroups(userId);
  const channels = getUserChannels(userId);
  const keywords = getUserFilters(userId).keywords || [];

  const allowedGroups = getAllowedUserChats(userId, limits.maxGroups);
  const allowedChannels = getAllowedUserChannels(userId, limits.maxChannels);
  const liveKeywords = allowedKeywords(keywords, limits.maxKeywords);

  const lines = [t(lang, 'status.header'), ''];

  if (subscription) {
    // A comped or granted row can have no expiry at all, which is not the same
    // statement as a date and must not be rendered as "until null".
    lines.push(
      subscription.expires_at
        ? t(lang, 'status.planPremium', {
            plan: planLabel(lang, subscription.plan),
            // Date only. Stored as either an ISO string or SQLite's
            // "YYYY-MM-DD HH:MM:SS", and the first ten characters are the day
            // in both; the seconds are noise to someone asking when they run out.
            expires: String(subscription.expires_at).slice(0, 10),
          })
        : t(lang, 'status.planPremiumNoExpiry', { plan: planLabel(lang, subscription.plan) })
    );
  } else {
    lines.push(t(lang, 'status.planFree'));
  }

  const summariesUsed = getSummaryUsageToday(userId);
  lines.push(
    t(lang, 'status.summaries', {
      used: summariesUsed,
      limit: renderLimit(lang, limits.maxSummariesPerDay),
    })
  );
  lines.push(t(lang, 'status.lookback', { hours: limits.maxLookbackHours }));

  lines.push('', t(lang, 'status.trackingHeader'));
  lines.push(
    allowanceLine(lang, 'status.groups', {
      allowed: allowedGroups.length,
      total: groups.length,
      limit: limits.maxGroups,
    })
  );
  lines.push(
    allowanceLine(lang, 'status.channels', {
      allowed: allowedChannels.length,
      total: channels.length,
      limit: limits.maxChannels,
    })
  );
  lines.push(
    allowanceLine(lang, 'status.keywords', {
      allowed: liveKeywords.length,
      total: keywords.length,
      limit: limits.maxKeywords,
    })
  );

  const digests = getUserScheduledDigests(userId);
  lines.push('', t(lang, 'status.digestHeader'));
  if (digests.length === 0) {
    lines.push(t(lang, 'status.digestNone'));
  } else {
    for (const digest of digests) {
      // Chat titles are written by whoever named the group. Escaped like every
      // other quoted third-party string that reaches Telegram's parser.
      const chat = escapeMarkdown(digest.chat_title || t(lang, 'common.chatFallback', { id: digest.chat_id }));

      if (digest.enabled) {
        lines.push(t(lang, 'status.digestOn', { chat, time: formatHour(digest.hour_utc) }));
      } else if (digest.disabled_reason === 'blocked') {
        // Otherwise this is indistinguishable from having turned it off
        // themselves, and there is nothing to tell them it can be undone.
        lines.push(t(lang, 'status.digestBlocked', { chat }));
      } else {
        lines.push(t(lang, 'status.digestOff', { chat }));
      }
    }
  }

  // The pitch belongs where the wall is: someone on their last summary of the
  // day, or already carrying items their plan has locked, is exactly who has
  // a reason to pay. Everyone else just wanted to check their status.
  const nearSummaryLimit =
    Number.isFinite(limits.maxSummariesPerDay) && summariesUsed >= limits.maxSummariesPerDay - 1;
  const hasLockedItems =
    liveKeywords.length < keywords.length ||
    allowedGroups.length < groups.length ||
    allowedChannels.length < channels.length;

  const offerSubscribe = !subscription && (nearSummaryLimit || hasLockedItems);
  if (offerSubscribe) lines.push('', t(lang, 'status.upsell'));

  return {
    text: lines.join('\n'),
    keyboard: offerSubscribe
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: t(lang, 'status.subscribeButton'), callback_data: 'status:subscribe' }]],
          },
        }
      : {},
  };
}

async function statusHandler(ctx) {
  const lang = ctx.state.lang;

  // In a group this would print one member's private allowances to everyone
  // else in it.
  if (isGroupChat(ctx.chat)) return ctx.reply(t(lang, 'status.dmOnly'));

  const { text, keyboard } = buildStatus(ctx);
  track(EVENTS.STATUS_VIEWED, { userId: ctx.from.id });

  // Chat titles are escaped above, but the plain-text retry stays as the
  // backstop for the same reason /find has one: showing this unformatted beats
  // showing nothing.
  try {
    return await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) {
    logger.warn('Status rejected with Markdown, resending as plain text', { error: error.message });
    return ctx.reply(text, keyboard);
  }
}

module.exports = (bot) => {
  bot.command('status', statusHandler);

  // Reuses the real /subscribe handler rather than re-implementing it, so the
  // guard that refuses the plan menu to someone already subscribed applies to
  // this button too.
  bot.action('status:subscribe', async (ctx) => {
    await ctx.answerCbQuery();
    return subscribeHandler(ctx);
  });
};

module.exports.buildStatus = buildStatus;
