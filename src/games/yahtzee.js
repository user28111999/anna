import { randomInt } from 'node:crypto';
import { cash, config, name, panel } from '../shared.js';
import { button, choose, playRound, row, select } from './controls.js';

export const command = 'yahtzee';
export const usage = 'yahtzee <bet>';

const upper = ['Ones', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes'];
const categories = [...upper, 'Three of a kind', 'Four of a kind', 'Full house',
  'Small straight', 'Large straight', 'Yahtzee', 'Chance'];

export function scoreDice(dice, category) {
  const counts = Array.from({ length: 6 }, (_, index) => dice.filter(die => die === index + 1).length);
  const sum = dice.reduce((total, die) => total + die, 0);
  const sequence = counts.map(count => count ? '1' : '0').join('');
  const index = upper.indexOf(category);
  if (index !== -1) return counts[index] * (index + 1);
  switch (category) {
    case 'Three of a kind': return Math.max(...counts) >= 3 ? sum : 0;
    case 'Four of a kind': return Math.max(...counts) >= 4 ? sum : 0;
    case 'Full house': return counts.includes(3) && counts.includes(2) ? 25 : 0;
    case 'Small straight': return sequence.includes('1111') ? 30 : 0;
    case 'Large straight': return sequence.includes('11111') ? 40 : 0;
    case 'Yahtzee': return counts.includes(5) ? 50 : 0;
    case 'Chance': return sum;
    default: throw new Error('Unknown Yahtzee category.');
  }
}

export function totalScore(sheet) {
  const base = Object.values(sheet).reduce((sum, points) => sum + points, 0);
  const upperScore = upper.reduce((sum, category) => sum + (sheet[category] ?? 0), 0);
  return base + (upperScore >= 63 ? 35 : 0);
}

const die = () => randomInt(1, 7);
const roll = () => Array.from({ length: 5 }, die);
const open = sheet => categories.filter(category => !Object.hasOwn(sheet, category));

// The bot plays the same three-roll turns. It keeps the most frequent face
// (highest face on a tie), then chooses the highest scoring unused category.
function botTurn(sheet) {
  let dice = roll();
  for (let attempt = 0; attempt < 2; attempt++) {
    const ranked = [6, 5, 4, 3, 2, 1].sort((a, b) =>
      dice.filter(value => value === b).length - dice.filter(value => value === a).length);
    dice = dice.map(value => value === ranked[0] ? value : die());
  }
  const category = open(sheet).sort((a, b) => scoreDice(dice, b) - scoreDice(dice, a))[0];
  sheet[category] = scoreDice(dice, category);
  return category + ' • ' + sheet[category];
}

export async function run(context) {
  const { message, bet, bank } = context;
  const player = message.author.id;
  const title = config.emoji.yahtzee + ' Yahtzee • ' + name(message.member);
  await playRound(context, title, { [player]: bet }, async (board, ticket) => {
    const yours = {};
    const house = {};
    let lastPlay = '';
    let timedOut = false;
    for (let turn = 1; turn <= categories.length; turn++) {
      let dice = roll();
      let rollsLeft = 2;
      let held = new Set();
      while (true) {
        const faces = dice.map((value, index) =>
          (held.has(String(index)) ? '**' : '') + config.emoji.dice[value - 1]
          + (held.has(String(index)) ? '** 🔒' : '')).join('  ');
        const standings = '**You • ' + totalScore(yours) + ' | Bot • ' + totalScore(house) + '**';
        const view = panel(title, 'Round ' + turn + '/13 • ' + rollsLeft + ' rerolls left\n\n'
          + faces + '\n\n' + standings + (lastPlay ? '\nLast bot play • ' + lastPlay : '')
          + '\n\nHold dice before rerolling, or score an unused category.');
        const scoreOptions = open(yours).map(category => ({
          label: category + ' (' + scoreDice(dice, category) + ')', value: category
        }));
        const rows = [row(select('score', 'Score a category', scoreOptions))];
        const ids = ['score'];
        if (rollsLeft) {
          rows.push(row(select('hold', 'Choose dice to hold', dice.map((value, index) => ({
            label: 'Die ' + (index + 1) + ' • ' + value, value: String(index), default: held.has(String(index))
          })), 0, 5)));
          rows.push(row(button('reroll', 'Reroll unheld dice')));
          ids.push('hold', 'reroll');
        }
        const choice = await choose(board, player, view, rows, ids);
        if (!choice) {
          timedOut = true;
          break;
        }
        if (choice.customId === 'hold') held = new Set(choice.values);
        if (choice.customId === 'reroll') {
          dice = dice.map((value, index) => held.has(String(index)) ? value : die());
          rollsLeft--;
        }
        if (choice.customId === 'score') {
          const [category] = choice.values;
          yours[category] = scoreDice(dice, category);
          lastPlay = botTurn(house);
          break;
        }
      }
      if (timedOut) break;
    }

    const playerScore = totalScore(yours);
    const botScore = totalScore(house);
    const payout = timedOut ? 0 : bet * (playerScore > botScore ? 3 : playerScore === botScore ? 2 : 0);
    bank.settle(ticket, { [player]: payout });
    const result = timedOut ? 'Time expired. Stake lost.'
      : playerScore > botScore ? 'You won!' : playerScore === botScore ? 'Draw.' : 'The bot won.';
    const scorecard = categories.map(category => category + ' • ' + (yours[category] ?? '—')
      + ' / ' + (house[category] ?? '—')).join('\n');
    await board.edit(panel(title, '**' + result + '**\nYou • ' + playerScore + ' | Bot • ' + botScore
      + '\n**Returned • ' + cash(payout) + '**\n\n' + scorecard));
  });
}
