# 500 for the web

Plain JavaScript (ES modules, no build step, no Node) so it runs from any static host.
Started 2026-10-23 for Louie: the iPhone app (`~/code/fivehundred`) in a browser — play the
computer, or family and friends anywhere with a 4-letter code; bots fill empty seats.
Built like `~/code/hearts-web` (four seats) and `~/code/cribbage-web` (same Firebase project).

## Layout
- `js/cards.js` — cards as ints like the app's ids (suit*100+rank, ace 14; Joker 999; suits
  ♠0 ♣1 ♦2 ♥3, No Trumps 4), bowers (`effectiveSuit`, `isTrump`, `power`), bids
  `{ tricks, trump }` and their values.
- `js/game.js` — the app's `FiveHundredGame`: Louie's family rules (45 cards, 10 each + 5
  kitty; no-face-card deals thrown in; standing on your bid; four passes redeal; ANY side
  to 500 wins, bidders first if both; −500 loses; slam ≥ 250; no misère). Plain JSON state;
  illegal moves throw `IllegalMove`. `markContinued` waits for every person (30 s after the
  first tap).
- `js/bot.js` — the app's `Bot` and `Search` (look-ahead over imagined deals: 50 per bid
  and throw-back, 80 per play; rule-of-thumb Steady play inside). Randomness goes through
  `rng` ({ below, unit }, Swift's shuffle/randomElement) so the parity check can feed the
  app's generator. Every web bot is an Expert with a secret style revealed at game over
  (Louie, 2026-10-23); a stand-in for a dropped person plays Steady. When the app's bots
  change, port the change here and rerun the parity check.
- `js/think.js` + `js/worker.js` — the bots think in a module Web Worker (falls back to the
  page); `?noworker` forces the page (headless Chrome's virtual clock doesn't wait for workers).
- `js/table.js` — table state (game + seats + paused), `applyMove`, `nextHostStep` and
  `Pacer` (the app's pacing: bot 0.75 s, a finished trick 1 s + 0.55 s sweep, the kitty
  turned up 0.75 s a card + 3 s; a bot thinks while the pause runs), `LocalHost`.
- `js/online.js` — Firebase (Louie's `hearts-659fc`) at `/tables/500-CODE` (the rules only
  open `/tables`): meta, seats ×4, state (host writes), moves, presence. Same scheme as
  Hearts: drop → pause (host may let a bot play), host takeover with the epoch guard.
- `js/sounds.js` — the app's synthesized snap, deal, knock, fanfare (same as Gin's).
- `js/main.js` — screens: start (Continue Game, Back to Table), friends, waiting room,
  table (as the app's TableView: partner across, bid grid on your turn — beside the table
  on a sideways phone — kitty turned up in the middle, then beside your hand, or in the
  middle when sideways), Joker-lead suit choice, hand result, final score with the bots'
  styles, score sheet, menu, settings (name, card back, highest left, large letters,
  sounds, Suggest), statistics (this device, the app's lines), How to Play. Hand order is
  the app's `defaultOrder` (colors alternate, trumps on the right). localStorage
  `fh.settings`, `fh.stats`, `fh.local`, `fh.table`. Names from other browsers go through
  `esc()`. Things that pop in (banner, kitty cards, trick cards) do so once, not on every
  redraw.
- Not ported: nearby (Bluetooth) play, iCloud stats, themes, drag-to-rearrange the hand.

## Test
- Rules: `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/engine.test.js`
  (rules, scoring, endings, 2 whole bot games through the table code).
- Same as the app: `swiftc -O -module-name Parity ~/code/fivehundred/FiveHundred/Engine/*.swift
  tests/parity/main.swift -o /tmp/fh_parity/parity && /tmp/fh_parity/parity GAMES SEED >
  /tmp/fh_parity/games.jsonl` (~5 s a game; run several SEEDs at once), then
  `jsc tests/args.js -m tests/parity/parity.js -- /tmp/fh_parity/games.jsonl`.
  2026-10-23: 120 games, 566 hands, 27,429 decisions (bids, passes, throw-backs, plays)
  identical to the app. A bot decision takes ~12 ms on average in JS.
- Page: serve with `Cache-Control: no-store`, headless Chrome with its own
  `--user-data-dir` (never Louie's) and `?noworker`. URL options: `?name=X`, `?play`,
  `?autoplay`, `?fast`, `?noworker`, `?newtable=CODE&startafter=N`, `?t=CODE`. To see
  phone sizes in headless Chrome, load the page in a 402×874 (or 874×402) iframe from a
  scratch driver page that taps for you. Online: two simulators' Safari (iPhone
  `?newtable=TZxx&startafter=2&autoplay`, iPad `?t=TZxx&autoplay`); delete TZ* tables after
  (`DELETE /tables/500-TZxx.json?auth=…`, token from anonymous `accounts:signUp`).
  Verified 2026-10-23: 12 fast games through the page with no errors; online (iPhone host +
  iPad): play, guest drop → pause → rejoin, host drop → takeover + pause → rejoin.

## Deploy
GitHub Pages from `main` (repo Louiebo1/fivehundred, public) → https://louiebo1.github.io/fivehundred/.
`git push`; Pages rebuilds in about a minute. GitHub CLI: `~/bin/gh` (logged in as Louiebo1).

## Google sign-in (2026-10-28)
`js/account.js` is a copy of `~/code/cardgames-home/shared/account.js` — the same file in
every game; change it there and copy it to all of them. It owns the Firebase connection
(`online.js` gets the id from `playerId()`): anonymous unless the person signed in with
Google (the button on the start screen, `accountLobby()`; Sign Out in Settings). Signed in, the name and statistics live at
`/users/UID` (`name`, `email`, `games/<game id>`), private to that person; `main.js` calls
`syncGame(...)` at startup, `pushName` in `saveSettings`, `pushStats` when stats are saved.
