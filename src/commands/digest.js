const {
  getUserChats,
  isUserLinkedToChat,
  getScheduledDigest,
  setScheduledDigest,
  disableScheduledDigest,
  getUserTimezoneOffset,
  setUserTimezoneOffset,
} = require('../services/database');
const { getLimits } = require('../models/subscription');
const { isGroupChat } = require('../utils/formatters');
const {
  OFFSET_CHOICES,
  isValidOffset,
  formatOffset,
  formatLocalTime,
  hoursInLocalOrder,
} = require('../utils/timezone');
const { t, allTranslations } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');

/**
 * The four times offered before anyone could say where they live.
 *
 * Still the whole list for a user whose offset is unknown, so an existing
 * subscriber who never opens the timezone screen sees exactly what they saw
 * yesterday.
 */
const HOUR_OPTIONS = [9, 12, 18, 21];

/** "18:00 UTC" when we do not know their clock, "21:00" when we do. */
function formatHour(hourUtc, offsetMinutes) {
  return offsetMinutes === null ? `${String(hourUtc).padStart(2, '0')}:00 UTC` : formatLocalTime(hourUtc, offsetMinutes);
}

/** "21:00 (18:00 UTC)" — the local time, with the UTC it really is alongside. */
function formatHourWithUtc(hourUtc, offsetMinutes) {
  if (offsetMinutes === null || offsetMinutes === 0) return `${String(hourUtc).padStart(2, '0')}:00 UTC`;
  return `${formatLocalTime(hourUtc, offsetMinutes)} (${String(hourUtc).padStart(2, '0')}:00 UTC)`;
}

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

function timezoneMenu(lang, chatId) {
  const buttons = chunk(
    OFFSET_CHOICES.map((minutes) => ({
      text: formatOffset(minutes),
      callback_data: `digest:tz:${chatId}:${minutes}`,
    })),
    3
  );
  // The way past this screen in one tap. "Do not block the flow on it" is the
  // requirement, and an explicit UTC is also a real answer rather than a skip:
  // it is recorded, so nobody is asked twice.
  buttons.push([{ text: t(lang, 'digest.keepUtc'), callback_data: `digest:tz:${chatId}:0` }]);
  return { inline_keyboard: buttons };
}

function digestMenu(lang, chatId, existing, offsetMinutes) {
  // Four fixed UTC hours while the clock is unknown; all 24, in their own time
  // and in their own order, once it is.
  const options =
    offsetMinutes === null
      ? HOUR_OPTIONS.map((hourUtc) => ({ hourUtc, label: `${String(hourUtc).padStart(2, '0')}:00 UTC` }))
      : hoursInLocalOrder(offsetMinutes);

  const isSet = (hourUtc) => existing && existing.enabled && existing.hour_utc === hourUtc;
  const buttons = chunk(
    options.map((option) => ({
      text: `${isSet(option.hourUtc) ? '✅ ' : ''}${option.label}`,
      callback_data: `digest:set:${chatId}:${option.hourUtc}`,
    })),
    offsetMinutes === null ? 1 : 4
  );

  if (existing && existing.enabled) {
    buttons.push([{ text: t(lang, 'digest.turnOff'), callback_data: `digest:off:${chatId}` }]);
  }

  // Offered beside the times rather than in front of them. Asking first would
  // block somebody who just wants a digest at a UTC hour they already know,
  // and this is a convenience, not a required setting. Once it is answered the
  // same button becomes the way to correct it — people move, and people mistap.
  buttons.push([
    {
      text:
        offsetMinutes === null
          ? t(lang, 'digest.setTimezone')
          : t(lang, 'digest.changeTimezone', { zone: formatOffset(offsetMinutes) }),
      callback_data: `digest:tzmenu:${chatId}`,
    },
  ]);
  return { inline_keyboard: buttons };
}

async function showTimezoneMenu(ctx, chatId) {
  const lang = ctx.state.lang;
  return ctx.reply(t(lang, 'digest.pickTimezone'), { reply_markup: timezoneMenu(lang, chatId) });
}

async function showDigestMenu(ctx, chatId, chatTitle) {
  const lang = ctx.state.lang;
  const offsetMinutes = getUserTimezoneOffset(ctx.from.id);
  const existing = getScheduledDigest(chatId, ctx.from.id);

  const statusLine =
    existing && existing.enabled
      ? t(lang, 'digest.statusOn', { chat: chatTitle, time: formatHourWithUtc(existing.hour_utc, offsetMinutes) })
      : t(lang, 'digest.statusOff', { chat: chatTitle });

  // Unknown clock: the same four UTC hours as before, with the offer to fix
  // that underneath them.
  const prompt =
    offsetMinutes === null
      ? t(lang, 'digest.pickTime')
      : t(lang, 'digest.pickTimeLocal', { zone: formatOffset(offsetMinutes) });

  return ctx.reply(`${statusLine}\n\n${prompt}`, {
    parse_mode: 'Markdown',
    reply_markup: digestMenu(lang, chatId, existing, offsetMinutes),
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

function chatTitleFor(ctx, chatId) {
  const lang = ctx.state.lang;
  const chat = getUserChats(ctx.from.id).find((c) => c.id === chatId);
  return chat && chat.title ? chat.title : t(lang, 'common.chatFallback', { id: chatId });
}

async function digestChatCallback(ctx) {
  const lang = ctx.state.lang;
  const chatId = Number(ctx.match[1]);

  if (!isUserLinkedToChat(chatId, ctx.from.id)) {
    return ctx.answerCbQuery(t(lang, 'common.notAuthorizedForChat'), { show_alert: true });
  }

  await ctx.answerCbQuery();
  return showDigestMenu(ctx, chatId, chatTitleFor(ctx, chatId));
}

async function digestTimezoneMenuCallback(ctx) {
  const lang = ctx.state.lang;
  const chatId = Number(ctx.match[1]);

  if (!isUserLinkedToChat(chatId, ctx.from.id)) {
    return ctx.answerCbQuery(t(lang, 'common.notAuthorizedForChat'), { show_alert: true });
  }

  await ctx.answerCbQuery();
  return showTimezoneMenu(ctx, chatId);
}

async function digestTimezoneCallback(ctx) {
  const lang = ctx.state.lang;
  const chatId = Number(ctx.match[1]);
  const offsetMinutes = Number(ctx.match[2]);

  if (!isUserLinkedToChat(chatId, ctx.from.id)) {
    return ctx.answerCbQuery(t(lang, 'common.notAuthorizedForChat'), { show_alert: true });
  }

  // The keyboard is ours, but the callback data is whatever arrives.
  if (!isValidOffset(offsetMinutes)) {
    return ctx.answerCbQuery(t(lang, 'digest.unknownTimezone'), { show_alert: true });
  }

  setUserTimezoneOffset(ctx.from.id, offsetMinutes);
  await ctx.answerCbQuery(t(lang, 'digest.saved'));

  // Straight on to the times, now readable in their own clock. An already
  // scheduled digest keeps its hour_utc — the same moment, relabelled, because
  // the stored value is what the tick matches and it has not changed.
  return showDigestMenu(ctx, chatId, chatTitleFor(ctx, chatId));
}

async function digestSetCallback(ctx) {
  const lang = ctx.state.lang;
  const chatId = Number(ctx.match[1]);
  const hour = Number(ctx.match[2]);

  if (!isUserLinkedToChat(chatId, ctx.from.id)) {
    return ctx.answerCbQuery(t(lang, 'common.notAuthorizedForChat'), { show_alert: true });
  }

  const limits = getLimits(ctx.state.subscription);
  if (!limits.scheduledDigests) {
    return ctx.answerCbQuery(t(lang, 'digest.premiumOnlyShort'), { show_alert: true });
  }

  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return ctx.answerCbQuery(t(lang, 'digest.unknownTimezone'), { show_alert: true });
  }

  // hour_utc, always. The offset decides what the button said, never what is
  // stored — the hourly tick compares this value against the current UTC hour.
  setScheduledDigest({ chatId, userId: ctx.from.id, hourUtc: hour });
  track(EVENTS.DIGEST_CONFIGURED, { userId: ctx.from.id, chatId, metadata: { hourUtc: hour } });

  const offsetMinutes = getUserTimezoneOffset(ctx.from.id);
  await ctx.answerCbQuery(t(lang, 'digest.saved'));
  return ctx.editMessageText(t(lang, 'digest.enabled', { time: formatHourWithUtc(hour, offsetMinutes) }));
}

async function digestOffCallback(ctx) {
  const lang = ctx.state.lang;
  const chatId = Number(ctx.match[1]);

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
  bot.action(/^digest:tzmenu:(-?\d+)$/, digestTimezoneMenuCallback);
  bot.action(/^digest:tz:(-?\d+):(-?\d+)$/, digestTimezoneCallback);
  bot.action(/^digest:set:(-?\d+):(\d+)$/, digestSetCallback);
  bot.action(/^digest:off:(-?\d+)$/, digestOffCallback);
};

module.exports.formatHour = formatHour;
module.exports.formatHourWithUtc = formatHourWithUtc;
