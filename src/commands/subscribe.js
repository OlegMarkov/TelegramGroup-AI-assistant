const { subscriptionMenu, planLabel } = require('../keyboards');
const { sendStarsInvoice } = require('../services/payments');
const { SUBSCRIPTION_PLANS } = require('../models/subscription');
const { t, allTranslations } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');

async function subscribeHandler(ctx) {
  const lang = ctx.state.lang;

  if (ctx.state.subscription) {
    return ctx.reply(
      t(lang, 'subscribe.alreadyActive', {
        plan: planLabel(lang, ctx.state.subscription.plan),
        expires: ctx.state.subscription.expires_at,
      }),
      { parse_mode: 'Markdown' }
    );
  }

  track(EVENTS.SUBSCRIBE_VIEWED, { userId: ctx.from.id });
  return ctx.reply(t(lang, 'subscribe.choosePlan'), subscriptionMenu(lang));
}

async function planSelected(ctx) {
  const planKey = ctx.match[1];
  if (!SUBSCRIPTION_PLANS[planKey]) {
    return ctx.answerCbQuery(t(ctx.state.lang, 'subscribe.unknownPlan'));
  }
  await ctx.answerCbQuery();
  return sendStarsInvoice(ctx, planKey);
}

module.exports = (bot) => {
  bot.command('subscribe', subscribeHandler);
  bot.hears(allTranslations('menu.subscribe'), subscribeHandler);
  bot.action(/^subscribe:(.+)$/, planSelected);
};
