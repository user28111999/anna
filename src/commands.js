import { randomInt } from 'node:crypto';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { amount, cash, config, dailyKey, label, memberFrom, name, panel, pick, root, UserError } from './shared.js';
import { change, credit, getUser, user } from './store.js';

import { recentLogs } from './logger.js';

const shop = new Map(Object.entries(config.shop).map(([item, price]) => [label(item), price]));
const itemKey = label;

// Inventory keys are explicitly owned properties, even for names like "constructor".
function addItem(account, item) {
  const key = itemKey(item);
  const existing = Object.hasOwn(account.items, key) ? account.items[key] : null;
  Object.defineProperty(account.items, key, {
    value: { name: existing?.name ?? item, count: (existing?.count ?? 0) + 1 },
    enumerable: true, configurable: true, writable: true
  });
}

function requireAdmin(message) {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    throw new UserError('Only server administrators can use this command.');
  }
}

// Split a leading mention, ID or single-word name from the rest of a command.
function firstWord(input) {
  const [first = '', ...remaining] = input.split(/\s+/);
  return [first, remaining.join(' ')];
}

async function money(message, args) {
  const [action, rest] = firstWord(args);
  if (['add', 'set', 'remove'].includes(action.toLowerCase())) {
    requireAdmin(message);
    const [quantity, target] = firstWord(rest);
    const mode = action.toLowerCase();
    const value = amount(quantity, mode === 'set');
    const member = await memberFrom(message.guild, target);
    const balance = change(draft => {
      const account = user(draft, member.id);
      if (mode === 'set') account.balance = value;
      else credit(account, mode === 'add' ? value : -value);
      return account.balance;
    });
    return message.reply(config.emoji.money + ' **' + name(member) + '** now has **' + cash(balance) + '**.');
  }
  const member = args ? await memberFrom(message.guild, args) : message.member;
  return message.reply(config.emoji.money + ' **' + name(member) + '** has **' + cash(getUser(member.id).balance) + '**.');
}

async function daily(message) {
  const today = dailyKey();
  const dailySettings = config.daily;
  const lootbox = change(draft => {
    const account = user(draft, message.author.id);
    if (account.daily === today) {
      const hour = String(dailySettings.resetHour).padStart(2, '0');
      throw new UserError('Already claimed. Daily resets at ' + hour + ':00 (' + dailySettings.timezone + ').');
    }
    credit(account, dailySettings.amount);
    account.daily = today;
    const dropped = Math.random() < dailySettings.lootboxChance;
    if (dropped) account.lootboxes++;
    return dropped;
  });
  return message.reply(config.emoji.money + ' Claimed **' + cash(dailySettings.amount) + '**.'
    + (lootbox ? ' ' + config.emoji.lootbox + ' You also found a lootbox!' : ''));
}

async function lootbox(message) {
  const reward = change(draft => {
    const account = user(draft, message.author.id);
    if (!account.lootboxes) throw new UserError('You have no lootboxes.');
    account.lootboxes--;
    if (config.lootbox.items.length && randomInt(2) === 0) {
      const item = pick(config.lootbox.items);
      addItem(account, item);
      return item;
    }
    credit(account, config.lootbox.money);
    return cash(config.lootbox.money);
  });
  return message.reply(config.emoji.lootbox + ' You opened a lootbox and found **' + reward + '**.');
}

async function inventory(message, args) {
  const member = args ? await memberFrom(message.guild, args) : message.member;
  const account = getUser(member.id);
  const rows = Object.values(account.items).map(item => '• ' + item.name + ' × ' + item.count);
  const summary = [config.emoji.money + ' ' + cash(account.balance),
    config.emoji.lootbox + ' Lootboxes × ' + account.lootboxes, ...rows].join('\n');
  // Send a readable text attachment if an edited item list exceeds Discord's embed limit.
  if (summary.length > 4096) {
    return message.reply({ content: 'Inventory for **' + name(member) + '**',
      files: [{ attachment: Buffer.from(summary), name: 'inventory.txt' }] });
  }
  return message.reply(panel('Inventory • ' + name(member), summary));
}

async function shopCommand(message, args) {
  if (!args) {
    const listing = Object.entries(config.shop).map(([item, price]) => '• **' + item + '** • ' + cash(price));
    return message.reply(panel('Shop', listing.join('\n') + '\n\nBuy with `' + config.prefix + ' shop buy <item>`.'));
  }
  const [action, item] = firstWord(args);
  if (action.toLowerCase() !== 'buy' || !shop.has(itemKey(item))) {
    throw new UserError('Use ' + config.prefix + ' shop buy <item from the shop>.');
  }
  const key = itemKey(item);
  const title = Object.keys(config.shop).find(entry => itemKey(entry) === key);
  change(draft => {
    const account = user(draft, message.author.id);
    credit(account, -shop.get(key));
    addItem(account, title);
  });
  return message.reply('Bought **' + title + '** for **' + cash(shop.get(key)) + '**.');
}

async function give(message, args) {
  const [target, item] = firstWord(args);
  if (!target || !item) throw new UserError('Use ' + config.prefix + ' give <@member> <item>.');
  const recipient = await memberFrom(message.guild, target);
  if (recipient.id === message.author.id || recipient.user.bot) {
    throw new UserError('Choose another human server member.');
  }
  const transferred = change(draft => {
    const account = user(draft, message.author.id);
    const key = itemKey(item);
    if (!Object.hasOwn(account.items, key)) throw new UserError('You do not own that item.');
    const entry = account.items[key];
    if (--entry.count === 0) delete account.items[key];
    addItem(user(draft, recipient.id), entry.name);
    return entry.name;
  });
  return message.reply('**' + name(message.member) + '** gave **' + transferred + '** to **'
    + name(recipient) + '**.');
}

async function prompt(message, args, kind) {
  const file = new URL(kind + '.txt', root);
  const addition = args.match(/^add(?:\s+([\s\S]*))?$/i);
  if (addition) {
    requireAdmin(message);
    const line = addition[1]?.replace(/\s+/g, ' ').trim();
    if (!line || line.length > 1500) throw new UserError('Enter a prompt of 1–1,500 characters.');
    // A leading newline also works when the hand-edited file lacks a final newline.
    await appendFile(file, '\n' + line + '\n', 'utf8');
    return message.reply('Added a new ' + kind + '.');
  }
  const target = args ? await memberFrom(message.guild, args) : null;
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new UserError('There are no prompts in ' + kind + '.txt.');
  const title = target ? name(message.member) + ' → ' + name(target) : name(message.member);
  const description = pick(lines).slice(0, 4096);
  return message.reply({
    ...panel((kind === 'dare' ? 'Dare' : 'Truth') + ' • ' + title, description),
    content: target ? '<@' + target.id + '>' : undefined,
    allowedMentions: { users: target ? [target.id] : [], repliedUser: false }
  });
}

// Discord-friendly still-image formats. The container checks reject APNG,
// animated WebP and animated AVIF, even when they have their usual extensions.
const stillExtensions = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.webp', '.avif', '.bmp', '.ico', '.tif', '.tiff']);
function hasChunk(buffer, start, animated, png) {
  const headerSize = png ? 12 : 8;
  for (let offset = start; offset + headerSize <= buffer.length;) {
    const typeOffset = offset + (png ? 4 : 0);
    if (buffer.toString('ascii', typeOffset, typeOffset + 4) === animated) return true;
    const size = png ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset + 4);
    offset += headerSize + size + (png ? 0 : size % 2);
  }
  return false;
}

function isAnimatedAvif(buffer) {
  // AVIF brands are four-byte identifiers inside the file type box.
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const end = Math.min(buffer.length, buffer.readUInt32BE(0));
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    if (offset !== 12 && buffer.toString('ascii', offset, offset + 4) === 'avis') return true;
  }
  return false;
}

async function media(message, kind) {
  const folder = new URL(kind + '/', root);
  const files = (await readdir(folder, { withFileTypes: true })).filter(file =>
    file.isFile() && (kind === 'gif' ? extname(file.name).toLowerCase() === '.gif'
      : stillExtensions.has(extname(file.name).toLowerCase())));
  // Try candidates in random order until we find a suitable file.
  while (files.length) {
    const [file] = files.splice(randomInt(files.length), 1);
    const extension = extname(file.name).toLowerCase();
    const data = await readFile(new URL(encodeURIComponent(file.name), folder));
    if (extension === '.png' && hasChunk(data, 8, 'acTL', true)) continue;
    if (extension === '.webp' && hasChunk(data, 12, 'ANIM', false)) continue;
    if (extension === '.avif' && isAnimatedAvif(data)) continue;
    try {
      return await message.reply({ files: [{ attachment: data, name: file.name }] });
    } catch (error) {
      if (error.status !== 413 && error.code !== 40005) throw error;
    }
  }
  throw new UserError('No uploadable ' + (kind === 'gif' ? 'GIFs' : 'still images') + ' in ' + kind + '/.');
}

async function logs(message) {
  requireAdmin(message);
  let attachment;
  try {
    attachment = await recentLogs(message.guildId);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return message.reply('No logs for this server yet.');
  }
  return message.reply({ content: 'Recent log entries for this server (up to 512 KiB).',
    files: [{ attachment, name: 'anna.log' }] });
}

async function fuck(message, args) {
  if (!args) return message.reply('Fuck you!');
  const member = await memberFrom(message.guild, args);
  return message.reply({ content: 'Fuck <@' + member.id + '>!',
    allowedMentions: { parse: [], users: [member.id], repliedUser: false } });
}

export const commands = {
  money, daily, lootbox, inventory, give, logs, fuck, shop: shopCommand,
  gif: message => media(message, 'gif'),
  img: message => media(message, 'img'),
  dare: (message, args) => prompt(message, args, 'dare'),
  truth: (message, args) => prompt(message, args, 'truth'),
  persona: message => message.reply('Persona is a work in progress.')
};

export const helpLines = [
  'help', 'money [@member]', 'money <add|set|remove> <amount> <@member> (admin)',
  'gif', 'img', 'daily', 'lootbox', 'shop [buy <item>]', 'inventory [@member]', 'fuck [@member]', 'logs (admin)',
  'give <@member> <item>', 'dare [@member]', 'truth [@member]',
  'dare add <dare> (admin)', 'truth add <question> (admin)', 'persona'
];
