import { ButtonStyle, ComponentType } from 'discord.js';
import { config, panel } from '../shared.js';

export const turnMs = config.turnSeconds * 1000;
export const row = (...components) => ({ type: ComponentType.ActionRow, components });
export const button = (id, label, style = ButtonStyle.Secondary) =>
  ({ type: ComponentType.Button, custom_id: id, label, style });
export const select = (id, placeholder, options, min = 1, max = 1) => ({
  type: ComponentType.StringSelect, custom_id: id, placeholder, options,
  min_values: min, max_values: max
});

// Carry choices forward only after Discord acknowledges the click. The collector
// is installed before sending the edit so an immediate click is still captured.
export async function choose(board, player, view, rows, ids) {
  const collector = board.createMessageComponentCollector({
    filter: interaction => interaction.user.id === player && ids.includes(interaction.customId),
    max: 1, time: turnMs
  });
  const selected = new Promise(resolve => collector.on('end', entries => resolve(entries.first())));
  try {
    await board.edit({ ...view, components: rows });
    const interaction = await selected;
    if (interaction) await interaction.deferUpdate();
    return interaction;
  } finally {
    collector.stop();
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
