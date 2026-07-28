const { z } = require('zod');

const userSchema = z.object({
  id: z.number().int().positive(),
  username: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
});

module.exports = { userSchema };
