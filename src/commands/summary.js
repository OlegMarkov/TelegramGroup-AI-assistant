const {
  getUserChats,
  getAllowedUserChats,
  isUserLinkedToChat,
  isChatWithinFreeLimit,
  getSummaryUsageToday,
  incrementSummaryUsage,
} = require('../services/database');
const { generateDigest } = require('../services/digest');
const { getLimits, PREMIUM_LIMITS } = require('../models/subscription');
const { isGroupChat } = require('../utils/formatters');
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

  track(EVENTS.SUMMARY_REQUESTED, { userId: requesterId, chatId });

  if (!isChatWithinFreeLimit(requesterId, chatId, limits.maxGroups)) {
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
    logger.error('Summary generation failed', { error: error.message });
    return ctx.reply(t(lang, 'summary.failed'));
  }

  if (!result) {
    return ctx.reply(t(lang, 'summary.noActivity', { hours }));
  }

  incrementSummaryUsage(requesterId);
  track(EVENTS.SUMMARY_COMPLETED, { userId: requesterId, chatId });

  return ctx.reply(
    `${t(lang, 'summary.header', { hours })}\n\n${result.summaryText}${result.highlightBlock}`,
    { parse_mode: 'Markdown' }
  );
}

async function summaryHandler(ctx) {
  const lang = ctx.state.lang;
  const args = ctx.message.text.split(' ').slice(1);
  const hours = parseHours(args);

  if (isGroupChat(ctx.chat)) {
    return buildAndSendSummary(ctx, ctx.chat.id, hours);
  }

  const limits = getLimits(ctx.state.subscription);
  const allChats = getUserChats(ctx.from.id);
  const chats = getAllowedUserChats(ctx.from.id, limits.maxGroups);

  if (allChats.length === 0) {
    return ctx.reply(t(lang, 'common.noLinkedChats'));
  }

  if (chats.length < allChats.length) {
    await ctx.reply(
      t(lang, 'summary.hiddenGroupsNote', { total: allChats.length, allowed: limits.maxGroups })
    );
  }

  if (chats.length === 1) {
    return buildAndSendSummary(ctx, chats[0].id, hours);
  }

  const buttons = chats.map((c) => [
    {
      text: c.title || t(lang, 'common.chatFallback', { id: c.id }),
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
