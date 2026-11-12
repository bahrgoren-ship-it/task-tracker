// Context menus: right-click (or the keyboard's menu key / Shift+F10) on a task, a work block, an empty time in the
// planner, a Moodle message or a category chip opens a small menu of what makes sense there. On touch screens a
// long-press does the same (except inside the planner, where a long-press drags). Shift + right-click, a link, a text
// field or selected text keep the browser's own menu.
//
// Items: { label, icon, run, danger, disabled, hint } · { sep: true } · { title } (a heading) ·
//        { label, choices: [{ label, on, run }] } (a row of quick choices) · { label, checked, run } (a toggle) ·
//        { label, icon, href } (opens a link in a new tab).

const ICONS = {
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  play: '<path d="M8 5.5v13l10-6.5-10-6.5Z"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>',
  plan: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M12 12v6M9 15h6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 11h6M9 15h4"/>',
  dup: '<rect x="4" y="4" width="11" height="11" rx="2"/><path d="M9 19h9a2 2 0 0 0 2-2V8M15 9.5v4M13 11.5h4" transform="translate(0 1)"/>',
  link: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  open: '<path d="M4 6h16v13H4zM4 10h16M9 14h6"/>',
  move: '<path d="M14 6l-6 6 6 6"/><path d="M8 12h12" transform="translate(0 0)"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  ai: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>',
  cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  read: '<path d="M4 4h16v12H5.2L4 17.5V4Z"/><path d="m8.5 10 2.2 2.2L15.5 7.5"/>',
};
const icon = (name) => (ICONS[name] ? `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>` : '<span class="ctx-noicon"></span>');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let menu = null;          // the open menu element
let actions = [];         // its actions, by data-i
let opener = null;        // element to give the focus back to
let openedAt = 0;
let suppressClickUntil = 0;
let swallowLift = false;  // opened by a finger: the click when that finger lifts is not a choice
let press = null;         // a touch long-press in progress
const LONG_PRESS = 520;   // ms
const MOVE_TOLERANCE = 10;

/**
 * Wires the menus up. resolve(target, point) returns the items for that spot, or null for the browser's own menu, or
 * false to show nothing at all (e.g. a long-press that drags in the planner).
 * longPressSel = where a long-press on a touch screen opens the menu too.
 */
export function init({ resolve, longPressSel }) {
  document.addEventListener('contextmenu', (e) => {
    if (Date.now() - openedAt < 700 && menu) { e.preventDefault(); return; } // the long-press already opened it
    if (keepNative(e)) return;
    const at = pointOf(e);
    const items = resolve(e.target, at, e);
    if (items === null || items === undefined) return;
    e.preventDefault();
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (items) { open(items, { ...at, touch }, e.target); swallowLift = touch; }
  });
  // a long-press on a touch screen (iPhone / iPad don't send contextmenu)
  document.addEventListener('pointerdown', (e) => {
    swallowLift = false; // a new touch: its click is meant
    if (menu && !menu.contains(e.target)) { close(); suppressClickUntil = Date.now() + 450; }
    if (e.pointerType === 'mouse' || !e.target.closest(longPressSel) || e.target.closest('input, textarea, select, a[href], [contenteditable], .ib-text, .ib-summary')) return;
    if (document.querySelector('dialog[open]')) return;
    press = { x: e.clientX, y: e.clientY, target: e.target, id: e.pointerId };
    press.timer = setTimeout(() => {
      if (!press) return;
      const p = press; press = null;
      const at = { x: p.x, y: p.y, touch: true };
      const items = resolve(p.target, at, null);
      if (!items) return;
      navigator.vibrate?.(10);
      open(items, at, p.target);
      swallowLift = true; // the finger lifting would "tap" what's under it (the card, or the menu)
    }, LONG_PRESS);
  }, true);
  const cancelPress = (e) => {
    if (!press || (e.pointerId !== undefined && e.pointerId !== press.id)) return;
    if (e.type === 'pointermove' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < MOVE_TOLERANCE) return;
    clearTimeout(press.timer); press = null;
  };
  ['pointermove', 'pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, cancelPress, true));
  window.addEventListener('scroll', (e) => {
    if (press) { clearTimeout(press.timer); press = null; }
    // the page scrolling away closes the menu — but not a scroll already on its way when it opened (momentum), nor
    // scrolling inside the menu itself
    if (menu && Date.now() - openedAt > 250 && !menu.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', (e) => { if (menu && e.key === 'Escape') { e.preventDefault(); close(); } }, true);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  document.addEventListener('click', (e) => {
    if (swallowLift) { swallowLift = false; e.preventDefault(); e.stopPropagation(); return; }
    if (Date.now() < suppressClickUntil && !(menu && menu.contains(e.target))) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

/** The browser's own menu: Shift held, on a link / text field, or with text selected (to copy it). */
function keepNative(e) {
  if (e.shiftKey) return true;
  if (e.target.closest('input, textarea, select, a[href], [contenteditable]')) return true;
  if (String(window.getSelection?.() || '').trim()) return true;
  return !!document.querySelector('dialog[open]'); // a sheet is open: its own content keeps the normal menu
}

/** Where to open: the pointer, or (from the keyboard) the focused element. */
function pointOf(e) {
  if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
  const r = e.target.getBoundingClientRect();
  return { x: r.right - 12, y: r.top + Math.min(r.height, 40) };
}

export function isOpen() { return !!menu; }

/** Opens a menu with these items at a point (viewport coordinates). */
export function open(items, at, from) {
  close();
  if (press) { clearTimeout(press.timer); press = null; }
  const list = items.filter(Boolean);
  if (!list.length) return;
  actions = [];
  const html = list.map((it) => {
    if (it.sep) return '<div class="ctx-sep" role="separator"></div>';
    if (it.title) return `<div class="ctx-title" dir="auto">${esc(it.title)}</div>`;
    if (it.choices) {
      return `<div class="ctx-row" role="group" aria-label="${esc(it.label)}"><span class="ctx-row-l">${esc(it.label)}</span><div class="ctx-choices">${it.choices.map((c) => {
        actions.push(c);
        return `<button type="button" class="ctx-choice ${c.on ? 'on' : ''}" role="menuitemradio" aria-checked="${!!c.on}" data-i="${actions.length - 1}">${esc(c.label)}</button>`;
      }).join('')}</div></div>`;
    }
    actions.push(it);
    const i = actions.length - 1;
    const cls = `ctx-item${it.danger ? ' danger' : ''}`;
    const inner = `${it.checked !== undefined ? `<span class="ctx-check" aria-hidden="true">${it.checked ? icon('check') : ''}</span>` : icon(it.icon)}<span class="ctx-l" dir="auto">${esc(it.label)}</span>${it.hint ? `<span class="ctx-hint" dir="auto">${esc(it.hint)}</span>` : ''}`;
    if (it.href) return `<a class="${cls}" role="menuitem" href="${esc(it.href)}" target="_blank" rel="noopener" data-i="${i}">${inner}</a>`;
    const role = it.checked !== undefined ? `role="menuitemcheckbox" aria-checked="${!!it.checked}"` : 'role="menuitem"';
    return `<button type="button" class="${cls}" ${role} data-i="${i}" ${it.disabled ? 'disabled' : ''}>${inner}</button>`;
  }).join('');
  menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;
  menu.dir = 'rtl';
  menu.innerHTML = html;
  document.body.appendChild(menu);
  place(menu, at);
  opener = from && from.focus ? (from.closest('button, [tabindex], a') || null) : null;
  openedAt = Date.now();
  menu.addEventListener('click', onMenuClick);
  menu.addEventListener('keydown', onKey);
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  requestAnimationFrame(() => menu?.classList.add('show'));
  // keyboard / mouse: the first item has the focus (arrows move it); a finger: the menu itself (nothing lit up)
  (at.touch ? menu : focusable()[0])?.focus({ preventScroll: true });
}

export function close() {
  if (!menu) return;
  menu.remove();
  menu = null;
  actions = [];
  const o = opener; opener = null;
  if (o && document.contains(o)) o.focus({ preventScroll: true });
}

function place(el, at) {
  const m = 8, vw = window.innerWidth, vh = window.innerHeight;
  const w = el.offsetWidth, h = el.offsetHeight;
  // right-to-left: the menu grows leftwards from the pointer, unless there's no room there
  let x = at.x - w;
  if (x < m) x = Math.min(at.x, vw - w - m);
  let y;
  if (at.touch) { // a finger: above it, where it doesn't cover the menu (or below, with a gap)
    y = at.y - h - 18;
    if (y < m) y = at.y + 28;
  } else {
    y = at.y + 2;
    if (y + h > vh - m) y = Math.max(m, at.y - h - 2);
  }
  el.style.left = `${Math.max(m, x)}px`;
  el.style.top = `${Math.max(m, Math.min(y, vh - h - m))}px`;
}

const focusable = () => (menu ? [...menu.querySelectorAll('button:not([disabled]), a[href]')] : []);

function onMenuClick(e) {
  const el = e.target.closest('[data-i]');
  if (!el || el.disabled) return;
  const it = actions[+el.dataset.i];
  if (it.href) { close(); return; } // the link opens by itself
  e.preventDefault();
  close();
  if (it.run) it.run();
}

function onKey(e) {
  const items = focusable();
  const i = items.indexOf(document.activeElement); // -1 = the menu itself: ↓ goes to the first item
  const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
  if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if (e.key === 'Tab') close();
  else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && document.activeElement?.classList.contains('ctx-choice')) {
    // within a row of choices (right-to-left: ArrowLeft = next)
    const row = [...document.activeElement.parentElement.children];
    const j = row.indexOf(document.activeElement) + (e.key === 'ArrowLeft' ? 1 : -1);
    if (row[j]) { e.preventDefault(); row[j].focus(); }
  }
}

/** Copies text to the clipboard; false if the browser refused. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
