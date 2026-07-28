const { searchMessages, getUserChats, getAllowedUserChats, isChatWithinFreeLimit } = require('../services/database');
const { getLimits } = require('../models/subscription');
const { truncate, formatDate, isGroupChat } = require('../utils/formatters');
const { t, allTranslations } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');

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
    const allChats = getUserChats(ctx.from.id);
    if (allChats.length === 0) {
      return ctx.reply(t(lang, 'find.noLinkedChats'));
    }
    const chats = getAllowedUserChats(ctx.from.id, limits.maxGroups);
    results = searchMessages({ chatIds: chats.map((c) => c.id), query, limit: 10 });
  }

  if (results.length === 0) {
    return ctx.reply(t(lang, 'find.noResults', { query }));
  }

  const lines = results.map((m) => {
    const chatLabel = m.chat_title ? `[${m.chat_title}] ` : '';
    return `${chatLabel}*${m.username || 'someone'}*\n${truncate(m.text, 200)}\n_${formatDate(m.created_at)}_`;
  });

  return ctx.reply(`${t(lang, 'find.header', { query })}\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
}

module.exports = (bot) => {
  bot.command('find', findHandler);
  bot.hears(allTranslations('menu.find'), (ctx) => ctx.reply(t(ctx.state.lang, 'find.prompt')));
};
