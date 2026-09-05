const { getOrCreateChat, linkUserToChat, saveMessage } = require('../services/database');
const { mayStoreMessage } = require('../services/ingestionPolicy');
const { isGroupChat } = require('../utils/formatters');
const { isMenuButtonText } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');

function ingestion() {
  return async (ctx, next) => {
    const message = ctx.message;

    if (message && isGroupChat(ctx.chat) && ctx.from && !ctx.from.is_bot) {
      getOrCreateChat({ id: ctx.chat.id, title: ctx.chat.title, type: ctx.chat.type });
      const isNewLink = linkUserToChat(ctx.chat.id, ctx.from.id);
      if (isNewLink) {
        track(EVENTS.CHAT_LINKED, { userId: ctx.from.id, chatId: ctx.chat.id });
      }

      // Skip bot interactions rather than storing them as conversation:
      // /commands, and reply-keyboard taps (which arrive as plain text, so
      // they have to be recognised by their label in any language).
      const isChatContent =
        typeof message.text === 'string' &&
        !message.text.startsWith('/') &&
        !isMenuButtonText(message.text);

      // The chat link above is kept even when the message itself is not
      // stored: it is what lets this person ask for summaries of chats they
      // are in, and it holds no message content. An admin pausing the group,
      // or a member opting out, is a statement about storing what people say —
      // not about who is allowed to use the bot.
      if (isChatContent && mayStoreMessage(ctx.chat.id, ctx.from.id)) {
        saveMessage({
          chatId: ctx.chat.id,
          messageId: message.message_id,
          userId: ctx.from.id,
          username: ctx.from.username || ctx.from.first_name,
          text: message.text,
          createdAt: new Date(message.date * 1000).toISOString(),
        });
      }
    }

    return next();
  };
}

module.exports = ingestion;
