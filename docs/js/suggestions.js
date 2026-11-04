// Suggestions from any AI that can edit the Sheet (tab "suggestions"; instructions in the tab "AI – איך להציע").
// Shown on the tasks screen; nothing changes until Bahr taps "אשר". Approving makes the change through the normal
// store methods (so it syncs, goes to Google Calendar, can be undone) and marks the row approved.
import { store } from './store.js';
import { dueLabel, shortDate, weekday, nowStampIL } from './dates.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let ui = {};
let open = true;

const FIELDS = {
  tasks: ['title', 'course', 'status', 'due_date', 'due_time', 'estimate_hours', 'notes', 'links'],
  blocks: ['task_id', 'start', 'end', 'state', 'note'],
  sessions: ['task_id', 'start', 'end', 'minutes', 'note'],
};
const OPS = { create: 'create', add: 'create', new: 'create', insert: 'create', update: 'update', edit: 'update',
  change: 'update', modify: 'update', delete: 'delete', remove: 'delete' };
const TABLES = { tasks: 'tasks', task: 'tasks', blocks: 'blocks', block: 'blocks', sessions: 'sessions', session: 'sessions' };
const LABEL = { title: 'שם', course: 'קורס', status: 'סטטוס', due_date: 'תאריך הגשה', due_time: 'שעה', estimate_hours: 'הערכת זמן',
  notes: 'הערות', links: 'קישורים', task_id: 'משימה', start: 'התחלה', end: 'סוף', state: 'מצב', note: 'הערה', minutes: 'דקות', blocks: 'בלוקי עבודה' };
const STATUS_HE = { todo: 'לא התחיל', in_progress: 'בתהליך', done: 'הושלם', cancelled: 'בוטל' };
const STATE_HE = { draft: 'טיוטה', planned: 'מתוכנן', done: 'בוצע', skipped: 'דילגתי' };
const WHAT = { tasks: 'משימה', blocks: 'בלוק עבודה', sessions: 'זמן עבודה' };
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/, STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

export function init(callbacks) { ui = callbacks; }

export const pending = () => (store.data.suggestions || []).filter((s) => s.id && (!s.status || s.status === 'pending'));

const KEYS = { tasks: 'id', blocks: 'id', sessions: 'id' };
const find = (table, id) => (store.data[table] || []).find((r) => r[KEYS[table]] === id);

/** What the row asks for, cleaned up, plus anything that stops it from being approved. */
export function parse(sg) {
  const table = TABLES[String(sg.table || '').trim().toLowerCase()];
  const op = OPS[String(sg.op || '').trim().toLowerCase()];
  const problems = [];
  let raw = {};
  const text = String(sg.fields || '').trim();
  if (text) { try { raw = JSON.parse(text); } catch { problems.push('השדה fields אינו JSON תקין'); } }
  if (!table) problems.push(`טבלה לא מוכרת: „${sg.table || ''}”`);
  if (!op) problems.push(`פעולה לא מוכרת: „${sg.op || ''}”`);
  if (!table || !op) return { table, op, fields: {}, problems };
  const fields = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (FIELDS[table].includes(k)) fields[k] = v === null ? '' : String(v);
    else if (!(k === 'blocks' && table === 'tasks' && op === 'create')) problems.push(`שדה לא מוכר: ${k}`);
  }
  const target = op !== 'create' ? find(table, String(sg.row_id || '').trim()) : null;
  if (op !== 'create' && !target) problems.push(`לא מצאתי ${WHAT[table]} עם id „${sg.row_id || ''}”`);
  if (op === 'update' && !Object.keys(fields).length) problems.push('אין מה לשנות');
  const blocks = table === 'tasks' && op === 'create' && Array.isArray(raw.blocks) ? raw.blocks : [];
  const check = (f, merged) => {
    if (f.course !== undefined && f.course && !store.course(f.course)) problems.push(`קורס לא מוכר: ${f.course}`);
    if (f.status !== undefined && !STATUS_HE[f.status]) problems.push(`סטטוס לא מוכר: ${f.status}`);
    if (f.state !== undefined && !STATE_HE[f.state]) problems.push(`מצב לא מוכר: ${f.state}`);
    if (f.due_date && !DATE.test(f.due_date)) problems.push('תאריך צריך להיות yyyy-mm-dd');
    if (f.due_time && !TIME.test(f.due_time)) problems.push('שעה צריכה להיות HH:MM');
    for (const k of ['start', 'end']) if (f[k] && !STAMP.test(f[k])) problems.push(`${LABEL[k]} צריכה להיות yyyy-mm-dd HH:MM`);
    if (merged.start && merged.end && STAMP.test(merged.start) && STAMP.test(merged.end) && merged.end <= merged.start) problems.push('הסוף לפני ההתחלה');
    if (f.task_id !== undefined && !store.task(f.task_id)) problems.push(`לא מצאתי משימה עם id „${f.task_id}”`);
  };
  check(fields, { ...(target || {}), ...fields });
  if (op === 'create') {
    if (table === 'tasks' && !fields.title) problems.push('חסר שם למשימה');
    if (table !== 'tasks' && !fields.task_id) problems.push('חסר task_id');
    if (table !== 'tasks' && !fields.start) problems.push('חסרה שעת התחלה');
    if (table === 'blocks' && !fields.end) problems.push('חסרה שעת סוף');
    if (table === 'sessions' && !fields.end && !fields.minutes) problems.push('חסרים סוף או דקות');
    blocks.forEach((b) => { if (!STAMP.test(b.start || '') || !STAMP.test(b.end || '') || b.end <= b.start) problems.push('בלוק עבודה עם זמנים לא תקינים'); });
  }
  return { table, op, fields, target, blocks, problems: [...new Set(problems)] };
}

function show(k, v) {
  if (v === '' || v === undefined) return '—';
  if (k === 'course') { const c = store.course(v); return c ? c.short_he || c.name_he : v; }
  if (k === 'status') return STATUS_HE[v] || v;
  if (k === 'state') return STATE_HE[v] || v;
  if (k === 'task_id') return store.task(v)?.title || v;
  if (k === 'due_date' && DATE.test(v)) return dueLabel(v, '');
  if ((k === 'start' || k === 'end') && STAMP.test(v)) return `יום ${weekday(v.slice(0, 10))} ${shortDate(v.slice(0, 10))} ${v.slice(11)}`;
  if (k === 'estimate_hours') return `${v} ש׳`;
  return v;
}

function detailHtml(p) {
  if (!p.table || !p.op) return '';
  const name = p.target ? (p.target.title || store.task(p.target.task_id)?.title || p.target.id) : '';
  if (p.op === 'delete') return `<p class="sg-line">🗑 למחוק ${WHAT[p.table]}: <b>${esc(name)}</b>${p.table !== 'tasks' && p.target ? ` (${esc(show('start', p.target.start))})` : ''}</p>`;
  const rows = Object.entries(p.fields).map(([k, v]) => p.op === 'update'
    ? `<li>${esc(LABEL[k] || k)}: <s>${esc(show(k, p.target ? p.target[k] : ''))}</s> ← <b>${esc(show(k, v))}</b></li>`
    : `<li>${esc(LABEL[k] || k)}: <b>${esc(show(k, v))}</b></li>`);
  p.blocks.forEach((b) => rows.push(`<li>${LABEL.blocks}: <b>${esc(show('start', b.start))}–${esc(String(b.end || '').slice(11))}</b></li>`));
  const head = p.op === 'create' ? `➕ ${WHAT[p.table]} חדש${p.table === 'tasks' ? 'ה' : ''}` : `✏️ שינוי ב${WHAT[p.table]}: <b>${esc(name)}</b>`;
  return `<p class="sg-line">${head}</p><ul class="sg-fields">${rows.join('')}</ul>`;
}

/** The card at the top of the tasks screen ('' when there's nothing to approve). */
export function html() {
  const list = pending().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (!list.length) return '';
  return `<section class="ai-sugg">
    <button class="ai-sugg-head" data-sg-act="toggle" aria-expanded="${open}">
      <span>✨ ${list.length === 1 ? 'הצעה אחת מ-AI' : `${list.length} הצעות מ-AI`}</span><small>שום דבר לא משתנה עד שתאשר</small>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    ${open ? `<ul>${list.map((sg) => {
      const p = parse(sg);
      return `<li class="sugg" data-sg-id="${esc(sg.id)}">
        <div class="sg-top"><b>${esc(sg.summary || `${WHAT[p.table] || ''}`)}</b>${sg.by ? `<span class="sg-kind">${esc(sg.by)}</span>` : ''}</div>
        ${detailHtml(p)}
        ${sg.reason ? `<p class="sg-why">${esc(sg.reason)}</p>` : ''}
        ${p.problems.length ? `<p class="sg-problem">אי אפשר לאשר: ${esc(p.problems.join(' · '))}</p>` : ''}
        <div class="sg-actions">
          <button class="btn primary sm" data-sg-act="approve" ${p.problems.length ? 'disabled' : ''}>אשר</button>
          <button class="btn ghost sm" data-sg-act="reject">דחה</button>
        </div>
      </li>`;
    }).join('')}</ul>` : ''}
  </section>`;
}

function mark(id, status, result = '') {
  store.change({ op: 'upsert', table: 'suggestions', row: { id, status, decided_at: status === 'pending' ? '' : nowStampIL(), result } });
}

/** Makes the change; returns a function that undoes it. */
function apply(p) {
  const f = p.fields;
  if (p.table === 'tasks') {
    if (p.op === 'create') {
      const id = store.saveTask({ ...f, source: 'ai' });
      const made = p.blocks.map((b) => store.saveBlock({ task_id: id, start: b.start, end: b.end, state: 'planned' }));
      return { result: id, undo: () => { made.forEach((b) => store.deleteBlock(b)); store.deleteTask(id); } };
    }
    if (p.op === 'update') {
      const before = Object.fromEntries(Object.keys(f).map((k) => [k, p.target[k] ?? '']));
      store.saveTask({ id: p.target.id, ...f });
      return { result: p.target.id, undo: () => store.saveTask({ id: p.target.id, ...before }) };
    }
    const copy = { ...p.target };
    store.deleteTask(copy.id);
    return { result: copy.id, undo: () => store.saveTask(copy) };
  }
  if (p.table === 'blocks') {
    if (p.op === 'create') {
      const id = store.saveBlock({ ...f, state: f.state || 'planned' });
      return { result: id, undo: () => store.deleteBlock(id) };
    }
    if (p.op === 'update') {
      const before = Object.fromEntries(Object.keys(f).map((k) => [k, p.target[k] ?? '']));
      store.saveBlock({ id: p.target.id, ...f });
      return { result: p.target.id, undo: () => store.saveBlock({ id: p.target.id, ...before }) };
    }
    const copy = { ...p.target, calendar_event_id: '' };
    store.deleteBlock(copy.id);
    return { result: copy.id, undo: () => store.saveBlock(copy) };
  }
  // sessions
  if (p.op === 'create') {
    const minutes = f.minutes || String(Math.max(1, Math.round((Date.parse(f.end.replace(' ', 'T')) - Date.parse(f.start.replace(' ', 'T'))) / 60000)));
    const id = store.saveSession({ ...f, minutes, end: f.end || '', kind: 'manual' });
    return { result: id, undo: () => store.deleteSession(id) };
  }
  if (p.op === 'update') {
    const before = { ...p.target };
    store.saveSession({ ...p.target, ...f });
    return { result: p.target.id, undo: () => store.saveSession(before) };
  }
  const copy = { ...p.target };
  store.deleteSession(copy.id);
  return { result: copy.id, undo: () => store.saveSession(copy) };
}

/** Click handler for the card (called from app.js); true if it handled the click. */
export function onClick(e) {
  const btn = e.target.closest('[data-sg-act]');
  if (!btn) return false;
  if (btn.dataset.sgAct === 'toggle') { open = !open; ui.render(); return true; }
  const id = btn.closest('[data-sg-id]').dataset.sgId;
  const sg = (store.data.suggestions || []).find((x) => x.id === id);
  if (!sg) return true;
  if (btn.dataset.sgAct === 'reject') {
    mark(id, 'rejected');
    ui.toast('ההצעה נדחתה', { label: 'בטל', fn: () => mark(id, 'pending') });
    return true;
  }
  const p = parse(sg);
  if (p.problems.length) return true;
  if (p.op === 'delete' && p.table === 'tasks' && !confirm(`למחוק את „${p.target.title}”?`)) return true;
  const done = apply(p);
  mark(id, 'approved', done.result);
  ui.toast('בוצע', { label: 'בטל', fn: () => { done.undo(); mark(id, 'pending'); } });
  return true;
}
