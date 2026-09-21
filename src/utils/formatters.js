const MARKDOWN_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!]/g;

function escapeMarkdownV2(text) {
  return String(text).replace(MARKDOWN_V2_SPECIAL_CHARS, (char) => `\\${char}`);
}

// Telegram's legacy Markdown parser recognises *bold*, _italic_, `code` and
// [label](url). Escaping those four is enough to make a span of untrusted text
// inert; escapeMarkdownV2 above is for the stricter V2 parser and would render
// visible backslashes if used on a legacy-mode message.
const MARKDOWN_SPECIAL_CHARS = /[_*[\]`]/g;

function escapeMarkdown(text) {
  return String(text).replace(MARKDOWN_SPECIAL_CHARS, (char) => `\\${char}`);
}

function truncate(text, maxLength = 400) {
  const str = String(text);
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Rewrites CommonMark emphasis into what Telegram's legacy Markdown understands.
 *
 * Models write **bold** and __bold__, because that is what CommonMark uses.
 * Telegram's legacy parse_mode uses *bold* and _italic_, and renders **text**
 * as two empty bold spans wrapped around plain text — no error, no bold, just
 * silently unformatted output. That is why AI-written theme headers arrived
 * looking like every other line.
 *
 * Applied to model output only. Text quoted from users and channels goes
 * through escapeMarkdown instead, which makes these characters inert.
 */
function normalizeModelMarkdown(text) {
  return String(text)
    .replace(/\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/g, '*$1*')
    .replace(/__(?!\s)([\s\S]+?)(?<!\s)__/g, '_$1_');
}

// Telegram rejects any message over 4096 characters outright — it is not
// trimmed for you, the whole send fails with a 400. Now that summaries have
// room to be long, a busy channel can cross it.
const TELEGRAM_MAX_MESSAGE = 4096;

/**
 * Splits text into Telegram-sized parts, preferring to break at a blank line,
 * then at a line end, and only cutting mid-line when a single line is itself
 * too long. Breaking on structure keeps a bullet list from being severed
 * halfway through a bullet.
 */
function splitForTelegram(text, limit = TELEGRAM_MAX_MESSAGE) {
  const body = String(text);
  if (body.length <= limit) return [body];

  const parts = [];
  let rest = body;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = limit;

    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest) parts.push(rest);
  return parts;
}

function formatDate(date = new Date()) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19);
}

function isGroupChat(chat) {
  return Boolean(chat) && (chat.type === 'group' || chat.type === 'supergroup');
}

/**
 * A link back to one message.
 *
 * A public group or channel has a username and a public permalink. A private
 * supergroup has neither, but t.me/c/<id>/<message> works for anyone already in
 * the chat — and every place this is shown only shows members their own chats.
 * Anything else (a legacy group, an id that is not a supergroup) gets no link
 * rather than a broken one.
 *
 * Usernames are Telegram's own [A-Za-z0-9_], so the result is safe inside a
 * legacy-Markdown [label](url) without escaping.
 */
function messageLink(chat, messageId) {
  if (!chat || !messageId) return null;
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const id = String(chat.id);
  return id.startsWith('-100') ? `https://t.me/c/${id.slice(4)}/${messageId}` : null;
}

/**
 * The link under a group summary, for members who want the bot for their own
 * groups. Its start payload names the group, so /start can credit it; the
 * payload is `g` plus the (negative) chat id, all within Telegram's allowed
 * [A-Za-z0-9_-]. Null without a bot username, which only a test lacks.
 */
function referralLink(botUsername, chatId) {
  return botUsername ? `https://t.me/${botUsername}?start=g${chatId}` : null;
}

// Send option for any message that may carry messageLink() links. Telegram
// otherwise expands the first link into a preview card of some unrelated
// message, pushing the summary or the results below the fold.
const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

module.exports = {
  messageLink,
  referralLink,
  NO_PREVIEW,
  escapeMarkdownV2,
  escapeMarkdown,
  normalizeModelMarkdown,
  truncate,
  splitForTelegram,
  TELEGRAM_MAX_MESSAGE,
  formatDate,
  isGroupChat,
};
