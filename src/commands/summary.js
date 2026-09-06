const {
  getUserGroups,
  getUserChannels,
  getAllowedUserChats,
  getAllowedUserChannels,
  isChannelWithinLimit,
  getChatById,
  isUserLinkedToChat,
  isChatWithinFreeLimit,
  getSummaryUsageToday,
  incrementSummaryUsage,
} = require('../services/database');
const { generateDigest } = require('../services/digest');
const { isChatPaused } = require('../services/ingestionPolicy');
const { ChannelUnavailableError } = require('../services/channelSource');
const { SpendCapReachedError } = require('../services/aiBudget');
const { getLimits, PREMIUM_LIMITS } = require('../models/subscription');
const { isGroupChat, splitForTelegram } = require('../utils/formatters');
const { startTyping } = require('../utils/typing');
const { t, allTranslations } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

const DEFAULT_HOURS = 24;
const ABSOLUTE_MAX_HOURS = 168; // sanity ceiling before per-plan clamping

function parseHours(args) {
  const n = Number(args[0]);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HOURS;
  return Math.min(n, ABSOLUTE_MAX_HOURS);
}

async function buildAndSendSummary(ctx, chatId, requestedHours) {
  const requesterId = ctx.from.id;
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);
  const chat = getChatById(chatId);
  const isChannel = Boolean(chat && chat.source === 'channel');

  track(EVENTS.SUMMARY_REQUESTED, { userId: requesterId, chatId });

  // Enforced here rather than only in the picker: callback_data is supplied by
  // the client, so a user whose subscription lapsed still has working buttons
  // for every channel they ever saw listed.
  if (isChannel && !isChannelWithinLimit(requesterId, chatId, limits.maxChannels)) {
    track(EVENTS.CHANNEL_BLOCKED_PREMIUM, { userId: requesterId, chatId });
    return ctx.reply(
      t(lang, 'channel.blockedLimit', { max: limits.maxChannels, premiumMax: PREMIUM_LIMITS.maxChannels }),
      { parse_mode: 'Markdown' }
    );
  }

  // The group quota does not apply to channels — they have their own cap.
  if (!isChannel && !isChatWithinFreeLimit(requesterId, chatId, limits.maxGroups)) {
    track(EVENTS.SUMMARY_BLOCKED_GROUP_LIMIT, { userId: requesterId, chatId });
    return ctx.reply(t(lang, 'summary.blockedGroupLimit', { maxGroups: limits.maxGroups }));
  }

  // Refused rather than summarized from whatever is still stored. An admin who
  // paused the group asked the bot to stop reading it, and quietly producing
  // summaries of the messages from before would answer a question nobody asked.
  // Checked before the daily allowance so a paused chat cannot burn one.
  if (isChatPaused(chatId)) {
    return ctx.reply(t(lang, 'summary.chatPaused'));
  }

  const usageToday = getSummaryUsageToday(requesterId);
  if (usageToday >= limits.maxSummariesPerDay) {
    track(EVENTS.SUMMARY_BLOCKED_DAILY_LIMIT, { userId: requesterId, chatId });
    return ctx.reply(t(lang, 'summary.blockedDailyLimit', { limit: limits.maxSummariesPerDay }));
  }

  const hours = Math.min(requestedHours, limits.maxLookbackHours);
  const isPremium = Boolean(ctx.state.subscription);
  let capNote = '';
  if (hours < requestedHours) {
    capNote = isPremium
      ? t(lang, 'summary.capNotePremium', { hours })
      : t(lang, 'summary.capNoteFree', { hours, maxHours: PREMIUM_LIMITS.maxLookbackHours });
  }

  await ctx.reply(t(lang, 'summary.working', { hours, capNote }));

  // Writing a summary takes ~25 seconds, during which the chat is silent and
  // looks stuck. The indicator is refreshed for the whole wait, and stopped in
  // `finally` so a failed digest cannot leave it running.
  const stopTyping = startTyping(ctx);

  let result;
  try {
    result = await generateDigest(chatId, requesterId, hours, lang);
  } catch (error) {
    // A channel that went private or was renamed since it was added.
    if (error instanceof ChannelUnavailableError) {
      return ctx.reply(t(lang, 'channel.unavailable', { handle: chat.username }), { parse_mode: 'Markdown' });
    }

    // We chose not to make this call. Say so plainly rather than reporting a
    // failure that sounds like the bot is broken — and do not charge the user
    // a daily allowance for a summary they did not get.
    if (error instanceof SpendCapReachedError) {
      logger.warn('Refused a summary: daily AI budget reached', {
        userId: requesterId,
        chatId,
        usage: error.usage,
        limit: error.limit,
      });
      return ctx.reply(t(lang, 'summary.budgetReached'));
    }
    logger.error('Summary generation failed', { error: error.message });
    return ctx.reply(t(lang, 'summary.failed'));
  } finally {
    stopTyping();
  }

  if (!result) {
    return ctx.reply(t(lang, 'summary.noActivity', { hours }));
  }

  incrementSummaryUsage(requesterId);
  track(EVENTS.SUMMARY_COMPLETED, { userId: requesterId, chatId });

  // Assembled per request and never cached, like the header: a footer inside
  // the cached text would be shared across every requester and every window.
  // Groups only — a channel summary has no members to tell.
  const footer = result.isChannel ? '' : `\n\n${t(lang, 'summary.footer')}`;

  // Assembled here rather than cached, exactly like the header and the footer:
  // whether the window was truncated depends on the window, and the cached
  // summary text is shared across every requester who asks for it.
  const truncatedNote = result.truncated
    ? `\n${t(lang, 'summary.truncatedNote', { shown: result.messageCount, total: result.totalAvailable })}`
    : '';

  const body =
    `${t(lang, 'summary.header', { hours })}${truncatedNote}\n\n` +
    `${result.summaryText}${result.highlightBlock}${footer}`;

  let sent;
  for (const part of splitForTelegram(body)) {
    try {
      sent = await ctx.reply(part, { parse_mode: 'Markdown' });
    } catch (error) {
      // The summary is model output shaped by content we do not control, so an
      // unbalanced * or _ is always possible and makes Telegram reject the
      // whole message. Delivering it unformatted beats delivering nothing.
      logger.warn('Summary part rejected with Markdown, resending as plain text', { error: error.message });
      sent = await ctx.reply(part);
    }
  }
  return sent;
}

async function summaryHandler(ctx) {
  const lang = ctx.state.lang;
  const args = ctx.message.text.split(' ').slice(1);
  const hours = parseHours(args);

  if (isGroupChat(ctx.chat)) {
    return buildAndSendSummary(ctx, ctx.chat.id, hours);
  }

  const limits = getLimits(ctx.state.subscription);
  const allGroups = getUserGroups(ctx.from.id);
  const allowedGroups = getAllowedUserChats(ctx.from.id, limits.maxGroups);
  // A lapsed subscriber keeps their earliest channels up to the free
  // allowance; the rest stay saved but unlisted until they resubscribe.
  const allChannels = getUserChannels(ctx.from.id);
  const channels = getAllowedUserChannels(ctx.from.id, limits.maxChannels);
  const chats = [...allowedGroups, ...channels];

  if (allGroups.length === 0 && allChannels.length === 0) {
    return ctx.reply(t(lang, 'common.noLinkedChats'));
  }

  if (allowedGroups.length < allGroups.length) {
    await ctx.reply(
      t(lang, 'summary.hiddenGroupsNote', { total: allGroups.length, allowed: limits.maxGroups })
    );
  }

  if (chats.length === 1) {
    return buildAndSendSummary(ctx, chats[0].id, hours);
  }

  const buttons = chats.map((c) => [
    {
      // Groups and channels sit in one list, so the icon is the only thing
      // telling the user which kind of thing they are about to summarize.
      text: `${c.source === 'channel' ? '📢 ' : '💬 '}${c.title || t(lang, 'common.chatFallback', { id: c.id })}`,
      callback_data: `summary:chat:${c.id}:${hours}`,
    },
  ]);
  return ctx.reply(t(lang, 'summary.pickChat'), { reply_markup: { inline_keyboard: buttons } });
}

async function summaryCallback(ctx) {
  const [, chatIdRaw, hoursRaw] = ctx.match;
  const chatId = Number(chatIdRaw);

  if (!isUserLinkedToChat(chatId, ctx.from.id)) {
    return ctx.answerCbQuery(t(ctx.state.lang, 'common.notAuthorizedForChat'), { show_alert: true });
  }

  await ctx.answerCbQuery();
  return buildAndSendSummary(ctx, chatId, Number(hoursRaw) || DEFAULT_HOURS);
}

module.exports = (bot) => {
  bot.command('summary', summaryHandler);
  bot.hears(allTranslations('menu.summary'), summaryHandler);
  bot.action(/^summary:chat:(-?\d+):(\d+)$/, summaryCallback);
};
