import { readdir } from 'node:fs/promises';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { commands, helpLines } from './commands.js';
import * as bank from './store.js';
import { amount, config, panel, UserError } from './shared.js';

// Add or remove a file in this directory to register or unregister a game.
// Helper modules have no command export and are ignored.
const modules = new URL('./games/', import.meta.url);
const games = new Map();
for (const file of (await readdir(modules)).filter(file => file.endsWith('.js')).sort()) {
  const game = await import(new URL(file, modules));
  if (!game.command) continue;
  if (games.has(game.command) || Object.hasOwn(commands, game.command) || game.command === 'help') {
    throw new Error('Duplicate command: ' + game.command);
  }
  games.set(game.command, game);
}

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Set DISCORD_TOKEN in .env first. See .env.example and README.md.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Reaction],
  allowedMentions: { parse: [], repliedUser: false }
});

client.once(Events.ClientReady, ready => {
  console.log('Ready as ' + ready.user.tag + ' • prefix ' + config.prefix);
});

const active = new Set();
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.inGuild() || !message.member) return;
  const parsed = message.content.trim().match(/^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/);
  if (!parsed || parsed[1].toLowerCase() !== config.prefix.toLowerCase()) return;
  const command = parsed[2].toLowerCase();
  const args = parsed[3]?.trim() ?? '';
  const game = games.get(command);
  let inGame = false;

  try {
    if (command === 'help') {
      const lines = [...helpLines, ...Array.from(games.values(), entry => entry.usage)];
      return await message.reply(panel('Commands', lines.map(line => '`' + config.prefix + ' ' + line + '`').join('\n')));
    }
    if (Object.hasOwn(commands, command)) return await commands[command](message, args);
    if (!game) return;
    if (game.move && await game.move(message, args)) return;
    const [rawBet, ...opponent] = args.split(/\s+/);
    if (!rawBet) throw new UserError('Missing bet amount. Use ' + config.prefix + ' ' + game.usage + '.');
    if (opponent.length && !game.acceptsOpponent) throw new UserError('Use ' + config.prefix + ' ' + game.usage + '.');
    const bet = amount(rawBet);
    if (active.has(message.author.id)) throw new UserError('Finish your current game first.');
    active.add(message.author.id);
    inGame = true;
    await game.run({ message, bet, opponents: opponent.join(' '), bank });
  } catch (error) {
    if (!(error instanceof UserError)) console.error(error);
    const reason = error instanceof UserError ? error.message : 'This command could not be completed.';
    const reply = game ? panel('🎮 ' + command, reason) : reason;
    await message.reply(reply).catch(replyError => console.error(replyError));
  } finally {
    if (inGame) active.delete(message.author.id);
  }
});

client.on(Events.Error, console.error);

// A single process owns the JSON save. Interrupted rounds are refunded on startup.
bank.recoverGames();
await client.login(token);
