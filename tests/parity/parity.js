// Replays the app's games (from tests/parity/main.swift) on the web version: every bid,
// throw-back and play the web bots choose — given the same position and the same random
// numbers — and every hand's result must match the app's.
//   jsc tests/args.js -m tests/parity/parity.js -- /tmp/fh_parity/games.jsonl [EVERY]
// EVERY: check only every Nth decision (the rest are just replayed), for a quicker run.
import * as G from '../../js/game.js';
import { Bot, bestDiscard, BID_SAMPLES } from '../../js/bot.js';

const [file = '/tmp/fh_parity/games.jsonl', everyArg = '1'] = globalThis.scriptArgs || [];
const every = Number(everyArg) || 1;
const lines = readFile(file).split('\n').filter(Boolean).map((l) => JSON.parse(l));

// The app's SplitMix64, with Swift's Int.random(in:) (Lemire's method) and Double.random.
const MASK = (1n << 64n) - 1n;
function splitMix(seed) {
  let state = BigInt(seed);
  const next = () => {
    state = (state + 0x9E3779B97F4A7C15n) & MASK;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK;
    return z ^ (z >> 31n);
  };
  return {
    below(n) {
      const bound = BigInt(n);
      let m = next() * bound;
      if ((m & MASK) < bound) {
        const t = ((1n << 64n) - bound) % bound;
        while ((m & MASK) < t) m = next() * bound;
      }
      return Number(m >> 64n);
    },
    unit: () => Number(next() >> 11n) * 2 ** -53,
  };
}

const decode = (m) => (m.type === 'bid' ? { type: 'bid', bid: { tricks: m.tricks, trump: m.trump } }
  : m.type === 'discard' ? { type: 'discard', cards: m.cards }
    : m.type === 'play' ? { type: 'play', card: m.card, jokerSuit: m.jokerSuit } : { type: 'pass' });
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
function same(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'bid') return a.bid.tricks === b.bid.tricks && a.bid.trump === b.bid.trump;
  if (a.type === 'discard') return sameSet(a.cards, b.cards);
  if (a.type === 'play') return a.card === b.card && (a.jokerSuit ?? null) === (b.jokerSuit ?? null);
  return true;
}

let g = null, styles = null, games = 0, hands = 0, checked = 0, ties = 0, bad = 0, n = 0;
const counts = { bid: 0, pass: 0, discard: 0, play: 0 };
const fail = (what, a, b) => { if (bad++ < 15) print(`DIFF ${what}: app ${JSON.stringify(a)} web ${JSON.stringify(b)}`); };
const started = Date.now();

for (const r of lines) {
  if (r.kind === 'game') { games++; styles = r.styles; g = null; continue; }
  if (r.kind === 'deal') {
    if (!g) g = G.newGame(r.dealer);
    else if (g.phase === 'handOver') G.nextHand(g);
    if (g.dealer !== r.dealer || g.phase !== 'bidding') fail('deal', r.dealer, [g.dealer, g.phase]);
    g.hands = r.hands.map((h) => h.slice());
    g.kitty = r.kitty.slice();
    continue;
  }
  if (r.kind === 'result') {
    hands++;
    const res = g.result;
    const mine = res && { made: res.made, points: res.points, tricks: res.tricks, scores: g.scores, phase: g.phase, winner: g.winner };
    const app = { made: r.made, points: r.points, tricks: r.tricks, scores: r.scores, phase: r.phase, winner: r.winner };
    if (JSON.stringify(mine) !== JSON.stringify(app)) fail('result', app, mine);
    continue;
  }
  // A move: what would the web bot do here with the same random numbers?
  const app = decode(r.move);
  if (g.turn !== r.seat) fail('turn', r.seat, g.turn);
  if (n++ % every === 0) {
    checked++;
    counts[app.type]++;
    const bot = new Bot({ style: styles[r.seat], skill: 'expert' });
    if (g.phase === 'kitty') {
      // The app takes the suits to empty in a Dictionary's order, so on a tie it may pick
      // another of the equally good throw-backs. Ties are counted, not failed.
      const out = {};
      const mine = bestDiscard(g, r.seat, BID_SAMPLES, splitMix(r.seed), out);
      if (!sameSet(mine, app.cards)) {
        const i = out.options.findIndex((o) => sameSet(o, app.cards));
        if (i >= 0 && out.totals[i] === Math.max(...out.totals)) ties++;
        else fail(`discard (${r.seed})`, app.cards, mine);
      }
    } else {
      const mine = bot.move(g, r.seat, splitMix(r.seed));
      if (!same(app, mine)) fail(`${g.phase} seat ${r.seat} ${styles[r.seat]} (${r.seed})`, app, mine);
    }
  }
  try { G.apply(g, app, r.seat); } catch (e) { fail('apply', app, String(e)); }
}
print(`${games} games, ${hands} hands, ${checked} decisions checked (${counts.bid} bids, ${counts.pass} passes, ${counts.discard} throw-backs, ${counts.play} plays), ${ties} tied throw-backs: ${bad ? bad + ' differences' : 'all identical'} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
