const {
  getOrCreateChannel,
  getUserChannels,
  getAllowedUserChannels,
  linkUserToChat,
  unlinkUserFromChat,
  getChannelByUsername,
} = require('../services/database');
const { resolveChannel, normalizeHandle, ChannelUnavailableError } = require('../services/channelSource');
const { getLimits, PREMIUM_LIMITS } = require('../models/subscription');
const { escapeMarkdown } = require('../utils/formatters');
const { t, allTranslations } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

function renderList(lang, channels) {
  if (channels.length === 0) return t(lang, 'channel.empty');

  const lines = channels.map((c) => `• *${escapeMarkdown(c.title || c.username)}* — @${c.username}`);
  return `${t(lang, 'channel.listHeader')}\n${lines.join('\n')}\n\n${t(lang, 'channel.listHint')}`;
}

async function listHandler(ctx) {
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);
  const channels = getUserChannels(ctx.from.id);
  const allowed = getAllowedUserChannels(ctx.from.id, limits.maxChannels);

  let body = renderList(lang, channels);

  // A lapsed subscriber can be following more channels than their plan now
  // allows. Saying so beats letting them wonder why a channel they can see
  // is missing from /summary.
  if (allowed.length < channels.length) {
    body += `\n\n${t(lang, 'channel.someLocked', {
      allowed: allowed.length,
      total: channels.length,
      premiumMax: PREMIUM_LIMITS.maxChannels,
    })}`;
  }

  return ctx.reply(body, { parse_mode: 'Markdown' });
}

async function addHandler(ctx) {
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();

  if (!arg) return ctx.reply(t(lang, 'channel.usage'));

  // Validate before any network call: this value would otherwise be
  // interpolated into a URL fetched by the server.
  const handle = normalizeHandle(arg);
  if (!handle) return ctx.reply(t(lang, 'channel.invalidHandle'));

  const existing = getChannelByUsername(handle);
  const alreadyFollowed = getUserChannels(ctx.from.id).some((c) => c.username === handle);
  if (alreadyFollowed) {
    return ctx.reply(t(lang, 'channel.alreadyAdded', { handle }));
  }

  // Checked against the user's own list, not the global channel table, and
  // before the fetch so a user at their cap cannot use /addchannel as a way to
  // make the server issue requests.
  const followed = getUserChannels(ctx.from.id).length;
  if (followed >= limits.maxChannels) {
    // Hitting the free allowance is an upsell; hitting the premium ceiling is
    // housekeeping. Same condition, entirely different thing to say.
    const isPremium = Boolean(ctx.state.subscription);
    track(isPremium ? EVENTS.CHANNEL_BLOCKED_LIMIT : EVENTS.CHANNEL_BLOCKED_PREMIUM, { userId: ctx.from.id });
    return ctx.reply(
      isPremium
        ? t(lang, 'channel.limitReached', { max: limits.maxChannels })
        : t(lang, 'channel.freeLimitReached', {
            max: limits.maxChannels,
            premiumMax: PREMIUM_LIMITS.maxChannels,
          }),
      { parse_mode: 'Markdown' }
    );
  }

  await ctx.reply(t(lang, 'channel.checking', { handle }));

  let resolved;
  try {
    resolved = await resolveChannel(handle);
  } catch (error) {
    if (error instanceof ChannelUnavailableError) {
      return ctx.reply(t(lang, 'channel.unavailable', { handle }), { parse_mode: 'Markdown' });
    }
    logger.error('Channel resolution failed', { handle, error: error.message });
    return ctx.reply(t(lang, 'channel.checkFailed'));
  }

  const chat = getOrCreateChannel({
    username: resolved.handle,
    title: resolved.title,
    addedBy: ctx.from.id,
  });
  linkUserToChat(chat.id, ctx.from.id);

  track(EVENTS.CHANNEL_ADDED, {
    userId: ctx.from.id,
    chatId: chat.id,
    metadata: { handle: resolved.handle, isNewChannel: !existing },
  });

  return ctx.reply(
    t(lang, 'channel.added', { title: escapeMarkdown(resolved.title), handle: resolved.handle }),
    { parse_mode: 'Markdown' }
  );
}

async function removeHandler(ctx) {
  const lang = ctx.state.lang;
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  if (!arg) return ctx.reply(t(lang, 'channel.removeUsage'));

  const handle = normalizeHandle(arg);
  const channel = handle ? getChannelByUsername(handle) : null;

  // Unlinking only ever touches the caller's own membership row, so a wrong or
  // hostile handle can at worst remove something from their own list.
  if (!channel || !unlinkUserFromChat(channel.id, ctx.from.id)) {
    return ctx.reply(t(lang, 'channel.notFollowing', { handle: handle || arg }));
  }

  track(EVENTS.CHANNEL_REMOVED, { userId: ctx.from.id, chatId: channel.id });
  return ctx.reply(t(lang, 'channel.removed', { handle: channel.username }));
}

module.exports = (bot) => {
  bot.command('channels', listHandler);
  bot.command('addchannel', addHandler);
  bot.command('removechannel', removeHandler);
  bot.hears(allTranslations('menu.channels'), listHandler);
};
