const { mainMenu } = require('../keyboards');
const { getChatById, isUserLinkedToChat, hasUserStarted } = require('../services/database');
const { startTrialForRequest, trialStartedText } = require('../services/trial');
const { escapeMarkdown } = require('../utils/formatters');
const { needsOnboarding, askWhatToCatchUpOn, offerReferringGroup, ADD_TO_GROUP_PAYLOAD } = require('./onboarding');

const { t } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');

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

function referringChatId(ctx) {
  const match = startPayload(ctx).match(REFERRAL_PAYLOAD);
  if (!match) return null;
  const chat = getChatById(Number(match[1]));
  return chat && chat.source !== 'channel' ? chat.id : null;
}

module.exports = (bot) => {
  bot.start(async (ctx) => {
    // Read before this /start is recorded, or every start would look like a
    // return visit.
    const firstStart = !hasUserStarted(ctx.from.id);
    track(EVENTS.USER_STARTED, { userId: ctx.from.id });
    const lang = ctx.state.lang;

    const fromChat = referringChatId(ctx);
    if (fromChat !== null) {
      // firstStart separates people the link brought in from existing users
      // who happened to tap it.
      track(EVENTS.REFERRAL_STARTED, { userId: ctx.from.id, chatId: fromChat, metadata: { firstStart } });
    }

    // In a group this is either the "add to group" link arriving (its payload,
    // and the bot's own join notice is already there) or somebody typing it.
    // Neither is the place for a DM welcome and a reply keyboard.
    if (ctx.chat && ctx.chat.type !== 'private') {
      if (startPayload(ctx) === ADD_TO_GROUP_PAYLOAD) return undefined;
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
    // The trial starts with something to use it on (services/trial). Somebody
    // with nothing connected gets it later, from whichever path they take.
    const trialNote = !isNew && startTrialForRequest(ctx) ? `\n\n${trialStartedText(lang)}` : '';
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
