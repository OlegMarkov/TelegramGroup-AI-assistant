const {
  getRecentMessages,
  getUserFilters,
  getActiveSubscription,
  getChatById,
  getCachedDigestSummary,
  setCachedDigestSummary,
} = require('./database');
const { summarize } = require('./deepseek');
const { buildFilterMatcher } = require('./filterMatcher');
const { allowedKeywords } = require('../models/filter');
const { getLimits } = require('../models/subscription');
const { fetchChannelPosts } = require('./channelSource');
const { truncate, escapeMarkdown, normalizeModelMarkdown } = require('../utils/formatters');
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
      isCaption: Boolean(m.is_caption),
    })),
  };
}

// Group messages are short and conversational; channel posts are long-form
// articles where 300 characters rarely reaches the end of the first paragraph,
// so the model was summarizing preambles. The extra input costs a fraction of
// a kopeck per digest.
const GROUP_MESSAGE_CHARS = 300;
const CHANNEL_POST_CHARS = 600;

// Highlights are excerpts, so they end in an ellipsis by design — but 150
// characters cut most channel posts before the point they were making.
const HIGHLIGHT_CHARS = 280;
const MAX_HIGHLIGHTS = 10;

// Marks a caption in the transcript, so the model reads "here is what someone
// said about a picture" rather than treating it as a remark out of nowhere.
// Costs about one token per captioned message. Deliberately not stored in the
// text itself: it would then show up in /find results and filter highlights as
// though the user had typed it.
const CAPTION_PREFIX = '[media] ';

function buildTranscript(items, isChannel) {
  // A channel is one voice, so prefixing every line with the same name is
  // noise that costs tokens and tells the model nothing.
  return items
    .map((item) =>
      isChannel
        ? truncate(item.text, CHANNEL_POST_CHARS)
        : `${item.author || 'someone'}: ${item.isCaption ? CAPTION_PREFIX : ''}${truncate(item.text, GROUP_MESSAGE_CHARS)}`
    )
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
  //
  // The keyword allowance is applied here rather than at the /filter screen,
  // because this is the single point where a stored filter turns into a match:
  // a subscription that lapsed between adding a keyword and running a summary
  // has to be noticed on the way out, not on the way in.
  const filters = getUserFilters(userId);
  const limits = getLimits(getActiveSubscription(userId));
  const matchesFilters = buildFilterMatcher({
    ...filters,
    keywords: allowedKeywords(filters.keywords, limits.maxKeywords),
  });

  let highlightBlock = '';
  if (matchesFilters) {
    const matches = items.filter((item) => matchesFilters(item.text));
    if (matches.length > 0) {
      // Highlights are quoted verbatim from messages and channel posts, so
      // they are the one place attacker-written text reaches Telegram's parser
      // unmediated. Unescaped, a post containing "[click](http://evil)" renders
      // as a link the user has every reason to read as coming from this bot.
      const lines = matches.slice(0, MAX_HIGHLIGHTS).map((item) => {
        const body = escapeMarkdown(truncate(item.text, HIGHLIGHT_CHARS));
        return item.author ? `• *${escapeMarkdown(item.author)}*: ${body}` : `• ${body}`;
      });
      highlightBlock = `\n\n${t(lang, 'summary.highlightsHeader')}\n${lines.join('\n')}`;
    }
  }

  // Normalized on the way out rather than before caching, so summaries already
  // stored under the old behaviour are fixed without discarding them.
  return {
    summaryText: normalizeModelMarkdown(summaryText),
    highlightBlock,
    messageCount: items.length,
    // So callers can add the "this bot is here" footer to a group summary and
    // not to a channel one, where there are no members to inform.
    isChannel,
  };
}

// GROUP_MESSAGE_CHARS is exported because /privacy tells users exactly how much
// of each message reaches DeepSeek. Stating that as a number typed into the
// copy would let the policy drift away from the code the first time it changes.
module.exports = { generateDigest, GROUP_MESSAGE_CHARS };
