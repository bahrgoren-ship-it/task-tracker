// Demo backend: behaves like the Apps Script API but keeps data in this browser only.
// Used when the app's server address is "demo" (try the app without connecting Google).

import { todayIL, addDays, nowStampIL } from './dates.js';

const LS_KEY = 'ht.demo.v2';

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
    blocks: [],
    courses: COURSES,
    settings: [{ key: 'default_block_minutes', value: '60' }],
    moodle_inbox: [],
  };
}

export class DemoBackend {
  constructor() {
    try { this.db = JSON.parse(localStorage.getItem(LS_KEY)) || seed(); } catch { this.db = seed(); }
  }
  save() { try { localStorage.setItem(LS_KEY, JSON.stringify(this.db)); } catch { /* ignore */ } }

  async handle(p) {
    await new Promise((r) => setTimeout(r, 150));
    if (p.action === 'ping') return { api_version: 1, now: nowStampIL(), demo: true };
    if (p.action === 'bootstrap') return structuredClone(this.db);
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
