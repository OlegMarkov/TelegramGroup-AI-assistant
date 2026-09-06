const crypto = require('node:crypto');
const { getUserFilters, setUserFilters } = require('../services/database');
const { filterSchema, allowedKeywords, MAX_KEYWORD_LENGTH } = require('../models/filter');
const { getLimits, PREMIUM_LIMITS } = require('../models/subscription');
const { normalize } = require('../services/filterMatcher');
const { filterCategoriesMenu, filterKeywordsMenu } = require('../keyboards');
const { t, allTranslations } = require('../utils/i18n');
const { armPrompt, clearPrompt, captureReply, createSelectionStore } = require('../utils/uiState');
const { setSubscribed, isSubscribed, MAX_ALERTS_PER_HOUR } = require('../services/keywordAlerts');
const { setUserAlertsEnabled } = require('../services/database');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

const KEYWORD_PROMPT = 'filter:keyword';
const keywordSelection = createSelectionStore();

// Every screen here is sent as plain text, with no parse_mode. Keywords are
// whatever the user typed, and they are echoed back on nearly every one of
// these messages — plain text makes an unbalanced * or [ inert by construction
// instead of relying on remembering to escape at each call site.

/**
 * A short, stable id for a keyword.
 *
 * The keyword itself cannot go in callback_data (64 bytes, versus up to 200 for
 * 50 characters of Cyrillic), and its index in the list cannot either: the list
 * shifts as things are added and removed, so a stale button would tick the
 * wrong row. Hashing the normalized form means an id resolves to the same
 * keyword or to nothing at all.
 */
function keywordId(word) {
  return crypto.createHash('sha1').update(normalize(word)).digest('hex').slice(0, 10);
}

function withIds(keywords) {
  return keywords.map((word) => ({ id: keywordId(word), word }));
}

function save(ctx, filters) {
  // The one place user-supplied filter content is written, so it is the one
  // place worth running the schema: it is the single declaration of both
  // ceilings, and everything above trusts that they hold.
  const parsed = filterSchema.safeParse(filters);
  if (!parsed.success) {
    logger.warn('Rejected filter update', { userId: ctx.from.id, error: parsed.error.message });
    return false;
  }
  setUserFilters(ctx.from.id, parsed.data);
  return true;
}

/**
 * Keywords are personal free text, and a /filter message in a group is one
 * message shared by everyone in it: whoever taps a button edits what the whole
 * group sees. Categories are a fixed list of five and were always like this,
 * but "квартальный отчёт" is nobody else's business, so keywords are shown and
 * edited in a private chat only.
 */
function isPrivate(ctx) {
  return Boolean(ctx.chat) && ctx.chat.type === 'private';
}

/**
 * The keyword list as one line, with the ones the plan does not match on
 * marked — the same convention the channel list uses, so a locked thing looks
 * locked wherever it is shown rather than only on the screen that owns it.
 */
function keywordsSummary(ctx, keywords) {
  const live = new Set(allowedKeywords(keywords, getLimits(ctx.state.subscription).maxKeywords));
  return keywords.map((word) => (live.has(word) ? word : `🔒 ${word}`)).join(', ');
}

function categoriesView(ctx) {
  const lang = ctx.state.lang;
  const { categories, keywords } = getUserFilters(ctx.from.id);

  // Keywords live on their own screen, so the topics screen says what is set
  // there — otherwise the only way to remember is to go and look.
  const text =
    keywords.length > 0 && isPrivate(ctx)
      ? `${t(lang, 'filter.choose')}\n\n${t(lang, 'filter.keywordsLine', {
          keywords: keywordsSummary(ctx, keywords),
        })}`
      : t(lang, 'filter.choose');

  return { text, keyboard: filterCategoriesMenu(lang, categories, isPrivate(ctx) ? keywords.length : 0) };
}

function keywordsView(ctx) {
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);
  const { keywords } = getUserFilters(ctx.from.id);
  const entries = withIds(keywords);
  const live = allowedKeywords(keywords, limits.maxKeywords);
  const liveIds = new Set(live.map(keywordId));

  // A keyword removed since the keyboard was drawn must not stay ticked, or
  // the count on the Remove button promises more than it can deliver.
  const known = new Set(entries.map((e) => e.id));
  const selectedIds = new Set([...keywordSelection.get(ctx.from.id)].filter((id) => known.has(id)));
  keywordSelection.set(ctx.from.id, selectedIds);

  let text =
    entries.length === 0
      ? t(lang, 'filter.keywordsEmpty')
      : `${t(lang, 'filter.keywordsHeader')}\n\n${t(lang, 'filter.keywordsHint')}`;

  // A lapsed subscriber can be following more keywords than their plan now
  // matches on. Saying so beats letting them wonder why a word they can see
  // never lights up.
  if (live.length < keywords.length) {
    text += `\n\n${t(lang, 'filter.keywordsSomeLocked', {
      allowed: live.length,
      total: keywords.length,
      premiumMax: PREMIUM_LIMITS.maxKeywords,
    })}`;
  }

  // Premium-gated, like the digest. Someone on the free plan sees no toggle
  // at all rather than one that refuses them.
  const alertsAvailable = limits.scheduledDigests;
  const alerts = alertsAvailable ? isSubscribed(ctx.from.id) : null;

  if (alerts) {
    text += `\n\n${t(lang, 'filter.alertsExplainer', { max: MAX_ALERTS_PER_HOUR })}`;
  }

  return { text, keyboard: filterKeywordsMenu(lang, { keywords: entries, selectedIds, liveIds, alerts }) };
}

/**
 * Hitting the free allowance is an upsell; hitting the premium ceiling is
 * housekeeping. Same condition, entirely different thing to say.
 */
function keywordLimitReply(ctx) {
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);
  const isPremium = Boolean(ctx.state.subscription);

  track(isPremium ? EVENTS.FILTER_BLOCKED_LIMIT : EVENTS.FILTER_BLOCKED_PREMIUM, { userId: ctx.from.id });

  return ctx.reply(
    isPremium
      ? t(lang, 'filter.keywordsAtLimit', { max: limits.maxKeywords })
      : t(lang, 'filter.keywordsFreeLimit', {
          max: limits.maxKeywords,
          premiumMax: PREMIUM_LIMITS.maxKeywords,
        })
  );
}

/**
 * Redraws the open screen in place. Telegram rejects an edit whose result is
 * identical to what is already shown, and a keyboard can outlive its message
 * entirely — neither is worth failing the interaction over.
 */
async function showView(ctx, view) {
  const { text, keyboard } = view(ctx);
  try {
    await ctx.editMessageText(text, keyboard);
    return true;
  } catch (error) {
    logger.debug('Filter screen edit skipped', { error: error.message });
    return false;
  }
}

function sendView(ctx, view) {
  const { text, keyboard } = view(ctx);
  return ctx.reply(text, keyboard);
}

async function filterHandler(ctx) {
  return sendView(ctx, categoriesView);
}

async function toggleCategory(ctx) {
  const category = ctx.match[1];
  const filters = getUserFilters(ctx.from.id);

  const categories = filters.categories.includes(category)
    ? filters.categories.filter((c) => c !== category)
    : [...filters.categories, category];

  save(ctx, { ...filters, categories });

  await showView(ctx, categoriesView);
  return ctx.answerCbQuery();
}

async function doneFiltering(ctx) {
  const lang = ctx.state.lang;
  const { categories, keywords } = getUserFilters(ctx.from.id);
  await ctx.answerCbQuery(t(lang, 'filter.saved'));

  if (categories.length === 0 && keywords.length === 0) {
    return ctx.reply(t(lang, 'filter.cleared'));
  }

  const lines = [];
  if (categories.length > 0) {
    // Stored categories are English keys; show them in the user's language.
    const labels = categories.map((c) => t(lang, `filter.categories.${c}`)).join(', ');
    lines.push(t(lang, 'filter.following', { categories: labels }));
  }
  if (keywords.length > 0 && isPrivate(ctx)) {
    lines.push(t(lang, 'filter.keywordsLine', { keywords: keywordsSummary(ctx, keywords) }));
  }
  return ctx.reply(lines.join('\n'));
}

/** Every keyword screen and action goes through here first. */
async function requirePrivate(ctx) {
  if (isPrivate(ctx)) return true;
  await ctx.answerCbQuery();
  await ctx.reply(t(ctx.state.lang, 'filter.keywordsGroupHint'));
  return false;
}

async function openKeywords(ctx) {
  if (!(await requirePrivate(ctx))) return undefined;
  await ctx.answerCbQuery();
  return showView(ctx, keywordsView);
}

/**
 * Turning the alerts on or off.
 *
 * The thing that turns this bot from something you ask into something that
 * messages you, so it is one tap in each direction and never on by default.
 */
async function toggleAlerts(ctx) {
  if (!(await requirePrivate(ctx))) return undefined;
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);

  if (!limits.scheduledDigests) {
    track(EVENTS.FILTER_BLOCKED_PREMIUM, { userId: ctx.from.id });
    return ctx.answerCbQuery(t(lang, 'digest.premiumOnlyShort'), { show_alert: true });
  }

  const next = !isSubscribed(ctx.from.id);
  setUserAlertsEnabled(ctx.from.id, next);
  setSubscribed(ctx.from.id, next);

  await showView(ctx, keywordsView);
  return ctx.answerCbQuery(t(lang, next ? 'filter.alertsEnabledShort' : 'filter.alertsDisabledShort'));
}

async function backToCategories(ctx) {
  clearPrompt(ctx.from.id, KEYWORD_PROMPT);
  await ctx.answerCbQuery();
  return showView(ctx, categoriesView);
}

async function toggleKeyword(ctx) {
  if (!(await requirePrivate(ctx))) return undefined;
  const lang = ctx.state.lang;
  const id = ctx.match[1];
  const { keywords } = getUserFilters(ctx.from.id);

  if (!withIds(keywords).some((e) => e.id === id)) {
    await ctx.answerCbQuery(t(lang, 'filter.keywordsGone'), { show_alert: true });
    return showView(ctx, keywordsView);
  }

  const selected = new Set(keywordSelection.get(ctx.from.id));
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  keywordSelection.set(ctx.from.id, selected);

  await showView(ctx, keywordsView);
  return ctx.answerCbQuery();
}

async function removeKeywords(ctx) {
  if (!(await requirePrivate(ctx))) return undefined;
  const lang = ctx.state.lang;
  const selected = keywordSelection.get(ctx.from.id);

  if (selected.size === 0) {
    return ctx.answerCbQuery(t(lang, 'filter.keywordsNothingSelected'), { show_alert: true });
  }

  // Driven by the user's own stored list rather than by the ids in
  // callback_data, so a stale or forged button can only ever match nothing.
  const filters = getUserFilters(ctx.from.id);
  const removed = filters.keywords.filter((word) => selected.has(keywordId(word)));
  const kept = filters.keywords.filter((word) => !selected.has(keywordId(word)));

  if (removed.length > 0) {
    save(ctx, { ...filters, keywords: kept });
    track(EVENTS.FILTER_KEYWORDS_REMOVED, { userId: ctx.from.id, metadata: { count: removed.length } });
  }

  keywordSelection.clear(ctx.from.id);
  await ctx.answerCbQuery(t(lang, 'filter.keywordsRemovedShort'));
  await showView(ctx, keywordsView);

  if (removed.length > 0) {
    return ctx.reply(t(lang, 'filter.keywordsRemoved', { keywords: removed.join(', ') }));
  }
  return undefined;
}

function promptForKeywords(ctx) {
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);
  armPrompt(ctx.from.id, KEYWORD_PROMPT);
  return ctx.reply(t(lang, 'filter.keywordsAddPrompt', { max: limits.maxKeywords }), {
    reply_markup: {
      inline_keyboard: [[{ text: t(lang, 'common.cancel'), callback_data: 'filter:kw:addcancel' }]],
    },
  });
}

async function addKeywordsCallback(ctx) {
  // Also the point where capturing the next message stops making sense: in a
  // group that message is somebody talking.
  if (!(await requirePrivate(ctx))) return undefined;
  const limits = getLimits(ctx.state.subscription);
  await ctx.answerCbQuery();

  // Said here rather than after they have typed a word we would only refuse.
  if (getUserFilters(ctx.from.id).keywords.length >= limits.maxKeywords) {
    return keywordLimitReply(ctx);
  }

  return promptForKeywords(ctx);
}

async function addCancelCallback(ctx) {
  const lang = ctx.state.lang;
  clearPrompt(ctx.from.id, KEYWORD_PROMPT);
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(t(lang, 'filter.keywordsAddCancelled'));
  } catch (error) {
    logger.debug('Keyword prompt cancel edit skipped', { error: error.message });
  }
  return undefined;
}

/**
 * Splits an answer into keywords on newlines, commas and semicolons — but
 * never on spaces. "world cup" and "машинное обучение" are single phrases the
 * matcher handles, and splitting them would quietly turn one precise filter
 * into two noisy ones.
 */
function parseKeywords(input) {
  return input
    .split(/[\n,;]+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

/**
 * Sorts an answer into what was taken and what was not, so the reply can say
 * exactly which words landed rather than silently dropping some of them.
 */
function classifyKeywords(existing, candidates, maxKeywords) {
  const seen = new Set(existing.map(normalize));
  const added = [];
  const duplicate = [];
  const tooLong = [];
  const overflow = [];

  for (const word of candidates) {
    if (word.length > MAX_KEYWORD_LENGTH) {
      tooLong.push(word);
    } else if (seen.has(normalize(word))) {
      // Case and ё/е are the matcher's idea of the same word, so they have to
      // be this list's idea of a duplicate too.
      duplicate.push(word);
    } else if (existing.length + added.length >= maxKeywords) {
      overflow.push(word);
    } else {
      seen.add(normalize(word));
      added.push(word);
    }
  }

  return { added, duplicate, tooLong, overflow };
}

async function handleKeywordAnswer(ctx, text) {
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);
  const isPremium = Boolean(ctx.state.subscription);
  const filters = getUserFilters(ctx.from.id);
  const candidates = parseKeywords(text);

  if (candidates.length === 0) {
    // Nothing usable in there: stay armed so retyping is enough.
    armPrompt(ctx.from.id, KEYWORD_PROMPT);
    return ctx.reply(t(lang, 'filter.keywordsNothingUseful'));
  }

  const { added, duplicate, tooLong, overflow } = classifyKeywords(
    filters.keywords,
    candidates,
    limits.maxKeywords
  );

  if (added.length > 0) {
    save(ctx, { ...filters, keywords: [...filters.keywords, ...added] });
    track(EVENTS.FILTER_KEYWORDS_ADDED, { userId: ctx.from.id, metadata: { count: added.length } });
  }

  const lines = [];
  if (added.length > 0) lines.push(t(lang, 'filter.keywordsAdded', { keywords: added.join(', ') }));
  if (duplicate.length > 0) {
    lines.push(t(lang, 'filter.keywordsDuplicate', { keywords: duplicate.join(', ') }));
  }
  if (tooLong.length > 0) {
    lines.push(t(lang, 'filter.keywordsTooLong', { max: MAX_KEYWORD_LENGTH, keywords: tooLong.join(', ') }));
  }
  if (overflow.length > 0) {
    // The wall a free user just hit is the one worth counting, and it reads
    // differently from a paying user filling their twenty.
    track(isPremium ? EVENTS.FILTER_BLOCKED_LIMIT : EVENTS.FILTER_BLOCKED_PREMIUM, { userId: ctx.from.id });
    lines.push(
      isPremium
        ? t(lang, 'filter.keywordsFull', { max: limits.maxKeywords, keywords: overflow.join(', ') })
        : t(lang, 'filter.keywordsFullFree', {
            max: limits.maxKeywords,
            premiumMax: PREMIUM_LIMITS.maxKeywords,
            keywords: overflow.join(', '),
          })
    );
  }

  await ctx.reply(lines.join('\n'));
  return sendView(ctx, keywordsView);
}

module.exports = (bot) => {
  bot.command('filter', filterHandler);
  bot.hears(allTranslations('menu.filters'), filterHandler);
  bot.action(/^filter:category:(.+)$/, toggleCategory);
  bot.action('filter:done', doneFiltering);
  bot.action('filter:keywords', openKeywords);
  bot.action('filter:back', backToCategories);
  // Registered ahead of the row pattern, which only matches a hash and so can
  // never claim these.
  bot.action('filter:kw:add', addKeywordsCallback);
  bot.action('filter:kw:addcancel', addCancelCallback);
  bot.action('filter:kw:remove', removeKeywords);
  bot.action(/^filter:kw:([0-9a-f]{10})$/, toggleKeyword);
  bot.on('text', captureReply(KEYWORD_PROMPT, handleKeywordAnswer));
};
