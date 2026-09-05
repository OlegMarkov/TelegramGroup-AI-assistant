const config = require('../config');
const { getUserDataSummary, deleteUserData } = require('../services/database');
const { optOutUser, isOptedOut } = require('../services/ingestionPolicy');
const { GROUP_MESSAGE_CHARS } = require('../services/digest');
const { formatDate } = require('../utils/formatters');
const { t, allTranslations } = require('../utils/i18n');
const logger = require('../utils/logger');

/**
 * The opt-out toggle, drawn wherever someone is thinking about their data.
 *
 * It has to be reachable, not just documented: "can I stop you storing my
 * messages?" previously had no answer except "leave the group".
 */
function optOutKeyboard(lang, userId) {
  const optedOut = isOptedOut(userId);
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: t(lang, optedOut ? 'privacy.optInButton' : 'privacy.optOutButton'),
            callback_data: optedOut ? `privacy:optin:${userId}` : `privacy:optout:${userId}`,
          },
        ],
      ],
    },
  };
}

async function privacyHandler(ctx) {
  const lang = ctx.state.lang;
  const optedOut = isOptedOut(ctx.from.id);

  const body =
    t(lang, 'privacy.policy', {
      retentionDays: config.privacy.messageRetentionDays,
      purgeDays: config.privacy.purgeAfterRemovalDays,
      groupChars: GROUP_MESSAGE_CHARS,
    }) +
    '\n\n' +
    t(lang, optedOut ? 'privacy.currentlyOptedOut' : 'privacy.currentlyStoring');

  return ctx.reply(body, { parse_mode: 'Markdown', ...optOutKeyboard(lang, ctx.from.id) });
}

/**
 * Toggling collection off, or back on.
 *
 * The user id is carried in the callback data and checked, because in a group
 * the buttons are visible to everyone: without it, anyone could opt somebody
 * else out, or quietly opt them back in.
 */
function optOutCallback(optOut) {
  return async (ctx) => {
    const lang = ctx.state.lang;
    const requesterId = Number(ctx.match[1]);

    if (ctx.from.id !== requesterId) {
      return ctx.answerCbQuery(t(lang, 'privacy.notYourConfirmation'), { show_alert: true });
    }

    optOutUser(requesterId, optOut);
    logger.info(optOut ? 'User opted out of message storage' : 'User opted back in', { userId: requesterId });

    await ctx.answerCbQuery(t(lang, optOut ? 'privacy.optedOutShort' : 'privacy.optedInShort'));
    return ctx.reply(t(lang, optOut ? 'privacy.optedOut' : 'privacy.optedIn'), {
      parse_mode: 'Markdown',
      ...optOutKeyboard(lang, requesterId),
    });
  };
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
    await ctx.editMessageText(
      t(lang, 'privacy.deleted', { messages: result.messagesDeleted, chats: result.chatsAffected })
    );

    // Someone deleting their data probably does not want it collected again an
    // hour later. Offered here rather than done automatically: deleting what
    // exists and refusing what comes next are two different decisions, and
    // making the second one for them would be presumptuous.
    if (!isOptedOut(requesterId)) {
      return ctx.reply(t(lang, 'privacy.offerOptOut'), {
        parse_mode: 'Markdown',
        ...optOutKeyboard(lang, requesterId),
      });
    }
    return undefined;
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
  bot.hears(allTranslations('menu.privacy'), privacyHandler);
  bot.command('forgetme', forgetMeHandler);
  bot.action(/^privacy:forget:(\d+)$/, forgetConfirmCallback);
  bot.action(/^privacy:optout:(\d+)$/, optOutCallback(true));
  bot.action(/^privacy:optin:(\d+)$/, optOutCallback(false));
  bot.action('privacy:cancel', cancelCallback);
};
