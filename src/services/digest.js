const {
  getRecentMessages,
  getUserFilters,
  getChatById,
  getCachedDigestSummary,
  setCachedDigestSummary,
} = require('./database');
const { summarize } = require('./deepseek');
const { buildFilterMatcher } = require('./filterMatcher');
const { fetchChannelPosts } = require('./channelSource');
const { truncate, escapeMarkdown } = require('../utils/formatters');
const { t, DEFAULT_LANGUAGE } = require('../utils/i18n');
const logger = require('../utils/logger');

// Identifies "the same conversation window" without a TTL: as long as the
// newest message id and total count are unchanged, no message has entered or
// aged out of the lookback window, so a previously generated summary is still
// accurate — not just "recent enough".
function fingerprintMessages(messages) {
  const maxId = messages.reduce((max, m) => Math.max(max, m.id), 0);
  return `${maxId}:${messages.length}`;
}

/**
 * Loads the window of content to summarize.
 *
 * Group messages come from the database, where ingestion has been storing them
 * as they arrive. Channel posts are fetched live and deliberately never stored:
 * they are other people's content, published to an audience that has no
 * relationship with this bot, and keeping a copy would put third-party material
 * into every nightly backup for no functional gain — the summary itself is
 * already cached.
 */
async function loadWindow(chat, hours) {
  if (chat && chat.source === 'channel') {
    const { posts } = await fetchChannelPosts(chat.username, { hours });
    return {
      isChannel: true,
      items: posts.map((p) => ({ id: p.id, author: null, text: p.text })),
    };
  }

  return {
    isChannel: false,
    items: getRecentMessages(chat.id, { hours }).map((m) => ({
      id: m.id,
      author: m.username || null,
      text: m.text,
    })),
  };
}

function buildTranscript(items, isChannel) {
  // A channel is one voice, so prefixing every line with the same name is
  // noise that costs tokens and tells the model nothing.
  return items
    .map((item) => (isChannel ? truncate(item.text, 300) : `${item.author || 'someone'}: ${truncate(item.text, 300)}`))
    .join(isChannel ? '\n\n' : '\n');
}

async function generateDigest(chatId, userId, hours, lang = DEFAULT_LANGUAGE) {
  const chat = getChatById(chatId);
  const { items, isChannel } = await loadWindow(chat || { id: chatId }, hours);
  if (items.length === 0) return null;

  const fingerprint = fingerprintMessages(items);
  // Language is part of the cache key: the same conversation summarized for a
  // Russian and an English user are different artifacts.
  let summaryText = getCachedDigestSummary(chatId, hours, lang, fingerprint);

  if (summaryText) {
    logger.info(`Digest cache hit for chat ${chatId} (${hours}h, ${lang})`);
  } else {
    summaryText = await summarize(buildTranscript(items, isChannel), { language: t(lang, 'aiPromptLanguage') });
    setCachedDigestSummary(chatId, hours, lang, fingerprint, summaryText);
  }

  // Highlights depend on the requesting user's own filters, so they're
  // always computed fresh — only the DeepSeek call itself is cached.
  const matchesFilters = buildFilterMatcher(getUserFilters(userId));

  let highlightBlock = '';
  if (matchesFilters) {
    const matches = items.filter((item) => matchesFilters(item.text));
    if (matches.length > 0) {
      // Highlights are quoted verbatim from messages and channel posts, so
      // they are the one place attacker-written text reaches Telegram's parser
      // unmediated. Unescaped, a post containing "[click](http://evil)" renders
      // as a link the user has every reason to read as coming from this bot.
      const lines = matches.slice(0, 10).map((item) => {
        const body = escapeMarkdown(truncate(item.text, 150));
        return item.author ? `• *${escapeMarkdown(item.author)}*: ${body}` : `• ${body}`;
      });
      highlightBlock = `\n\n${t(lang, 'summary.highlightsHeader')}\n${lines.join('\n')}`;
    }
  }

  return { summaryText, highlightBlock, messageCount: items.length };
}

module.exports = { generateDigest };
