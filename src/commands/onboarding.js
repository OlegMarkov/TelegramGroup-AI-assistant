const { getUserGroups, getUserChannels, getChatById, claimAdderWelcome } = require('../services/database');
const { getLimits } = require('../models/subscription');
const { normalizeHandle } = require('../services/channelSource');
const { addChannelFromInput } = require('./channel');
const { buildAndSendSummary } = require('./summary');
const { escapeMarkdown, truncate } = require('../utils/formatters');
const { t, DEFAULT_LANGUAGE } = require('../utils/i18n');
const { armPrompt, clearPrompt, captureReply } = require('../utils/uiState');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

/**
 * The first minute with the bot: one question instead of a feature list.
 *
 * A new user has nothing to summarize yet, and a wall of seven commands does
 * not change that. So /start asks what they want to catch up on and walks each
 * answer to a first result — a channel can be summarized on the spot, a group
 * cannot (the bot only sees messages sent after it joins), and the example
 * shows what the output looks like without either. The full list stays in
 * /help for anyone who wants it.
 *
 * Every button here is stateless and stays live for ever: someone who closes
 * the keyboard and comes back a week later can still tap it.
 */

const CHANNEL_PROMPT = 'onboarding:channel';

// Removing and re-adding the bot must not make it DM the same person again and
// again; one welcome a day per group is plenty.
const ADDER_WELCOME_THROTTLE_HOURS = 24;

// The start payload the "add to group" link carries. Telegram posts it into the
// group as "/start <payload>" once the bot is added; start.js stays quiet for it.
const ADD_TO_GROUP_PAYLOAD = 'onboarding';

/**
 * Nothing to summarize yet — no group, no channel. Who gets the question.
 *
 * Deliberately the empty state rather than "has seen the question before": it
 * needs no flag, it stays right for someone who ran /start twice without
 * choosing, and it stops the moment there is anything to summarize.
 */
function needsOnboarding(userId) {
  return getUserGroups(userId).length === 0 && getUserChannels(userId).length === 0;
}

/**
 * Telegram's "add to group" link: opens the user's group picker with the bot
 * preselected. Null without a username, which only a test lacks.
 */
function addToGroupUrl(ctx) {
  const username = ctx.botInfo && ctx.botInfo.username;
  return username ? `https://t.me/${username}?startgroup=${ADD_TO_GROUP_PAYLOAD}` : null;
}

// Spelled out rather than built from the path names: test/wiring.test.js reads
// callback_data out of the source, and a template would hide them from it.
function pathKeyboard(lang, { exclude = null } = {}) {
  const rows = [
    { path: 'group', text: t(lang, 'onboarding.groupButton'), callback_data: 'onb:group' },
    { path: 'channel', text: t(lang, 'onboarding.channelButton'), callback_data: 'onb:channel' },
    { path: 'example', text: t(lang, 'onboarding.exampleButton'), callback_data: 'onb:example' },
  ]
    .filter((row) => row.path !== exclude)
    .map(({ text, callback_data }) => [{ text, callback_data }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function askWhatToCatchUpOn(ctx) {
  const lang = ctx.state.lang;
  return ctx.reply(t(lang, 'onboarding.question'), { parse_mode: 'Markdown', ...pathKeyboard(lang) });
}

function choosePath(ctx, path) {
  track(EVENTS.ONBOARDING_PATH_CHOSEN, { userId: ctx.from.id, metadata: { path } });
  return ctx.answerCbQuery();
}

async function groupCallback(ctx) {
  const lang = ctx.state.lang;
  await choosePath(ctx, 'group');
  // Leaving the channel prompt armed would swallow their next message.
  clearPrompt(ctx.from.id, CHANNEL_PROMPT);

  const url = addToGroupUrl(ctx);
  return ctx.reply(t(lang, 'onboarding.groupHowTo'), {
    parse_mode: 'Markdown',
    ...(url ? { reply_markup: { inline_keyboard: [[{ text: t(lang, 'onboarding.addToGroupButton'), url }]] } } : {}),
  });
}

async function channelCallback(ctx) {
  const lang = ctx.state.lang;
  await choosePath(ctx, 'channel');
  armPrompt(ctx.from.id, CHANNEL_PROMPT);
  return ctx.reply(t(lang, 'onboarding.channelPrompt'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: t(lang, 'onboarding.backButton'), callback_data: 'onb:back' }]] },
  });
}

async function exampleCallback(ctx) {
  const lang = ctx.state.lang;
  await choosePath(ctx, 'example');
  clearPrompt(ctx.from.id, CHANNEL_PROMPT);
  // Static on purpose: it costs no AI call, and it is labelled as made up so
  // nobody mistakes it for the bot having read something of theirs.
  return ctx.reply(t(lang, 'onboarding.example'), {
    parse_mode: 'Markdown',
    ...pathKeyboard(lang, { exclude: 'example' }),
  });
}

async function backCallback(ctx) {
  const lang = ctx.state.lang;
  clearPrompt(ctx.from.id, CHANNEL_PROMPT);
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageText(t(lang, 'onboarding.question'), { parse_mode: 'Markdown', ...pathKeyboard(lang) });
  } catch (error) {
    logger.debug('Onboarding back edit skipped', { error: error.message });
  }
  return undefined;
}

/**
 * The reply to "send me a channel": follow it, then summarize it right away.
 *
 * Both halves go through the ordinary code — addChannelFromInput for the
 * channel allowance and the handle check, buildAndSendSummary for the daily
 * summary allowance and the AI budget — so this path is not a way around any
 * limit, only a shorter walk to the same place.
 */
async function handleChannelAnswer(ctx, text) {
  const lang = ctx.state.lang;
  const chat = await addChannelFromInput(ctx, text, { addedKey: 'onboarding.channelAdded' });

  if (!chat) {
    // A typo keeps the prompt: retyping gets them past it. Anything else — a
    // private channel, the allowance, Telegram unreachable — has already been
    // explained, and ends on the choice again rather than on a dead end.
    if (!normalizeHandle(text)) {
      armPrompt(ctx.from.id, CHANNEL_PROMPT);
      return undefined;
    }
    return ctx.reply(t(lang, 'onboarding.tryAnother'), pathKeyboard(lang));
  }

  // The plan's whole lookback rather than "since you last checked": a first
  // look at a quiet channel over the last few hours would often find nothing.
  const limits = getLimits(ctx.state.subscription);
  await buildAndSendSummary(ctx, chat.id, limits.maxLookbackHours);

  const url = addToGroupUrl(ctx);
  return ctx.reply(t(lang, 'onboarding.channelNext'), {
    ...(url ? { reply_markup: { inline_keyboard: [[{ text: t(lang, 'onboarding.addToGroupButton'), url }]] } } : {}),
  });
}

/**
 * Someone arriving through the link under a group summary is already in that
 * group, so there is nothing to ask: offer that group's summary directly. The
 * button is the ordinary summary picker's, whose handler re-checks membership.
 *
 * Returns false when the offer does not apply — they are not linked to the
 * group yet, say because they joined after the summary was posted — so the
 * caller falls back to the usual first-run question.
 */
async function offerReferringGroup(ctx, chatId, isLinked) {
  if (!isLinked) return false;
  const lang = ctx.state.lang;
  const chat = getChatById(chatId);
  if (!chat) return false;

  const title = chat.title || t(lang, 'common.chatFallback', { id: chat.id });
  await ctx.reply(t(lang, 'onboarding.referralOffer', { title: escapeMarkdown(title) }), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: t(lang, 'onboarding.referralButton', { title: truncate(title, 40) }),
            callback_data: `summary:chat:${chat.id}:auto`,
          },
        ],
      ],
    },
  });
  return true;
}

/**
 * A DM to whoever just added the bot to a group, saying it arrived and what
 * happens next — chiefly that the first summary is not instant, since the bot
 * cannot read what was said before it joined.
 *
 * The privacy-mode line is shown only when it is true. Telegram reports it in
 * getMe, and an admin sees every message regardless, so a bot that is already
 * reading everything does not tell anyone to fix a problem they do not have.
 *
 * Best effort: someone who never started the bot cannot be messaged at all.
 */
async function welcomeAdder(ctx, chat, adder, { isAdmin = false } = {}) {
  if (!adder || adder.is_bot) return false;
  if (!claimAdderWelcome(chat.id, ADDER_WELCOME_THROTTLE_HOURS)) return false;

  const lang = (ctx.state && ctx.state.lang) || DEFAULT_LANGUAGE;
  const title = escapeMarkdown(chat.title || t(lang, 'common.chatFallback', { id: chat.id }));
  const seesEverything = isAdmin || !ctx.botInfo || ctx.botInfo.can_read_all_group_messages !== false;
  const privacyNote = seesEverything ? '' : `\n\n${t(lang, 'onboarding.adderPrivacyMode', { title })}`;

  try {
    await ctx.telegram.sendMessage(adder.id, t(lang, 'onboarding.adderWelcome', { title, privacyNote }), {
      parse_mode: 'Markdown',
    });
    return true;
  } catch (error) {
    logger.info('Could not DM whoever added the bot to a group', { chatId: chat.id, error: error.message });
    return false;
  }
}

module.exports = (bot) => {
  bot.action('onb:group', groupCallback);
  bot.action('onb:channel', channelCallback);
  bot.action('onb:example', exampleCallback);
  bot.action('onb:back', backCallback);
  bot.on('text', captureReply(CHANNEL_PROMPT, handleChannelAnswer));
};

module.exports.needsOnboarding = needsOnboarding;
module.exports.askWhatToCatchUpOn = askWhatToCatchUpOn;
module.exports.offerReferringGroup = offerReferringGroup;
module.exports.welcomeAdder = welcomeAdder;
module.exports.ADDER_WELCOME_THROTTLE_HOURS = ADDER_WELCOME_THROTTLE_HOURS;
module.exports.ADD_TO_GROUP_PAYLOAD = ADD_TO_GROUP_PAYLOAD;
