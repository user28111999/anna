import { randomInt } from 'node:crypto';
import { cash, config, name, panel } from '../shared.js';
import { appEmoji } from '../emojis.js';
import { button, choose, playDuel, row, select } from './controls.js';

export const command = 'yahtzee';
export const usage = 'yahtzee <bet> @opponent';
export const acceptsOpponent = true;
export const requiresOpponent = true;
export const maxReturn = 3;

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

// Each player completes a turn in every round and keeps a separate scorecard.
export async function run(context) {
  const { message, bet, bank } = context;
  const title = config.emoji.yahtzee + ' Yahtzee Duel';
  const dieEmoji = value => appEmoji(message.client.application, 'dice_' + value, config.emoji.dice[value - 1]);
  await playDuel(context, title, async (board, ticket, players) => {
    const sheets = [{}, {}];
    const totals = () => players.map((member, index) =>
      '**' + name(member) + '**  •  ' + totalScore(sheets[index])).join('\n');
    let lastPlay = '';
    let forfeited;

    for (let turn = 0; turn < categories.length * 2; turn++) {
      const player = turn % 2;
      const member = players[player];
      const sheet = sheets[player];
      let dice = roll();
      let rollsLeft = 2;
      let held = new Set();
      while (true) {
        const faces = dice.map((value, index) => dieEmoji(value) + (held.has(String(index)) ? '🔒' : '')).join('   ');
        const view = panel(title, '**Round ' + (Math.floor(turn / 2) + 1) + ' / 13**  ·  '
          + rollsLeft + ' rerolls left\n**Turn**  •  ' + name(member)
          + '\n\n' + faces + '\n\n**Scoreboard**\n' + totals()
          + (lastPlay ? '\n\nLast play  •  ' + lastPlay : '')
          + '\n\nChoose dice to hold, reroll, or score an unused category.');
        const scoreOptions = open(sheet).map(category => ({
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
        const choice = await choose(board, member.id, view, rows, ids);
        if (!choice) {
          forfeited = player;
          break;
        }
        if (choice.customId === 'hold') held = new Set(choice.values);
        if (choice.customId === 'reroll') {
          dice = dice.map((value, index) => held.has(String(index)) ? value : die());
          rollsLeft--;
        }
        if (choice.customId === 'score') {
          const [category] = choice.values;
          sheet[category] = scoreDice(dice, category);
          lastPlay = name(member) + ' scored ' + sheet[category] + ' in ' + category + '.';
          break;
        }
      }
      if (forfeited !== undefined) break;
    }

    const [left, right] = sheets.map(totalScore);
    const draw = forfeited === undefined && left === right;
    const winner = forfeited !== undefined ? 1 - forfeited : Number(right > left);
    // Keep the original solo payout rules for each player's own wager.
    const payouts = draw ? { [players[0].id]: bet * 2, [players[1].id]: bet * 2 }
      : { [players[winner].id]: bet * 3 };
    bank.settle(ticket, payouts);
    const result = draw ? '**Draw.** Both players received ' + cash(bet * 2) + '.'
      : '**' + name(players[winner]) + ' won ' + cash(bet * 3) + '.**'
        + (forfeited === undefined ? '' : '\n' + name(players[forfeited]) + ' ran out of time.');
    const final = panel(title, result + '\n\n' + totals());
    final.embeds[0].fields = players.map((member, index) => ({
      name: name(member),
      value: categories.map(category => category + '  •  ' + (sheets[index][category] ?? '—')).join('\n'),
      inline: true
    }));
    await board.edit(final);
  });
}
