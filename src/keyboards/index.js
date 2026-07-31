const { Markup } = require('telegraf');
const { SUBSCRIPTION_PLANS } = require('../models/subscription');
const { FILTER_CATEGORIES } = require('../services/filterMatcher');
const { t } = require('../utils/i18n');

function mainMenu(lang) {
  return Markup.keyboard([
    [t(lang, 'menu.summary'), t(lang, 'menu.find')],
    [t(lang, 'menu.filters'), t(lang, 'menu.digest')],
    [t(lang, 'menu.subscribe')],
    [t(lang, 'menu.language'), t(lang, 'menu.privacy')],
  ]).resize();
}

function planLabel(lang, planKey) {
  return t(lang, `subscribe.plan${planKey.charAt(0).toUpperCase()}${planKey.slice(1)}`);
}

function subscriptionMenu(lang) {
  const buttons = Object.entries(SUBSCRIPTION_PLANS).map(([key, plan]) =>
    Markup.button.callback(
      t(lang, 'subscribe.planButton', { label: planLabel(lang, key), stars: plan.stars }),
      `subscribe:${key}`
    )
  );
  return Markup.inlineKeyboard(buttons, { columns: 1 });
}

function filterCategoriesMenu(lang, selectedCategories = []) {
  const buttons = FILTER_CATEGORIES.map((category) => {
    const isSelected = selectedCategories.includes(category);
    const label = t(lang, `filter.categories.${category}`);
    return Markup.button.callback(`${isSelected ? '✅' : '▫️'} ${label}`, `filter:category:${category}`);
  });
  return Markup.inlineKeyboard([...buttons, Markup.button.callback(t(lang, 'common.done'), 'filter:done')], {
    columns: 2,
  });
}

module.exports = { mainMenu, subscriptionMenu, filterCategoriesMenu, planLabel, FILTER_CATEGORIES };
