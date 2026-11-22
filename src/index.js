import { readdir } from 'node:fs/promises';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { commands, helpLines } from './commands.js';
import * as bank from './store.js';
import { amount, config, panel, UserError } from './shared.js';
import { auditCommand, captureConsole, loggedMessage } from './logger.js';

captureConsole();

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

let emojiReady;
client.once(Events.ClientReady, ready => {
  console.log('Ready as ' + ready.user.tag + ' • prefix ' + config.prefix);
  emojiReady = ready.application.emojis.fetch()
    .catch(error => console.warn('Application emoji fetch failed. Using fallback symbols.', error.message));
});

const active = new Set();
client.on(Events.MessageCreate, async incoming => {
  if (incoming.author.bot || !incoming.inGuild() || !incoming.member) return;
  // Bare logs is the sole unprefixed shortcut.
  const content = incoming.content.trim();
  const input = /^logs$/i.test(content) ? config.prefix + ' logs' : content;
  const parsed = input.match(/^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/);
  if (!parsed || parsed[1].toLowerCase() !== config.prefix.toLowerCase()) return;
  const message = loggedMessage(incoming);
  const command = parsed[2].toLowerCase();
  const args = parsed[3]?.trim() ?? '';
  const game = games.get(command);
  const participants = [];
  auditCommand(message);

  function claimPlayer(id) {
    if (active.has(id)) throw new UserError(id === message.author.id
      ? 'Finish your current game first.' : 'That player is already in a game.');
    active.add(id);
    participants.push(id);
  }

  try {
    if (command === 'help') {
      const lines = [...helpLines, ...Array.from(games.values(), entry => entry.usage)];
      return await message.reply(panel('Commands', lines.map(line => '`' + config.prefix + ' ' + line + '`').join('\n')
        + '\n\nUse `all` in place of a bet amount. Administrators can also type `logs` by itself.'));
    }
    if (Object.hasOwn(commands, command)) return await commands[command](message, args);
    if (!game) return;
    if (game.move && await game.move(message, args)) return;
    const [rawBet, ...opponent] = args.split(/\s+/);
    if (!rawBet) throw new UserError('Missing bet amount. Use ' + config.prefix + ' ' + game.usage + '.');
    if (opponent.length && !game.acceptsOpponent) throw new UserError('Use ' + config.prefix + ' ' + game.usage + '.');
    if (game.requiresOpponent && !opponent.length) {
      throw new UserError('Mention an opponent. Use ' + config.prefix + ' ' + game.usage + '.');
    }
    const allIn = rawBet.toLowerCase() === 'all';
    const bet = allIn ? bank.getUser(message.author.id).balance : amount(rawBet);
    if (!bet) throw new UserError('You have no ' + config.currency + ' to bet.');
    if (bet > Math.floor(Number.MAX_SAFE_INTEGER / (game.maxReturn ?? 2))) {
      throw new UserError('That stake exceeds the supported payout limit.');
    }
    claimPlayer(message.author.id);
    await emojiReady;
    await game.run({ message, bet, opponents: opponent.join(' '), bank, claimPlayer });
  } catch (error) {
    if (!(error instanceof UserError)) console.error(error);
    const reason = error instanceof UserError ? error.message : 'This command could not be completed.';
    const reply = game ? panel('🎮 ' + command, reason) : reason;
    await message.reply(reply).catch(replyError => console.error(replyError));
  } finally {
    for (const id of participants) active.delete(id);
  }
});

client.on(Events.Error, console.error);

// A single process owns the JSON save. Interrupted rounds are refunded on startup.
try {
  bank.recoverGames();
  await client.login(token);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  client.destroy();
}
