const { recordSummaryFeedback } = require('../services/database');
const { t } = require('../utils/i18n');
const logger = require('../utils/logger');

/**
 * Two buttons under every summary.
 *
 * The DeepSeek prompt has been tuned several times — reasoning off, an explicit
 * output format, a bullet ceiling — entirely on the strength of reading a few
 * outputs by hand. There is no data on whether summaries are actually good,
 * which groups produce bad ones, or whether any of those changes helped. Two
 * buttons turn prompt tuning from taste into measurement.
 */

/**
 * The keyboard, for whoever is delivering a summary.
 *
 * callback_data is capped at 64 bytes by Telegram, so it carries identifiers
 * and never text: "fb:u:-1001234567890:168:ru" is 26. The summarized chat id is
 * in there because it is NOT the chat the message was delivered to — a summary
 * requested in a DM is about somewhere else, and the whole question is which
 * groups produce bad summaries.
 */
function feedbackKeyboard(lang, { chatId, hours }) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: t(lang, 'feedback.up'), callback_data: `fb:u:${chatId}:${hours}:${lang}` },
          { text: t(lang, 'feedback.down'), callback_data: `fb:d:${chatId}:${hours}:${lang}` },
        ],
      ],
    },
  };
}

function voteHandler(vote) {
  return async (ctx) => {
    const [, chatIdRaw, hoursRaw, langRaw] = ctx.match;
    const lang = ctx.state.lang;

    try {
      recordSummaryFeedback({
        userId: ctx.from.id,
        // The message the buttons are attached to. In a group everyone sees the
        // same one, so this is what makes it one vote per person rather than
        // one vote per tap.
        chatId: Number(chatIdRaw),
        messageId: ctx.callbackQuery.message.message_id,
        vote,
        hours: Number(hoursRaw),
        language: langRaw,
      });
    } catch (error) {
      // A vote is worth less than the summary it is about. Never turn a failed
      // write into a visible error on a message the user is happy with.
      logger.warn('Could not record summary feedback', { userId: ctx.from.id, error: error.message });
      return ctx.answerCbQuery();
    }

    // Acknowledged and otherwise left alone: editing the message to show the
    // vote would rewrite a summary several people are reading.
    return ctx.answerCbQuery(t(lang, vote > 0 ? 'feedback.thanksUp' : 'feedback.thanksDown'));
  };
}

module.exports = (bot) => {
  bot.action(/^fb:u:(-?\d+):(\d+):(\w+)$/, voteHandler(1));
  bot.action(/^fb:d:(-?\d+):(\d+):(\w+)$/, voteHandler(-1));
};

module.exports.feedbackKeyboard = feedbackKeyboard;
