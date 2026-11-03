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

const EMPTY = { tasks: [], sessions: [], blocks: [], courses: [], settings: [], moodle_inbox: [] };
const KEY = { tasks: 'id', sessions: 'id', blocks: 'id', courses: 'slug', moodle_inbox: 'id', settings: 'key' };

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

  async flush(throwOnError = false) {
    if (!this.configured || !this.queue.length) return;
    const ops = this.queue.slice();
    try {
      this.status = 'syncing'; this.emit();
      await this.call({ action: 'batch', ops });
      this.queue = this.queue.slice(ops.length);
      this.persist();
      this.status = 'idle'; this.error = '';
    } catch (e) {
      this.status = isNetwork(e) ? 'offline' : 'error';
      this.error = String(e.message || e);
      if (throwOnError) throw e;
    } finally { this.emit(); }
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

function isNetwork(e) {
  return e.network || e instanceof TypeError; // fetch() throws TypeError when offline / blocked
}

export const store = new Store();
