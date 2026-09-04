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

  // subscribeHandler refuses to show the menu to an active subscriber, but a
  // /subscribe message sent before they paid still has live buttons in their
  // history. Without this, tapping one bills them a second time.
  if (ctx.state.subscription) {
    return ctx.answerCbQuery(
      t(ctx.state.lang, 'subscribe.alreadyActiveShort', {
        expires: ctx.state.subscription.expires_at,
      }),
      { show_alert: true }
    );
  }

  await ctx.answerCbQuery();
  return sendStarsInvoice(ctx, planKey);
}

module.exports = (bot) => {
  bot.command('subscribe', subscribeHandler);
  bot.hears(allTranslations('menu.subscribe'), subscribeHandler);
  bot.action(/^subscribe:(.+)$/, planSelected);

  // The button on /status and on an expiry reminder. Registered here, next to
  // the flow it opens, so both callers reuse the real handler - including its
  // refusal to show the plan menu to someone already subscribed - rather than
  // a second copy that can drift. Not part of the subscribe:<plan> pattern,
  // which would read "open" as a plan name and answer "Unknown plan".
  bot.action('renew:open', async (ctx) => {
    await ctx.answerCbQuery();
    return subscribeHandler(ctx);
  });
};
