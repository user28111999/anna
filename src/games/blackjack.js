import { appEmoji } from '../emojis.js';
import { cash, config, name, panel, shuffle, UserError } from '../shared.js';
import { chooseReaction, playRound, requireReactionPermissions } from './controls.js';

export const command = 'blackjack';
export const usage = 'blackjack <bet>';
export const maxReturn = 8; // Two split hands can each double down.
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const suits = { spades: '♠️', hearts: '♥️', diamonds: '♦️', clubs: '♣️' };
const rankNames = { A: '1', J: 'jack', Q: 'queen', K: 'king' };

// Count aces low first, then promote one to 11 when it fits.
export function handValue(cards) {
  const total = cards.reduce((sum, card) => sum + Math.min(ranks.indexOf(card.rank) + 1, 10), 0);
  return cards.some(card => card.rank === 'A') && total <= 11 ? total + 10 : total;
}

const natural = cards => cards.length === 2 && handValue(cards) === 21;
function render(application, cards) {
  return cards.map(card => appEmoji(application, card.suit + '_' + (rankNames[card.rank] ?? card.rank),
    card.rank + suits[card.suit])).join('  ');
}

export function blackjackPayout(hand, dealer, original) {
  const score = handValue(hand.cards);
  const dealerScore = handValue(dealer);
  if (natural(dealer)) return original && natural(hand.cards) ? hand.stake : 0;
  if (original && natural(hand.cards)) return hand.stake * 3;
  if (score > 21) return 0;
  if (dealerScore > 21 || score > dealerScore) return hand.stake * 2;
  return score === dealerScore ? hand.stake : 0;
}

export async function run(context) {
  const { message, bet, bank } = context;
  const player = message.author.id;
  requireReactionPermissions(message, 'Blackjack');
  const application = message.client.application;
  const title = config.emoji.blackjack + ' Blackjack • ' + name(message.member);
  await playRound(context, title, { [player]: bet }, async (board, ticket) => {
    const deck = shuffle(Object.keys(suits).flatMap(suit => ranks.map(rank => ({ rank, suit }))));
    const hands = [{ cards: [deck.pop(), deck.pop()], stake: bet }];
    const dealer = [deck.pop(), deck.pop()];
    const openingNatural = natural(dealer) || natural(hands[0].cards);
    let timedOut = false;

    const summary = (reveal, current = -1) => {
      const dealerCards = render(application, reveal ? dealer : dealer.slice(0, 1));
      const dealerLine = reveal ? dealerCards + '  •  **' + handValue(dealer) + '**'
        : dealerCards + '  ' + appEmoji(application, 'empty_blue', appEmoji(application, 'empty_red', '🂠'));
      const playerLines = hands.map((hand, index) => (current === index ? '▶  ' : '')
        + '**Hand ' + (index + 1) + '**  ·  ' + cash(hand.stake) + '\n'
        + render(application, hand.cards) + '  •  **' + handValue(hand.cards) + '**');
      return ['**Dealer**\n' + dealerLine, ...playerLines].join('\n\n');
    };

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
          const action = await chooseReaction(board, player, panel(title, summary(false, index) + '\n\n' + hint), actions);
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
