const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-wiring-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');

/**
 * Every button the bot draws, checked against every handler it registers.
 *
 * This exists because the keyword-alerts toggle shipped dead: toggleAlerts()
 * was written, the keyboard emitted 'filter:alerts:toggle', and no bot.action()
 * ever claimed it. Tapping it did nothing — Telegram shows a spinner, the
 * spinner stops, nothing is logged, and no test noticed for two days, because
 * every alerts test called the service directly instead of pressing the button.
 *
 * A drawn-but-dead button produces no error anywhere. The only way to find one
 * is to compare the two lists, which is all this file does.
 */

const SRC = path.join(__dirname, '..', 'src');

// ---------------------------------------------------------------------------
// The handler side: register every module the real bot registers.
// ---------------------------------------------------------------------------

/**
 * The command list is read out of bot.js rather than copied here, so a module
 * added there is covered by this test automatically. A copy would drift, and it
 * would drift silently in the direction of testing less.
 */
function commandModules() {
  const source = fs.readFileSync(path.join(SRC, 'bot.js'), 'utf8');
  const list = source.match(/\[((?:\s*'[a-z]+',?)+)\s*\]\.forEach/);
  assert.ok(list, 'could not find the command list in bot.js — has registerCommands changed shape?');
  const names = [...list[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

  // fallback is registered outside the list on purpose (it claims any plain
  // private message nothing else took), so it has to be added back by hand.
  const extra = [...source.matchAll(/require\(['"`]\.\/commands\/([a-z]+)['"`]\)\(instance\)/g)]
    .map((m) => m[1])
    .filter((name) => !names.includes(name));

  return [...names, ...extra];
}

const actions = [];
const fakeBot = {
  command() {},
  hears() {},
  on() {},
  use() {},
  start() {},
  action(pattern, ...rest) {
    // Telegraf allows middleware chains; the pattern is what matters here.
    actions.push(pattern);
    void rest;
  },
};

const MODULES = commandModules();
for (const name of MODULES) {
  require(path.join(SRC, 'commands', name))(fakeBot);
}

// Payments and the scheduler draw buttons too, and register their own handlers
// in bot.js rather than in a command module.
const payments = require('../src/services/payments');
if (typeof payments.registerActions === 'function') payments.registerActions(fakeBot);

function matches(pattern, data) {
  if (typeof pattern === 'string') return pattern === data;
  if (pattern instanceof RegExp) return pattern.test(data);
  // Telegraf also accepts an array or a predicate.
  if (Array.isArray(pattern)) return pattern.some((p) => matches(p, data));
  if (typeof pattern === 'function') {
    try {
      return Boolean(pattern(data));
    } catch {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The button side: every callback_data the source can emit.
// ---------------------------------------------------------------------------

function sourceFiles() {
  const files = [];
  for (const dir of ['commands', 'keyboards', 'services', 'middleware']) {
    const full = path.join(SRC, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.js')) files.push(path.join(full, name));
    }
  }
  return files;
}

/**
 * Pull the arguments of a call out of source text, respecting nesting and
 * quotes. A label is routinely `t(lang, 'some.key')`, so splitting the argument
 * list on commas with a regex takes the label apart instead of the call.
 */
function callArguments(source, openIndex) {
  const args = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += source[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      if (depth === 1) continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
    }
    if (ch === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  return null;
}

/**
 * The value expression after `callback_data:`, up to the comma or brace that
 * ends it. Scanned rather than matched, because a template literal contains
 * braces of its own: `digest:tz:${chatId}` ends at a `}` that is not the end
 * of anything.
 */
function valueExpression(source, start) {
  let depth = 0;
  let quote = null;
  let out = '';
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += source[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
    }
    if (ch === ',' && depth === 0) break;
    out += ch;
  }
  return out;
}

/**
 * Every string literal in an expression, not just the whole of it.
 *
 * A callback_data is not always one literal: privacy.js picks between
 * `privacy:optin:${id}` and `privacy:optout:${id}` with a ternary, and reading
 * only a plain literal misses both halves — which is exactly what this scanner
 * did on its first run.
 */
function literalsIn(text) {
  const out = [];
  for (const m of text.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) out.push(m[2]);
  return out;
}

/** Every callback_data the source can produce, as written. */
function declaredCallbackData() {
  const found = new Map();
  const record = (value, file) => {
    if (!value) return;
    if (!found.has(value)) found.set(value, path.relative(SRC, file));
  };

  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');

    // Object form: { text, callback_data: <expression> }
    for (const m of source.matchAll(/callback_data:\s*/g)) {
      const value = valueExpression(source, m.index + m[0].length);
      for (const literal of literalsIn(value)) record(literal, file);
    }

    // Telegraf form: Markup.button.callback(label, <expression>)
    for (const m of source.matchAll(/button\.callback\s*\(/g)) {
      const args = callArguments(source, m.index + m[0].length - 1);
      if (!args || args.length < 2) continue;
      for (const literal of literalsIn(args[1])) record(literal, file);
    }
  }
  return found;
}

/**
 * Values to try in a `${...}` hole. A template only has to be reachable by SOME
 * real value, so every combination is tried and one match is enough. The list
 * covers what actually goes into callback_data here: chat and user ids (large
 * and negative), hours, UTC offsets in minutes (negative), weekday indices, the
 * two language codes, the literal words a ternary can produce, and a keyword
 * row's ten-character hash.
 */
const HOLE_VALUES = [
  '-1001234567890',
  '900',
  '0',
  '-330',
  '12',
  '6',
  'daily',
  'weekly',
  'en',
  'ru',
  '0123456789',
];

function expansions(template) {
  const parts = template.split(/\$\{[^}]*\}/);
  const holes = parts.length - 1;
  if (holes === 0) return [template];
  // 11^3 is 1331 strings for the widest template here — cheap, and the cap
  // keeps a future four-hole template from quietly becoming slow.
  assert.ok(holes <= 3, `${template} has ${holes} interpolations; widen this deliberately`);

  let out = [parts[0]];
  for (let i = 1; i <= holes; i += 1) {
    const next = [];
    for (const prefix of out) {
      for (const value of HOLE_VALUES) next.push(prefix + value + parts[i]);
    }
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------------------

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('the guard finds the buttons and the handlers at all', () => {
  // If the scanners ever stop matching — a refactor to a different keyboard
  // helper, say — every assertion below passes vacuously. This is the test
  // that fails instead.
  assert.ok(MODULES.length >= 15, `only found ${MODULES.length} command modules in bot.js`);
  assert.ok(MODULES.includes('fallback'), 'fallback is registered outside the list and must still be covered');
  assert.ok(actions.length >= 25, `only ${actions.length} action handlers registered`);

  const declared = declaredCallbackData();
  assert.ok(declared.size >= 20, `only ${declared.size} callback_data values found in src/`);

  // A known button from each of the screens this is meant to cover, so a
  // scanner that silently stops seeing one of them is caught here.
  for (const known of ['filter:alerts:toggle', 'filter:kw:add', 'renew:open', 'privacy:cancel']) {
    assert.ok(declared.has(known), `the scanner no longer sees ${known}`);
  }
  for (const prefix of ['digest:', 'summary:chat:', 'channel:toggle:', 'fb:', 'language:set:']) {
    assert.ok(
      [...declared.keys()].some((d) => d.startsWith(prefix)),
      `the scanner no longer sees any ${prefix} button`
    );
  }
});

test('every button the bot draws has a handler listening for it', () => {
  const declared = declaredCallbackData();
  const dead = [];

  for (const [template, file] of declared) {
    const reachable = expansions(template).some((data) => actions.some((p) => matches(p, data)));
    if (!reachable) dead.push(`${template}  (${file})`);
  }

  assert.deepEqual(
    dead,
    [],
    `these buttons are drawn but nothing is listening — tapping them does nothing and logs nothing:\n  ${dead.join('\n  ')}`
  );
});

test('no button can outgrow the 64-byte callback_data cap', () => {
  // Telegram rejects the whole sendMessage, so an over-long button does not
  // degrade — it takes the entire screen with it. The dangerous ones are the
  // templates: a chat id and a keyword are both user-supplied lengths.
  const declared = declaredCallbackData();
  const oversized = [];

  for (const [template, file] of declared) {
    // The widest realistic values, not the average ones: a channel id is 14
    // characters and a supergroup id is 14 with the sign.
    const worst = template.replace(/\$\{[^}]*\}/g, '-1001234567890');
    if (Buffer.byteLength(worst) > 64) oversized.push(`${template} -> ${Buffer.byteLength(worst)}B  (${file})`);
  }

  assert.deepEqual(oversized, [], `over Telegram's 64-byte cap:\n  ${oversized.join('\n  ')}`);
});

test('a handler that no button can reach is either dead code or a typo', () => {
  // The other direction. A pattern nothing produces is usually a renamed
  // button whose handler was left behind, and it is the shape a typo takes:
  // 'filter:alert:toggle' registered against 'filter:alerts:toggle' drawn.
  const declared = declaredCallbackData();
  const all = [...declared.keys()].flatMap(expansions);

  const unreachable = actions
    .filter((pattern) => !all.some((data) => matches(pattern, data)))
    .map(String);

  assert.deepEqual(unreachable, [], `registered but nothing draws them:\n  ${unreachable.join('\n  ')}`);
});
