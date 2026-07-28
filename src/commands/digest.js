const {
  getUserChats,
  isUserLinkedToChat,
  getScheduledDigest,
  setScheduledDigest,
  disableScheduledDigest,
} = require('../services/database');
const { getLimits } = require('../models/subscription');
const { isGroupChat } = require('../utils/formatters');
const { t, allTranslations } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');

const HOUR_OPTIONS = [9, 12, 18, 21];

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00 UTC`;
}

function digestMenu(lang, chatId, existing) {
  const buttons = HOUR_OPTIONS.map((h) => [
    {
      text: `${existing && existing.enabled && existing.hour_utc === h ? '✅ ' : ''}${formatHour(h)}`,
      callback_data: `digest:set:${chatId}:${h}`,
    },
  ]);
  if (existing && existing.enabled) {
    buttons.push([{ text: t(lang, 'digest.turnOff'), callback_data: `digest:off:${chatId}` }]);
  }
  return { inline_keyboard: buttons };
}

async function showDigestMenu(ctx, chatId, chatTitle) {
  const lang = ctx.state.lang;
  const existing = getScheduledDigest(chatId, ctx.from.id);
  const statusLine =
    existing && existing.enabled
      ? t(lang, 'digest.statusOn', { chat: chatTitle, time: formatHour(existing.hour_utc) })
      : t(lang, 'digest.statusOff', { chat: chatTitle });

  return ctx.reply(`${statusLine}\n\n${t(lang, 'digest.pickTime')}`, {
    parse_mode: 'Markdown',
    reply_markup: digestMenu(lang, chatId, existing),
  });
}

async function digestHandler(ctx) {
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);
  if (!limits.scheduledDigests) {
    track(EVENTS.DIGEST_BLOCKED_PREMIUM, { userId: ctx.from.id });
    return ctx.reply(t(lang, 'digest.premiumOnly'));
  }

  if (isGroupChat(ctx.chat)) {
    return showDigestMenu(ctx, ctx.chat.id, ctx.chat.title);
  }

  const chats = getUserChats(ctx.from.id);

  if (chats.length === 0) {
    return ctx.reply(t(lang, 'common.noLinkedChats'));
  }

  if (chats.length === 1) {
    return showDigestMenu(ctx, chats[0].id, chats[0].title);
  }

  const buttons = chats.map((c) => [
    {
      text: c.title || t(lang, 'common.chatFallback', { id: c.id }),
      callback_data: `digest:chat:${c.id}`,
    },
  ]);
  return ctx.reply(t(lang, 'digest.pickChat'), { reply_markup: { inline_keyboard: buttons } });
}

async function digestChatCallback(ctx) {
  const lang = ctx.state.lang;
  const [, chatIdRaw] = ctx.match;
  const chatId = Number(chatIdRaw);

  if (!isUserLinkedToChat(chatId, ctx.from.id)) {
    return ctx.answerCbQuery(t(lang, 'common.notAuthorizedForChat'), { show_alert: true });
  }

  await ctx.answerCbQuery();
  const chat = getUserChats(ctx.from.id).find((c) => c.id === chatId);
  return showDigestMenu(ctx, chatId, chat ? chat.title : t(lang, 'common.chatFallback', { id: chatId }));
}

async function digestSetCallback(ctx) {
  const lang = ctx.state.lang;
  const [, chatIdRaw, hourRaw] = ctx.match;
  const chatId = Number(chatIdRaw);
  const hour = Number(hourRaw);

  if (!isUserLinkedToChat(chatId, ctx.from.id)) {
    return ctx.answerCbQuery(t(lang, 'common.notAuthorizedForChat'), { show_alert: true });
  }

  const limits = getLimits(ctx.state.subscription);
  if (!limits.scheduledDigests) {
    return ctx.answerCbQuery(t(lang, 'digest.premiumOnlyShort'), { show_alert: true });
  }

  setScheduledDigest({ chatId, userId: ctx.from.id, hourUtc: hour });
  track(EVENTS.DIGEST_CONFIGURED, { userId: ctx.from.id, chatId, metadata: { hourUtc: hour } });
  await ctx.answerCbQuery(t(lang, 'digest.saved'));
  return ctx.editMessageText(t(lang, 'digest.enabled', { time: formatHour(hour) }));
}

async function digestOffCallback(ctx) {
  const lang = ctx.state.lang;
  const [, chatIdRaw] = ctx.match;
  const chatId = Number(chatIdRaw);

  if (!isUserLinkedToChat(chatId, ctx.from.id)) {
    return ctx.answerCbQuery(t(lang, 'common.notAuthorizedForChat'), { show_alert: true });
  }

  disableScheduledDigest(chatId, ctx.from.id);
  await ctx.answerCbQuery(t(lang, 'digest.disabledShort'));
  return ctx.editMessageText(t(lang, 'digest.disabled'));
}

module.exports = (bot) => {
  bot.command('digest', digestHandler);
  bot.hears(allTranslations('menu.digest'), digestHandler);
  bot.action(/^digest:chat:(-?\d+)$/, digestChatCallback);
  bot.action(/^digest:set:(-?\d+):(\d+)$/, digestSetCallback);
  bot.action(/^digest:off:(-?\d+)$/, digestOffCallback);
};
