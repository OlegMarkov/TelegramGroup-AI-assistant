const {
  getUserGroups,
  getUserChannels,
  getAllowedUserChats,
  getAllowedUserChannels,
  isChannelWithinLimit,
  getChatById,
  isUserLinkedToChat,
  isChatWithinFreeLimit,
  getAskUsageToday,
  incrementAskUsage,
} = require('../services/database');
const { loadWindow, buildTranscript } = require('../services/digest');
const { answerQuestion } = require('../services/deepseek');
const { isChatPaused } = require('../services/ingestionPolicy');
const { ChannelUnavailableError } = require('../services/channelSource');
const { SpendCapReachedError } = require('../services/aiBudget');
const { getLimits, PREMIUM_LIMITS } = require('../models/subscription');
const { isGroupChat, splitForTelegram, normalizeModelMarkdown, truncate, NO_PREVIEW } = require('../utils/formatters');
const { startTyping } = require('../utils/typing');
const { createTokenStore } = require('../utils/uiState');
const { t } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

/**
 * /ask <question> — answers a question from one chat's recent history.
 *
 * Deliberately bounded by the same window a summary may read,
 * maxLookbackHours, rather than by everything retention keeps. PRIVACY.md
 * promises that what reaches the AI provider is the transcript of one chat's
 * lookback window and nothing more; an answer drawn from that same window
 * keeps that promise, where one drawn from ninety days of history would need a
 * different one. Going wider is a policy decision before it is a code change.
 */

// Long enough for a real question, short enough that nobody pastes a document.
const MAX_QUESTION_CHARS = 300;

// The question does not fit in callback_data, so when the chat has to be
// picked first it waits here under a token. Losing it on a restart costs one
// retyped question.
const pendingQuestions = createTokenStore();

async function answerInChat(ctx, chatId, question) {
  const lang = ctx.state.lang;
  const userId = ctx.from.id;
  const limits = getLimits(ctx.state.subscription);
  const chat = getChatById(chatId);
  const isChannel = Boolean(chat && chat.source === 'channel');

  // Enforced here and not only in the picker: callback_data is supplied by the
  // client, and a lapsed subscriber still holds buttons for every chat.
  if (isChannel && !isChannelWithinLimit(userId, chatId, limits.maxChannels)) {
    return ctx.reply(
      t(lang, 'channel.blockedLimit', { max: limits.maxChannels, premiumMax: PREMIUM_LIMITS.maxChannels }),
      { parse_mode: 'Markdown' }
    );
  }
  if (!isChannel && !isChatWithinFreeLimit(userId, chatId, limits.maxGroups)) {
    return ctx.reply(t(lang, 'summary.blockedGroupLimit', { maxGroups: limits.maxGroups }));
  }

  // An admin who paused the group asked the bot to stop reading it.
  if (isChatPaused(chatId)) return ctx.reply(t(lang, 'summary.chatPaused'));

  if (getAskUsageToday(userId) >= limits.maxQuestionsPerDay) {
    track(EVENTS.ASK_BLOCKED_DAILY_LIMIT, { userId, chatId });
    return ctx.reply(t(lang, 'ask.dailyLimit', { limit: limits.maxQuestionsPerDay }));
  }

  const hours = limits.maxLookbackHours;
  const stopTyping = startTyping(ctx);

  let answer;
  try {
    const { items, isChannel: fromChannel } = await loadWindow(chat || { id: chatId }, hours);
    if (items.length === 0) return ctx.reply(t(lang, 'ask.noActivity', { hours }));
    answer = await answerQuestion(buildTranscript(items, fromChannel), question, {
      language: t(lang, 'aiPromptLanguage'),
    });
  } catch (error) {
    if (error instanceof ChannelUnavailableError) {
      return ctx.reply(t(lang, 'channel.unavailable', { handle: chat.username }), { parse_mode: 'Markdown' });
    }
    // Not charged against the daily allowance: nothing was answered.
    if (error instanceof SpendCapReachedError) {
      logger.warn('Refused a question: daily AI budget reached', { userId, chatId });
      return ctx.reply(t(lang, 'summary.budgetReached'));
    }
    logger.error('Answering a question failed', { userId, chatId, error: error.message });
    return ctx.reply(t(lang, 'ask.failed'));
  } finally {
    stopTyping();
  }

  incrementAskUsage(userId);
  track(EVENTS.ASK_ANSWERED, { userId, chatId });

  const body = `${t(lang, 'ask.header', { hours })}\n\n${normalizeModelMarkdown(answer)}`;
  let sent;
  for (const part of splitForTelegram(body)) {
    // Model output shaped by content we do not control: unbalanced Markdown is
    // always possible, and an unformatted answer beats none.
    try {
      sent = await ctx.reply(part, { parse_mode: 'Markdown', ...NO_PREVIEW });
    } catch (error) {
      logger.warn('Answer rejected with Markdown, resending as plain text', { error: error.message });
      sent = await ctx.reply(part, NO_PREVIEW);
    }
  }
  return sent;
}

async function askHandler(ctx) {
  const lang = ctx.state.lang;
  const question = ctx.message.text.split(' ').slice(1).join(' ').trim();

  if (!question) return ctx.reply(t(lang, 'ask.usage'));
  if (question.length > MAX_QUESTION_CHARS) {
    return ctx.reply(t(lang, 'ask.tooLong', { max: MAX_QUESTION_CHARS }));
  }

  const userId = ctx.from.id;
  const limits = getLimits(ctx.state.subscription);
  track(EVENTS.ASK_REQUESTED, { userId, chatId: isGroupChat(ctx.chat) ? ctx.chat.id : undefined });

  if (limits.maxQuestionsPerDay <= 0) {
    track(EVENTS.ASK_BLOCKED_PREMIUM, { userId });
    return ctx.reply(t(lang, 'ask.premiumOnly'));
  }

  if (isGroupChat(ctx.chat)) return answerInChat(ctx, ctx.chat.id, question);

  // The same list /summary offers, with the same plan limits applied.
  const allGroups = getUserGroups(userId);
  const allChannels = getUserChannels(userId);
  if (allGroups.length === 0 && allChannels.length === 0) return ctx.reply(t(lang, 'common.noLinkedChats'));

  const chats = [...getAllowedUserChats(userId, limits.maxGroups), ...getAllowedUserChannels(userId, limits.maxChannels)];
  if (chats.length === 1) return answerInChat(ctx, chats[0].id, question);

  const token = pendingQuestions.put({ question, ownerId: userId });
  const buttons = chats.map((c) => [
    {
      text: `${c.source === 'channel' ? '📢 ' : '💬 '}${c.title || t(lang, 'common.chatFallback', { id: c.id })}`,
      callback_data: `ask:chat:${c.id}:${token}`,
    },
  ]);
  return ctx.reply(t(lang, 'ask.pickChat', { question: truncate(question, 80) }), {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function askCallback(ctx) {
  const lang = ctx.state.lang;
  const [, chatIdRaw, token] = ctx.match;
  const chatId = Number(chatIdRaw);
  const pending = pendingQuestions.get(token);

  if (!pending || pending.ownerId !== ctx.from.id) return ctx.answerCbQuery(t(lang, 'ask.expired'));
  if (!isUserLinkedToChat(chatId, ctx.from.id)) {
    return ctx.answerCbQuery(t(lang, 'common.notAuthorizedForChat'), { show_alert: true });
  }

  await ctx.answerCbQuery();
  return answerInChat(ctx, chatId, pending.question);
}

module.exports = (bot) => {
  bot.command('ask', askHandler);
  bot.action(/^ask:chat:(-?\d+):([0-9a-f]{8})$/, askCallback);
};

module.exports.MAX_QUESTION_CHARS = MAX_QUESTION_CHARS;
