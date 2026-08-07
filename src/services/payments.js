const { SUBSCRIPTION_PLANS } = require('../models/subscription');
const { createSubscription, getActiveSubscription } = require('./database');
const { formatDate } = require('../utils/formatters');
const { planLabel } = require('../keyboards');
const { t, DEFAULT_LANGUAGE } = require('../utils/i18n');
const { track, EVENTS } = require('./analytics');
const logger = require('../utils/logger');

/**
 * Timestamps are stored as "YYYY-MM-DD HH:MM:SS" in UTC, by both formatDate
 * and SQLite's datetime(). Date.parse() reads that shape as *local* time, so
 * it has to be spelled as UTC explicitly or every comparison is off by the
 * server's offset — silently correct on a UTC box, wrong anywhere else.
 */
function parseStoredUtc(value) {
  if (!value) return null;
  const ms = Date.parse(`${String(value).trim().replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

async function sendStarsInvoice(ctx, planKey) {
  const plan = SUBSCRIPTION_PLANS[planKey];
  if (!plan) throw new Error(`Unknown subscription plan: ${planKey}`);

  const lang = (ctx.state && ctx.state.lang) || DEFAULT_LANGUAGE;
  const label = planLabel(lang, planKey);

  return ctx.replyWithInvoice({
    title: t(lang, 'subscribe.invoiceTitle', { label }),
    description: t(lang, 'subscribe.invoiceDescription', { days: plan.days }),
    payload: `subscription:${planKey}:${ctx.from.id}`,
    provider_token: '', // Telegram Stars payments do not use a provider token
    currency: 'XTR',
    prices: [{ label, amount: plan.stars }],
  });
}

async function handlePreCheckoutQuery(ctx) {
  const payload = ctx.preCheckoutQuery.invoice_payload || '';
  const [kind, planKey] = payload.split(':');

  if (kind !== 'subscription' || !SUBSCRIPTION_PLANS[planKey]) {
    return ctx.answerPreCheckoutQuery(false, 'Invalid subscription plan');
  }

  // The last server-side gate before money moves, and the only one that holds
  // no matter where the invoice came from or how old it is. Declining here
  // means the user is never charged, rather than charged and refunded.
  const existing = getActiveSubscription(ctx.from.id);
  if (existing) {
    const lang = (ctx.state && ctx.state.lang) || DEFAULT_LANGUAGE;
    logger.info('Declined a duplicate purchase for an active subscriber', { userId: ctx.from.id });
    return ctx.answerPreCheckoutQuery(false, t(lang, 'subscribe.alreadyActiveShort', { expires: existing.expires_at }));
  }

  return ctx.answerPreCheckoutQuery(true);
}

async function handleSuccessfulPayment(ctx) {
  const payment = ctx.message.successful_payment;
  const [, planKey] = (payment.invoice_payload || '').split(':');
  const plan = SUBSCRIPTION_PLANS[planKey];

  if (!plan) {
    logger.warn('Received successful payment with unknown plan', { payload: payment.invoice_payload });
    return;
  }

  const lang = (ctx.state && ctx.state.lang) || DEFAULT_LANGUAGE;

  // Pre-checkout declines duplicates, so reaching here with time still on the
  // clock means a race — an invoice already in flight when a subscription
  // started. Extend from whichever is later so the new period is added to the
  // remaining one instead of replacing it: getActiveSubscription picks the
  // newest row by started_at, not the longest, so computing from "now" would
  // let a 300-star monthly silently swallow the rest of a 3000-star yearly.
  const existing = getActiveSubscription(ctx.from.id);
  const startFrom = Math.max(Date.now(), parseStoredUtc(existing && existing.expires_at) || 0);
  const expiresAt = formatDate(new Date(startFrom + plan.days * 24 * 60 * 60 * 1000));

  if (existing) {
    logger.warn('Payment accepted while a subscription was still active; extending it', {
      userId: ctx.from.id,
      previousExpiry: existing.expires_at,
      newExpiry: expiresAt,
    });
  }

  createSubscription({
    userId: ctx.from.id,
    plan: planKey,
    starsPaid: payment.total_amount,
    telegramChargeId: payment.telegram_payment_charge_id,
    expiresAt,
  });
  track(EVENTS.SUBSCRIPTION_PURCHASED, { userId: ctx.from.id, metadata: { plan: planKey, stars: payment.total_amount } });

  await ctx.reply(
    t(lang, 'subscribe.thanks', { label: planLabel(lang, planKey), expires: expiresAt })
  );
}

module.exports = { sendStarsInvoice, handlePreCheckoutQuery, handleSuccessfulPayment };
