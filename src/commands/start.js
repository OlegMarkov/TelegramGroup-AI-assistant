const { mainMenu } = require('../keyboards');
const { FREE_LIMITS, PREMIUM_LIMITS } = require('../models/subscription');
const { t } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');

module.exports = (bot) => {
  bot.start(async (ctx) => {
    track(EVENTS.USER_STARTED, { userId: ctx.from.id });
    const lang = ctx.state.lang;
    const name = ctx.from.first_name || '';

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
      mainMenu(lang)
    );
  });
};
