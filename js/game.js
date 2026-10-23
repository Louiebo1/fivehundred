// Four-player partnership Five Hundred, ported from the app's `FiveHundredGame` (the
// Australian rules from pagat.com with Louie's family's deck and rules, no misère). Seats
// 0–3 clockwise: South, West, North, East; partners sit opposite (0 & 2 are team 0, 1 & 3
// team 1). The state is plain JSON; moves that break the rules throw `IllegalMove`.
//
// 45 cards (A–4 in every suit, one Joker); 10 each and a 5-card kitty. A deal where any
// hand has no face card (J, Q, K or the Joker) is thrown in and the same dealer deals again.
// Bidding goes clockwise from the dealer's left; each bid must outrank the last (more
// tricks, or the same with a higher suit: ♠ ♣ ♦ ♥ NT); a pass is final. Once the other
// three have passed, the high bidder may raise their own bid or keep it (passing then means
// keeping it). Four passes: the deal passes on and the cards are dealt again. The kitty is
// turned face up for everyone; the contractor keeps it beside their hand, throws back any
// five of the fifteen face down, and leads. Trumps: Joker, right bower, left bower, A K Q
// 10 9 … In No Trumps the Joker wins any trick; it may be played on another lead only when
// void, and when led its player names a suit not yet led (any suit on the last trick).
//
// Scoring: the contractors score the bid's value if they make it (all ten tricks are worth
// at least 250) or lose it if they don't; the defenders score 10 a trick. ANY side reaching
// 500 wins, defending points included (if both pass 500 on the same hand, the side that
// made the bid wins); a side at −500 loses.

import { FULL_DECK, JOKER, SUITS, NO_TRUMPS, shuffled, isFaceCard, effectiveSuit, isTrump, power, bidAbove, bidValue } from './cards.js';

export const TARGET = 500, BACK_DOOR = -500, SLAM_VALUE = 250, HAND_SIZE = 10, KITTY_SIZE = 5;
export const CONTINUE_WAIT = 30000;

export class IllegalMove extends Error {}
const illegal = () => { throw new IllegalMove('illegal move'); };

export const team = (seat) => seat % 2;
export const partner = (seat) => (seat + 2) % 4;

/** A new game. `deck` is the first deal's order (shuffled if not given). */
export function newGame(dealer = Math.floor(Math.random() * 4), deck = shuffled(), random = Math.random) {
  const g = {
    scores: [0, 0], dealer, handNumber: 0, phase: 'bidding', turn: 0,
    hands: [[], [], [], []], kitty: [], revealedKitty: [], discarded: [],
    calls: [], passed: [], highBid: null, contractor: null, redeals: 0, noFaceThrowIns: 0, noFaceSeat: null,
    trick: [], jokerSuit: null, tricksWon: [0, 0, 0, 0], played: [], lastTrick: [], lastTrickWinner: null,
    voids: [[], [], [], []], suitsLed: [],
    result: null, history: [], winner: null,
    humanSeats: [0], botStyles: {}, continued: null, continueDeadline: null,
  };
  deal(g, deck, random);
  return g;
}

/** A copy to try things on (the bots' look-ahead copies a lot, so this is by hand). */
export function copyGame(g) {
  return {
    ...g,
    scores: g.scores.slice(), hands: g.hands.map((h) => h.slice()), kitty: g.kitty.slice(),
    revealedKitty: g.revealedKitty.slice(), discarded: g.discarded.slice(), calls: g.calls.slice(),
    passed: g.passed.slice(), trick: g.trick.slice(), tricksWon: g.tricksWon.slice(), played: g.played.slice(),
    lastTrick: g.lastTrick.slice(), voids: g.voids.map((v) => v.slice()), suitsLed: g.suitsLed.slice(),
    history: g.history.slice(), humanSeats: g.humanSeats.slice(), botStyles: { ...g.botStyles },
    continued: g.continued && g.continued.slice(),
  };
}

export const trumpOf = (g) => (g.phase === 'bidding' || !g.highBid ? null : g.highBid.trump);
export const contractTeam = (g) => (g.contractor === null ? null : team(g.contractor));
export const teamTricks = (g) => [g.tricksWon[0] + g.tricksWon[2], g.tricksWon[1] + g.tricksWon[3]];

// MARK: Dealing

function deal(g, deck, random = Math.random) {
  while (true) {
    g.hands = [[], [], [], []];
    for (let i = 0; i < HAND_SIZE * 4; i++) g.hands[(g.dealer + 1 + i) % 4].push(deck[i]);
    // Anyone without a face card throws the hand in, and the same dealer deals again.
    const seats = [0, 1, 2, 3].map((k) => (g.dealer + 1 + k) % 4);
    const bare = seats.find((s) => !g.hands[s].some(isFaceCard));
    if (bare === undefined) break;
    g.noFaceSeat = bare;
    g.noFaceThrowIns = (g.noFaceThrowIns || 0) + 1;
    deck = shuffled(FULL_DECK, random);
  }
  g.kitty = deck.slice(HAND_SIZE * 4, HAND_SIZE * 4 + KITTY_SIZE);
  Object.assign(g, {
    revealedKitty: [], discarded: [], calls: [], passed: [], highBid: null, contractor: null,
    trick: [], jokerSuit: null, tricksWon: [0, 0, 0, 0], played: [], lastTrick: [], lastTrickWinner: null,
    voids: [[], [], [], []], suitsLed: [], result: null, continued: null, continueDeadline: null,
    phase: 'bidding', turn: (g.dealer + 1) % 4,
  });
}

// MARK: Moves — { type: 'bid', bid } | { type: 'pass' } | { type: 'discard', cards } | { type: 'play', card, jokerSuit? }

export function canApply(g, move, seat) {
  try { apply(copyGame(g), move, seat); return true; } catch { return false; }
}

export function apply(g, move, seat, random = Math.random) {
  if (seat !== g.turn) illegal();
  if (g.phase === 'bidding' && move.type === 'bid') {
    const bid = move.bid;
    if (!bid || g.passed.includes(seat) || !(bid.tricks >= 6 && bid.tricks <= 10) || !(bid.trump >= 0 && bid.trump <= 4)
      || (g.highBid && !bidAbove(bid, g.highBid))) illegal();
    g.highBid = { tricks: bid.tricks, trump: bid.trump };
    g.contractor = seat;
    g.calls.push({ seat, bid: g.highBid });
    advanceBidding(g, seat, random);
  } else if (g.phase === 'bidding' && move.type === 'pass' && standing(g)) {
    settleBidding(g);                                   // The high bidder keeps their bid.
  } else if (g.phase === 'bidding' && move.type === 'pass') {
    if (g.passed.includes(seat)) illegal();
    g.passed.push(seat);
    g.calls.push({ seat, bid: null });
    advanceBidding(g, seat, random);
  } else if (g.phase === 'kitty' && move.type === 'discard') {
    const pool = g.hands[seat].concat(g.kitty), cards = move.cards || [];
    if (seat !== g.contractor || cards.length !== KITTY_SIZE || new Set(cards).size !== KITTY_SIZE
      || !cards.every((c) => pool.includes(c))) illegal();
    g.hands[seat] = pool.filter((c) => !cards.includes(c));
    g.kitty = [];
    g.discarded = cards.slice();
    g.phase = 'playing';
    g.turn = seat;
  } else if (g.phase === 'playing' && move.type === 'play') {
    play(g, move.card, move.jokerSuit ?? null, seat);
  } else illegal();
}

function advanceBidding(g, seat, random) {
  if (g.passed.length === 4) {
    // Everyone passed: throw the cards in and deal again.
    g.redeals += 1;
    g.dealer = (g.dealer + 1) % 4;
    deal(g, shuffled(FULL_DECK, random), random);
    return;
  }
  if (g.contractor !== null && g.passed.length === 3) {
    // The others are out: the high bidder may raise their own bid, or keep it.
    g.turn = g.contractor;
    return;
  }
  let next = (seat + 1) % 4;
  while (g.passed.includes(next)) next = (next + 1) % 4;
  g.turn = next;
}

/** The other three have passed and it's the high bidder's turn: raise, or keep the bid. */
export const standing = (g) => g.phase === 'bidding' && g.passed.length === 3 && g.contractor !== null && g.turn === g.contractor;

function settleBidding(g) {
  g.redeals = 0;
  g.revealedKitty = g.kitty.slice();
  g.phase = 'kitty';
  g.turn = g.contractor;
}

// MARK: Tricks

/** The suit led to the current trick (null when nothing is led yet, or an unnamed Joker). */
export function ledSuit(g) {
  const trump = trumpOf(g);
  if (!g.trick.length || trump === null) return null;
  return effectiveSuit(g.trick[0].card, trump, g.jokerSuit);
}

/** The cards `seat` may play now. */
export function legalPlays(g, seat) {
  const trump = trumpOf(g);
  if (g.phase !== 'playing' || seat !== g.turn || trump === null) return [];
  const hand = g.hands[seat];
  const led = ledSuit(g);
  if (led === null) {
    // Leading. In No Trumps the Joker needs a suit not yet led, unless it's the last trick.
    if (trump === NO_TRUMPS && hand.includes(JOKER) && !(hand.length === 1 || g.suitsLed.length < 4)) {
      return hand.filter((c) => c !== JOKER);
    }
    return hand.slice();
  }
  const following = hand.filter((c) => effectiveSuit(c, trump) === led);
  return following.length ? following : hand.slice();
}

/** The suits that may be named when leading the Joker in No Trumps. */
export function jokerLeadSuits(g) {
  const hand = g.hands[g.turn];
  if (!hand) return [];
  if (hand.length === 1) return SUITS.slice();
  return SUITS.filter((s) => !g.suitsLed.includes(s));
}

function play(g, c, named, seat) {
  const trump = trumpOf(g);
  if (trump === null || !legalPlays(g, seat).includes(c)) illegal();
  if (!g.trick.length) {
    g.jokerSuit = null;
    if (c === JOKER && trump === NO_TRUMPS) {
      if (named === null || !jokerLeadSuits(g).includes(named)) illegal();
      g.jokerSuit = named;
    }
  } else {
    const led = ledSuit(g);
    if (led !== null && effectiveSuit(c, trump) !== led && !g.voids[seat].includes(led)) g.voids[seat].push(led);
  }
  g.hands[seat] = g.hands[seat].filter((x) => x !== c);
  g.trick.push({ seat, card: c });
  g.played.push({ seat, card: c });
  if (g.trick.length === 1) {
    const led = ledSuit(g);
    if (led !== null && !g.suitsLed.includes(led)) g.suitsLed.push(led);
  }
  if (g.trick.length < 4) { g.turn = (seat + 1) % 4; return; }
  const winner = trickWinner(g, g.trick, trump);
  g.tricksWon[winner] += 1;
  g.lastTrick = g.trick;
  g.lastTrickWinner = winner;
  g.trick = [];
  g.turn = winner;
  if (g.hands.every((h) => h.length === 0)) scoreHand(g);
}

/** Who wins these plays: the Joker in No Trumps; else the best trump; else the best of the led suit. */
export function trickWinner(g, plays, trump) {
  if (trump === NO_TRUMPS) { const j = plays.find((p) => p.card === JOKER); if (j) return j.seat; }
  const led = effectiveSuit(plays[0].card, trump, g.jokerSuit);
  const strength = (p) => {
    if (isTrump(p.card, trump)) return 1000 + power(p.card, trump);
    if (effectiveSuit(p.card, trump, g.jokerSuit) === led) return power(p.card, trump);
    return 0;
  };
  let best = plays[0], top = strength(best);
  for (let i = 1; i < plays.length; i++) { const s = strength(plays[i]); if (s > top) { best = plays[i]; top = s; } }
  return best.seat;
}

/** Who is winning the trick so far. */
export function currentWinner(g) {
  const trump = trumpOf(g);
  return g.trick.length && trump !== null ? trickWinner(g, g.trick, trump) : null;
}

// MARK: Scoring

function scoreHand(g) {
  const contract = g.highBid, contractor = g.contractor;
  if (!contract || contractor === null) return;
  const t = team(contractor), other = 1 - t;
  const tricks = teamTricks(g);
  const made = tricks[t] >= contract.tricks, slam = tricks[t] === 10;
  const points = [0, 0];
  points[t] = made ? (slam ? Math.max(bidValue(contract), SLAM_VALUE) : bidValue(contract)) : -bidValue(contract);
  points[other] = 10 * tricks[other];
  g.scores[t] += points[t];
  g.scores[other] += points[other];
  g.result = { contract, contractor, tricks, made, slam, points };
  g.history.push(g.result);
  g.phase = 'handOver';
  if (made && g.scores[t] >= TARGET) g.winner = t;                 // The bidders win if both sides pass 500.
  else if (g.scores[other] >= TARGET) g.winner = other;            // Defending points count toward 500.
  else if (g.scores[t] <= BACK_DOOR) g.winner = other;
  if (g.winner !== null) g.phase = 'gameOver';
}

/** A person taps Continue after a hand: the next hand is dealt once everyone has (bots
 *  don't need to). The first tap starts the others' 30 seconds. */
export function markContinued(g, seat, now = Date.now(), random = Math.random) {
  if (g.phase !== 'handOver') illegal();
  const ready = (g.continued || []).slice();
  if (!ready.includes(seat)) ready.push(seat);
  if (g.humanSeats.every((s) => ready.includes(s))) { nextHand(g, shuffled(FULL_DECK, random), random); return; }
  g.continued = ready;
  if (g.continueDeadline === null) g.continueDeadline = now + CONTINUE_WAIT;
}

/** Deals the next hand; the deal passes to the left. */
export function nextHand(g, deck = shuffled(), random = Math.random) {
  if (g.phase !== 'handOver') illegal();
  g.dealer = (g.dealer + 1) % 4;
  g.handNumber += 1;
  deal(g, deck, random);
}

// MARK: For the bots' look-ahead

/** The same game with the hidden cards replaced — every hand, the kitty, and the
 *  contractor's discards. */
export function determinized(g, hands, kitty, discarded) {
  const copy = copyGame(g);
  copy.hands = hands.map((h) => h.slice());
  copy.kitty = kitty.slice();
  copy.discarded = discarded.slice();
  return copy;
}

/** A practice contract during the bidding: as if `seat` had won with `bid`; the kitty is theirs. */
export function practiceContract(g, bid, seat, hands, kitty) {
  const copy = copyGame(g);
  copy.hands = hands.map((h) => h.slice());
  copy.kitty = kitty.slice();
  copy.revealedKitty = kitty.slice();
  copy.highBid = bid;
  copy.contractor = seat;
  copy.phase = 'kitty';
  copy.turn = seat;
  return copy;
}

export { bidValue };
