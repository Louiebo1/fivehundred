// Cards are small integers, as in the app: suit * 100 + rank (rank 4–14, ace 14), and the
// Joker is 999. Suits in bidding order: spades, clubs, diamonds, hearts; No Trumps (4) is
// above them all. Louie's family deck has 45 cards: A–4 in every suit, and the Joker.

export const SPADES = 0, CLUBS = 1, DIAMONDS = 2, HEARTS = 3, NO_TRUMPS = 4;
export const SUITS = [SPADES, CLUBS, DIAMONDS, HEARTS];
export const TRUMPS = [SPADES, CLUBS, DIAMONDS, HEARTS, NO_TRUMPS];
export const SYMBOL = ['♠', '♣', '♦', '♥'];
export const SUIT_NAME = ['Spades', 'Clubs', 'Diamonds', 'Hearts'];
export const JOKER = 999;
export const JACK = 11;

export const card = (suit, rank) => suit * 100 + rank;
export const isJoker = (c) => c === JOKER;
// The Joker's own suit field means nothing (the app keeps hearts there).
export const suitOf = (c) => (c === JOKER ? HEARTS : Math.floor(c / 100));
export const rankOf = (c) => (c === JOKER ? 15 : c % 100);
export const isRedSuit = (s) => s === DIAMONDS || s === HEARTS;
/** The other suit of the same color: where the left bower comes from. */
export const partnerSuit = (s) => [CLUBS, SPADES, HEARTS, DIAMONDS][s];
/** J, Q, K or the Joker — a hand without one is thrown in (Louie's family rule). */
export const isFaceCard = (c) => c === JOKER || (rankOf(c) >= 11 && rankOf(c) <= 13);

export const FULL_DECK = [...SUITS.flatMap((s) => Array.from({ length: 11 }, (_, i) => card(s, i + 4))), JOKER];

export function rankLabel(c) {
  const r = rankOf(c);
  return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '★' }[r] || String(r);
}
export const label = (c) => (c === JOKER ? 'Joker' : rankLabel(c) + SYMBOL[suitOf(c)]);

// MARK: Trumps

/** The trump suit, or null for No Trumps. */
export const trumpSuit = (trump) => (trump === NO_TRUMPS ? null : trump);
export const trumpSymbol = (trump) => (trump === NO_TRUMPS ? 'NT' : SYMBOL[trump]);
export const trumpName = (trump) => (trump === NO_TRUMPS ? 'No Trumps' : SUIT_NAME[trump]);

/** The suit this card belongs to under `trump`: the Joker and the left bower are trumps.
 *  In No Trumps the Joker has no suit of its own (null) unless one is named for it. */
export function effectiveSuit(c, trump, jokerSuit = null) {
  if (c === JOKER) return trumpSuit(trump) ?? jokerSuit;
  const ts = trumpSuit(trump);
  if (ts !== null && rankOf(c) === JACK && suitOf(c) === partnerSuit(ts)) return ts;
  return suitOf(c);
}

export function isTrump(c, trump) {
  const ts = trumpSuit(trump);
  return ts !== null && effectiveSuit(c, trump) === ts;
}

/** Strength within its (effective) suit: Joker 30, right bower 29, left bower 28, then the rank. */
export function power(c, trump) {
  if (c === JOKER) return 30;
  const ts = trumpSuit(trump);
  if (ts !== null && rankOf(c) === JACK) {
    if (suitOf(c) === ts) return 29;
    if (suitOf(c) === partnerSuit(ts)) return 28;
  }
  return rankOf(c);
}

// MARK: Bids — { tricks: 6–10, trump: 0–4 }

/** The table: 6♠ 40, each suit up 20 (♣ ♦ ♥ NT), each trick up 100 — 10 NT is 520. */
export const bidValue = (b) => 40 + 20 * b.trump + 100 * (b.tricks - 6);
export const bidAbove = (a, b) => (a.tricks !== b.tricks ? a.tricks > b.tricks : a.trump > b.trump);
export const ALL_BIDS = [6, 7, 8, 9, 10].flatMap((tricks) => TRUMPS.map((trump) => ({ tricks, trump })));
export const bidLabel = (b) => (b ? `${b.tricks}${b.trump === NO_TRUMPS ? ' NT' : SYMBOL[b.trump]}` : 'Pass');
export const sameBid = (a, b) => (a && b ? a.tricks === b.tricks && a.trump === b.trump : a === b);

/** A shuffled copy of the deck (Fisher–Yates). */
export function shuffled(deck = FULL_DECK, random = Math.random) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
