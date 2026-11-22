import { appendFileSync, mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { format } from 'node:util';
import { root } from './shared.js';

const directory = new URL('logs/', root);
mkdirSync(directory, { recursive: true });
const session = new URL('session-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.log', directory);
const guildFile = guildId => new URL('guild-' + guildId + '.log', directory);
const writeTerminal = console.log.bind(console);
const writeError = console.error.bind(console);

function record(type, details, guildId) {
  const secret = process.env.DISCORD_TOKEN;
  const data = JSON.stringify({ time: new Date().toISOString(), type, ...details });
  const line = secret ? data.replaceAll(secret, '[redacted]') : data;
  (type === 'error' ? writeError : writeTerminal)(line);
  try {
    appendFileSync(session, line + '\n', { mode: 0o600 });
    if (guildId) appendFileSync(guildFile(guildId), line + '\n', { mode: 0o600 });
  } catch (error) {
    // A logging failure is visible in the terminal and must never change a wager.
    writeError('Cannot write Anna log: ' + error.message);
  }
}

export function captureConsole() {
  for (const [method, type] of [['log', 'info'], ['warn', 'warning'], ['error', 'error']]) {
    console[method] = (...values) => record(type, { text: format(...values) });
  }
}

export function auditCommand(message) {
  record('command', { guild: message.guildId, channel: message.channelId,
    actor: message.author.id, displayName: message.member.displayName, text: message.content }, message.guildId);
}

export function auditMove(guild, channel, actor, action) {
  record('game action', { guild, channel, actor, action }, guild);
}

function auditOutput(message, method, payload, privateOutput) {
  const details = typeof payload === 'string' ? { text: payload } : {
    text: payload?.content, embeds: payload?.embeds, components: payload?.components,
    files: payload?.files?.map(file => file.name === 'inventory.txt'
      ? { name: file.name, text: file.attachment.toString('utf8') }
      : { name: file.name ?? '(attachment)' })
  };
  record('output', { guild: message.guildId, channel: message.channelId, method,
    ...(privateOutput ? { private: true } : details) }, message.guildId);
}

// Wrap only the reply/edit methods used by Anna. Bind everything else to Discord's
// real objects, so collectors and message methods still have their expected receiver.
export function loggedMessage(message) {
  function wrap(target, method) {
    return new Proxy(target, {
      get(object, key) {
        if (key === method) return async payload => {
          const result = await object[method](payload);
          auditOutput(message, method, payload, false);
          return method === 'reply' ? wrap(result, 'edit') : result;
        };
        const value = Reflect.get(object, key, object);
        return typeof value === 'function' ? value.bind(object) : value;
      }
    });
  }
  return wrap(message, 'reply');
}

export async function privateReply(interaction, payload) {
  await interaction.reply(payload);
  // Private game information stays private even when an opponent is a server admin.
  auditOutput(interaction, 'interaction reply', payload, true);
}

// Read only a bounded tail and discard any partial first line. Guild logs are
// isolated so an admin can never retrieve another server's command history.
export async function recentLogs(guildId) {
  const file = await open(guildFile(guildId), 'r');
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 512 * 1024);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const data = buffer.subarray(0, bytesRead);
    return start ? data.subarray(data.indexOf(10) + 1) : data;
  } finally {
    await file.close();
  }
}
