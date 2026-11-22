import { randomInt } from 'node:crypto';
import { parseEmoji } from 'discord.js';
import settings from '../config.json' with { type: 'json' };

// Keep the settings next to package.json so the working directory does not matter.
export const root = new URL('../', import.meta.url);
export const config = settings;

if (!/^\S+$/.test(config.prefix || '') || typeof config.prefix !== 'string') {
  throw new Error('config.json needs a single non-empty word for prefix.');
}
if (typeof config.currency !== 'string' || !config.currency.trim() || config.currency.length > 60) {
  throw new Error('Set currency to a non-empty string of up to 60 characters.');
}

// Catch invalid economy settings before they can damage a saved balance.
const isAmount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
if (!isAmount(config.daily.amount) || !isAmount(config.lootbox.money)
    || !Object.values(config.shop).every(isAmount)) {
  throw new Error('Daily, lootbox and shop amounts must be whole numbers from 0 to 1,000,000,000.');
}
if (!Number.isInteger(config.daily.resetHour) || config.daily.resetHour < 0 || config.daily.resetHour > 23
    || typeof config.daily.lootboxChance !== 'number' || config.daily.lootboxChance < 0 || config.daily.lootboxChance > 1
    || !Number.isInteger(config.turnSeconds) || config.turnSeconds < 1 || config.turnSeconds > 3600) {
  throw new Error('Check resetHour (0–23), lootboxChance (0–1) and turnSeconds (1–3,600).');
}
if (!Array.isArray(config.lootbox.items)
    || !config.lootbox.items.every(item => typeof item === 'string' && item.trim() && item.length <= 100)) {
  throw new Error('Lootbox items must be an array of names with up to 100 characters per item.');
}

const dailyClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.daily.timezone, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', hourCycle: 'h23'
});

// Before the reset hour, a claim still belongs to the previous local calendar day.
// Subtracting from the calendar date keeps the reset correct across daylight saving.
export function dailyKey(now = new Date()) {
  const parts = Object.fromEntries(dailyClock.formatToParts(now).map(part => [part.type, part.value]));
  const day = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  const offset = +parts.hour < config.daily.resetHour ? 86_400_000 : 0;
  return new Date(day - offset).toISOString().slice(0, 10);
}

export class UserError extends Error {}

export function amount(value, allowZero = false) {
  const number = Number(value);
  if (!/^\d+$/.test(value ?? '') || number > 1_000_000_000 || number < (allowZero ? 0 : 1)) {
    throw new UserError('Enter a whole amount between ' + (allowZero ? 0 : 1) + ' and 1,000,000,000.');
  }
  return number;
}

export const cash = number => number.toLocaleString('en-US') + ' ' + config.currency;
export const name = member => member.displayName;
export const pick = entries => entries[randomInt(entries.length)];
export const label = input => input.trim().replace(/\s+/g, ' ').toLowerCase();

// Shuffle in place using Fisher–Yates. Never sort by a random comparator.
export function shuffle(cards) {
  for (let index = cards.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [cards[index], cards[other]] = [cards[other], cards[index]];
  }
  return cards;
}

export function panel(title, description) {
  return { embeds: [{ title, description, color: 0x5865f2 }], components: [] };
}

export function reactionKey(emoji) {
  const parsed = parseEmoji(emoji);
  return parsed.id ?? parsed.name;
}

// Match mentions and IDs exactly. Names are convenient but must be unambiguous.
export async function memberFrom(guild, input) {
  if (!input?.trim()) throw new UserError('Specify a server member.');
  const id = input.match(/^(?:<@!?(\d{17,20})>|(\d{17,20}))$/);
  if (id) {
    try {
      return await guild.members.fetch(id[1] ?? id[2]);
    } catch (error) {
      if (error.code !== 10007 && error.code !== 10013) throw error;
      throw new UserError('That person is not a member of this server.');
    }
  }
  const result = await guild.members.search({ query: input, limit: 100 });
  const matches = result.filter(member =>
    [member.displayName, member.user.username].some(value => label(value) === label(input)));
  if (matches.size === 1) return matches.first();
  throw new UserError('Use a Discord mention for that member.');
}
