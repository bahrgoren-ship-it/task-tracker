// Data store: local copy of the Sheet + a queue of unsent changes.
// - Every change is applied locally at once (works offline) and queued.
// - The queue is sent to the Apps Script backend as one "batch"; then the full data is re-read.
// - Connection settings live in localStorage of each device ("ht.cfg").
// - api url "demo" = built-in demo backend (no Google needed), for trying the app.

import { nowStampIL } from './dates.js';
import { DemoBackend } from './demo.js';

const LS = { cfg: 'ht.cfg', data: 'ht.data', queue: 'ht.queue', ui: 'ht.ui' };

function lsGet(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ }
}

const EMPTY = { tasks: [], sessions: [], blocks: [], courses: [], settings: [], moodle_inbox: [], suggestions: [] };
const KEY = { tasks: 'id', sessions: 'id', blocks: 'id', courses: 'slug', moodle_inbox: 'id', settings: 'key', suggestions: 'id' };

export function newId(prefix) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  for (const b of rnd) s += chars[b % chars.length];
  return `${prefix}_${s}`;
}

class Store {
  constructor() {
    this.cfg = lsGet(LS.cfg, null);           // {url, key}
    this.data = { ...structuredClone(EMPTY), ...lsGet(LS.data, {}) };
    this.queue = lsGet(LS.queue, []);         // [{op, table, row|id}]
    this.status = 'idle';                     // idle | syncing | offline | error
    this.error = '';
    this.lastSync = lsGet('ht.lastSync', '');
    this.apiVersion = lsGet('ht.apiVersion', 0);   // backend version: 3+ has calendar & Moodle features
    this.listeners = new Set();
    this._flushTimer = null;
    this._demo = null;
  }

  get configured() { return !!(this.cfg && this.cfg.url && this.cfg.key); }
  get isDemo() { return this.cfg && this.cfg.url === 'demo'; }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => fn(this)); }

  setConfig(cfg) {
    const changed = !this.cfg || this.cfg.url !== cfg.url;
    this.cfg = cfg;
    lsSet(LS.cfg, cfg);
    if (changed) { this.data = structuredClone(EMPTY); this.queue = []; this.persist(); }
  }

  clearConfig() {
    this.cfg = null;
    localStorage.removeItem(LS.cfg);
    this.data = structuredClone(EMPTY); this.queue = []; this.persist();
    this.emit();
  }

  persist() { lsSet(LS.data, this.data); lsSet(LS.queue, this.queue); }

  /* ---------- backend calls ---------- */

  async call(payload) {
    if (this.isDemo) {
      this._demo = this._demo || new DemoBackend();
      return this._demo.handle(payload);
    }
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // "simple" request: no CORS preflight
      body: JSON.stringify({ key: this.cfg.key, ...payload }),
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { network: true });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'server error');
    return j.data;
  }

  async testConnection(cfg) {
    const prev = this.cfg;
    this.cfg = cfg;
    try { return await this.call({ action: 'ping' }); } finally { this.cfg = prev; }
  }

  /* ---------- sync ---------- */

  async refresh() {
    if (!this.configured) return;
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      this.status = 'syncing'; this.emit();
      try {
        await this.flush(true);
        const fresh = await this.call({ action: 'bootstrap' });
        this.apiVersion = Number(fresh.api_version) || 1; lsSet('ht.apiVersion', this.apiVersion);
        const data = {};
        for (const t of Object.keys(EMPTY)) data[t] = fresh[t] || [];
        this.data = data;
        // re-apply anything still waiting to be sent, so it doesn't flicker away
        for (const op of this.queue) this.applyLocal(op);
        this.persist();
        this.status = 'idle'; this.error = '';
        this.lastSync = nowStampIL(); lsSet('ht.lastSync', this.lastSync);
      } catch (e) {
        this.status = isNetwork(e) ? 'offline' : 'error';
        this.error = String(e.message || e);
      } finally {
        this._refreshing = null;
        this.emit();
      }
    })();
    return this._refreshing;
  }

  // Sends the queue as one batch. Only one batch is on its way at a time: a change made meanwhile waits and goes in
  // the next batch (sending the same changes twice, in parallel, could bring back something already deleted).
  async flush(throwOnError = false) {
    while (this._flushing) { try { await this._flushing; } catch { /* its own caller reports it */ } }
    if (!this.configured || !this.queue.length) return;
    const ops = this.queue.slice();
    const run = this._flushing = this.call({ action: 'batch', ops });
    this.status = 'syncing'; this.emit();
    try {
      const res = await run;
      this.queue = this.queue.slice(ops.length);
      this.applyResults(res && res.results);
      this.persist();
      this.status = 'idle'; this.error = '';
    } catch (e) {
      this.status = isNetwork(e) ? 'offline' : 'error';
      this.error = String(e.message || e);
      if (throwOnError) throw e;
    } finally {
      if (this._flushing === run) this._flushing = null;
      this.emit();
    }
  }

  // The rows as the server saved them (e.g. a confirmed block now has its Google Calendar event, a task its total
  // time) — unless this device changed that row again in the meantime. "deleted" = the row no longer exists.
  applyResults(results) {
    if (!Array.isArray(results)) return;
    const pending = new Set(this.queue.map((op) => `${op.table}|${op.op === 'delete' ? op.id : op.row[KEY[op.table]]}`));
    for (const r of results) {
      const list = this.data[r.table];
      const k = KEY[r.table];
      if (!list || !k) continue;
      const id = r.deleted || (r.row && r.row[k]);
      if (!id || pending.has(`${r.table}|${id}`)) continue;
      const i = list.findIndex((x) => x[k] === id);
      if (r.deleted) { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = { ...list[i], ...r.row };
    }
  }

  scheduleFlush() {
    clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this.flush(), 400);
  }

  /* ---------- local changes ---------- */

  applyLocal(op) {
    const list = this.data[op.table] || (this.data[op.table] = []);
    const k = KEY[op.table];
    if (op.op === 'upsert') {
      const i = list.findIndex((r) => r[k] === op.row[k]);
      if (i >= 0) list[i] = { ...list[i], ...op.row };
      else list.push({ ...op.row });
    } else if (op.op === 'delete') {
      const i = list.findIndex((r) => r[k] === op.id);
      if (i >= 0) list.splice(i, 1);
      if (op.table === 'tasks') {
        this.data.blocks = this.data.blocks.filter((b) => b.task_id !== op.id);
        this.data.sessions = this.data.sessions.filter((x) => x.task_id !== op.id);
      }
    }
  }

  change(op) {
    this.applyLocal(op);
    this.queue.push(op);
    this.persist();
    this.emit();
    this.scheduleFlush();
  }

  saveTask(patch) {
    const now = nowStampIL();
    const row = { ...patch, updated_at: now };
    if (!row.id) {
      row.id = newId('t');
      row.created_at = now;
      row.source = row.source || 'manual';
      row.status = row.status || 'todo';
    }
    this.change({ op: 'upsert', table: 'tasks', row });
    return row.id;
  }

  deleteTask(id) { this.change({ op: 'delete', table: 'tasks', id }); }

  /* ---------- time tracking ---------- */
  // A session = a stretch of real work on a task (from the timer or added by hand).
  saveSession(row) {
    const full = { kind: 'manual', note: '', ...row, id: row.id || newId('s'), updated_at: nowStampIL() };
    this.change({ op: 'upsert', table: 'sessions', row: full });
    return full.id;
  }
  deleteSession(id) { this.change({ op: 'delete', table: 'sessions', id }); }
  sessionsOf(taskId) {
    return this.data.sessions.filter((x) => x.task_id === taskId).sort((a, b) => b.start.localeCompare(a.start));
  }
  // Total minutes worked on a task. Uses the sessions we have locally; falls back to the Sheet's total.
  spentMinutes(taskId) {
    const list = this.data.sessions.filter((x) => x.task_id === taskId);
    if (list.length) return list.reduce((s, x) => s + (Number(x.minutes) || 0), 0);
    const t = this.task(taskId);
    return t && t.spent_hours ? Math.round(Number(t.spent_hours) * 60) : 0;
  }

  /* ---------- work blocks (planner) ---------- */
  saveBlock(row) {
    const full = { ...row, updated_at: nowStampIL() };
    if (!full.id) { full.id = newId('b'); full.state = full.state || 'draft'; full.sync_calendar = full.sync_calendar ?? ''; full.calendar_event_id = ''; full.note = full.note || ''; }
    this.change({ op: 'upsert', table: 'blocks', row: full });
    return full.id;
  }
  deleteBlock(id) { this.change({ op: 'delete', table: 'blocks', id }); }
  block(id) { return this.data.blocks.find((b) => b.id === id); }
  blocksOf(taskId) { return this.data.blocks.filter((b) => b.task_id === taskId); }
  // minutes in work blocks (all states except skipped)
  plannedMinutes(taskId) {
    return this.blocksOf(taskId).filter((b) => b.state !== 'skipped')
      .reduce((s, b) => s + Math.max(0, minutesBetween(b.start, b.end)), 0);
  }

  /* ---------- Moodle inbox ---------- */
  saveInbox(row) { this.change({ op: 'upsert', table: 'moodle_inbox', row }); }
  inboxNew() { return this.data.moodle_inbox.filter((m) => m.status === 'new'); }

  /* ---------- direct backend actions (v3+) ---------- */
  async busy(from, to) {
    if (!this.configured || this.apiVersion < 3) return null;
    const k = `${from}|${to}`;
    this._busy = this._busy || {};
    const hit = this._busy[k];
    if (hit && Date.now() - hit.at < 5 * 60000) return hit.data;
    const data = await this.call({ action: 'busy', from, to });
    this._busy[k] = { at: Date.now(), data };
    return data;
  }
  async action(name, extra = {}) { return this.call({ action: name, ...extra }); }

  setSetting(key, value) { this.change({ op: 'upsert', table: 'settings', row: { key, value: String(value) } }); }

  task(id) { return this.data.tasks.find((t) => t.id === id); }
  course(slug) { return this.data.courses.find((c) => c.slug === slug); }
  setting(key, fallback = '') {
    const s = this.data.settings.find((r) => r.key === key);
    return s ? s.value : fallback;
  }

  /* ---------- per-device UI prefs ---------- */
  ui(key, fallback) { return (lsGet(LS.ui, {}) || {})[key] ?? fallback; }
  setUi(key, value) { const u = lsGet(LS.ui, {}) || {}; u[key] = value; lsSet(LS.ui, u); }
}

function minutesBetween(a, b) {
  if (!a || !b) return 0;
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16));
  return Math.round((t(b) - t(a)) / 60000);
}

function isNetwork(e) {
  return e.network || e instanceof TypeError; // fetch() throws TypeError when offline / blocked
}

export const store = new Store();
