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
  getHoursSinceLastSummary,
  recordSummaryRead,
} = require('../services/database');
const { generateDigest } = require('../services/digest');
const { isChatPaused } = require('../services/ingestionPolicy');
const { ChannelUnavailableError } = require('../services/channelSource');
const { SpendCapReachedError } = require('../services/aiBudget');
const { feedbackKeyboard } = require('./feedback');
const { getLimits, PREMIUM_LIMITS } = require('../models/subscription');
const { isGroupChat, splitForTelegram } = require('../utils/formatters');
const { startTyping } = require('../utils/typing');
const { t, allTranslations } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

const DEFAULT_HOURS = 24;
const ABSOLUTE_MAX_HOURS = 168; // sanity ceiling before per-plan clamping

// null means "no argument given", and is resolved per (user, chat) from
// summary_reads much later, in buildAndSendSummary. An explicit but unusable
// number still falls back to DEFAULT_HOURS: "/summary banana" asked for a
// number and got it wrong, which is a different thing from not asking.
function parseHours(args) {
  if (args.length === 0) return null;
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

  const isAuto = requestedHours === null;

  track(EVENTS.SUMMARY_REQUESTED, { userId: requesterId, chatId, metadata: { auto: isAuto } });

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

  // Resolved here rather than in summaryHandler: "since you last checked" is
  // per (user, chat), and the handler does not always know the chat yet — with
  // several linked chats it asks which one afterwards.
  let elapsed = null;
  let rawHours;
  if (isAuto) {
    elapsed = getHoursSinceLastSummary(requesterId, chatId);
    // Rounded UP, and to WHOLE hours. Up, because "since you last checked" must
    // never silently drop the most recent minutes of conversation — covering up
    // to an hour too much is the safe direction. Whole, because digest_cache is
    // keyed on this number: a per-user window carrying fractions would make
    // every request its own cache entry. Math.max(1) guards a zero or negative
    // window from clock skew.
    rawHours = elapsed === null ? DEFAULT_HOURS : Math.max(1, Math.ceil(elapsed));
  } else {
    rawHours = requestedHours;
  }

  // The very same clamp an explicit argument gets, reused rather than
  // duplicated: someone who has not asked for a fortnight is still capped at
  // 24h or 72h by plan, and the note below tells them so.
  const hours = Math.min(rawHours, limits.maxLookbackHours);
  const isPremium = Boolean(ctx.state.subscription);
  let capNote = '';
  if (hours < rawHours) {
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

  // Which window this actually covered. Empty for an explicit argument: the
  // user typed the number and does not need it read back to them.
  const autoNote = isAuto
    ? t(lang, elapsed === null ? 'summary.autoNoteFirstTime' : 'summary.autoNoteSinceLast')
    : '';

  const body =
    `${t(lang, 'summary.header', { hours, autoNote })}${truncatedNote}\n\n` +
    `${result.summaryText}${result.highlightBlock}${footer}`;

  const parts = splitForTelegram(body);

  let sent;
  for (const [index, part] of parts.entries()) {
    // Only the last part carries the buttons: a long summary arrives as
    // several messages, and a thumbs pair under each one asks the same
    // question four times.
    const extra = index === parts.length - 1 ? feedbackKeyboard(lang, { chatId, hours }) : {};

    try {
      sent = await ctx.reply(part, { parse_mode: 'Markdown', ...extra });
    } catch (error) {
      // The summary is model output shaped by content we do not control, so an
      // unbalanced * or _ is always possible and makes Telegram reject the
      // whole message. Delivering it unformatted beats delivering nothing —
      // and the buttons come with it, since the question is about the summary
      // rather than about its formatting.
      logger.warn('Summary part rejected with Markdown, resending as plain text', { error: error.message });
      sent = await ctx.reply(part, extra);
    }
  }

  // Recorded only once delivery has actually happened. incrementSummaryUsage
  // above can afford to run early because a daily quota self-corrects within
  // 24h — but a read recorded for a summary the user never received would skip
  // that content permanently, since every later "since you last checked" would
  // start from a timestamp covering messages they never saw.
  recordSummaryRead(requesterId, chatId);
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
      // The sentinel is spelled out rather than interpolating `hours` directly:
      // a bare null stringifies to the literal text "null", which reads back as
      // NaN on the other side.
      callback_data: `summary:chat:${c.id}:${hours === null ? 'auto' : hours}`,
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
  // 'auto' is tested before the coercion on purpose: Number('auto') is NaN, so
  // `Number(hoursRaw) || DEFAULT_HOURS` would quietly turn every chat picked
  // off the list back into a fixed 24h window and defeat the default entirely.
  const requestedHours = hoursRaw === 'auto' ? null : Number(hoursRaw) || DEFAULT_HOURS;
  return buildAndSendSummary(ctx, chatId, requestedHours);
}

module.exports = (bot) => {
  bot.command('summary', summaryHandler);
  bot.hears(allTranslations('menu.summary'), summaryHandler);
  bot.action(/^summary:chat:(-?\d+):(\d+|auto)$/, summaryCallback);
};

module.exports.parseHours = parseHours;
