import { cash, name, panel } from '../shared.js';
import { chooseReaction, playDuel, requireReactionPermissions } from './controls.js';

export const command = 'connect4';
export const usage = 'connect4 <bet> @opponent (alias: connectfour)';
export const aliases = ['connectfour'];
export const acceptsOpponent = true;
export const requiresOpponent = true;
const columns = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
const pieces = ['🔴', '🟡'];
const empty = '⚫';

// Only the newly placed piece can create a line. Count in both directions
// along each axis, including the diagonals.
export function hasFour(grid, row, column) {
  const piece = grid[row][column];
  return [[0, 1], [1, 0], [1, 1], [1, -1]].some(([dy, dx]) => {
    let count = 1;
    for (const direction of [-1, 1]) {
      let y = row + dy * direction;
      let x = column + dx * direction;
      while (grid[y]?.[x] === piece) {
        count++;
        y += dy * direction;
        x += dx * direction;
      }
    }
    return count >= 4;
  });
}

export async function run(context) {
  const { message, bet, bank } = context;
  requireReactionPermissions(message, 'Connect Four');
  const title = '🔴 Connect Four 🟡';
  await playDuel(context, title, async (board, ticket, players) => {
    const grid = Array.from({ length: 6 }, () => Array(7).fill(null));
    const render = detail => panel(title, players.map((member, index) =>
      pieces[index] + ' **' + name(member) + '**').join('    ') + '\n\n'
      + grid.map(line => line.map(cell => cell ?? empty).join(' ')).join('\n')
      + '\n' + columns.join(' ') + '\n\n' + detail);

    let result = '**Draw.** Both stakes returned.';
    let payout;
    for (let turn = 0; turn < 42; turn++) {
      const player = turn % 2;
      const member = players[player];
      const actions = columns.flatMap((emoji, index) => grid[0][index] ? [] : [[index, emoji]]);
      const column = await chooseReaction(board, member.id,
        render('**' + name(member) + '’s turn.** React with a column number.'), actions);

      let winner;
      let reason = '';
      if (column === null) {
        winner = 1 - player;
        reason = name(member) + ' ran out of time. ';
      } else {
        const row = grid.findLastIndex(line => line[column] === null);
        grid[row][column] = pieces[player];
        if (hasFour(grid, row, column)) winner = player;
      }
      if (winner !== undefined) {
        payout = { [players[winner].id]: bet * 2 };
        result = reason + '**' + name(players[winner]) + ' won ' + cash(bet * 2) + '.**';
        break;
      }
    }
    bank.settle(ticket, payout);
    await board.edit(render(result));
    await board.reactions.removeAll().catch(error => console.warn('Could not clear Connect Four reactions:', error.message));
  });
}
