import { ButtonStyle, ComponentType, PermissionFlagsBits } from 'discord.js';
import { cash, config, memberFrom, name, panel, reactionKey, UserError } from '../shared.js';

import { auditMove } from '../logger.js';

export const turnMs = config.turnSeconds * 1000;
export const row = (...components) => ({ type: ComponentType.ActionRow, components });
export const button = (id, label, style = ButtonStyle.Secondary) =>
  ({ type: ComponentType.Button, custom_id: id, label, style });
const challengeMs = 30_000;

// Expiry is measured separately from turn time. Serialize countdown edits so
// a slow Discord response cannot overwrite the accepted or expired state.
async function chooseChallenge(board, player, view, deadline) {
  const remaining = () => deadline - Date.now();
  const collector = board.createMessageComponentCollector({
    filter: interaction => remaining() > 0 && interaction.user.id === player
      && ['join', 'decline'].includes(interaction.customId),
    max: 1, time: Math.max(1, remaining())
  });
  const selected = new Promise(resolve => collector.once('end', (entries, reason) =>
    resolve({ interaction: entries.first(), reason })));
  const components = [row(button('join', 'Accept', ButtonStyle.Success), button('decline', 'Decline'))];
  let edit;
  let interval;

  function refresh() {
    if (edit || collector.ended || remaining() <= 0) return;
    edit = board.edit({ ...view(remaining()), components })
      .catch(error => {
        collector.stop('editFailed');
        console.error('Could not edit challenge countdown:', error);
      }).finally(() => { edit = undefined; });
  }

  try {
    refresh();
    interval = setInterval(refresh, 5000);
    const { interaction, reason } = await selected;
    if (interaction) {
      await interaction.deferUpdate();
      auditMove(board.guildId, board.channelId, player, interaction.customId);
      return interaction.customId;
    }
    if (reason !== 'time') throw new Error('Challenge message became unavailable.');
    return null;
  } finally {
    clearInterval(interval);
    collector.stop();
    await edit;
  }
}

export async function playRound(context, title, stakes, play) {
  let ticket;
  let board;
  try {
    ticket = context.bank.reserve(stakes);
    board = await context.message.reply(panel(title, 'Dealing…'));
    // Games settle before writing their final message. If Discord fails after
    // settlement, the result stays recorded and the fallback refund is a no-op.
    await play(board, ticket);
  } finally {
    if (ticket) context.bank.settle(ticket);
  }
}

// Invite one human player and reserve both stakes only after acceptance.
export async function playDuel(context, title, play) {
  const { message, opponents, bet, bank } = context;
  const opponent = await memberFrom(message.guild, opponents);
  if (opponent.id === message.author.id || opponent.user.bot) {
    throw new UserError('Challenge another human server member.');
  }

  const players = [message.member, opponent];
  const description = '**' + name(players[0]) + '** challenged **' + name(opponent)
    + '** for **' + cash(bet) + '** each.';
  if (bank.getUser(players[0].id).balance < bet) throw new UserError('Your balance is too low for that bet.');
  const deadline = (message.createdTimestamp ?? Date.now()) + challengeMs;
  const view = remaining => panel(title, description + '\n\n⏳ **'
    + Math.max(0, Math.ceil(remaining / 1000)) + 's remaining**');
  const board = await message.reply({
    ...view(deadline - Date.now()), content: '<@' + opponent.id + '>',
    allowedMentions: { parse: [], users: [opponent.id], repliedUser: false }
  });

  let ticket;
  try {
    const choice = await chooseChallenge(board, opponent.id, view, deadline);
    if (choice !== 'join') {
      return await board.edit({ ...panel(title, choice ? 'Challenge declined.' : 'Challenge expired.'), content: null });
    }
    await board.edit({ ...panel(title, description), content: null });
    try {
      context.claimPlayer(opponent.id);
      for (const member of players) {
        if (bank.getUser(member.id).balance < bet) {
          throw new UserError(name(member) + ' needs ' + cash(bet) + ' to play.');
        }
      }
      ticket = bank.reserve(Object.fromEntries(players.map(member => [member.id, bet])));
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      return await board.edit(panel(title, error.message));
    }
    await play(board, ticket, players);
  } finally {
    if (ticket) bank.settle(ticket);
  }
}

export function requireReactionPermissions(message, game) {
  const permissions = message.channel.permissionsFor(message.guild.members.me);
  if (!permissions?.has([PermissionFlagsBits.AddReactions, PermissionFlagsBits.ManageMessages])) {
    throw new UserError(game + ' needs Add Reactions and Manage Messages in this channel.');
  }
}

// Reset old reactions before arming the next turn. This also clears reactions
// placed out of turn so the next player can pick the same column.
export async function chooseReaction(board, player, view, actions) {
  if (board.reactions.cache.size) await board.reactions.removeAll();
  const keyOf = value => value?.replaceAll('\uFE0F', '');
  const keys = new Map(actions.map(([action, emoji]) => [keyOf(reactionKey(emoji)), action]));
  const keyFor = entry => keyOf(entry.emoji.id ?? entry.emoji.name);
  const collector = board.createReactionCollector({
    filter: (entry, actor) => actor.id === player && keys.has(keyFor(entry)),
    max: 1, time: turnMs
  });
  const selected = new Promise(resolve => collector.once('end', (entries, reason) =>
    resolve({ entry: entries.first(), reason })));
  try {
    await board.edit(view);
    for (const [, emoji] of actions) {
      if (collector.ended) break;
      await board.react(emoji);
    }
    const { entry, reason } = await selected;
    if (!entry) {
      if (reason !== 'time') throw new Error('Game message became unavailable.');
      return null;
    }
    const action = keys.get(keyFor(entry));
    auditMove(board.guildId, board.channelId, player, action);
    return action;
  } finally {
    collector.stop();
  }
}
