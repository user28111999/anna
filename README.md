# BB Discord Bot

A local Discord bot with a shared play-money wallet, three games, and editable text and media folders. It uses Node.js 24.22.1 or newer and has one direct dependency, discord.js.

## Run it

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). On its **Bot** page, enable **Message Content Intent** and copy the bot token.
2. Install the app to your server using the **bot** scope. Grant View Channel, Send Messages, Send Messages in Threads if applicable, Embed Links, Attach Files, Read Message History, Add Reactions, and Manage Messages. Blackjack uses Manage Messages to clear reaction controls. If you use custom emoji from another server, also grant Use External Emojis.
3. Copy `.env.example` to `.env` and put your token after `DISCORD_TOKEN=`. Keep `.env` on your machine.
4. Run the following from the project directory.

   ```sh
   npm ci
   npm start
   ```

Use `npm run dev` for Node’s watch mode. Run one instance per copy of the save. Try `bb help`, then `bb daily` for a starting balance.

## Commands

| Command | Behavior |
| --- | --- |
| `bb help` | Show commands and installed games. |
| `bb money [@member]` | Check your balance or another server member’s. |
| `bb money add <amount> <@member>` | Add funds. Server administrator only. |
| `bb money set <amount> <@member>` | Set a balance, including zero. Server administrator only. |
| `bb money remove <amount> <@member>` | Subtract funds, up to the available balance. Server administrator only. |
| `bb daily` | Claim 20 money starting at 6 a.m. Paris time each day, with a 50% chance of a lootbox. |
| `bb lootbox` | Open one box for a 50/50 chance at 20 money or a random configured item. |
| `bb shop` | Browse prices. |
| `bb shop buy <item>` | Buy an item with money. |
| `bb inventory` | View your items, lootboxes and balance. |
| `bb give <@member> <item>` | Transfer one owned item. Item names can contain spaces. |
| `bb gif` / `bb img` | Upload a random file from the matching folder. |
| `bb dare [@member]` / `bb truth [@member]` | Draw a random prompt and optionally address it to a friend. |
| `bb dare add <text>` / `bb truth add <text>` | Append a single prompt to its text file. |
| `bb persona` | Placeholder for a future feature. |

Commands are case-insensitive. Members can be specified by mention or ID. Where the member argument runs to the end of the command, an exact display name can also contain spaces. For `give`, use a mention or ID when an exact name contains spaces. Messages identify people by their server display names.

## Games

Each game starts with a positive whole-number bet and displays an embed. The stake is deducted when play starts. Payouts below are total returns, including any returned stake. Turn time defaults to two minutes.

| Command | How it plays | Return |
| --- | --- | --- |
| `bb blackjack <bet>` | The person who started the round reacts to hit, stand, split an equal-rank pair once, or double down with two cards. Split and double require another stake. Split aces get one card each. Dealer stands on soft 17. | Win 2×, opening blackjack 3× (2:1 profit), push 1×, loss 0. Hands settle separately after a split. |
| `bb yahtzee <bet>` | A 13-round dice scorecard duel against the bot. Hold dice and reroll up to twice per round. Score one unused category per round. Upper-section bonus at 63, without bonus Yahtzee or joker rules. | Win 3×, draw 2×, loss 0. |
| `bb uno <bet> [@opponent]` | Color Match house variant. Play against the bot or invite a friend. The friend must accept before either stake is charged. View your hand privately with the button. | Winner gets 2×. On a draw, stakes return. |

Color Match starts with six cards per player. Match a card’s color or value. Use `bb uno play 3` to play the third card in your hand, or `bb uno play 3 blue` to play a Shift and choose blue. Swap exchanges hands and Draw 1 adds one card to the other hand. `bb uno draw` takes a card and passes the turn. Empty your hand to win. If a hand changes, open the hand button again for current card numbers. There is one Color Match table per channel.

A timed-out player forfeits. Restarting the bot refunds stakes from interrupted rounds.

## Edit it

- **`config.json`** controls the one-word prefix, currency name, reset hour and time zone, reward values, lootbox item names, shop prices, turn timer and emojis. Emoji values can be Unicode or Discord custom markup such as `<:hit:123456789012345678>`. Use a different emoji for each Blackjack action.
- **`dare.txt` and `truth.txt`** use one prompt per line. Blank lines are ignored.
- **`gif/` and `img/`** are local media folders. Add GIFs to `gif/`, and JPEG, PNG, WebP, AVIF, BMP, ICO or TIFF files to `img/`. Animated PNG, WebP and AVIF files are skipped.
- **`data/state.json`** is generated on the first write. It holds wallets, inventories, claim dates, and temporarily reserved stakes. Wallets are global per Discord user across the servers using this copy of the bot. To move or back up the bot, stop it and copy the save alongside the project. The save and token are ignored by Git.
- **`src/games/`** is auto-discovered at startup. To add a game, create a JavaScript module exporting `command`, `usage`, and an async `run({ message, bet, opponents, bank })`. A game can also export `move(message, args)` to consume text moves before bet parsing, and `acceptsOpponent = true` to receive an opponent argument. Start from a small existing module and reuse `playRound` to reserve and refund stakes. Removing a game file removes its command and help entry.

The starter commit is on `master`. You can branch locally with `git switch -c feature/my-game`. No remote is required.
