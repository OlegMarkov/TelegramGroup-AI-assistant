const config = require('../config');
const {
  getOrCreateUser,
  getSubscriptionByChargeId,
  setSubscriptionStatus,
  revokeActiveSubscriptions,
  createSubscription,
  getActiveSubscription,
} = require('../services/database');
const { formatDate } = require('../utils/formatters');
const logger = require('../utils/logger');

/**
 * Owner-only subscription management: refunds, comps, and taking access back.
 *
 * Telegram Stars supports refundStarPayment and Telegram points users at the
 * bot owner for refunds, so until now there was no answer to someone asking for
 * their money back. There was also no supported way to comp anyone, which is
 * how two production rows ended up inserted by hand with a made-up charge id -
 * the thing that blocked the unique index on telegram_charge_id from ever being
 * created.
 *
 * Replies here are plain English rather than localized. Deliberate, and the
 * same choice /stats makes: this is tooling for the one person who owns the
 * bot, and putting it in both locales would grow the translation surface that
 * the i18n tests police for no reader.
 */

// The comp plan key. Deliberately NOT added to SUBSCRIPTION_PLANS: pre-checkout
// validates a purchase against that map, and a comp is not purchasable. It only
// needs a label to render in /status.
const COMP_PLAN = 'comp';

function isAdmin(userId) {
  return config.adminUserIds.includes(userId);
}

function args(ctx) {
  return (ctx.message.text || '').trim().split(/\s+/).slice(1);
}

async function refundHandler(ctx) {
  // Silently ignore for non-admins rather than revealing the command exists.
  if (!isAdmin(ctx.from.id)) return;

  const [chargeId] = args(ctx);
  if (!chargeId) return ctx.reply('Usage: /refund <telegram_payment_charge_id>');

  const subscription = getSubscriptionByChargeId(chargeId);
  if (!subscription) return ctx.reply(`No subscription recorded for charge ${chargeId}.`);

  // The refund is attempted BEFORE the row is touched. Marking it refunded
  // first would take away access on a call that might fail, leaving someone
  // with neither their subscription nor their stars.
  try {
    await ctx.telegram.callApi('refundStarPayment', {
      user_id: subscription.user_id,
      telegram_payment_charge_id: chargeId,
    });
  } catch (error) {
    logger.error('Refund refused by Telegram', { adminId: ctx.from.id, chargeId, error: error.message });
    return ctx.reply(`Telegram refused the refund: ${error.message}\nNothing was changed.`);
  }

  setSubscriptionStatus(subscription.id, 'refunded');
  logger.info('Subscription refunded', {
    adminId: ctx.from.id,
    userId: subscription.user_id,
    chargeId,
    subscriptionId: subscription.id,
  });

  return ctx.reply(
    `Refunded ${subscription.stars_paid} stars to user ${subscription.user_id}. ` +
      'Their subscription is marked refunded and no longer grants access.'
  );
}

async function grantHandler(ctx) {
  if (!isAdmin(ctx.from.id)) return;

  const [rawUserId, rawDays] = args(ctx);
  const userId = Number(rawUserId);
  const days = Number(rawDays);

  if (!Number.isInteger(userId) || !Number.isFinite(days) || days <= 0) {
    return ctx.reply('Usage: /grant <user_id> <days>');
  }

  // The subscriptions row references users(id) and foreign keys are on, so a
  // grant to somebody who has never opened the bot needs the user row first.
  getOrCreateUser({ id: userId });

  const subscription = createSubscription({
    userId,
    plan: COMP_PLAN,
    starsPaid: 0,
    // NULL, not a placeholder. A made-up id collides with the next comp on the
    // partial unique index, which is exactly how the live database ended up
    // unable to create that index at all.
    telegramChargeId: null,
    // SQLite's own format, matching what payments.js writes. An ISO string
    // sorts differently against datetime('now') on the day it expires.
    expiresAt: formatDate(new Date(Date.now() + days * 86400000)),
  });

  logger.info('Subscription granted', { adminId: ctx.from.id, userId, days, subscriptionId: subscription.id });
  return ctx.reply(`Granted ${days} days to user ${userId}, until ${subscription.expires_at} UTC.`);
}

async function revokeHandler(ctx) {
  if (!isAdmin(ctx.from.id)) return;

  const userId = Number(args(ctx)[0]);
  if (!Number.isInteger(userId)) return ctx.reply('Usage: /revoke <user_id>');

  const revoked = revokeActiveSubscriptions(userId);
  logger.info('Subscriptions revoked', { adminId: ctx.from.id, userId, revoked });

  if (revoked === 0) return ctx.reply(`User ${userId} had no active subscription.`);
  return ctx.reply(
    `Revoked ${revoked} subscription(s) for user ${userId}. ` +
      `They now have ${getActiveSubscription(userId) ? 'another active subscription' : 'free-plan access'}.`
  );
}

module.exports = (bot) => {
  // None of these are in PUBLIC_COMMANDS, so they never appear in the "/" menu.
  bot.command('refund', refundHandler);
  bot.command('grant', grantHandler);
  bot.command('revoke', revokeHandler);
};

module.exports.COMP_PLAN = COMP_PLAN;
