import { privateReply } from '../logger.js';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { cash, config, memberFrom, name, panel, shuffle, UserError } from '../shared.js';
import { button, choose, row, turnMs } from './controls.js';

export const command = 'uno';
export const usage = 'uno <bet> [@opponent]';
export const acceptsOpponent = true;
const colors = ['red', 'yellow', 'green', 'blue'];
const waiting = new Map();

const cardText = card => config.emoji.colors[card.color] + ' ' + card.value;
const matches = (card, top, color) =>
  card.color === 'wild' || card.color === color || card.value === top.value;

// This color-matching variant deals six cards, has two house action cards,
// and uses eight numbered cards in each color.
function makeDeck() {
  const cards = colors.flatMap(color =>
    ['1', '2', '3', '4', '5', '6', '7', '8', 'Swap', 'Draw 1'].map(value => ({ color, value })));
  cards.push(...colors.map(() => ({ color: 'wild', value: 'Shift' })));
  return shuffle(cards);
}

function draw(deck, discard) {
  if (!deck.length && discard.length > 1) {
    deck.push(...shuffle(discard.splice(0, discard.length - 1)));
  }
  return deck.pop();
}

const handView = hand => hand.map((card, index) => (index + 1) + '. ' + cardText(card)).join('\n').slice(0, 4096);

async function humanTurn(board, view, table, turn, top, color) {
  const player = table[turn];
  let timer;
  let cancel;
  // Commands only consume the turn if valid. The channel and player ID must both match.
  const action = new Promise(resolve => {
    cancel = () => resolve(null);
    timer = setTimeout(cancel, turnMs);
    waiting.set(board.channelId, {
      player: player.id,
      submit(args) {
        const [verb, index, chosenColor, extra] = args.toLowerCase().split(/\s+/);
        if (verb === 'draw' && !index) {
          resolve({ verb });
        } else if (verb === 'play' && /^\d+$/.test(index ?? '') && !extra) {
          const position = Number(index) - 1;
          const card = player.hand[position];
          if (!card || !matches(card, top, color)) throw new UserError('Choose a matching card number from your hand.');
          if (card.color === 'wild' && !colors.includes(chosenColor)) {
            throw new UserError('Choose red, yellow, green, or blue after the card number.');
          }
          if (card.color !== 'wild' && chosenColor) throw new UserError('Only Shift takes a color argument.');
          resolve({ verb, position, color: chosenColor });
        } else {
          throw new UserError('Use ' + config.prefix + ' uno play <card number> [color], or ' + config.prefix + ' uno draw.');
        }
        waiting.delete(board.channelId);
      }
    });
  });

  const handCollector = board.createMessageComponentCollector({
    filter: interaction => interaction.customId === 'uno-hand' && table.some(entry => entry.id === interaction.user.id),
    time: turnMs
  });
  handCollector.once('end', cancel);
  handCollector.on('collect', interaction => {
    const viewer = table.find(entry => entry.id === interaction.user.id);
    privateReply(interaction, { ...panel('Your hand', handView(viewer.hand)), flags: MessageFlags.Ephemeral })
      .catch(error => console.error('Could not show UNO hand:', error));
  });
  try {
    await board.edit({ ...view, components: [row(button('uno-hand', 'View my hand', ButtonStyle.Primary))] });
    return await action;
  } finally {
    waiting.delete(board.channelId);
    clearTimeout(timer);
    handCollector.stop();
  }
}

// Route text moves separately from the game-start command.
export async function move(message, args) {
  if (!/^(play|draw)(\s|$)/i.test(args)) return false;
  const turn = waiting.get(message.channelId);
  if (!turn) throw new UserError('There is no active UNO turn in this channel.');
  if (turn.player !== message.author.id) throw new UserError('It is not your turn.');
  turn.submit(args);
  return true;
}

const occupied = new Set();

export async function run(context) {
  const { message, bet, bank, opponents } = context;
  if (occupied.has(message.channelId)) throw new UserError('This channel already has an UNO table.');
  occupied.add(message.channelId);
  let board;
  let ticket;
  try {
    const foe = opponents ? await memberFrom(message.guild, opponents) : null;
    if (foe && (foe.user.bot || foe.id === message.author.id)) {
      throw new UserError('Challenge another human server member.');
    }
    const title = config.emoji.uno + ' UNO • Color Match';
    const table = [
      { id: message.author.id, name: name(message.member), hand: [] },
      { id: foe?.id, name: foe ? name(foe) : 'Bot', hand: [] }
    ];
    const stakes = { [table[0].id]: bet };
    if (foe) stakes[foe.id] = bet;
    if (bank.getUser(table[0].id).balance < bet) throw new UserError('Your balance is too low for that bet.');
    board = await message.reply({
      ...panel(title, foe ? '**' + table[0].name + '** challenged **' + table[1].name
        + '** for ' + cash(bet) + ' each.' : 'Dealing a solo round…'),
      content: foe ? '<@' + foe.id + '>' : undefined,
      allowedMentions: { users: foe ? [foe.id] : [], repliedUser: false }
    });
    if (foe) {
      const invite = panel(title, '**' + table[0].name + '** challenged **' + table[1].name
        + '** for ' + cash(bet) + ' each.');
      const choice = await choose(board, foe.id, invite,
        [row(button('join', 'Accept', ButtonStyle.Success), button('decline', 'Decline'))], ['join', 'decline']);
      if (choice?.customId !== 'join') {
        return await board.edit(panel(title, choice ? 'Challenge declined.' : 'Challenge expired.'));
      }
    }
    try {
      if (foe && bank.getUser(foe.id).balance < bet) {
        throw new UserError(name(foe) + ' has too little ' + config.currency + ' to accept this bet.');
      }
      if (foe) context.claimPlayer?.(foe.id);
      ticket = bank.reserve(stakes);
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      return await board.edit(panel(title, error.message));
    }

    const deck = makeDeck();
    for (const entry of table) entry.hand = deck.splice(-6);
    // Start on a number card so the opening discard never applies an action.
    const first = deck.findIndex(card => /^\d$/.test(card.value));
    const discard = deck.splice(first, 1);
    let color = discard[0].color;
    let turn = 0;
    let winner;
    let history = 'Round started.';
    for (let step = 0; step < 300; step++) {
      const player = table[turn];
      const other = table[1 - turn];
      const top = discard.at(-1);
      let action;
      if (player.id) {
        const view = panel(title, '**Top card** • ' + cardText(top) + '\n**Color** • ' + color
          + '\n**Turn** • ' + player.name + '\n\n' + table.map(entry =>
            '**' + entry.name + '** • ' + entry.hand.length + ' card(s)').join('\n')
          + '\n\n' + history + '\n\n`' + config.prefix + ' uno play <card number> [color]` or `'
          + config.prefix + ' uno draw`');
        action = await humanTurn(board, view, table, turn, top, color);
      } else {
        const position = player.hand.findIndex(card => matches(card, top, color));
        const preferred = [...colors].sort((a, b) =>
          player.hand.filter(card => card.color === b).length - player.hand.filter(card => card.color === a).length)[0];
        action = position < 0 ? { verb: 'draw' } : { verb: 'play', position, color: preferred };
      }
      if (!action) {
        winner = other;
        history = player.name + ' timed out.';
        break;
      }
      if (action.verb === 'draw') {
        const card = draw(deck, discard);
        if (!card) break;
        player.hand.push(card);
        history = player.name + ' drew a card and passed.';
      } else {
        const [card] = player.hand.splice(action.position, 1);
        discard.push(card);
        color = card.color === 'wild' ? action.color : card.color;
        history = player.name + ' played ' + cardText(card) + '.';
        if (!player.hand.length) {
          winner = player;
          break;
        }
        if (card.value === 'Swap') {
          [player.hand, other.hand] = [other.hand, player.hand];
          history += ' Hands switched.';
        }
        if (card.value === 'Draw 1') {
          const extra = draw(deck, discard);
          if (extra) other.hand.push(extra);
          history += ' ' + other.name + ' drew a card.';
        }
      }
      turn = 1 - turn;
    }

    if (winner) {
      const payout = bet * 2;
      bank.settle(ticket, winner.id ? { [winner.id]: payout } : {});
      const winnings = winner.id ? ' • received ' + cash(payout) : '';
      await board.edit(panel(title, '**' + winner.name + ' won!**' + winnings + '\n' + history));
    } else {
      bank.settle(ticket);
      await board.edit(panel(title, '**Draw.** Stakes returned.'));
    }
  } finally {
    if (ticket) bank.settle(ticket);
    occupied.delete(message.channelId);
  }
}
