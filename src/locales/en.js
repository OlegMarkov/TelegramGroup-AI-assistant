module.exports = {
  languageName: 'English',
  // Passed to the DeepSeek prompt, so it must be the language's English name.
  aiPromptLanguage: 'English',

  menu: {
    summary: '📝 Summary',
    find: '🔎 Find',
    filters: '🎯 Filters',
    channels: '📢 Channels',
    digest: '📅 Digest',
    subscribe: '⭐ Subscribe',
    language: '🌐 Language',
    privacy: '🔒 Privacy',
    help: 'ℹ️ Help',
  },

  // One line each, published to Telegram's "/" menu. Kept short on purpose:
  // the client truncates them, and they are read while scrolling a list.
  commands: {
    start: 'Start over and show the main menu',
    help: 'How I work — the full guide',
    summary: 'Summarize what you missed',
    find: 'Search the history of your groups',
    filter: 'Topics and keywords to highlight',
    channels: 'Public channels you follow',
    digest: 'Daily digest by DM (premium)',
    subscribe: 'Go premium with Telegram Stars',
    status: 'Your plan, usage and limits',
    language: 'Switch language / сменить язык',
    privacy: 'What I store and for how long',
    forgetme: 'Delete all my data',
  },

  common: {
    notAuthorizedForChat: 'Not authorized for this chat',
    noLinkedChats: 'You are not linked to any group chats yet. Add me to a group to get started.',
    cancel: 'Cancel',
    done: 'Done',
    chatFallback: 'Chat {id}',
    tooManyRequests: '⏳ Too many requests. Please try again in {seconds}s.',
    unclaimedMessage:
      "🤔 I'm not sure what that refers to. Here's the menu — or /help for the full guide.\n\n" +
      'If you were answering a question I asked, try tapping the button again.',
  },

  start: {
    // Appended to the greeting only when a trial was actually granted, so the
    // sentence is never a promise to somebody who did not get one.
    trialGranted:
      '🎁 *Your {days}-day free trial has started.* Unlimited summaries, longer lookback, ' +
      'more channels and keywords, and daily digests — all switched on right now. ' +
      'Nothing to pay and nothing to cancel: when it ends you simply drop back to the free plan.',
    greeting:
      "👋 Hi {name}! I'm your AI assistant for busy chats — I read them so you don't have to.\n\n" +
      '*Two ways to start*\n' +
      '💬 Add me to a group, then run /summary there to see what you missed.\n' +
      '📢 Or follow a public channel with /channels — no group needed.\n\n' +
      '*Then, from right here in DM*\n' +
      '📝 /summary — the last few hours in a few lines ' +
      '(free: {freeSummaries} a day, up to {freeHours}h back)\n' +
      '🔎 /find <words> — search what was said in your groups\n' +
      '🎯 /filter — topics and keywords of your own ' +
      '({freeKeywords} free, {premiumKeywords} with premium), pulled out of every summary\n' +
      '📢 /channels — public channels ({freeChannels} free, {premiumChannels} with premium)\n' +
      '📅 /digest — premium: a summary by DM every day, at an hour you pick\n' +
      '⭐ /subscribe — unlimited summaries, longer lookback, daily digests\n\n' +
      'ℹ️ /help for the full guide, 🔒 /privacy for what I store.\n' +
      'Or just tap the buttons below.{trialNote}',
  },

  help: {
    text:
      '🤖 *How I work*\n\n' +
      'Point me at a chat and I tell you what you missed — a few lines instead of a few hundred messages.\n\n' +
      '*Setting me up*\n' +
      '💬 *Groups* — add me to one and I start keeping track. If I stay quiet, whoever owns this bot has to ' +
      'turn off privacy mode in @BotFather → /setprivacy → Disable; until then Telegram only shows me ' +
      'messages that mention or reply to me.\n' +
      '📢 *Channels* — /channels follows any public channel. Nothing to install, and no group required.\n\n' +
      '*Day to day*\n' +
      '📝 /summary — what happened recently. Add hours to look further back, like `/summary 12`. ' +
      'In a group it summarizes that group; in DM I ask which chat you mean.\n' +
      '🔎 /find <words> — search everything I have stored for your groups, e.g. `/find deploy schedule`. ' +
      'Captions on photos and files count too. ' +
      'Channel posts are read live and never stored, so they are not searchable.\n' +
      '🎯 /filter — pick topics, and add keywords of your own: a project, a product, your name. ' +
      'Anything matching gets its own block at the end of every summary. ' +
      'Endings count too — "release" also finds "releases".\n' +
      '📢 /channels — your channel list. Tap to select, ➕ to add, 🗑 to remove. ' +
      '`/addchannel @name` and `/removechannel @name` work too.\n' +
      '📅 /digest — premium: have the summary arrive by DM every day, at an hour you choose. ' +
      'Tell me your timezone once and the times are shown in your own clock.\n\n' +
      '*Free vs. premium*\n' +
      '• Summaries — {freeSummaries} a day → unlimited\n' +
      '• Lookback — {freeHours}h → {premiumHours}h\n' +
      '• Groups — {freeGroups} → unlimited\n' +
      '• Channels — {freeChannels} → {premiumChannels}\n' +
      '• Keywords of your own — {freeKeywords} → {premiumKeywords}\n' +
      '• Daily digest — premium only\n\n' +
      '⭐ /subscribe pays with Telegram Stars, without leaving Telegram. Nothing you set up is ever thrown ' +
      'away: if a subscription lapses, the extras stay saved and simply wait for you to renew.\n\n' +
      '*Your data and settings*\n' +
      '📊 /status — your plan, what you have used, and what is locked\n' +
      '🔒 /privacy — what I store, who sees it, how long I keep it\n' +
      '🗑 /forgetme — delete your messages and settings for good\n' +
      '🚫 Not comfortable being recorded? /privacy has a button that stops me storing ' +
      'your messages in every group, while you carry on using everything else\n' +
      '👮 Group admins: /pause and /resume control collection for the whole chat\n' +
      '🌐 /language — English or Русский\n\n' +
      'Lost? /start brings the menu back.',
  },

  onboarding: {
    joined:
      '👋 Thanks for adding me!\n\n' +
      "📋 *Heads up, everyone*: from now on I store this chat's text messages " +
      '(sender name + timestamp) so I can generate summaries and let you search history. ' +
      'Message text is sent to the DeepSeek API to write those summaries, and is deleted ' +
      'automatically after {retentionDays} days.\n\n' +
      'Run /privacy for the full details, or /forgetme to delete your own data at any time — ' +
      'that screen also has a button to stop me storing your messages anywhere.\n\n' +
      '👮 *Admins*: /pause stops me storing anything in this chat, /resume starts again. ' +
      'Removing me stops collection entirely.\n\n' +
      '⚠️ For me to see all messages (not just replies/mentions), whoever owns this bot must ' +
      'disable privacy mode via @BotFather → /setprivacy → Disable.\n\n' +
      'Then use /summary here anytime, or message me privately to pick this chat from your list.\n' +
      '/help explains everything I can do.',
    // Shorter than the arrival notice on purpose: this lands in an established
    // group, where a wall of text reads as spam and gets the bot removed.
    newMembers:
      '👋 Welcome! *Heads up*: I summarize this chat, so I store its text messages ' +
      '(sender name + timestamp) and send them to the DeepSeek API, based in China, ' +
      'to write those summaries. They are deleted automatically after {retentionDays} days.\n\n' +
      '🔒 /privacy — the full details, and a button to stop me storing YOUR messages anywhere.\n' +
      '🗑 /forgetme — delete what I already have for you.',
  },

  summary: {
    blockedGroupLimit:
      '⭐ The free plan only works in your first {maxGroups} group. ' +
      '/subscribe to use me in unlimited groups.',
    blockedDailyLimit:
      "You've used your {limit} free summaries for today. " +
      '⭐ /subscribe for unlimited summaries, longer lookback, and daily digests.',
    capNotePremium: ' ({hours}h is the max lookback)',
    capNoteFree: ' (capped to {hours}h on the free plan — /subscribe for up to {maxHours}h)',
    working: '⏳ Looking at the last {hours}h of activity...{capNote}',
    failed: 'Sorry, I could not generate a summary right now. Please try again shortly.',
    // An honest refusal. Not a stack trace, and not a blank summary under a
    // confident header — we chose not to make this call.
    budgetReached:
      "🛑 I've hit my daily limit for writing summaries, so I'm not making any more today.\n\n" +
      'This resets at 00:00 UTC. Everything else — /find, /filter, /channels — still works.',
    noActivity: 'No activity in the last {hours}h to summarize.',
    header: '📝 *Summary — last {hours}h*{autoNote}',
    // Appended to the header when the window was chosen for the user rather
    // than typed by them, so "last 7h" is never an unexplained number.
    autoNoteSinceLast: ' (since your last summary)',
    autoNoteFirstTime: ' (first summary here)',
    // A busy window is summarized from its most recent messages only. Without
    // this the result looks exactly like a summary of the whole period.
    truncatedNote: '_Busy window — this covers the most recent {shown} of {total} messages._',
    pickChat: 'Which chat do you want summarized?',
    hiddenGroupsNote:
      "ℹ️ You're active in {total} groups, but the free plan only works in {allowed}. " +
      '⭐ /subscribe to unlock the rest.',
    highlightsHeader: '🔔 *Matches your filters*',
    // Appended to every group summary, so the bot's presence is visible to
    // people reading it who never saw the notice when it joined.
    footer: "_Summarized by this bot, which stores this chat's messages. /privacy for what and how long._",
    chatPaused:
      '⏸ Collection is paused in this chat, so there is nothing new to summarize.\n' +
      'A group admin can run /resume to start it again.',
  },

  find: {
    usage: 'Usage: /find <search term>\nExample: /find deploy schedule',
    prompt: 'Send: /find <search term>',
    noResults: 'No results found for "{query}".',
    header: '🔎 Results for "{query}":',
    unknownAuthor: 'someone',
    noLinkedChats:
      'You are not linked to any group chats yet. Add me to a group to start searching its history.',
  },

  filter: {
    choose: '🎯 Choose the topics you want to follow:',
    saved: 'Filters saved',
    following: '✅ Topics: {categories}',
    keywordsLine: '✏️ Keywords: {keywords}',
    cleared: '✅ Filters cleared — you will receive everything.',
    keywordsButton: '✏️ My keywords ({count})',
    keywordsButtonEmpty: '✏️ Add my own keywords',
    keywordsBackButton: '⬅️ Topics',
    alertsOn: '🔔 Alerts: ON — tap to stop',
    alertsOff: '🔕 Alerts: off — tap to be told when a keyword comes up',
    alertsEnabledShort: 'Alerts on',
    alertsDisabledShort: 'Alerts off',
    alertsExplainer:
      "🔔 I'll DM you when one of these words comes up in a group you're in. " +
      'At most {max} an hour, and never for your own messages.',
    keywordsAddButton: '➕ Add keywords',
    keywordsRemoveButton: '🗑 Remove ({count})',
    keywordsHeader: '✏️ Your keywords',
    keywordsHint:
      'Anything you follow is highlighted in summaries and digests. ' +
      'Endings count too — "release" also finds "releases".\n\n' +
      'Tap one to select it, then 🗑 to remove.',
    keywordsEmpty:
      "✏️ You haven't added any keywords of your own yet.\n\n" +
      'Tap ➕ to follow words the topic filters miss — a project, a person, ' +
      'your product name. They get highlighted in summaries and digests.',
    keywordsAddPrompt:
      '✏️ Send the words you want highlighted.\n\n' +
      'One per line, or separated by commas — for example:\n' +
      'deploy, release notes, Anna\n\n' +
      'Phrases are fine. Up to {max} keywords.',
    keywordsAddCancelled: 'Cancelled — nothing was added.',
    keywordsNothingUseful:
      "I couldn't find any words in that. Send them one per line, or separated by commas.",
    keywordsAdded: '✅ Added: {keywords}',
    keywordsDuplicate: 'Already following: {keywords}',
    keywordsTooLong: 'Skipped, over {max} characters: {keywords}',
    keywordsFull: "You can follow up to {max} keywords, so these didn't fit: {keywords}",
    keywordsFullFree:
      "⭐ The free plan includes {max} keyword, so these didn't fit: {keywords}\n\n" +
      '/subscribe to follow up to {premiumMax}.',
    keywordsAtLimit: "You're already following {max} keywords. Remove one to make room.",
    keywordsFreeLimit:
      '⭐ The free plan includes {max} keyword.\n\n' +
      'You already have one. /subscribe to follow up to {premiumMax}, ' +
      'or swap it for another below.',
    // Phrased with the plan as the subject on purpose: "only the first
    // {allowed} of your {total} keywords are matched" reads as "the first 1 …
    // are" for every free user, which is the common case.
    keywordsSomeLocked:
      '⭐ The free plan matches {allowed} of your {total} keywords. ' +
      'The rest are kept — /subscribe to use all {premiumMax} again.',
    keywordsGroupHint:
      'Your keywords are yours alone — open /filter in a private chat with me to see or change them.',
    keywordsRemoved: '✅ Removed: {keywords}',
    keywordsRemovedShort: 'Removed',
    keywordsNothingSelected: 'Tap a keyword in the list first, then press Remove.',
    keywordsGone: "That keyword isn't in your list any more.",
    categories: {
      Tech: 'Tech',
      Business: 'Business',
      Science: 'Science',
      World: 'World',
      Sports: 'Sports',
    },
  },

  channel: {
    freeLimitReached:
      '⭐ *The free plan includes {max} channel.*\n\n' +
      'You are already following it. /subscribe to follow up to {premiumMax} channels, ' +
      'or swap it out from /channels.',
    blockedLimit:
      '⭐ On the free plan you can summarize your first {max} channel.\n\n' +
      '/subscribe to use all {premiumMax} of yours again.',
    someLocked:
      '⭐ The free plan covers {allowed} of your {total} channels. ' +
      'The rest are kept — /subscribe to use all {premiumMax} again.',
    usage: 'Usage: `/addchannel @channelname`',
    invalidHandle:
      "That doesn't look like a channel. Send its @name or its link — " +
      'for example `@durov` or `https://t.me/durov`.',
    checking: 'Checking @{handle}…',
    unavailable:
      "I can't read *@{handle}*.\n\n" +
      'I can only summarize **public** channels — ones with a @name that anyone can open. ' +
      'Private channels, invite-only groups and user accounts are out of reach.',
    checkFailed: "Couldn't reach Telegram to check that channel. Please try again in a minute.",
    added:
      '✅ Added *{title}* (@{handle}).\n\n' +
      'Run /summary and pick it from the list, or set up a daily /digest for it.',
    alreadyAdded: "You're already following @{handle}.",
    limitReached:
      "You're following the maximum of {max} channels. Remove one from /channels first.",
    removed: '✅ Removed @{handle}.',
    removedShort: 'Removed',
    removedMany: '✅ Removed {handles}.',
    notFollowing: "You're not following @{handle}.",
    empty:
      "📢 You're not following any channels yet.\n\n" +
      'Tap ➕ below to add one — any public channel works.',
    listHeader: '📢 *Channels you follow*',
    listHint: 'Tap a channel to select it, then 🗑 to remove. ➕ adds a new one.',
    addButton: '➕ Add channel',
    removeButton: '🗑 Remove ({count})',
    addPrompt:
      '📢 Send me the channel — its @name or its link, whichever you have at hand.\n\n' +
      'For example `@durov` or `https://t.me/durov`.',
    addCancelled: 'Cancelled — nothing was added.',
    nothingSelected: 'Tap a channel in the list first, then press Remove.',
    gone: "You're not following that channel any more.",
  },

  digest: {
    premiumOnly:
      '⭐ Scheduled daily digests are a premium feature.\n' +
      'Use /subscribe to unlock unlimited summaries and automatic daily digests.',
    premiumOnlyShort: 'Premium feature — /subscribe first',
    statusOn: '🔔 Daily digest is ON for *{chat}* at {time}',
    statusOff: '🔕 Daily digest is OFF for *{chat}*',
    pickTime: 'Pick a time (UTC) to receive a daily DM summary:',
    pickTimezone:
      '🌍 Where are you? Times below will be shown in your own clock instead of UTC.\n\n' +
      'This only changes what you see — a digest already set keeps arriving at the same moment.',
    keepUtc: '🌍 Just use UTC',
    setTimezone: '🌍 Show these times in my timezone',
    changeTimezone: '🌍 Timezone: {zone} — change',
    pickTimeLocal: 'Pick a time to receive a daily DM summary. Times are in your timezone ({zone}):',
    unknownTimezone: 'I did not recognise that option — reopen /digest.',
    pickChat: 'Which chat do you want to configure?',
    turnOff: '🔕 Turn off',
    saved: 'Saved',
    enabled: '✅ Daily digest enabled for this chat at {time}.',
    disabledShort: 'Disabled',
    disabled: '🔕 Daily digest disabled for this chat.',
    dailyHeader: '📅 *Daily digest — {chat}*',
    weeklyHeader: '📅 *Weekly digest — {chat}*',
    switchToWeekly: '📆 Switch to weekly',
    switchToDaily: '📅 Switch back to daily',
    weeklyNote: '📆 Weekly, every {day}. It covers the whole past week.',
    pickTimeFirst: 'Pick a time first, then choose how often.',
    weekday0: 'Sun',
    weekday1: 'Mon',
    weekday2: 'Tue',
    weekday3: 'Wed',
    weekday4: 'Thu',
    weekday5: 'Fri',
    weekday6: 'Sat',
  },

  subscribe: {
    alreadyActive: 'You already have an active *{plan}* subscription until {expires}.',
    // Shown in a Telegram alert and as a pre-checkout decline, both of which
    // are plain text with a tight length limit.
    alreadyActiveShort: 'You are already subscribed until {expires} UTC — no need to pay again.',
    choosePlan: '⭐ Choose a subscription plan (paid with Telegram Stars):',
    unknownPlan: 'Unknown plan',
    planButton: '{label} — {stars} ⭐',
    planMonthly: 'Monthly',
    planYearly: 'Yearly',
    planComp: 'Complimentary',
    planTrial: 'Free trial',
    invoiceTitle: '{label} subscription',
    invoiceDescription: 'Unlock premium features for {days} days.',
    thanks: '✅ Thanks! Your {label} subscription is now active until {expires} UTC.',
  },

  language: {
    choose: '🌐 Choose your language:',
    changed: '✅ Language set to English.',
    current: 'Current: {language}',
  },

  reminder: {
    expiring3d:
      '⭐ Your *{plan}* subscription ends in {days} days, on {expires}.\n\n' +
      'Renew now and nothing changes: unlimited summaries, {premiumChannels} channels, ' +
      'and your daily digest keep running.',
    expiring1d:
      '⏳ Your *{plan}* subscription ends tomorrow, on {expires}.\n\n' +
      'Renew to keep unlimited summaries, {premiumChannels} channels and your daily digest. ' +
      'A new period is added on top of what is left, so renewing early costs you nothing.',
    expired:
      '🔕 Your *{plan}* subscription ended on {expires}, so you are back on the free plan: ' +
      '{freeSummaries} summaries a day, {freeGroups} group, {freeChannels} channel, ' +
      '{freeKeywords} keyword.\n\n' +
      'Nothing was deleted — your groups, channels and keywords are all still there, ' +
      'waiting. Renew and they light up again.',
    renewButton: '⭐ Renew',
    // A trial cannot be renewed, only bought. Same three stages, different ask.
    trial_expiring_3d:
      '⭐ Your free trial has {days} days left, until {expires}.\n\n' +
      'Everything you have set up keeps working if you subscribe: unlimited summaries, ' +
      '{premiumChannels} channels, and your daily digest.',
    trial_expiring_1d:
      '⏳ Your free trial ends tomorrow, on {expires}.\n\n' +
      'Subscribe to keep unlimited summaries, {premiumChannels} channels and daily digests. ' +
      'Nothing you have set up is lost either way.',
    trial_expired:
      '🔕 Your free trial ended on {expires}, so you are on the free plan now: ' +
      '{freeSummaries} summaries a day, {freeGroups} group, {freeChannels} channel, ' +
      '{freeKeywords} keyword.\n\n' +
      'Nothing was deleted — everything you added is still there and comes back the moment you subscribe.',
  },

  moderation: {
    groupOnly: 'Run this inside the group you want to pause.',
    adminsOnly: 'Only an admin of this group can pause or resume collection.',
    alreadyPaused: '⏸ Collection is already paused here.',
    alreadyActive: '▶️ Collection is already running here.',
    paused:
      "⏸ *Paused.* I've stopped storing messages in this chat.\n\n" +
      'What I already stored is kept until it expires normally — pausing is not a deletion. ' +
      'Any admin can run /resume to start again.',
    resumed: "▶️ *Resumed.* I'm storing this chat's messages again. /privacy explains what that means.",
  },

  alerts: {
    match:
      '🔔 *{author}* in *{chat}*:\n\n' +
      '{text}',
    openButton: '↗️ Open the message',
    // The one message that explains the silence, sent once per hour at most.
    muted:
      '🔕 That is {max} keyword alerts this hour, so I will hold the rest until the next one.\n\n' +
      'Too noisy? /filter lets you narrow the words, or switch alerts off entirely.',
  },

  broadcast: {
    // Pre-translated announcements, sent in each recipient's own language.
    // Free text cannot be translated on the way out, and the preview says so.
    templates: {
      maintenance:
        '🔧 *Scheduled maintenance*\n\n' +
        'I will be briefly unavailable while I am updated. Summaries and digests ' +
        'may be delayed for a few minutes. Nothing you have set up is affected.',
      newFeatures:
        "✨ *What's new*\n\n" +
        '📆 Weekly digests, for groups that are not busy every day — /digest\n' +
        '🔔 Keyword alerts: I can DM you when one of your words comes up — /filter\n' +
        '🌍 Digest times in your own timezone, not UTC — /digest\n' +
        '📊 /status shows your plan, usage and limits at a glance',
    },
  },

  feedback: {
    up: '👍 Useful',
    down: '👎 Not useful',
    thanksUp: 'Thanks — noted',
    thanksDown: 'Thanks — noted, I will work on it',
  },

  status: {
    header: '📊 *Where you stand*',
    planFree: '*Plan*: Free',
    planPremium: '*Plan*: {plan} — until {expires}',
    planPremiumNoExpiry: '*Plan*: {plan}',
    summaries: '📝 Summaries today: {used} of {limit}',
    lookback: '⏳ Lookback: up to {hours}h',
    unlimited: 'unlimited',
    trackingHeader: '*What you are tracking*',
    groups: '💬 Groups: {allowed} of {limit}{locked}',
    channels: '📢 Channels: {allowed} of {limit}{locked}',
    keywords: '🎯 Keywords: {allowed} of {limit}{locked}',
    lockedSuffix: ' — 🔒 {count} kept but not active',
    digestHeader: '*Daily digest*',
    digestNone: '🔕 Not set up — /digest to schedule one',
    digestOn: '🔔 *{chat}* at {time}',
    digestOnWeekly: '🔔 *{chat}* — {day} at {time}, weekly',
    digestOff: '🔕 *{chat}* — off',
    // A digest the bot switched off itself. Without saying so, someone who
    // blocked and later unblocked the bot has no way to know why it stopped.
    digestBlocked: '🔕 *{chat}* — off, because you blocked me. /digest turns it back on',
    upsell: '⭐ You are at the edge of the free plan. /subscribe lifts every limit above.',
    subscribeButton: '⭐ Go premium',
    dmOnly: 'Send me /status in a private chat — it shows your own plan and usage.',
  },

  privacy: {
    policy:
      '🔒 *Privacy*\n\n' +
      '*What I store*\n' +
      "• Text messages sent in groups I've been added to, along with the sender's name and timestamp\n" +
      '• Captions written on a photo, video or file — the caption text only, never the file itself\n' +
      '• Your Telegram ID, username and first name\n' +
      '• Your filter keywords, subscription status, and command usage counts\n\n' +
      '*What I do NOT store*\n' +
      '• The photos, files and voice messages themselves — I never download them, only a caption someone typed\n' +
      '• Private (1:1) conversations you have with other people\n' +
      '• Payment card details — payments go through Telegram Stars, I never see them\n\n' +
      '*Where summaries are made*\n' +
      'To write a summary I send the messages from that time window to *DeepSeek*, an AI provider ' +
      'based in China — so that text is processed outside the EU and the UK. Each message goes as ' +
      'the sender name plus the first {groupChars} characters. Nothing else leaves the server: ' +
      '/find searches only my own database, and no ID of yours is attached to the request.\n\n' +
      '*Who sees it*\n' +
      'Summaries are visible to members of that group who ask for them. A summary is cached and ' +
      'shared within the chat; your keyword highlights are worked out for you alone and are never ' +
      "shown in anyone else's summary.\n\n" +
      '*How long*\n' +
      '• Messages are deleted automatically after {retentionDays} days\n' +
      "• If I'm removed from a group, that group's messages are deleted after {purgeDays} days\n" +
      '• A cached summary is dropped as soon as the conversation changes, and deleted with the messages\n\n' +
      '*Your control*\n' +
      '• /forgetme — delete your messages and settings\n' +
      '• Remove me from a group to stop collection there\n' +
      '• Group admins can restrict or remove me at any time',
    nothingStored: 'I have no messages or group links stored for you.',
    currentlyStoring: "📥 *Right now*: I'm storing your messages in the groups I'm in.",
    currentlyOptedOut: "🚫 *Right now*: I'm not storing your messages anywhere.",
    optOutButton: '🚫 Stop storing my messages',
    optInButton: '📥 Start storing my messages again',
    optedOutShort: 'Opted out',
    optedInShort: 'Opted back in',
    optedOut:
      "🚫 Done — I won't store anything you say, in any group, from now on.\n\n" +
      'This does not delete what I already have: /forgetme does that. ' +
      'You can still use every command, and summaries of your groups still work — ' +
      'they just will not include your own messages.',
    optedIn: "📥 Done — I'm storing your messages again in the groups I'm in.",
    offerOptOut:
      'Deleted. Note that I will start storing new messages again as you keep chatting.\n\n' +
      'Want me to stop collecting them altogether?',
    confirmPrompt:
      '⚠️ This will permanently delete:\n\n' +
      '• {messageCount} of your messages{oldest}\n' +
      '• Your links to {chatCount} group(s)\n' +
      '• Your filters, scheduled digests, and usage counters\n\n' +
      'Your subscription record is kept, so billing history and any remaining paid time stay intact.\n\n' +
      'This cannot be undone. Continue?',
    oldestSuffix: ' (oldest from {date})',
    confirmButton: '🗑 Yes, delete my data',
    notYourConfirmation: 'This confirmation is not yours',
    deletedShort: 'Deleted',
    deleted:
      '✅ Deleted {messages} message(s) across {chats} chat(s), along with your filters and settings.\n\n' +
      "Note: if you keep chatting in a group I'm in, I'll start storing new messages again. " +
      'Remove me from the group to stop that.',
    deleteFailedShort: 'Something went wrong',
    deleteFailed: 'Sorry, I could not delete your data right now. Please try again shortly.',
    cancelledShort: 'Cancelled',
    cancelled: 'Cancelled — nothing was deleted.',
  },
};
