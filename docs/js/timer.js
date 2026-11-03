// Work timer: stopwatch or pomodoro, one at a time, shared between devices.
//
// The running timer is stored in the Sheet (settings row "active_timer", JSON), so a timer started
// on the PC shows on the phone too. Everything is computed from timestamps, so the time stays right
// even if the app was closed or the device slept.
//
// Focus time is saved as a row in "sessions" (task_id, start, end, minutes, kind); breaks are not.
// Session ids are derived from (task, focus start), so two devices finishing the same pomodoro
// write the same row instead of a duplicate.

import { store } from './store.js';
import { stampIL } from './dates.js';

const MIN = 60000;

export function settingsP() {
  const n = (k, d) => Math.max(1, Number(store.setting(k, d)) || d);
  return {
    focus: n('pomodoro_focus_minutes', 25),
    short: n('pomodoro_short_break_minutes', 5),
    long: n('pomodoro_long_break_minutes', 15),
    every: n('pomodoro_long_break_every', 4),
    autoBreak: store.setting('pomodoro_auto_start_breaks', 'TRUE') !== 'FALSE',
  };
}

/** Current timer state or null. Shape:
 *  { task_id, mode: 'stopwatch'|'pomodoro', phase: 'focus'|'short'|'long', running: bool,
 *    seg_start: ms (when the current running stretch began), acc: ms already counted in this phase,
 *    focus_start: ms (wall time the current focus period began — the session's start), cycle: n focus done } */
export function state() {
  const raw = store.setting('active_timer', '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function save(st) { store.setSetting('active_timer', st ? JSON.stringify(st) : ''); }

export const elapsed = (st, now = Date.now()) => st.acc + (st.running ? now - st.seg_start : 0);
export function phaseLength(st) {
  if (st.mode !== 'pomodoro') return Infinity;
  const p = settingsP();
  return (st.phase === 'focus' ? p.focus : st.phase === 'short' ? p.short : p.long) * MIN;
}
export const isBreak = (st) => st && st.phase !== 'focus';

/* ---------------------------------------------------------- actions ---- */

export function start(taskId, mode) {
  const cur = state();
  if (cur) stop({ silent: true });
  const now = Date.now();
  save({ task_id: taskId, mode, phase: 'focus', running: true, seg_start: now, acc: 0, focus_start: now, cycle: 0 });
  if (store.task(taskId)?.status === 'todo') store.saveTask({ id: taskId, status: 'in_progress' });
  if (mode === 'pomodoro') askNotifications();
  unlockAudio();
}

export function pause() {
  const st = state(); if (!st || !st.running) return;
  const now = Date.now();
  save({ ...st, running: false, acc: elapsed(st, now) });
}

export function resume() {
  const st = state(); if (!st || st.running) return;
  const now = Date.now();
  // resuming a finished break / waiting focus starts a fresh focus period
  const newFocus = st.phase === 'focus' && st.acc === 0;
  save({ ...st, running: true, seg_start: now, ...(newFocus ? { focus_start: now } : {}) });
  unlockAudio();
}

/** Ends the timer. Saves the focus time worked so far. Returns minutes saved. */
export function stop({ silent = false } = {}) {
  const st = state(); if (!st) return 0;
  const now = Date.now();
  let saved = 0;
  if (st.phase === 'focus') saved = logFocus(st, elapsed(st, now), now);
  save(null);
  if (!silent) document.dispatchEvent(new CustomEvent('timer:stopped', { detail: { minutes: saved, task_id: st.task_id } }));
  return saved;
}

/** Pomodoro: jump to the next phase now. */
export function skip() {
  const st = state(); if (!st || st.mode !== 'pomodoro') return;
  advance(st, Date.now(), true);
}

/** Called every second by the UI: handles the end of pomodoro phases (also ones that ended while closed). */
export function tick() {
  let st = state();
  if (!st || st.mode !== 'pomodoro' || !st.running) return;
  let guard = 0;
  while (st && st.running && elapsed(st) >= phaseLength(st) && guard++ < 20) {
    const endAt = st.seg_start + (phaseLength(st) - st.acc);
    st = advance(st, endAt, false);
  }
}

function advance(st, at, manual) {
  const p = settingsP();
  let next;
  if (st.phase === 'focus') {
    const worked = manual ? elapsed(st, at) : phaseLength(st);
    logFocus(st, worked, at);
    const cycle = st.cycle + 1;
    const phase = cycle % p.every === 0 ? 'long' : 'short';
    next = { ...st, phase, cycle, acc: 0, seg_start: at, running: manual || p.autoBreak };
    if (!manual && fresh(at)) notify('סיימת פומודורו 🎉', phase === 'long' ? `הפסקה ארוכה — ${p.long} דק׳` : `הפסקה — ${p.short} דק׳`);
  } else {
    // break over: wait for the user to start the next focus (or start it now if skipped by hand)
    next = { ...st, phase: 'focus', acc: 0, seg_start: at, focus_start: at, running: manual };
    if (!manual && fresh(at)) notify('ההפסקה נגמרה', 'מוכן לפומודורו הבא?');
  }
  save(next);
  return next;
}

// Only alert for phase ends that just happened (not ones caught up after the app was closed for a while).
const fresh = (at) => Date.now() - at < 90000;

function logFocus(st, ms, endMs) {
  const minutes = Math.round(ms / MIN);
  if (minutes < 1) return 0;
  const startMs = st.focus_start || endMs - ms;
  store.saveSession({
    id: sessionId(st.task_id, startMs),
    task_id: st.task_id,
    start: stampIL(startMs),
    end: stampIL(endMs),
    minutes: String(minutes),
    kind: st.mode,
  });
  return minutes;
}

function sessionId(taskId, startMs) {
  let h = 2166136261;
  for (const ch of `${taskId}|${Math.floor(startMs / 1000)}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return 's_' + h.toString(36).padStart(6, '0').slice(-6);
}

/* ---------------------------------------------------- alerts & sound ---- */

let audioCtx;
function unlockAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* no audio */ }
}
function beep() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [0, 0.25, 0.5].forEach((d, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = i === 2 ? 1046 : 784;
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.25, t + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.22);
    o.connect(g).connect(audioCtx.destination); o.start(t + d); o.stop(t + d + 0.25);
  });
}
function askNotifications() {
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
}
async function notify(title, body) {
  beep();
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* ignore */ }
  document.dispatchEvent(new CustomEvent('timer:phase', { detail: { title, body } }));
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag: 'timer' });
    else new Notification(title, { body, icon: 'icons/icon-192.png', tag: 'timer' });
  } catch { /* ignore */ }
}
