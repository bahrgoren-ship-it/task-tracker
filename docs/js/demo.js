// Demo backend: behaves like the Apps Script API but keeps data in this browser only.
// Used when the app's server address is "demo" (try the app without connecting Google).

import { todayIL, addDays, nowStampIL } from './dates.js';

const LS_KEY = 'ht.demo.v6';

const COURSES = [
  ['ds-algs', 'מבני נתונים ואלגוריתמים', 'מבני נתונים', '#3B6FB6', '1349'],
  ['databases', 'ניהול מסדי נתונים', 'מסדי נתונים', '#C8742B', '1350'],
  ['statistics-1', 'סטטיסטיקה 1', 'סטטיסטיקה 1', '#3F8F5B', '1360'],
  ['algebraic-methods', 'שיטות אלגבריות בהנדסת נתונים', 'שיטות אלגבריות', '#8B5E3C', '1377'],
  ['game-theory', 'תורת המשחקים והתנהגות כלכלית', 'תורת המשחקים', '#7B5AA6', '1393'],
].map(([slug, name_he, short_he, color, forum]) => ({ slug, name_he, short_he, color, active: 'TRUE', moodle_news_forum_id: forum }));
// like the backend: a change to a row that no longer exists, without these fields, is dropped (not half-created)
const REQUIRED = { tasks: ['title'], sessions: ['task_id', 'start'], blocks: ['task_id', 'start', 'end'], moodle_inbox: ['moodle_ref'] };

const dm = (d) => `${+d.slice(8)}.${+d.slice(5, 7)}`;

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
      task('t_demo08', 'סיכום הרצאה 3', 'statistics-1', 'todo', 0),
      task('t_demo09', 'קריאה: עצים מאוזנים', 'ds-algs', 'todo', 3, { estimate_hours: '1.5', due_time: '12:00' }),
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
    settings: [{ key: 'default_block_minutes', value: '60' }, { key: 'ai_status', value: `ok · 3 reviewed · ${now} · gemini-flash-lite (הדגמה)` },
      { key: 'moodle_status', value: 'ok · הדגמה' }, { key: 'moodle_last_check', value: now },
      { key: 'sync_blocks_to_calendar', value: 'TRUE' }, { key: 'blocks_calendar_name', value: 'לימודים' },
      { key: 'calendar_status', value: `ok · ${now}` }],
    moodle_inbox: [
      { id: 'm_demo01', course: 'databases', kind: 'announcement', moodle_ref: 'post:1', posted_at: `${addDays(t, -1)} 21:04`,
        title: 'עדכונים', author: 'אפק וקנין',
        text: `שלום לכולם,\n\nתרגיל בית 1 פורסם באתר הקורס. ההגשה בזוגות, עד ה-${dm(addDays(t, 9))} בשעה 23:59, דרך המודל בלבד.\nמי שעדיין לא מצא/ה זוג — יש פורום חיפוש שותפים.\n\nבנוסף, לפני התרגול הבא יש להתקין את SQL Server Management Studio לפי ההנחיות שבאתר.\n\nבהצלחה!\nאפק`,
        detected_dates: addDays(t, 9), url: 'https://moodle26.technion.ac.il', status: 'new', task_id: '',
        ai_status: 'done', ai_summary: 'תרגיל בית 1 פורסם (הגשה בזוגות), ויש להתקין SSMS לפני התרגול הבא.', ai_checked_at: now,
        ai_suggestions: JSON.stringify([
          { id: 'n0', type: 'new', state: 'open', title: 'תרגיל בית 1', course: 'databases', due_date: addDays(t, 9), due_time: '23:59', estimate_hours: 6, notes: 'הגשה בזוגות דרך המודל בלבד.', reason: '„תרגיל בית 1 פורסם באתר הקורס. ההגשה בזוגות…”' },
          { id: 'n1', type: 'new', state: 'open', title: 'להתקין SQL Server Management Studio', course: 'databases', due_date: addDays(t, 2), due_time: '', estimate_hours: 0.5, notes: 'לפי ההנחיות שבאתר הקורס, לפני התרגול הבא.', reason: '„לפני התרגול הבא יש להתקין…”' },
          { id: 'c2', type: 'covered', state: 'info', task_id: 't_demo01', title: 'למצוא זוג', reason: 'מציאת זוג לתרגילי הבית' },
        ]) },
      { id: 'm_demo02', course: 'algebraic-methods', kind: 'announcement', moodle_ref: 'post:2', posted_at: `${t} 09:12`,
        title: 'הארכה בתרגיל בית 2', author: 'צוות הקורס',
        text: `בעקבות בקשות רבות, ההגשה של תרגיל בית 2 נדחית ל-${dm(addDays(t, 15))} בשעה 12:00.\nשאלה 4 לא חובה.`,
        detected_dates: addDays(t, 15), url: 'https://moodle26.technion.ac.il', status: 'new', task_id: '',
        ai_status: 'done', ai_summary: 'ההגשה של תרגיל בית 2 נדחתה, ושאלה 4 אינה חובה.', ai_checked_at: now,
        ai_suggestions: JSON.stringify([
          { id: 'u0', type: 'update', state: 'open', task_id: 't_demo05', title: 'תרגיל בית 2', old_due: addDays(t, 12), due_date: addDays(t, 15), due_time: '12:00', notes_to_add: 'שאלה 4 לא חובה.', reason: '„ההגשה של תרגיל בית 2 נדחית…”' },
        ]) },
      { id: 'm_demo03', course: 'ds-algs', kind: 'announcement', moodle_ref: 'post:3', posted_at: `${addDays(t, -2)} 13:40`,
        title: 'ביטול התרגול מחר', author: 'יהושע רוס', text: 'התרגול של מחר בשעה 10:30 מבוטל. החומר יועבר בתרגול הבא.',
        detected_dates: '', url: 'https://moodle26.technion.ac.il', status: 'new', task_id: '',
        ai_status: 'done', ai_summary: 'התרגול של מחר מבוטל; החומר יועבר בתרגול הבא.', ai_checked_at: now, ai_suggestions: '[]' },
      { id: 'm_demo05', course: 'game-theory', kind: 'announcement', moodle_ref: 'post:file930', posted_at: addDays(t, -3),
        title: 'ברוכים הבאים', author: 'בר מולר',
        text: 'שלום לכולם, וברוכים הבאים לקורס!\n\nבאתר הקורס תוכלו למצוא את הסילבוס המעודכן לסמסטר הקרוב. מומלץ לקרוא אותו\nבעיון.\n\n**מספר הודעות חשובות:**\n\n  1. **תרגול 0:** פורסם באתר הקורס תרגול 0. חשוב לעבור עליו **לפני ההרצאה\nהראשונה**.\n\n  2. **בוחן אמצע:** יתקיים ב-**13.12**, משקלו 20% (מגן).\n\n  * **ימי ראשון 12:30-14:30** \\- בהנחייתי.\n  * **ימי שלישי 11:30-13:30** \\- בהנחיית גילעד.\n\nהסילבוס: https://moodle26.technion.ac.il/course/view.php?id=575',
        detected_dates: '', url: 'https://drive.google.com/drive/folders/demo', status: 'new', task_id: '',
        ai_status: '', ai_summary: '', ai_suggestions: '', ai_checked_at: '' },
      { id: 'm_demo04', course: 'statistics-1', kind: 'assignment', moodle_ref: 'assign:1', posted_at: `${t} 08:00`,
        title: 'תרגיל בית 2', author: '', text: 'הגשה ביחידים, קובץ PDF אחד.', detected_dates: `${addDays(t, 6)} 23:59`,
        url: 'https://moodle26.technion.ac.il', status: 'new', task_id: '', ai_status: '', ai_summary: '', ai_suggestions: '', ai_checked_at: '' },
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
    if (p.action === 'ping') return { api_version: 5, now: nowStampIL(), demo: true };
    if (p.action === 'bootstrap') return { ...structuredClone(this.db), api_version: 5 };
    if (p.action === 'calendars') {
      return { calendars: [{ name: 'bahr.goren@gmail.com', primary: true }, { name: 'לימודים' }, { name: 'אישי' }].map((c) => ({ id: c.name, color: '#4285F4', primary: false, ...c })),
        chosen: (this.db.settings.find((r) => r.key === 'blocks_calendar_name') || {}).value || '' };
    }
    if (p.action === 'busy') return demoBusy(p.from, p.to);
    if (p.action === 'syncNow') return { calendar: { pulled: 0, pushed: 0 } };
    if (p.action === 'moodleCheck') {
      const row = this.db.settings.find((r) => r.key === 'moodle_last_check');
      if (row) row.value = nowStampIL(); else this.db.settings.push({ key: 'moodle_last_check', value: nowStampIL() });
      this.save();
      return { status: 'ok · 0 new (הדגמה)', added: 0 };
    }
    if (p.action === 'setMoodleToken') return { connected: true, fullname: 'הדגמה' };
    if (p.action === 'setGeminiKey') return { connected: true, model: 'הדגמה' };
    if (p.action === 'aiReview') { // fake review: one suggested task per waiting message
      let reviewed = 0;
      for (const m of this.db.moodle_inbox) {
        if (p.id ? m.id !== p.id : (m.status !== 'new' || m.kind === 'date_change' || m.ai_status)) continue;
        if (p.id && m.ai_status === 'done') { reviewed++; continue; }
        const due = (m.detected_dates || '').split(',')[0].trim();
        Object.assign(m, { ai_status: 'done', ai_summary: `(הדגמה) ${m.title}`, ai_checked_at: nowStampIL(),
          ai_suggestions: JSON.stringify([{ id: 'n0', type: 'new', state: 'open', title: m.title, course: m.course,
            due_date: due.slice(0, 10), due_time: due.slice(11, 16), estimate_hours: 3, notes: m.text.slice(0, 120), reason: 'הדגמה' }]) });
        reviewed++;
      }
      this.save();
      return { status: `ok · ${reviewed} reviewed · ${nowStampIL()} · הדגמה`, reviewed };
    }
    if (p.action === 'batch') {
      const results = [];
      for (const o of p.ops) {
        const k = o.table === 'settings' ? 'key' : 'id';
        const list = this.db[o.table];
        if (o.op === 'upsert') {
          const i = list.findIndex((r) => r[k] === o.row[k]);
          if (i < 0 && (REQUIRED[o.table] || []).some((c) => !o.row[c])) { results.push({ table: o.table, deleted: o.row[k] }); continue; }
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
      // like the real backend: confirmed blocks get a (pretend) Google Calendar event
      const syncOn = (this.db.settings.find((r) => r.key === 'sync_blocks_to_calendar') || {}).value === 'TRUE';
      for (const b of this.db.blocks) {
        const want = syncOn && (b.state === 'planned' || b.state === 'done') && b.sync_calendar !== 'FALSE';
        const id = want ? (b.calendar_event_id || `demo-ev-${b.id}`) : '';
        if (id !== (b.calendar_event_id || '')) { b.calendar_event_id = id; results.push({ table: 'blocks', row: { ...b } }); }
      }
      this.save();
      return { results, now: nowStampIL() };
    }
    throw new Error('unknown action');
  }
}
