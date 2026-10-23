// The rules, and whole games of the real bots through the table code.
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/engine.test.js
import * as G from '../js/game.js';
import { card, JOKER, SPADES, CLUBS, DIAMONDS, HEARTS, NO_TRUMPS, JACK, FULL_DECK, isTrump, power, effectiveSuit, bidValue } from '../js/cards.js';
import { Bot } from '../js/bot.js';
import { newTableState, applyMove } from '../js/table.js';

let checks = 0, failures = 0;
function check(ok, what) { checks++; if (!ok) { failures++; print('FAIL ' + what); } }
const throws = (f) => { try { f(); return false; } catch (e) { return e instanceof G.IllegalMove; } };
const S = (r) => card(SPADES, r), C = (r) => card(CLUBS, r), D = (r) => card(DIAMONDS, r), H = (r) => card(HEARTS, r);

/** A hand in play: `contract` by `contractor`, `turn` to lead. */
function playing(hands, contract, contractor, turn, extra = {}) {
  const g = G.newGame(3, FULL_DECK.slice());
  Object.assign(g, { hands, kitty: [], highBid: contract, contractor, phase: 'playing', turn }, extra);
  return g;
}

// The deck and the bowers.
check(FULL_DECK.length === 45 && new Set(FULL_DECK).size === 45, '45 cards');
check(isTrump(D(JACK), HEARTS) && effectiveSuit(D(JACK), HEARTS) === HEARTS, 'left bower is a trump');
check(power(H(JACK), HEARTS) === 29 && power(D(JACK), HEARTS) === 28 && power(JOKER, HEARTS) === 30, 'bower order');
check(!isTrump(D(JACK), NO_TRUMPS) && effectiveSuit(JOKER, NO_TRUMPS) === null, 'no bowers in No Trumps');
check(bidValue({ tricks: 6, trump: SPADES }) === 40 && bidValue({ tricks: 10, trump: NO_TRUMPS }) === 520 && bidValue({ tricks: 8, trump: HEARTS }) === 300, 'bid values');

// The deal: 10 each and 5 in the kitty; everyone has a face card.
for (let i = 0; i < 50; i++) {
  const g = G.newGame();
  check(g.hands.every((h) => h.length === 10) && g.kitty.length === 5, 'deal sizes');
  check(g.hands.every((h) => h.some((c) => c === JOKER || [11, 12, 13].includes(c % 100))), 'face card in every hand');
  check(g.turn === (g.dealer + 1) % 4, 'left of the dealer bids first');
}
{
  // A deal where someone has no face card is thrown in by the same dealer.
  const deck = FULL_DECK.slice().sort((a, b) => (a % 100 >= 11 ? 1 : 0) - (b % 100 >= 11 ? 1 : 0));
  const g = G.newGame(2, deck);
  check(g.noFaceThrowIns >= 1 && g.dealer === 2 && g.noFaceSeat !== null, 'no-face deal thrown in, same dealer');
}

// Bidding.
{
  const g = G.newGame(3);
  check(g.turn === 0, 'seat 0 first');
  G.apply(g, { type: 'bid', bid: { tricks: 7, trump: HEARTS } }, 0);
  check(throws(() => G.apply(g, { type: 'bid', bid: { tricks: 7, trump: DIAMONDS } }, 1)), 'must outbid');
  G.apply(g, { type: 'bid', bid: { tricks: 7, trump: NO_TRUMPS } }, 1);
  G.apply(g, { type: 'pass' }, 2);
  G.apply(g, { type: 'pass' }, 3);
  check(g.turn === 0, 'skips passed players');
  G.apply(g, { type: 'pass' }, 0);
  check(G.standing(g) && g.turn === 1, 'the others passed: the high bidder may raise');
  G.apply(g, { type: 'bid', bid: { tricks: 8, trump: NO_TRUMPS } }, 1);
  check(G.standing(g), 'still standing after raising');
  G.apply(g, { type: 'pass' }, 1);
  check(g.phase === 'kitty' && g.contractor === 1 && g.highBid.tricks === 8 && g.revealedKitty.length === 5, 'keeping the bid ends the bidding');
  const pool = g.hands[1].concat(g.kitty);
  check(throws(() => G.apply(g, { type: 'discard', cards: pool.slice(0, 4) }, 1)), 'throw back exactly five');
  G.apply(g, { type: 'discard', cards: pool.slice(0, 5) }, 1);
  check(g.phase === 'playing' && g.turn === 1 && g.hands[1].length === 10 && g.discarded.length === 5, 'contractor leads after throwing back');
}
{
  const g = G.newGame(0);
  for (const s of [1, 2, 3, 0]) G.apply(g, { type: 'pass' }, s);
  check(g.phase === 'bidding' && g.dealer === 1 && g.redeals === 1 && g.calls.length === 0 && g.turn === 2, 'four passes: next dealer deals again');
}

// Tricks: follow suit (the left bower follows trumps), the Joker, No Trumps.
{
  const g = playing([[D(JACK), D(9), C(4), S(5), S(6), S(7), S(8), S(9), S(10), S(11)],
    [H(5), C(5), C(6), C(7), C(8), C(9), C(10), C(11), C(12), C(13)],
    [H(14), D(4), D(5), D(6), D(7), D(8), D(10), C(14), D(12), D(13)],
    [JOKER, H(4), H(6), H(7), H(8), H(9), H(10), H(11), H(12), H(13)]], { tricks: 6, trump: HEARTS }, 3, 1);
  G.apply(g, { type: 'play', card: H(5) }, 1);
  check(JSON.stringify(G.legalPlays(g, 2)) === JSON.stringify([H(14)]), 'follow trumps');
  G.apply(g, { type: 'play', card: H(14) }, 2);
  G.apply(g, { type: 'play', card: H(11) }, 3);
  check(JSON.stringify(G.legalPlays(g, 0)) === JSON.stringify([D(JACK)]), 'the left bower must follow trumps');
  G.apply(g, { type: 'play', card: D(JACK) }, 0);
  check(g.lastTrickWinner === 3 && g.tricksWon[3] === 1 && g.turn === 3, 'right bower beats left bower and ace');
}
{
  // No Trumps: the Joker led names a suit not yet led, and wins.
  const g = playing([[JOKER, S(14), S(4), S(5), S(6), S(7), S(8), S(9), S(10), S(11)],
    [C(4), C(5), C(6), C(7), C(8), C(9), C(10), C(11), C(12), C(13)],
    [H(14), D(4), D(5), D(6), D(7), D(8), D(10), D(11), D(12), D(13)],
    [H(4), H(5), H(6), H(7), H(8), H(9), H(10), H(11), H(12), H(13)]], { tricks: 6, trump: NO_TRUMPS }, 0, 0);
  check(throws(() => G.apply(g, { type: 'play', card: JOKER, jokerSuit: null }, 0)), 'the Joker lead must name a suit');
  G.apply(g, { type: 'play', card: JOKER, jokerSuit: CLUBS }, 0);
  G.apply(g, { type: 'play', card: C(13) }, 1);
  check(G.ledSuit(g) === CLUBS && JSON.stringify(G.legalPlays(g, 2)) === JSON.stringify(g.hands[2]), 'named suit is led; void may play anything');
  G.apply(g, { type: 'play', card: H(14) }, 2);
  G.apply(g, { type: 'play', card: H(4) }, 3);
  check(g.lastTrickWinner === 0 && g.voids[2].includes(CLUBS), 'the Joker wins in No Trumps; voids noted');
  check(!G.jokerLeadSuits({ ...g, turn: 0 }).includes(CLUBS), 'clubs already led');
}
{
  // In No Trumps the Joker may be played on another lead only when void.
  const g = playing([[S(4), S(5), S(6), S(7), S(8), S(9), S(10), S(11), S(12), S(13)],
    [JOKER, S(14), C(5), C(6), C(7), C(8), C(9), C(10), C(11), C(12)],
    [D(4), D(5), D(6), D(7), D(8), D(9), D(10), D(11), D(12), D(13)],
    [H(4), H(5), H(6), H(7), H(8), H(9), H(10), H(11), H(12), H(13)]], { tricks: 6, trump: NO_TRUMPS }, 0, 0);
  G.apply(g, { type: 'play', card: S(4) }, 0);
  check(JSON.stringify(G.legalPlays(g, 1)) === JSON.stringify([S(14)]), 'the Joker can’t be played while you can follow');
}

// Scoring.
function scored(contract, tricks, scores = [0, 0]) {
  // Team 0 bid `contract` (seat 0) and took `tricks`; play out a hand by hand.
  const g = playing([[], [], [], []], contract, 0, 0, { scores: scores.slice(), tricksWon: [tricks, 10 - tricks, 0, 0] });
  // Nine tricks already taken; seat 3 (team 1) wins the last one.
  g.hands = [[S(4)], [S(5)], [S(6)], [S(7)]];
  g.tricksWon = [tricks, 0, 0, 10 - tricks - 1];
  for (const s of [0, 1, 2, 3]) G.apply(g, { type: 'play', card: g.hands[s][0] }, s);
  return g;
}
{
  let g = scored({ tricks: 7, trump: HEARTS }, 8);
  check(g.result.made && g.scores[0] === 200 && g.scores[1] === 20, 'made: bid value; defenders 10 a trick');
  g = scored({ tricks: 8, trump: SPADES }, 7);
  check(!g.result.made && g.scores[0] === -240 && g.scores[1] === 30, 'set: minus the value');
  g = scored({ tricks: 6, trump: SPADES }, 9, [480, 0]);
  check(!g.result.slam && g.phase === 'gameOver' && g.winner === 0 && g.scores[0] === 520, 'making it past 500 wins');
  g = scored({ tricks: 8, trump: HEARTS }, 6, [0, 480]);
  check(g.phase === 'gameOver' && g.winner === 1, 'defending points count toward 500');
  g = scored({ tricks: 7, trump: HEARTS }, 8, [300, 490]);
  check(g.phase === 'gameOver' && g.winner === 0, 'both past 500: the bidders win');
  g = scored({ tricks: 9, trump: HEARTS }, 6, [-200, 0]);
  check(g.phase === 'gameOver' && g.winner === 1 && g.scores[0] <= -500, 'out the back door');
}
{
  // A slam: all ten tricks are worth at least 250.
  const g = playing([[S(4)], [S(5)], [S(6)], [S(7)]], { tricks: 6, trump: SPADES }, 3, 0, { tricksWon: [0, 4, 0, 5] });
  for (const s of [0, 1, 2, 3]) G.apply(g, { type: 'play', card: g.hands[s][0] }, s);
  check(g.result.slam && g.scores[1] === 250 && g.scores[0] === 0, 'slam worth 250');
}

// Next Hand waits for every person; the first tap starts 30 seconds.
{
  const g = scored({ tricks: 7, trump: HEARTS }, 8);
  g.humanSeats = [0, 2];
  G.markContinued(g, 0, 1000);
  check(g.phase === 'handOver' && g.continueDeadline === 1000 + G.CONTINUE_WAIT, 'waits for the other person');
  G.markContinued(g, 2);
  check(g.phase === 'bidding' && g.handNumber === 1 && g.dealer === 0, 'next hand once everyone has; deal passes left');
}

// Whole games of the real bots (Experts, a style each) through the table code.
for (let n = 0; n < 2; n++) {
  const state = newTableState([0, 1, 2, 3].map((i) => ({ kind: 'bot', name: 'B' + i })));
  let steps = 0;
  const started = Date.now();
  while (state.game.phase !== 'gameOver' && steps < 3000) {
    const g = state.game;
    steps++;
    if (g.phase === 'handOver') { applyMove(state, { type: 'deal', hand: g.handNumber }); continue; }
    const s = g.turn;
    const move = new Bot({ style: g.botStyles[s], skill: 'expert' }).move(g, s);
    if (!applyMove(state, { ...move, seat: s })) { check(false, `bot move refused: ${JSON.stringify(move)} in ${g.phase}`); break; }
  }
  const g = state.game;
  check(g.phase === 'gameOver' && g.winner !== null, 'a whole bot game finishes');
  check(g.history.reduce((n, h) => n + h.tricks[0] + h.tricks[1], 0) === 10 * g.history.length, 'ten tricks a hand');
  print(`  bot game ${n + 1}: ${g.history.length} hands, ${g.scores.join('–')}, ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

print(`${checks} checks, ${failures} failures`);
