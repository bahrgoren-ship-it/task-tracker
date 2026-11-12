// Planner: a week grid (RTL) where tasks are dragged in as "work blocks" (בלוקי עבודה).
//
// - Drag a task from the tray onto the grid → a 1-hour work block (length = settings.default_block_minutes).
//   On touch screens: press-and-hold, then drag. Or tap a task, then tap a time slot.
// - Drag a block to move it, drag its bottom edge to resize it, tap it to edit.
// - Take a block back off: drag it back onto the task list, use its ✕, or "הסר מהלוח" in its sheet.
//   Every placement / move / resize / removal can be undone from the toast ("בטל").
// - A block is in Google Calendar as soon as it is placed (no drafts / "אשר תכנון" since backend v9; the backend
//   turns an old 'draft' into 'planned'), and changes made there come back. Only a block whose "להציג ביומן
//   Google" is unchecked stays out. The user's own calendar events are shown in grey as busy time.
// - Right-click (menuAt): a block → edit, task, timer, state, move / duplicate to tomorrow, copy, calendar; an empty
//   time → new block there, paste a copied block; a task in the tray / a deadline → the task's menu (from app.js).
//   On a touch screen a long-press here drags, so it opens no menu.
import { store } from './store.js';
import { todayIL, addDays, dayDiff, weekday, shortDate, nowIL, fmtMinutes, dueLabel } from './dates.js';
import { calendarState, calendarText, noticeHtml } from './notices.js';
import { calendarOf, calLabel } from './categories.js';

const START_H = 6, END_H = 24;          // visible hours
const SNAP = 15;                        // minutes
const LONG_PRESS = 280;                 // ms before a touch becomes a drag

let ui = {};                            // callbacks from app.js: openEditor, openTimer, toast, taskMenu
let root;
let view = { start: null, days: 7 };    // first visible day + number of days
let selectedTask = null;                // tap-to-place mode
let busyCache = {};                     // "from|to" → events
let drag = null;                        // active drag state
let lastSig = '';
let lastPointer = 'mouse';              // type of the last pointer that went down here (touch: long-press = drag)
let clip = null;                        // a copied block: { task_id, len, note, sync_calendar }

const $ = (sel, r = root) => r.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// a phone turned sideways: little height, so shorter hours (matches the CSS media query)
const shortLandscape = () => window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches;
const hourPx = () => (shortLandscape() ? 40 : window.innerWidth < 600 ? 46 : 52);
const toMin = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const isOpen = (t) => t.status !== 'done' && t.status !== 'cancelled';
// tasks you can plan: open, and not in an archived category (their blocks stay on the calendar as history)
const plannable = (t) => isOpen(t) && !store.taskArchived(t);
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

export function initPlanner(el, callbacks) {
  root = el; ui = callbacks;
  resetView();
  root.addEventListener('click', onClick);
  root.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('touchmove', (e) => { if (drag && drag.active) e.preventDefault(); }, { passive: false });
  let lastHour = hourPx();
  window.addEventListener('resize', () => {
    const d = daysForWidth(), h = hourPx();
    if (d !== view.days) { resetView(); render(true); } else if (h !== lastHour) render(true);
    lastHour = h;
  });
  setInterval(() => { if (!root.hidden) drawNowLine(); }, 60000);
}

function daysForWidth() {
  const w = window.innerWidth;
  return w >= 1000 ? 7 : w >= 700 ? 5 : 3;
}
function resetView() {
  view.days = daysForWidth();
  const t = todayIL();
  view.start = view.days === 7 ? addDays(t, -new Date(t + 'T12:00:00Z').getUTCDay()) : t; // week view starts Sunday
}
function visibleDays() { return Array.from({ length: view.days }, (_, i) => addDays(view.start, i)); }

/** Line under the screen title: how much work is planned in the visible days. */
export function summary() {
  if (!view.start) return '';
  const days = visibleDays();
  const blocks = store.data.blocks.filter((b) => b.state !== 'skipped' && days.includes(b.start.slice(0, 10)));
  const min = blocks.reduce((s, b) => s + Math.max(0, minutes(b.start, b.end)), 0);
  if (!blocks.length) return 'אין בלוקי עבודה בימים האלה';
  return `${fmtMinutes(min)} ש׳ מתוכננות`;
}

/* ------------------------------------------------------------------ render ---- */

export function render(force = false) {
  if (!root || root.hidden) return;
  if (drag && drag.active) return; // never redraw under the finger
  const days = visibleDays();
  const sig = JSON.stringify([days, store.data.blocks, store.data.tasks, store.data.courses, store.data.groups, selectedTask,
    busyCache[`${days[0]}|${days[days.length - 1]}`] ? 1 : 0, store.setting('sync_blocks_to_calendar'), store.setting('calendar_status'),
    store.setting('blocks_calendar_name'), store.setting('other_blocks_calendar_name'), store.ui('dismissed', {}), window.innerWidth >= 900]);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  const keepScroll = $('.pl-scroll')?.scrollTop;

  const first = days[0], last = days[days.length - 1];
  const range = first.slice(5, 7) === last.slice(5, 7)
    ? `${+first.slice(8)}–${+last.slice(8)} ב${MONTHS[+first.slice(5, 7) - 1]}`
    : `${shortDate(first)} – ${shortDate(last)}`;

  root.innerHTML = `
    <div class="pl-toolbar">
      <div class="pl-nav">
        <button class="icon-btn" data-nav="prev" aria-label="הקודם"><svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></button>
        <button class="btn ghost sm" data-nav="today">היום</button>
        <button class="icon-btn" data-nav="next" aria-label="הבא"><svg viewBox="0 0 24 24"><path d="m15 6-6 6 6 6"/></svg></button>
        <span class="pl-range">${esc(range)}</span>
      </div>
    </div>
    ${calendarNotice()}
    ${selectedTask ? `<div class="pl-banner">הקש על שעה בלוח כדי לשבץ את „${esc(store.task(selectedTask)?.title || '')}” <button class="btn ghost sm" data-cancelsel>ביטול</button></div>` : ''}
    <div class="pl-body">
      <aside class="pl-tray" aria-label="משימות לתכנון">${trayHtml()}</aside>
      <div class="pl-cal" style="--days:${days.length}; --hour:${hourPx()}px">
        <div class="pl-head">
          <div class="pl-gutter"></div>
          ${days.map((d) => headHtml(d)).join('')}
        </div>
        <div class="pl-scroll">
          <div class="pl-grid" style="height:${(END_H - START_H) * hourPx()}px">
            <div class="pl-gutter">${Array.from({ length: END_H - START_H }, (_, i) => `<span style="top:${i * hourPx()}px">${toHHMM((START_H + i) * 60)}</span>`).join('')}</div>
            ${days.map((d) => `<div class="pl-day ${d === todayIL() ? 'today' : ''}" data-day="${d}">${dayEventsHtml(d)}</div>`).join('')}
          </div>
        </div>
      </div>
    </div>`;

  const sc = $('.pl-scroll');
  sc.scrollTop = keepScroll ?? Math.max(0, (Math.max(START_H, +nowIL().time.slice(0, 2) - 2) - START_H) * hourPx());
  drawNowLine();
  loadBusy(days);
  ui.onRender?.();
}

function trayHtml() {
  const tasks = store.data.tasks.filter(plannable)
    .sort((a, b) => `${a.due_date || '9999'}${a.due_time}`.localeCompare(`${b.due_date || '9999'}${b.due_time}`));
  if (!tasks.length) return '<p class="hint small">אין משימות פתוחות.</p>';
  return `<p class="tray-hint">${window.matchMedia('(pointer: coarse)').matches ? 'החזק וגרור משימה ללוח, או הקש עליה ואז על שעה' : 'גרור משימה ללוח, או לחץ עליה ואז על שעה'}. כדי להחזיר בלוק — גרור אותו לכאן או הקש על ✕.</p>
    <ul>${tasks.map((t) => {
      const c = store.course(t.course);
      const planned = store.plannedMinutes(t.id), spent = store.spentMinutes(t.id), est = Math.round((Number(t.estimate_hours) || 0) * 60);
      const missing = est ? est - planned - spent : 0;
      return `<li class="tray-task ${selectedTask === t.id ? 'sel' : ''}" data-task="${esc(t.id)}" style="--c:${esc(c ? c.color : '#8A8F98')}">
        <b dir="auto">${esc(t.title)}</b>
        <small>${t.due_date ? `<span class="${dayDiff(todayIL(), t.due_date) < 0 ? 'late' : ''}">${esc(dueLabel(t.due_date, t.due_time))}</span>` : 'ללא תאריך'}</small>
        <small>מתוכנן ${fmtMinutes(planned)}${est ? ` מתוך ${fmtMinutes(est)}` : ''}${missing > 0 ? ` <em>חסר ${fmtMinutes(missing)}</em>` : ''}</small>
      </li>`;
    }).join('')}</ul>`;
}

function headHtml(d) {
  const dl = store.data.tasks.filter((t) => t.due_date === d && plannable(t)); // finished / archived tasks don't clutter the plan
  const busy = (busyFor(d) || []).filter((e) => e.all_day);
  return `<div class="pl-dayhead ${d === todayIL() ? 'today' : ''}">
    <div class="dname">${weekday(d)} <b>${shortDate(d)}</b></div>
    ${dl.map((t) => `<button class="deadline ${t.status === 'done' ? 'done' : ''}" data-edit="${esc(t.id)}" title="הגשה">⏰ ${esc(t.title)}</button>`).join('')}
    ${busy.map((e) => `<div class="allday-busy" title="${esc(e.calendar)}">${esc(e.title)}</div>`).join('')}
  </div>`;
}

function inView(stamp) { const m = toMin(stamp.slice(11, 16)); return m >= START_H * 60 || m < END_H * 60; }
function topOf(min) { return ((min - START_H * 60) / 60) * hourPx(); }

function dayEventsHtml(d) {
  let html = '';
  // busy (Google Calendar) — background layer
  for (const e of (busyFor(d) || []).filter((x) => !x.all_day)) {
    const s = e.start.slice(0, 10) < d ? START_H * 60 : toMin(e.start.slice(11, 16));
    const en = e.end.slice(0, 10) > d ? END_H * 60 : toMin(e.end.slice(11, 16));
    if (en <= START_H * 60 || s >= END_H * 60) continue;
    const a = Math.max(s, START_H * 60), b = Math.min(en, END_H * 60);
    html += `<div class="cal-busy" style="top:${topOf(a)}px;height:${Math.max(14, topOf(b) - topOf(a))}px" title="${esc(e.calendar)}"><span>${esc(e.title)}</span></div>`;
  }
  // deadline lines with a time
  for (const t of store.data.tasks.filter((x) => x.due_date === d && x.due_time && plannable(x))) {
    const m = toMin(t.due_time);
    if (m > START_H * 60) html += `<div class="due-line" style="top:${topOf(Math.min(m, END_H * 60 - 1))}px"><span>⏰ ${esc(t.title)} ${esc(t.due_time)}</span></div>`;
  }
  // work blocks, laid out side by side when they overlap
  const blocks = store.data.blocks.filter((b) => b.start.slice(0, 10) === d && b.state !== 'skipped' && inView(b.start))
    .map((b) => ({ b, s: toMin(b.start.slice(11, 16)), e: b.end.slice(0, 10) > d ? END_H * 60 : toMin(b.end.slice(11, 16)) }))
    .sort((x, y) => x.s - y.s || y.e - x.e);
  layout(blocks);
  for (const x of blocks) html += blockHtml(x);
  return html;
}

function layout(items) {
  let cluster = [], clusterEnd = -1;
  const flush = () => { const n = Math.max(...cluster.map((i) => i.col)) + 1; cluster.forEach((i) => (i.cols = n)); cluster = []; };
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((o) => o.e > it.s).map((o) => o.col));
    let col = 0; while (used.has(col)) col++;
    it.col = col; cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
}

function blockHtml({ b, s, e, col, cols }) {
  const t = store.task(b.task_id);
  const c = t && store.course(t.course);
  const a = Math.max(s, START_H * 60), z = Math.min(e, END_H * 60);
  const h = Math.max(18, topOf(z) - topOf(a));
  const synced = !!b.calendar_event_id;
  return `<div class="blk st-${esc(b.state === 'draft' ? 'planned' : b.state)} ${h < 60 ? 'short' : ''}" data-block="${esc(b.id)}"
      style="--c:${esc(c ? c.color : '#8A8F98')};top:${topOf(a)}px;height:${h}px;inset-inline-start:calc(${(100 / cols) * col}% + 1px);width:calc(${100 / cols}% - 3px)">
    <div class="blk-t" dir="auto">${b.state === 'done' ? '✓ ' : ''}${esc(t ? t.title : '(משימה נמחקה)')}</div>
    ${h > 30 ? `<div class="blk-m"><bdi dir="ltr">${b.start.slice(11, 16)}–${b.end.slice(11, 16)}</bdi>${synced ? ' · 📅' : ''}</div>` : ''}
    <button type="button" class="blk-x" data-unplace aria-label="הסר מהלוח" title="הסר מהלוח">✕</button>
    <div class="blk-resize" data-resize></div>
  </div>`;
}

function drawNowLine() {
  const col = root && root.querySelector(`.pl-day[data-day="${todayIL()}"]`);
  root?.querySelectorAll('.now-line').forEach((n) => n.remove());
  if (!col) return;
  const m = toMin(nowIL().time);
  if (m < START_H * 60) return;
  col.insertAdjacentHTML('beforeend', `<div class="now-line" style="top:${topOf(m)}px"></div>`);
}

/* -------------------------------------------------------------- busy layer ---- */

function busyFor(d) {
  for (const [k, v] of Object.entries(busyCache)) {
    const [a, b] = k.split('|');
    if (d >= a && d <= b) return v.filter((e) => e.start.slice(0, 10) <= d && (e.all_day ? e.end > d : e.end.slice(0, 10) >= d));
  }
  return null;
}
async function loadBusy(days) {
  const k = `${days[0]}|${days[days.length - 1]}`;
  if (busyCache[k]) return;
  try {
    const data = await store.busy(days[0], days[days.length - 1]);
    if (data) { busyCache[k] = data; render(); }
  } catch { /* offline or old backend: no busy layer */ }
}
export function clearBusy() { busyCache = {}; }

/* ------------------------------------------------------------------ clicks ---- */

function onClick(e) {
  if (drag && drag.justDropped) { drag = null; return; }
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    const n = nav.dataset.nav;
    if (n === 'today') resetView();
    else view.start = addDays(view.start, n === 'next' ? view.days : -view.days);
    return render(true);
  }
  if (e.target.closest('[data-cancelsel]')) { selectedTask = null; return render(true); }
  const ed = e.target.closest('[data-edit]');
  if (ed) return ui.openEditor(ed.dataset.edit);
  const tt = e.target.closest('[data-task]');
  if (tt) { selectedTask = selectedTask === tt.dataset.task ? null : tt.dataset.task; return render(true); }
  const unplace = e.target.closest('[data-unplace]');
  if (unplace) return removeBlock(unplace.closest('[data-block]').dataset.block);
  const blk = e.target.closest('[data-block]');
  if (blk) return openBlockSheet(blk.dataset.block);
  const day = e.target.closest('.pl-day');
  if (day) {
    const start = slotFromPoint(day, e.clientY);
    if (selectedTask) { createBlock(selectedTask, day.dataset.day, start); selectedTask = null; render(true); }
    else openChooser(day.dataset.day, start);
  }
}

function slotFromPoint(dayEl, clientY) {
  const r = dayEl.getBoundingClientRect();
  const m = START_H * 60 + ((clientY - r.top) / hourPx()) * 60;
  return Math.max(START_H * 60, Math.min(END_H * 60 - SNAP, Math.floor(m / SNAP) * SNAP));
}

function defaultLen() { return Math.max(15, Number(store.setting('default_block_minutes', '60')) || 60); }

function createBlock(taskId, day, startMin, len = defaultLen(), extra = {}) {
  const endMin = Math.min(END_H * 60, startMin + len);
  const end = endMin >= 24 * 60 ? `${addDays(day, 1)} 00:00` : `${day} ${toHHMM(endMin)}`;
  const id = store.saveBlock({ task_id: taskId, start: `${day} ${toHHMM(startMin)}`, end, state: 'planned', ...extra });
  const cal = calendarWhere([{ task_id: taskId, sync_calendar: '' }]);
  ui.toast(`נוסף בלוק · ${toHHMM(startMin)}${cal ? ` — נכנס ${cal}` : ''}`, { label: 'בטל', fn: () => store.deleteBlock(id) });
}

/** Takes a block off the planner (back to the task list), with undo. */
function removeBlock(id) {
  const b = store.block(id);
  if (!b) return;
  const copy = { ...b, calendar_event_id: '' }; // its calendar event is deleted with it; undo makes a fresh one
  store.deleteBlock(id);
  const t = store.task(b.task_id);
  ui.toast(`הבלוק הוסר${t ? ` · „${t.title}”` : ''}`, { label: 'בטל', fn: () => store.saveBlock(copy) });
}

function moveBlock(id, start, end) {
  const b = store.block(id);
  if (!b) return;
  const before = { id, start: b.start, end: b.end };
  if (before.start === start && before.end === end) return;
  store.saveBlock({ id, start, end });
  ui.toast(`הבלוק הוזז · ${start.slice(11, 16)}–${end.slice(11, 16)}`, { label: 'בטל', fn: () => store.saveBlock(before) });
}

// Where these blocks go, for the toast: 'ליומן „לימודים”' / 'ליומנים „לימודים” ו-„Bahr Goren”' ('' = nowhere).
// Each block goes to its category's calendar (categories.calendarOf).
function calendarWhere(blocks) {
  if (store.setting('sync_blocks_to_calendar') !== 'TRUE') return '';
  if (store.apiVersion && store.apiVersion < 5) return 'ליומן Google';
  const names = [...new Set(blocks.filter((b) => b.sync_calendar !== 'FALSE')
    .map((b) => calLabel(calendarOf(store.course((store.task(b.task_id) || {}).course)))))].map((n) => `„${n}”`);
  if (!names.length) return '';
  return names.length === 1 ? `ליומן ${names[0]}` : `ליומנים ${names.slice(0, -1).join(', ')} ו-${names[names.length - 1]}`;
}

function calendarNotice() {
  const st = calendarState();
  if (st.kind !== 'error' || store.setting('sync_blocks_to_calendar') !== 'TRUE') return '';
  return noticeHtml({ tone: 'err', ...calendarText(st), tech: st.tech, dismiss: `cal:${st.tech}` });
}

/* ------------------------------------------------------------ drag & drop ---- */

function onPointerDown(e) {
  lastPointer = e.pointerType || 'mouse';
  if (e.button > 0 || e.target.closest('[data-unplace]')) return;
  const resize = e.target.closest('[data-resize]');
  const blk = e.target.closest('[data-block]');
  const task = e.target.closest('[data-task]');
  if (!resize && !blk && !task) return;
  const kind = resize ? 'resize' : blk ? 'move' : 'task';
  const touch = e.pointerType !== 'mouse';
  drag = { kind, id: kind === 'task' ? task.dataset.task : blk.dataset.block, x0: e.clientX, y0: e.clientY,
    x: e.clientX, y: e.clientY, active: false, pointerId: e.pointerId, el: blk || task };
  if (kind === 'resize') { e.preventDefault(); startDrag(); } // the handle has touch-action:none
  else if (touch) drag.timer = setTimeout(() => { if (drag && !drag.active) startDrag(); }, LONG_PRESS);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.x = e.clientX; drag.y = e.clientY;
  const moved = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
  if (!drag.active) {
    if (e.pointerType === 'mouse' && moved > 4) startDrag();
    else if (e.pointerType !== 'mouse' && moved > 8) { cancel(); return; } // it was a scroll
    else return;
  }
  e.preventDefault();
  updateDrag();
}

function startDrag() {
  drag.active = true;
  try { navigator.vibrate?.(12); } catch { /* ignore */ }
  root.classList.add('dragging');
  const b = drag.kind !== 'task' ? store.block(drag.id) : null;
  if (b) {
    drag.len = Math.max(SNAP, minutes(b.start, b.end));
    // where inside the block it was grabbed (measured at the press point, not after the first move)
    const y = drag.y; drag.y = drag.y0;
    drag.grab = drag.kind === 'move' ? toMinAt(b.start) - pointerMinute(b.start.slice(0, 10)) : 0;
    drag.y = y;
    drag.el.classList.add('lifted');
    if (drag.kind === 'move') root.querySelector('.pl-tray')?.classList.add('drop-zone');
  } else drag.len = defaultLen();
  drag.ghost = document.createElement('div');
  drag.ghost.className = 'pl-ghost';
  const t = store.task(b ? b.task_id : drag.id);
  const c = t && store.course(t.course);
  drag.ghost.style.setProperty('--c', c ? c.color : '#8A8F98');
  drag.ghost.innerHTML = `<b dir="auto">${esc(t ? t.title : '')}</b><span></span>`;
  root.querySelector('.pl-grid').appendChild(drag.ghost);
  updateDrag();
  autoScroll();
}

function toMinAt(stamp) { return toMin(stamp.slice(11, 16)); }
function minutes(a, b) { return dayDiff(a.slice(0, 10), b.slice(0, 10)) * 1440 + toMin(b.slice(11, 16)) - toMin(a.slice(11, 16)); }
function pointerMinute(day) {
  const col = root.querySelector(`.pl-day[data-day="${day}"]`);
  if (!col) return START_H * 60;
  const r = col.getBoundingClientRect();
  return START_H * 60 + ((drag.y - r.top) / hourPx()) * 60;
}
function dayUnderPointer() {
  for (const col of root.querySelectorAll('.pl-day')) {
    const r = col.getBoundingClientRect();
    if (drag.x >= r.left && drag.x <= r.right) return col;
  }
  return null;
}

function updateDrag() {
  const grid = root.querySelector('.pl-grid');
  const g = grid.getBoundingClientRect();
  const sc = root.querySelector('.pl-scroll').getBoundingClientRect();
  const overGrid = drag.x >= g.left && drag.x <= g.right && drag.y >= sc.top && drag.y <= sc.bottom;
  const tray = root.querySelector('.pl-tray');
  if (drag.kind === 'move' && tray) {
    const tr = tray.getBoundingClientRect();
    const overTray = drag.x >= tr.left && drag.x <= tr.right && drag.y >= tr.top && drag.y <= tr.bottom;
    tray.classList.toggle('drop-over', overTray);
    if (overTray) { drag.target = { remove: true }; drag.ghost.style.display = 'none'; return; }
  }
  let col = drag.kind === 'resize' ? root.querySelector(`.pl-day[data-day="${store.block(drag.id).start.slice(0, 10)}"]`) : dayUnderPointer();
  if (!overGrid && drag.kind !== 'resize') col = null;
  drag.target = null;
  if (!col) { drag.ghost.style.display = 'none'; return; }
  const day = col.dataset.day;
  let s, e;
  if (drag.kind === 'resize') {
    const b = store.block(drag.id);
    s = toMinAt(b.start);
    e = Math.max(s + SNAP, Math.min(END_H * 60, Math.round(pointerMinute(day) / SNAP) * SNAP));
  } else {
    const raw = pointerMinute(day) + (drag.kind === 'move' ? drag.grab : -drag.len / 4);
    s = Math.max(START_H * 60, Math.min(END_H * 60 - drag.len, Math.round(raw / SNAP) * SNAP));
    e = Math.min(END_H * 60, s + drag.len);
  }
  drag.target = { day, s, e };
  const cr = col.getBoundingClientRect();
  Object.assign(drag.ghost.style, {
    display: 'block', top: `${topOf(s)}px`, height: `${topOf(e) - topOf(s)}px`,
    left: `${cr.left - g.left}px`, width: `${cr.width - 2}px`,
  });
  drag.ghost.querySelector('span').textContent = `${toHHMM(s)}–${toHHMM(e)}`;
}

function autoScroll() {
  if (!drag || !drag.active) return;
  const sc = root.querySelector('.pl-scroll');
  const r = sc.getBoundingClientRect();
  const edge = 44;
  let dy = 0;
  // only while the finger/mouse is over the calendar (not while still crossing the task tray)
  if (drag.x >= r.left && drag.x <= r.right && drag.y >= r.top - 10) {
    if (drag.y < r.top + edge) dy = -Math.ceil((r.top + edge - drag.y) / 4);
    else if (drag.y > r.bottom - edge && drag.y < r.bottom + 60) dy = Math.ceil((drag.y - (r.bottom - edge)) / 4);
  }
  if (dy) { sc.scrollTop += dy; updateDrag(); }
  requestAnimationFrame(autoScroll);
}

function onPointerUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  cleanupListeners();
  clearTimeout(d.timer);
  if (!d.active) { drag = null; return; } // a plain tap → click handler
  const tgt = d.target;
  finish();
  if (tgt && tgt.remove) removeBlock(d.id);
  else if (tgt) {
    const end = tgt.e >= 24 * 60 ? `${addDays(tgt.day, 1)} 00:00` : `${tgt.day} ${toHHMM(tgt.e)}`;
    if (d.kind === 'task') createBlock(d.id, tgt.day, tgt.s, tgt.e - tgt.s);
    else moveBlock(d.id, `${tgt.day} ${toHHMM(tgt.s)}`, end);
  }
  drag = { justDropped: true };
  setTimeout(() => { if (drag && drag.justDropped) drag = null; }, 400);
  render(true);
}
function onPointerCancel() { cancel(); }
function cancel() {
  if (!drag) return;
  clearTimeout(drag.timer);
  cleanupListeners();
  const wasActive = drag.active;
  finish();
  drag = null;
  if (wasActive) render(true);
}
function finish() {
  root.classList.remove('dragging');
  root.querySelector('.pl-tray')?.classList.remove('drop-zone', 'drop-over');
  drag.ghost?.remove();
  drag.el?.classList.remove('lifted');
  drag.active = false;
}
function cleanupListeners() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
}

/* ------------------------------------------------------------ right-click ---- */

/**
 * The menu for a right-click inside the planner (see ctxmenu.js): items, false = nothing (and no browser menu),
 * null = not ours. e = the contextmenu event (null for a long-press, which never reaches here).
 */
export function menuAt(target, at, e) {
  if (!root || root.hidden || !target.closest('.pl-body')) return null;
  const type = (e && e.pointerType) || lastPointer;
  if (type === 'touch' || type === 'pen' || drag) return false; // a long-press on a touch screen drags here
  const blk = target.closest('[data-block]');
  if (blk) return blockMenu(blk.dataset.block);
  const task = target.closest('[data-task]');
  if (task) return ui.taskMenu?.(task.dataset.task, 'tray') || false;
  const dl = target.closest('.deadline[data-edit]');
  if (dl) return ui.taskMenu?.(dl.dataset.edit, 'planner') || false;
  const day = target.closest('.pl-day');
  if (day) return slotMenu(day.dataset.day, slotFromPoint(day, at.y));
  return false;
}

/** From the task list's menu: pick this task, then a time on the grid places it (like tapping it in the tray). */
export function selectForPlacing(taskId) {
  selectedTask = taskId;
  render(true);
  root.querySelector(`.pl-tray [data-task="${CSS.escape(taskId)}"]`)?.scrollIntoView({ block: 'nearest' });
}

const nextDay = (stamp) => `${addDays(stamp.slice(0, 10), 1)} ${stamp.slice(11, 16)}`;

function blockMenu(id) {
  const b = store.block(id);
  if (!b) return false;
  const t = store.task(b.task_id);
  const syncOn = store.setting('sync_blocks_to_calendar') === 'TRUE';
  const len = Math.max(SNAP, minutes(b.start, b.end));
  const url = eventUrl(b);
  const state = b.state === 'draft' ? 'planned' : b.state;
  return [
    { title: `${t ? t.title : 'בלוק עבודה'} · ${b.start.slice(11, 16)}–${b.end.slice(11, 16)}` },
    { label: 'עריכת הבלוק…', icon: 'edit', run: () => openBlockSheet(id) },
    t ? { label: 'פתח את המשימה', icon: 'open', run: () => ui.openEditor(t.id) } : null,
    t && isOpen(t) ? { label: 'התחל טיימר', icon: 'play', run: () => ui.openTimer(t.id) } : null,
    { sep: true },
    { label: 'מצב', choices: Object.entries(STATES).map(([k, v]) => ({ label: v, on: state === k, run: () => setBlockState(b, k) })) },
    { sep: true },
    { label: 'הזז למחר', icon: 'move', hint: 'אותה שעה', run: () => moveBlock(id, nextDay(b.start), nextDay(b.end)) },
    { label: 'שכפל למחר', icon: 'dup', hint: 'אותה שעה', run: () => createBlock(b.task_id, addDays(b.start.slice(0, 10), 1), toMin(b.start.slice(11, 16)), len, { note: b.note || '', sync_calendar: b.sync_calendar || '' }) },
    { label: 'העתק', icon: 'copy', hint: 'להדבקה בשעה אחרת', run: () => {
      clip = { task_id: b.task_id, len, note: b.note || '', sync_calendar: b.sync_calendar || '' };
      ui.toast('הבלוק הועתק — לחיצה ימנית על שעה פנויה ← הדבק');
    } },
    syncOn ? { label: 'להציג ביומן Google', checked: b.sync_calendar !== 'FALSE', run: () => {
      const before = { id, sync_calendar: b.sync_calendar || '' };
      const off = b.sync_calendar !== 'FALSE';
      store.saveBlock({ id, sync_calendar: off ? 'FALSE' : '' });
      ui.toast(off ? 'הבלוק יוצא מהיומן' : 'הבלוק נכנס ליומן', { label: 'בטל', fn: () => store.saveBlock(before) });
    } } : null,
    url ? { label: 'פתח ב-Google Calendar', icon: 'link', href: url } : null,
    { sep: true },
    { label: 'הסר מהלוח', icon: 'trash', danger: true, run: () => removeBlock(id) },
  ];
}

function setBlockState(b, state) {
  if ((b.state === 'draft' ? 'planned' : b.state) === state) return;
  const before = { id: b.id, state: b.state };
  store.saveBlock({ id: b.id, state });
  const msg = state === 'skipped' ? 'סומן „דילגתי” — הבלוק הוסתר מהלוח' : state === 'done' ? 'סומן „בוצע”' : 'סומן „מתוכנן”';
  ui.toast(msg, { label: 'בטל', fn: () => store.saveBlock(before) });
}

function slotMenu(day, startMin) {
  const ct = clip && store.task(clip.task_id);
  return [
    { title: `יום ${weekday(day)} ${shortDate(day)} · ${toHHMM(startMin)}` },
    { label: 'בלוק חדש כאן…', icon: 'plus', run: () => openChooser(day, startMin) },
    ct ? { label: `הדבק: „${ct.title}”`, icon: 'paste', hint: fmtMinutes(clip.len), run: () => createBlock(clip.task_id, day, startMin, clip.len, { note: clip.note, sync_calendar: clip.sync_calendar }) } : null,
  ];
}

/** The block's event in Google Calendar (eid = base64 of "<event id> <calendar id>"), or '' if it has none. */
function eventUrl(b) {
  const id = String(b.calendar_event_id || '');
  const cal = b.calendar_id || store.setting('blocks_calendar_id', '');
  if (!/@google\.com$/.test(id) || !cal) return '';
  try {
    const eid = btoa(unescape(encodeURIComponent(`${id.replace(/@google\.com$/, '')} ${cal}`))).replace(/=+$/, '');
    return `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(eid)}`;
  } catch { return ''; }
}

/* --------------------------------------------------------------- sheets ---- */

function openChooser(day, startMin) {
  const dlg = document.querySelector('#blockSheet');
  const tasks = store.data.tasks.filter(plannable)
    .sort((a, b) => `${a.due_date || '9999'}`.localeCompare(`${b.due_date || '9999'}`));
  dlg.innerHTML = `<div class="sheet-form">
    <header class="sheet-head"><h2 tabindex="-1" autofocus>מה לעשות ב-${toHHMM(startMin)}, יום ${weekday(day)} ${shortDate(day)}?</h2>
      <button type="button" class="icon-btn" data-close aria-label="סגור"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header>
    <div class="sheet-body"><ul class="choose-list">${tasks.map((t) => {
      const c = store.course(t.course);
      return `<li><button type="button" data-pick="${esc(t.id)}" style="--c:${esc(c ? c.color : '#8A8F98')}"><i></i><b>${esc(t.title)}</b><small>${esc(t.due_date ? dueLabel(t.due_date, t.due_time) : '')}</small></button></li>`;
    }).join('') || '<li class="hint">אין משימות פתוחות.</li>'}</ul></div></div>`;
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => { createBlock(b.dataset.pick, day, startMin); dlg.close(); }));
  dlg.showModal();
}

const STATES = { planned: 'מתוכנן', done: 'בוצע', skipped: 'דילגתי' }; // 'draft' (old) shows as planned

function openBlockSheet(id) {
  const b = store.block(id);
  if (!b) return;
  const t = store.task(b.task_id);
  const c = t && store.course(t.course);
  const dlg = document.querySelector('#blockSheet');
  const syncOn = store.setting('sync_blocks_to_calendar') === 'TRUE';
  dlg.innerHTML = `<form method="dialog" class="sheet-form">
    <header class="sheet-head"><div><h2 tabindex="-1" autofocus>${esc(t ? t.title : 'בלוק עבודה')}</h2>
      ${c ? `<p class="sub"><i style="--c:${esc(c.color)}"></i>${esc(c.short_he || c.name_he)}</p>` : ''}</div>
      <button type="button" class="icon-btn" data-close aria-label="סגור"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header>
    <div class="sheet-body">
      <div class="row">
        <label class="field grow"><span>יום</span><input type="date" name="day" value="${b.start.slice(0, 10)}"></label>
        <label class="field"><span>מ-</span><input type="time" name="from" step="900" value="${b.start.slice(11, 16)}"></label>
        <label class="field"><span>עד</span><input type="time" name="to" step="900" value="${b.end.slice(11, 16)}"></label>
      </div>
      <fieldset class="field"><legend>מצב</legend><div class="segmented">
        ${Object.entries(STATES).map(([k, v]) => `<label><input type="radio" name="state" value="${k}" ${(b.state === 'draft' ? 'planned' : b.state) === k ? 'checked' : ''}><span>${v}</span></label>`).join('')}
      </div></fieldset>
      ${syncOn ? `<label class="check"><input type="checkbox" name="sync" ${b.sync_calendar !== 'FALSE' ? 'checked' : ''}> להציג ביומן Google</label>` : ''}
      <label class="field"><span>מה לעשות בבלוק (לא חובה)</span><input name="note" value="${esc(b.note)}"></label>
    </div>
    <footer class="sheet-foot">
      <button type="button" class="btn danger ghost" data-del>הסר מהלוח</button>
      <div class="foot-actions">
        ${t && isOpen(t) ? '<button type="button" class="btn ghost" data-timer>▶ טיימר</button>' : ''}
        <button type="submit" class="btn primary">שמירה</button>
      </div>
    </footer></form>`;
  const f = dlg.querySelector('form');
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.querySelector('[data-del]').onclick = () => { dlg.close(); removeBlock(id); };
  const tm = dlg.querySelector('[data-timer]');
  if (tm) tm.onclick = () => { dlg.close(); ui.openTimer(b.task_id); };
  f.onsubmit = () => {
    const day = f.day.value || b.start.slice(0, 10);
    let from = f.from.value || b.start.slice(11, 16), to = f.to.value || b.end.slice(11, 16);
    if (toMin(to) <= toMin(from) && to !== '00:00') to = toHHMM(Math.min(24 * 60 - 1, toMin(from) + SNAP));
    const end = to === '00:00' ? `${addDays(day, 1)} 00:00` : `${day} ${to}`;
    const patch = { id, start: `${day} ${from}`, end, state: f.state.value, note: f.note.value.trim() };
    if (f.sync) patch.sync_calendar = f.sync.checked ? '' : 'FALSE';
    const before = { id, start: b.start, end: b.end, state: b.state, note: b.note, sync_calendar: b.sync_calendar };
    store.saveBlock(patch);
    if (patch.state === 'skipped' && b.state !== 'skipped') ui.toast('סומן „דילגתי” — הבלוק הוסתר מהלוח', { label: 'בטל', fn: () => store.saveBlock(before) });
    if (patch.state === 'done' && t && b.state !== 'done') ui.toast('כל הכבוד! (הזמן עצמו נרשם מהטיימר או ידנית במשימה)');
  };
  dlg.showModal();
}


