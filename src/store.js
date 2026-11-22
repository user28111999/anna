import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cash, root, UserError } from './shared.js';

const directory = new URL('data/', root);
const save = new URL('state.json', directory);
const temporary = new URL('state.tmp', directory);
mkdirSync(directory, { recursive: true });

let state = { users: {}, games: {} };
try {
  state = JSON.parse(readFileSync(save, 'utf8'));
  if (!state.users || !state.games) throw new Error('Invalid state.json structure.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

// IDs are global across guilds. Reading a new user does not write to disk.
const blank = () => ({ balance: 0, daily: null, lootboxes: 0, items: {} });
export const getUser = id => structuredClone(state.users[id] ?? blank());
export const user = (draft, id) => draft.users[id] ??= blank();

// Each mutation runs synchronously against a copy. Rename commits the entire change
// together, so a gift or settlement never saves only one side of the transfer.
export function change(update) {
  const draft = structuredClone(state);
  const result = update(draft);
  writeFileSync(temporary, JSON.stringify(draft, null, 2) + '\n', { flush: true });
  renameSync(temporary, save);
  state = draft;
  return result;
}

export function credit(account, delta) {
  const balance = account.balance + delta;
  if (balance < 0) throw new UserError('Your balance is too low. Available: ' + cash(account.balance) + '.');
  if (!Number.isSafeInteger(balance)) throw new UserError('This transaction exceeds the balance limit.');
  account.balance = balance;
}

// Reserve the stakes together once everyone has agreed to play.
export function reserve(stakes) {
  const ticket = randomUUID();
  change(draft => {
    for (const [id, stake] of Object.entries(stakes)) credit(user(draft, id), -stake);
    draft.games[ticket] = stakes;
  });
  return ticket;
}

export function increaseStake(ticket, id, stake) {
  change(draft => {
    credit(user(draft, id), -stake);
    draft.games[ticket][id] += stake;
  });
}

export function settle(ticket, payouts) {
  if (!state.games[ticket]) return;
  change(draft => {
    const amounts = payouts ?? draft.games[ticket];
    for (const [id, value] of Object.entries(amounts)) credit(user(draft, id), value);
    delete draft.games[ticket];
  });
}

// A restart interrupts interactive rounds. Restore all stakes in one transaction.
export function recoverGames() {
  if (!Object.keys(state.games).length) return;
  change(draft => {
    for (const stakes of Object.values(draft.games)) {
      for (const [id, value] of Object.entries(stakes)) credit(user(draft, id), value);
    }
    draft.games = {};
  });
}
