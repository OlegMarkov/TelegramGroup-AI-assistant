const { searchMessages, getUserGroups, getAllowedUserChats, isChatWithinFreeLimit } = require('../services/database');
const { getLimits } = require('../models/subscription');
const { truncate, formatDate, isGroupChat, escapeMarkdown, splitForTelegram } = require('../utils/formatters');
const { t, allTranslations } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

async function findHandler(ctx) {
  const lang = ctx.state.lang;
  const query = ctx.message.text.split(' ').slice(1).join(' ').trim();

  if (!query) {
    return ctx.reply(t(lang, 'find.usage'));
  }

  track(EVENTS.FIND_REQUESTED, { userId: ctx.from.id, chatId: isGroupChat(ctx.chat) ? ctx.chat.id : undefined });

  const limits = getLimits(ctx.state.subscription);
  let results;

  if (isGroupChat(ctx.chat)) {
    if (!isChatWithinFreeLimit(ctx.from.id, ctx.chat.id, limits.maxGroups)) {
      track(EVENTS.FIND_BLOCKED_GROUP_LIMIT, { userId: ctx.from.id, chatId: ctx.chat.id });
      return ctx.reply(t(lang, 'summary.blockedGroupLimit', { maxGroups: limits.maxGroups }));
    }
    results = searchMessages({ chatId: ctx.chat.id, query, limit: 10 });
  } else {
    // Groups only: channel posts are fetched at summary time and never stored,
    // so there is no history here to search.
    const allChats = getUserGroups(ctx.from.id);
    if (allChats.length === 0) {
      return ctx.reply(t(lang, 'find.noLinkedChats'));
    }
    const chats = getAllowedUserChats(ctx.from.id, limits.maxGroups);
    results = searchMessages({ chatIds: chats.map((c) => c.id), query, limit: 10 });
  }

  if (results.length === 0) {
    return ctx.reply(t(lang, 'find.noResults', { query }));
  }

  // Results are quoted verbatim from group messages, so every part of them is
  // attacker-written text reaching Telegram's parser: the chat title, the
  // author's name and the message body alike. Unescaped, a message containing
  // "[click](http://evil)" renders as a link the user reads as coming from
  // this bot, and a single unbalanced "*" makes Telegram reject the whole
  // reply. Same treatment the digest highlights already get.
  const lines = results.map((m) => {
    const chatLabel = m.chat_title ? `[${escapeMarkdown(m.chat_title)}] ` : '';
    const author = escapeMarkdown(m.username || t(lang, 'find.unknownAuthor'));
    const body = escapeMarkdown(truncate(m.text, 200));
    return `${chatLabel}*${author}*\n${body}\n_${formatDate(m.created_at)}_`;
  });

  const body = `${t(lang, 'find.header', { query })}\n\n${lines.join('\n\n')}`;

  // Ten results were comfortably inside Telegram's 4096-character limit until
  // escaping started adding a backslash per special character — a result set
  // full of them can now cross it, and Telegram rejects an oversized message
  // outright rather than trimming it.
  let sent;
  for (const part of splitForTelegram(body)) {
    // Escaping makes malformed Markdown structurally impossible in the results
    // themselves, but the header interpolates the user's own query, so the
    // plain-text retry stays as the backstop — delivering search results
    // unformatted beats delivering nothing.
    try {
      sent = await ctx.reply(part, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.warn('Search results rejected with Markdown, resending as plain text', { error: error.message });
      sent = await ctx.reply(part);
    }
  }
  return sent;
}

module.exports = (bot) => {
  bot.command('find', findHandler);
  bot.hears(allTranslations('menu.find'), (ctx) => ctx.reply(t(ctx.state.lang, 'find.prompt')));
};
