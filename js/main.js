// The web app: the start screen, the table, and the overlays. It draws whatever table
// state it's given and turns taps into moves. Built like the app's TableView: your partner
// across, opponents left and right, the trick (or the kitty being turned up) in the
// middle, the bid grid on your turn to bid, your hand at the bottom.

import * as G from './game.js';
import {
  SYMBOL, SUIT_NAME, SUITS, JOKER, NO_TRUMPS, ALL_BIDS, card, suitOf, rankOf, rankLabel, label, isRedSuit,
  isTrump, power, trumpSuit, effectiveSuit, bidValue, bidAbove, bidLabel, trumpSymbol, HEARTS, DIAMONDS, JACK,
} from './cards.js';
import { STYLES } from './bot.js';
import { newTableState, LocalHost, BOT_NAMES, PACE, trickLinger, shuffledList } from './table.js';
import { OnlineTable, onlineAvailable } from './online.js';
import { think } from './think.js';
import { play as playSound, sound, unlockSound } from './sounds.js';

const app = document.getElementById('app');
// The page's options as it was opened (the address changes to ?t=CODE once at a table).
// For checking the page: ?name=X, ?play, ?autoplay, ?fast, ?newtable=CODE&startafter=N.
const params = new URLSearchParams(location.search);

// MARK: Remembered on this device

function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const settings = Object.assign({ name: '', back: 'red', highFirst: true, largePrint: false, sounds: true, hints: false }, stored('fh.settings', {}));
function saveSettings() {
  store('fh.settings', settings);
  document.body.classList.toggle('large-print', settings.largePrint);
  sound.on = settings.sounds;
}
saveSettings();

// The online table this browser last sat at, so the start screen can offer to go back.
const lastTable = {
  get: () => stored('fh.table', null),
  set: (code) => store('fh.table', code),
  clear: () => store('fh.table', null),
};

// A game against the computer, saved after every move so a reload doesn't lose it.
const savedGame = {
  get: () => { const s = stored('fh.local', null); return s && s.game && s.game.phase !== 'gameOver' ? s : null; },
  set: (s) => store('fh.local', s),
};

// Statistics, kept on this device (the app's lines, without iCloud).
const blankLine = () => ({ played: 0, won: 0, lost: 0, backDoor: 0, hands: 0, contracts: 0, contractsMade: 0, myBids: 0, myBidsMade: 0, slams: 0, defenseSets: 0, bestHand: 0 });
const stats = stored('fh.stats', null) || { computer: blankLine(), online: blankLine() };
const saveStats = () => store('fh.stats', stats);

const myName = () => settings.name || 'Player';

// MARK: Helpers

/** Names come from other people's browsers: never let them be read as HTML. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

function button(text, cls, onclick) {
  const b = el('button', cls);
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

const signed = (n) => (n >= 0 ? `+${n}` : String(n));

function cardEl(c) {
  if (c === JOKER) {
    const e = el('div', 'card joker');
    e.innerHTML = `<div class="letters">${[...'JOKER'].map((ch) => `<span>${ch}</span>`).join('')}</div><div class="star">★</div>`;
    e.setAttribute('aria-label', 'Joker');
    return e;
  }
  const red = isRedSuit(suitOf(c));
  const e = el('div', 'card' + (red ? ' red' : ''));
  e.innerHTML = `<div class="corner"><span class="r">${rankLabel(c)}</span><span class="s">${SYMBOL[suitOf(c)]}</span></div><div class="pip">${SYMBOL[suitOf(c)]}</div>`;
  e.setAttribute('aria-label', label(c));
  return e;
}

function backEl() {
  const e = el('div', 'back');
  const inner = el('div');
  inner.style.backgroundImage = `url(img/back_${settings.back}.jpg)`;
  e.appendChild(inner);
  return e;
}

/** A bid in its suit's color — red for ♥ ♦, black for ♠ ♣, navy for No Trumps — on a
 *  card-colored chip, or a grey "Pass". */
function bidChip(bid, large = false) {
  const ink = !bid ? 'pass' : bid.trump === NO_TRUMPS ? 'nt' : isRedSuit(bid.trump) ? 'red' : 'black';
  return `<span class="bid-chip ${ink}${large ? ' large' : ''}">${bidLabel(bid)}</span>`;
}

const dealerChip = '<span class="dealer" aria-label="Dealer">D</span>';

/** A dialog over the page. `title` and a string `body` are HTML; Escape or a tap outside
 *  calls `dismiss`, when there is one. */
function dialog(title, body, buttons, dismiss) {
  const o = el('div', 'overlay'), p = el('div', 'panel');
  if (title) p.appendChild(el('h2', '', title));
  if (typeof body === 'string') p.appendChild(el('p', '', body));
  else if (body) p.appendChild(body);
  if (buttons && buttons.length) { const row = el('div', 'buttons'); row.append(...buttons); p.appendChild(row); }
  o.appendChild(p);
  if (dismiss) {
    o.dataset.dismiss = '';
    o.dismiss = dismiss;
    o.onclick = (e) => { if (e.target === o) dismiss(); };
  }
  return o;
}

/** A dialog of its own (the menu, settings, a question) that stays on top while the table
 *  redraws under it. `buttons` are [text, class, action]; each one closes it. */
function popup(title, body, buttons, onDismiss) {
  const o = dialog(title, body, buttons.map(([text, cls, then]) => button(text, cls, () => { o.remove(); then?.(); })),
    () => { o.remove(); onDismiss?.(); });
  o.classList.add('popup');
  app.appendChild(o);
  return o;
}

const message = (html, then) => popup('', html, [['OK', 'primary', then]], then);
const confirmThen = (title, html, yes, onYes) => popup(title, html, [['Cancel', ''], [yes, 'primary', onYes]]);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') [...document.querySelectorAll('.overlay[data-dismiss]')].pop()?.dismiss();
});
// Browsers only allow sound after a tap.
document.addEventListener('pointerdown', unlockSound);

// MARK: Start screen

let host = null;      // LocalHost or OnlineTable
let state = null;     // The table state being shown.
const ui = {
  me: 0,
  selected: new Set(),   // Cards picked to throw back after taking the kitty.
  pending: null,         // The card picked to play: it waits for a second tap or the button.
  hint: null, hintCard: null, thinkingHint: false,
  banner: null,          // { title, detail, team, big, until, id }: a message over the table.
  bannerShown: null,     // The banner last drawn: it pops in only the first time.
  revealStart: 0,        // When the kitty started turning up (one card at a time).
  kittyPopped: 0,        // Kitty cards already turned (each pops once).
  linger: null,          // { plays, winner, start }: a finished trick left up, then swept to its winner.
  shown: { key: '', count: 0 },   // Trick cards already drawn (new ones slide in).
  holdResultUntil: 0,    // The hand just ended: the result waits so "Set!" can be seen first.
  sentAt: null,          // Online guest: the state version when I sent a move (no double taps).
  prev: null,            // The last game drawn (a copy), to see what changed.
  recorded: false,       // This game's result is in the stats.
  showSheet: false, showFinal: false,
  overlayKey: null,      // The overlay drawn last time (it doesn't fade in again).
};
const later = [];        // Timers that redraw when something on the table expires.

function resetUI() {
  Object.assign(ui, {
    pending: null, hint: null, hintCard: null, thinkingHint: false, banner: null, bannerShown: null, revealStart: 0,
    kittyPopped: 0, linger: null, shown: { key: '', count: 0 }, holdResultUntil: 0, sentAt: null, prev: null,
    recorded: false, showSheet: false, showFinal: false, overlayKey: null,
  });
  ui.selected.clear();
  later.splice(0).forEach(clearTimeout);
}

function redrawAt(time) {
  later.push(setTimeout(() => render(), Math.max(0, time - Date.now()) + 20));
}

const isOnline = () => host instanceof OnlineTable;

function leaveTable() {
  // Mid-game, keep the code: the others wait, and Back to Table brings me back.
  const midGame = isOnline() && host.started && state && state.game.phase !== 'gameOver';
  if (isOnline() && !midGame) lastTable.clear();
  showLobby();
}

function showLobby() {
  host?.stop(); host = null; state = null;
  resetUI();
  if (location.search) history.replaceState(null, '', location.pathname);
  app.innerHTML = '';
  const lobby = el('div', 'lobby');
  lobby.appendChild(el('h1', '', '500'));
  lobby.appendChild(el('div', 'tag', 'Bid it · make it · first to 500'));
  const fan = el('div', 'fan');
  [card(HEARTS, 14), card(DIAMONDS, JACK), JOKER, card(HEARTS, JACK), card(HEARTS, 13)].forEach((c, i) => {
    const e = cardEl(c);
    e.style.transform = `translateX(-50%) rotate(${(i - 2) * 9}deg)`;
    fan.appendChild(e);
  });
  lobby.appendChild(fan);

  const name = el('div', 'name', 'Playing as ');
  name.appendChild(button(settings.name || 'You', 'link', () => askName(showLobby)));
  lobby.appendChild(name);

  const code = onlineAvailable() && lastTable.get();
  if (code) lobby.appendChild(button(`Back to Table ${code}`, 'big-button primary', () => joinTable(code)));

  const saved = savedGame.get();
  if (saved) lobby.appendChild(button(`Continue Game · ${saved.game.scores.join('–')}`, 'big-button primary', () => playComputer(saved)));
  lobby.appendChild(button(saved ? 'New Game vs the Computer' : 'Play the Computer', 'big-button', () => {
    if (saved) confirmThen('New Game?', 'The game you have going will be lost.', 'New Game', () => playComputer());
    else playComputer();
  }));

  const friends = button('Play with Friends', 'big-button', showFriends);
  friends.disabled = !onlineAvailable();
  lobby.appendChild(friends);

  const links = el('div', 'links');
  links.appendChild(button('Settings', 'link', () => showSettings(showLobby)));
  links.appendChild(button('Statistics', 'link', showStats));
  links.appendChild(button('How to Play', 'link', showRules));
  lobby.appendChild(links);
  app.appendChild(lobby);
  if (!settings.name) askName(showLobby);
}

function askName(then) {
  const input = el('input', 'text');
  input.maxLength = 16; input.value = settings.name; input.placeholder = 'Your name'; input.autocomplete = 'nickname';
  const save = () => {
    const name = input.value.trim().slice(0, 16);
    if (!name) { input.focus(); return; }
    settings.name = name; saveSettings(); o.remove(); then?.();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  const o = dialog('Your name?', input, [button('OK', 'primary', save)], settings.name ? () => o.remove() : null);
  o.classList.add('popup');
  app.appendChild(o);
  input.focus();
}

function playComputer(saved = null) {
  let s = saved;
  if (!s) {
    const names = shuffledList(BOT_NAMES.filter((n) => n !== settings.name));
    const seats = [{ kind: 'person', name: settings.name || 'You' }, ...[0, 1, 2].map((i) => ({ kind: 'bot', name: names[i] }))];
    if (params.has('autoplay')) seats[0].kind = 'bot';     // Testing: bots in every seat.
    s = newTableState(seats);
  }
  ui.me = 0;
  resetUI();
  const keep = !params.has('autoplay');
  host = new LocalHost(s, (next) => {
    state = next;
    if (keep) savedGame.set(next.game.phase === 'gameOver' ? null : next);
    update();
    render();
  });
}

// MARK: Playing with friends

function showFriends() {
  app.innerHTML = '';
  const lobby = el('div', 'lobby');
  lobby.appendChild(el('h1', '', '500'));
  lobby.appendChild(el('div', 'tag', 'Play with friends'));
  lobby.appendChild(button('Start a Table', 'big-button primary', () => withTable(OnlineTable.create(myName(), onTableUpdate))));
  lobby.appendChild(el('div', 'note', 'or join with a code'));
  const row = el('div', 'row');
  const input = el('input', 'code');
  input.maxLength = 4; input.placeholder = 'CODE'; input.autocapitalize = 'characters'; input.autocomplete = 'off'; input.spellcheck = false;
  const join = button('Join', 'primary', () => { if (input.value.trim().length === 4) joinTable(input.value.trim()); else input.focus(); });
  input.onkeydown = (e) => { if (e.key === 'Enter') join.onclick(); };
  row.append(input, join);
  lobby.appendChild(row);
  lobby.appendChild(el('div', 'note', 'Seats 1 & 3 are partners, and 2 & 4. Bots fill any empty seats when the game starts. If someone drops, the game waits until they’re back — they reopen the link, or tap Back to Table on the start screen.'));
  lobby.appendChild(button('Back', '', showLobby));
  app.appendChild(lobby);
}

const joinTable = (code) => withTable(OnlineTable.join(code, myName(), onTableUpdate));

async function withTable(promise) {
  app.innerHTML = '<div class="lobby"><div class="tag">Connecting…</div></div>';
  resetUI();
  try {
    host = await promise;
    lastTable.set(host.code);
    history.replaceState(null, '', `${location.pathname}?t=${host.code}`);
    onTableUpdate();
  } catch (e) {
    const text = (e && e.message) || String(e);
    if (/no table|already started|full/i.test(text)) lastTable.clear();
    showFriends();
    message(esc(text));
  }
}

function onTableUpdate() {
  if (!isOnline()) return;
  ui.me = Math.max(0, host.mySeat);
  if (host.started && host.state) {
    state = host.state;
    update();
    render();
    testAutoplay();
  } else waitingRoom();
}

// Testing online: ?autoplay makes this browser play its own seat with a bot, and
// ?startafter=N (host) starts the table once N people are seated.
let autoTimer = null, autoBusy = false;
function testAutoplay() {
  if (!params.has('autoplay') || !state) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    const g = state.game, me = ui.me;
    if (state.paused || autoBusy) return;
    if (['bidding', 'kitty', 'playing'].includes(g.phase) && g.turn === me) {
      autoBusy = true;
      const version = state.version;
      const move = await think(g, me, 'steady');
      autoBusy = false;
      if (state.version === version) host.send({ ...move, seat: me });
    } else if (g.phase === 'handOver' && !(g.continued || []).includes(me)) host.send({ type: 'continue', seat: me });
    document.title = `500 ${g.phase} hand ${g.handNumber + 1} scores ${g.scores.join(',')}`;
  }, 400);
}

function waitingRoom() {
  const t = host;
  const want = Number(params.get('startafter') || 0);
  if (want && t.isHost && t.seats.filter((x) => x.kind === 'person').length >= want) { t.start(); return; }
  state = null;
  app.innerHTML = '';
  const lobby = el('div', 'lobby');
  lobby.appendChild(el('div', 'tag', 'Table code'));
  lobby.appendChild(el('h1', 'table-code', t.code));
  const link = `${location.origin}${location.pathname}?t=${t.code}`;
  const share = button('Send the Link', 'primary', async () => {
    if (navigator.share) { try { await navigator.share({ title: '500', text: `Join my 500 table: ${t.code}`, url: link }); } catch {} return; }
    try { await navigator.clipboard.writeText(link); share.textContent = 'Link Copied'; } catch { share.textContent = link; }
  });
  lobby.appendChild(share);
  const list = el('div', 'seats-list');
  t.seats.forEach((seat, i) => {
    const row = el('div', 'seat-row');
    const team = `<span class="team-dot t${i % 2}"></span>`;
    if (seat.kind === 'open') row.innerHTML = `<span class="n">${i + 1}</span>${team}<i>Open — a bot sits here if nobody joins</i>`;
    else row.innerHTML = `<span class="n">${i + 1}</span>${team}<b>${esc(seat.name)}</b>${seat.uid === t.uid ? '<span class="you">you</span>' : ''}<span class="dot ${t.presence[seat.uid] ? 'on' : ''}"></span>`;
    list.appendChild(row);
  });
  lobby.appendChild(list);
  lobby.appendChild(el('div', 'note', 'Partners: seats 1 & 3, and seats 2 & 4.'));
  if (t.isHost) {
    const open = t.seats.filter((s) => s.kind === 'open').length;
    lobby.appendChild(button(open ? `Start — bots take ${open} seat${open === 1 ? '' : 's'}` : 'Start the Game', 'big-button primary', () => t.start()));
  } else {
    const hostSeat = t.seats.find((s) => s.uid === t.meta?.hostUid);
    lobby.appendChild(el('div', 'note', `Waiting for ${hostSeat ? esc(hostSeat.name) : 'the host'} to start…`));
  }
  lobby.appendChild(button('Leave', '', leaveTable));
  app.appendChild(lobby);
}

// MARK: Who's who

const myTeam = () => G.team(ui.me);
const partnerSeat = () => G.partner(ui.me);
const positionOf = (seat) => (seat - ui.me + 4) % 4;      // 0 me (bottom), 1 left, 2 across, 3 right.
const seatAt = (position) => (ui.me + position) % 4;
const nameOf = (seat) => esc(state.seats[seat].name) + (state.seats[seat].standIn ? ' (bot)' : '');
/** "You" for me, else the name. */
const who = (seat) => (seat === ui.me ? 'You' : nameOf(seat));
const teamClass = (team) => (team === myTeam() ? 'us' : 'them');
/** "You and Ray", "Frank and Dot": the two players on a team, me first. */
function teamPlayers(team) {
  const seats = [team, team + 2].sort((a, b) => (a === ui.me ? -1 : b === ui.me ? 1 : a - b));
  return seats.map(who).join(' and ');
}
const isMyTurn = (g) => ['bidding', 'kitty', 'playing'].includes(g.phase) && g.turn === ui.me && !state.paused;
const waitingOnHost = () => isOnline() && !host.isHost && ui.sentAt !== null && ui.sentAt === state.version;

// MARK: What changed: sounds, banners, the kitty, the last trick, the stats

function showBanner(b, ms = 2400) {
  ui.banner = { ...b, until: Date.now() + ms, id: Math.random() };
  redrawAt(ui.banner.until);
}

function update() {
  const g = state.game, old = ui.prev, now = Date.now();
  if (ui.sentAt !== null && state.version !== ui.sentAt) ui.sentAt = null;
  const newGame = !old || g.history.length < old.history.length || (old.phase === 'gameOver' && g.phase !== 'gameOver');
  const newDeal = newGame || old.handNumber !== g.handNumber || old.redeals !== g.redeals || old.noFaceThrowIns !== g.noFaceThrowIns
    || (g.phase === 'bidding' && !g.calls.length && old.calls.length > 0);
  if (newDeal) {
    if (old) playSound('deal');
    ui.holdResultUntil = 0; ui.linger = null; ui.revealStart = 0; ui.pending = null; ui.selected.clear();
    ui.hint = null; ui.hintCard = null; ui.showFinal = false;
    if (newGame) ui.recorded = false;
  } else if (g.played.length > old.played.length) playSound('snap');

  if (old && !newGame) {
    if (g.redeals > old.redeals) showBanner({ title: 'Everyone passed', detail: 'New deal' });
    if ((g.noFaceThrowIns || 0) > (old.noFaceThrowIns || 0) && g.noFaceSeat !== null) {
      showBanner({ title: g.noFaceSeat === ui.me ? 'You had no face cards' : `${nameOf(g.noFaceSeat)} had no face cards`, detail: 'Thrown in — new deal' });
    }
    // The bidding is over: turn the kitty up slowly, one card at a time, for everyone.
    if (old.phase === 'bidding' && g.phase === 'kitty') {
      ui.revealStart = params.has('fast') ? now - 99999 : now;
      ui.kittyPopped = 0;
      for (let i = 1; i <= G.KITTY_SIZE + 1; i++) redrawAt(now + PACE.kittyCard * i);
      redrawAt(now + PACE.kittyCard * G.KITTY_SIZE + PACE.kittyHold);
      ui.selected.clear();
    }
    // A trick just finished: leave it on the table a moment, then slide it to the winner.
    if (g.played.length > old.played.length && !g.trick.length && g.lastTrick.length) {
      ui.linger = { plays: g.lastTrick, winner: g.lastTrickWinner, start: now, key: g.played.length };
      redrawAt(now + trickLinger());
    }
    if (g.trick.length && old.trick.length === 0) ui.linger = null;
    if (g.result && !old.result) handEnded(g);
    if (g.phase !== old.phase || g.turn !== old.turn) { ui.hint = null; ui.hintCard = null; ui.pending = null; }
  }
  if (g.phase === 'gameOver' && g.winner !== null && !ui.recorded && old) {
    ui.recorded = true;
    const won = g.winner === myTeam();
    if (!params.has('autoplay')) {
      const line = stats[isOnline() ? 'online' : 'computer'];
      line.played += 1; line[won ? 'won' : 'lost'] += 1;
      if (!won && g.scores[myTeam()] <= G.BACK_DOOR) line.backDoor += 1;
      saveStats();
    }
    if (won) playSound('fanfare', PACE.resultHold / 1000);
  }
  ui.prev = JSON.parse(JSON.stringify(g));
}

function handEnded(g) {
  const r = g.result, now = Date.now();
  const team = G.team(r.contractor);
  if (!params.has('autoplay')) {
    // The app's hand statistics.
    const line = stats[isOnline() ? 'online' : 'computer'], mine = team === myTeam();
    line.hands += 1;
    if (mine) {
      line.contracts += 1; if (r.made) line.contractsMade += 1;
      if (r.contractor === ui.me) { line.myBids += 1; if (r.made) line.myBidsMade += 1; }
      if (r.slam) line.slams += 1;
    } else if (!r.made) line.defenseSets += 1;
    line.bestHand = Math.max(line.bestHand, r.points[myTeam()]);
    saveStats();
  }
  const banner = r.made
    ? { title: r.slam ? 'Slam!' : `${team === myTeam() ? 'We' : 'They'} made it!`, detail: `${bidLabel(r.contract)} · ${signed(r.points[team])}`, team, big: true }
    : { title: 'Set!', detail: `${bidLabel(r.contract)} · ${r.points[team]}`, team: 1 - team, big: true };
  if (!r.made) playSound('knock');
  const fast = params.has('fast');
  showBanner(banner, fast ? 100 : PACE.resultHold + 400);
  ui.holdResultUntil = fast ? now : now + PACE.resultHold + trickLinger();
  redrawAt(ui.holdResultUntil);
}

// MARK: The table

/** Card sizes from the window: the app's formulas (hand and trick), as CSS variables. */
function sizes() {
  const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
  const sideways = w > h && h < 500;
  return {
    sideways,
    hand: Math.floor(Math.min((w - 24) / 7.4, 88, sideways ? h / 5.4 : h / 7.2)),
    trick: Math.floor(Math.min(w / 6.5, h / (sideways ? 7.5 : 9.5), 84)),
  };
}

function render() {
  if (!state) return;
  const g = state.game, me = ui.me, now = Date.now();
  if (ui.pending !== null && !G.legalPlays(g, me).includes(ui.pending)) ui.pending = null;
  const size = sizes();
  // The table and its overlays are redrawn in one piece; dialogs opened on top of them
  // (the menu, settings) are left alone, so they don't flicker as the bots play.
  const screen = el('div', 'screen');
  const table = el('div', 'table' + (size.sideways ? ' sideways' : ''));
  table.style.setProperty('--hand-w', size.hand + 'px');
  table.style.setProperty('--trick-w', size.trick + 'px');
  if (isOnline() && !host.connected) table.appendChild(el('div', 'banner-line', 'Connection lost — reconnecting…'));

  table.appendChild(topBar(g));
  const middle = el('div', 'middle');
  for (const position of [2, 1, 3]) middle.appendChild(seatBadge(g, seatAt(position), position));
  const center = el('div', 'center');
  const revealing = g.phase === 'kitty' && now < ui.revealStart + PACE.kittyCard * G.KITTY_SIZE + PACE.kittyHold;
  if (g.phase === 'kitty' && (revealing || g.contractor !== me)) center.appendChild(kittyShow(g, now, revealing));
  else center.appendChild(trickEl(g, now));
  // Choosing from the kitty: it sits above my hand — or, on a phone held sideways, in the
  // middle of the table (there's no room for another row, and no trick yet).
  const choosing = g.phase === 'kitty' && g.contractor === me && !revealing;
  if (choosing && size.sideways) center.appendChild(kittyRow(g));
  if (ui.banner && now < ui.banner.until) center.appendChild(bannerEl(ui.banner));
  middle.appendChild(center);
  table.appendChild(middle);

  table.appendChild(controls(g, revealing));
  if (choosing && !size.sideways) table.appendChild(kittyRow(g));
  table.appendChild(meLine(g));
  table.appendChild(handRow(g, revealing));
  screen.appendChild(table);
  const old = app.querySelector(':scope > .screen');
  if (old) old.replaceWith(screen);
  else { app.innerHTML = ''; app.appendChild(screen); }

  // Overlays. The same one as last time doesn't fade in again.
  let overlay = null, key = null;
  const over = g.phase === 'handOver' || g.phase === 'gameOver';
  if (state.paused && state.paused.seat !== me) { overlay = pausedPanel(); key = 'paused'; }
  else if (over && now >= ui.holdResultUntil) {
    overlay = ui.showFinal ? finalPanel(g) : resultPanel(g);
    key = `result:${g.handNumber}:${g.phase}:${ui.showFinal}`;
  } else if (ui.showSheet) { overlay = sheetPanel(g); key = 'sheet'; }
  if (overlay) {
    if (key === ui.overlayKey) overlay.classList.add('still');
    screen.appendChild(overlay);
  }
  ui.overlayKey = key;
}

function teamScore(g, team) {
  const tricks = g.phase === 'playing' ? shownTeamTricks(g, team) : null;
  return el('div', `team-score ${teamClass(team)}`,
    `<div class="line"><i></i><b>${team === myTeam() ? 'Us' : 'Them'}</b><span class="n">${g.scores[team]}</span></div>${tricks === null ? '' : `<small>${tricks} trick${tricks === 1 ? '' : 's'}</small>`}`);
}

/** Tricks taken, counting the last one only once it has slid over. */
const lingering = (now = Date.now()) => ui.linger && now < ui.linger.start + trickLinger();
function shownTricks(g, seat) {
  return g.tricksWon[seat] - (lingering() && ui.linger.winner === seat ? 1 : 0);
}
const shownTeamTricks = (g, team) => shownTricks(g, team) + shownTricks(g, team + 2);

function topBar(g) {
  const top = el('div', 'topbar');
  top.appendChild(teamScore(g, myTeam()));
  top.appendChild(teamScore(g, 1 - myTeam()));
  if (g.highBid && g.phase !== 'bidding' && g.contractor !== null) {
    top.appendChild(el('div', `contract ${teamClass(G.team(g.contractor))}`, `${bidChip(g.highBid, true)}<small>${who(g.contractor)} · ${bidValue(g.highBid)}</small>`));
  } else top.appendChild(el('div', 'hand-no', `Hand ${g.handNumber + 1}`));
  const menu = button('•••', 'menu', showMenu);
  menu.setAttribute('aria-label', 'Game menu');
  top.appendChild(menu);
  return top;
}

/** Another player: name, team, dealer, a little fan of their cards, their bid or tricks,
 *  and a gold outline when it's their turn. */
function seatBadge(g, seat, position) {
  const turn = ['bidding', 'kitty', 'playing'].includes(g.phase) && g.turn === seat;
  const b = el('div', `seat ${['', 'west', 'north', 'east'][position]}${turn ? ' turn' : ''}`);
  b.appendChild(el('div', 'who', `<i class="team-dot ${teamClass(G.team(seat))}"></i><b>${nameOf(seat)}</b>${g.dealer === seat ? dealerChip : ''}`));
  if (seat === partnerSeat()) b.appendChild(el('div', 'partner', 'Partner'));
  const fan = el('div', 'fan-backs');
  const n = g.hands[seat].length;
  fan.style.setProperty('--n', Math.max(1, n));
  for (let i = 0; i < n; i++) { const back = backEl(); back.style.left = `calc(var(--bw) * 0.22 * ${i})`; fan.appendChild(back); }
  b.appendChild(fan);
  b.appendChild(el('div', 'status', seatStatus(g, seat)));
  const uid = isOnline() && state.seats[seat].kind === 'person' && host.seats[seat]?.uid;
  if (uid && !host.presence[uid]) b.appendChild(el('div', 'away', 'Away'));
  return b;
}

function seatStatus(g, seat) {
  switch (g.phase) {
    case 'bidding': {
      const call = g.calls.filter((c) => c.seat === seat).pop();
      if (!call) return g.turn === seat ? '<span class="dots"><i></i><i></i><i></i></span>' : '<span class="faint">…</span>';
      return bidChip(call.bid, seat === partnerSeat());
    }
    case 'kitty': case 'playing': {
      const t = shownTricks(g, seat);
      if (seat === g.contractor) return `★ ${bidChip(g.highBid)} · ${t}`;
      return `${t} trick${t === 1 ? '' : 's'}`;
    }
    default: return '&nbsp;';
  }
}

/** The cards in the middle. New ones slide in from whoever played them; a finished trick
 *  stays up a moment, then slides off to its winner. */
function trickEl(g, now) {
  const trick = el('div', 'trick');
  const linger = lingering(now) ? ui.linger : null;
  const plays = linger ? linger.plays : g.phase === 'playing' ? g.trick : [];
  const key = linger ? `l${linger.key}` : `${g.handNumber}:${g.played.length - g.trick.length}`;
  // The cards of a trick that just finished were already drawn while it was being played.
  const seen = ui.shown.key === key ? ui.shown.count : (linger && ui.shown.key === `${g.handNumber}:${linger.key - 4}` ? ui.shown.count : 0);
  const winner = linger ? linger.winner : G.currentWinner(g);
  plays.forEach((p, i) => {
    const c = cardEl(p.card);
    c.classList.add('p' + positionOf(p.seat));
    if (i >= seen) c.classList.add('enter');
    if (p.seat === winner) c.classList.add('winner');
    if (i === 0 && p.card === JOKER && g.jokerSuit !== null && (G.trumpOf(g) === NO_TRUMPS || (linger && g.highBid?.trump === NO_TRUMPS))) {
      c.appendChild(el('div', 'as-suit', `as ${SYMBOL[g.jokerSuit]}`));
    }
    trick.appendChild(c);
  });
  ui.shown = { key, count: plays.length };
  if (linger && !params.has('fast')) {
    // The sweep runs on the clock, so a redraw part-way through picks up where it was.
    trick.classList.add('collect', 'to-' + positionOf(linger.winner));
    trick.style.setProperty('--sweep-delay', `${PACE.trickPause - (now - linger.start)}ms`);
  }
  return trick;
}

/** The kitty in the middle of the table: turned up one card at a time for everyone after
 *  the bidding, then (if someone else won it) left showing while they choose. */
function kittyShow(g, now, revealing) {
  const box = el('div', 'kitty-show');
  if (g.contractor !== null && g.highBid) box.appendChild(el('div', 'caption', `Kitty for ${who(g.contractor)} · ${bidLabel(g.highBid)} (${bidValue(g.highBid)})`));
  const row = el('div', 'cards');
  const shown = revealing ? Math.min(G.KITTY_SIZE, Math.floor((now - ui.revealStart) / PACE.kittyCard)) : G.KITTY_SIZE;
  if (shown > ui.kittyPopped && shown < 6) playSound('snap');
  g.revealedKitty.forEach((c, i) => {
    if (i < shown) {
      const e = cardEl(c);
      if (i >= ui.kittyPopped && revealing) e.classList.add('turned');
      row.appendChild(e);
    } else row.appendChild(backEl());
  });
  ui.kittyPopped = Math.max(ui.kittyPopped, shown);
  box.appendChild(row);
  return box;
}

function bannerEl(b) {
  const color = b.team === undefined || b.team === null ? 'neutral' : teamClass(b.team);
  const fresh = ui.bannerShown !== b.id;
  ui.bannerShown = b.id;
  return el('div', `banner ${color}${b.big ? ' big' : ''}${fresh ? ' fresh' : ''}`, `<b>${b.title}</b>${b.detail ? `<small>${b.detail}</small>` : ''}`);
}

function statusText(g, revealing) {
  const me = ui.me;
  const whose = g.turn === me ? null : nameOf(g.turn);
  switch (g.phase) {
    case 'bidding':
      if (whose) return `${whose} is bidding…`;
      if (G.standing(g)) return `Everyone passed — raise your bid, or keep ${bidLabel(g.highBid)}`;
      return g.highBid ? `Bid over ${bidLabel(g.highBid)}, or pass` : 'Your bid';
    case 'kitty':
      if (revealing) return 'Turning up the kitty…';
      if (whose) return `${whose} is choosing 5 to throw back…`;
      return ui.selected.size === G.KITTY_SIZE ? 'Throw these five back' : `Pick 5 cards to throw back (${ui.selected.size}/5)`;
    case 'playing':
      if (whose) return `${whose}’s turn`;
      if (ui.pending !== null) return 'Tap it again to play it';
      return g.trick.length ? 'Your play — pick a card' : 'Your lead — pick a card';
    default: return '';
  }
}

function controls(g, revealing) {
  const box = el('div', 'controls');
  const row = el('div', 'row');
  row.appendChild(el('div', 'status-line', statusText(g, revealing)));
  const mine = isMyTurn(g) && !waitingOnHost();
  if (mine && g.phase === 'playing' && ui.pending !== null) row.appendChild(button(`Play ${label(ui.pending)}`, 'primary', confirmPlay));
  if (mine && g.phase === 'kitty' && !revealing) {
    const b = button('Throw Back', 'primary', throwBack);
    b.disabled = ui.selected.size !== G.KITTY_SIZE;
    row.appendChild(b);
  }
  if (mine && settings.hints && !(g.phase === 'kitty' && revealing)) {
    const b = button(ui.thinkingHint ? 'Thinking…' : '💡 Suggest', 'ghost', suggest);
    b.disabled = ui.thinkingHint;
    row.appendChild(b);
  }
  box.appendChild(row);
  if (ui.hint) box.appendChild(el('div', 'hint', ui.hint));
  if (mine && g.phase === 'bidding') box.appendChild(bidGrid(g));
  return box;
}

/** Every bid from 6♠ to 10 NT with its value; only bids over the current one are live. */
function bidGrid(g) {
  const wrap = el('div', 'bid-grid');
  const grid = el('div', 'grid');
  for (const bid of ALL_BIDS) {
    const allowed = !g.highBid || bidAbove(bid, g.highBid);
    const b = el('button', 'bid' + (bid.trump !== NO_TRUMPS && isRedSuit(bid.trump) ? ' red' : ''),
      `<b>${bid.tricks}${trumpSymbol(bid.trump)}</b><small>${bidValue(bid)}</small>`);
    b.disabled = !allowed;
    b.setAttribute('aria-label', `Bid ${bid.tricks} ${bid.trump === NO_TRUMPS ? 'No Trumps' : SUIT_NAME[bid.trump]}, ${bidValue(bid)}`);
    b.onclick = () => perform({ type: 'bid', bid });
    grid.appendChild(b);
  }
  wrap.appendChild(grid);
  wrap.appendChild(button(G.standing(g) ? `Keep ${bidLabel(g.highBid)}` : 'Pass', 'pass', () => perform({ type: 'pass' })));
  return wrap;
}

/** The kitty beside my hand after I win the bid: pick any five of these and my ten to
 *  throw back; the rest join my hand once I have. */
function kittyRow(g) {
  const row = el('div', 'kitty-row');
  row.appendChild(el('div', 'tag', 'KITTY'));
  const cards = el('div', 'cards');
  for (const c of g.kitty) {
    const e = cardEl(c);
    e.classList.add('kitty-card');
    if (ui.selected.has(c)) e.classList.add('picked');
    if (c === ui.hintCard) e.classList.add('hinted');
    e.onclick = () => tapCard(c);
    cards.appendChild(e);
  }
  row.appendChild(cards);
  return row;
}

function meLine(g) {
  const me = ui.me;
  const parts = [`<i class="team-dot ${teamClass(myTeam())}"></i><b>${nameOf(me)}</b>${g.dealer === me ? dealerChip : ''}`];
  if (g.phase === 'bidding') {
    const call = g.calls.filter((c) => c.seat === me).pop();
    if (call) parts.push(`Your bid ${bidChip(call.bid, true)}`);
    else if (g.dealer === me) parts.push('You dealt — you bid last');
  } else if (g.phase === 'kitty' || g.phase === 'playing') {
    const t = shownTricks(g, me);
    parts.push(me === g.contractor ? `★ ${bidChip(g.highBid)} · ${t}` : `${t} trick${t === 1 ? '' : 's'}`);
  }
  return el('div', 'me-line' + (isMyTurn(g) ? ' turn' : ''), `<span class="pill">${parts.join('<span class="sep"></span>')}</span>`);
}

/** My hand in the app's order: suits alternate black and red so the same color never
 *  touches; once trumps are named they sit together on the right, strongest last (the
 *  bowers and the Joker with them), unless putting them between two suits of the other
 *  color keeps those apart. Ties prefer ♠ ♦ ♣ ♥. With no trump suit the Joker goes last. */
export function defaultOrder(hand, trump, highFirst = true) {
  const ts = trump === null ? null : trumpSuit(trump);
  const trumpCard = (c) => trump !== null && isTrump(c, trump);
  const groups = SUITS.filter((s) => hand.some((c) => c !== JOKER && !trumpCard(c) && suitOf(c) === s));
  if (ts !== null && hand.some(trumpCard)) groups.push(ts);
  const preferred = [0, 2, 1, 3];       // ♠ ♦ ♣ ♥
  const permutations = (list) => (list.length <= 1 ? [list] : list.flatMap((first) => permutations(list.filter((x) => x !== first)).map((rest) => [first, ...rest])));
  const score = (order) => {
    const colors = order.map(isRedSuit);
    let clashes = 0;
    for (let i = 1; i < colors.length; i++) if (colors[i] === colors[i - 1]) clashes++;
    const trumpsNotLast = ts !== null && order.includes(ts) && order[order.length - 1] !== ts ? 1 : 0;
    return [clashes, trumpsNotLast, ...order.map((s) => preferred.indexOf(s))];
  };
  const before = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
  let suitOrder = [], best = null;
  for (const order of permutations(groups)) { const s = score(order); if (!best || before(s, best)) { best = s; suitOrder = order; } }
  const key = (c) => {
    if (trumpCard(c)) return [suitOrder.indexOf(ts), 100 + power(c, trump)];
    if (c === JOKER) return [11, 0];
    return [suitOrder.indexOf(suitOf(c)), rankOf(c)];
  };
  return hand.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] !== kb[0] ? ka[0] - kb[0] : highFirst ? kb[1] - ka[1] : ka[1] - kb[1];
  });
}

function handRow(g, revealing) {
  const me = ui.me;
  const row = el('div', 'handrow');
  const hand = defaultOrder(g.hands[me], G.trumpOf(g), settings.highFirst);
  const legal = new Set(G.legalPlays(g, me));
  const myTurn = isMyTurn(g) && g.phase === 'playing';
  const choosing = isMyTurn(g) && g.phase === 'kitty' && !revealing;
  // Overlap the cards just enough to fit the screen.
  const cardW = sizes().hand;
  const width = Math.min(document.documentElement.clientWidth - 24, 1000);
  const natural = cardW + 4;
  const step = hand.length > 1 ? Math.min(natural, (width - cardW) / (hand.length - 1)) : natural;
  row.style.setProperty('--overlap', `${step - cardW}px`);
  for (const c of hand) {
    const e = cardEl(c);
    if (choosing) e.classList.add(ui.selected.has(c) ? 'picked' : 'choosable');
    if (myTurn && c === ui.pending) e.classList.add('picked');
    else if (myTurn && legal.has(c)) e.classList.add('playable');
    else if (myTurn) e.classList.add('dim');
    if (c === ui.hintCard) e.classList.add('hinted');
    e.onclick = () => tapCard(c);
    row.appendChild(e);
  }
  return row;
}

// MARK: Taps and moves

function perform(move) {
  const g = state.game;
  if (!isMyTurn(g) || waitingOnHost()) return;
  const full = { ...move, seat: ui.me };
  if (!G.canApply(g, full, ui.me)) return;
  ui.pending = null; ui.hint = null; ui.hintCard = null;
  if (g.phase === 'kitty') ui.selected.clear();
  if (isOnline() && !host.isHost) { ui.sentAt = state.version; render(); }
  host.send(full);
}

/** A card in my hand (or the kitty beside it): pick it for the throw-back, or play it. */
function tapCard(c) {
  const g = state.game, me = ui.me;
  if (!isMyTurn(g) || waitingOnHost()) return;
  if (g.phase === 'kitty') {
    if (Date.now() < ui.revealStart + PACE.kittyCard * G.KITTY_SIZE + PACE.kittyHold) return;
    if (ui.selected.has(c)) ui.selected.delete(c);
    else if (ui.selected.size < G.KITTY_SIZE) ui.selected.add(c);
    else ui.hint = 'That’s 5 already — tap a picked card to put it back first.';
    ui.hintCard = null;
    render();
    return;
  }
  if (g.phase !== 'playing') return;
  if (!G.legalPlays(g, me).includes(c)) {
    // Say why the card can't be played.
    const led = G.ledSuit(g), trump = G.trumpOf(g);
    if (led !== null) {
      const bower = c !== JOKER && rankOf(c) === JACK && isTrump(c, trump) && suitOf(c) !== trump;
      ui.hint = `You have to follow ${SUIT_NAME[led].toLowerCase()}` + (bower ? ' — and that jack counts as a trump this hand.' : '.');
    } else ui.hint = 'In No Trumps the Joker can only lead to a suit nobody has led yet.';
    ui.hintCard = null;
    render();
    return;
  }
  if (ui.pending === c) confirmPlay();
  else { ui.pending = c; ui.hint = null; render(); }
}

/** Plays the picked card (asking for a suit first when leading the Joker in No Trumps). */
function confirmPlay() {
  const g = state.game, c = ui.pending;
  if (c === null) return;
  if (c === JOKER && !g.trick.length && G.trumpOf(g) === NO_TRUMPS) {
    const body = el('p', '', 'Name the suit everyone must follow. The Joker wins the trick.');
    popup('Lead the Joker as…', body, [...G.jokerLeadSuits(g).map((s) => [`${SYMBOL[s]} ${SUIT_NAME[s]}`, '', () => perform({ type: 'play', card: JOKER, jokerSuit: s })]), ['Cancel', '']]);
    return;
  }
  perform({ type: 'play', card: c, jokerSuit: null });
}

function throwBack() {
  if (ui.selected.size !== G.KITTY_SIZE) return;
  perform({ type: 'discard', cards: [...ui.selected] });
}

/** What a Steady bot would do here (the app's Suggest). */
async function suggest() {
  const g = state.game, me = ui.me;
  if (!isMyTurn(g) || ui.thinkingHint) return;
  ui.thinkingHint = true;
  render();
  const version = state.version;
  const move = await think(g, me, 'steady');
  ui.thinkingHint = false;
  if (state.version !== version) return render();
  ui.hintCard = null;
  if (move.type === 'bid') ui.hint = `Bid ${bidLabel(move.bid)} (${bidValue(move.bid)}).`;
  else if (move.type === 'pass') ui.hint = G.standing(g) ? `Keep ${bidLabel(g.highBid)}.` : 'Pass.';
  else if (move.type === 'discard') {
    ui.hint = 'Throw ' + defaultOrder(move.cards, G.trumpOf(g), settings.highFirst).map(label).join(', ') + '.';
    ui.selected = new Set(move.cards);
  } else if (move.type === 'play') {
    ui.hint = `Play the ${label(move.card)}` + (move.jokerSuit !== null && move.jokerSuit !== undefined ? ` and name ${SUIT_NAME[move.jokerSuit].toLowerCase()}` : '') + '.';
    ui.hintCard = move.card;
  }
  render();
}

// MARK: Overlays drawn with the table

/** Every hand so far, like a score pad: who bid what, made or set, the tricks each side
 *  took, the points each side gained, and the running totals. */
function scoreSheet(g) {
  const us = myTeam(), them = 1 - us;
  const t = el('table', 'sheet');
  t.appendChild(el('tr', '', '<th>#</th><th class="bidcol">Bid</th><th>Tricks</th><th class="us">Us</th><th class="them">Them</th>'));
  if (!g.history.length) t.appendChild(el('tr', '', '<td colspan="5" class="faint">No hands played yet</td>'));
  const total = [0, 0];
  g.history.forEach((h, i) => {
    total[0] += h.points[0]; total[1] += h.points[1];
    const mark = h.slam ? '<em class="made">slam</em>' : h.made ? '<em class="made">made</em>' : '<em class="set">set</em>';
    t.appendChild(el('tr', '', `<td class="faint">${i + 1}</td><td class="bidcol"><i class="team-dot ${teamClass(G.team(h.contractor))}"></i>${who(h.contractor)} ${bidChip(h.contract)} ${mark}</td>`
      + `<td>${h.tricks[us]}–${h.tricks[them]}</td>`
      + `<td class="pts"><small>${signed(h.points[us])}</small><b class="us">${total[us]}</b></td><td class="pts"><small>${signed(h.points[them])}</small><b class="them">${total[them]}</b></td>`));
  });
  return t;
}

function scorePair(g, big = false) {
  const us = myTeam();
  return el('div', 'score-pair' + (big ? ' big' : ''), [us, 1 - us].map((t) => `<div><small>${t === us ? 'Us' : 'Them'}</small><b class="${teamClass(t)}">${g.scores[t]}</b></div>`).join(''));
}

/** The end of a hand: the contract, the tricks each team took, made or set and why, the
 *  points, and the score. */
function resultPanel(g) {
  const r = g.result, me = ui.me;
  const team = G.team(r.contractor), other = 1 - team;
  const body = el('div', 'result');
  body.appendChild(el('div', 'contract-line', `${who(r.contractor)} bid ${bidChip(r.contract, true)} for ${bidValue(r.contract)}`));
  const boxes = el('div', 'tricks-boxes');
  const box = (t, n, text) => `<div class="box"><small>${teamPlayers(t)}</small><b class="${teamClass(t)}">${n}</b><span>tricks · ${text}</span></div>`;
  boxes.innerHTML = box(team, r.tricks[team], `needed ${r.contract.tricks}`) + box(other, r.tricks[other], 'defending');
  body.appendChild(boxes);
  body.appendChild(el('p', 'explain', explanation(g, r, team, other)));
  const points = el('div', 'score-pair');
  points.innerHTML = [myTeam(), 1 - myTeam()].map((t) => `<div><small>${t === myTeam() ? 'Us' : 'Them'}</small><span class="${teamClass(t)}">${signed(r.points[t])}</span><b>${g.scores[t]}</b></div>`).join('');
  body.appendChild(points);
  const buttons = [button('Score Sheet', '', () => { ui.showSheet = true; render(); })];
  if (g.phase === 'gameOver') buttons.push(button('Final Score', 'primary', () => { ui.showFinal = true; render(); }));
  else if ((g.continued || []).includes(me)) {
    const waiting = g.humanSeats.filter((s) => !(g.continued || []).includes(s)).map(nameOf);
    const left = g.continueDeadline ? Math.max(0, Math.ceil((g.continueDeadline - Date.now()) / 1000)) : null;
    buttons.push(el('div', 'pill', `⏳ Waiting for ${waiting.join(', ') || 'the others'}…${left !== null ? ' ' + left : ''}`));
    redrawAt(Date.now() + 1000);
  } else buttons.push(button('Next Hand', 'primary', () => host.send({ type: 'continue', seat: me })));
  const title = r.made ? (r.slam ? 'Slam!' : 'Made it!') : 'Set!';
  const panel = dialog(title, body, buttons);
  if (ui.showSheet) panel.appendChild(sheetPanel(g));
  return panel;
}

function explanation(g, r, team, other) {
  const bidders = teamPlayers(team), defenders = teamPlayers(other);
  const defending = `${defenders} score 10 a trick: ${r.points[other]}.`;
  let text;
  if (r.made) {
    const slamNote = r.slam && bidValue(r.contract) < G.SLAM_VALUE ? ` All ten tricks are worth at least ${G.SLAM_VALUE}.` : '';
    text = `${bidders} needed ${r.contract.tricks} and took ${r.tricks[team]}, so they score ${r.points[team]}.${slamNote} ${defending}`;
  } else {
    text = `${bidders} needed ${r.contract.tricks} but took only ${r.tricks[team]}, so they lose ${bidValue(r.contract)}. ${defending}`;
  }
  if (g.winner !== null) {
    text += g.scores[g.winner] >= G.TARGET
      ? ` That takes ${teamPlayers(g.winner)} to ${g.scores[g.winner]} — they win!`
      : ` ${teamPlayers(1 - g.winner)} fall to ${g.scores[1 - g.winner]} — out the back door.`;
  }
  return text;
}

/** The end of the game: who won and how, the final score, the bots' secret styles, and
 *  every hand. */
function finalPanel(g) {
  const won = g.winner === myTeam();
  const backDoor = g.scores[1 - g.winner] <= G.BACK_DOOR;
  const body = el('div', 'final');
  body.appendChild(el('div', 'how', backDoor ? (won ? 'They went out the back door (−500).' : 'We went out the back door (−500).')
    : (won ? 'We reached 500.' : 'They reached 500.')));
  body.appendChild(scorePair(g, true));
  const bots = [0, 1, 2, 3].filter((s) => state.seats[s].kind === 'bot' && !state.seats[s].standIn && g.botStyles[s]);
  if (bots.length) {
    const reveal = el('div', 'reveal', '<h3>Turns out…</h3>');
    for (const s of bots) {
      const style = STYLES[g.botStyles[s]];
      reveal.appendChild(el('div', 'style', `<div><b>${nameOf(s)}</b>${s === partnerSeat() ? ' (partner)' : ''} <span class="faint">was</span> <b class="gold">${style.title}</b></div><small>${style.blurb}</small>`));
    }
    body.appendChild(reveal);
  }
  const sheet = el('div', 'sheet-box');
  sheet.appendChild(scoreSheet(g));
  body.appendChild(sheet);
  const line = stats[isOnline() ? 'online' : 'computer'];
  if (line.played) body.appendChild(el('div', 'note', `${line.won} win${line.won === 1 ? '' : 's'} · ${line.lost} loss${line.lost === 1 ? '' : 'es'} ${isOnline() ? 'with friends' : 'vs the computer'}`));
  return dialog(won ? 'We win!' : 'They win', body, [button('Play Again', 'primary', () => host.send({ type: 'newGame' })), button('Leave', '', leaveTable)]);
}

function sheetPanel(g) {
  const close = () => { ui.showSheet = false; render(); };
  const body = el('div');
  body.appendChild(scorePair(g, true));
  body.appendChild(el('div', 'note', `First to ${G.TARGET} wins · ${G.BACK_DOOR} loses`));
  const box = el('div', 'sheet-box');
  box.appendChild(scoreSheet(g));
  body.appendChild(box);
  return dialog('Score Sheet', body, [button('Close', 'primary', close)], close);
}

function pausedPanel() {
  const away = state.paused;
  const body = el('div');
  body.appendChild(el('p', '', `Waiting for <b>${esc(away.name)}</b> to come back… They reopen the link, or tap Back to Table on the start screen.`));
  const buttons = [];
  if (isOnline() && host.isHost) {
    buttons.push(button(`Let a Bot Play for ${away.name}`, 'primary', () => host.send({ type: 'standIn', away: away.seat })));
    body.appendChild(el('div', 'note', 'They get their seat back as soon as they return.'));
  }
  buttons.push(button('Leave', '', leaveTable));
  return dialog('Paused', body, buttons);
}

// MARK: Dialogs on top of the table

function showMenu() {
  const online = isOnline();
  popup(online ? `Table ${host.code}` : 'Menu', null, [
    ['Score Sheet', '', () => { ui.showSheet = true; render(); }],
    ['Statistics', '', showStats],
    ['Settings', '', () => showSettings(render)],
    ['How to Play', '', showRules],
    ['New Game', '', () => confirmThen('New Game?', online ? 'This starts the game over for everyone at the table.' : 'This game’s scores will be lost.', 'New Game', () => host.send({ type: 'newGame' }))],
    ['Leave', '', () => {
      if (online && state.game.phase !== 'gameOver') confirmThen('Leave the Table?', 'The game waits for you (or the host lets a bot play). Come back with Back to Table on the start screen.', 'Leave', leaveTable);
      else leaveTable();
    }],
    ['Close', 'primary'],
  ]);
}

function showSettings(after) {
  const form = el('div', 'settings');
  form.innerHTML = `
    <label class="name-setting">Your name <input class="text" id="name" maxlength="16" autocomplete="nickname"></label>
    <label>Card back <select id="back">${['red', 'green', 'blue', 'black'].map((c) => `<option value="${c}" ${settings.back === c ? 'selected' : ''}>${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}</select></label>
    <label>Highest card on the left <input type="checkbox" id="high" ${settings.highFirst ? 'checked' : ''}></label>
    <label>Large card letters <input type="checkbox" id="large" ${settings.largePrint ? 'checked' : ''}></label>
    <label>Sounds <input type="checkbox" id="sounds" ${settings.sounds ? 'checked' : ''}></label>
    <label>Suggest button (hints) <input type="checkbox" id="hints" ${settings.hints ? 'checked' : ''}></label>`;
  form.querySelector('#name').value = settings.name;
  // Seated at a table, the name is already taken; change it from the start screen.
  if (state) form.querySelector('.name-setting').remove();
  const done = () => {
    const name = form.querySelector('#name')?.value.trim().slice(0, 16);
    if (name) settings.name = name;
    settings.back = form.querySelector('#back').value;
    settings.highFirst = form.querySelector('#high').checked;
    settings.largePrint = form.querySelector('#large').checked;
    settings.sounds = form.querySelector('#sounds').checked;
    settings.hints = form.querySelector('#hints').checked;
    if (!settings.hints) { ui.hint = null; ui.hintCard = null; }
    saveSettings();
    after?.();
  };
  popup('Settings', form, [['Done', 'primary', done]], done);     // Closing any way keeps the changes.
}

function showStats() {
  const pct = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
  const rows = [
    ['Games', (l) => l.played], ['Won', (l) => l.won], ['Lost', (l) => l.lost], ['Win rate', (l) => pct(l.won, l.played)],
    ['Out the back door', (l) => l.backDoor], ['Hands', (l) => l.hands],
    ['Our contracts made', (l) => `${l.contractsMade}/${l.contracts} (${pct(l.contractsMade, l.contracts)})`],
    ['My bids made', (l) => `${l.myBidsMade}/${l.myBids} (${pct(l.myBidsMade, l.myBids)})`],
    ['Slams', (l) => l.slams], ['Their bids we set', (l) => l.defenseSets], ['Best hand', (l) => l.bestHand],
  ];
  const t = el('table', 'stats');
  t.appendChild(el('tr', '', '<th></th><th>vs the Computer</th><th>with Friends</th>'));
  for (const [name, f] of rows) t.appendChild(el('tr', '', `<td>${name}</td><td>${f(stats.computer)}</td><td>${f(stats.online)}</td>`));
  const body = el('div');
  body.appendChild(t);
  body.appendChild(el('div', 'note', 'Kept on this device.'));
  popup('Statistics', body, [
    ['Reset', '', () => confirmThen('Reset Statistics?', 'Every game and hand recorded on this device is forgotten.', 'Reset', () => {
      stats.computer = blankLine(); stats.online = blankLine(); saveStats();
    })],
    ['Done', 'primary'],
  ]);
}

function showRules() {
  const body = el('div', 'rules', `
    <p><b>Four players, two teams.</b> Your partner sits across from you. 45 cards: A–4 in every suit, and the Joker. Ten cards each and five in the kitty. A deal where anyone has no J, Q, K or Joker is thrown in.</p>
    <p><b>Bidding</b> goes round to the left, starting left of the dealer: bid how many tricks (6–10) your team will take, and trumps. Each bid must beat the last — more tricks, or the same with a higher suit (♠ ♣ ♦ ♥ No Trumps). Once you pass you're out. When the other three have passed, the high bidder may raise their own bid or keep it. If all four pass, the cards are dealt again.</p>
    <p><b>The kitty</b> is turned up for everyone. The winner of the bid takes it, throws back any five, and leads.</p>
    <p><b>Trumps</b>, high to low: the Joker, the jack of trumps (right bower), the other jack of the same color (left bower — it's a trump), then A K Q 10 9 … Follow suit if you can. In No Trumps the Joker wins any trick; you may play it on another suit only when you can't follow, and if you lead it you name a suit nobody has led yet.</p>
    <p><b>Scoring.</b> Make your bid and score its value (on the bid grid: 6♠ is 40, up to 10 NT at 520); all ten tricks score at least 250. Fall short and lose the bid's value. The other team scores 10 a trick. The first team to 500 wins — defending points count too — and a team at −500 is out the back door.</p>`);
  popup('How to Play', body, [['Got It', 'primary']]);
}

// MARK: Start

let resizeFrame = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(render); });

if (params.get('name')) { settings.name = params.get('name').slice(0, 16); saveSettings(); }
if (params.has('fast')) Object.assign(PACE, { bot: 20, trickPause: 30, trickSweep: 20, kittyCard: 10, kittyHold: 20, resultHold: 30, autoNext: 60 });
const tableCode = params.get('t') || params.get('newtable');
if (tableCode && onlineAvailable()) {
  const go = () => (params.get('newtable') ? withTable(OnlineTable.create(myName(), onTableUpdate, tableCode)) : joinTable(tableCode));
  // Someone opening a shared link for the first time: their name before their seat.
  if (settings.name) go(); else askName(go);
} else if (params.has('play') || params.has('autoplay')) playComputer();
else showLobby();
