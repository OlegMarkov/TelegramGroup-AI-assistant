const { getUserFilters, setUserFilters } = require('../services/database');
const { filterCategoriesMenu } = require('../keyboards');
const { t, allTranslations } = require('../utils/i18n');

async function filterHandler(ctx) {
  const lang = ctx.state.lang;
  const { categories } = getUserFilters(ctx.from.id);
  return ctx.reply(t(lang, 'filter.choose'), filterCategoriesMenu(lang, categories));
}

async function toggleCategory(ctx) {
  const category = ctx.match[1];
  const filters = getUserFilters(ctx.from.id);

  const categories = filters.categories.includes(category)
    ? filters.categories.filter((c) => c !== category)
    : [...filters.categories, category];

  setUserFilters(ctx.from.id, { ...filters, categories });

  await ctx.editMessageReplyMarkup(filterCategoriesMenu(ctx.state.lang, categories).reply_markup);
  return ctx.answerCbQuery();
}

async function doneFiltering(ctx) {
  const lang = ctx.state.lang;
  const { categories } = getUserFilters(ctx.from.id);
  await ctx.answerCbQuery(t(lang, 'filter.saved'));

  if (categories.length === 0) {
    return ctx.reply(t(lang, 'filter.cleared'));
  }

  // Stored categories are English keys; show them in the user's language.
  const labels = categories.map((c) => t(lang, `filter.categories.${c}`)).join(', ');
  return ctx.reply(t(lang, 'filter.following', { categories: labels }));
}

module.exports = (bot) => {
  bot.command('filter', filterHandler);
  bot.hears(allTranslations('menu.filters'), filterHandler);
  bot.action(/^filter:category:(.+)$/, toggleCategory);
  bot.action('filter:done', doneFiltering);
};
