const { mainMenu } = require('../keyboards');
const { FREE_LIMITS, PREMIUM_LIMITS } = require('../models/subscription');
const { splitForTelegram } = require('../utils/formatters');
const { t, allTranslations } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');

/**
 * The full guide, for people who met the bot after /start scrolled away.
 *
 * Every number in it comes from the limits rather than the copy, so the guide
 * cannot quietly start advertising an allowance the code no longer gives.
 * Premium's unlimited values are words in the translation, not placeholders —
 * interpolating Infinity would print "Infinity".
 */
async function helpHandler(ctx) {
  const lang = ctx.state.lang;
  track(EVENTS.HELP_VIEWED, { userId: ctx.from.id });

  const text = t(lang, 'help.text', {
    freeSummaries: FREE_LIMITS.maxSummariesPerDay,
    freeHours: FREE_LIMITS.maxLookbackHours,
    premiumHours: PREMIUM_LIMITS.maxLookbackHours,
    freeGroups: FREE_LIMITS.maxGroups,
    freeChannels: FREE_LIMITS.maxChannels,
    premiumChannels: PREMIUM_LIMITS.maxChannels,
    freeKeywords: FREE_LIMITS.maxKeywords,
    premiumKeywords: PREMIUM_LIMITS.maxKeywords,
  });

  // Long enough that a future edit could push it past Telegram's 4096-character
  // limit, which rejects the whole message rather than truncating it.
  const parts = splitForTelegram(text);
  let sent;
  for (const [index, part] of parts.entries()) {
    const isLast = index === parts.length - 1;
    sent = await ctx.reply(part, {
      parse_mode: 'Markdown',
      // The keyboard belongs on the last part only, so it lands under the
      // whole guide rather than in the middle of it.
      ...(isLast ? mainMenu(lang) : {}),
    });
  }
  return sent;
}

module.exports = (bot) => {
  bot.command('help', helpHandler);
  bot.hears(allTranslations('menu.help'), helpHandler);
};
