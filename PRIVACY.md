# Privacy Policy

_Last updated: 2026-09-05_

This policy describes what the Telegram Assistant Bot ("the bot") collects, why, and how to remove it. It describes the behaviour actually implemented in this codebase — the retention periods below are enforced automatically by a scheduled job, not just stated here.

## What is collected

When the bot is a member of a group chat:

- **Text messages** sent in that group — the message text, the sender's Telegram display name/username, the message ID, and the timestamp.
- **Group metadata** — the group's ID, title, and type.
- **Membership** — which users have been seen active in which groups, so they can request summaries of those groups.

For public channels a user adds with `/addchannel`:

- **The channel's public username and title**, and which users follow it through the bot.
- **Nothing else.** Channel posts are fetched from the channel's own public web page at the moment a summary is requested, summarized, and discarded. Post text is never written to the database and therefore never appears in backups. Only the generated summary is cached.

Only **public** channels can be added — ones with a `@name` that anyone can open without joining. The bot has no access to private channels, and reads nothing through any user's Telegram account.

For users who interact with the bot directly:

- **Account basics** — Telegram user ID, username, first name.
- **Settings** — filter keywords and categories, scheduled digest preferences.
- **Usage** — counts of commands run (for enforcing free-tier limits) and a log of product events (e.g. "requested a summary", "hit a limit", "subscribed") used for aggregate analytics.
- **Subscription records** — plan, status, expiry, and the Telegram payment charge ID.

## What is NOT collected

- Non-text content: photos, videos, files, voice messages, stickers, and locations are ignored entirely.
- Private one-to-one conversations between other people. The bot only sees messages in groups it has been added to, plus direct messages sent to the bot itself.
- Payment card or banking details. Payments use Telegram Stars; the bot receives only a confirmation and a charge ID, never payment instrument data.
- Commands themselves (messages starting with `/`) are not stored as chat history.

## Why

Message text is stored solely to produce the product's core features: AI-generated summaries of recent group activity, and keyword search over past messages.

## Third parties

### Who receives message content

Message text is transmitted to the **DeepSeek API** to generate summaries. DeepSeek is operated by Hangzhou DeepSeek Artificial Intelligence Co., Ltd., **a company based in Hangzhou, China**, and the summarization is performed on DeepSeek's own infrastructure — that is, **outside the European Economic Area and the United Kingdom**. If you are in the EEA or the UK, this is a transfer of your data to a country that has not received an EU adequacy decision.

DeepSeek is the **only** third party that receives message content, and it receives it only at the moment a summary is generated. See DeepSeek's own terms and privacy policy for how they handle API data.

### What is sent

When a summary is generated, the bot sends DeepSeek a single request containing:

- **A transcript of the lookback window only** — the messages from the requested time range in that one chat, nothing else.
- For group messages: the **sender's display name or username**, followed by their message text **truncated to the first 300 characters**.
- For public channel posts: the post text **truncated to the first 600 characters**, with no author name (a channel is a single voice).
- **The language** the summary should be written in.

At most 200 messages are included in one request; longer windows are cut to the most recent 200.

### What is NOT sent

- **No identifiers.** The request carries no Telegram user ID, no chat ID, no username of the person who asked, and no account of ours that could be linked back to you. DeepSeek receives a block of text and a target language.
- **Nothing from `/find`.** Search runs entirely against the local database and never leaves the server.
- **No message beyond the requested window,** and nothing from a chat other than the one being summarized.
- **No message text at all when a cached summary is reused** — see below.

Requests to fetch public channel posts go to Telegram's own public web preview (`t.me`) and carry no information about which user asked.

### Generated summaries

Generated summaries are cached per (chat, time window, language) so repeated requests don't re-send the same content to DeepSeek. A cached summary is **shared between the users of that chat**, which is why identical requests produce identical text. Keyword highlights are *not* cached — they are recomputed per person from that person's own filters, so one user's keywords are never visible in another user's summary.

The cache has **no fixed expiry**. Instead it is invalidated the moment the underlying conversation changes, and it is deleted outright when the chat's messages are purged or when a participant runs `/forgetme`. It therefore never outlives the messages it was made from.

No data is sold, and no advertising or third-party tracking is present.

## Who can see what

- A group's summaries and search results are available to users the bot has seen active in that group.
- Aggregate, non-identifying usage statistics are visible to the bot operator.
- The bot operator has technical access to the underlying database, as with any self-hosted service.

## Retention

| Data | Retained for |
|---|---|
| Group messages | **90 days**, then deleted automatically |
| Messages in a group the bot was removed from | **7 days** after removal, then deleted |
| Cached summaries | No fixed expiry; discarded as soon as the underlying messages change, and deleted when those messages are |
| Filters, settings, usage counters | Until you delete them (`/forgetme`) |
| Subscription/payment records | Kept as billing records |
| Analytics events | Kept, but unlinked from your account when you use `/forgetme` |

Retention windows are configurable by the operator via `MESSAGE_RETENTION_DAYS` and `PURGE_AFTER_REMOVAL_DAYS`.

## How you find out the bot is here

The bot posts a data-collection notice when it joins a group. On its own that
only reaches whoever was in the room that day, so there are two further
mechanisms:

- **When new people join**, the notice is posted again — at most once every 24
  hours per group, however many people arrive, so an active group is not spammed
  into removing the bot.
- **Every summary carries a footer** naming the bot and linking `/privacy`. That
  reaches people who read a group without ever joining while the bot was
  watching, which the join notice cannot.

A direct message to each new member would be the most reliable of the three and
is not possible: Telegram does not let a bot message someone who has never
started a conversation with it.

## Your controls

- **`/privacy`** — see this summary inside Telegram, and **stop the bot storing
  your messages** with one tap. The opt-out applies to **every group**, not just
  the one you asked in, takes effect on your next message, and is reversible.
  Everything else keeps working: you can still request summaries and use every
  command, your own messages simply are not recorded. It does not delete what
  was stored before — `/forgetme` does that, and offers the opt-out at the same
  time.
- **Group admins** can run **`/pause`** in a group to stop the bot storing
  *anything* there, and `/resume` to start again. Paused means paused: messages
  already stored are kept until they expire normally, because pausing collection
  and deleting history are two different requests. While a chat is paused the
  bot will not produce summaries of it.
- **`/forgetme`** — permanently delete your stored messages, group links, filters, scheduled digests, and usage counters, and unlink your analytics events. Requires confirmation. Subscription records are retained so billing history and remaining paid time survive.
- **Remove the bot from a group** — stops collection immediately; that group's stored messages are deleted after the 7-day grace period. (The grace period exists so an accidental removal doesn't destroy history; re-adding the bot within it cancels the deletion.)
- **Group admins** can remove the bot or restrict its permissions at any time.

Note that `/forgetme` deletes data collected so far. If you continue chatting in a group the bot is still in, new messages will be stored again **unless you also opt out** — which is why the deletion confirmation offers that as the next step.

## A note to group admins

Adding this bot means the text messages of **everyone** in that group will be stored and sent to **DeepSeek**, an AI provider based in China, for summarization. The bot posts a notice explaining this when it joins, and again when new people join. You are responsible for ensuring the group's members are comfortable with that — consider asking before adding it, especially in groups discussing sensitive matters.

If you want the bot's summaries but not its collection right now, `/pause` stops the storing without removing the bot. Any admin of the group can run it; the person who owns the bot has no say over your group, and you have no say over the bot.

## Contact

Data deletion beyond `/forgetme`, or any other request, should be directed to the bot operator.
