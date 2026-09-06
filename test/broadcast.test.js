const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-broadcast-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const ADMIN_ID = 5150;
process.env.ADMIN_USER_IDS = String(ADMIN_ID);

const db = require('../src/services/database');
const registerBroadcast = require('../src/commands/broadcast');
const { t } = require('../src/utils/i18n');
const { formatDate } = require('../src/utils/formatters');

const handlers = { commands: {}, actions: {} };
registerBroadcast({
  command(name, fn) {
    handlers.commands[name] = fn;
  },
  hears() {},
  action(name, fn) {
    handlers.actions[name] = fn;
  },
});

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function telegramError(code, description) {
  const error = new Error(`${code}: ${description}`);
  error.response = { error_code: code, description };
  error.code = code;
  error.description = description;
  return error;
}

function makeCtx({ text, from = ADMIN_ID, failFor = new Map() } = {}) {
  const replies = [];
  const answers = [];
  const delivered = [];
  return {
    from: { id: from },
    chat: { id: from, type: 'private' },
    message: { text },
    replies,
    answers,
    delivered,
    telegram: {
      sendMessage: async (chatId, body) => {
        const error = failFor.get(chatId);
        if (error) throw error;
        delivered.push({ chatId, body });
        return { message_id: 1 };
      },
    },
    reply: async (msg, extra) => {
      replies.push({ msg, extra: extra || {} });
      return { message_id: 1 };
    },
    editMessageText: async (msg) => {
      replies.push({ msg, extra: {} });
    },
    answerCbQuery: async (msg) => {
      answers.push(msg || '');
    },
  };
}

/** Somebody with data attached, so they are a real recipient. */
function reachableUser(id, { lang = 'en' } = {}) {
  db.getOrCreateUser({ id, username: `u${id}`, firstName: 'U' });
  db.setUserLanguage(id, lang);
  db.getOrCreateChat({ id: -id, title: 'Group', type: 'group' });
  db.linkUserToChat(-id, id);
  return id;
}

test('the first message never sends — it only previews, with the real count', async () => {
  reachableUser(5001);
  reachableUser(5002);
  reachableUser(5003);

  const ctx = makeCtx({ text: '/broadcast we are raising prices next month' });
  await handlers.commands.broadcast(ctx);

  assert.deepEqual(ctx.delivered, [], 'nothing is sent on the first message, ever');

  const preview = ctx.replies[0];
  assert.match(preview.msg, /Preview/);
  assert.match(preview.msg, /we are raising prices next month/);

  // The real count, not an estimate: it has to match what actually goes out.
  const recipients = db.getBroadcastRecipients().length;
  assert.match(preview.msg, new RegExp(`\\*${recipients}\\* people`));
  assert.equal(preview.extra.reply_markup.inline_keyboard[0][0].callback_data, 'broadcast:confirm');
});

test('confirming sends to exactly the people the preview counted', async () => {
  const ids = [5010, 5011, 5012].map((id) => reachableUser(id));

  const preview = makeCtx({ text: '/broadcast planned downtime tonight' });
  await handlers.commands.broadcast(preview);

  const confirm = makeCtx({ text: '' });
  await handlers.actions['broadcast:confirm'](confirm);

  for (const id of ids) {
    assert.ok(confirm.delivered.some((d) => d.chatId === id), `${id} should have been messaged`);
  }
  assert.ok(confirm.delivered.every((d) => d.body === 'planned downtime tonight'), 'free text goes as typed');

  const summary = confirm.replies[confirm.replies.length - 1].msg;
  assert.match(summary, /Sent: \d+/);
});

test('a preview can be cancelled, and cancelling really does cancel', async () => {
  reachableUser(5020);

  await handlers.commands.broadcast(makeCtx({ text: '/broadcast something regrettable' }));

  const cancel = makeCtx();
  await handlers.actions['broadcast:cancel'](cancel);
  assert.match(cancel.replies[0].msg, /Cancelled/);

  // The pending preview is gone, so a later confirm has nothing to send.
  const confirm = makeCtx();
  await handlers.actions['broadcast:confirm'](confirm);
  assert.deepEqual(confirm.delivered, []);
  assert.match(confirm.answers[0], /expired/);
});

test('confirming without a preview sends nothing', async () => {
  reachableUser(5030);
  const confirm = makeCtx();
  await handlers.actions['broadcast:confirm'](confirm);

  assert.deepEqual(confirm.delivered, [], 'the confirm gate is not optional');
  assert.match(confirm.answers[0], /expired/);
});

test('one blocked recipient does not end the run for everybody else', async () => {
  const ids = [5040, 5041, 5042, 5043].map((id) => reachableUser(id));

  await handlers.commands.broadcast(makeCtx({ text: '/broadcast an announcement' }));

  const failFor = new Map([
    [5041, telegramError(403, 'Forbidden: bot was blocked by the user')],
    [5042, telegramError(400, 'Bad Request: chat not found')],
  ]);
  const confirm = makeCtx({ failFor });
  await handlers.actions['broadcast:confirm'](confirm);

  // The two that could be reached, were.
  assert.ok(confirm.delivered.some((d) => d.chatId === ids[0]));
  assert.ok(confirm.delivered.some((d) => d.chatId === ids[3]));

  const summary = confirm.replies[confirm.replies.length - 1].msg;
  assert.match(summary, /Blocked the bot: 1/, 'a block is counted, not fatal');
  assert.match(summary, /Failed: 1/, 'and other failures are counted separately');
});

test('a pre-translated announcement reaches each person in their own language', async () => {
  reachableUser(5050, { lang: 'en' });
  reachableUser(5051, { lang: 'ru' });

  const preview = makeCtx({ text: '/broadcast :maintenance' });
  await handlers.commands.broadcast(preview);
  assert.match(preview.replies[0].msg, /own language/);

  const confirm = makeCtx();
  await handlers.actions['broadcast:confirm'](confirm);

  const toEnglish = confirm.delivered.find((d) => d.chatId === 5050);
  const toRussian = confirm.delivered.find((d) => d.chatId === 5051);
  assert.equal(toEnglish.body, t('en', 'broadcast.templates.maintenance'));
  assert.equal(toRussian.body, t('ru', 'broadcast.templates.maintenance'));
  assert.notEqual(toEnglish.body, toRussian.body);
});

test('free text says plainly that it is not translated', async () => {
  reachableUser(5060);
  const ctx = makeCtx({ text: '/broadcast just as I typed it' });
  await handlers.commands.broadcast(ctx);
  assert.match(ctx.replies[0].msg, /exactly as written/);
});

test('an unknown announcement name is refused rather than sent as text', async () => {
  reachableUser(5070);
  const ctx = makeCtx({ text: '/broadcast :nosuchthing' });
  await handlers.commands.broadcast(ctx);

  assert.match(ctx.replies[0].msg, /Unknown announcement/);
  assert.deepEqual(ctx.delivered, []);
});

test('somebody who ran /forgetme and never came back is not messaged', async () => {
  // /forgetme keeps the users row on purpose, so "everyone in users" would
  // reach people who pressed the delete button.
  const forgotten = 5080;
  db.getOrCreateUser({ id: forgotten, username: 'gone', firstName: 'G' });
  db.getOrCreateChat({ id: -forgotten, title: 'Group', type: 'group' });
  db.linkUserToChat(-forgotten, forgotten);
  db.saveMessage({ chatId: -forgotten, messageId: 1, userId: forgotten, username: 'gone', text: 'hello' });

  assert.ok(db.getBroadcastRecipients().includes(forgotten), 'reachable to begin with');

  db.deleteUserData(forgotten);

  assert.ok(!db.getBroadcastRecipients().includes(forgotten), 'and not afterwards');
});

test('but a paying customer who ran /forgetme is still reachable', async () => {
  // Subscriptions survive /forgetme by design, and somebody still paying should
  // hear about a price change even if they cleared their history.
  const payer = 5090;
  db.getOrCreateUser({ id: payer, username: 'payer', firstName: 'P' });
  db.createSubscription({
    userId: payer,
    plan: 'monthly',
    starsPaid: 300,
    telegramChargeId: `charge-bc-${payer}`,
    expiresAt: formatDate(new Date(Date.now() + 30 * 86400000)),
  });

  db.deleteUserData(payer);

  assert.ok(db.getBroadcastRecipients().includes(payer));
});

test('sends are paced, because this is the one place that hits the rate limit hardest', async () => {
  const ids = [5100, 5101, 5102, 5103, 5104].map((id) => reachableUser(id));

  await handlers.commands.broadcast(makeCtx({ text: '/broadcast paced' }));

  const waits = [];
  const ctx = makeCtx();
  // runBroadcast is exercised directly so the pacing can be observed without
  // the suite actually sleeping through it.
  const entry = { template: null, text: 'paced', recipients: ids };
  const result = await registerBroadcast.runBroadcast(ctx, entry, {
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal(result.sent, ids.length);

  // Every send after the first waited for a slot. The exact gap is not asserted
  // here: this fake sleep returns without advancing the clock, so the sender
  // correctly keeps booking further into a future that never arrives and the
  // waits grow. The pacing arithmetic is pinned against a controlled clock in
  // telegramSend.test.js; what matters here is that a broadcast goes through
  // the shared sender at all rather than looping over sendMessage.
  assert.ok(waits.length >= ids.length - 1, `expected the sends to be spaced out, got ${JSON.stringify(waits)}`);
  assert.ok(waits.every((ms) => ms > 0));
});

test('/broadcast is silent for a non-admin and has no effect', async () => {
  reachableUser(5110);

  const ctx = makeCtx({ text: '/broadcast I am not an admin', from: 9999 });
  await handlers.commands.broadcast(ctx);
  assert.deepEqual(ctx.replies, []);

  const confirm = makeCtx({ from: 9999 });
  await handlers.actions['broadcast:confirm'](confirm);
  assert.deepEqual(confirm.delivered, []);
});

test('broadcast stays out of the published command menu', () => {
  const { PUBLIC_COMMANDS } = require('../src/utils/i18n');
  assert.ok(!PUBLIC_COMMANDS.includes('broadcast'));
});
