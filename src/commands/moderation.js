const { pauseChat, isChatPaused } = require('../services/ingestionPolicy');
const { getOrCreateChat } = require('../services/database');
const { isGroupChat } = require('../utils/formatters');
const { t } = require('../utils/i18n');
const logger = require('../utils/logger');

/**
 * /pause and /resume, for the admins of the group itself.
 *
 * Note this is a completely different notion of "admin" from /stats, /grant and
 * the rest: those are gated on config.adminUserIds, the person who owns the
 * bot. These are the admins of one particular group, asked of Telegram at the
 * moment the command runs. The bot owner has no say over someone else's group,
 * and a group's admins have no say over the bot.
 *
 * Anyone can add this bot to a group, and from that moment every member's
 * messages are stored. Before this there was no way to stop that short of
 * removing the bot entirely, which also throws away the summaries the group
 * presumably wanted.
 */
async function isGroupAdmin(ctx) {
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === 'creator' || member.status === 'administrator';
  } catch (error) {
    // Fails CLOSED. If Telegram will not say who is an admin, nobody is
    // treated as one — the alternative is letting any member pause a group
    // whenever the API is having a bad day.
    logger.warn('Could not determine group admin status', {
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      error: error.message,
    });
    return false;
  }
}

function setPaused(paused) {
  return async (ctx) => {
    const lang = ctx.state.lang;

    if (!isGroupChat(ctx.chat)) return ctx.reply(t(lang, 'moderation.groupOnly'));
    if (!(await isGroupAdmin(ctx))) return ctx.reply(t(lang, 'moderation.adminsOnly'));

    // The chat row has to exist before it can carry a paused flag, and an
    // admin may well reach for /pause before anyone has said anything.
    getOrCreateChat({ id: ctx.chat.id, title: ctx.chat.title, type: ctx.chat.type });

    if (isChatPaused(ctx.chat.id) === paused) {
      return ctx.reply(t(lang, paused ? 'moderation.alreadyPaused' : 'moderation.alreadyActive'));
    }

    pauseChat(ctx.chat.id, paused);
    logger.info(paused ? 'Ingestion paused for a chat' : 'Ingestion resumed for a chat', {
      chatId: ctx.chat.id,
      byUserId: ctx.from.id,
    });

    return ctx.reply(t(lang, paused ? 'moderation.paused' : 'moderation.resumed'), { parse_mode: 'Markdown' });
  };
}

module.exports = (bot) => {
  bot.command('pause', setPaused(true));
  bot.command('resume', setPaused(false));
};
