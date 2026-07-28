const logger = require('../utils/logger');

function requestLogging() {
  return async (ctx, next) => {
    const start = Date.now();
    const type = ctx.updateType;
    const from = ctx.from ? ctx.from.id : 'unknown';

    try {
      await next();
      logger.info(`Handled ${type}`, { userId: from, ms: Date.now() - start });
    } catch (error) {
      logger.error(`Error handling ${type}`, { userId: from, error: error.message });
      throw error;
    }
  };
}

module.exports = requestLogging;
