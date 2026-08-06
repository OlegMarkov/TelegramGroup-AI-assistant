const {
  getUserGroups,
  getUserChannels,
  getAllowedUserChats,
  getChatById,
  isUserLinkedToChat,
  isChatWithinFreeLimit,
  getSummaryUsageToday,
  incrementSummaryUsage,
} = require('../services/database');
const { generateDigest } = require('../services/digest');
const { ChannelUnavailableError } = require('../services/channelSource');
const { getLimits, PREMIUM_LIMITS } = require('../models/subscription');
const { isGroupChat, splitForTelegram } = require('../utils/formatters');
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
  if (isChannel && limits.maxChannels === 0) {
    track(EVENTS.CHANNEL_BLOCKED_PREMIUM, { userId: requesterId, chatId });
    return ctx.reply(t(lang, 'channel.premiumOnly'), { parse_mode: 'Markdown' });
  }

  // The group quota does not apply to channels — they have their own cap.
  if (!isChannel && !isChatWithinFreeLimit(requesterId, chatId, limits.maxGroups)) {
    track(EVENTS.SUMMARY_BLOCKED_GROUP_LIMIT, { userId: requesterId, chatId });
    return ctx.reply(t(lang, 'summary.blockedGroupLimit', { maxGroups: limits.maxGroups }));
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

  let result;
  try {
    result = await generateDigest(chatId, requesterId, hours, lang);
  } catch (error) {
    // A channel that went private or was renamed since it was added.
    if (error instanceof ChannelUnavailableError) {
      return ctx.reply(t(lang, 'channel.unavailable', { handle: chat.username }), { parse_mode: 'Markdown' });
    }
    logger.error('Summary generation failed', { error: error.message });
    return ctx.reply(t(lang, 'summary.failed'));
  }

  if (!result) {
    return ctx.reply(t(lang, 'summary.noActivity', { hours }));
  }

  incrementSummaryUsage(requesterId);
  track(EVENTS.SUMMARY_COMPLETED, { userId: requesterId, chatId });

  const body = `${t(lang, 'summary.header', { hours })}\n\n${result.summaryText}${result.highlightBlock}`;

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
  // Free users keep any channels they added while subscribed, but none of them
  // are offered until they resubscribe.
  const channels = limits.maxChannels > 0 ? getUserChannels(ctx.from.id) : [];
  const chats = [...allowedGroups, ...channels];

  if (allGroups.length === 0 && channels.length === 0) {
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
