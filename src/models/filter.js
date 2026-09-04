const { z } = require('zod');

// The ceilings live here rather than inline in the schema because the /filter
// screen quotes them back at the user ("you can follow up to 20 keywords"),
// and a limit that is enforced in one place and described in another drifts.
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_LENGTH = 50;

const filterSchema = z.object({
  keywords: z.array(z.string().min(1).max(MAX_KEYWORD_LENGTH)).max(MAX_KEYWORDS).default([]),
  categories: z.array(z.string().min(1).max(30)).max(10).default([]),
});

/**
 * The keywords a plan actually matches on, oldest first.
 *
 * Someone who subscribes, adds twenty keywords and then lapses keeps all
 * twenty stored — only the first now counts. Deleting the rest would be the
 * one irreversible way to handle it, and it is the same bargain their channels
 * get: the list survives, the plan decides how much of it is live.
 */
function allowedKeywords(keywords = [], maxKeywords) {
  if (!Number.isFinite(maxKeywords)) return keywords;
  return maxKeywords <= 0 ? [] : keywords.slice(0, maxKeywords);
}

module.exports = { filterSchema, allowedKeywords, MAX_KEYWORDS, MAX_KEYWORD_LENGTH };
