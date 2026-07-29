const { setUserLanguage } = require('../services/database');
const { mainMenu } = require('../keyboards');
const { t, allTranslations, SUPPORTED_LANGUAGES } = require('../utils/i18n');

function languageMenu(currentLang) {
  const buttons = SUPPORTED_LANGUAGES.map((lang) => [
    {
      text: `${lang === currentLang ? '✅ ' : ''}${t(lang, 'languageName')}`,
      callback_data: `language:set:${lang}`,
    },
  ]);
  return { inline_keyboard: buttons };
}

async function languageHandler(ctx) {
  const lang = ctx.state.lang;
  return ctx.reply(`${t(lang, 'language.choose')}\n${t(lang, 'language.current', { language: t(lang, 'languageName') })}`, {
    reply_markup: languageMenu(lang),
  });
}

async function languageSetCallback(ctx) {
  const selected = ctx.match[1];
  if (!SUPPORTED_LANGUAGES.includes(selected)) {
    return ctx.answerCbQuery();
  }

  setUserLanguage(ctx.from.id, selected);
  await ctx.answerCbQuery();
  await ctx.editMessageText(t(selected, 'language.changed'));

  // The reply keyboard is rendered client-side and keeps the old language
  // until it's re-sent, so push a fresh one in the new language.
  return ctx.reply(t(selected, 'language.current', { language: t(selected, 'languageName') }), mainMenu(selected));
}

module.exports = (bot) => {
  bot.command('language', languageHandler);
  bot.hears(allTranslations('menu.language'), languageHandler);
  bot.action(/^language:set:(\w+)$/, languageSetCallback);
};
