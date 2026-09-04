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

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function filterCategoriesMenu(lang, selectedCategories = [], keywordCount = 0) {
  const buttons = FILTER_CATEGORIES.map((category) => {
    const isSelected = selectedCategories.includes(category);
    const label = t(lang, `filter.categories.${category}`);
    return Markup.button.callback(`${isSelected ? '✅' : '▫️'} ${label}`, `filter:category:${category}`);
  });

  // With nothing of their own set yet, the button has to say what it is for
  // rather than report a count of zero.
  const keywordsLabel =
    keywordCount > 0
      ? t(lang, 'filter.keywordsButton', { count: keywordCount })
      : t(lang, 'filter.keywordsButtonEmpty');

  // Rows are built explicitly rather than with `columns: 2`, which would pack
  // Done in beside the last category and, once a third action exists, leave
  // the actions wrapping across rows in whatever order they happen to fall.
  return Markup.inlineKeyboard([
    ...chunk(buttons, 2),
    [Markup.button.callback(keywordsLabel, 'filter:keywords')],
    [Markup.button.callback(t(lang, 'common.done'), 'filter:done')],
  ]);
}

/**
 * The user's own keywords, one tappable row each, with the same select-then-act
 * shape as the channel list: tap to tick, 🗑 acts on what is ticked.
 *
 * Rows are addressed by the id their feature computed for them rather than by
 * the keyword itself — callback_data is capped at 64 bytes, which a 50-character
 * Cyrillic keyword blows straight past.
 */
function filterKeywordsMenu(lang, { keywords, selectedIds = new Set() }) {
  const rows = keywords.map(({ id, word }) => [
    Markup.button.callback(`${selectedIds.has(id) ? '☑️' : '▫️'} ${truncate(word, 40)}`, `filter:kw:${id}`),
  ]);

  const actions = [Markup.button.callback(t(lang, 'filter.keywordsAddButton'), 'filter:kw:add')];
  if (selectedIds.size > 0) {
    actions.push(
      Markup.button.callback(
        t(lang, 'filter.keywordsRemoveButton', { count: selectedIds.size }),
        'filter:kw:remove'
      )
    );
  }

  return Markup.inlineKeyboard([
    ...rows,
    actions,
    [Markup.button.callback(t(lang, 'filter.keywordsBackButton'), 'filter:back')],
  ]);
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
  filterKeywordsMenu,
  channelsMenu,
  planLabel,
  FILTER_CATEGORIES,
};
