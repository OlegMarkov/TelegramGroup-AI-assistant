const { mainMenu } = require('../keyboards');
const { TRIAL_PLAN, TRIAL_DAYS } = require('../models/subscription');
const {
  createSubscription,
  hasEverHadSubscription,
  getChatById,
  isUserLinkedToChat,
} = require('../services/database');
const { escapeMarkdown, formatDate } = require('../utils/formatters');
const { needsOnboarding, askWhatToCatchUpOn, offerReferringGroup } = require('./onboarding');
const logger = require('../utils/logger');

const { t } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');

/**
 * Gives a first-time user a week of premium, once ever.
 *
 * Written as a normal subscription row - plan 'trial', starsPaid 0, and a NULL
 * charge id - so it flows through getActiveSubscription and getLimits with no
 * special case anywhere else. Everything premium simply works, and when it
 * expires the user falls back to FREE_LIMITS by the same path a lapsed paid
 * plan does.
 *
 * NULL rather than a placeholder charge id: a made-up value collides with the
 * next comp on the partial unique index, which is exactly the bug that took a
 * production hotfix.
 *
 * Guarded on ever having had ANY subscription, not just a trial. Handing one to
 * a lapsed paying customer would be a discount for churning.
 */
function grantTrialIfDue(ctx) {
  const userId = ctx.from.id;
  if (hasEverHadSubscription(userId)) return false;

  try {
    createSubscription({
      userId,
      plan: TRIAL_PLAN,
      starsPaid: 0,
      telegramChargeId: null,
      // SQLite's own format, matching what payments.js writes.
      expiresAt: formatDate(new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000)),
    });
  } catch (error) {
    // A trial that could not be granted must not stop somebody starting the
    // bot. They get the free plan, which is what they had a moment ago.
    logger.error('Could not grant a trial', { userId, error: error.message });
    return false;
  }

  track(EVENTS.TRIAL_STARTED, { userId });
  logger.info('Granted a free trial', { userId, days: TRIAL_DAYS });
  return true;
}

/**
 * The start payload carried by the link under a group summary, `g<chat id>`
 * (see referralLink in utils/formatters).
 *
 * Read from the message text rather than a Telegraf convenience property, whose
 * name has changed between versions. Only a group the bot actually knows is
 * credited: the payload is whatever the link said, and anyone can edit a link.
 */
const REFERRAL_PAYLOAD = /^g(-\d{1,20})$/;

function startPayload(ctx) {
  const text = (ctx.message && ctx.message.text) || '';
  return text.split(/\s+/)[1] || '';
}

function hasPayload(ctx) {
  return startPayload(ctx) !== '';
}

function referringChatId(ctx) {
  const match = startPayload(ctx).match(REFERRAL_PAYLOAD);
  if (!match) return null;
  const chat = getChatById(Number(match[1]));
  return chat && chat.source !== 'channel' ? chat.id : null;
}

module.exports = (bot) => {
  bot.start(async (ctx) => {
    track(EVENTS.USER_STARTED, { userId: ctx.from.id });
    const lang = ctx.state.lang;
    const trialGranted = grantTrialIfDue(ctx);
    const trialNote = trialGranted ? `\n\n${t(lang, 'start.trialGranted', { days: TRIAL_DAYS })}` : '';

    const fromChat = referringChatId(ctx);
    if (fromChat !== null) {
      // firstStart separates people the link brought in from existing users
      // who happened to tap it; a granted trial is the "never been here" test.
      track(EVENTS.REFERRAL_STARTED, { userId: ctx.from.id, chatId: fromChat, metadata: { firstStart: trialGranted } });
    }

    // In a group this is either the "add to group" link arriving (a payload,
    // and the bot's own join notice is already there) or somebody typing it.
    // Neither is the place for a DM welcome and a reply keyboard.
    if (ctx.chat && ctx.chat.type !== 'private') {
      if (hasPayload(ctx)) return undefined;
      return ctx.reply(t(lang, 'start.inGroup'));
    }

    // Sent as Markdown, and a first name is free-form text: an unbalanced * or
    // _ in it would make Telegram reject the whole message, so the very first
    // thing a new user sees would be nothing at all.
    const name = escapeMarkdown(ctx.from.first_name || '');

    // Somebody with chats already knows what the bot does, and gets the menu.
    // Somebody with none gets one question instead of a feature list — see
    // commands/onboarding. Two messages because a message carries one keyboard:
    // the reply menu arrives with the first, the inline choice with the next.
    const isNew = needsOnboarding(ctx.from.id);
    await ctx.reply(t(lang, isNew ? 'start.welcome' : 'start.welcomeBack', { name, trialNote }), {
      parse_mode: 'Markdown',
      ...mainMenu(lang),
    });

    // Arriving from a group they are already in: that group's summary is the
    // obvious first thing, so it is offered instead of the question.
    if (fromChat !== null && (await offerReferringGroup(ctx, fromChat, isUserLinkedToChat(fromChat, ctx.from.id)))) {
      return undefined;
    }
    if (isNew) return askWhatToCatchUpOn(ctx);
    return undefined;
  });
};
