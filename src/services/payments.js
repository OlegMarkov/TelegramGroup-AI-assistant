const { SUBSCRIPTION_PLANS } = require('../models/subscription');
const { createSubscription } = require('./database');
const { formatDate } = require('../utils/formatters');
const { planLabel } = require('../keyboards');
const { t, DEFAULT_LANGUAGE } = require('../utils/i18n');
const { track, EVENTS } = require('./analytics');
const logger = require('../utils/logger');

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
  const expiresAt = formatDate(new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000));

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
