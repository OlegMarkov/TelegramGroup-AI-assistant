const { TRIAL_PLAN, TRIAL_DAYS } = require('../models/subscription');
const {
  createSubscription,
  hasEverHadSubscription,
  hasUserStarted,
  getActiveSubscription,
} = require('./database');
const { formatDate } = require('../utils/formatters');
const { t } = require('../utils/i18n');
const { track, EVENTS } = require('./analytics');
const logger = require('../utils/logger');

/**
 * A week of premium, once ever — starting when there is something to use it on.
 *
 * It used to start at the first /start, so somebody who took four days to add
 * the bot to a group had three days of trial left by the time anything could
 * be summarized, and trial → paid counted everyone who pressed /start and
 * left. Now it starts at the first moment the person has a chat to summarize:
 * /start when they already have one, following a channel, adding the bot to a
 * group, or asking for their first summary in DM (which covers people linked
 * to a group just by talking in it). Every one of those calls this function.
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
 * a lapsed paying customer would be a discount for churning. The check and the
 * insert are two synchronous statements with no await between them, in a bot
 * that is one process, so two triggers firing at once cannot both pass it.
 *
 * Only for someone who has opened the bot: a group member who never has would
 * otherwise have a trial quietly run out without ever hearing of it.
 */
function grantTrialIfDue(userId) {
  if (!hasUserStarted(userId)) return false;
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
    // A trial that could not be granted must not stop whatever triggered it.
    // They get the free plan, which is what they had a moment ago.
    logger.error('Could not grant a trial', { userId, error: error.message });
    return false;
  }

  track(EVENTS.TRIAL_STARTED, { userId });
  logger.info('Granted a free trial', { userId, days: TRIAL_DAYS });
  return true;
}

/**
 * grantTrialIfDue for a handler that is about to act for this person: the
 * subscription auth loaded at the start of the update is refreshed, so the
 * premium limits apply to the very request that started the trial.
 */
function startTrialForRequest(ctx) {
  if (!grantTrialIfDue(ctx.from.id)) return false;
  ctx.state.subscription = getActiveSubscription(ctx.from.id) || null;
  return true;
}

function trialStartedText(lang) {
  return t(lang, 'start.trialGranted', { days: TRIAL_DAYS });
}

module.exports = { grantTrialIfDue, startTrialForRequest, trialStartedText };
