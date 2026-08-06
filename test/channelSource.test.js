const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeHandle,
  parsePreviewPage,
  parseChannelTitle,
  htmlToText,
  dedupePosts,
} = require('../src/services/channelSource');

// Mirrors the real markup of https://t.me/s/<channel>: a run of message
// wrappers, each carrying data-post and a <time datetime>, where a text block
// is optional. The third post here is media-only, which is the case that broke
// naive parsing.
const PREVIEW_FIXTURE = `
<div class="tgme_channel_info_header_title"><span dir="auto">Pavel &amp; Co</span></div>
<div class="tgme_widget_message" data-post="durov/101">
  <div class="tgme_widget_message_text js-message_text" dir="auto">First post<br/>second line</div>
  <time datetime="2026-08-06T10:00:00+00:00" class="time">10:00</time>
</div>
<div class="tgme_widget_message" data-post="durov/102">
  <div class="tgme_widget_message_text js-message_text" dir="auto"><tg-emoji emoji-id="1"><i class="emoji"><b>🚀</b></i></tg-emoji> Ship it &amp; <b>celebrate</b> &lt;b&gt;not bold&lt;/b&gt;</div>
  <time datetime="2026-08-06T11:00:00+00:00" class="time">11:00</time>
</div>
<div class="tgme_widget_message" data-post="durov/103">
  <video src="x.mp4"></video>
  <time class="message_video_duration">0:16</time>
  <time datetime="2026-08-06T12:00:00+00:00" class="time">12:00</time>
</div>
<div class="tgme_widget_message" data-post="durov/104">
  <div class="tgme_widget_message_text js-message_text" dir="auto">Last one</div>
  <time datetime="2026-08-06T13:00:00+00:00" class="time">13:00</time>
</div>
`;

test('normalizeHandle accepts the forms people actually paste', () => {
  assert.equal(normalizeHandle('@durov'), 'durov');
  assert.equal(normalizeHandle('durov'), 'durov');
  assert.equal(normalizeHandle('  @Durov  '), 'durov', 'handles are lowercased so @Durov and @durov are one channel');
  assert.equal(normalizeHandle('t.me/durov'), 'durov');
  assert.equal(normalizeHandle('https://t.me/durov'), 'durov');
  assert.equal(normalizeHandle('https://t.me/s/durov'), 'durov');
  assert.equal(normalizeHandle('https://t.me/durov?single=1'), 'durov');
});

test('normalizeHandle rejects anything that is not a username', () => {
  // This value is interpolated into a URL the server fetches, so a null here
  // is the difference between a bot feature and a request generator aimed at
  // whatever the caller names — including this container's own network.
  for (const bad of [
    'abcd', // too short (Telegram minimum is 5)
    'a'.repeat(33), // too long
    '1durov', // must start with a letter
    'has-dash',
    'has space',
    '../../etc/passwd',
    'http://169.254.169.254/latest/meta-data',
    'evil.com/durov',
    'redis:6379',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(normalizeHandle(bad), null, `${String(bad)} must be rejected`);
  }
});

test('normalizeHandle keeps only the first path segment', () => {
  // t.me/durov/123 is a link to one post; the channel is still durov.
  assert.equal(normalizeHandle('t.me/durov/123'), 'durov');
  assert.equal(normalizeHandle('durov/../admin'), 'durov');
});

test('a media-only post does not shift text onto the wrong post', () => {
  // The bug this guards: scanning the page for ids and texts separately pairs
  // post 103's id with post 104's text, so a summary quotes the wrong post.
  const posts = parsePreviewPage(PREVIEW_FIXTURE);

  assert.equal(posts.length, 3, 'the media-only post is skipped, not mis-paired');
  assert.deepEqual(
    posts.map((p) => p.id),
    [101, 102, 104]
  );
  assert.match(posts[0].text, /^First post/);
  assert.equal(posts[2].text, 'Last one');
});

test('post text is decoded, de-tagged and keeps line breaks and emoji', () => {
  const [, second] = parsePreviewPage(PREVIEW_FIXTURE);

  assert.match(second.text, /🚀/, 'emoji survive tag stripping');
  assert.match(second.text, /Ship it & celebrate/, 'entities decoded, inline tags removed');
  assert.equal(parsePreviewPage(PREVIEW_FIXTURE)[0].text, 'First post\nsecond line', '<br> becomes a newline');
});

test('escaped markup in a post stays literal text', () => {
  // Order of operations: tags are stripped before entities are decoded. The
  // other way round, a post containing "&lt;b&gt;" would be decoded into a tag
  // and then silently stripped, changing what the author actually wrote.
  const [, second] = parsePreviewPage(PREVIEW_FIXTURE);
  assert.match(second.text, /<b>not bold<\/b>/);
});

test('posts carry a usable timestamp', () => {
  for (const post of parsePreviewPage(PREVIEW_FIXTURE)) {
    assert.ok(!Number.isNaN(Date.parse(post.createdAt)), `${post.id} has an unparseable date`);
  }
});

test('a post with no parseable date is dropped rather than dated now', () => {
  // Dating it "now" would drag an arbitrarily old post into every 24h window.
  const undated = '<div class="tgme_widget_message" data-post="x/1"><div class="tgme_widget_message_text js-message_text">no time</div></div>';
  assert.deepEqual(parsePreviewPage(undated), []);
});

test('an album repeats one caption across several ids and is collapsed to one post', () => {
  // Observed live on @durov: posts 440 and 442 carry identical text because
  // each item of an album is its own message. Uncollapsed, the caption is paid
  // for twice in the prompt and shown twice in the highlights.
  const deduped = dedupePosts([
    { id: 442, text: 'Historic milestone', createdAt: '2026-08-06T12:00:00Z' },
    { id: 440, text: 'Historic milestone', createdAt: '2026-08-06T11:00:00Z' },
    { id: 441, text: 'Something else', createdAt: '2026-08-06T11:30:00Z' },
  ]);

  assert.deepEqual(deduped.map((p) => p.id), [440, 441]);
  assert.equal(deduped[0].createdAt, '2026-08-06T11:00:00Z', 'the earliest id wins, keeping the real publish time');
});

test('overlapping pages repeating the same id yield one post', () => {
  const deduped = dedupePosts([
    { id: 10, text: 'a', createdAt: '2026-08-06T10:00:00Z' },
    { id: 10, text: 'a', createdAt: '2026-08-06T10:00:00Z' },
    { id: 11, text: 'b', createdAt: '2026-08-06T10:05:00Z' },
  ]);
  assert.deepEqual(deduped.map((p) => p.id), [10, 11]);
});

test('posts are returned oldest first, so the transcript reads in order', () => {
  const deduped = dedupePosts([
    { id: 3, text: 'c', createdAt: '2026-08-06T12:00:00Z' },
    { id: 1, text: 'a', createdAt: '2026-08-06T10:00:00Z' },
    { id: 2, text: 'b', createdAt: '2026-08-06T11:00:00Z' },
  ]);
  assert.deepEqual(deduped.map((p) => p.text), ['a', 'b', 'c']);
});

test('channel title is extracted and decoded', () => {
  assert.equal(parseChannelTitle(PREVIEW_FIXTURE), 'Pavel & Co');
  assert.equal(parseChannelTitle('<html>nothing here</html>'), null);
});

test('htmlToText collapses runaway whitespace', () => {
  assert.equal(htmlToText('a<br/><br/><br/><br/>b'), 'a\n\nb');
  assert.equal(htmlToText('   <b>  padded  </b>   '), 'padded');
});

test('numeric character references are decoded, invalid ones left alone', () => {
  assert.equal(htmlToText('&#1055;&#1088;&#1080;&#1074;&#1077;&#1090;'), 'Привет');
  assert.equal(htmlToText('&#x41;&#x42;'), 'AB');
  assert.equal(htmlToText('&#99999999;'), '&#99999999;', 'out-of-range code points are not crashed on');
  assert.equal(htmlToText('&notanentity;'), '&notanentity;');
});
