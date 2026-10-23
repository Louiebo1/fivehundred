// A 500 table: the game, who sits where (a person or a bot), and the pacing. The table's
// host runs the game: it applies everyone's moves, plays the bots, and (online) publishes
// the state. Other players only send moves. Everything here is plain data so the same
// table can run locally or through Firebase.

import * as G from './game.js';
import { STYLE_NAMES } from './bot.js';
import { think } from './think.js';

/** Ordinary names for the bots, so they feel like people at the table (the app's). */
export const BOT_NAMES = ['Maggie', 'Ray', 'June', 'Walt', 'Dot', 'Frank', 'Ruth', 'Hank', 'Bea', 'Gus',
  'Ida', 'Earl', 'Pearl', 'Mac', 'Vera', 'Stan', 'Lou', 'Nell', 'Otis', 'Fay', 'Dan', 'Terry', 'Darlene'];

/** The app's pacing (ms): a bot's move, a finished trick on show then sliding to its
 *  winner, the kitty turned up one card at a time then left up, the result held back so
 *  "Set!" can be seen first. */
export const PACE = { bot: 750, trickPause: 1000, trickSweep: 550, kittyCard: 750, kittyHold: 3000, resultHold: 1800, autoNext: 4000 };
export const trickLinger = () => PACE.trickPause + PACE.trickSweep;
export const kittyReveal = () => PACE.kittyCard * G.KITTY_SIZE + PACE.kittyHold;

export const shuffledList = (list) => list.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((e) => e[1]);

/** A fresh table state: the game plus the seats ([{ kind: 'person' | 'bot', name }]).
 *  Each bot is dealt a secret style, revealed when the game ends. */
export function newTableState(seats) {
  const game = G.newGame();
  const styles = shuffledList(STYLE_NAMES);
  game.humanSeats = peopleSeats({ seats });
  seats.forEach((s, i) => { if (s.kind === 'bot') game.botStyles[i] = styles.pop(); });
  return { game, seats, paused: null, version: 0 };
}

export const peopleSeats = (state) => state.seats.map((s, i) => (s.kind === 'person' ? i : -1)).filter((i) => i >= 0);

/** Apply one move (from anyone) to the table state. Returns true if it changed. */
export function applyMove(state, move) {
  const g = state.game;
  try {
    switch (move.type) {
      case 'bid': case 'pass': case 'discard': case 'play':
        G.apply(g, move, move.seat);
        break;
      case 'continue': G.markContinued(g, move.seat); break;
      case 'deal':                      // The 30 seconds after the first Next Hand are up.
        if (g.phase !== 'handOver' || move.hand !== g.handNumber) return false;
        G.nextHand(g);
        break;
      case 'newGame': {
        const fresh = newTableState(state.seats);
        Object.assign(state, fresh, { version: state.version });
        break;
      }
      default: return false;
    }
  } catch (e) {
    if (!(e instanceof G.IllegalMove)) console.error(e);
    return false;
  }
  state.version += 1;
  return true;
}

/** The next thing the host should do on its own, with how long to wait first: a bot's
 *  turn ({ seat, style }) or a move ({ move }) — or null when it's waiting on a person. */
export function nextHostStep(state) {
  if (state.paused) return null;
  const g = state.game;
  const isBot = (s) => state.seats[s].kind === 'bot';
  switch (g.phase) {
    case 'bidding': case 'kitty': case 'playing': {
      const s = g.turn;
      if (!isBot(s)) return null;
      let delay = PACE.bot;
      // Wait for the kitty to be turned up, or a finished trick to slide away.
      if (g.phase === 'kitty') delay = kittyReveal();
      else if (g.phase === 'playing' && !g.trick.length && g.lastTrick.length) delay = trickLinger() + PACE.bot / 2;
      return { delay, seat: s, style: g.botStyles[s] || 'steady' };
    }
    case 'handOver':
      // A table of only bots (for testing) moves straight on.
      if (!peopleSeats(state).length) return { delay: PACE.autoNext, move: { type: 'deal', hand: g.handNumber } };
      if (g.continueDeadline) return { delay: Math.max(0, g.continueDeadline - Date.now()), move: { type: 'deal', hand: g.handNumber } };
      return null;
    default:
      return null;
  }
}

/** Runs the host's steps: a bot thinks (in the background) while the pause runs, and its
 *  move is played once both are done — unless the table moved on in the meantime. */
export class Pacer {
  constructor(onMove) {
    this.onMove = onMove;
    this.token = 0;
    this.timer = null;
  }

  schedule(state) {
    this.cancel();
    const step = nextHostStep(state);
    if (!step) return;
    const token = this.token, due = Date.now() + step.delay;
    const move = step.move ? Promise.resolve(step.move)
      : think(state.game, step.seat, step.style).then((m) => ({ ...m, seat: step.seat }));
    move.then((m) => {
      if (token !== this.token) return;
      this.timer = setTimeout(() => { if (token === this.token) this.onMove(m); }, Math.max(0, due - Date.now()));
    });
  }

  cancel() { this.token += 1; clearTimeout(this.timer); }
}

/** Runs a table on this device (the host). `onState` gets every new state. */
export class LocalHost {
  constructor(state, onState) {
    this.state = state;
    this.onState = onState;
    this.pacer = new Pacer((move) => this.send(move));
    this.publish();
  }

  /** A move from a person at this table (or a bot, through the pacer). */
  send(move) {
    if (applyMove(this.state, move)) this.publish();
  }

  publish() {
    this.onState(this.state);
    this.pacer.schedule(this.state);
  }

  stop() { this.pacer.cancel(); }
}
