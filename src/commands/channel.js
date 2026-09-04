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
const { channelsMenu } = require('../keyboards');
const { escapeMarkdown } = require('../utils/formatters');
const { t, allTranslations } = require('../utils/i18n');
const { armPrompt, clearPrompt, captureReply, createSelectionStore } = require('../utils/uiState');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

const ADD_PROMPT = 'channel:add';
const selection = createSelectionStore();

/**
 * The whole channels screen — body text and keyboard — from current state.
 *
 * Built fresh on every render rather than carried along with the message,
 * because the list can change from another chat, another device, or an expired
 * subscription between two taps of the same keyboard.
 */
function buildView(ctx) {
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);
  const channels = getUserChannels(ctx.from.id);
  const allowed = getAllowedUserChannels(ctx.from.id, limits.maxChannels);
  const allowedIds = new Set(allowed.map((c) => c.id));

  // A channel removed since the keyboard was drawn must not stay selected, or
  // the count on the Remove button promises more than it can deliver.
  const live = new Set(channels.map((c) => c.id));
  const selectedIds = new Set([...selection.get(ctx.from.id)].filter((id) => live.has(id)));
  selection.set(ctx.from.id, selectedIds);

  let text;
  if (channels.length === 0) {
    text = t(lang, 'channel.empty');
  } else {
    const lines = channels.map((c) => {
      const lock = allowedIds.has(c.id) ? '' : '🔒 ';
      return `• ${lock}*${escapeMarkdown(c.title || c.username)}* — @${c.username}`;
    });
    text = `${t(lang, 'channel.listHeader')}\n${lines.join('\n')}\n\n${t(lang, 'channel.listHint')}`;
  }

  // A lapsed subscriber can be following more channels than their plan now
  // allows. Saying so beats letting them wonder why a channel they can see
  // is missing from /summary.
  if (allowed.length < channels.length) {
    text += `\n\n${t(lang, 'channel.someLocked', {
      allowed: allowed.length,
      total: channels.length,
      premiumMax: PREMIUM_LIMITS.maxChannels,
    })}`;
  }

  return { text, keyboard: channelsMenu(lang, { channels, selectedIds, allowedIds }) };
}

function sendView(ctx) {
  const { text, keyboard } = buildView(ctx);
  return ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
}

/**
 * Redraws the open list in place. Telegram rejects an edit whose result is
 * identical to what is already shown, and a keyboard can outlive its message
 * entirely — neither is worth failing the interaction over, so the redraw is
 * best effort and the caller carries on.
 */
async function refreshView(ctx) {
  const { text, keyboard } = buildView(ctx);
  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    return true;
  } catch (error) {
    logger.debug('Channel list edit skipped', { error: error.message });
    return false;
  }
}

function limitReachedReply(ctx) {
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);

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

async function listHandler(ctx) {
  return sendView(ctx);
}

/**
 * Adds one channel from whatever the user gave us — a bare name, an @handle or
 * a full t.me link, all of which normalizeHandle accepts.
 *
 * Returns true when a channel was actually added, so the button flow knows
 * whether to redraw the list and the text flow knows whether to keep waiting.
 */
async function addChannelFromInput(ctx, input) {
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);

  // Validate before any network call: this value would otherwise be
  // interpolated into a URL fetched by the server.
  const handle = normalizeHandle(input);
  if (!handle) {
    await ctx.reply(t(lang, 'channel.invalidHandle'), { parse_mode: 'Markdown' });
    return false;
  }

  const existing = getChannelByUsername(handle);
  const followed = getUserChannels(ctx.from.id);
  if (followed.some((c) => c.username === handle)) {
    await ctx.reply(t(lang, 'channel.alreadyAdded', { handle }));
    return false;
  }

  // Checked against the user's own list, not the global channel table, and
  // before the fetch so a user at their cap cannot use /addchannel as a way to
  // make the server issue requests.
  if (followed.length >= limits.maxChannels) {
    await limitReachedReply(ctx);
    return false;
  }

  await ctx.reply(t(lang, 'channel.checking', { handle }));

  let resolved;
  try {
    resolved = await resolveChannel(handle);
  } catch (error) {
    if (error instanceof ChannelUnavailableError) {
      await ctx.reply(t(lang, 'channel.unavailable', { handle }), { parse_mode: 'Markdown' });
      return false;
    }
    logger.error('Channel resolution failed', { handle, error: error.message });
    await ctx.reply(t(lang, 'channel.checkFailed'));
    return false;
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

  await ctx.reply(
    t(lang, 'channel.added', { title: escapeMarkdown(resolved.title), handle: resolved.handle }),
    { parse_mode: 'Markdown' }
  );
  return true;
}

function promptForHandle(ctx) {
  const lang = ctx.state.lang;
  armPrompt(ctx.from.id, ADD_PROMPT);
  return ctx.reply(t(lang, 'channel.addPrompt'), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: t(lang, 'common.cancel'), callback_data: 'channel:addcancel' }]],
    },
  });
}

async function addHandler(ctx) {
  const lang = ctx.state.lang;
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();

  // A bare /addchannel used to be a dead end that recited the syntax. In a DM
  // we can ask for the name instead and take the next message.
  if (!arg) {
    if (ctx.chat.type !== 'private') return ctx.reply(t(lang, 'channel.usage'), { parse_mode: 'Markdown' });
    return promptForHandle(ctx);
  }

  return addChannelFromInput(ctx, arg);
}

async function removeHandler(ctx) {
  const lang = ctx.state.lang;
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();

  // No handle given: show the list and let them tap, rather than teaching a
  // syntax the buttons make unnecessary.
  if (!arg) return sendView(ctx);

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

async function toggleCallback(ctx) {
  const lang = ctx.state.lang;
  const chatId = Number(ctx.match[1]);

  // callback_data comes from the client, and the row may also have been
  // removed from another device since this keyboard was drawn.
  const channels = getUserChannels(ctx.from.id);
  if (!channels.some((c) => c.id === chatId)) {
    await ctx.answerCbQuery(t(lang, 'channel.gone'), { show_alert: true });
    return refreshView(ctx);
  }

  const selected = new Set(selection.get(ctx.from.id));
  if (selected.has(chatId)) selected.delete(chatId);
  else selected.add(chatId);
  selection.set(ctx.from.id, selected);

  await refreshView(ctx);
  return ctx.answerCbQuery();
}

async function removeSelectedCallback(ctx) {
  const lang = ctx.state.lang;
  const selected = selection.get(ctx.from.id);

  if (selected.size === 0) {
    return ctx.answerCbQuery(t(lang, 'channel.nothingSelected'), { show_alert: true });
  }

  // Driven by the user's own rows rather than by ids arriving in callback_data,
  // so this can only ever unlink channels they actually follow.
  const removed = [];
  for (const channel of getUserChannels(ctx.from.id)) {
    if (!selected.has(channel.id)) continue;
    if (unlinkUserFromChat(channel.id, ctx.from.id)) {
      removed.push(channel.username);
      track(EVENTS.CHANNEL_REMOVED, { userId: ctx.from.id, chatId: channel.id });
    }
  }

  selection.clear(ctx.from.id);
  await ctx.answerCbQuery(t(lang, 'channel.removedShort'));

  // Naming what went keeps the confirmation honest for a multi-channel
  // removal, where the redrawn list only shows what is left.
  if (removed.length > 0) {
    await ctx.reply(t(lang, 'channel.removedMany', { handles: removed.map((h) => `@${h}`).join(', ') }));
  }
  return refreshView(ctx);
}

async function addCallback(ctx) {
  const lang = ctx.state.lang;
  const limits = getLimits(ctx.state.subscription);
  await ctx.answerCbQuery();

  if (getUserChannels(ctx.from.id).length >= limits.maxChannels) {
    return limitReachedReply(ctx);
  }

  // Capturing the next message only works where the next message is
  // unambiguously an answer to us — in a group it is somebody talking.
  if (!ctx.chat || ctx.chat.type !== 'private') {
    return ctx.reply(t(lang, 'channel.usage'), { parse_mode: 'Markdown' });
  }

  return promptForHandle(ctx);
}

async function addCancelCallback(ctx) {
  const lang = ctx.state.lang;
  clearPrompt(ctx.from.id, ADD_PROMPT);
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(t(lang, 'channel.addCancelled'));
  } catch (error) {
    logger.debug('Add-channel cancel edit skipped', { error: error.message });
  }
  return undefined;
}

/**
 * Handles the reply to "send me the channel name".
 */
async function handleAddAnswer(ctx, text) {
  const added = await addChannelFromInput(ctx, text);
  if (added) return sendView(ctx);

  // A typo shouldn't cost them the prompt: stay armed unless they hit a wall
  // that retyping cannot get them past.
  if (!normalizeHandle(text)) armPrompt(ctx.from.id, ADD_PROMPT);
  return undefined;
}

module.exports = (bot) => {
  bot.command('channels', listHandler);
  bot.command('addchannel', addHandler);
  bot.command('removechannel', removeHandler);
  bot.hears(allTranslations('menu.channels'), listHandler);
  bot.action(/^channel:toggle:(\d+)$/, toggleCallback);
  bot.action('channel:remove', removeSelectedCallback);
  bot.action('channel:add', addCallback);
  bot.action('channel:addcancel', addCancelCallback);
  bot.on('text', captureReply(ADD_PROMPT, handleAddAnswer));
};
