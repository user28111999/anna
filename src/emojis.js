// The ready handler fetches application emojis into discord.js's cache.
// Unlike guild emojis, these belong to the bot and work across its servers.
export function appEmoji(application, key, fallback) {
  return application?.emojis?.cache.find(emoji => emoji.name === key)?.toString() ?? fallback;
}
