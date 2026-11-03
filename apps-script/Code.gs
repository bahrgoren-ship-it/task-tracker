/**
 * Task tracker — backend (Google Apps Script, bound to the Sheet "מעקב שיעורי בית").
 *
 * What it does: a small JSON API over the Sheet, used by the app (docs/ folder of this repo).
 * Every request must carry the secret key stored in Script Properties (API_KEY).
 *
 * Setup (once): run setup() from the Apps Script editor, copy the key from the log,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Full steps: SETUP.md in the repo.
 *
 * Schema of every tab: SCHEMA.md in the repo (also in Technion Studies/.ai/homework-tracker/).
 */

const SHEET_ID = '10qLYln2zUiMo7dEI3xZ8pj4ncGX7TRmATZNuZfvUfWM';
const TZ = 'Asia/Jerusalem';
const API_VERSION = 2;
const SCHEMA_VERSION = 2; // bump when SCHEMA changes; the Sheet is migrated automatically

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
  ['sync_deadlines_to_calendar', 'FALSE', "TRUE = every task deadline appears in the 'שיעורי בית – הגשות' calendar."],
  ['sync_blocks_to_calendar', 'FALSE', "TRUE = confirmed work blocks are sent to the 'שיעורי בית – בלוקי עבודה' calendar."],
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
  ops.forEach(function (o) {
    if (WRITABLE.indexOf(o.table) < 0) throw new Error('table not writable: ' + o.table);
    if (o.op === 'upsert') {
      const row = upsert_(o.table, o.row || {});
      if (o.table === 'sessions') touched[row.task_id] = true;
      results.push({ table: o.table, row: row });
    } else if (o.op === 'delete') {
      if (DELETABLE.indexOf(o.table) < 0) throw new Error('rows of ' + o.table + ' cannot be deleted');
      const old = deleteRow_(o.table, o.id);
      if (o.table === 'sessions' && old) touched[old.task_id] = true;
      if (o.table === 'tasks') { deleteWhere_('blocks', 'task_id', o.id); deleteWhere_('sessions', 'task_id', o.id); }
      results.push({ table: o.table, deleted: o.id });
    } else throw new Error('unknown op: ' + o.op);
  });
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

function upsert_(table, patch) {
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
  if (cols.indexOf('updated_at') >= 0) merged.updated_at = now_();
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
  const sh = sheet_(table);
  const last = sh.getLastRow();
  if (last < 2) return;
  const idx = SCHEMA[table].indexOf(col);
  const vals = sh.getRange(2, idx + 1, last - 1, 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) if (String(vals[i][0]) === String(value)) sh.deleteRow(i + 2);
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
