// Suggestions from any AI that can edit the Sheet (tab "suggestions"; instructions in the tab "AI – איך להציע").
// Shown on the tasks screen; nothing changes until Bahr taps "אשר". Approving makes the change through the normal
// store methods (so it syncs, goes to Google Calendar, can be undone) and marks the row approved.
// Any change Bahr can make in the app can be suggested: tasks, work blocks, work sessions, categories (courses) and
// meta categories (groups), including archiving them (active FALSE).
import { store } from './store.js';
import { dueLabel, shortDate, weekday, nowStampIL, todayIL } from './dates.js';
import { KIND, createCategory, createGroup } from './categories.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let ui = {};
let open = true;

const FIELDS = {
  tasks: ['title', 'course', 'status', 'due_date', 'due_time', 'estimate_hours', 'notes', 'links'],
  blocks: ['task_id', 'start', 'end', 'state', 'note'],
  sessions: ['task_id', 'start', 'end', 'minutes', 'note'],
  courses: ['slug', 'name_he', 'short_he', 'group', 'color', 'number', 'moodle_course_id', 'moodle_folder', 'active'],
  groups: ['name', 'kind', 'active'],
};
const OPS = { create: 'create', add: 'create', new: 'create', insert: 'create', update: 'update', edit: 'update',
  change: 'update', modify: 'update', delete: 'delete', remove: 'delete' };
const TABLES = { tasks: 'tasks', task: 'tasks', blocks: 'blocks', block: 'blocks', sessions: 'sessions', session: 'sessions',
  courses: 'courses', course: 'courses', categories: 'courses', category: 'courses',
  groups: 'groups', group: 'groups', meta_categories: 'groups', meta_category: 'groups' };
const LABEL = { title: 'שם', course: 'קורס', status: 'סטטוס', due_date: 'תאריך הגשה', due_time: 'שעה', estimate_hours: 'הערכת זמן',
  notes: 'הערות', links: 'קישורים', task_id: 'משימה', start: 'התחלה', end: 'סוף', state: 'מצב', note: 'הערה', minutes: 'דקות', blocks: 'בלוקי עבודה',
  name_he: 'שם', short_he: 'שם קצר', group: 'קטגוריית־על', color: 'צבע', number: 'מספר קורס', moodle_course_id: 'קורס במודל',
  moodle_folder: 'תיקייה ב-Drive', active: 'מצב', name: 'שם', kind: 'סוג', slug: 'מזהה' };
const STATUS_HE = { todo: 'לא התחיל', in_progress: 'בתהליך', done: 'הושלם', cancelled: 'בוטל' };
const STATE_HE = { draft: 'טיוטה', planned: 'מתוכנן', done: 'בוצע', skipped: 'דילגתי' };
const WHAT = { tasks: 'משימה', blocks: 'בלוק עבודה', sessions: 'זמן עבודה', courses: 'קטגוריה', groups: 'קטגוריית־על' };
const FEMININE = { tasks: true, courses: true, groups: true }; // "חדשה" / "חדש"
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/, STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/, COLOR = /^#[0-9a-fA-F]{6}$/;

export function init(callbacks) { ui = callbacks; }

export const pending = () => (store.data.suggestions || []).filter((s) => s.id && (!s.status || s.status === 'pending'));

const KEYS = { tasks: 'id', blocks: 'id', sessions: 'id', courses: 'slug', groups: 'id' };
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
  if ((table === 'courses' || table === 'groups') && !store.canSaveCategories) problems.push('צריך לעדכן את השרת (Apps Script) כדי לאשר שינוי בקטגוריות');
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
    if (f.course !== undefined && f.course && !store.course(f.course)) problems.push(`קטגוריה לא מוכרת: ${f.course}`);
    if (table === 'tasks' && op === 'create' && f.course && store.categoryArchived(f.course)) problems.push(`הקטגוריה „${store.course(f.course).name_he}” בארכיון`);
    if (table === 'courses' && f.group !== undefined && !store.group(f.group)) problems.push(`קטגוריית־על לא מוכרת: ${f.group}`);
    if (f.color !== undefined && f.color && !COLOR.test(f.color)) problems.push('צבע צריך להיות #RRGGBB');
    if (f.active !== undefined && f.active !== 'TRUE' && f.active !== 'FALSE') problems.push('active צריך להיות TRUE או FALSE');
    if (f.kind !== undefined && !KIND[f.kind]) problems.push(`סוג לא מוכר: ${f.kind}`);
    if (f.moodle_course_id && !/^\d+$/.test(f.moodle_course_id)) problems.push('moodle_course_id צריך להיות מספר');
    if (f.slug !== undefined) {
      if (op !== 'create') problems.push('אי אפשר לשנות מזהה (slug)');
      else if (!SLUG.test(f.slug)) problems.push('מזהה (slug): אותיות קטנות באנגלית, ספרות ו-"-"');
      else if (store.course(f.slug)) problems.push(`המזהה ${f.slug} כבר קיים`);
    }
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
    if (table === 'courses' && !fields.name_he) problems.push('חסר שם (name_he)');
    if (table === 'courses' && !fields.group) problems.push('חסרה קטגוריית־על (group)');
    if (table === 'groups' && !fields.name) problems.push('חסר שם (name)');
    if ((table === 'blocks' || table === 'sessions') && !fields.task_id) problems.push('חסר task_id');
    if ((table === 'blocks' || table === 'sessions') && !fields.start) problems.push('חסרה שעת התחלה');
    if (table === 'blocks' && !fields.end) problems.push('חסרה שעת סוף');
    if (table === 'sessions' && !fields.end && !fields.minutes) problems.push('חסרים סוף או דקות');
    blocks.forEach((b) => { if (!STAMP.test(b.start || '') || !STAMP.test(b.end || '') || b.end <= b.start) problems.push('בלוק עבודה עם זמנים לא תקינים'); });
  }
  if (op === 'delete' && target && table === 'courses' &&
    (store.data.tasks.some((t) => t.course === target.slug) || store.data.moodle_inbox.some((m) => m.course === target.slug))) {
    problems.push('יש בה משימות או הודעות — אפשר רק להעביר לארכיון ({"active":"FALSE"})');
  }
  if (op === 'delete' && target && table === 'groups' && store.data.courses.some((c) => c.group === target.id)) {
    problems.push('יש בה קטגוריות — אפשר רק להעביר לארכיון ({"active":"FALSE"})');
  }
  return { table, op, fields, target, blocks, problems: [...new Set(problems)] };
}

function show(k, v) {
  if (v === '' || v === undefined) return '—';
  if (k === 'course') { const c = store.course(v); return c ? c.short_he || c.name_he : v; }
  if (k === 'status') return STATUS_HE[v] || v;
  if (k === 'state') return STATE_HE[v] || v;
  if (k === 'task_id') return store.task(v)?.title || v;
  if (k === 'group') return store.group(v)?.name || v;
  if (k === 'active') return v === 'FALSE' ? 'בארכיון' : 'פעיל';
  if (k === 'kind') return KIND[v]?.label || v;
  if (k === 'moodle_course_id') return `id=${v}`;
  if (k === 'due_date' && DATE.test(v)) return dueLabel(v, '');
  if ((k === 'start' || k === 'end') && STAMP.test(v)) return `יום ${weekday(v.slice(0, 10))} ${shortDate(v.slice(0, 10))} ${v.slice(11)}`;
  if (k === 'estimate_hours') return `${v} ש׳`;
  return v;
}

function detailHtml(p) {
  if (!p.table || !p.op) return '';
  const name = p.target ? (p.target.title || p.target.name_he || p.target.name || store.task(p.target.task_id)?.title || p.target.id || p.target.slug) : '';
  if (p.op === 'delete') return `<p class="sg-line">🗑 למחוק ${WHAT[p.table]}: <b>${esc(name)}</b>${p.table !== 'tasks' && p.target ? ` (${esc(show('start', p.target.start))})` : ''}</p>`;
  const rows = Object.entries(p.fields).map(([k, v]) => p.op === 'update'
    ? `<li>${esc(LABEL[k] || k)}: <s>${esc(show(k, p.target ? p.target[k] : ''))}</s> ← <b>${esc(show(k, v))}</b></li>`
    : `<li>${esc(LABEL[k] || k)}: <b>${esc(show(k, v))}</b></li>`);
  p.blocks.forEach((b) => rows.push(`<li>${LABEL.blocks}: <b>${esc(show('start', b.start))}–${esc(String(b.end || '').slice(11))}</b></li>`));
  const head = p.op === 'create' ? `➕ ${WHAT[p.table]} חדש${FEMININE[p.table] ? 'ה' : ''}` : `✏️ שינוי ב${WHAT[p.table]}: <b>${esc(name)}</b>`;
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
  if (p.table === 'courses' || p.table === 'groups') return applyCategory(p);
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

/** Categories (tab courses, key slug) and meta categories (tab groups, key id). Archiving = active FALSE. */
function applyCategory(p) {
  const f = { ...p.fields };
  const courses = p.table === 'courses';
  if (p.op === 'create') {
    if (courses) {
      const slug = createCategory(f); // (no slug given: the store makes one)
      return { result: slug, undo: () => store.deleteCategory(slug) };
    }
    const made = createGroup(f);
    return { result: made.id, undo: () => { if (made.slug) store.deleteCategory(made.slug); store.deleteGroup(made.id); } };
  }
  const key = courses ? 'slug' : 'id';
  const id = p.target[key];
  const save = (row) => (courses ? store.saveCategory(row) : store.saveGroup(row));
  if (p.op === 'update') {
    if (f.active !== undefined) f.archived_at = f.active === 'FALSE' ? (p.target.active === 'FALSE' && p.target.archived_at ? p.target.archived_at : todayIL()) : '';
    const before = Object.fromEntries(Object.keys(f).map((k) => [k, p.target[k] ?? '']));
    save({ [key]: id, ...f });
    return { result: id, undo: () => save({ [key]: id, ...before }) };
  }
  const copy = { ...p.target };
  if (courses) store.deleteCategory(id); else store.deleteGroup(id);
  return { result: id, undo: () => save(copy) };
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
  if (p.op === 'update' && (p.table === 'courses' || p.table === 'groups') && p.fields.active === 'FALSE' &&
    !confirm(`להעביר את „${p.target.name_he || p.target.name}” לארכיון? היא תיעלם מהמסכים עם המשימות שלה; שום דבר לא נמחק.`)) return true;
  const done = apply(p);
  mark(id, 'approved', done.result);
  ui.toast('בוצע', { label: 'בטל', fn: () => { done.undo(); mark(id, 'pending'); } });
  return true;
}
