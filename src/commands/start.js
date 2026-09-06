const { mainMenu } = require('../keyboards');
const { FREE_LIMITS, PREMIUM_LIMITS, TRIAL_PLAN, TRIAL_DAYS } = require('../models/subscription');
const { createSubscription, hasEverHadSubscription } = require('../services/database');
const { escapeMarkdown, formatDate } = require('../utils/formatters');
const logger = require('../utils/logger');

const { t } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');

/**
 * Gives a first-time user a week of premium, once ever.
 *
 * Written as a normal subscription row - plan 'trial', starsPaid 0, and a NULL
 * charge id - so it flows through getActiveSubscription and getLimits with no
 * special case anywhere else. Everything premium simply works, and when it
 * expires the user falls back to FREE_LIMITS by the same path a lapsed paid
 * plan does.
 *
 * NULL rather than a placeholder charge id: a made-up value collides with the
 * next comp on the partial unique index, which is exactly the bug that took a
 * production hotfix.
 *
 * Guarded on ever having had ANY subscription, not just a trial. Handing one to
 * a lapsed paying customer would be a discount for churning.
 */
function grantTrialIfDue(ctx) {
  const userId = ctx.from.id;
  if (hasEverHadSubscription(userId)) return false;

  try {
    createSubscription({
      userId,
      plan: TRIAL_PLAN,
      starsPaid: 0,
      telegramChargeId: null,
      // SQLite's own format, matching what payments.js writes.
      expiresAt: formatDate(new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000)),
    });
  } catch (error) {
    // A trial that could not be granted must not stop somebody starting the
    // bot. They get the free plan, which is what they had a moment ago.
    logger.error('Could not grant a trial', { userId, error: error.message });
    return false;
  }

  track(EVENTS.TRIAL_STARTED, { userId });
  logger.info('Granted a free trial', { userId, days: TRIAL_DAYS });
  return true;
}

module.exports = (bot) => {
  bot.start(async (ctx) => {
    track(EVENTS.USER_STARTED, { userId: ctx.from.id });
    const lang = ctx.state.lang;
    const trialNote = grantTrialIfDue(ctx) ? `\n\n${t(lang, 'start.trialGranted', { days: TRIAL_DAYS })}` : '';
    // The greeting is sent as Markdown, and a first name is free-form text: an
    // unbalanced * or _ in it would make Telegram reject the whole message, so
    // the very first thing a new user sees would be nothing at all.
    const name = escapeMarkdown(ctx.from.first_name || '');

    await ctx.reply(
      t(lang, 'start.greeting', {
        name,
        freeSummaries: FREE_LIMITS.maxSummariesPerDay,
        freeHours: FREE_LIMITS.maxLookbackHours,
        // Sourced from the limits rather than written into the copy, so the
        // greeting cannot quietly start advertising the wrong allowance.
        freeChannels: FREE_LIMITS.maxChannels,
        premiumChannels: PREMIUM_LIMITS.maxChannels,
        freeKeywords: FREE_LIMITS.maxKeywords,
        premiumKeywords: PREMIUM_LIMITS.maxKeywords,
        trialNote,
      }),
      { parse_mode: 'Markdown', ...mainMenu(lang) }
    );
  });
};
