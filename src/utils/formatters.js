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

function formatDate(date = new Date()) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19);
}

function isGroupChat(chat) {
  return Boolean(chat) && (chat.type === 'group' || chat.type === 'supergroup');
}

module.exports = { escapeMarkdownV2, escapeMarkdown, truncate, formatDate, isGroupChat };
