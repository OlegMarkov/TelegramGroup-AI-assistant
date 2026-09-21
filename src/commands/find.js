const { searchMessages, getUserGroups, getAllowedUserChats, isChatWithinFreeLimit } = require('../services/database');
const { getLimits } = require('../models/subscription');
const {
  truncate,
  formatDate,
  isGroupChat,
  escapeMarkdown,
  splitForTelegram,
  messageLink,
  NO_PREVIEW,
} = require('../utils/formatters');
const { t, allTranslations } = require('../utils/i18n');
const { createTokenStore } = require('../utils/uiState');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

// Ten per message: comfortably inside Telegram's 4096 characters even when
// escaping adds a backslash per special character, and short enough to scan.
// Paging stops at MAX_RESULTS — past that, a narrower query is the better
// answer than another page.
const PAGE_SIZE = 10;
const MAX_RESULTS = 50;

// A query does not fit in 64 bytes of callback_data, so a "more" button
// carries a token for the search instead. Kept in memory: losing it on a
// restart costs one retyped /find.
const searches = createTokenStore();

function renderResults(lang, results) {
  // Results are quoted verbatim from group messages, so every part of them is
  // attacker-written text reaching Telegram's parser: the chat title, the
  // author's name and the message body alike. Unescaped, a message containing
  // "[click](http://evil)" renders as a link the user reads as coming from
  // this bot, and a single unbalanced "*" makes Telegram reject the whole
  // reply. Same treatment the digest highlights already get.
  return results.map((m) => {
    const chatLabel = m.chat_title ? `[${escapeMarkdown(m.chat_title)}] ` : '';
    const author = escapeMarkdown(m.username || t(lang, 'find.unknownAuthor'));
    const body = escapeMarkdown(truncate(m.text, 200));
    // A result is a quote out of context; the link is how you get the context.
    const link = messageLink({ id: m.chat_id, username: m.chat_username }, m.message_id);
    const open = link ? ` · [${t(lang, 'common.openLink')}](${link})` : '';
    return `${chatLabel}*${author}*\n${body}\n_${formatDate(m.created_at)}_${open}`;
  });
}

function moreKeyboard(lang, token, offset) {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: t(lang, 'find.more'), callback_data: `find:more:${token}:${offset}` }]],
    },
  };
}

/**
 * Sends one page of results, with a "more" button under the last part when
 * there is another page. Returns how many results the page held.
 */
async function sendPage(ctx, lang, search, offset) {
  // One extra row says whether a next page exists, without a COUNT(*).
  const rows = searchMessages({ chatIds: search.chatIds, query: search.query, limit: PAGE_SIZE + 1, offset });
  const results = rows.slice(0, PAGE_SIZE);
  if (results.length === 0) return 0;

  const nextOffset = offset + PAGE_SIZE;
  const hasMore = rows.length > PAGE_SIZE && nextOffset < MAX_RESULTS;
  const header = t(lang, offset === 0 ? 'find.header' : 'find.headerMore', { query: search.query });
  const body = `${header}\n\n${renderResults(lang, results).join('\n\n')}`;

  // A page full of escaped special characters can still cross 4096, and
  // Telegram rejects an oversized message outright rather than trimming it.
  const parts = splitForTelegram(body);
  for (const [index, part] of parts.entries()) {
    const more = hasMore && index === parts.length - 1 ? moreKeyboard(lang, search.token, nextOffset) : {};
    // Escaping makes malformed Markdown structurally impossible in the results
    // themselves, but the header interpolates the user's own query, so the
    // plain-text retry stays as the backstop — delivering search results
    // unformatted beats delivering nothing.
    try {
      await ctx.reply(part, { parse_mode: 'Markdown', ...NO_PREVIEW, ...more });
    } catch (error) {
      logger.warn('Search results rejected with Markdown, resending as plain text', { error: error.message });
      await ctx.reply(part, { ...NO_PREVIEW, ...more });
    }
  }
  return results.length;
}

async function findHandler(ctx) {
  const lang = ctx.state.lang;
  const query = ctx.message.text.split(' ').slice(1).join(' ').trim();

  if (!query) {
    return ctx.reply(t(lang, 'find.usage'));
  }

  track(EVENTS.FIND_REQUESTED, { userId: ctx.from.id, chatId: isGroupChat(ctx.chat) ? ctx.chat.id : undefined });

  const limits = getLimits(ctx.state.subscription);
  let chatIds;

  if (isGroupChat(ctx.chat)) {
    if (!isChatWithinFreeLimit(ctx.from.id, ctx.chat.id, limits.maxGroups)) {
      track(EVENTS.FIND_BLOCKED_GROUP_LIMIT, { userId: ctx.from.id, chatId: ctx.chat.id });
      return ctx.reply(t(lang, 'summary.blockedGroupLimit', { maxGroups: limits.maxGroups }));
    }
    chatIds = [ctx.chat.id];
  } else {
    // Groups only: channel posts are fetched at summary time and never stored,
    // so there is no history here to search.
    const allChats = getUserGroups(ctx.from.id);
    if (allChats.length === 0) {
      return ctx.reply(t(lang, 'find.noLinkedChats'));
    }
    chatIds = getAllowedUserChats(ctx.from.id, limits.maxGroups).map((c) => c.id);
  }

  // Fixed here, with the plan checks already applied, so a later page covers
  // exactly the chats this one was allowed to and nothing more.
  const search = { query, chatIds, ownerId: ctx.from.id };
  search.token = searches.put(search);

  const shown = await sendPage(ctx, lang, search, 0);
  if (shown === 0) {
    // How often search finds nothing is what says whether it is good enough;
    // a count of requests alone cannot.
    track(EVENTS.FIND_NO_RESULTS, { userId: ctx.from.id });
    return ctx.reply(t(lang, 'find.noResults', { query }));
  }
  return undefined;
}

async function moreResults(ctx) {
  const lang = ctx.state.lang;
  const [, token, offsetRaw] = ctx.match;
  const search = searches.get(token);
  const offset = Number(offsetRaw);

  // In a group everyone sees the button, but the search ran against one
  // person's plan and chat list, so only they can page through it.
  if (!search || search.ownerId !== ctx.from.id || !(offset > 0 && offset < MAX_RESULTS)) {
    return ctx.answerCbQuery(t(lang, 'find.expired'));
  }

  await ctx.answerCbQuery();
  // The button has done its job; leaving it would invite a second tap that
  // sends the same page again.
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  return sendPage(ctx, lang, search, offset);
}

module.exports = (bot) => {
  bot.command('find', findHandler);
  bot.action(/^find:more:([0-9a-f]{8}):(\d+)$/, moreResults);
  bot.hears(allTranslations('menu.find'), (ctx) => ctx.reply(t(ctx.state.lang, 'find.prompt')));
};

module.exports.PAGE_SIZE = PAGE_SIZE;
module.exports.MAX_RESULTS = MAX_RESULTS;
