const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-fallback-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');
const registerFallback = require('../src/commands/fallback');
const { armPrompt, captureReply } = require('../src/utils/uiState');
const { t, SUPPORTED_LANGUAGES } = require('../src/utils/i18n');

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/**
 * A miniature of the real middleware chain, in the real order: whatever a
 * command module registered first, then the fallback last. The ordering is the
 * property under test as much as the reply is.
 */
function makeChain({ before = [] } = {}) {
  const textHandlers = [...before];
  registerFallback({
    on(event, fn) {
      assert.equal(event, 'text');
      textHandlers.push(fn);
    },
    command() {},
    hears() {},
    action() {},
  });

  return async function dispatch(ctx) {
    let i = 0;
    const next = async () => {
      const handler = textHandlers[i++];
      if (handler) return handler(ctx, next);
      return undefined;
    };
    await next();
    return ctx;
  };
}

function makeCtx({ text, type = 'private', userId = 800, lang = 'en' }) {
  const replies = [];
  return {
    chat: { id: type === 'private' ? userId : -userId, type },
    from: { id: userId },
    message: { text },
    state: { lang },
    replies,
    reply: async (msg, extra) => {
      replies.push({ msg, extra });
      return { message_id: 1 };
    },
  };
}

test('a private message nothing claimed gets an answer instead of silence', async () => {
  const dispatch = makeChain();
  const ctx = await dispatch(makeCtx({ text: 'my project channel' }));

  assert.equal(ctx.replies.length, 1, 'the bot must say something rather than ignore them');
  assert.equal(ctx.replies[0].msg, t('en', 'common.unclaimedMessage'));
  assert.ok(ctx.replies[0].extra.reply_markup.keyboard, 'and the menu comes back with it');
});

test('an armed prompt still wins, because the fallback runs last', async () => {
  // The exact scenario the fallback must not break: someone tapped "add a
  // channel", was asked for the name, and is now answering.
  const captured = [];
  const dispatch = makeChain({
    before: [captureReply('add-channel', async (ctx, text) => captured.push(text))],
  });

  armPrompt(801, 'add-channel');
  const ctx = await dispatch(makeCtx({ text: '@durov', userId: 801 }));

  assert.deepEqual(captured, ['@durov'], 'the feature that asked gets the answer');
  assert.deepEqual(ctx.replies, [], 'and the fallback stays out of it');
});

test('a prompt lost to a restart is the case this exists for', async () => {
  // Same message, same handler registered — but no armed prompt, which is what
  // a deploy leaves behind. captureReply passes it through, and before this
  // change nothing else claimed it.
  const captured = [];
  const dispatch = makeChain({
    before: [captureReply('add-channel', async (ctx, text) => captured.push(text))],
  });

  const ctx = await dispatch(makeCtx({ text: '@durov', userId: 802 }));

  assert.deepEqual(captured, []);
  assert.equal(ctx.replies.length, 1, 'the message lands on the fallback rather than on nothing');
});

test('it never fires in a group, where people are talking to each other', async () => {
  const dispatch = makeChain();
  for (const type of ['group', 'supergroup']) {
    const ctx = await dispatch(makeCtx({ text: 'what did everyone think?', type }));
    assert.deepEqual(ctx.replies, [], `must stay silent in a ${type}`);
  }
});

test('it never fires for a command, or for a menu button in any language', async () => {
  const dispatch = makeChain();

  const command = await dispatch(makeCtx({ text: '/somethingunknown' }));
  assert.deepEqual(command.replies, [], 'Telegram already lists the commands that exist');

  // Every label, in every language: someone who switched language still has
  // the old keyboard rendered on their client.
  for (const lang of SUPPORTED_LANGUAGES) {
    for (const key of ['menu.summary', 'menu.find', 'menu.filters', 'menu.digest', 'menu.channels', 'menu.subscribe', 'menu.language', 'menu.privacy', 'menu.help']) {
      const ctx = await dispatch(makeCtx({ text: t(lang, key) }));
      assert.deepEqual(ctx.replies, [], `"${t(lang, key)}" (${lang}) is a button, not a stray message`);
    }
  }
});

test('the fallback is registered after every command module', () => {
  // The whole design rests on it running last. Registered from the list of
  // command modules instead, a later addition would sit behind it and never
  // see a plain private message.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'bot.js'), 'utf8');
  const listIndex = source.indexOf('.forEach((name) => {');
  const fallbackIndex = source.indexOf("require('./commands/fallback')");

  assert.ok(fallbackIndex > listIndex, 'fallback must be required after the command list is registered');
  assert.ok(
    !/'fallback'/.test(source.slice(0, listIndex)),
    'fallback must not be inside the command list, where a new command could be appended behind it'
  );
});
