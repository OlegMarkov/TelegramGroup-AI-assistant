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

module.exports = { filterSchema, MAX_KEYWORDS, MAX_KEYWORD_LENGTH };
