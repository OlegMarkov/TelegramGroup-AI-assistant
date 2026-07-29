module.exports = {
  languageName: 'English',
  // Passed to the DeepSeek prompt, so it must be the language's English name.
  aiPromptLanguage: 'English',

  menu: {
    summary: '📝 Summary',
    find: '🔎 Find',
    filters: '🎯 Filters',
    digest: '📅 Digest',
    subscribe: '⭐ Subscribe',
    language: '🌐 Language',
    privacy: '🔒 Privacy',
  },

  common: {
    notAuthorizedForChat: 'Not authorized for this chat',
    noLinkedChats: 'You are not linked to any group chats yet. Add me to a group to get started.',
    cancel: 'Cancel',
    done: 'Done',
    chatFallback: 'Chat {id}',
  },

  start: {
    greeting:
      "👋 Hi {name}! I'm your AI assistant bot for busy group chats.\n\n" +
      'Add me to a group to get started, then:\n' +
      '📝 /summary [hours] — AI summary of recent activity (free: {freeSummaries}/day, up to {freeHours}h)\n' +
      "🔎 /find <query> — search that group's message history\n" +
      '🎯 /filter — pick keywords/topics to get highlighted in summaries\n' +
      '📅 /digest — premium: automatic daily digest sent to your DM\n' +
      '⭐ /subscribe — unlimited summaries, longer lookback, and daily digests\n' +
      '🌐 /language — change language\n' +
      '🔒 /privacy — what I store and how to delete it\n\n' +
      "You can also run these commands here in DM once you've linked a group.",
  },

  onboarding: {
    joined:
      '👋 Thanks for adding me!\n\n' +
      "📋 *Heads up, everyone*: from now on I store this chat's text messages " +
      '(sender name + timestamp) so I can generate summaries and let you search history. ' +
      'Message text is sent to the DeepSeek API to write those summaries, and is deleted ' +
      'automatically after {retentionDays} days.\n\n' +
      'Run /privacy for the full details, or /forgetme to delete your own data at any time. ' +
      'Admins can remove me to stop collection entirely.\n\n' +
      '⚠️ For me to see all messages (not just replies/mentions), whoever owns this bot must ' +
      'disable privacy mode via @BotFather → /setprivacy → Disable.\n\n' +
      'Then use /summary here anytime, or message me privately to pick this chat from your list.',
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
    noActivity: 'No activity in the last {hours}h to summarize.',
    header: '📝 *Summary — last {hours}h*',
    pickChat: 'Which chat do you want summarized?',
    hiddenGroupsNote:
      "ℹ️ You're active in {total} groups, but the free plan only works in {allowed}. " +
      '⭐ /subscribe to unlock the rest.',
    highlightsHeader: '🔔 *Matches your filters*',
  },

  find: {
    usage: 'Usage: /find <search term>\nExample: /find deploy schedule',
    prompt: 'Send: /find <search term>',
    noResults: 'No results found for "{query}".',
    header: '🔎 Results for "{query}":',
    noLinkedChats:
      'You are not linked to any group chats yet. Add me to a group to start searching its history.',
  },

  filter: {
    choose: '🎯 Choose the topics you want to follow:',
    saved: 'Filters saved',
    following: '✅ Following: {categories}',
    cleared: '✅ Filters cleared — you will receive everything.',
    categories: {
      Tech: 'Tech',
      Business: 'Business',
      Science: 'Science',
      World: 'World',
      Sports: 'Sports',
    },
  },

  digest: {
    premiumOnly:
      '⭐ Scheduled daily digests are a premium feature.\n' +
      'Use /subscribe to unlock unlimited summaries and automatic daily digests.',
    premiumOnlyShort: 'Premium feature — /subscribe first',
    statusOn: '🔔 Daily digest is ON for *{chat}* at {time}',
    statusOff: '🔕 Daily digest is OFF for *{chat}*',
    pickTime: 'Pick a time (UTC) to receive a daily DM summary:',
    pickChat: 'Which chat do you want to configure?',
    turnOff: '🔕 Turn off',
    saved: 'Saved',
    enabled: '✅ Daily digest enabled for this chat at {time}.',
    disabledShort: 'Disabled',
    disabled: '🔕 Daily digest disabled for this chat.',
    dailyHeader: '📅 *Daily digest — {chat}*',
  },

  subscribe: {
    alreadyActive: 'You already have an active *{plan}* subscription until {expires}.',
    choosePlan: '⭐ Choose a subscription plan (paid with Telegram Stars):',
    unknownPlan: 'Unknown plan',
    planButton: '{label} — {stars} ⭐',
    planMonthly: 'Monthly',
    planYearly: 'Yearly',
    invoiceTitle: '{label} subscription',
    invoiceDescription: 'Unlock premium features for {days} days.',
    thanks: '✅ Thanks! Your {label} subscription is now active until {expires} UTC.',
  },

  language: {
    choose: '🌐 Choose your language:',
    changed: '✅ Language set to English.',
    current: 'Current: {language}',
  },

  privacy: {
    policy:
      '🔒 *Privacy*\n\n' +
      '*What I store*\n' +
      "• Text messages sent in groups I've been added to, along with the sender's name and timestamp\n" +
      '• Your Telegram ID, username and first name\n' +
      '• Your filter keywords, subscription status, and command usage counts\n\n' +
      '*What I do NOT store*\n' +
      '• Photos, files, voice messages, or any non-text content\n' +
      '• Private (1:1) conversations you have with other people\n' +
      '• Payment card details — payments go through Telegram Stars, I never see them\n\n' +
      '*Who sees it*\n' +
      'Message text is sent to the DeepSeek API to generate summaries. Summaries are visible ' +
      'to members of that group who ask for them. Nobody else has access.\n\n' +
      '*How long*\n' +
      '• Messages are deleted automatically after {retentionDays} days\n' +
      "• If I'm removed from a group, that group's messages are deleted after {purgeDays} days\n\n" +
      '*Your control*\n' +
      '• /forgetme — delete your messages and settings\n' +
      '• Remove me from a group to stop collection there\n' +
      '• Group admins can restrict or remove me at any time',
    nothingStored: 'I have no messages or group links stored for you.',
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
