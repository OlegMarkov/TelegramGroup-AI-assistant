const { Markup } = require('telegraf');
const { SUBSCRIPTION_PLANS } = require('../models/subscription');
const { FILTER_CATEGORIES } = require('../services/filterMatcher');
const { truncate } = require('../utils/formatters');
const { t } = require('../utils/i18n');

function mainMenu(lang) {
  return Markup.keyboard([
    [t(lang, 'menu.summary'), t(lang, 'menu.find')],
    [t(lang, 'menu.filters'), t(lang, 'menu.digest')],
    [t(lang, 'menu.channels'), t(lang, 'menu.subscribe')],
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

/**
 * The channel list as a keyboard: one tappable row per channel, plus the
 * add and remove actions.
 *
 * Selection lives in the marks rather than in a typed command, so removing a
 * channel is tap-tap instead of retyping a handle you first have to read off
 * the list. Remove only appears once something is selected — a button whose
 * only possible answer is "select something first" is noise.
 */
function channelsMenu(lang, { channels, selectedIds = new Set(), allowedIds = null }) {
  const rows = channels.map((c) => {
    const mark = selectedIds.has(c.id) ? '☑️' : '▫️';
    // Channels past the plan's allowance stay in the list — they are still
    // followed, just not summarizable — so they have to look different.
    const lock = allowedIds && !allowedIds.has(c.id) ? '🔒 ' : '';
    const label = truncate(c.title || `@${c.username}`, 40);
    return [Markup.button.callback(`${mark} ${lock}${label}`, `channel:toggle:${c.id}`)];
  });

  const actions = [Markup.button.callback(t(lang, 'channel.addButton'), 'channel:add')];
  if (selectedIds.size > 0) {
    actions.push(
      Markup.button.callback(t(lang, 'channel.removeButton', { count: selectedIds.size }), 'channel:remove')
    );
  }

  return Markup.inlineKeyboard([...rows, actions]);
}

module.exports = {
  mainMenu,
  subscriptionMenu,
  filterCategoriesMenu,
  channelsMenu,
  planLabel,
  FILTER_CATEGORIES,
};
