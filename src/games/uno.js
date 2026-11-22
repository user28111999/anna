import { privateReply } from '../logger.js';
import { appEmoji } from '../emojis.js';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { cash, config, name, panel, shuffle, UserError } from '../shared.js';
import { button, playDuel, playRound, row, turnMs } from './controls.js';

export const command = 'uno';
export const usage = 'uno <bet> [@opponent]';
export const acceptsOpponent = true;
const colors = ['red', 'yellow', 'green', 'blue'];
const waiting = new Map();

const actionNames = {
  draw_two: 'Draw Two', reverse: 'Reverse / Swap', skip: 'Skip',
  wild: 'Wild', wild_draw_four: 'Wild Draw Four'
};

export function cardText(application, card) {
  const fallback = config.emoji.colors[card.color];
  const emoji = appEmoji(application, card.color + '_' + card.value, fallback);
  const label = actionNames[card.value] ?? card.value;
  return emoji + ' ' + (card.color === 'wild' ? '' : card.color + ' ') + label;
}
const matches = (card, top, color) =>
  card.color === 'wild' || card.color === color || card.value === top.value;

// Keep the six-card Color Match deal. The deck has one of every uploaded
// colored face and four copies of each wild face.
export function makeDeck() {
  const values = [...Array.from({ length: 10 }, (_, value) => String(value)), 'draw_two', 'reverse', 'skip'];
  const cards = colors.flatMap(color => values.map(value => ({ color, value })));
  for (let copy = 0; copy < 4; copy++) {
    cards.push({ color: 'wild', value: 'wild' }, { color: 'wild', value: 'wild_draw_four' });
  }
  return shuffle(cards);
}

function draw(deck, discard) {
  if (!deck.length && discard.length > 1) {
    deck.push(...shuffle(discard.splice(0, discard.length - 1)));
  }
  return deck.pop();
}

function handView(hand, renderCard) {
  const lines = hand.map((card, index) => (index + 1) + '. ' + renderCard(card));
  const pages = [lines.slice(0, 30), lines.slice(30)].filter(page => page.length);
  const view = panel('Your hand', pages[0]?.join('\n') ?? 'Your hand is empty.');
  // A very long hand still shows every playable index with intact emoji markup.
  if (pages[1]) view.embeds.push(panel('Your hand • continued', pages[1].join('\n')).embeds[0]);
  return view;
}

async function humanTurn(board, view, table, turn, top, color, renderCard) {
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
          if (card.color !== 'wild' && chosenColor) throw new UserError('Only wild cards take a color argument.');
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
    privateReply(interaction, { ...handView(viewer.hand, renderCard), flags: MessageFlags.Ephemeral })
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
  const application = message.client.application;
  const renderCard = card => cardText(application, card);
  const cardBack = appEmoji(application, 'empty-card', appEmoji(application, 'empty_card', '🂠'));
  const title = config.emoji.uno + ' UNO • Color Match';

  async function play(board, ticket, members) {
    const table = [
      { id: members[0].id, name: name(members[0]), hand: [] },
      { id: members[1]?.id, name: members[1] ? name(members[1]) : 'Bot', hand: [] }
    ];
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
        const view = panel(title, '**Top card** • ' + renderCard(top) + '\n**Color** • ' + color
          + '\n**Turn** • ' + player.name + '\n\n' + table.map(entry =>
            '**' + entry.name + '** • ' + cardBack + ' × ' + entry.hand.length).join('\n')
          + '\n\n' + history + '\n\n`' + config.prefix + ' uno play <card number> [color]` or `'
          + config.prefix + ' uno draw`');
        action = await humanTurn(board, view, table, turn, top, color, renderCard);
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
      let skip = false;
      if (action.verb === 'draw') {
        const card = draw(deck, discard);
        if (!card) break;
        player.hand.push(card);
        history = player.name + ' drew a card and passed.';
      } else {
        const [card] = player.hand.splice(action.position, 1);
        discard.push(card);
        color = card.color === 'wild' ? action.color : card.color;
        history = player.name + ' played ' + renderCard(card) + '.';
        if (!player.hand.length) {
          winner = player;
          break;
        }
        if (card.value === 'reverse') {
          [player.hand, other.hand] = [other.hand, player.hand];
          history += ' Hands switched.';
        }
        if (card.value === 'draw_two' || card.value === 'wild_draw_four') {
          const penalty = card.value === 'draw_two' ? 2 : 4;
          let count = 0;
          for (; count < penalty; count++) {
            const extra = draw(deck, discard);
            if (!extra) break;
            other.hand.push(extra);
          }
          history += ' ' + other.name + ' drew ' + count + ' card(s).';
        }
        skip = card.value === 'skip';
        if (skip) history += ' ' + other.name + ' was skipped.';
      }
      if (!skip) turn = 1 - turn;
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
  }

  try {
    if (opponents) return await playDuel(context, title, play);
    await playRound(context, title, { [message.author.id]: bet },
      (board, ticket) => play(board, ticket, [message.member]));
  } finally {
    occupied.delete(message.channelId);
  }
}
