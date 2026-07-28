const { getRecentMessages, getUserFilters, getCachedDigestSummary, setCachedDigestSummary } = require('./database');
const { summarize } = require('./deepseek');
const { truncate } = require('../utils/formatters');
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

async function generateDigest(chatId, userId, hours, lang = DEFAULT_LANGUAGE) {
  const messages = getRecentMessages(chatId, { hours });
  if (messages.length === 0) return null;

  const fingerprint = fingerprintMessages(messages);
  // Language is part of the cache key: the same conversation summarized for a
  // Russian and an English user are different artifacts.
  let summaryText = getCachedDigestSummary(chatId, hours, lang, fingerprint);

  if (summaryText) {
    logger.info(`Digest cache hit for chat ${chatId} (${hours}h, ${lang})`);
  } else {
    const transcript = messages.map((m) => `${m.username || 'someone'}: ${truncate(m.text, 300)}`).join('\n');
    summaryText = await summarize(transcript, { language: t(lang, 'aiPromptLanguage') });
    setCachedDigestSummary(chatId, hours, lang, fingerprint, summaryText);
  }

  // Highlights depend on the requesting user's own filters, so they're
  // always computed fresh — only the DeepSeek call itself is cached.
  const filters = getUserFilters(userId);
  const highlightTerms = [...filters.keywords, ...filters.categories].map((term) => term.toLowerCase());

  let highlightBlock = '';
  if (highlightTerms.length > 0) {
    const matches = messages.filter((m) => highlightTerms.some((term) => m.text.toLowerCase().includes(term)));
    if (matches.length > 0) {
      const lines = matches.slice(0, 10).map((m) => `• ${m.username || 'someone'}: ${truncate(m.text, 150)}`);
      highlightBlock = `\n\n${t(lang, 'summary.highlightsHeader')}\n${lines.join('\n')}`;
    }
  }

  return { summaryText, highlightBlock, messageCount: messages.length };
}

module.exports = { generateDigest };
