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
const { setAdminNotifier } = require('./services/aiBudget');
const { setAlertSender } = require('./services/keywordAlerts');
const { getOrCreateChat, linkUserToChat, deactivateChat, claimJoinNotice } = require('./services/database');
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
bot.on('new_chat_members', handleNewChatMembers);

bot.catch((err, ctx) => {
  logger.error(`Unhandled error for update ${ctx.updateType}`, { error: err.message, stack: err.stack });
});

function registerCommands(instance) {
  ['start', 'help', 'summary', 'find', 'filter', 'channel', 'subscribe', 'status', 'feedback', 'digest', 'stats', 'admin', 'broadcast', 'moderation', 'privacy', 'language'].forEach((name) => {
    require(`./commands/${name}`)(instance);
  });

  // Registered after every command module, and deliberately kept out of the
  // list above rather than appended to the end of it: it claims any plain
  // private message nothing else took, so a module registered behind it would
  // never see one. Out here, a new command added to the list cannot land on
  // the wrong side of it by accident.
  require('./commands/fallback')(instance);
}

// Once a day at most. The notice is for people who were not here when the bot
// arrived; posting it on every join would turn a busy group's membership churn
// into a stream of identical messages and get the bot removed, which protects
// nobody.
const JOIN_NOTICE_THROTTLE_HOURS = 24;

/**
 * Someone who joins a group three months after the bot did never saw the
 * notice it posted on arrival. Their messages are stored and sent to a
 * third-party AI service in another jurisdiction, and nothing has ever told
 * them the bot exists — /forgetme only helps someone who already knows to run
 * it.
 *
 * This is one of two mechanisms, deliberately. The other is the footer on every
 * summary, which reaches people who read the group without ever joining while
 * the bot was watching. A DM to each new member would be the most direct
 * approach and is not possible: Telegram will not let a bot message a stranger.
 */
async function handleNewChatMembers(ctx) {
  const chat = ctx.chat;
  if (!isGroupChat(chat)) return;

  const members = ctx.message.new_chat_members || [];
  // The bot joining is already covered, with a fuller notice, by
  // handleMyChatMemberUpdate.
  if (members.every((member) => member.is_bot)) return;

  getOrCreateChat({ id: chat.id, title: chat.title, type: chat.type });
  if (!claimJoinNotice(chat.id, JOIN_NOTICE_THROTTLE_HOURS)) return;

  const lang = (ctx.state && ctx.state.lang) || DEFAULT_LANGUAGE;
  try {
    await ctx.telegram.sendMessage(
      chat.id,
      t(lang, 'onboarding.newMembers', { retentionDays: config.privacy.messageRetentionDays }),
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    // A notice that cannot be posted must not take the update down with it.
    logger.warn('Could not post the data-collection notice for new members', {
      chatId: chat.id,
      error: error.message,
    });
  }
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
  // aiBudget deliberately knows nothing about Telegram — deepseek.js imports it,
  // and dragging a bot client in there would put one into every test that stubs
  // a summary. It gets a way to reach the operator here instead, once.
  setAdminNotifier(async (text) => {
    for (const adminId of config.adminUserIds) {
      await bot.telegram.sendMessage(adminId, text).catch((error) =>
        logger.warn('Could not DM an admin the spend warning', { adminId, error: error.message })
      );
    }
  });

  // Same reasoning as the spend notifier: keywordAlerts is reached from
  // ingestion middleware, and importing a bot client there would put one into
  // every test that sends a group message.
  setAlertSender((chatId, text, extra) => bot.telegram.sendMessage(chatId, text, extra));

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
