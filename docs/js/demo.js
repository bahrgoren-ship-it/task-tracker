// Demo backend: behaves like the Apps Script API but keeps data in this browser only.
// Used when the app's server address is "demo" (try the app without connecting Google).

import { todayIL, addDays, nowStampIL } from './dates.js';

const LS_KEY = 'ht.demo.v3';

const COURSES = [
  ['ds-algs', 'מבני נתונים ואלגוריתמים', 'מבני נתונים', '#3B6FB6'],
  ['databases', 'ניהול מסדי נתונים', 'מסדי נתונים', '#C8742B'],
  ['statistics-1', 'סטטיסטיקה 1', 'סטטיסטיקה 1', '#3F8F5B'],
  ['algebraic-methods', 'שיטות אלגבריות בהנדסת נתונים', 'שיטות אלגבריות', '#8B5E3C'],
  ['game-theory', 'תורת המשחקים והתנהגות כלכלית', 'תורת המשחקים', '#7B5AA6'],
].map(([slug, name_he, short_he, color]) => ({ slug, name_he, short_he, color, active: 'TRUE' }));

function seed() {
  const t = todayIL();
  const now = nowStampIL();
  const task = (id, title, course, status, offset, extra = {}) => ({
    id, title, course, status, due_date: offset === null ? '' : addDays(t, offset), due_time: '',
    estimate_hours: '', notes: '', links: '', source: 'manual', moodle_ref: '', calendar_event_id: '',
    created_at: now, updated_at: now, spent_hours: '', ...extra,
  });
  return {
    tasks: [
      task('t_demo01', 'למצוא זוג', 'databases', 'todo', -2, { notes: 'עומר. רק לאשר סופית.' }),
      task('t_demo02', 'Tutorial 01 - Lab Tables in SQL Azure', 'databases', 'in_progress', 0,
        { notes: 'לחכות שיהיה אפשר', due_time: '23:59', estimate_hours: '2' }),
      task('t_demo03', 'תרגיל בית 1', 'statistics-1', 'todo', 1, { estimate_hours: '5' }),
      task('t_demo04', 'מעבר על הרצאה', 'ds-algs', 'todo', 4),
      task('t_demo05', 'תרגיל בית 2', 'algebraic-methods', 'todo', 12, { links: 'https://moodle26.technion.ac.il' }),
      task('t_demo06', 'לקרוא פרק 2 בספר', 'game-theory', 'todo', null),
      task('t_demo07', 'רענון פייתון', 'databases', 'done', -1),
    ],
    sessions: [
      { id: 's_demo01', task_id: 't_demo02', start: `${addDays(t, -1)} 20:00`, end: `${addDays(t, -1)} 20:50`,
        minutes: '50', kind: 'pomodoro', note: '', updated_at: now },
    ],
    blocks: [
      { id: 'b_demo01', task_id: 't_demo03', start: `${addDays(t, 1)} 10:00`, end: `${addDays(t, 1)} 12:00`, state: 'planned', sync_calendar: '', calendar_event_id: '', note: '', updated_at: now },
      { id: 'b_demo02', task_id: 't_demo04', start: `${t} 18:00`, end: `${t} 19:00`, state: 'draft', sync_calendar: '', calendar_event_id: '', note: '', updated_at: now },
    ],
    courses: COURSES,
    settings: [{ key: 'default_block_minutes', value: '60' }],
    moodle_inbox: [
      { id: 'm_demo01', course: 'databases', kind: 'announcement', moodle_ref: 'post:1', posted_at: `${addDays(t, -1)} 21:04`,
        title: 'עדכונים', author: 'אפק וקנין', text: 'שלום,\nההגשה של תרגיל בית 1 תהיה עד ה-' + `${+addDays(t, 9).slice(8)}.${+addDays(t, 9).slice(5, 7)}` + ' בשעה 23:59.\nבהצלחה!',
        detected_dates: addDays(t, 9), url: 'https://moodle26.technion.ac.il', status: 'new', task_id: '' },
      { id: 'm_demo02', course: 'statistics-1', kind: 'assignment', moodle_ref: 'assign:1', posted_at: `${t} 08:00`,
        title: 'תרגיל בית 2', author: '', text: 'הגשה ביחידים, קובץ PDF אחד.', detected_dates: `${addDays(t, 6)} 23:59`,
        url: 'https://moodle26.technion.ac.il', status: 'new', task_id: '' },
    ],
  };
}

// fake personal calendar for the planner's "busy" layer
function demoBusy(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = new Date(d + 'T12:00:00Z').getUTCDay();
    if (wd === 0 || wd === 2) out.push({ title: 'הרצאה', start: `${d} 14:30`, end: `${d} 16:30`, all_day: false, calendar: 'טכניון', color: '#9E69AF' });
    if (wd === 3) out.push({ title: 'תרגול', start: `${d} 10:30`, end: `${d} 12:30`, all_day: false, calendar: 'טכניון', color: '#9E69AF' });
    if (wd === 5) out.push({ title: 'ארוחת שישי', start: `${d} 19:00`, end: `${d} 21:30`, all_day: false, calendar: 'אישי', color: '#33B679' });
  }
  return out;
}

export class DemoBackend {
  constructor() {
    try { this.db = JSON.parse(localStorage.getItem(LS_KEY)) || seed(); } catch { this.db = seed(); }
  }
  save() { try { localStorage.setItem(LS_KEY, JSON.stringify(this.db)); } catch { /* ignore */ } }

  async handle(p) {
    await new Promise((r) => setTimeout(r, 150));
    if (p.action === 'ping') return { api_version: 3, now: nowStampIL(), demo: true };
    if (p.action === 'bootstrap') return { ...structuredClone(this.db), api_version: 3 };
    if (p.action === 'busy') return demoBusy(p.from, p.to);
    if (p.action === 'syncNow') return { calendar: { pulled: 0, pushed: 0 } };
    if (p.action === 'moodleCheck') return { status: 'ok · 0 new (הדגמה)', added: 0 };
    if (p.action === 'setMoodleToken') return { connected: true, fullname: 'הדגמה' };
    if (p.action === 'batch') {
      for (const o of p.ops) {
        const k = o.table === 'settings' ? 'key' : 'id';
        const list = this.db[o.table];
        if (o.op === 'upsert') {
          const i = list.findIndex((r) => r[k] === o.row[k]);
          if (i >= 0) list[i] = { ...list[i], ...o.row }; else list.push({ ...o.row });
        } else if (o.op === 'delete') {
          this.db[o.table] = list.filter((r) => r[k] !== o.id);
          if (o.table === 'tasks') {
            this.db.blocks = this.db.blocks.filter((b) => b.task_id !== o.id);
            this.db.sessions = this.db.sessions.filter((b) => b.task_id !== o.id);
          }
        }
      }
      // like the real backend: tasks.spent_hours = sum of session minutes
      for (const task of this.db.tasks) {
        const m = this.db.sessions.filter((x) => x.task_id === task.id).reduce((a, x) => a + Number(x.minutes || 0), 0);
        task.spent_hours = m ? String(Math.round(m / 60 * 100) / 100) : '';
      }
      this.save();
      return { results: [], now: nowStampIL() };
    }
    throw new Error('unknown action');
  }
}
