const {
  countUserEvents,
  hasShownTip,
  areTipsMuted,
  setTipsMuted,
  getScheduledDigest,
  getUserFilters,
} = require('../services/database');
const { getLimits } = require('../models/subscription');
const { t } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

/**
 * One feature at a time, at the moment it would have helped.
 *
 * Nobody reads a tour, and the /start greeting stopped being one. Instead each
 * feature gets one line, once ever, right after the person did the thing that
 * makes it relevant — search after their first summary, digests once they keep
 * coming back to the same chat. At most one a day, never in a group, and one
 * tap turns them all off.
 *
 * Everything here is read from the event log: a tip shown is a tip_shown
 * event, so "once ever" and "one a day" need no table of their own, and
 * /forgetme already covers them.
 *
 * No tip sells anything. Free users are pitched where they hit a wall (the
 * paywall replies and /status), which is where the conversion funnel measures
 * it; a second, differently timed ask would blur that number.
 */

const TIP_COOLDOWN_HOURS = 24;

/**
 * In order of priority when more than one applies. `after` is the moment it can
 * follow; `applies` reads everything else it needs from the database.
 */
const TIPS = [
  {
    id: 'find',
    after: 'summary',
    // Only groups are searchable, and someone who already searched knows.
    applies: ({ userId, isChannel }) => !isChannel && countUserEvents(userId, EVENTS.FIND_REQUESTED) === 0,
  },
  {
    id: 'digest',
    after: 'summary',
    // Back to the same chat twice in a week is exactly who a digest is for.
    applies: ({ userId, chatId, limits }) =>
      limits.scheduledDigests &&
      countUserEvents(userId, EVENTS.SUMMARY_COMPLETED, { chatId, sinceHours: 7 * 24 }) >= 2 &&
      !getScheduledDigest(chatId, userId),
  },
  {
    id: 'filter',
    after: 'summary',
    applies: ({ userId }) =>
      countUserEvents(userId, EVENTS.SUMMARY_COMPLETED) >= 3 && (getUserFilters(userId).keywords || []).length === 0,
  },
  {
    id: 'ask',
    after: 'find',
    applies: ({ userId, limits }) =>
      limits.maxQuestionsPerDay > 0 && countUserEvents(userId, EVENTS.ASK_REQUESTED) === 0,
  },
];

/** The tip to show now, or null. Exported for tests. */
function pickTip(userId, after, { chatId = null, isChannel = false, limits }) {
  if (areTipsMuted(userId)) return null;
  if (countUserEvents(userId, EVENTS.TIP_SHOWN, { sinceHours: TIP_COOLDOWN_HOURS }) > 0) return null;

  for (const tip of TIPS) {
    if (tip.after !== after) continue;
    if (hasShownTip(userId, tip.id)) continue;
    if (tip.applies({ userId, chatId, isChannel, limits })) return tip.id;
  }
  return null;
}

/**
 * Called after a success. Best effort: a tip that fails must never look like
 * the thing it follows failed.
 */
async function maybeShowTip(ctx, after, { chatId = null, isChannel = false } = {}) {
  if (!ctx.chat || ctx.chat.type !== 'private' || !ctx.from) return null;

  try {
    const tip = pickTip(ctx.from.id, after, { chatId, isChannel, limits: getLimits(ctx.state.subscription) });
    if (!tip) return null;

    const lang = ctx.state.lang;
    await ctx.reply(t(lang, `tips.${tip}`), {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: t(lang, 'tips.muteButton'), callback_data: 'tips:mute' }]] },
    });
    track(EVENTS.TIP_SHOWN, { userId: ctx.from.id, chatId, metadata: { tip } });
    return tip;
  } catch (error) {
    logger.warn('Could not show a tip', { userId: ctx.from.id, error: error.message });
    return null;
  }
}

async function muteCallback(ctx) {
  const lang = ctx.state.lang;
  setTipsMuted(ctx.from.id, true);
  track(EVENTS.TIPS_MUTED, { userId: ctx.from.id });
  await ctx.answerCbQuery(t(lang, 'tips.muted'));
  // The button has done its job, and a second tap would say the same thing.
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  return undefined;
}

module.exports = (bot) => {
  bot.action('tips:mute', muteCallback);
};

module.exports.maybeShowTip = maybeShowTip;
module.exports.pickTip = pickTip;
module.exports.TIPS = TIPS;
module.exports.TIP_COOLDOWN_HOURS = TIP_COOLDOWN_HOURS;
