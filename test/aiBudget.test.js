const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-aibudget-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';
process.env.ADMIN_USER_IDS = '4242';
// Set before config is loaded: it reads the environment once, at require time.
process.env.DEEPSEEK_DAILY_WARN_COMPLETIONS = '3';
process.env.DEEPSEEK_DAILY_MAX_COMPLETIONS = '5';

const db = require('../src/services/database');
const budget = require('../src/services/aiBudget');
const deepseek = require('../src/services/deepseek');
const registerAdmin = require('../src/commands/admin');

const handlers = {};
registerAdmin({
  command(name, fn) {
    handlers[name] = fn;
  },
  hears() {},
  action() {},
});

test.afterEach(() => {
  budget.resetToday();
  budget.setAdminNotifier(null);
});

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function adminCtx(text) {
  const replies = [];
  return {
    from: { id: 4242 },
    chat: { id: 4242, type: 'private' },
    message: { text },
    replies,
    reply: async (msg) => {
      replies.push(msg);
      return { message_id: 1 };
    },
  };
}

test('the cap blocks a call once it is reached, and not before', () => {
  for (let i = 0; i < 4; i++) budget.recordCompletion({ promptTokens: 100, completionTokens: 50 });

  // Four of five spent: still allowed.
  assert.doesNotThrow(() => budget.assertWithinBudget());

  budget.recordCompletion({ promptTokens: 100, completionTokens: 50 });

  assert.throws(() => budget.assertWithinBudget(), budget.SpendCapReachedError);
  const describe = budget.describeBudget();
  assert.equal(describe.completions, 5);
  assert.equal(describe.hardLimit, 5);
  assert.equal(describe.blocked, true);
});

test('the warning fires once, not on every call after the threshold', () => {
  const warnings = [];
  budget.setAdminNotifier(async (text) => warnings.push(text));

  budget.recordCompletion();
  budget.recordCompletion();
  assert.equal(warnings.length, 0, 'below the threshold nobody is bothered');

  budget.recordCompletion(); // third, the warn level
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /3 completions today/);

  budget.recordCompletion();
  budget.recordCompletion();
  assert.equal(warnings.length, 1, 'a DM per summary is a thing people mute');
});

test('a notifier that throws does not break the summary that triggered it', async () => {
  budget.setAdminNotifier(async () => {
    throw new Error('Forbidden: bot was blocked by the user');
  });

  // Telling the operator is best effort; failing to warn must never be the
  // thing that stops the work.
  assert.doesNotThrow(() => {
    budget.recordCompletion();
    budget.recordCompletion();
    budget.recordCompletion();
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(budget.describeBudget().completions, 3);
});

test('tokens are counted alongside completions, so the two can be calibrated', () => {
  budget.recordCompletion({ promptTokens: 1200, completionTokens: 800 });
  budget.recordCompletion({ promptTokens: 300, completionTokens: 150 });

  const describe = budget.describeBudget();
  assert.equal(describe.completions, 2);
  assert.equal(describe.promptTokens, 1500);
  assert.equal(describe.completionTokens, 950);
});

test('the counter is keyed by UTC date, so it rolls over at midnight on its own', () => {
  budget.recordCompletion();
  budget.recordCompletion();
  assert.equal(budget.describeBudget().completions, 2);

  // What tomorrow looks like: today's row is simply not the one being read.
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  db.db.prepare('UPDATE ai_usage SET date = ? WHERE date = ?').run(yesterday, new Date().toISOString().slice(0, 10));

  assert.equal(budget.describeBudget().completions, 0, 'a new day starts at zero with no job to run');
  assert.doesNotThrow(() => budget.assertWithinBudget());
});

test('an admin can add room for the day without raising the ceiling for ever', async () => {
  for (let i = 0; i < 5; i++) budget.recordCompletion();
  assert.throws(() => budget.assertWithinBudget(), budget.SpendCapReachedError);

  const ctx = adminCtx('/spend allow 10');
  await handlers.spend(ctx);

  assert.doesNotThrow(() => budget.assertWithinBudget(), 'the call goes through again');
  assert.equal(budget.describeBudget().hardLimit, 15);
  assert.match(ctx.replies[0], /Added 10 completions for today/);

  // Stored against today's row, so tomorrow starts from the configured cap.
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(db.db.prepare('SELECT extra_allowance FROM ai_usage WHERE date = ?').get(today).extra_allowance, 10);
});

test('an admin can reset the counter, and /spend reports where things stand', async () => {
  for (let i = 0; i < 4; i++) budget.recordCompletion({ promptTokens: 10, completionTokens: 5 });

  const report = adminCtx('/spend');
  await handlers.spend(report);
  assert.match(report.replies[0], /4 completions \(4\/5, warns at 3\)/);
  assert.match(report.replies[0], /40 in, 20 out/);

  const reset = adminCtx('/spend reset');
  await handlers.spend(reset);
  assert.equal(budget.describeBudget().completions, 0);
});

test('/spend is silent for a non-admin, like every other admin command', async () => {
  const ctx = adminCtx('/spend reset');
  ctx.from.id = 999;
  budget.recordCompletion();

  await handlers.spend(ctx);

  assert.deepEqual(ctx.replies, []);
  assert.equal(budget.describeBudget().completions, 1, 'and it had no effect');
});

test('bad arguments to /spend allow are refused rather than acted on', async () => {
  for (const text of ['/spend allow', '/spend allow zero', '/spend allow -5', '/spend allow 0']) {
    const ctx = adminCtx(text);
    await handlers.spend(ctx);
    assert.match(ctx.replies[0], /Usage:/, `"${text}" should print usage`);
  }
  assert.equal(budget.describeBudget().hardLimit, 5, 'the ceiling is untouched');
});

// --- the real call path ----------------------------------------------------

test('chatCompletion refuses before spending, and books what it spends', async () => {
  // Stubbed on the exported client instance, NOT on axios's prototype.
  // axios.create() binds its methods, so a prototype patch does not intercept
  // this call at all — and a stub that silently fails to bind means the suite
  // hits the real API and spends real money. It did, once, before this seam
  // existed. Asserting the call count is what makes that visible if it recurs.
  const calls = [];
  const realPost = deepseek.client.post;
  deepseek.client.post = async (...args) => {
    calls.push(args);
    return {
      data: {
        choices: [{ message: { content: 'a summary' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 700, completion_tokens: 300 },
      },
    };
  };

  try {
    const text = await deepseek.summarize('some conversation');
    assert.equal(text, 'a summary', 'if this is a real summary, the stub did not bind');
    assert.equal(calls.length, 1, 'the request went through the stub');

    const describe = budget.describeBudget();
    assert.equal(describe.completions, 1);
    assert.equal(describe.promptTokens, 700, 'usage comes from the response, not a guess');

    // Now spend the rest of the day's budget and try again.
    for (let i = 0; i < 4; i++) budget.recordCompletion();
    await assert.rejects(() => deepseek.summarize('more conversation'), budget.SpendCapReachedError);
    assert.equal(calls.length, 1, 'the point of a cap is that the request is never sent');
  } finally {
    deepseek.client.post = realPost;
  }
});

test('an unstubbed AI call cannot reach the real API from the test suite', async () => {
  // The invariant the README states: the suite needs no secrets and no network.
  // A developer .env sits in the repo root and dotenv loads it, so without this
  // a stub that fails to bind spends real money against a real key — which is
  // how this test came to exist.
  budget.resetToday();

  await assert.rejects(
    () => deepseek.summarize('this must never leave the machine'),
    (error) => {
      assert.match(error.message, /Failed to get a response from DeepSeek/);
      return true;
    }
  );
});
