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

      // A photo with a caption, a video with a caption, a document with a
      // caption: in plenty of real groups that is where the content actually
      // is — someone posts a screenshot and explains it underneath. Those
      // messages were invisible to every summary and every /find result, and
      // nothing said so. Media with no caption stays unstored, because there
      // is nothing there to summarize.
      const isCaption = typeof message.text !== 'string' && typeof message.caption === 'string';
      const content = typeof message.text === 'string' ? message.text : message.caption;

      // Skip bot interactions rather than storing them as conversation:
      // /commands, and reply-keyboard taps (which arrive as plain text, so
      // they have to be recognised by their label in any language). A caption
      // cannot be either of those, but the check stays uniform rather than
      // branching on where the text came from.
      const isChatContent =
        typeof content === 'string' && !content.startsWith('/') && !isMenuButtonText(content);

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
          text: content,
          createdAt: new Date(message.date * 1000).toISOString(),
          isCaption,
        });
      }
    }

    return next();
  };
}

module.exports = ingestion;
