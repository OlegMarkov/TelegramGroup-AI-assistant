const config = require('../config');
const { getUserDataSummary, deleteUserData } = require('../services/database');
const { formatDate } = require('../utils/formatters');
const { t } = require('../utils/i18n');
const logger = require('../utils/logger');

async function privacyHandler(ctx) {
  const lang = ctx.state.lang;
  return ctx.reply(
    t(lang, 'privacy.policy', {
      retentionDays: config.privacy.messageRetentionDays,
      purgeDays: config.privacy.purgeAfterRemovalDays,
    }),
    { parse_mode: 'Markdown' }
  );
}

async function forgetMeHandler(ctx) {
  const lang = ctx.state.lang;
  const summary = getUserDataSummary(ctx.from.id);

  if (summary.messageCount === 0 && summary.chatCount === 0) {
    return ctx.reply(t(lang, 'privacy.nothingStored'));
  }

  const oldest = summary.oldestMessageAt
    ? t(lang, 'privacy.oldestSuffix', { date: formatDate(summary.oldestMessageAt) })
    : '';

  return ctx.reply(
    t(lang, 'privacy.confirmPrompt', {
      messageCount: summary.messageCount,
      chatCount: summary.chatCount,
      oldest,
    }),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, 'privacy.confirmButton'), callback_data: `privacy:forget:${ctx.from.id}` }],
          [{ text: t(lang, 'common.cancel'), callback_data: 'privacy:cancel' }],
        ],
      },
    }
  );
}

async function forgetConfirmCallback(ctx) {
  const lang = ctx.state.lang;
  const requesterId = Number(ctx.match[1]);

  // The button lives in a group chat too, so anyone could click it — only the
  // person whose data it is may confirm.
  if (ctx.from.id !== requesterId) {
    return ctx.answerCbQuery(t(lang, 'privacy.notYourConfirmation'), { show_alert: true });
  }

  try {
    const result = deleteUserData(requesterId);
    logger.info('User data deleted on request', { userId: requesterId, ...result });
    await ctx.answerCbQuery(t(lang, 'privacy.deletedShort'));
    return ctx.editMessageText(
      t(lang, 'privacy.deleted', { messages: result.messagesDeleted, chats: result.chatsAffected })
    );
  } catch (error) {
    logger.error('Failed to delete user data', { userId: requesterId, error: error.message });
    await ctx.answerCbQuery(t(lang, 'privacy.deleteFailedShort'), { show_alert: true });
    return ctx.reply(t(lang, 'privacy.deleteFailed'));
  }
}

async function cancelCallback(ctx) {
  const lang = ctx.state.lang;
  await ctx.answerCbQuery(t(lang, 'privacy.cancelledShort'));
  return ctx.editMessageText(t(lang, 'privacy.cancelled'));
}

module.exports = (bot) => {
  bot.command('privacy', privacyHandler);
  bot.command('forgetme', forgetMeHandler);
  bot.action(/^privacy:forget:(\d+)$/, forgetConfirmCallback);
  bot.action('privacy:cancel', cancelCallback);
};
