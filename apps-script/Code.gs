/**
 * Task tracker — backend (Google Apps Script, bound to the Sheet "מעקב שיעורי בית").
 *
 * What it does: a small JSON API over the Sheet, used by the app (docs/ folder of this repo).
 * Every request must carry the secret key stored in Script Properties (API_KEY).
 * Also: Google Calendar sync (confirmed work blocks → Bahr's calendar 'לימודים', two-way; optional deadlines),
 * a Moodle check (announcements + assignments → moodle_inbox), run every 10 minutes by a trigger that setup()
 * installs, and an AI review (Gemini, built for the free tier) of new Moodle messages that suggests tasks only
 * when no existing task already covers them.
 *
 * Setup (once): run setup() from the Apps Script editor, copy the key from the log,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Full steps: SETUP.md in the repo.
 *
 * Schema of every tab: SCHEMA.md in the repo (also in Technion Studies/.ai/homework-tracker/).
 */

const SHEET_ID = '10qLYln2zUiMo7dEI3xZ8pj4ncGX7TRmATZNuZfvUfWM';
const TZ = 'Asia/Jerusalem';
const API_VERSION = 6; // 5: calendars action, chosen blocks calendar, batch returns fresh rows · 6: suggestions tab
const SCHEMA_VERSION = 6; // bump when SCHEMA / settings change; the Sheet is migrated automatically

// Column order of each tab. Must match row 1 of the Sheet (see SCHEMA.md).
const SCHEMA = {
  tasks: ['id', 'title', 'course', 'status', 'due_date', 'due_time', 'estimate_hours', 'spent_hours', 'notes',
    'links', 'source', 'moodle_ref', 'calendar_event_id', 'created_at', 'updated_at'],
  sessions: ['id', 'task_id', 'start', 'end', 'minutes', 'kind', 'note', 'updated_at'],
  blocks: ['id', 'task_id', 'start', 'end', 'state', 'sync_calendar', 'calendar_event_id', 'note', 'updated_at'],
  courses: ['slug', 'name_he', 'short_he', 'number', 'moodle_course_id', 'moodle_news_forum_id', 'color',
    'active', 'moodle_folder'],
  moodle_inbox: ['id', 'course', 'kind', 'moodle_ref', 'posted_at', 'title', 'author', 'text', 'detected_dates',
    'url', 'status', 'task_id', 'ai_status', 'ai_summary', 'ai_suggestions', 'ai_checked_at'],
  settings: ['key', 'value', 'meaning'],
  // changes proposed by any AI with access to the Sheet; nothing happens until Bahr approves one in the app
  suggestions: ['id', 'status', 'summary', 'table', 'op', 'row_id', 'fields', 'reason', 'by', 'created_at', 'decided_at', 'result'],
};
const KEY_COLUMN = { tasks: 'id', sessions: 'id', blocks: 'id', courses: 'slug', moodle_inbox: 'id', settings: 'key', suggestions: 'id' };
const ID_PREFIX = { tasks: 't', sessions: 's', blocks: 'b', moodle_inbox: 'm', suggestions: 'sg' };
// Columns removed in a later schema version (dropped by migrate_).
const DROPPED = { tasks: ['grade'] };
// Default settings rows: [key, value, meaning]. Missing keys are added by migrate_.
const DEFAULT_SETTINGS = [
  ['sync_deadlines_to_calendar', 'FALSE', "TRUE = every task deadline appears in the Google Calendar 'משימות – הגשות'."],
  ['sync_blocks_to_calendar', 'TRUE', "TRUE = confirmed work blocks (after 'אשר תכנון') appear in the Google Calendar named in blocks_calendar_name (two-way: moving/deleting the event there changes the block)."],
  ['blocks_calendar_name', 'לימודים', "Name of the Google Calendar for work blocks (one of Bahr's own calendars). Empty = a separate calendar 'משימות – בלוקי עבודה'."],
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
  ['blocks_calendar_id', '', 'App-managed: id of the calendar that holds the work-block events now.'],
  ['calendar_last_sync', '', 'App-managed: last full calendar sync (rows changed after it are pushed next time).'],
  ['calendar_status', '', "App-managed: result of the last calendar sync ('ok · time' or 'error · time · what')."],
  ['moodle_last_check', '', 'App-managed: last time Moodle was checked.'],
  ['moodle_status', '', "App-managed: result of the last Moodle check ('ok …' or the error)."],
  ['ai_model', '', "Gemini model to try first for the AI review. Empty = automatic: the newest Flash-Lite (biggest free quota), then the newest Flash."],
  ['ai_status', '', "App-managed: AI review — 'ok · …', 'waiting · why · until · at' (quota / busy) or 'error · what · at'."],
  ['ai_last_error', '', "App-managed: Gemini's own text for the last problem (shown under 'פרטים' in the app)."],
  ['schema_version', String(SCHEMA_VERSION), 'Bumped when columns change (see SCHEMA.md).'],
];
// Tables the app may write to, and which may have rows deleted.
const WRITABLE = ['tasks', 'sessions', 'blocks', 'moodle_inbox', 'settings', 'suggestions'];
const DELETABLE = ['tasks', 'sessions', 'blocks'];
// A row must have these to be created. A change to a row that no longer exists (deleted on another device, merged
// as a duplicate…) without them is dropped instead of creating half a row.
const REQUIRED = { tasks: ['title'], sessions: ['task_id', 'start'], blocks: ['task_id', 'start', 'end'], moodle_inbox: ['moodle_ref'], suggestions: ['op'] };
// How Date cells (if someone typed a real date into the Sheet) are turned back into text.
const DATE_FORMAT = { due_date: 'yyyy-MM-dd', due_time: 'HH:mm', posted_at: 'yyyy-MM-dd HH:mm',
  start: 'yyyy-MM-dd HH:mm', end: 'yyyy-MM-dd HH:mm', created_at: 'yyyy-MM-dd HH:mm',
  updated_at: 'yyyy-MM-dd HH:mm', ai_checked_at: 'yyyy-MM-dd HH:mm' };

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
        if (suggestionsWithoutId_()) withLock_(fillSuggestionIds_);
        return json_({ ok: true, data: bootstrap_() });
      case 'batch':
        return json_({ ok: true, data: withLock_(function () { return batch_(req.ops || []); }) });
      case 'busy': // events from Bahr's own calendars between two dates (for the planner)
        return json_({ ok: true, data: busy_(String(req.from), String(req.to)) });
      case 'calendars': // Bahr's own calendars, to choose where work blocks go
        return json_({ ok: true, data: calendars_() });
      case 'syncNow':
        return json_({ ok: true, data: withLock_(function () { return { calendar: syncCalendars_(true) }; }) });
      case 'setMoodleToken':
        return json_({ ok: true, data: setMoodleToken_(String(req.token || '').trim()) });
      case 'moodleCheck':
        return json_({ ok: true, data: withLock_(moodleCheck_) });
      case 'setGeminiKey':
        return json_({ ok: true, data: setGeminiKey_(String(req.key_value || '').trim()) });
      case 'aiReview': // {id} = review that message again; no id = review all messages still waiting
        return json_({ ok: true, data: aiReview_({ id: req.id ? String(req.id) : '' }) });
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
      const patch = o.row || {}, id = patch[KEY_COLUMN[o.table]], need = REQUIRED[o.table];
      if (need && id && need.some(function (c) { return !patch[c]; }) && !rowExists_(o.table, id)) {
        results.push({ table: o.table, deleted: id }); // gone: tell the app to drop it too
        return;
      }
      const row = upsert_(o.table, patch);
      if (o.table === 'sessions') touched[row.task_id] = true;
      if (o.table === 'tasks') cal.tasks[row.id] = true;
      if (o.table === 'blocks') cal.blocks[row.id] = true;
      if (o.table === 'settings' && /^(sync_.*_to_calendar|blocks_calendar_name)$/.test(row.key)) cal.full = true;
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
  } catch (err) { setSetting_('calendar_status', 'error · ' + now_() + ' · ' + err.message); }
  // send back the rows as they are now (the calendar sync fills calendar_event_id), so the app shows it at once
  [['tasks', cal.tasks], ['blocks', cal.blocks]].forEach(function (p) {
    if (!Object.keys(p[1]).length) return;
    readTable_(p[0]).forEach(function (r) { if (p[1][r.id]) results.push({ table: p[0], row: r }); });
  });
  Object.keys(touched).forEach(function (id) {
    const row = id ? recomputeSpent_(id) : null;
    if (row) results.push({ table: 'tasks', row: row });
  });
  return { results: results, now: now_() };
}

function rowExists_(table, id) {
  return findRow_(sheet_(table), SCHEMA[table].indexOf(KEY_COLUMN[table]), id) > 0;
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
  const existing = readTable_('settings').map(function (r) { return r.key; });
  DEFAULT_SETTINGS.forEach(function (d) {
    if (existing.indexOf(d[0]) < 0) upsert_('settings', { key: d[0], value: d[1], meaning: d[2] });
    else upsert_('settings', { key: d[0], meaning: d[2] }); // keep the value, refresh the explanation
  });
  // schema 5: Bahr asked for confirmed work blocks in his calendar 'לימודים' — switch it on once
  if (existing.indexOf('blocks_calendar_name') < 0) setSetting_('sync_blocks_to_calendar', 'TRUE');
  upsert_('settings', { key: 'schema_version', value: String(SCHEMA_VERSION) });
  readTable_('tasks').forEach(function (t) { recomputeSpent_(t.id); });
  writeAiHelp_();
  const fixed = cleanup_();
  return 'migrated to schema ' + SCHEMA_VERSION + ' · ' + JSON.stringify(fixed);
}

/* ------------------------------------------------- suggestions from any AI ---- */
// An AI that can edit the Sheet adds a row to 'suggestions' (instructions: tab 'AI – איך להציע', and SCHEMA.md).
// The app shows each pending row; on "אשר" the app itself makes the change (so the calendar sync etc. run as usual).

function suggestionsWithoutId_() {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('suggestions');
  if (!sh || sh.getLastRow() < 2) return false;
  const n = SCHEMA.suggestions.length;
  return sh.getRange(2, 1, sh.getLastRow() - 1, n).getValues()
    .some(function (r) { return !r[0] && r.some(function (v) { return v !== ''; }); });
}
/** Rows an AI typed in without an id / status / time get them, so the app can approve or reject them. */
function fillSuggestionIds_() {
  const sh = sheet_('suggestions');
  const n = SCHEMA.suggestions.length, last = sh.getLastRow();
  if (last < 2) return 0;
  const vals = sh.getRange(2, 1, last - 1, n).getValues();
  let fixed = 0;
  vals.forEach(function (r, i) {
    if (r[0] || !r.some(function (v) { return v !== ''; })) return;
    r[0] = newId_('sg');
    if (!r[1]) r[1] = 'pending';
    if (!r[9]) r[9] = now_();
    const range = sh.getRange(i + 2, 1, 1, n);
    range.setNumberFormat('@');
    range.setValues([r.map(function (v, k) { return cellToString_(SCHEMA.suggestions[k], v); })]);
    fixed++;
  });
  return fixed;
}

const AI_HELP = [
  'How to suggest a change to Bahr\'s tasks (for any AI that can edit this Sheet)',
  '',
  'Add ONE ROW to the tab "suggestions" for each change. Bahr sees it in the app and approves or rejects it. Never edit the',
  'tasks / blocks / sessions tabs directly. Leave id, status, created_at, decided_at, result empty (filled automatically).',
  '',
  'Columns:',
  '  summary  – what the change is, short Hebrew, written to Bahr (male), e.g. "להוסיף משימה: תרגיל בית 3 בסטטיסטיקה, הגשה ב-20.11"',
  '  table    – tasks | blocks | sessions   (tasks = the task list; blocks = planned work time in the planner; sessions = time already worked)',
  '  op       – create | update | delete',
  '  row_id   – for update / delete: the id of the existing row (e.g. t_ab12cd). Empty for create.',
  '  fields   – JSON object with only the columns to set, e.g. {"title":"תרגיל בית 3","course":"statistics-1","due_date":"2026-11-20","due_time":"23:59"}',
  '  reason   – why (one short Hebrew sentence)',
  '  by       – who suggests it (e.g. "Gemini", "Claude")',
  '',
  'Allowed fields:',
  '  tasks:    title, course (a slug from the courses tab), status (todo | in_progress | done | cancelled), due_date (yyyy-mm-dd),',
  '            due_time (HH:MM), estimate_hours (number), notes, links (one URL per line).',
  '            create may also include "blocks": [{"start":"2026-11-10 18:00","end":"2026-11-10 19:00"}] to plan work time for it.',
  '  blocks:   task_id, start, end ("yyyy-mm-dd HH:MM", Israel time), state (draft | planned | done | skipped), note.',
  '  sessions: task_id, start, end, minutes (number), note.',
  '',
  'Rules: one change per row (several rows are fine). Dates/times are Israel time. Check the tasks tab first so you don\'t',
  'suggest something that already exists. Don\'t suggest the same thing twice — look at pending rows in "suggestions".',
  '',
  'Examples (fields column):',
  '  tasks create   {"title":"הכנה לבוחן אמצע","course":"algebraic-methods","due_date":"2026-12-13","estimate_hours":6}',
  '  tasks update   row_id t_ab12cd   {"due_date":"2026-11-22","due_time":"12:00"}',
  '  tasks update   row_id t_ab12cd   {"status":"done"}',
  '  blocks create  {"task_id":"t_ab12cd","start":"2026-11-10 18:00","end":"2026-11-10 20:00","state":"planned"}',
  '  blocks delete  row_id b_xy34zz   {}',
];
function writeAiHelp_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const name = 'AI – איך להציע';
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  sh.getRange(1, 1, AI_HELP.length, 1).setValues(AI_HELP.map(function (l) { return [l]; }));
  sh.getRange(1, 1, 1, 1).setFontWeight('bold');
}

/**
 * Repairs left-overs (safe to run any time): duplicate inbox messages, half-written blocks/sessions,
 * and messages the AI couldn't read only because Gemini was busy or out of quota (they are read again).
 */
function cleanup_() {
  const out = { duplicates: dedupeInbox_(), orphans: 0, retry: 0 };
  readTable_('blocks').forEach(function (b) {
    if (!b.task_id || !b.start || !b.end) { deleteRow_('blocks', b.id); out.orphans++; }
  });
  readTable_('sessions').forEach(function (x) {
    if (!x.task_id || !x.start) { deleteRow_('sessions', x.id); out.orphans++; }
  });
  readTable_('moodle_inbox').forEach(function (m) {
    if (/^error: Gemini (429|5\d\d)/.test(m.ai_status)) {
      upsert_('moodle_inbox', { id: m.id, ai_status: '' }, { touch: false });
      out.retry++;
    }
  });
  return out;
}

/**
 * The same Moodle post must appear once. Keeps the copy Bahr already handled (or the one the AI read) and
 * deletes the others. Returns how many were removed.
 */
function dedupeInbox_() {
  const byRef = {};
  readTable_('moodle_inbox').forEach(function (r) {
    if (r.moodle_ref) (byRef[r.moodle_ref] = byRef[r.moodle_ref] || []).push(r);
  });
  const score = function (r) { return (r.status !== 'new' ? 4 : 0) + (r.ai_status === 'done' ? 2 : 0) + (r.task_id ? 1 : 0); };
  let removed = 0;
  Object.keys(byRef).forEach(function (ref) {
    const list = byRef[ref];
    if (list.length < 2) return;
    list.sort(function (a, b) { return score(b) - score(a); });
    const keep = list[0], patch = { id: keep.id };
    list.slice(1).forEach(function (r) {
      if (keep.ai_status !== 'done' && r.ai_status === 'done' && !patch.ai_status) {
        ['ai_status', 'ai_summary', 'ai_suggestions', 'ai_checked_at'].forEach(function (c) { patch[c] = r[c]; });
      }
      if (!keep.task_id && r.task_id && !patch.task_id) patch.task_id = r.task_id;
      deleteRow_('moodle_inbox', r.id);
      removed++;
    });
    if (Object.keys(patch).length > 1) upsert_('moodle_inbox', patch, { touch: false });
  });
  return removed;
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
    list('source', ['manual', 'moodle', 'class', 'notion', 'ai']);
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
  if (table === 'suggestions') {
    // hints only (invalid values allowed): an AI that writes "add" instead of "create" still works
    const hint = function (name, values) {
      sh.getRange(2, col(name), rows, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build());
    };
    hint('status', ['pending', 'approved', 'rejected']);
    hint('table', ['tasks', 'blocks', 'sessions']);
    hint('op', ['create', 'update', 'delete']);
  }
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
// Work blocks go to one of Bahr's own Google calendars, chosen by name in settings.blocks_calendar_name
// (default 'לימודים'; empty = a separate calendar the app creates, 'משימות – בלוקי עבודה'). Only confirmed
// blocks ("אשר תכנון") are synced, right after they are saved. Two-way: moving or deleting the event in Google
// Calendar changes / removes the block. Task deadlines can go (one-way) to the app's calendar 'משימות – הגשות'.

const CAL = {
  deadlines: { name: 'משימות – הגשות', setting: 'deadline_calendar_id', color: 'RED', toggle: 'sync_deadlines_to_calendar' },
  blocks: { name: 'משימות – בלוקי עבודה', setting: 'blocks_calendar_id', color: 'BLUE', toggle: 'sync_blocks_to_calendar',
    pick: 'blocks_calendar_name' },
};
const APP_URL = 'https://bahrgoren-ship-it.github.io/task-tracker/';

function calendarById_(id) {
  if (!id) return null;
  try { return CalendarApp.getCalendarById(id); } catch (err) { return null; }
}

/** The deadlines calendar (created by the app the first time, when create = true). */
function calendar_(kind, create) {
  const c = CAL[kind];
  let cal = calendarById_(getSetting_(c.setting));
  if (!cal && create) {
    cal = CalendarApp.createCalendar(c.name, { color: CalendarApp.Color[c.color], timeZone: TZ });
    setSetting_(c.setting, cal.getId());
  }
  return cal;
}

/**
 * The calendar work blocks go to. blocks_calendar_id remembers the calendar that holds the events now; when Bahr
 * picks another calendar, the events are removed from the old one (and created again in the new one by the sync).
 * Sync off: returns the calendar that still holds old events (so they can be removed), or null.
 * Throws if the chosen calendar doesn't exist.
 */
function blocksCalendar_(on) {
  const current = calendarById_(getSetting_(CAL.blocks.setting));
  if (!on) return current;
  const name = String(getSetting_(CAL.blocks.pick) || '').trim();
  if (current && current.getName() === (name || CAL.blocks.name)) return current;
  let target;
  if (name) {
    target = CalendarApp.getOwnedCalendarsByName(name)[0] || CalendarApp.getCalendarsByName(name)[0];
    if (!target) throw new Error('calendar not found: ' + name);
  } else {
    target = CalendarApp.getOwnedCalendarsByName(CAL.blocks.name)[0] ||
      CalendarApp.createCalendar(CAL.blocks.name, { color: CalendarApp.Color.BLUE, timeZone: TZ });
  }
  // moving to another calendar: take the block events out of the old one (or forget ids of a calendar that's gone)
  readTable_('blocks').forEach(function (b) {
    if (!b.calendar_event_id) return;
    const ev = current && safeEvent_(current, b.calendar_event_id);
    if (ev) ev.deleteEvent();
    upsert_('blocks', { id: b.id, calendar_event_id: '' }, { touch: false });
  });
  setSetting_(CAL.blocks.setting, target.getId());
  return target;
}

/** Bahr's own calendars, for the "which calendar" choice in the app's settings. */
function calendars_() {
  const list = CalendarApp.getAllOwnedCalendars()
    .filter(function (c) { return c.getName() !== CAL.deadlines.name; })
    .map(function (c) {
      return { id: c.getId(), name: c.getName(), color: c.getColor(), primary: c.isMyPrimaryCalendar() };
    })
    .sort(function (a, b) { return (b.primary - a.primary) || a.name.localeCompare(b.name); });
  return { calendars: list, chosen: getSetting_(CAL.blocks.pick) };
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
    const cal = d.table === 'tasks' ? calendar_('deadlines', false) : calendarById_(getSetting_(CAL.blocks.setting));
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
    const cal = blocksCalendar_(blOn);
    readTable_('blocks').forEach(function (b) {
      if (c.blocks[b.id] && (blOn || b.calendar_event_id)) syncBlockEvent_(b, cal, blOn, tasks, courses);
    });
  }
  if (dlOn || blOn) setSetting_('calendar_status', 'ok · ' + now_());
}

/**
 * Full sync (every 10 minutes, and when a calendar setting changes).
 * 1. Calendar → Sheet: work-block events moved or deleted in Google Calendar update/delete the block.
 * 2. Sheet → Calendar: rows changed since the last run (or all rows when force) are pushed.
 * A problem with the blocks calendar (e.g. the chosen calendar doesn't exist) doesn't stop the deadlines.
 */
function syncCalendars_(force) {
  const dlOn = getSetting_(CAL.deadlines.toggle) === 'TRUE';
  const blOn = getSetting_(CAL.blocks.toggle) === 'TRUE';
  const last = force ? '' : (getSetting_('calendar_last_sync') || '').slice(0, 16);
  const startedAt = now_();
  const courses = courseMap_();
  const tasks = {};
  readTable_('tasks').forEach(function (t) { tasks[t.id] = t; });
  let pulled = 0, pushed = 0, problem = '';

  let bcal = null;
  try { bcal = blocksCalendar_(blOn); } catch (err) { problem = err.message; }

  // 1. pull changes made in Google Calendar to work blocks
  if (bcal && blOn) {
    const from = new Date(Date.now() - 45 * 86400000), to = new Date(Date.now() + 180 * 86400000);
    const events = {};
    bcal.getEvents(from, to).forEach(function (ev) { events[ev.getId()] = ev; });
    readTable_('blocks').forEach(function (b) {
      if (!b.calendar_event_id || !b.start) return;
      const s = toDate_(b.start);
      if (s < from || s > to) return;
      // not in the window → ask for it directly (it may have been moved far away) before deciding it was deleted
      const ev = events[b.calendar_event_id] || safeEvent_(bcal, b.calendar_event_id);
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
  if (!problem) {
    readTable_('blocks').forEach(function (b) {
      const want = blockWanted_(b, blOn, tasks);
      if (force || (b.updated_at || '') >= last || (want && !b.calendar_event_id) || (!want && b.calendar_event_id)) {
        if (bcal || b.calendar_event_id) { syncBlockEvent_(b, bcal, blOn, tasks, courses); pushed++; }
      }
    });
  }
  setSetting_('calendar_last_sync', startedAt);
  setSetting_('calendar_status', problem ? 'error · ' + startedAt + ' · ' + problem : 'ok · ' + startedAt);
  return { pulled: pulled, pushed: pushed, problem: problem };
}

/**
 * Events from Bahr's calendars between two dates, shown as busy time in the planner.
 * Leaves out the app's own calendars and the events of his work blocks (they are drawn as blocks already).
 */
function busy_(from, to) {
  const cache = CacheService.getScriptCache();
  const ck = 'busy:' + from + ':' + to;
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  const start = toDate_(from), end = new Date(toDate_(to).getTime() + 86400000);
  const skipCal = [getSetting_(CAL.deadlines.setting)];
  const ours = {};
  readTable_('blocks').forEach(function (b) { if (b.calendar_event_id) ours[b.calendar_event_id] = true; });
  const out = [];
  CalendarApp.getAllCalendars().forEach(function (cal) {
    if (skipCal.indexOf(cal.getId()) >= 0 || cal.isHidden()) return;
    if (cal.getName() === CAL.deadlines.name || cal.getName() === CAL.blocks.name) return;
    cal.getEvents(start, end).forEach(function (ev) {
      if (ours[ev.getId()]) return;
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
const MAX_TEXT = 40000; // full message text (a Sheet cell holds up to 50,000 characters)

function moodle_(fn, params, token) {
  token = token || PropertiesService.getScriptProperties().getProperty('MOODLE_TOKEN');
  if (!token) throw new Error('no Moodle token');
  const payload = Object.assign({ wstoken: token, wsfunction: fn, moodlewsrestformat: 'json',
    moodlewssettingfilter: 'true', moodlewssettingfileurl: 'true' }, params || {});
  const res = UrlFetchApp.fetch(MOODLE_SITE + '/webservice/rest/server.php',
    { method: 'post', payload: payload, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Moodle HTTP ' + res.getResponseCode());
  const j = JSON.parse(res.getContentText());
  if (j && j.exception) {
    throw new Error((j.errorcode || 'error') + ': ' + (j.message || '') + (j.debuginfo ? ' [' + j.debuginfo + ']' : ''));
  }
  return j;
}

/**
 * Discussions of one forum, newest first (Moodle's default order: latest post first).
 * Technion's Moodle (5.2) rejects page sizes above 10 with "invalidparameter", so we ask exactly like moodle-dl
 * does ({forumid, page, perpage: 10}) and read as many pages as needed. If that is refused, a few other parameter
 * sets are tried; the one that works is remembered.
 */
const FORUM_PAGE_SIZE = 10;
function forumDiscussions_(forumId, wanted) {
  const props = PropertiesService.getScriptProperties();
  const variants = [ // extra parameters for mod_forum_get_forum_discussions, tried in order
    { },                 // = moodle-dl
    { sortorder: 1 },    // last post, newest first
    { sortorder: 3 },    // created, newest first
    { sortorder: -1 },
  ];
  const fetchPage = function (i, page) {
    const p = Object.assign({ forumid: forumId, page: page, perpage: FORUM_PAGE_SIZE }, variants[i]);
    return moodle_('mod_forum_get_forum_discussions', p);
  };
  const known = props.getProperty('MOODLE_FORUM_VARIANT2');
  const order = (known !== null && variants[Number(known)] ? [Number(known)] : [])
    .concat(variants.map(function (v, i) { return i; }));
  const errors = [];
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    let first;
    try { first = fetchPage(i, 0); } catch (err) {
      if (errors.length < 3) errors.push(JSON.stringify(variants[i]) + ': ' + err.message);
      continue;
    }
    if (known !== String(i)) props.setProperty('MOODLE_FORUM_VARIANT2', String(i));
    let all = first.discussions || [];
    for (let page = 1; all.length >= page * FORUM_PAGE_SIZE && all.length < (wanted || 20); page++) {
      const more = fetchPage(i, page).discussions || [];
      if (!more.length) break;
      all = all.concat(more);
    }
    return { discussions: all.slice(0, wanted || 20) };
  }
  throw new Error('forum ' + forumId + ': ' + errors.join(' / '));
}

/**
 * Fallback when the Moodle API refuses: read the announcements moodle-dl already saved to Drive
 * (<course Moodle folder>/<section>/לוח הודעות/<yy-mm-dd subject>/[<post id>] <author>.md).
 */
const STUDIES_FOLDER_ID = '1HoErIXnpHGZiuPmThqXuOVe4iwEMKdDs'; // Technion Studies
function driveFolderByPath_(path) {
  let f = DriveApp.getFolderById(STUDIES_FOLDER_ID);
  const parts = String(path || '').split('/').filter(String);
  for (let i = 0; i < parts.length; i++) {
    const it = f.getFoldersByName(parts[i]);
    if (!it.hasNext()) return null;
    f = it.next();
  }
  return f;
}
function driveAnnouncements_(course) {
  const root = driveFolderByPath_(course.moodle_folder);
  if (!root) throw new Error('Drive folder not found: ' + course.moodle_folder);
  const boards = [];
  const sections = root.getFolders();
  while (sections.hasNext()) {
    const it = sections.next().getFoldersByName('לוח הודעות');
    while (it.hasNext()) boards.push(it.next());
  }
  const out = [];
  boards.forEach(function (board) {
    const ds = board.getFolders();
    while (ds.hasNext()) {
      const d = ds.next();
      const m = /^(\d{2})-(\d{2})-(\d{2}) (.*)$/.exec(d.getName());
      const files = [];
      const fi = d.getFiles();
      while (fi.hasNext()) files.push(fi.next());
      const posts = files.map(function (f) {
        const pm = /^\[(\d+)\]\s*(.*?)\.(md|html|txt)$/.exec(f.getName());
        return pm ? { id: Number(pm[1]), author: pm[2], file: f } : null;
      }).filter(Boolean).sort(function (a, b) { return a.id - b.id; });
      if (!posts.length) continue;
      const first = posts[0];
      out.push({
        ref: 'post:file' + first.id,
        // the folder name has the post's date; the file's own time is when moodle-dl saved it, so no time is kept
        posted: m ? '20' + m[1] + '-' + m[2] + '-' + m[3] : fmt_(first.file.getDateCreated(), 'yyyy-MM-dd'),
        title: m ? m[4] : d.getName(), author: first.author,
        text: first.file.getBlob().getDataAsString('UTF-8'), url: d.getUrl(),
      });
    }
  });
  return out;
}

function refStored_(ref) {
  const sh = sheet_('moodle_inbox');
  const last = sh.getLastRow();
  if (last < 2) return false;
  const col = SCHEMA.moodle_inbox.indexOf('moodle_ref') + 1;
  return sh.getRange(2, col, last - 1, 1).getValues().some(function (r) { return String(r[0]) === ref; });
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
  const errors = [], viaDrive = []; // viaDrive: why the Moodle API couldn't be used for a course
  let added = 0;
  const add = function (row) {
    if (inboxRefs[row.moodle_ref]) return;
    inboxRefs[row.moodle_ref] = true;
    if (refStored_(row.moodle_ref)) return; // another run added it in the meantime
    upsert_('moodle_inbox', Object.assign({ status: 'new' }, row));
    added++;
  };

  // Find each course's announcements forum (type "news"). courses.moodle_news_forum_id holds the forum's page id
  // (cmid, as in the Moodle folder); the API needs the forum instance id, so we look it up.
  const forumOf = {};
  try {
    const fp = {};
    courses.forEach(function (c, i) { if (c.moodle_course_id) fp['courseids[' + i + ']'] = c.moodle_course_id; });
    (moodle_('mod_forum_get_forums_by_courses', fp) || []).forEach(function (f) {
      const c = courses.filter(function (x) { return String(x.moodle_course_id) === String(f.course); })[0];
      if (!c) return;
      const isNews = f.type === 'news' || String(f.cmid) === String(c.moodle_news_forum_id);
      if (isNews && (!forumOf[c.slug] || f.type === 'news')) forumOf[c.slug] = f.id;
    });
  } catch (err) { errors.push('forums: ' + err.message); }

  courses.forEach(function (c) {
    const forumId = forumOf[c.slug];
    try {
      let res;
      try {
        if (!forumId) throw new Error('no news forum found');
        res = forumDiscussions_(forumId, 20);
      } catch (apiErr) {
        // API refused → use the copies moodle-dl saved in Drive (only as fresh as the last moodle-dl run)
        viaDrive.push((c.short_he || c.slug) + ': ' + apiErr.message);
        driveAnnouncements_(c).forEach(function (p) {
          if (taskByRef[p.ref]) return;
          add({
            course: c.slug, kind: 'announcement', moodle_ref: p.ref, posted_at: p.posted, title: p.title,
            author: p.author, text: p.text.slice(0, MAX_TEXT),
            detected_dates: detectDates_(p.title + '\n' + p.text, toDate_(p.posted.slice(0, 10))).join(', '), url: p.url,
          });
        });
        return;
      }
      (res.discussions || []).forEach(function (d) {
        const did = d.discussion || d.id;
        const ref = 'post:' + did;
        if (taskByRef[ref]) return;
        const posted = new Date((d.created || d.timemodified) * 1000);
        const text = plain_(d.message);
        add({
          course: c.slug, kind: 'announcement', moodle_ref: ref, posted_at: fmt_(posted),
          title: d.subject || d.name || '', author: d.userfullname || '', text: text.slice(0, MAX_TEXT),
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
            text: plain_(a.intro).slice(0, MAX_TEXT), detected_dates: due,
            url: MOODLE_SITE + '/mod/assign/view.php?id=' + a.cmid,
          });
        }
      });
    });
  } catch (err) { errors.push('assignments: ' + err.message); }

  if (added) dedupeInbox_();
  const status = errors.length ? 'error: ' + errors.join(' | ')
    : 'ok · ' + added + ' new' + (viaDrive.length ? ' · via Drive copy · Moodle API: ' + viaDrive[0].slice(0, 300) : '');
  setSetting_('moodle_last_check', now_());
  setSetting_('moodle_status', status);
  return { status: status, added: added };
}

/* ------------------------------------------------------------- AI review ---- */
// Every Moodle message (announcement / assignment) is read in full by Gemini, which suggests tasks for the things
// Bahr actually has to do — but only when no existing task (or a suggestion from another message) already covers
// them; if a message changes an existing task (e.g. a new deadline) it suggests an update instead. The message
// itself is never a task. Suggestions are stored as JSON in moodle_inbox.ai_suggestions; nothing becomes a task
// until Bahr accepts it in the app. The Gemini API key lives in Script Properties (GEMINI_KEY) only.
//
// Built for the free tier (small quotas, busy models):
// - Up to AI_BATCH messages are read in ONE request, so a day of messages costs only a few requests.
// - Models are tried in order: settings.ai_model (if set), the newest Gemini Flash-Lite (the biggest free quota),
//   the newest Gemini Flash, then the "-latest" aliases.
// - A model that answers 429 (quota) or 5xx (overloaded) rests — until its daily quota resets (midnight Pacific
//   time) or for a few minutes — and the next model is tried. If every model is resting, the messages just wait
//   (ai_status "waiting · …"); a message is never marked as failed because Gemini was busy.
// - settings.ai_status = what happened last ('ok · …', 'waiting · <why> · <until> · <at>', 'error · <what> · <at>');
//   settings.ai_last_error = Gemini's own error text (shown under "פרטים" in the app).

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/';
const AI_BATCH = 6;             // messages per request
const AI_BATCH_CHARS = 20000;   // message text per request
const AI_TEXT_MAX = 12000;      // one message's text in the prompt
const AI_REST_BUSY_MIN = 15;    // minutes a model rests after "overloaded" / a broken answer

function gemini_(path, body, key) {
  key = key || PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) throw new Error('no Gemini key');
  const opts = { method: body ? 'post' : 'get', muteHttpExceptions: true, headers: { 'x-goog-api-key': key } };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch(GEMINI_API + path, opts);
  const code = res.getResponseCode();
  let j = {};
  try { j = JSON.parse(res.getContentText()); } catch (err) { j = {}; }
  if (code !== 200) {
    const er = j.error || {};
    const e = new Error('Gemini ' + code + ': ' + (er.message || res.getContentText().slice(0, 300)));
    e.code = code;
    e.quota = '';
    (er.details || []).forEach(function (d) {
      const type = String(d['@type'] || '');
      if (/RetryInfo$/.test(type) && d.retryDelay) e.retryMs = parseFloat(d.retryDelay) * 1000;
      if (/QuotaFailure$/.test(type)) {
        e.quota += (d.violations || []).map(function (v) { return (v.quotaId || '') + ' ' + (v.quotaMetric || ''); }).join(' ');
      }
    });
    e.daily = /PerDay/i.test(e.quota) || (!e.quota && /per day|daily/i.test(er.message || ''));
    e.keyProblem = code === 401 || code === 403 || (code === 400 && /API key|API_KEY/i.test(er.message || ''));
    throw e;
  }
  return j;
}

/** Models to try, best first. The list is read from the API (cached 3 days); settings.ai_model goes first. */
function aiModels_(key, refresh) {
  const props = PropertiesService.getScriptProperties();
  let list = [];
  try { list = JSON.parse(props.getProperty('GEMINI_MODELS') || '[]'); } catch (err) { list = []; }
  const at = Number(props.getProperty('GEMINI_MODELS_AT') || 0);
  if (refresh || !list.length || Date.now() - at > 3 * 86400000) {
    const names = (gemini_('models?pageSize=1000', null, key).models || [])
      .filter(function (m) { return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0; })
      .map(function (m) { return String(m.name || '').replace(/^models\//, ''); });
    const newest = function (re) {
      let best = '', bestV = null;
      names.forEach(function (n) {
        const r = re.exec(n);
        if (!r) return;
        const v = r[1].split('.').map(Number);
        if (!bestV || compareVersions_(v, bestV) > 0) { best = n; bestV = v; }
      });
      return best;
    };
    list = [newest(/^gemini-(\d+(?:\.\d+)*)-flash-lite$/), newest(/^gemini-(\d+(?:\.\d+)*)-flash$/)]
      .concat(['gemini-flash-lite-latest', 'gemini-flash-latest'].filter(function (a) { return names.indexOf(a) >= 0; }))
      .filter(Boolean);
    if (!list.length) throw new Error('no Gemini Flash model available for this key');
    props.setProperty('GEMINI_MODELS', JSON.stringify(list));
    props.setProperty('GEMINI_MODELS_AT', String(Date.now()));
  }
  const chosen = String(getSetting_('ai_model') || '').replace(/^models\//, '').trim();
  return (chosen ? [chosen] : []).concat(list.filter(function (m) { return m !== chosen; }));
}
function compareVersions_(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Which models are resting, and until when: Script Property AI_REST = {model: {until: ms, why}}.
function aiRest_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('AI_REST') || '{}'); } catch (err) { return {}; }
}
function setAiRest_(rest) { PropertiesService.getScriptProperties().setProperty('AI_REST', JSON.stringify(rest)); }
/** Gemini's daily quotas reset at midnight Pacific time (10:00 or 09:00 in Israel). */
function nextQuotaReset_() {
  const LA = 'America/Los_Angeles';
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), LA, 'yyyy-MM-dd');
  return Utilities.parseDate(tomorrow + ' 00:05', LA, 'yyyy-MM-dd HH:mm').getTime();
}

function setGeminiKey_(key) {
  const props = PropertiesService.getScriptProperties();
  if (!key) {
    props.deleteProperty('GEMINI_KEY');
    setSetting_('ai_status', 'not connected');
    return { connected: false };
  }
  const models = aiModels_(key, true); // throws if the key is wrong
  props.setProperty('GEMINI_KEY', key);
  props.deleteProperty('AI_REST');
  setSetting_('ai_status', 'connected · ' + models[0]);
  setSetting_('ai_last_error', '');
  return { connected: true, model: models[0] };
}

const AI_RESULT = {
  type: 'OBJECT',
  properties: {
    message_id: { type: 'STRING', description: 'The id of the message, copied exactly.' },
    summary: { type: 'STRING', description: 'What the message says, 1-2 short sentences in Hebrew.' },
    new_tasks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' }, due_date: { type: 'STRING' }, due_time: { type: 'STRING' },
          estimate_hours: { type: 'NUMBER' }, notes: { type: 'STRING' }, reason: { type: 'STRING' },
        },
        required: ['title', 'due_date', 'due_time', 'notes', 'reason'],
      },
    },
    updates: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          task_id: { type: 'STRING' }, due_date: { type: 'STRING' }, due_time: { type: 'STRING' },
          notes_to_add: { type: 'STRING' }, reason: { type: 'STRING' },
        },
        required: ['task_id', 'due_date', 'due_time', 'notes_to_add', 'reason'],
      },
    },
    covered: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { task_id: { type: 'STRING' }, what: { type: 'STRING' } },
        required: ['task_id', 'what'],
      },
    },
  },
  required: ['message_id', 'summary', 'new_tasks', 'updates', 'covered'],
};
const AI_SCHEMA = { type: 'OBJECT', properties: { results: { type: 'ARRAY', items: AI_RESULT } }, required: ['results'] };

function aiPrompt_(batch, courses, tasks, pending) {
  const kindHe = { announcement: 'הודעה בלוח ההודעות של הקורס', assignment: 'מטלה שפורסמה במודל עם תאריך הגשה' };
  const taskLines = tasks.map(function (t) {
    return '- id=' + t.id + ' | ' + t.title + ' | course=' + (t.course || '-') + ' | status=' + t.status +
      ' | due=' + (t.due_date ? t.due_date + (t.due_time ? ' ' + t.due_time : '') : '-') +
      (t.notes ? ' | notes=' + String(t.notes).replace(/\s+/g, ' ').slice(0, 160) : '');
  }).join('\n') || '(none)';
  const pendingLines = pending.map(function (p) { return '- ' + p; }).join('\n') || '(none)';
  const messages = batch.map(function (m) {
    const c = courses[m.course];
    return [
      '=== message_id: ' + m.id + ' ===',
      'Course: ' + (c ? c.name_he + ' (course=' + m.course + ')' : '(none)'),
      'Message type: ' + (kindHe[m.kind] || m.kind),
      'Message date: ' + (m.posted_at || '-'),
      'Author: ' + (m.author || '-'),
      'Title: ' + m.title,
      'Dates our parser saw in the text (may be wrong): ' + (m.detected_dates || '-'),
      'Message text:',
      '"""',
      String(m.text || '').slice(0, AI_TEXT_MAX),
      '"""',
    ].join('\n');
  }).join('\n\n');
  return [
    'You help Bahr, a Technion student, keep his task list complete. Below are ' + batch.length + ' message(s) from',
    'his course websites (Moodle). For EACH message separately, decide whether it requires him to DO something that',
    'is not already in his task list.',
    '',
    'Rules:',
    '1. A message itself is NOT a task. Most messages (greetings, general info, a cancelled class, office-hour',
    '   changes, reminders of things already listed) need no new task. Return an empty new_tasks list in that case.',
    '2. Suggest a new task only for a concrete action Bahr must take: submit/hand in something, register or sign up,',
    '   fill a form, prepare something specific before a given class, watch/read specific required material,',
    '   install/set up something required, an exam or quiz to prepare for, etc. One task per separate action.',
    '3. NEVER suggest something an existing task already covers, even if worded differently (compare meaning, course',
    '   and dates; "HW1", "תרגיל בית 1", "גיליון 1" can be the same thing). Done/cancelled tasks also count as covered.',
    '   List each such match in "covered" with the task id. Don\'t repeat anything in "already suggested", and don\'t',
    '   suggest the same thing twice across the messages below (suggest it once, from the message that says most).',
    '4. If a message changes something about an existing task (new/extended deadline, new time, extra',
    '   requirement), put it in "updates" with that task id instead of a new task. Leave due_date/due_time "" when',
    '   unchanged; notes_to_add = the new requirement in one short Hebrew line, or "".',
    '5. Titles: short Hebrew, like Bahr writes them (e.g. "תרגיל בית 2", "הרשמה לבוחן", "לצפות בהרצאה 3"), without the',
    '   course name. notes: the practical details from the message (what exactly, format, where to submit), Hebrew,',
    '   max 3 short lines. reason: one short Hebrew sentence quoting/pointing to the part of the message.',
    '6. Dates: due_date as yyyy-mm-dd, due_time as HH:MM (24h) or "" if no time. Resolve dates relative to the',
    '   message date; Israeli format is day.month (15.11 = 15 November). "" if the message gives no date.',
    '   estimate_hours: your rough guess of the work in hours, or 0 if you can\'t tell.',
    '7. summary: what the message says, 1-2 short Hebrew sentences.',
    '8. Return exactly one entry in "results" for every message, with its message_id copied exactly.',
    '',
    'Today: ' + fmt_(new Date(), 'yyyy-MM-dd (EEEE)'),
    '',
    'Bahr\'s existing tasks:',
    taskLines,
    '',
    'Already suggested from other messages (not yet accepted):',
    pendingLines,
    '',
    'Messages:',
    messages,
  ].join('\n');
}

function cleanDate_(s) { s = String(s || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }
function cleanTime_(s) { s = String(s || '').trim(); return /^\d{2}:\d{2}$/.test(s) ? s : ''; }
function parseSuggestions_(json) { try { const a = JSON.parse(json || '[]'); return Array.isArray(a) ? a : []; } catch (err) { return []; } }
function badAnswer_(text) { const e = new Error(text); e.badAnswer = true; return e; }

/** The fields to save for one message, from Gemini's result for it. seen: new-task keys already suggested in this run. */
function aiFields_(m, out, data, seen) {
  const byId = {};
  data.tasks.forEach(function (t) { byId[t.id] = t; });
  const sugg = [];
  (out.new_tasks || []).forEach(function (t) {
    const title = String(t.title || '').trim();
    if (!title) return;
    const due = cleanDate_(t.due_date);
    const k = (m.course || '') + '|' + title.replace(/\s+/g, ' ') + '|' + due;
    if (seen[k]) return; // the same task from another message in this batch
    seen[k] = true;
    sugg.push({ id: 'n' + sugg.length, type: 'new', state: 'open', title: title, course: m.course || '',
      due_date: due, due_time: cleanTime_(t.due_time),
      estimate_hours: Number(t.estimate_hours) > 0 ? Math.round(Number(t.estimate_hours) * 2) / 2 : '',
      notes: String(t.notes || '').trim(), reason: String(t.reason || '').trim() });
  });
  (out.updates || []).forEach(function (u) {
    const t = byId[u.task_id];
    if (!t) return;
    const due = cleanDate_(u.due_date), time = cleanTime_(u.due_time), add = String(u.notes_to_add || '').trim();
    if ((!due || due === t.due_date) && (!time || time === t.due_time) && !add) return; // nothing actually changes
    sugg.push({ id: 'u' + sugg.length, type: 'update', state: 'open', task_id: t.id, title: t.title,
      old_due: t.due_date + (t.due_time ? ' ' + t.due_time : ''), due_date: due, due_time: time, notes_to_add: add,
      reason: String(u.reason || '').trim() });
  });
  (out.covered || []).forEach(function (c) {
    const t = byId[c.task_id];
    if (t) sugg.push({ id: 'c' + sugg.length, type: 'covered', state: 'info', task_id: t.id, title: t.title, reason: String(c.what || '').trim() });
  });
  return { ai_status: 'done', ai_summary: String(out.summary || '').trim(), ai_suggestions: JSON.stringify(sugg), ai_checked_at: now_() };
}

/** Reads a batch of inbox rows with one Gemini request. Returns {messageId: fields} for the messages it answered. */
function aiReviewBatch_(batch, data, model) {
  const courses = {};
  data.courses.forEach(function (c) { courses[c.slug] = c; });
  const inBatch = {}, slugs = {};
  batch.forEach(function (m) { inBatch[m.id] = true; slugs[m.course || ''] = true; });
  const tasks = data.tasks.filter(function (t) { return slugs[''] || !t.course || slugs[t.course]; })
    .sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); }).slice(0, 150);
  const pending = [];
  data.moodle_inbox.forEach(function (o) {
    if (inBatch[o.id]) return;
    parseSuggestions_(o.ai_suggestions).forEach(function (sg) {
      if (sg.type === 'new' && sg.state === 'open') {
        pending.push(sg.title + (o.course ? ' | course=' + o.course : '') + (sg.due_date ? ' (' + sg.due_date + ')' : ''));
      }
    });
  });
  const res = gemini_('models/' + model + ':generateContent', {
    contents: [{ role: 'user', parts: [{ text: aiPrompt_(batch, courses, tasks, pending) }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: AI_SCHEMA },
  });
  const cand = (res.candidates || [])[0];
  const text = cand && cand.content && (cand.content.parts || []).map(function (p) { return p.text || ''; }).join('');
  const why = cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '';
  if (!text) throw badAnswer_('Gemini gave an empty answer' + why);
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { throw badAnswer_('Gemini\'s answer is not valid JSON' + why); }
  const results = (parsed && parsed.results) || [];
  const out = {}, seen = {};
  results.forEach(function (r, i) {
    let m = batch.filter(function (x) { return x.id === String(r.message_id || '').trim(); })[0];
    if (!m && batch.length === 1 && results.length === 1) m = batch[0];
    if (!m && results.length === batch.length) m = batch[i]; // ids garbled but one result per message, in order
    if (m && !out[m.id]) out[m.id] = aiFields_(m, r, data, seen);
  });
  if (!Object.keys(out).length) throw badAnswer_('Gemini answered without results for these messages');
  return out;
}

/**
 * Reviews inbox messages that haven't been reviewed yet, a batch per run (or one message again: opts.id).
 * Runs from the 10-minute trigger and from the app ("בדוק שוב", "בדוק במודל עכשיו").
 */
function aiReview_(opts) {
  opts = opts || {};
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) return { status: 'not connected', reviewed: 0 };
  const data = { tasks: readTable_('tasks'), courses: readTable_('courses'), moodle_inbox: readTable_('moodle_inbox') };
  const todo = data.moodle_inbox.filter(function (m) {
    if (opts.id) return m.id === opts.id;
    return m.status === 'new' && m.kind !== 'date_change' && (!m.ai_status || m.ai_status === 'pending');
  }).sort(function (a, b) { return String(a.posted_at).localeCompare(String(b.posted_at)); });
  if (!todo.length) {
    if (/^waiting/.test(getSetting_('ai_status'))) setSetting_('ai_status', 'ok · 0 reviewed · ' + now_());
    return { status: opts.id ? 'not found' : 'nothing to review', reviewed: 0 };
  }
  const batch = [];
  let chars = 0;
  for (let i = 0; i < todo.length; i++) {
    const len = Math.min(String(todo[i].text || '').length, AI_TEXT_MAX) + 400;
    if (batch.length && (batch.length >= AI_BATCH || chars + len > AI_BATCH_CHARS)) break;
    batch.push(todo[i]);
    chars += len;
  }

  let models;
  try { models = aiModels_(key); } catch (err) { return aiFailed_(err); }
  const rest = aiRest_(), now = Date.now();
  let out = null, used = '', lastErr = null;
  for (let i = 0; i < models.length && !out; i++) {
    const model = models[i], r = rest[model];
    // "בדוק שוב" from the app may try a model that is only resting for a few minutes
    if (r && r.until > now && !(opts.id && r.why !== 'quota-day')) continue;
    try {
      out = aiReviewBatch_(batch, data, model);
      used = model;
      delete rest[model];
    } catch (err) {
      lastErr = err;
      if (err.code === 429) {
        rest[model] = err.daily ? { until: nextQuotaReset_(), why: 'quota-day' }
          : { until: now + Math.max(60000, err.retryMs || 0), why: 'quota-minute' };
      } else if (err.code >= 500 || err.badAnswer) {
        rest[model] = { until: now + AI_REST_BUSY_MIN * 60000, why: 'busy' };
      } else if (err.code === 404) { // model retired: rest it and read the model list again next time
        rest[model] = { until: now + 86400000, why: 'gone' };
        PropertiesService.getScriptProperties().deleteProperty('GEMINI_MODELS');
      } else break; // the key or the request itself is the problem: another model won't help
    }
  }
  Object.keys(rest).forEach(function (m) { if (rest[m].until < now) delete rest[m]; });
  setAiRest_(rest);

  if (out) {
    let reviewed = 0;
    withLock_(function () {
      batch.forEach(function (m) {
        if (!out[m.id]) return;
        upsert_('moodle_inbox', Object.assign({ id: m.id }, out[m.id]), { touch: false });
        reviewed++;
      });
    });
    const status = 'ok · ' + reviewed + ' reviewed · ' + now_() + ' · ' + used;
    setSetting_('ai_status', status);
    setSetting_('ai_last_error', '');
    return { status: status, reviewed: reviewed, waiting: todo.length - reviewed };
  }
  if (lastErr && !(lastErr.code === 429 || lastErr.code >= 500 || lastErr.code === 404 || lastErr.badAnswer)) {
    return aiFailed_(lastErr);
  }
  // every model is resting: the messages wait for the soonest one
  let next = Infinity, why = 'busy';
  models.forEach(function (m) { if (rest[m] && rest[m].until < next) { next = rest[m].until; why = rest[m].why; } });
  if (next === Infinity) { next = now + AI_REST_BUSY_MIN * 60000; why = 'busy'; }
  const status = 'waiting · ' + why + ' · ' + fmt_(new Date(next)) + ' · ' + now_();
  setSetting_('ai_status', status);
  if (lastErr) setSetting_('ai_last_error', lastErr.message.slice(0, 1500));
  return { status: status, reviewed: 0, waiting: todo.length };
}

function aiFailed_(err) {
  const what = err.keyProblem ? 'key' : /no Gemini Flash model/.test(err.message) ? 'no-model' : 'request';
  const status = 'error · ' + what + ' · ' + now_();
  setSetting_('ai_status', status);
  setSetting_('ai_last_error', String(err.message || err).slice(0, 1500));
  return { status: status, reviewed: 0 };
}

/** Diagnostics — run from the Apps Script editor: shows the models, which are resting, and reviews the newest message. */
function debugAi() {
  const log = function (label, v) { Logger.log(label + ': ' + JSON.stringify(v).slice(0, 3000)); };
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) { log('no Gemini key', 'add it in the app: ⚙️ → AI'); return; }
  try { log('models (in order)', aiModels_(key, true)); } catch (err) { log('models FAILED', err.message); return; }
  log('resting', aiRest_());
  const last = readTable_('moodle_inbox').filter(function (m) { return m.kind !== 'date_change'; })
    .sort(function (a, b) { return String(b.posted_at).localeCompare(String(a.posted_at)); })[0];
  if (!last) { log('inbox empty', ''); return; }
  log('reviewing', last.title);
  log('result', aiReview_({ id: last.id }));
  log('suggestions', parseSuggestions_(readTable_('moodle_inbox').filter(function (m) { return m.id === last.id; })[0].ai_suggestions));
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
    } catch (err) { setSetting_('calendar_status', 'error · ' + now_() + ' · ' + err.message); }
    try {
      const every = Number(getSetting_('moodle_check_minutes')) || 15;
      const last = getSetting_('moodle_last_check');
      if (!last || Date.now() - toDate_(last).getTime() >= (every - 1) * 60000) moodleCheck_();
    } catch (err) { setSetting_('moodle_status', 'error: ' + err.message); }
  } finally { lock.releaseLock(); }
  // AI review runs outside the lock (Gemini can take a few seconds per message; the app must stay writable)
  try { aiReview_({}); } catch (err) { aiFailed_(err); }
}

/**
 * Diagnostics — run from the Apps Script editor (choose debugMoodle → Run) and look at the Execution log.
 * Prints what Moodle answers for each step of the check. Never prints the token.
 */
function debugMoodle() {
  const log = function (label, v) { Logger.log(label + ': ' + JSON.stringify(v).slice(0, 1500)); };
  try {
    const info = moodle_('core_webservice_get_site_info', {});
    const fns = (info.functions || []).map(function (f) { return f.name; });
    log('site', { user: info.fullname, release: info.release, version: info.version });
    log('functions available', ['mod_forum_get_forums_by_courses', 'mod_forum_get_forum_discussions',
      'mod_forum_get_forum_discussions_paginated', 'mod_assign_get_assignments', 'core_course_get_contents']
      .map(function (n) { return n + '=' + (fns.indexOf(n) >= 0); }));
  } catch (err) { log('site info FAILED', err.message); return; }
  const courses = readTable_('courses');
  const fp = {};
  courses.forEach(function (c, i) { if (c.moodle_course_id) fp['courseids[' + i + ']'] = c.moodle_course_id; });
  let forums = [];
  try {
    forums = moodle_('mod_forum_get_forums_by_courses', fp) || [];
    log('forums', forums.map(function (f) { return { id: f.id, cmid: f.cmid, course: f.course, type: f.type, name: f.name }; }));
  } catch (err) { log('forums FAILED', err.message); }
  const news = forums.filter(function (f) { return f.type === 'news'; })[0];
  if (!news) { log('no news forum found', ''); return; }
  try {
    PropertiesService.getScriptProperties().deleteProperty('MOODLE_FORUM_VARIANT2');
    const r = forumDiscussions_(news.id, 5);
    log('discussions OK (variant ' + PropertiesService.getScriptProperties().getProperty('MOODLE_FORUM_VARIANT2') + ')',
      (r.discussions || []).map(function (d) { return { id: d.id, discussion: d.discussion, subject: d.subject, created: d.created }; }));
  } catch (err) { log('discussions FAILED', err.message); }
  try {
    const c = courses.filter(function (x) { return x.slug === 'databases'; })[0] || courses[0];
    log('Drive copy (' + c.slug + ')', driveAnnouncements_(c).map(function (p) { return p.posted + ' ' + p.title; }));
  } catch (err) { log('Drive copy FAILED', err.message); }
  try {
    const r = moodleCheck_();
    log('full check', r);
  } catch (err) { log('full check FAILED', err.message); }
}
