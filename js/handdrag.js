// Drag a card sideways in your hand to move it, as in the iPhone apps. The order you make
// lasts for the hand; cards that arrive later (the kitty, a pass) slot in after their
// neighbor in the game's own order. A short tap is still a tap.
//
// The same file in every web game (master copy: ~/code/cardgames-home/shared/handdrag.js).
//
//   const order = new HandOrder();
//   const hand = order.arrange(defaultOrder, handId);     // a new handId starts fresh
//   ...draw one element per card in `hand`...
//   makeDraggable(hand, elements, (c, to) => { order.move(hand, c, to); render(); });
//   function render() { if (deferWhileDragging(render)) return; ... }
// CSS: .card.dragging { transform: translate(var(--drag-x), -20%) scale(1.08) !important; ... }

const THRESHOLD = 8;          // px before a press becomes a drag (the apps use 8 too)

export class HandOrder {
  constructor() { this.keys = new Map(); this.hand = null; }

  /** My hand in my order: the default order, with any cards I've dragged where I put them. */
  arrange(defaultOrder, handId) {
    if (handId !== this.hand) { this.keys = new Map(); this.hand = handId; }
    if (!this.keys.size) return defaultOrder.slice();
    const keys = new Map();
    let last = -1;
    for (const c of defaultOrder) {
      if (this.keys.has(c)) last = this.keys.get(c);
      else last += 0.001;
      keys.set(c, last);
    }
    return defaultOrder.slice().sort((a, b) => keys.get(a) - keys.get(b));
  }

  /** Move `card` to position `to` in `hand` (the order now on screen). */
  move(hand, card, to) {
    const from = hand.indexOf(card);
    if (from < 0 || from === to) return false;
    const order = hand.slice();
    order.splice(from, 1);
    order.splice(to, 0, card);
    this.keys = new Map(order.map((c, i) => [c, i]));
    return true;
  }
}

let active = null;            // The drag in progress: { el, ... }
let deferred = null;          // A redraw asked for mid-drag, run when it ends.
let quietUntil = 0;           // Taps until then are the end of a drag, not taps.

/** Call at the top of render(): true while a card is being dragged (the redraw then runs
 *  when the drag ends, so the bots playing don't pull the card out from under a finger). */
export function deferWhileDragging(render) {
  if (!active) return false;
  deferred = render;
  return true;
}

function finish() {
  active = null;
  const r = deferred;
  deferred = null;
  r?.();
}

/** Let each card element in `els` (in the order of `hand`) be dragged sideways.
 *  `onMove(card, toIndex)` is called when one is dropped in a new place. */
export function makeDraggable(hand, els, onMove) {
  els.forEach((e, index) => {
    e.style.touchAction = 'none';
    // At the card itself (capture runs before its own onclick): a drag isn't a tap.
    e.addEventListener('click', (c) => { if (Date.now() < quietUntil) { c.stopImmediatePropagation(); c.preventDefault(); } }, true);
    e.addEventListener('pointerdown', (down) => {
      if (down.button !== 0 || active || hand.length < 2) return;
      const x0 = down.clientX;
      let dragging = false;
      const move = (ev) => {
        if (ev.pointerId !== down.pointerId) return;
        const dx = ev.clientX - x0;
        if (!dragging && Math.abs(dx) < THRESHOLD) return;
        if (!dragging) {
          dragging = true;
          active = { el: e };
          e.classList.add('dragging');
          try { e.setPointerCapture(down.pointerId); } catch {}
        }
        e.style.setProperty('--drag-x', `${dx}px`);
      };
      const up = (ev) => {
        if (ev.pointerId !== down.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (!dragging) return;
        // A drag isn't a tap: swallow the click that follows it.
        quietUntil = Date.now() + 300;
        const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 80);
        const dx = ev.type === 'pointercancel' ? 0 : ev.clientX - x0;
        const a = els[0].getBoundingClientRect(), b = els[1].getBoundingClientRect();
        const step = Math.abs(b.left - a.left) || a.width || 40;
        const to = Math.max(0, Math.min(hand.length - 1, index + Math.round(dx / step)));
        e.classList.remove('dragging');
        e.style.removeProperty('--drag-x');
        const card = hand[index];
        active = null;
        if (to !== index) onMove(card, to);
        finish();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  });
}
