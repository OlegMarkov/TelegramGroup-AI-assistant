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
const { startScheduler, startRetentionSweeps } = require('./services/scheduler');
const { getOrCreateChat, linkUserToChat, deactivateChat } = require('./services/database');
const { isGroupChat } = require('./utils/formatters');
const { t, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, PUBLIC_COMMANDS } = require('./utils/i18n');
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
  ['start', 'help', 'summary', 'find', 'filter', 'channel', 'subscribe', 'status', 'digest', 'stats', 'admin', 'privacy', 'language'].forEach((name) => {
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

/**
 * Publish the command list Telegram shows in its "/" menu, in every language
 * we support.
 *
 * Best effort on purpose: this costs discoverability, not function, so a
 * Telegram hiccup here must never keep the bot from launching.
 */
async function publishCommandMenu() {
  for (const lang of SUPPORTED_LANGUAGES) {
    const commands = PUBLIC_COMMANDS.map((command) => ({
      command,
      description: t(lang, `commands.${command}`),
    }));
    // Telegram keys these by language_code, and falls back to the list
    // published without one — so the default language is published bare.
    const scope = lang === DEFAULT_LANGUAGE ? {} : { language_code: lang };
    await bot.telegram.setMyCommands(commands, scope);
  }
}

/**
 * Is the Telegram polling loop still running?
 *
 * Telegraf's Polling.loop() aborts its AbortController in a `finally` block, so
 * the signal flips whenever polling ends for any reason — clean stop, thrown
 * error, or the iterator completing. That makes it a trustworthy liveness
 * signal, at the cost of reaching into library internals.
 *
 * Deliberately fails OPEN: if a future Telegraf version reshapes this, we
 * report alive rather than flapping the container into a restart loop. The
 * "launch() resolved unexpectedly" check in main() still catches the real
 * failure independently of these internals.
 */
function isPollingAlive() {
  const polling = bot.polling;
  if (!polling) return true; // not launched yet — don't suppress the first beat
  return polling.abortController?.signal?.aborted !== true;
}

async function main() {
  const worker = startWorker();
  const schedulerWorker = startScheduler();
  // Deliberately not part of the scheduler: retention is a promise made in
  // PRIVACY.md, and it must not stop being kept because Redis is down.
  const stopRetentionSweeps = startRetentionSweeps();
  let stopHeartbeat = () => {};
  let shuttingDown = false;

  const shutdown = (signal) => async () => {
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    stopHeartbeat();
    stopRetentionSweeps();
    bot.stop(signal);
    await Promise.all([worker.close(), schedulerWorker.close()]);
    process.exit(0);
  };

  // Register signal handlers before launching: bot.launch() in polling mode
  // doesn't resolve until the bot stops, so awaiting it first would mean
  // Ctrl+C / SIGTERM are never handled.
  process.once('SIGINT', shutdown('SIGINT'));
  process.once('SIGTERM', shutdown('SIGTERM'));

  // Before launch rather than after: the menu is a plain API call that needs
  // only the token, and doing it here keeps the failure out of the callback
  // that starts the heartbeat.
  try {
    await publishCommandMenu();
  } catch (error) {
    logger.warn('Could not publish the command menu to Telegram', { error: error.message });
  }

  await bot.launch({}, () => {
    logger.info(`Bot launched as @${bot.botInfo.username}`);
    // Telegraf aborts this signal when the polling loop ends, so it is the
    // closest thing to a real "am I still listening to Telegram?" check.
    // Gating the heartbeat on it means a bot that has stopped consuming
    // updates goes unhealthy instead of silently looking fine.
    stopHeartbeat = startHeartbeat(heartbeatPath, { isAlive: isPollingAlive });
  });

  // In polling mode bot.launch() only resolves once polling has stopped. If we
  // reach here without a shutdown having been requested, the poller died on its
  // own: the process would otherwise stay alive (Redis connections hold the
  // event loop open) as a bot that answers nobody. Exit loudly so Docker's
  // restart policy brings it back.
  if (!shuttingDown) {
    logger.error('Telegram polling stopped unexpectedly — exiting so the container restarts');
    stopHeartbeat();
    stopRetentionSweeps();
    await Promise.all([worker.close(), schedulerWorker.close()]).catch(() => {});
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Fatal error during startup', { error: error.message, stack: error.stack });
  process.exit(1);
});
