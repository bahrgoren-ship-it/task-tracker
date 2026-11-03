/**
 * Task tracker — backend (Google Apps Script, bound to the Sheet "מעקב שיעורי בית").
 *
 * What it does: a small JSON API over the Sheet, used by the app (docs/ folder of this repo).
 * Every request must carry the secret key stored in Script Properties (API_KEY).
 * Also: optional Google Calendar sync (deadlines + two-way work blocks) and a Moodle check (announcements +
 * assignments → moodle_inbox), run every 10 minutes by a trigger that setup() installs.
 *
 * Setup (once): run setup() from the Apps Script editor, copy the key from the log,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Full steps: SETUP.md in the repo.
 *
 * Schema of every tab: SCHEMA.md in the repo (also in Technion Studies/.ai/homework-tracker/).
 */

const SHEET_ID = '10qLYln2zUiMo7dEI3xZ8pj4ncGX7TRmATZNuZfvUfWM';
const TZ = 'Asia/Jerusalem';
const API_VERSION = 3;
const SCHEMA_VERSION = 3; // bump when SCHEMA changes; the Sheet is migrated automatically

// Column order of each tab. Must match row 1 of the Sheet (see SCHEMA.md).
const SCHEMA = {
  tasks: ['id', 'title', 'course', 'status', 'due_date', 'due_time', 'estimate_hours', 'spent_hours', 'notes',
    'links', 'source', 'moodle_ref', 'calendar_event_id', 'created_at', 'updated_at'],
  sessions: ['id', 'task_id', 'start', 'end', 'minutes', 'kind', 'note', 'updated_at'],
  blocks: ['id', 'task_id', 'start', 'end', 'state', 'sync_calendar', 'calendar_event_id', 'note', 'updated_at'],
  courses: ['slug', 'name_he', 'short_he', 'number', 'moodle_course_id', 'moodle_news_forum_id', 'color',
    'active', 'moodle_folder'],
  moodle_inbox: ['id', 'course', 'kind', 'moodle_ref', 'posted_at', 'title', 'author', 'text', 'detected_dates',
    'url', 'status', 'task_id'],
  settings: ['key', 'value', 'meaning'],
};
const KEY_COLUMN = { tasks: 'id', sessions: 'id', blocks: 'id', courses: 'slug', moodle_inbox: 'id', settings: 'key' };
const ID_PREFIX = { tasks: 't', sessions: 's', blocks: 'b', moodle_inbox: 'm' };
// Columns removed in a later schema version (dropped by migrate_).
const DROPPED = { tasks: ['grade'] };
// Default settings rows: [key, value, meaning]. Missing keys are added by migrate_.
const DEFAULT_SETTINGS = [
  ['sync_deadlines_to_calendar', 'FALSE', "TRUE = every task deadline appears in the Google Calendar 'משימות – הגשות'."],
  ['sync_blocks_to_calendar', 'FALSE', "TRUE = planned work blocks appear in the Google Calendar 'משימות – בלוקי עבודה' (two-way: moving/deleting the event there changes the block)."],
  ['default_block_minutes', '60', 'Length of a new work block dropped on the planner.'],
  ['week_starts_on', 'sunday', 'First day of the week in the planner.'],
  ['timezone', 'Asia/Jerusalem', 'All times in this Sheet are in this time zone.'],
  ['moodle_check_minutes', '15', 'How often the cloud check reads Moodle announcements.'],
  ['pomodoro_focus_minutes', '25', 'Pomodoro: length of a focus period.'],
  ['pomodoro_short_break_minutes', '5', 'Pomodoro: short break.'],
  ['pomodoro_long_break_minutes', '15', 'Pomodoro: long break.'],
  ['pomodoro_long_break_every', '4', 'Pomodoro: a long break after this many focus periods.'],
  ['pomodoro_auto_start_breaks', 'TRUE', 'Pomodoro: start the break automatically when focus ends.'],
  ['active_timer', '', 'App-managed: the running timer (JSON), shared between devices. Do not edit.'],
  ['deadline_calendar_id', '', "App-managed: id of the 'משימות – הגשות' calendar."],
  ['blocks_calendar_id', '', "App-managed: id of the 'משימות – בלוקי עבודה' calendar."],
  ['calendar_last_sync', '', 'App-managed: last calendar sync.'],
  ['moodle_last_check', '', 'App-managed: last time Moodle was checked.'],
  ['moodle_status', '', "App-managed: result of the last Moodle check ('ok …' or the error)."],
  ['schema_version', String(SCHEMA_VERSION), 'Bumped when columns change (see SCHEMA.md).'],
];
// Tables the app may write to, and which may have rows deleted.
const WRITABLE = ['tasks', 'sessions', 'blocks', 'moodle_inbox', 'settings'];
const DELETABLE = ['tasks', 'sessions', 'blocks'];
// How Date cells (if someone typed a real date into the Sheet) are turned back into text.
const DATE_FORMAT = { due_date: 'yyyy-MM-dd', due_time: 'HH:mm', posted_at: 'yyyy-MM-dd HH:mm',
  start: 'yyyy-MM-dd HH:mm', end: 'yyyy-MM-dd HH:mm', created_at: 'yyyy-MM-dd HH:mm',
  updated_at: 'yyyy-MM-dd HH:mm' };

/* ------------------------------------------------------------------ setup ---- */

/** Run once from the editor. Creates the secret key (or shows the existing one). */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('API_KEY', key);
  }
  withLock_(migrate_); // brings the Sheet's tabs/columns up to date (safe to run any time)
  // background job every 10 minutes: calendar two-way sync + Moodle check
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'scheduledSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scheduledSync').timeBased().everyMinutes(10).create();
  Logger.log('Your app key (paste it in the app settings): ' + key);
  return key;
}

/** Run if the key leaked: makes a new one (all devices must be set up again). */
function rotateKey() {
  PropertiesService.getScriptProperties().deleteProperty('API_KEY');
  return setup();
}

/* ------------------------------------------------------------------- HTTP ---- */

function doGet(e) {
  return handle_(Object.assign({}, (e && e.parameter) || {}));
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }
  return handle_(Object.assign({}, (e && e.parameter) || {}, body));
}

function handle_(req) {
  try {
    const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (!key || req.key !== key) return json_({ ok: false, error: 'unauthorized' });
    switch (req.action) {
      case 'ping':
        return json_({ ok: true, data: { api_version: API_VERSION, now: now_() } });
      case 'bootstrap':
        if (Number(getSetting_('schema_version') || 1) < SCHEMA_VERSION) withLock_(migrate_);
        return json_({ ok: true, data: bootstrap_() });
      case 'batch':
        return json_({ ok: true, data: withLock_(function () { return batch_(req.ops || []); }) });
      case 'busy': // events from Bahr's own calendars between two dates (for the planner)
        return json_({ ok: true, data: busy_(String(req.from), String(req.to)) });
      case 'syncNow':
        return json_({ ok: true, data: withLock_(function () { return { calendar: syncCalendars_(true) }; }) });
      case 'setMoodleToken':
        return json_({ ok: true, data: setMoodleToken_(String(req.token || '').trim()) });
      case 'moodleCheck':
        return json_({ ok: true, data: withLock_(moodleCheck_) });
      default:
        return json_({ ok: false, error: 'unknown action: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------- data access ---- */

function sheet_(table) {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(table);
  if (!sh) throw new Error('missing tab: ' + table);
  return sh;
}

/** Reads a tab into an array of objects (all values as strings). */
function readTable_(table) {
  const cols = SCHEMA[table];
  const sh = sheet_(table);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  const out = [];
  values.forEach(function (row) {
    if (row.every(function (v) { return v === '' || v === null; })) return;
    const obj = {};
    cols.forEach(function (c, i) { obj[c] = cellToString_(c, row[i]); });
    out.push(obj);
  });
  return out;
}

function cellToString_(col, v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, TZ, DATE_FORMAT[col] || 'yyyy-MM-dd HH:mm');
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function bootstrap_() {
  const data = { api_version: API_VERSION, now: now_() };
  Object.keys(SCHEMA).forEach(function (t) { data[t] = readTable_(t); });
  return data;
}

/**
 * ops: [{op:'upsert', table, row:{...only changed fields + key}}, {op:'delete', table, id}]
 * Returns the saved rows so the app can refresh its copy.
 */
function batch_(ops) {
  const results = [];
  const touched = {}; // task ids whose total time must be recomputed
  const cal = { tasks: {}, blocks: {}, dead: [], full: false }; // what the calendar sync must look at
  ops.forEach(function (o) {
    if (WRITABLE.indexOf(o.table) < 0) throw new Error('table not writable: ' + o.table);
    if (o.op === 'upsert') {
      const row = upsert_(o.table, o.row || {});
      if (o.table === 'sessions') touched[row.task_id] = true;
      if (o.table === 'tasks') cal.tasks[row.id] = true;
      if (o.table === 'blocks') cal.blocks[row.id] = true;
      if (o.table === 'settings' && /^sync_.*_to_calendar$/.test(row.key)) cal.full = true;
      results.push({ table: o.table, row: row });
    } else if (o.op === 'delete') {
      if (DELETABLE.indexOf(o.table) < 0) throw new Error('rows of ' + o.table + ' cannot be deleted');
      const old = deleteRow_(o.table, o.id);
      if (o.table === 'sessions' && old) touched[old.task_id] = true;
      if (old && old.calendar_event_id) cal.dead.push({ table: o.table, id: old.calendar_event_id });
      if (o.table === 'tasks') {
        deleteWhere_('blocks', 'task_id', o.id).forEach(function (b) {
          if (b.calendar_event_id) cal.dead.push({ table: 'blocks', id: b.calendar_event_id });
        });
        deleteWhere_('sessions', 'task_id', o.id);
      }
      results.push({ table: o.table, deleted: o.id });
    } else throw new Error('unknown op: ' + o.op);
  });
  try { // calendar problems must never block saving the data
    if (cal.full) syncCalendars_(true);
    else syncSome_(cal);
  } catch (err) { setSetting_('calendar_last_sync', now_() + ' · error: ' + err.message); }
  Object.keys(touched).forEach(function (id) {
    const row = id ? recomputeSpent_(id) : null;
    if (row) results.push({ table: 'tasks', row: row });
  });
  return { results: results, now: now_() };
}

/** tasks.spent_hours = sum of sessions.minutes / 60 (2 decimals). */
function recomputeSpent_(taskId) {
  const total = readTable_('sessions').reduce(function (sum, s) {
    return s.task_id === taskId ? sum + (Number(s.minutes) || 0) : sum;
  }, 0);
  const spent = total ? String(Math.round(total / 60 * 100) / 100) : '';
  const task = readTable_('tasks').filter(function (t) { return t.id === taskId; })[0];
  if (!task) return null;
  if (task.spent_hours === spent) return task; // unchanged: don't touch updated_at
  return upsert_('tasks', { id: taskId, spent_hours: spent });
}

function getSetting_(key) {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('settings');
  if (!sh || sh.getLastRow() < 2) return '';
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === key) return String(vals[i][1]);
  return '';
}

/* -------------------------------------------------------------- migration ---- */

/**
 * Makes every tab match SCHEMA: creates missing tabs, puts columns in SCHEMA order (by header name),
 * drops columns listed in DROPPED, adds missing settings, recomputes task totals. Keeps all data.
 */
function migrate_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  Object.keys(SCHEMA).forEach(function (table) {
    const cols = SCHEMA[table];
    let sh = ss.getSheetByName(table);
    if (!sh) sh = ss.insertSheet(table);
    const lastRow = sh.getLastRow(), lastCol = Math.max(sh.getLastColumn(), 1);
    const values = lastRow ? sh.getRange(1, 1, lastRow, lastCol).getValues() : [[]];
    const header = values[0].map(String);
    const same = header.length === cols.length && cols.every(function (c, i) { return header[i] === c; });
    if (!same) {
      const keep = header.filter(function (h) {
        return h && cols.indexOf(h) < 0 && (DROPPED[table] || []).indexOf(h) < 0;
      }); // unknown columns someone added by hand are kept at the end
      const newHeader = cols.concat(keep);
      const rows = values.slice(1).filter(function (r) { return r.some(function (v) { return v !== ''; }); })
        .map(function (r) {
          return newHeader.map(function (h) { const i = header.indexOf(h); return i < 0 ? '' : cellToString_(h, r[i]); });
        });
      sh.clear();
      sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
      sh.clearConditionalFormatRules();
      const all = sh.getRange(1, 1, rows.length + 1, newHeader.length);
      all.setNumberFormat('@');
      all.setValues([newHeader].concat(rows));
    }
    styleTab_(sh, table, cols.length);
  });
  // settings: add missing keys, set schema_version
  const sh = ss.getSheetByName('settings');
  const existing = readTable_('settings').map(function (r) { return r.key; });
  DEFAULT_SETTINGS.forEach(function (d) {
    if (existing.indexOf(d[0]) < 0) upsert_('settings', { key: d[0], value: d[1], meaning: d[2] });
    else upsert_('settings', { key: d[0], meaning: d[2] }); // keep the value, refresh the explanation
  });
  upsert_('settings', { key: 'schema_version', value: String(SCHEMA_VERSION) });
  readTable_('tasks').forEach(function (t) { recomputeSpent_(t.id); });
  return 'migrated to schema ' + SCHEMA_VERSION;
}

/** Header style, RTL, frozen header, dropdowns and colors. */
function styleTab_(sh, table, n) {
  sh.setRightToLeft(true);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, n).setFontWeight('bold').setBackground('#2B2F36').setFontColor('#FFFFFF');
  const rows = Math.max(sh.getMaxRows() - 1, 1);
  const col = function (name) { return SCHEMA[table].indexOf(name) + 1; };
  const list = function (name, values) {
    sh.getRange(2, col(name), rows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build());
  };
  if (table === 'tasks') {
    list('status', ['todo', 'in_progress', 'done', 'cancelled']);
    list('source', ['manual', 'moodle', 'class', 'notion']);
    const courses = SpreadsheetApp.openById(SHEET_ID).getSheetByName('courses');
    if (courses) sh.getRange(2, col('course'), rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInRange(courses.getRange('A2:A50'), true).setAllowInvalid(true).build());
    const all = sh.getRange(2, 1, rows, n);
    const st = String.fromCharCode(64 + col('status')), due = String.fromCharCode(64 + col('due_date'));
    sh.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(
        '=AND($' + due + '2<>"",DATEVALUE($' + due + '2)<TODAY(),$' + st + '2<>"done",$' + st + '2<>"cancelled")')
        .setFontColor('#C0392B').setBold(true).setRanges([all]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(
        '=OR($' + st + '2="done",$' + st + '2="cancelled")').setFontColor('#9AA0A6').setRanges([all]).build(),
    ]);
  }
  if (table === 'sessions') list('kind', ['stopwatch', 'pomodoro', 'manual']);
  if (table === 'blocks') list('state', ['draft', 'planned', 'done', 'skipped']);
  if (table === 'moodle_inbox') list('status', ['new', 'accepted', 'ignored']);
}

function findRow_(sh, keyIndex, keyValue) {
  const last = sh.getLastRow();
  if (last < 2 || !keyValue) return -1;
  const keys = sh.getRange(2, keyIndex + 1, last - 1, 1).getValues();
  for (let i = 0; i < keys.length; i++) if (String(keys[i][0]) === String(keyValue)) return i + 2;
  return -1;
}

function upsert_(table, patch, opts) {
  const touch = !(opts && opts.touch === false); // touch=false: don't change updated_at (internal bookkeeping)
  const cols = SCHEMA[table];
  const keyCol = KEY_COLUMN[table];
  const sh = sheet_(table);
  let rowNum = findRow_(sh, cols.indexOf(keyCol), patch[keyCol]);
  let current = {};
  if (rowNum > 0) {
    const vals = sh.getRange(rowNum, 1, 1, cols.length).getValues()[0];
    cols.forEach(function (c, i) { current[c] = cellToString_(c, vals[i]); });
  } else {
    if (!patch[keyCol]) {
      if (!ID_PREFIX[table]) throw new Error('missing ' + keyCol);
      patch[keyCol] = newId_(ID_PREFIX[table]);
    }
    if (cols.indexOf('created_at') >= 0) current.created_at = now_();
    rowNum = sh.getLastRow() + 1;
  }
  const merged = Object.assign({}, current);
  cols.forEach(function (c) {
    if (Object.prototype.hasOwnProperty.call(patch, c)) merged[c] = patch[c] === null ? '' : String(patch[c]);
  });
  if (cols.indexOf('updated_at') >= 0 && (touch || !merged.updated_at)) merged.updated_at = now_();
  const range = sh.getRange(rowNum, 1, 1, cols.length);
  range.setNumberFormat('@'); // keep everything as plain text (no auto date conversion)
  range.setValues([cols.map(function (c) { return merged[c] === undefined ? '' : merged[c]; })]);
  return merged;
}

function deleteRow_(table, id) {
  const cols = SCHEMA[table];
  const sh = sheet_(table);
  const rowNum = findRow_(sh, cols.indexOf(KEY_COLUMN[table]), id);
  if (rowNum < 0) return null;
  const vals = sh.getRange(rowNum, 1, 1, cols.length).getValues()[0];
  const old = {};
  cols.forEach(function (c, i) { old[c] = cellToString_(c, vals[i]); });
  sh.deleteRow(rowNum);
  return old;
}

function deleteWhere_(table, col, value) {
  const removed = readTable_(table).filter(function (r) { return String(r[col]) === String(value); });
  const sh = sheet_(table);
  const last = sh.getLastRow();
  if (last < 2) return removed;
  const idx = SCHEMA[table].indexOf(col);
  const vals = sh.getRange(2, idx + 1, last - 1, 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) if (String(vals[i][0]) === String(value)) sh.deleteRow(i + 2);
  return removed;
}

function newId_(prefix) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return prefix + '_' + s;
}

function now_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
}

function setSetting_(key, value) { upsert_('settings', { key: key, value: String(value) }, { touch: false }); }

/* ------------------------------------------------------- Google Calendar ---- */
// Two calendars are created in Bahr's Google Calendar the first time sync is turned on:
//   'משימות – הגשות'        all-day events for task deadlines (one-way: Sheet → Calendar)
//   'משימות – בלוקי עבודה'  planned work blocks (two-way: moving/deleting the event updates the block)

const CAL = {
  deadlines: { name: 'משימות – הגשות', setting: 'deadline_calendar_id', color: 'RED', toggle: 'sync_deadlines_to_calendar' },
  blocks: { name: 'משימות – בלוקי עבודה', setting: 'blocks_calendar_id', color: 'BLUE', toggle: 'sync_blocks_to_calendar' },
};
const APP_URL = 'https://bahrgoren-ship-it.github.io/task-tracker/';

function calendar_(kind, create) {
  const c = CAL[kind];
  const id = getSetting_(c.setting);
  let cal = null;
  if (id) { try { cal = CalendarApp.getCalendarById(id); } catch (err) { cal = null; } }
  if (!cal && create) {
    cal = CalendarApp.createCalendar(c.name, { color: CalendarApp.Color[c.color], timeZone: TZ });
    setSetting_(c.setting, cal.getId());
  }
  return cal;
}

function toDate_(stamp) {
  return stamp.length > 10 ? Utilities.parseDate(stamp, TZ, 'yyyy-MM-dd HH:mm') : Utilities.parseDate(stamp, TZ, 'yyyy-MM-dd');
}
function fmt_(d, f) { return Utilities.formatDate(d, TZ, f || 'yyyy-MM-dd HH:mm'); }
function safeEvent_(cal, id) { try { return cal.getEventById(id); } catch (err) { return null; } }
function courseMap_() {
  const m = {};
  readTable_('courses').forEach(function (c) { m[c.slug] = c; });
  return m;
}
function courseName_(courses, slug) { const c = courses[slug]; return c ? (c.short_he || c.name_he) : ''; }

/** Creates / updates / removes the deadline event of one task. */
function syncTaskEvent_(task, cal, enabled, courses) {
  const want = enabled && cal && task.due_date && task.status !== 'cancelled';
  const ev = task.calendar_event_id && cal ? safeEvent_(cal, task.calendar_event_id) : null;
  if (!want) {
    if (ev) ev.deleteEvent();
    if (task.calendar_event_id) upsert_('tasks', { id: task.id, calendar_event_id: '' }, { touch: false });
    return;
  }
  const course = courseName_(courses, task.course);
  const title = (task.status === 'done' ? '✓ ' : '⏰ ') + task.title + (course ? ' · ' + course : '') +
    (task.due_time ? ' (עד ' + task.due_time + ')' : '');
  const desc = (task.notes ? task.notes + '\n\n' : '') + 'נוצר ממעקב המשימות: ' + APP_URL;
  const day = toDate_(task.due_date);
  if (ev) {
    if (ev.getTitle() !== title) ev.setTitle(title);
    if (fmt_(ev.getAllDayStartDate(), 'yyyy-MM-dd') !== task.due_date) ev.setAllDayDate(day);
    if (ev.getDescription() !== desc) ev.setDescription(desc);
  } else {
    const created = cal.createAllDayEvent(title, day, { description: desc });
    upsert_('tasks', { id: task.id, calendar_event_id: created.getId() }, { touch: false });
  }
}

function blockWanted_(b, enabled, tasks) {
  return enabled && tasks[b.task_id] && (b.state === 'planned' || b.state === 'done') && b.sync_calendar !== 'FALSE' &&
    b.start && b.end;
}

/** Creates / updates / removes the calendar event of one work block. */
function syncBlockEvent_(b, cal, enabled, tasks, courses) {
  const ev = b.calendar_event_id && cal ? safeEvent_(cal, b.calendar_event_id) : null;
  if (!blockWanted_(b, enabled, tasks) || !cal) {
    if (ev) ev.deleteEvent();
    if (b.calendar_event_id) upsert_('blocks', { id: b.id, calendar_event_id: '' }, { touch: false });
    return;
  }
  const t = tasks[b.task_id];
  const course = courseName_(courses, t.course);
  const title = (b.state === 'done' ? '✓ ' : '📚 ') + t.title + (course ? ' · ' + course : '');
  const desc = (b.note ? b.note + '\n\n' : '') + 'בלוק עבודה ממעקב המשימות: ' + APP_URL +
    '\nהזזה או מחיקה של האירוע כאן מעדכנת את האפליקציה.';
  const s = toDate_(b.start), e = toDate_(b.end);
  if (ev) {
    if (ev.getTitle() !== title) ev.setTitle(title);
    if (ev.getStartTime().getTime() !== s.getTime() || ev.getEndTime().getTime() !== e.getTime()) ev.setTime(s, e);
  } else {
    const created = cal.createEvent(title, s, e, { description: desc });
    upsert_('blocks', { id: b.id, calendar_event_id: created.getId() }, { touch: false });
  }
}

/** After a save from the app: sync only the rows that changed. */
function syncSome_(c) {
  const dlOn = getSetting_(CAL.deadlines.toggle) === 'TRUE';
  const blOn = getSetting_(CAL.blocks.toggle) === 'TRUE';
  const taskIds = Object.keys(c.tasks), blockIds = Object.keys(c.blocks);
  if (!c.dead.length && !taskIds.length && !blockIds.length) return;
  const tasks = {};
  readTable_('tasks').forEach(function (t) { tasks[t.id] = t; });
  const courses = courseMap_();
  c.dead.forEach(function (d) {
    const cal = calendar_(d.table === 'tasks' ? 'deadlines' : 'blocks', false);
    const ev = cal && safeEvent_(cal, d.id);
    if (ev) ev.deleteEvent();
  });
  if (taskIds.length) {
    const cal = calendar_('deadlines', dlOn);
    taskIds.forEach(function (id) {
      if (tasks[id] && (dlOn || tasks[id].calendar_event_id)) syncTaskEvent_(tasks[id], cal, dlOn, courses);
    });
  }
  if (blockIds.length) {
    const cal = calendar_('blocks', blOn);
    readTable_('blocks').forEach(function (b) {
      if (c.blocks[b.id] && (blOn || b.calendar_event_id)) syncBlockEvent_(b, cal, blOn, tasks, courses);
    });
  }
}

/**
 * Full sync (every 10 minutes, and when a sync setting is switched).
 * 1. Calendar → Sheet: work-block events moved or deleted in Google Calendar update/delete the block.
 * 2. Sheet → Calendar: rows changed since the last run (or all rows when force) are pushed.
 */
function syncCalendars_(force) {
  const dlOn = getSetting_(CAL.deadlines.toggle) === 'TRUE';
  const blOn = getSetting_(CAL.blocks.toggle) === 'TRUE';
  const last = force ? '' : (getSetting_('calendar_last_sync') || '').slice(0, 16);
  const startedAt = now_();
  const courses = courseMap_();
  const tasks = {};
  readTable_('tasks').forEach(function (t) { tasks[t.id] = t; });
  let pulled = 0, pushed = 0;

  // 1. pull changes made in Google Calendar to work blocks
  const bcal = calendar_('blocks', blOn);
  if (bcal && blOn) {
    const from = new Date(Date.now() - 45 * 86400000), to = new Date(Date.now() + 180 * 86400000);
    const events = {};
    bcal.getEvents(from, to).forEach(function (ev) { events[ev.getId()] = ev; });
    readTable_('blocks').forEach(function (b) {
      if (!b.calendar_event_id || !b.start) return;
      const s = toDate_(b.start);
      if (s < from || s > to) return;
      const ev = events[b.calendar_event_id];
      if (!ev) { deleteRow_('blocks', b.id); pulled++; return; } // deleted in Google Calendar
      const es = fmt_(ev.getStartTime()), ee = fmt_(ev.getEndTime());
      if ((es !== b.start || ee !== b.end) && ev.getLastUpdated() > toDate_(b.updated_at || '2000-01-01')) {
        upsert_('blocks', { id: b.id, start: es, end: ee }); pulled++;
      }
    });
  }

  // 2. push changes from the Sheet
  const dcal = calendar_('deadlines', dlOn);
  Object.keys(tasks).forEach(function (id) {
    const t = tasks[id];
    const want = dlOn && t.due_date && t.status !== 'cancelled';
    if (force || (t.updated_at || '') >= last || (want && !t.calendar_event_id) || (!want && t.calendar_event_id)) {
      if (dcal || t.calendar_event_id) { syncTaskEvent_(t, dcal, dlOn, courses); pushed++; }
    }
  });
  readTable_('blocks').forEach(function (b) {
    const want = blockWanted_(b, blOn, tasks);
    if (force || (b.updated_at || '') >= last || (want && !b.calendar_event_id) || (!want && b.calendar_event_id)) {
      if (bcal || b.calendar_event_id) { syncBlockEvent_(b, bcal, blOn, tasks, courses); pushed++; }
    }
  });
  setSetting_('calendar_last_sync', startedAt);
  return { pulled: pulled, pushed: pushed };
}

/** Events from Bahr's own calendars (not the two app calendars), shown as busy time in the planner. */
function busy_(from, to) {
  const cache = CacheService.getScriptCache();
  const ck = 'busy:' + from + ':' + to;
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  const start = toDate_(from), end = new Date(toDate_(to).getTime() + 86400000);
  const skip = [getSetting_('deadline_calendar_id'), getSetting_('blocks_calendar_id')];
  const out = [];
  CalendarApp.getAllCalendars().forEach(function (cal) {
    if (skip.indexOf(cal.getId()) >= 0 || cal.isHidden()) return;
    cal.getEvents(start, end).forEach(function (ev) {
      const allDay = ev.isAllDayEvent();
      out.push({
        title: ev.getTitle(), calendar: cal.getName(), color: cal.getColor(), all_day: allDay,
        start: allDay ? fmt_(ev.getAllDayStartDate(), 'yyyy-MM-dd') : fmt_(ev.getStartTime()),
        end: allDay ? fmt_(ev.getAllDayEndDate(), 'yyyy-MM-dd') : fmt_(ev.getEndTime()),
      });
    });
  });
  try { cache.put(ck, JSON.stringify(out), 300); } catch (err) { /* too big to cache */ }
  return out;
}

/* ----------------------------------------------------------------- Moodle ---- */
// Reads each course's לוח הודעות (news forum) and the assignments with due dates from Technion Moodle,
// using Bahr's Moodle token (the same one moodle-dl uses). The token is kept in Script Properties only.
// New items go to the moodle_inbox tab; nothing becomes a task until Bahr accepts it in the app.

const MOODLE_SITE = 'https://moodle26.technion.ac.il';

function moodle_(fn, params, token) {
  token = token || PropertiesService.getScriptProperties().getProperty('MOODLE_TOKEN');
  if (!token) throw new Error('no Moodle token');
  const payload = Object.assign({ wstoken: token, wsfunction: fn, moodlewsrestformat: 'json' }, params || {});
  const res = UrlFetchApp.fetch(MOODLE_SITE + '/webservice/rest/server.php',
    { method: 'post', payload: payload, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Moodle HTTP ' + res.getResponseCode());
  const j = JSON.parse(res.getContentText());
  if (j && j.exception) throw new Error((j.errorcode || 'error') + ': ' + (j.message || ''));
  return j;
}

function setMoodleToken_(token) {
  if (!token) {
    PropertiesService.getScriptProperties().deleteProperty('MOODLE_TOKEN');
    setSetting_('moodle_status', 'not connected');
    return { connected: false };
  }
  const info = moodle_('core_webservice_get_site_info', {}, token); // throws if the token is wrong
  PropertiesService.getScriptProperties().setProperty('MOODLE_TOKEN', token);
  setSetting_('moodle_status', 'connected as ' + info.fullname);
  return { connected: true, fullname: info.fullname, site: info.sitename };
}

function plain_(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)); })
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Dates written in a Hebrew post (15.11, 15/11/26, 15.11.2026) → ['2026-11-15', ...] */
function detectDates_(text, ref) {
  const out = [];
  const re = /(^|[^\d.\/:])(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?(?![\d:]|[.\/]\d)/g;
  let m;
  while ((m = re.exec(text)) && out.length < 6) {
    const d = Number(m[2]), mo = Number(m[3]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    let y = m[4] ? Number(m[4]) : Number(fmt_(ref, 'yyyy'));
    if (y < 100) y += 2000;
    let date = new Date(y, mo - 1, d);
    if (!m[4] && date < new Date(ref.getTime() - 60 * 86400000)) date = new Date(y + 1, mo - 1, d);
    if (date.getMonth() !== mo - 1) continue; // e.g. 31.11
    const s = fmt_(date, 'yyyy-MM-dd');
    if (out.indexOf(s) < 0) out.push(s);
  }
  return out;
}

function moodleCheck_() {
  if (!PropertiesService.getScriptProperties().getProperty('MOODLE_TOKEN')) return { status: 'not connected' };
  const courses = readTable_('courses').filter(function (c) { return c.active !== 'FALSE'; });
  const inboxRefs = {};
  readTable_('moodle_inbox').forEach(function (r) { inboxRefs[r.moodle_ref] = true; });
  const taskByRef = {};
  readTable_('tasks').forEach(function (t) { if (t.moodle_ref) taskByRef[t.moodle_ref] = t; });
  const errors = [];
  let added = 0;
  const add = function (row) {
    if (inboxRefs[row.moodle_ref]) return;
    inboxRefs[row.moodle_ref] = true;
    upsert_('moodle_inbox', Object.assign({ status: 'new' }, row));
    added++;
  };

  courses.forEach(function (c) {
    if (!c.moodle_news_forum_id) return;
    try {
      let res;
      try {
        res = moodle_('mod_forum_get_forum_discussions', { forumid: c.moodle_news_forum_id, page: 0, perpage: 40 });
      } catch (err) {
        res = moodle_('mod_forum_get_forum_discussions_paginated',
          { forumid: c.moodle_news_forum_id, sortby: 'timemodified', sortdirection: 'DESC', page: 0, perpage: 40 });
      }
      (res.discussions || []).forEach(function (d) {
        const did = d.discussion || d.id;
        const ref = 'post:' + did;
        if (taskByRef[ref]) return;
        const posted = new Date((d.created || d.timemodified) * 1000);
        const text = plain_(d.message);
        add({
          course: c.slug, kind: 'announcement', moodle_ref: ref, posted_at: fmt_(posted),
          title: d.subject || d.name || '', author: d.userfullname || '', text: text.slice(0, 3000),
          detected_dates: detectDates_((d.subject || '') + '\n' + text, posted).join(', '),
          url: MOODLE_SITE + '/mod/forum/discuss.php?d=' + did,
        });
      });
    } catch (err) { errors.push((c.short_he || c.slug) + ': ' + err.message); }
  });

  try {
    const params = {};
    courses.forEach(function (c, i) { if (c.moodle_course_id) params['courseids[' + i + ']'] = c.moodle_course_id; });
    const res = moodle_('mod_assign_get_assignments', params);
    const soon = Date.now() - 3 * 86400000;
    (res.courses || []).forEach(function (mc) {
      const c = courses.filter(function (x) { return String(x.moodle_course_id) === String(mc.id); })[0];
      (mc.assignments || []).forEach(function (a) {
        if (!a.duedate || a.duedate * 1000 < soon) return;
        const due = fmt_(new Date(a.duedate * 1000));
        const ref = 'assign:' + a.id;
        const task = taskByRef[ref];
        if (task) {
          const mine = task.due_time ? task.due_date + ' ' + task.due_time : task.due_date;
          const theirs = task.due_time ? due : due.slice(0, 10);
          if (mine !== theirs) add({
            course: c ? c.slug : '', kind: 'date_change', moodle_ref: ref + '@' + due, posted_at: now_(),
            title: a.name, author: '', text: 'תאריך ההגשה במודל: ' + due + ' · אצלך: ' + mine,
            detected_dates: due, url: MOODLE_SITE + '/mod/assign/view.php?id=' + a.cmid, task_id: task.id,
          });
        } else {
          add({
            course: c ? c.slug : '', kind: 'assignment', moodle_ref: ref, posted_at: now_(), title: a.name, author: '',
            text: plain_(a.intro).slice(0, 1500), detected_dates: due,
            url: MOODLE_SITE + '/mod/assign/view.php?id=' + a.cmid,
          });
        }
      });
    });
  } catch (err) { errors.push('assignments: ' + err.message); }

  const status = errors.length ? 'error: ' + errors.join(' | ') : 'ok · ' + added + ' new';
  setSetting_('moodle_last_check', now_());
  setSetting_('moodle_status', status);
  return { status: status, added: added };
}

/* ------------------------------------------------------------ background ---- */

/** Runs every 10 minutes (trigger created by setup): calendar two-way sync + Moodle check. */
function scheduledSync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    try {
      if (getSetting_(CAL.deadlines.toggle) === 'TRUE' || getSetting_(CAL.blocks.toggle) === 'TRUE' ||
        getSetting_('deadline_calendar_id') || getSetting_('blocks_calendar_id')) syncCalendars_(false);
    } catch (err) { setSetting_('calendar_last_sync', now_() + ' · error: ' + err.message); }
    try {
      const every = Number(getSetting_('moodle_check_minutes')) || 15;
      const last = getSetting_('moodle_last_check');
      if (!last || Date.now() - toDate_(last).getTime() >= (every - 1) * 60000) moodleCheck_();
    } catch (err) { setSetting_('moodle_status', 'error: ' + err.message); }
  } finally { lock.releaseLock(); }
}
