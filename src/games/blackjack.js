import { PermissionFlagsBits } from 'discord.js';
import { cash, config, name, panel, reactionKey, shuffle, UserError } from '../shared.js';
import { playRound, turnMs } from './controls.js';

export const command = 'blackjack';
export const usage = 'blackjack <bet>';
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const suits = ['♠️', '♥️', '♦️', '♣️'];

// Count aces low first, then promote one to 11 when it fits.
export function handValue(cards) {
  const total = cards.reduce((sum, card) => sum + Math.min(ranks.indexOf(card.rank) + 1, 10), 0);
  return cards.some(card => card.rank === 'A') && total <= 11 ? total + 10 : total;
}

const natural = cards => cards.length === 2 && handValue(cards) === 21;
const render = cards => cards.map(card => card.rank + card.suit).join(' ');

export function blackjackPayout(hand, dealer, original) {
  const score = handValue(hand.cards);
  const dealerScore = handValue(dealer);
  if (natural(dealer)) return original && natural(hand.cards) ? hand.stake : 0;
  if (original && natural(hand.cards)) return hand.stake * 3;
  if (score > 21) return 0;
  if (dealerScore > 21 || score > dealerScore) return hand.stake * 2;
  return score === dealerScore ? hand.stake : 0;
}

async function reaction(board, player, view, actions) {
  const keys = new Map(actions.map(([action, emoji]) => [reactionKey(emoji), action]));
  const collector = board.createReactionCollector({
    filter: (entry, actor) => actor.id === player && keys.has(entry.emoji.id ?? entry.emoji.name),
    max: 1, time: turnMs
  });
  const selected = new Promise(resolve => collector.on('end', entries => resolve(entries.first())));
  try {
    await board.edit(view);
    for (const [, emoji] of actions) {
      if (!board.reactions.cache.has(reactionKey(emoji))) await board.react(emoji);
    }
    const entry = await selected;
    if (!entry) return null;
    // Remove the player's reaction so they can choose the same action again.
    await entry.users.remove(player);
    return keys.get(entry.emoji.id ?? entry.emoji.name);
  } finally {
    collector.stop();
  }
}

export async function run(context) {
  const { message, bet, bank } = context;
  const player = message.author.id;
  const permissions = message.channel.permissionsFor(message.guild.members.me);
  if (!permissions?.has([PermissionFlagsBits.AddReactions, PermissionFlagsBits.ManageMessages])) {
    throw new UserError('Blackjack needs Add Reactions and Manage Messages in this channel.');
  }
  const title = config.emoji.blackjack + ' Blackjack • ' + name(message.member);
  await playRound(context, title, { [player]: bet }, async (board, ticket) => {
    const deck = shuffle(suits.flatMap(suit => ranks.map(rank => ({ rank, suit }))));
    const hands = [{ cards: [deck.pop(), deck.pop()], stake: bet }];
    const dealer = [deck.pop(), deck.pop()];
    const openingNatural = natural(dealer) || natural(hands[0].cards);
    let timedOut = false;

    const summary = (reveal, current = -1) => [
      '**Dealer** • ' + (reveal ? render(dealer) + ' (' + handValue(dealer) + ')' : render(dealer.slice(0, 1)) + ' 🂠'),
      ...hands.map((hand, index) => (current === index ? '▶ ' : '') + '**Hand ' + (index + 1)
        + '** • ' + render(hand.cards) + ' (' + handValue(hand.cards) + ') • ' + cash(hand.stake))
    ].join('\n');

    if (!openingNatural) {
      for (let index = 0; index < hands.length; index++) {
        const hand = hands[index];
        while (handValue(hand.cards) < 21 && !hand.splitAce) {
          const actions = [['Hit', config.emoji.hit], ['Stand', config.emoji.stand]];
          if (hand.cards.length === 2 && bank.getUser(player).balance >= bet) {
            actions.push(['Double down', config.emoji.double]);
            if (hands.length === 1 && hand.cards[0].rank === hand.cards[1].rank) {
              actions.push(['Split', config.emoji.split]);
            }
          }
          const hint = actions.map(([action, emoji]) => emoji + ' ' + action).join('  ');
          const action = await reaction(board, player, panel(title, summary(false, index) + '\n\n' + hint), actions);
          if (!action) {
            timedOut = true;
            break;
          }
          if (action === 'Stand') break;
          if (action === 'Hit') {
            hand.cards.push(deck.pop());
            continue;
          }
          // Recheck funds atomically in case they changed while the menu was open.
          try {
            bank.increaseStake(ticket, player, bet);
          } catch (error) {
            if (!(error instanceof UserError)) throw error;
            continue;
          }
          if (action === 'Double down') {
            hand.stake += bet;
            hand.cards.push(deck.pop());
            break;
          }
          const separated = hand.cards.pop();
          const splitAce = separated.rank === 'A';
          hands.push({ cards: [separated, deck.pop()], stake: bet, splitAce });
          hand.cards.push(deck.pop());
          hand.splitAce = splitAce;
        }
        if (timedOut) break;
      }
      // Dealer stands on all 17s, including soft 17.
      if (!timedOut && hands.some(hand => handValue(hand.cards) <= 21)) {
        while (handValue(dealer) < 17) dealer.push(deck.pop());
      }
    }

    const payouts = hands.map(hand => timedOut ? 0 : blackjackPayout(hand, dealer, hands.length === 1));
    const total = payouts.reduce((sum, value) => sum + value, 0);
    bank.settle(ticket, { [player]: total });
    const result = timedOut ? 'Time expired. Stakes lost.' : payouts.map((value, index) => {
      const hand = hands[index];
      let outcome = 'Lost';
      if (value === hand.stake) outcome = 'Push';
      if (value > hand.stake) outcome = value === hand.stake * 3 ? 'Blackjack' : 'Won';
      return 'Hand ' + (index + 1) + ' • ' + outcome + ' • ' + cash(value) + ' returned';
    }).join('\n');
    await board.edit(panel(title, summary(true) + '\n\n' + result + '\n\n**Total returned • ' + cash(total) + '**'));
    await board.reactions.removeAll().catch(() => {});
  });
}
