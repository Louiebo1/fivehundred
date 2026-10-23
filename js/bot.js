// The bots, ported from the app's `Bot` and `Search` (2026-10-18). A bot sees only its own
// hand, the bidding, the cards played, which suits players have shown out of, the kitty
// that was turned up, and its own discards if it took the kitty.
//
// Experts look ahead: they imagine many deals of the cards they can't see, consistent with
// all of that, play each one out with quick rule-of-thumb play (a Steady bot that doesn't
// look ahead), and choose the bid, throw-back or card that does best. Every bot at the web
// table is an Expert with a secret style (Louie, 2026-10-23).
//
// Randomness comes from `rng` ({ below(n), unit() }), so the parity check can feed in the
// same generator as the app and get the very same decisions.

import { FULL_DECK, JOKER, SUITS, TRUMPS, NO_TRUMPS, ALL_BIDS, rankOf, suitOf, trumpSuit, effectiveSuit, isTrump, power, bidAbove, bidValue } from './cards.js';
import * as G from './game.js';

export const STYLES = {
  steady: { title: 'Steady', blurb: 'Bids what its hand is worth and plays by the book.', confidence: 0.52 },
  cautious: { title: 'Cautious', blurb: 'Bids low and plays safe. Rarely goes set.', confidence: 0.62 },
  aggressive: { title: 'Aggressive', blurb: 'Bids high, counts on the kitty, pulls trumps and chases slams.', confidence: 0.42 },
  teamPlayer: { title: 'Team Player', blurb: 'Supports its partner: raises their suit, never outbids them, leads their suit back.', confidence: 0.52 },
  gambler: { title: 'Gambler', blurb: 'Loves No Trumps and long shots. Unpredictable.', confidence: 0.45 },
};
export const STYLE_NAMES = Object.keys(STYLES);

/** Math.random as the bots' generator. */
export const mathRandom = { below: (n) => Math.floor(Math.random() * n), unit: () => Math.random() };

// Swift's shuffle and randomElement, so a seeded generator gives the app's results.
function shuffle(list, rng) {
  const a = list.slice();
  for (let i = 0, amount = a.length; amount > 1; i++) {
    const j = i + rng.below(amount);
    amount -= 1;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const randomElement = (list, rng) => (list.length ? list[rng.below(list.length)] : undefined);

// Swift's min(by:) and max(by:): the first of equals wins.
function minBy(list, key) {
  let best, top = Infinity;
  for (const x of list) { const k = key(x); if (k < top) { best = x; top = k; } }
  return best;
}
function maxBy(list, key) {
  let best, top = -Infinity;
  for (const x of list) { const k = key(x); if (k > top) { best = x; top = k; } }
  return best;
}
const sortedBy = (list, key) => list.map((x, i) => [key(x), i, x]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((e) => e[2]);

export class Bot {
  constructor({ style = 'steady', skill = 'expert', thinks = true, cheapTies = true } = {}) {
    this.style = style;
    this.skill = skill;
    this.thinks = thinks;
    this.cheapTies = cheapTies;
  }

  /** How sure the style must be of making a bid before it bids it. */
  get confidence() { return 0 + STYLES[this.style].confidence; }
  get searching() { return this.thinks && this.skill === 'expert'; }

  move(game, seat, rng = mathRandom) {
    switch (game.phase) {
      case 'bidding': return this.searching ? this.searchBid(game, seat, rng) : this.bid(game, seat, rng);
      case 'kitty': {
        if (this.searching) {
          const cards = bestDiscard(game, seat, BID_SAMPLES, rng);
          if (cards) return { type: 'discard', cards };
        }
        return { type: 'discard', cards: this.discards(game.hands[seat].concat(game.kitty), game.highBid.trump) };
      }
      case 'playing': return this.play(game, seat, rng);
      default: return { type: 'pass' };
    }
  }

  // MARK: Bidding

  /** Bids from the look-ahead: for each bid it could make, how often the team would take
   *  that many tricks; it bids the one worth the most on average (made value × odds minus
   *  set value × the rest), if it's sure enough for its style. */
  searchBid(game, seat, rng) {
    const odds = trickOdds(game, seat, BID_SAMPLES, rng);
    const partnerHolds = game.contractor === G.partner(seat);
    let best = null;
    for (const bid of ALL_BIDS) {
      if (game.highBid && !bidAbove(bid, game.highBid)) continue;
      if (!odds) continue;
      let p = odds[bid.trump][bid.tricks - 6];
      if (this.style === 'gambler' && bid.trump === NO_TRUMPS) p = Math.min(1, p + 0.08);
      let need = this.confidence;
      if (G.standing(game)) need = Math.max(need, 0.75);                // Raising myself: only if it's safe.
      if (partnerHolds) {
        // Taking the bid off my partner needs a better reason.
        const raisingTheirSuit = bid.trump === game.highBid?.trump;
        if (this.style === 'teamPlayer' && !raisingTheirSuit) continue;
        need += raisingTheirSuit ? 0.05 : 0.15;
      }
      if (!(p >= need)) continue;
      const value = bidValue(bid) * (2 * p - 1);
      if (best === null || value > best.value) best = { bid, value };
    }
    return best ? { type: 'bid', bid: best.bid } : { type: 'pass' };
  }

  /** Tricks this hand should take with `trump`, counting on a little from the kitty and partner. */
  estimate(hand, trump) {
    let tricks = 0;
    const ts = trumpSuit(trump);
    if (ts !== null) {
      const trumps = hand.filter((c) => isTrump(c, trump)).sort((a, b) => power(b, trump) - power(a, trump));
      // Top trumps: Joker, right and left bower, A, K, Q (the lower ones count if long).
      let expected = 30;
      for (const c of trumps) {
        const p = power(c, trump);
        if (p === expected || p >= 28) tricks += p >= 28 ? 1 : 0.85;
        else if (p >= 12 && trumps.length >= 3) tricks += 0.45;
        expected = Math.min(expected, p) - 1;
      }
      tricks += Math.max(0, trumps.length - 3) * 0.8;
      // Side suits: aces, guarded kings, and ruffing chances when short.
      for (const suit of SUITS) {
        if (suit === ts) continue;
        const cards = hand.filter((c) => !isTrump(c, trump) && suitOf(c) === suit);
        if (cards.some((c) => rankOf(c) === 14)) tricks += 0.9;
        if (cards.some((c) => rankOf(c) === 13) && cards.length >= 2) tricks += 0.4;
        if (trumps.length >= 3) tricks += cards.length === 0 ? 0.6 : cards.length === 1 ? 0.3 : 0;
      }
    } else {
      // No Trumps: aces and the Joker are tricks, kings with company help, long suits run —
      // but an unguarded suit is a danger.
      if (hand.includes(JOKER)) tricks += 1;
      for (const suit of SUITS) {
        const ranks = hand.filter((c) => c !== JOKER && suitOf(c) === suit).map(rankOf).sort((a, b) => b - a);
        if (ranks.includes(14)) tricks += 1;
        if (ranks.includes(13) && ranks.length >= 2) tricks += ranks.includes(14) ? 0.9 : 0.5;
        if (ranks.includes(12) && ranks.length >= 3) tricks += 0.4;
        tricks += Math.max(0, ranks.length - 4) * 0.8;
        if (!ranks.length || ranks[0] < 12) tricks -= 0.6;
      }
    }
    return tricks + 0.6;     // The kitty.
  }

  /** Rule-of-thumb bidding (beginners). */
  bid(game, seat, rng) {
    // Everyone else has passed: the bots keep their bid rather than raise themselves.
    if (G.standing(game)) return { type: 'pass' };
    const hand = game.hands[seat];
    const partnerSeat = G.partner(seat);
    const partnerBids = game.calls.filter((c) => c.seat === partnerSeat && c.bid).map((c) => c.bid);
    const opponentBids = game.calls.filter((c) => G.team(c.seat) !== G.team(seat) && c.bid).map((c) => c.bid);
    const highIsPartner = game.contractor === partnerSeat;
    let best = null;
    for (const trump of TRUMPS) {
      let tricks = this.estimate(hand, trump);
      // The partner's tricks: about two, more if they've bid our suit or support it.
      let partnerTricks = 1.8;
      if (partnerBids.some((b) => b.trump === trump)) partnerTricks += 1.0;
      const last = partnerBids[partnerBids.length - 1];
      if (last && last.trump !== trump) partnerTricks -= 0.3;
      if (opponentBids.some((b) => b.trump === trump)) tricks -= 1.2;
      tricks += partnerTricks;
      switch (this.style) {
        case 'cautious': tricks -= 0.9; break;
        case 'aggressive': tricks += 0.7; break;
        case 'teamPlayer':
          if (partnerBids.some((b) => b.trump === trump)) tricks += 0.4; else if (partnerBids.length) tricks -= 0.5;
          break;
        case 'gambler':
          tricks += trump === NO_TRUMPS ? 1.0 : 0.3;
          tricks += -0.8 + 1.6 * rng.unit();
          break;
      }
      if (this.skill === 'beginner') tricks += -1.2 + 2.4 * rng.unit();
      const maxTricks = Math.min(10, Math.floor(tricks));
      if (maxTricks < 6) continue;
      // The cheapest legal bid with this trump, up to what the hand is worth.
      let bid = null;
      for (let t = 6; t <= maxTricks && !bid; t++) {
        const candidate = { tricks: t, trump };
        if (!game.highBid || bidAbove(candidate, game.highBid)) bid = candidate;
      }
      if (!bid) continue;
      const margin = tricks - bid.tricks + bidValue(bid) / 1000;
      if (best === null || margin > best.margin) best = { bid, margin };
    }
    if (!best) return { type: 'pass' };
    // Don't take the bid off a partner without a clear reason.
    if (highIsPartner && game.highBid) {
      const raise = best.bid.trump === game.highBid.trump;
      if (this.style === 'teamPlayer' && !raise) return { type: 'pass' };
      if (this.style === 'cautious') return { type: 'pass' };
      if (this.style !== 'teamPlayer' && !raise && best.bid.tricks <= game.highBid.tricks + 1) return { type: 'pass' };
    }
    return { type: 'bid', bid: best.bid };
  }

  // MARK: The kitty

  /** The five to throw back from the fifteen: keeps trumps, aces and kings; throws low
   *  cards, emptying short suits to make voids. */
  discards(hand, trump) {
    const keepValue = (c) => {
      if (c === JOKER) return 1000;
      if (isTrump(c, trump)) return 500 + power(c, trump);
      let value = rankOf(c);
      if (rankOf(c) === 14) value += 40;
      if (rankOf(c) === 13) value += 15;
      if (trumpSuit(trump) !== null) {
        // Short side suits are worth emptying.
        value += hand.filter((x) => !isTrump(x, trump) && suitOf(x) === suitOf(c)).length * 2.5;
      }
      return value;
    };
    return sortedBy(hand, keepValue).slice(0, G.KITTY_SIZE);
  }

  // MARK: Play

  play(game, seat, rng) {
    const legal = G.legalPlays(game, seat);
    const trump = G.trumpOf(game);
    if (trump === null || !legal.length) return { type: 'pass' };
    if (this.searching) {
      const move = bestPlay(game, seat, PLAY_SAMPLES, this.cheapTies, rng);
      if (move) return move;
    }
    if (this.skill === 'beginner' && rng.unit() < 0.25) {
      const c = randomElement(legal, rng);
      return { type: 'play', card: c, jokerSuit: this.jokerSuit(c, game, seat) };
    }
    if (this.style === 'gambler' && rng.unit() < 0.08) {
      const c = randomElement(legal, rng);
      return { type: 'play', card: c, jokerSuit: this.jokerSuit(c, game, seat) };
    }
    const c = game.trick.length === 0 ? this.lead(game, seat, legal, trump) : this.follow(game, seat, legal, trump);
    return { type: 'play', card: c, jokerSuit: this.jokerSuit(c, game, seat) };
  }

  jokerSuit(c, game, seat) {
    if (c !== JOKER || game.trick.length || G.trumpOf(game) !== NO_TRUMPS) return null;
    // Name the suit where we hold the most, to draw out the others' cards in it.
    const options = G.jokerLeadSuits(game);
    const count = (s) => game.hands[seat].filter((x) => x !== JOKER && suitOf(x) === s).length;
    return maxBy(options, count) ?? options[0] ?? null;
  }

  lead(game, seat, legal, trump) {
    const declaring = G.contractTeam(game) === G.team(seat);
    const partnerSeat = G.partner(seat);
    const out = unseen(game, seat);
    const trumpsOut = out.filter((c) => isTrump(c, trump)).length;
    const myTrumps = sortedBy(legal.filter((c) => isTrump(c, trump)), (c) => -power(c, trump));

    // Declarers pull trumps while the opponents may still hold some.
    if (declaring && trumpSuit(trump) !== null && myTrumps.length && trumpsOut > 0) {
      const pull = this.style === 'aggressive' || myTrumps.length >= 3 || seat === game.contractor;
      if (pull && !(this.style === 'cautious' && myTrumps.length <= 2)) {
        if (isBoss(myTrumps[0], out, trump)) return myTrumps[0];
        if (this.style === 'aggressive' || myTrumps.length >= 4) return myTrumps[myTrumps.length - 1];
      }
    }
    // A winner in a side suit.
    const bosses = legal.filter((c) => !isTrump(c, trump) && isBoss(c, out, trump));
    const boss = maxBy(bosses, (c) => power(c, trump));
    if (boss !== undefined) return boss;
    // The partner's bid suit (team players always try this first).
    const partnerCalls = game.calls.filter((c) => c.seat === partnerSeat && c.bid);
    const partnerBid = partnerCalls.length ? partnerCalls[partnerCalls.length - 1].bid : null;
    if (partnerBid && trumpSuit(partnerBid.trump) !== null && (partnerBid.trump !== trump || this.style === 'teamPlayer')) {
      const suit = partnerBid.trump;
      const inSuit = legal.filter((c) => effectiveSuit(c, trump) === suit && !isTrump(c, trump));
      const low = minBy(inSuit, (c) => power(c, trump));
      if (low !== undefined) return low;
    }
    // Otherwise lead low from the longest side suit: least likely to give a trick away.
    const side = legal.filter((c) => !isTrump(c, trump) && c !== JOKER);
    if (side.length) {
      let longest = null, length = -1;
      for (const s of SUITS) {
        const n = side.filter((c) => suitOf(c) === s).length;
        if (n && n >= length) { longest = s; length = n; }     // Ties: the higher suit, as the app.
      }
      return minBy(side.filter((c) => suitOf(c) === longest), (c) => power(c, trump));
    }
    return minBy(legal, (c) => power(c, trump));
  }

  follow(game, seat, legal, trump) {
    const partnerSeat = G.partner(seat);
    const lastToPlay = game.trick.length === 3;
    const winning = G.currentWinner(game);
    const out = unseen(game, seat);
    const winners = legal.filter((c) => G.trickWinner(game, game.trick.concat([{ seat, card: c }]), trump) === seat);
    // Throw non-trumps before trumps, low before high.
    const lowest = (cards) => minBy(cards, (c) => (isTrump(c, trump) ? 100 : 0) + power(c, trump));

    if (winning === partnerSeat) {
      const partnerCard = game.trick.find((p) => p.seat === partnerSeat).card;
      const safe = lastToPlay || isBoss(partnerCard, out, trump);
      if (safe || !winners.length) return lowest(legal);
    }
    if (!winners.length) return lowest(legal);
    // Win as cheaply as is safe: last to play, the lowest winner; otherwise a winner nobody
    // behind can beat if we have one, else the lowest winner.
    if (lastToPlay) return lowest(winners);
    const solid = minBy(winners.filter((c) => isBoss(c, out, trump)), (c) => power(c, trump));
    if (solid !== undefined) {
      // Cautious players don't spend top trumps on a cheap trick early.
      if (this.style === 'cautious' && isTrump(solid, trump) && power(solid, trump) >= 28 && game.trick.length === 1
        && G.contractTeam(game) !== G.team(seat)) return lowest(legal);
      return solid;
    }
    return lowest(winners);
  }
}

/** Cards still out (not in my hand, not played; my own discards are known to me). */
function unseen(game, seat) {
  const known = new Set(game.hands[seat]);
  for (const p of game.played) known.add(p.card);
  if (seat === game.contractor) for (const c of game.discarded) known.add(c);
  return FULL_DECK.filter((c) => !known.has(c));
}

/** Whether `c` is the best card left in its suit (nothing unseen beats it). */
function isBoss(c, out, trump) {
  if (c === JOKER) return true;
  // The Joker beats any trump, and in No Trumps anything at all.
  if (out.includes(JOKER) && (trump === NO_TRUMPS || isTrump(c, trump))) return false;
  const suit = effectiveSuit(c, trump), p = power(c, trump);
  return !out.some((x) => x !== JOKER && effectiveSuit(x, trump) === suit && power(x, trump) > p);
}

// MARK: The look-ahead (the app's `Search`)

/** Rule-of-thumb play for the imagined deals (no look-ahead inside the look-ahead). */
const rollout = new Bot({ style: 'steady', skill: 'expert', thinks: false });
/** Deals imagined per decision. */
export const PLAY_SAMPLES = 80, BID_SAMPLES = 50;
/** Points per trick of margin in `playOut`. */
const TRICK_WEIGHT = 3;
/** Plays scoring within this many points (per deal, on average) of the best count as
 *  equally good, and the cheapest of them is played — the Joker and bowers are kept. */
const TIE_MARGIN = 2.0;

/** Deals the cards `seat` can't see into the other hands (and the kitty or the
 *  contractor's discards), respecting known voids and what the bids suggest. */
export function sample(game, seat, rng) {
  const trump = G.trumpOf(game);
  const iAmContractor = game.contractor === seat;
  const known = new Set(game.hands[seat]);
  for (const p of game.played) known.add(p.card);
  if (iAmContractor) for (const c of game.discarded) known.add(c);
  if (game.phase === 'kitty' && iAmContractor) for (const c of game.kitty) known.add(c);
  let pool = shuffle(FULL_DECK.filter((c) => !known.has(c)), rng);

  // Who needs how many: the other three hands, then the kitty (during the bidding) or the
  // contractor's discards (if they aren't mine). A null seat holds the hidden extras.
  const holders = [0, 1, 2, 3].filter((s) => s !== seat).map((s) => ({ seat: s, count: game.hands[s].length }));
  const hiddenKitty = game.phase === 'bidding' ? game.kitty.length : 0;
  const hiddenDiscards = !iAmContractor && game.phase === 'playing' ? game.discarded.length : 0;
  if (hiddenKitty + hiddenDiscards > 0) holders.push({ seat: null, count: hiddenKitty + hiddenDiscards });
  if (holders.reduce((n, h) => n + h.count, 0) !== pool.length) return null;

  const hands = game.hands.map((h) => h.slice());
  const extra = [];
  for (const h of holders) if (h.seat !== null) hands[h.seat] = [];

  const allowed = (c, holder) => {
    if (holder === null || trump === null) return true;
    if (c === JOKER && trump === NO_TRUMPS) return true;
    const suit = effectiveSuit(c, trump);
    if (suit === null) return true;
    return !game.voids[holder].includes(suit);
  };

  // The contractor kept the kitty's good cards: put the turned-up trumps, aces and kings
  // still unplayed into their hand.
  if (game.contractor !== null && game.contractor !== seat && game.phase === 'playing' && trump !== null) {
    const kept = game.revealedKitty.filter((c) => pool.includes(c) && allowed(c, game.contractor)
      && (isTrump(c, trump) || c === JOKER || rankOf(c) >= 13)).slice(0, game.hands[game.contractor].length);
    hands[game.contractor] = kept;
    pool = pool.filter((c) => !kept.includes(c));
  }

  // Bid hints: a player who bid a suit gets some of it first.
  if (game.phase === 'bidding') {
    for (const call of game.calls) {
      if (!call.bid || call.seat === seat || trumpSuit(call.bid.trump) === null) continue;
      const suitTrump = call.bid.trump;
      const want = 3 - hands[call.seat].filter((c) => isTrump(c, suitTrump)).length;
      const room = game.hands[call.seat].length - hands[call.seat].length;
      const picks = pool.filter((c) => isTrump(c, suitTrump)).slice(0, Math.max(0, Math.min(want, room)));
      hands[call.seat].push(...picks);
      pool = pool.filter((c) => !picks.includes(c));
    }
  }

  // The cards with the fewest possible holders go first.
  pool = sortedBy(pool, (c) => holders.filter((h) => allowed(c, h.seat)).length);
  for (const c of pool) {
    const open = [];
    holders.forEach((h, i) => {
      const have = h.seat !== null ? hands[h.seat].length : extra.length;
      if (have < h.count && allowed(c, h.seat)) open.push(i);
    });
    const pick = randomElement(open, rng);
    if (pick === undefined) return null;
    if (holders[pick].seat !== null) hands[holders[pick].seat].push(c); else extra.push(c);
  }
  const kitty = hiddenKitty > 0 ? extra.slice(0, hiddenKitty) : game.phase === 'kitty' ? game.kitty.slice() : [];
  const discarded = hiddenDiscards > 0 ? extra.slice(extra.length - hiddenDiscards) : game.discarded.slice();
  return { hands, kitty, discarded };
}

/** Plays the rest of the hand with rule-of-thumb play and returns how many points `team`
 *  gained over the other team, plus a little for each trick more than the other team
 *  (bidders score nothing for overtricks short of a slam, so without that a big trump spent
 *  now and a small one look the same). */
export function playOut(game, forTeam, countTricks = true) {
  const g = game;
  for (let steps = 1; g.phase === 'kitty' || g.phase === 'playing'; steps++) {
    if (steps > 200) break;
    const s = g.turn;
    try { G.apply(g, rollout.move(g, s), s); } catch { break; }
  }
  if (!g.result) return 0;
  const margin = countTricks ? TRICK_WEIGHT * (g.result.tricks[forTeam] - g.result.tricks[1 - forTeam]) : 0;
  return g.result.points[forTeam] - g.result.points[1 - forTeam] + margin;
}

/** How much a card is worth keeping: trumps above everything (the Joker most), then rank. */
function keepValue(c, trump) {
  if (trump === null) return rankOf(c);
  if (c === JOKER) return 1000;
  return (isTrump(c, trump) ? 100 : 0) + power(c, trump);
}

/** The card (and suit for a No Trumps Joker lead) that scores best for `seat`'s team over
 *  `samples` imagined deals. The same deals are used for every card. */
export function bestPlay(game, seat, samples, cheapTies, rng, out = null) {
  const legal = G.legalPlays(game, seat);
  if (legal.length <= 1) return null;
  const trump = G.trumpOf(game);
  const moves = [];
  for (const c of legal) {
    if (c === JOKER && !game.trick.length && trump === NO_TRUMPS) {
      for (const s of G.jokerLeadSuits(game)) moves.push({ type: 'play', card: c, jokerSuit: s });
    } else moves.push({ type: 'play', card: c, jokerSuit: null });
  }
  const t = G.team(seat);
  const totals = moves.map(() => 0);
  let dealt = 0;
  for (let n = 0; n < samples * 2 && dealt < samples; n++) {
    const deal = sample(game, seat, rng);
    if (!deal) continue;
    dealt += 1;
    const world = G.determinized(game, deal.hands, deal.kitty, deal.discarded);
    moves.forEach((move, i) => {
      const next = G.copyGame(world);
      try { G.apply(next, move, seat); } catch { return; }
      totals[i] += playOut(next, t, cheapTies);
    });
  }
  if (out) Object.assign(out, { moves, totals, dealt });
  if (!dealt) return null;
  const bestIndex = totals.indexOf(Math.max(...totals));
  if (!cheapTies) return moves[bestIndex];
  // Among the plays that do (about) as well as the best, the cheapest.
  const best = totals[bestIndex];
  const good = moves.filter((_, i) => (best - totals[i]) / dealt <= TIE_MARGIN);
  return minBy(good, (m) => keepValue(m.card, trump)) ?? moves[bestIndex];
}

/** A few sensible ways to throw back five: the rule-of-thumb choice, emptying each side
 *  suit (or two) that can be emptied, and simply the five lowest side cards. */
export function discardOptions(cards, trump) {
  const size = G.KITTY_SIZE;
  const side = cards.filter((c) => !isTrump(c, trump) && c !== JOKER);
  const options = [rollout.discards(cards, trump)];
  // The five lowest side cards (aces last).
  const lowestSide = sortedBy(sortedBy(side, (c) => power(c, trump)), (c) => (rankOf(c) === 14 ? 1 : 0));
  if (lowestSide.length >= size) options.push(lowestSide.slice(0, size));
  // Empty a suit, or two, then fill with the lowest other side cards. (The app takes the
  // suits in a Dictionary's order; here in suit order. Only ties could tell them apart.)
  const suits = SUITS.filter((s) => side.some((c) => suitOf(c) === s));
  const voidSets = suits.map((s) => [s]);
  for (let i = 0; i < suits.length; i++) for (let j = i + 1; j < suits.length; j++) voidSets.push([suits[i], suits[j]]);
  for (const voids of voidSets) {
    const emptied = voids.flatMap((s) => side.filter((c) => suitOf(c) === s));
    if (emptied.length > size) continue;
    const rest = lowestSide.filter((c) => !emptied.includes(c));
    if (emptied.length + rest.length < size) continue;
    options.push(emptied.concat(rest.slice(0, size - emptied.length)));
  }
  // Distinct sets only.
  const seen = new Set();
  return options.filter((o) => {
    const key = o.slice().sort((a, b) => a - b).join();
    if (seen.has(key) || o.length !== size) return false;
    seen.add(key);
    return true;
  });
}

/** The throw-back that scores best over imagined deals of the other hands. */
export function bestDiscard(game, seat, samples, rng, out = null) {
  if (!game.highBid) return null;
  const trump = game.highBid.trump;
  const options = discardOptions(game.hands[seat].concat(game.kitty), trump);
  if (options.length <= 1) return options[0] ?? null;
  const t = G.team(seat);
  const totals = options.map(() => 0);
  let dealt = 0;
  for (let n = 0; n < samples * 2 && dealt < samples; n++) {
    const deal = sample(game, seat, rng);
    if (!deal) continue;
    dealt += 1;
    const world = G.determinized(game, deal.hands, game.kitty, []);
    options.forEach((option, i) => {
      const next = G.copyGame(world);
      try { G.apply(next, { type: 'discard', cards: option }, seat); } catch { return; }
      totals[i] += playOut(next, t);
    });
  }
  if (out) Object.assign(out, { options, totals, dealt });
  if (!dealt) return null;
  return options[totals.indexOf(Math.max(...totals))];
}

/** For each trump: how often `seat`'s team would take at least 6, 7, 8, 9 and 10 tricks if
 *  `seat` won the bid with it and took the kitty. Null if no deal could be imagined. */
export function trickOdds(game, seat, samples, rng) {
  const counts = TRUMPS.map(() => [0, 0, 0, 0, 0]);
  const t = G.team(seat);
  let dealt = 0;
  for (let n = 0; n < samples * 2 && dealt < samples; n++) {
    const deal = sample(game, seat, rng);
    if (!deal) continue;
    dealt += 1;
    for (const trump of TRUMPS) {
      const world = G.practiceContract(game, { tricks: 6, trump }, seat, deal.hands, deal.kitty);
      for (let steps = 1; world.phase === 'kitty' || world.phase === 'playing'; steps++) {
        if (steps > 200) break;
        const s = world.turn;
        try { G.apply(world, rollout.move(world, s), s); } catch { break; }
      }
      const tricks = world.result ? world.result.tricks[t] : G.teamTricks(world)[t];
      for (let k = 6; k <= 10; k++) if (tricks >= k) counts[trump][k - 6] += 1;
    }
  }
  if (!dealt) return null;
  return counts.map((row) => row.map((c) => c / dealt));
}
