const { mainMenu } = require('../keyboards');
const { FREE_LIMITS, PREMIUM_LIMITS } = require('../models/subscription');
const { escapeMarkdown } = require('../utils/formatters');
const { t } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');

module.exports = (bot) => {
  bot.start(async (ctx) => {
    track(EVENTS.USER_STARTED, { userId: ctx.from.id });
    const lang = ctx.state.lang;
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
      }),
      { parse_mode: 'Markdown', ...mainMenu(lang) }
    );
  });
};
