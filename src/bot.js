const path = require('path');
const { Telegraf } = require('telegraf');
const config = require('./config');
const logger = require('./utils/logger');

const auth = require('./middleware/auth');
const requestLogging = require('./middleware/logging');
const rateLimit = require('./middleware/rateLimit');
const ingestion = require('./middleware/ingestion');

const { handlePreCheckoutQuery, handleSuccessfulPayment } = require('./services/payments');
const { startWorker } = require('./services/queue');
const { startScheduler } = require('./services/scheduler');
const { getOrCreateChat, linkUserToChat, deactivateChat } = require('./services/database');
const { isGroupChat } = require('./utils/formatters');
const { t, DEFAULT_LANGUAGE } = require('./utils/i18n');
const { startHeartbeat } = require('./utils/heartbeat');

const heartbeatPath = path.join(path.dirname(config.database.path), 'heartbeat');

require('./services/database'); // ensure schema is initialized

const bot = new Telegraf(config.botToken);

bot.use(requestLogging());
bot.use(rateLimit());
bot.use(auth());
bot.use(ingestion());

registerCommands(bot);

bot.on('pre_checkout_query', handlePreCheckoutQuery);
bot.on('successful_payment', handleSuccessfulPayment);
bot.on('my_chat_member', handleMyChatMemberUpdate);

bot.catch((err, ctx) => {
  logger.error(`Unhandled error for update ${ctx.updateType}`, { error: err.message, stack: err.stack });
});

function registerCommands(instance) {
  ['start', 'summary', 'find', 'filter', 'subscribe', 'digest', 'stats', 'privacy', 'language'].forEach((name) => {
    require(`./commands/${name}`)(instance);
  });
}

async function handleMyChatMemberUpdate(ctx) {
  const update = ctx.myChatMember;
  const chat = update.chat;
  if (!isGroupChat(chat)) return;

  const newStatus = update.new_chat_member.status;

  if (newStatus === 'member' || newStatus === 'administrator') {
    getOrCreateChat({ id: chat.id, title: chat.title, type: chat.type, addedBy: update.from.id });
    linkUserToChat(chat.id, update.from.id);

    // A group has members of mixed languages; best effort is the language of
    // whoever added the bot.
    const lang = (ctx.state && ctx.state.lang) || DEFAULT_LANGUAGE;

    await ctx.telegram.sendMessage(
      chat.id,
      t(lang, 'onboarding.joined', { retentionDays: config.privacy.messageRetentionDays }),
      { parse_mode: 'Markdown' }
    );
  } else if (newStatus === 'left' || newStatus === 'kicked') {
    deactivateChat(chat.id);
  }
}

async function main() {
  const worker = startWorker();
  const schedulerWorker = startScheduler();
  let stopHeartbeat = () => {};

  const shutdown = (signal) => async () => {
    logger.info(`Received ${signal}, shutting down...`);
    stopHeartbeat();
    bot.stop(signal);
    await Promise.all([worker.close(), schedulerWorker.close()]);
    process.exit(0);
  };

  // Register signal handlers before launching: bot.launch() in polling mode
  // doesn't resolve until the bot stops, so awaiting it first would mean
  // Ctrl+C / SIGTERM are never handled.
  process.once('SIGINT', shutdown('SIGINT'));
  process.once('SIGTERM', shutdown('SIGTERM'));

  await bot.launch({}, () => {
    logger.info(`Bot launched as @${bot.botInfo.username}`);
    // Written periodically so Docker's HEALTHCHECK (healthcheck.js) can tell
    // the process is alive and pumping updates, not just still running.
    stopHeartbeat = startHeartbeat(heartbeatPath);
  });
}

main().catch((error) => {
  logger.error('Fatal error during startup', { error: error.message, stack: error.stack });
  process.exit(1);
});
