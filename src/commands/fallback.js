const { mainMenu } = require('../keyboards');
const { isMenuButtonText, t, DEFAULT_LANGUAGE } = require('../utils/i18n');

/**
 * The last word on a private message nothing else claimed.
 *
 * uiState keeps pending prompts in memory on purpose — losing them costs one
 * extra tap, and persisting them would mean a database write per keystroke of
 * UI. What that tradeoff did not handle is how it feels: someone taps "add a
 * channel", is asked for the name, and sends it just after a deploy. The prompt
 * is gone, captureReply passes the message through, no handler claims it, and
 * the bot says nothing at all. From their side it ignored them.
 *
 * This also covers the ordinary case of typing a question at the bot in a DM,
 * which is the same silence arriving for a different reason.
 *
 * MUST be registered after every command module — see registerCommands in
 * bot.js. It claims any plain private message, so anything registered behind it
 * would never run.
 */
module.exports = (bot) => {
  bot.on('text', async (ctx, next) => {
    const text = ctx.message && ctx.message.text;
    if (!text) return next();

    // In a group the next message is somebody talking to each other, not to us.
    if (!ctx.chat || ctx.chat.type !== 'private') return next();

    // A command that reached here is one the bot does not have; Telegram
    // already shows those in the "/" menu and answering "here is the menu"
    // would be noise. Menu-button labels are checked in every language,
    // because someone who switched language still has the old keyboard
    // rendered client-side.
    if (text.startsWith('/') || isMenuButtonText(text)) return next();

    const lang = (ctx.state && ctx.state.lang) || DEFAULT_LANGUAGE;
    return ctx.reply(t(lang, 'common.unclaimedMessage'), mainMenu(lang));
  });
};
