const config = require('../config');
const { getBroadcastRecipients, getUserLanguage } = require('../services/database');
const { createSender, isBlockedError } = require('../utils/telegramSend');
const { t, normalizeLanguage, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = require('../utils/i18n');
const { track, EVENTS } = require('../services/analytics');
const logger = require('../utils/logger');

/**
 * Announcing something to everybody.
 *
 * This is the single most dangerous command in the bot: it messages every user
 * at once and cannot be recalled. Everything below is shaped by that — the
 * first message never sends, the preview shows the REAL recipient list rather
 * than an estimate, and the list that was counted is the list that gets
 * messaged.
 *
 * Admin replies are plain English, the same choice /stats and /spend make: this
 * is tooling for the one person who owns the bot. The ANNOUNCEMENTS themselves
 * are localized, because those go to users.
 */

// Pre-translated announcements, sent in each recipient's own language. Free
// text cannot be, so the preview says so rather than pretending.
const TEMPLATES = ['maintenance', 'newFeatures'];

// A preview nobody confirmed should not be sitting there an hour later waiting
// for a mistaken tap.
const PENDING_TTL_MS = 10 * 60 * 1000;

// adminId -> { template | text, recipients, expiresAt }
const pending = new Map();

function isAdmin(userId) {
  return config.adminUserIds.includes(userId);
}

function takePending(adminId) {
  const entry = pending.get(adminId);
  pending.delete(adminId);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry;
}

/** What one recipient will actually receive. */
function renderFor(entry, userId) {
  if (!entry.template) return entry.text;
  const lang = normalizeLanguage(getUserLanguage(userId));
  return t(lang, `broadcast.templates.${entry.template}`);
}

async function broadcastHandler(ctx) {
  // Silently ignore for non-admins rather than revealing the command exists.
  if (!isAdmin(ctx.from.id)) return;

  const body = (ctx.message.text || '').trim().replace(/^\/broadcast\s*/, '');

  if (!body) {
    return ctx.reply(
      'Usage:\n' +
        '  /broadcast <text>        send exactly this text to everyone\n' +
        `  /broadcast :<name>       send a pre-translated announcement\n\n` +
        `Available: ${TEMPLATES.map((name) => `:${name}`).join(', ')}\n\n` +
        'Nothing is sent until you confirm.'
    );
  }

  const template = body.startsWith(':') ? body.slice(1).trim() : null;
  if (template && !TEMPLATES.includes(template)) {
    return ctx.reply(`Unknown announcement ":${template}". Available: ${TEMPLATES.map((n) => `:${n}`).join(', ')}`);
  }

  // The real list, computed now and kept, so the number in the preview is the
  // number that gets messaged — not a count taken twice with a gap between.
  const recipients = getBroadcastRecipients();

  if (recipients.length === 0) {
    return ctx.reply('Nobody to send to. (People who ran /forgetme and never came back are excluded.)');
  }

  pending.set(ctx.from.id, {
    template,
    text: template ? null : body,
    recipients,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });

  const preview = template
    ? SUPPORTED_LANGUAGES.map((lang) => `[${lang}]\n${t(lang, `broadcast.templates.${template}`)}`).join('\n\n')
    : body;

  const languageNote = template
    ? 'Each person gets this in their own language.'
    : 'Free text: everybody gets it exactly as written above, in one language.';

  return ctx.reply(
    `📣 *Preview* — this will go to *${recipients.length}* people.\n${languageNote}\n\n` +
      '———\n' +
      `${preview}\n` +
      '———\n\n' +
      'This cannot be recalled. Confirm within 10 minutes.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `📣 Send to ${recipients.length} people`, callback_data: 'broadcast:confirm' }],
          [{ text: 'Cancel', callback_data: 'broadcast:cancel' }],
        ],
      },
    }
  );
}

/**
 * Sends to everyone, one at a time, at a pace Telegram tolerates.
 *
 * Uses the same sender the scheduler does rather than a BullMQ job. The task
 * that asked for this predates case-10, which solved exactly this problem in
 * process: createSender already paces, waits out a 429 for its stated
 * retry_after, and gives up in a bounded way. Routing through Redis would add a
 * dependency to a command the operator triggers by hand and watches, and buys
 * durability that a re-run would undo anyway — re-running a half-finished
 * broadcast double-sends to everyone it already reached. If that ever matters,
 * the fix is per-recipient delivery tracking, not a queue.
 */
async function runBroadcast(ctx, entry, { sleep } = {}) {
  const sender = createSender(sleep ? { sleep } : {});
  const result = { sent: 0, blocked: 0, failed: 0 };

  for (const userId of entry.recipients) {
    try {
      await sender.send(() => ctx.telegram.sendMessage(userId, renderFor(entry, userId)));
      result.sent += 1;
    } catch (error) {
      // One person's failure never ends the run. That is the whole difference
      // between "announced to everyone" and "announced to everyone up to the
      // first person who blocked the bot".
      if (isBlockedError(error)) {
        result.blocked += 1;
      } else {
        result.failed += 1;
        logger.warn('Broadcast delivery failed', { userId, error: error.message });
      }
    }
  }

  return result;
}

async function confirmCallback(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();

  const entry = takePending(ctx.from.id);
  if (!entry) {
    await ctx.answerCbQuery('That preview has expired — run /broadcast again.', { show_alert: true });
    return undefined;
  }

  await ctx.answerCbQuery('Sending…');
  await ctx.editMessageText(`📣 Sending to ${entry.recipients.length} people…`);

  logger.info('Broadcast started', {
    adminId: ctx.from.id,
    recipients: entry.recipients.length,
    template: entry.template || 'free-text',
  });

  const result = await runBroadcast(ctx, entry);

  track(EVENTS.BROADCAST_SENT, {
    userId: ctx.from.id,
    metadata: { ...result, template: entry.template || 'free-text' },
  });
  logger.info('Broadcast finished', { adminId: ctx.from.id, ...result });

  return ctx.reply(
    `📣 Done.\n` +
      `Sent: ${result.sent}\n` +
      `Blocked the bot: ${result.blocked}\n` +
      `Failed: ${result.failed}`
  );
}

async function cancelCallback(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  await ctx.answerCbQuery('Cancelled');
  return ctx.editMessageText('📣 Cancelled — nothing was sent.');
}

module.exports = (bot) => {
  // Absent from PUBLIC_COMMANDS, so it never appears in the "/" menu.
  bot.command('broadcast', broadcastHandler);
  bot.action('broadcast:confirm', confirmCallback);
  bot.action('broadcast:cancel', cancelCallback);
};

module.exports.runBroadcast = runBroadcast;
module.exports.TEMPLATES = TEMPLATES;
module.exports.DEFAULT_LANGUAGE = DEFAULT_LANGUAGE;
