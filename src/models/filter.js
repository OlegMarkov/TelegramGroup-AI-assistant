const { z } = require('zod');

const filterSchema = z.object({
  keywords: z.array(z.string().min(1).max(50)).max(20).default([]),
  categories: z.array(z.string().min(1).max(30)).max(10).default([]),
});

module.exports = { filterSchema };
