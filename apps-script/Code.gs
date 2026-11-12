/**
 * Task tracker — backend (Google Apps Script, bound to the Sheet "מעקב שיעורי בית").
 *
 * What it does: a small JSON API over the Sheet, used by the app (docs/ folder of this repo).
 * Every request must carry the secret key stored in Script Properties (API_KEY).
 * Also: Google Calendar sync (confirmed work blocks, two-way, each into its category's calendar: courses → 'לימודים',
 * other categories → 'Bahr Goren' unless a category picks its own; changes made in Google Calendar come back within
 * about a minute through calendar triggers; optional deadlines),
 * a Moodle check (announcements + assignments → moodle_inbox), run every 10 minutes by a trigger that setup()
 * installs, and an AI review (Gemini, built for the free tier) of new Moodle messages that suggests tasks only
 * when no existing task already covers them.
 * Categories: every task may belong to a category (tab 'courses': a course is one kind of category), and every
 * category belongs to a meta category (tab 'groups': a semester, a project, general tasks). Bahr adds, edits and
 * archives both in the app; an archived one is hidden there with its tasks (nothing is deleted) and its courses are
 * no longer checked on Moodle.
 *
 * Setup (once): run setup() from the Apps Script editor, copy the key from the log,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Full steps: SETUP.md in the repo.
 *
 * Schema of every tab: SCHEMA.md in the repo (also in Technion Studies/.ai/homework-tracker/).
 */

const SHEET_ID = '10qLYln2zUiMo7dEI3xZ8pj4ncGX7TRmATZNuZfvUfWM';
const TZ = 'Asia/Jerusalem';
const API_VERSION = 9; // 5: calendars action, chosen blocks calendar, batch returns fresh rows · 6: suggestions tab
// · 7: categories and meta categories (tabs courses + groups) written by the app, archive
// · 8: a Google Calendar per category (courses.calendar; defaults: courses / everything else), blocks.calendar_id
// · 9: changes made in Google Calendar come back within about a minute (calendar triggers; bootstrap {pull: 1})
const SCHEMA_VERSION = 9; // bump when SCHEMA / settings change; the Sheet is migrated automatically

// Column order of each tab. Must match row 1 of the Sheet (see SCHEMA.md).
const SCHEMA = {
  tasks: ['id', 'title', 'course', 'status', 'due_date', 'due_time', 'estimate_hours', 'spent_hours', 'notes',
    'links', 'source', 'moodle_ref', 'calendar_event_id', 'created_at', 'updated_at'],
  sessions: ['id', 'task_id', 'start', 'end', 'minutes', 'kind', 'note', 'updated_at'],
  // calendar_id = the Google Calendar that holds the block's event now (app-managed)
  blocks: ['id', 'task_id', 'start', 'end', 'state', 'sync_calendar', 'calendar_event_id', 'note', 'updated_at', 'calendar_id'],
  // categories (a course is one kind of category). active = FALSE: archived. group = a groups.id
  // calendar = the Google Calendar for its work blocks (empty = the default for courses / for other categories)
  courses: ['slug', 'name_he', 'short_he', 'number', 'moodle_course_id', 'moodle_news_forum_id', 'color',
    'active', 'moodle_folder', 'group', 'sort', 'archived_at', 'calendar'],
  // meta categories: a semester, a project, general tasks… Archiving one hides all of its categories and their tasks
  groups: ['id', 'name', 'kind', 'active', 'sort', 'archived_at', 'created_at', 'updated_at'],
  moodle_inbox: ['id', 'course', 'kind', 'moodle_ref', 'posted_at', 'title', 'author', 'text', 'detected_dates',
    'url', 'status', 'task_id', 'ai_status', 'ai_summary', 'ai_suggestions', 'ai_checked_at'],
  settings: ['key', 'value', 'meaning'],
  // changes proposed by any AI with access to the Sheet; nothing happens until Bahr approves one in the app
  suggestions: ['id', 'status', 'summary', 'table', 'op', 'row_id', 'fields', 'reason', 'by', 'created_at', 'decided_at', 'result'],
};
const KEY_COLUMN = { tasks: 'id', sessions: 'id', blocks: 'id', courses: 'slug', groups: 'id', moodle_inbox: 'id', settings: 'key', suggestions: 'id' };
const ID_PREFIX = { tasks: 't', sessions: 's', blocks: 'b', courses: 'c', groups: 'g', moodle_inbox: 'm', suggestions: 'sg' };
// a new tab is placed right after this one (default: at the end)
const TAB_AFTER = { groups: 'courses' };
// The first meta category: in schema 7 the courses that already exist go into it (see groupCourses_).
const FIRST_GROUP = { id: 'winter-2026-2027', name: 'סמסטר חורף תשפ״ז', kind: 'semester' };
// Columns removed in a later schema version (dropped by migrate_).
const DROPPED = { tasks: ['grade'] };
// Default settings rows: [key, value, meaning]. Missing keys are added by migrate_.
const DEFAULT_SETTINGS = [
  ['sync_deadlines_to_calendar', 'FALSE', "TRUE = every task deadline appears in the Google Calendar 'משימות – הגשות'."],
  ['sync_blocks_to_calendar', 'TRUE', "TRUE = confirmed work blocks (after 'אשר תכנון') appear in Google Calendar, each in its category's calendar: courses.calendar, else blocks_calendar_name (courses) / other_blocks_calendar_name (everything else). Two-way, within about a minute: moving, resizing or deleting the event there, editing its description (= the block's note) or moving it to another calendar changes the block."],
  ['blocks_calendar_name', 'לימודים', "Google Calendar for the work blocks of courses (categories in a semester) that have no calendar of their own (courses.calendar). Empty = a separate calendar 'משימות – בלוקי עבודה'."],
  ['other_blocks_calendar_name', 'Bahr Goren', "Google Calendar for the work blocks of every other category, and of tasks without a category, when the category has no calendar of its own (courses.calendar). Empty = a separate calendar 'משימות – בלוקי עבודה'."],
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
  ['blocks_calendar_id', '', 'Old (before schema 8): the one calendar that held all work-block events. Each block now keeps its own (blocks.calendar_id); this is only a fallback for blocks without it.'],
  ['calendar_last_sync', '', 'App-managed: last full calendar sync (rows changed after it are pushed next time).'],
  ['calendar_status', '', "App-managed: result of the last calendar sync ('ok · time' or 'error · time · what')."],
  ['calendar_watch', '', "App-managed: calendars watched for changes made in Google Calendar ('ok · N calendars · time' or 'error · time · what')."],
  ['moodle_last_check', '', 'App-managed: last time Moodle was checked.'],
  ['moodle_status', '', "App-managed: result of the last Moodle check ('ok …' or the error)."],
  ['ai_model', '', "Gemini model to try first for the AI review. Empty = automatic: the newest Flash-Lite (biggest free quota), then the newest Flash."],
  ['ai_status', '', "App-managed: AI review — 'ok · …', 'waiting · why · until · at' (quota / busy) or 'error · what · at'."],
  ['ai_last_error', '', "App-managed: Gemini's own text for the last problem (shown under 'פרטים' in the app)."],
  ['schema_version', String(SCHEMA_VERSION), 'Bumped when columns change (see SCHEMA.md).'],
];
// Tables the app may write to, and which may have rows deleted. A category or meta category is deleted only while
// nothing uses it (see inUse_); otherwise it is archived (active = FALSE), never deleted.
const WRITABLE = ['tasks', 'sessions', 'blocks', 'courses', 'groups', 'moodle_inbox', 'settings', 'suggestions'];
const DELETABLE = ['tasks', 'sessions', 'blocks', 'courses', 'groups'];
// A row must have these to be created. A change to a row that no longer exists (deleted on another device, merged
// as a duplicate…) without them is dropped instead of creating half a row.
const REQUIRED = { tasks: ['title'], sessions: ['task_id', 'start'], blocks: ['task_id', 'start', 'end'],
  courses: ['name_he'], groups: ['name'], moodle_inbox: ['moodle_ref'], suggestions: ['op'] };
// How Date cells (if someone typed a real date into the Sheet) are turned back into text.
const DATE_FORMAT = { due_date: 'yyyy-MM-dd', due_time: 'HH:mm', posted_at: 'yyyy-MM-dd HH:mm',
  start: 'yyyy-MM-dd HH:mm', end: 'yyyy-MM-dd HH:mm', created_at: 'yyyy-MM-dd HH:mm',
  updated_at: 'yyyy-MM-dd HH:mm', ai_checked_at: 'yyyy-MM-dd HH:mm', archived_at: 'yyyy-MM-dd' };

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
  try { withLock_(watchCalendars_); } catch (err) { Logger.log('calendar watch: ' + err.message); } // instant pull-back
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
    if (req.action !== 'ping' && schemaBehind_()) withLock_(migrate_); // first request after a new version
    switch (req.action) {
      case 'ping':
        return json_({ ok: true, data: { api_version: API_VERSION, now: now_() } });
      case 'bootstrap':
        if (suggestionsWithoutId_()) withLock_(fillSuggestionIds_);
        if (req.pull) pullNow_(); // the app opened / came back: bring in changes made in Google Calendar first
        return json_({ ok: true, data: bootstrap_() });
      case 'batch':
        return json_({ ok: true, data: withLock_(function () { return batch_(req.ops || []); }) });
      case 'busy': // events from Bahr's own calendars between two dates (for the planner)
        return json_({ ok: true, data: busy_(String(req.from), String(req.to)) });
      case 'calendars': // Bahr's own calendars, to choose where work blocks go
        return json_({ ok: true, data: calendars_() });
      case 'syncNow':
        return json_({ ok: true, data: withLock_(function () { return { calendar: syncCalendars_(true, false) }; }) });
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
  // what the calendar sync must look at. relocate = blocks whose calendar may have changed (moved there if so)
  const cal = { tasks: {}, blocks: {}, relocate: {}, dead: [], full: false };
  // tasks / categories whose work blocks may now belong in another calendar (their blocks are synced again)
  const moved = { tasks: {}, cats: {} };
  const has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  let paint = false; // a category changed: refresh the colour swatches in the courses tab
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
      if (o.table === 'tasks' && has(patch, 'course')) moved.tasks[row.id] = true;
      if (o.table === 'blocks') cal.blocks[row.id] = true;
      if (o.table === 'courses') paint = true;
      if (o.table === 'courses' && (has(patch, 'calendar') || has(patch, 'group'))) moved.cats[row.slug] = true;
      if (o.table === 'groups' && has(patch, 'kind')) { // semester ↔ other: the default calendar of its categories changes
        readTable_('courses').forEach(function (c) { if (c.group === row.id) moved.cats[c.slug] = true; });
      }
      if (o.table === 'settings' && /^(sync_.*_to_calendar|(other_)?blocks_calendar_name)$/.test(row.key)) cal.full = true;
      results.push({ table: o.table, row: row });
    } else if (o.op === 'delete') {
      if (DELETABLE.indexOf(o.table) < 0) throw new Error('rows of ' + o.table + ' cannot be deleted');
      if (inUse_(o.table, o.id)) { // a category with tasks / a meta category with categories: keep it, send it back
        const kept = rowById_(o.table, o.id);
        results.push(kept ? { table: o.table, row: kept } : { table: o.table, deleted: o.id });
        return;
      }
      const old = deleteRow_(o.table, o.id);
      if (o.table === 'sessions' && old) touched[old.task_id] = true;
      if (old && old.calendar_event_id) cal.dead.push({ table: o.table, id: old.calendar_event_id, cal: old.calendar_id || '' });
      if (o.table === 'tasks') {
        deleteWhere_('blocks', 'task_id', o.id).forEach(function (b) {
          if (b.calendar_event_id) cal.dead.push({ table: 'blocks', id: b.calendar_event_id, cal: b.calendar_id || '' });
        });
        deleteWhere_('sessions', 'task_id', o.id);
      }
      results.push({ table: o.table, deleted: o.id });
    } else throw new Error('unknown op: ' + o.op);
  });
  if (!cal.full && (Object.keys(moved.tasks).length || Object.keys(moved.cats).length)) {
    const catOf = {};
    readTable_('tasks').forEach(function (t) { catOf[t.id] = t.course; });
    readTable_('blocks').forEach(function (b) {
      if (moved.tasks[b.task_id] || moved.cats[catOf[b.task_id]]) cal.blocks[b.id] = cal.relocate[b.id] = true;
    });
  }
  try { // calendar problems must never block saving the data
    if (cal.full) syncCalendars_(true, true); // a calendar setting changed: every block to where it belongs now
    else syncSome_(cal);
  } catch (err) { setSetting_('calendar_status', 'error · ' + now_() + ' · ' + err.message); }
  if (cal.full || Object.keys(moved.cats).length) watchCalendars_(); // a calendar may have joined / left (never throws)
  // send back the rows as they are now (the calendar sync fills calendar_event_id), so the app shows it at once
  [['tasks', cal.tasks], ['blocks', cal.blocks]].forEach(function (p) {
    if (!Object.keys(p[1]).length) return;
    readTable_(p[0]).forEach(function (r) { if (p[1][r.id]) results.push({ table: p[0], row: r }); });
  });
  Object.keys(touched).forEach(function (id) {
    const row = id ? recomputeSpent_(id) : null;
    if (row) results.push({ table: 'tasks', row: row });
  });
  if (paint) { try { paintCourseColors_(sheet_('courses')); } catch (err) { /* only the look of the Sheet */ } }
  return { results: results, now: now_() };
}

function rowExists_(table, id) {
  return findRow_(sheet_(table), SCHEMA[table].indexOf(KEY_COLUMN[table]), id) > 0;
}

/** One row as an object, or null. */
function rowById_(table, id) {
  const cols = SCHEMA[table];
  const sh = sheet_(table);
  const rowNum = findRow_(sh, cols.indexOf(KEY_COLUMN[table]), id);
  if (rowNum < 0) return null;
  const vals = sh.getRange(rowNum, 1, 1, cols.length).getValues()[0];
  const out = {};
  cols.forEach(function (c, i) { out[c] = cellToString_(c, vals[i]); });
  return out;
}

/** A category that tasks or Moodle messages point to, or a meta category that still has categories, is never deleted. */
function inUse_(table, id) {
  if (!id) return false;
  if (table === 'courses') {
    return readTable_('tasks').some(function (t) { return t.course === id; }) ||
      readTable_('moodle_inbox').some(function (m) { return m.course === id; });
  }
  if (table === 'groups') return readTable_('courses').some(function (c) { return c.group === id; });
  return false;
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

/** Brings the Sheet up to this code's schema first (the first request / run after a new version is deployed). */
function schemaBehind_() { return Number(getSetting_('schema_version') || 1) < SCHEMA_VERSION; }

/* ------------------------------------------------- categories & archive ---- */
// A category is a row of 'courses' (a course is a category with Moodle details); a meta category is a row of
// 'groups'. Archived = active FALSE on either one. Archived things stay in the Sheet; the app hides them (and their
// tasks) and the Moodle check / AI review skip them.

/** Like readTable_, but [] while the tab doesn't exist yet (before the migration ran). */
function readTableIfAny_(table) {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(table) ? readTable_(table) : [];
}

/** Slugs of the categories that are archived, or sit in an archived meta category: {slug: true}. */
function archivedSlugs_() {
  const offGroup = {};
  readTableIfAny_('groups').forEach(function (g) { if (g.active === 'FALSE') offGroup[g.id] = true; });
  const out = {};
  readTable_('courses').forEach(function (c) { if (c.active === 'FALSE' || offGroup[c.group]) out[c.slug] = true; });
  return out;
}

/** The courses the Moodle check reads: not archived, and with a Moodle course id (other categories have none). */
function moodleCourses_() {
  const archived = archivedSlugs_();
  return readTable_('courses').filter(function (c) {
    return !archived[c.slug] && String(c.moodle_course_id || '').trim() !== '';
  });
}

/**
 * Schema 7: every category belongs to a meta category. The first time (no meta categories yet), the courses that
 * already exist go into FIRST_GROUP, in their current order. Safe to run again: it only fills what is empty.
 */
function groupCourses_() {
  const courses = readTable_('courses');
  if (readTable_('groups').length || !courses.length) return 0;
  upsert_('groups', { id: FIRST_GROUP.id, name: FIRST_GROUP.name, kind: FIRST_GROUP.kind, active: 'TRUE', sort: '1' });
  let n = 0;
  courses.forEach(function (c, i) {
    if (c.group) return;
    upsert_('courses', { slug: c.slug, group: FIRST_GROUP.id, sort: c.sort || String(i + 1) });
    n++;
  });
  return n;
}

/** The colour cell of each category shows its colour (as the Sheet was built). */
function paintCourseColors_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return;
  const col = SCHEMA.courses.indexOf('color') + 1;
  const range = sh.getRange(2, col, last - 1, 1);
  const vals = range.getValues();
  const ok = function (v) { return /^#[0-9a-fA-F]{6}$/.test(String(v || '').trim()); };
  range.setBackgrounds(vals.map(function (r) { return [ok(r[0]) ? String(r[0]).trim() : null]; }));
  range.setFontColors(vals.map(function (r) { return [ok(r[0]) ? '#FFFFFF' : null]; }));
}

/* -------------------------------------------------------------- migration ---- */

/**
 * Makes every tab match SCHEMA: creates missing tabs, puts columns in SCHEMA order (by header name),
 * drops columns listed in DROPPED, adds missing settings, recomputes task totals. Keeps all data.
 */
function migrate_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  Object.keys(SCHEMA).forEach(function (table) { // missing tabs first (dropdowns may point to them)
    if (ss.getSheetByName(table)) return;
    const after = TAB_AFTER[table] && ss.getSheetByName(TAB_AFTER[table]);
    if (after) ss.insertSheet(table, after.getIndex()); else ss.insertSheet(table);
  });
  Object.keys(SCHEMA).forEach(function (table) {
    const cols = SCHEMA[table];
    const sh = ss.getSheetByName(table);
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
  // schema 8: Bahr asked for the blocks of every category that isn't a course to go to his calendar 'Bahr Goren'
  if (existing.indexOf('other_blocks_calendar_name') < 0) setSetting_('other_blocks_calendar_name', otherCalendarDefault_());
  const grouped = groupCourses_(); // schema 7: the existing courses go into their semester
  paintCourseColors_(sheet_('courses'));
  upsert_('settings', { key: 'schema_version', value: String(SCHEMA_VERSION) });
  readTable_('tasks').forEach(function (t) { recomputeSpent_(t.id); });
  writeAiHelp_();
  const fixed = cleanup_();
  fixed.grouped = grouped;
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
  'How to suggest a change to Bahr\'s tasks or categories (for any AI that can edit this Sheet)',
  '',
  'Add ONE ROW to the tab "suggestions" for each change. Bahr sees it in the app and approves or rejects it. Never edit the',
  'tasks / blocks / sessions / courses / groups tabs directly. Leave id, status, created_at, decided_at, result empty (filled automatically).',
  '',
  'Columns:',
  '  summary  – what the change is, short Hebrew, written to Bahr (male), e.g. "להוסיף משימה: תרגיל בית 3 בסטטיסטיקה, הגשה ב-20.11"',
  '  table    – tasks | blocks | sessions | courses | groups',
  '             (tasks = the task list; blocks = planned work time in the planner; sessions = time already worked;',
  '              courses = categories, e.g. a course or "בית"; groups = meta categories, e.g. a semester, a project, "משימות יומיות")',
  '  op       – create | update | delete',
  '  row_id   – for update / delete: the id of the existing row (e.g. t_ab12cd; for courses: the slug). Empty for create.',
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
  '  courses:  name_he, short_he (short label), group (an id from the groups tab), color (#RRGGBB), number, moodle_course_id,',
  '            moodle_folder (path under Technion Studies), active (TRUE | FALSE = archived),',
  '            calendar (a Google Calendar name for its work blocks; empty = the default from settings:',
  '            blocks_calendar_name for courses, other_blocks_calendar_name for every other category).',
  '            create needs name_he and group, and may include slug (lowercase English, e.g. "statistics-2").',
  '  groups:   name, kind (semester | project | general), active (TRUE | FALSE = archived).',
  '            A new project / general group starts with one category of the same name, so tasks can go into it.',
  '',
  'Archive = update with {"active":"FALSE"}; restore = {"active":"TRUE"}. An archived category or group is hidden in the app',
  'together with its tasks (nothing is deleted) and its courses are no longer checked on Moodle. delete works only for a',
  'category nothing uses (no tasks, no Moodle messages) or a group without categories.',
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
  '  courses create {"name_he":"סטטיסטיקה 2","short_he":"סטטיסטיקה 2","group":"spring-2027","slug":"statistics-2"}',
  '  groups update  row_id winter-2026-2027   {"active":"FALSE"}',
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
  // a dropdown that also accepts other values (e.g. TRUE typed by hand, which Sheets turns into a checkbox value)
  const hintList = function (name, values) {
    sh.getRange(2, col(name), rows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build());
  };
  // a dropdown of the ids in another tab
  const idsOf = function (name, tab) {
    const other = SpreadsheetApp.openById(SHEET_ID).getSheetByName(tab);
    if (other) sh.getRange(2, col(name), rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInRange(other.getRange('A2:A200'), true).setAllowInvalid(true).build());
  };
  if (table === 'tasks') {
    list('status', ['todo', 'in_progress', 'done', 'cancelled']);
    list('source', ['manual', 'moodle', 'class', 'notion', 'ai']);
    idsOf('course', 'courses');
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
  if (table === 'courses') { hintList('active', ['TRUE', 'FALSE']); idsOf('group', 'groups'); }
  if (table === 'groups') { hintList('kind', ['semester', 'project', 'general']); hintList('active', ['TRUE', 'FALSE']); }
  if (table === 'moodle_inbox') list('status', ['new', 'accepted', 'ignored']);
  if (table === 'suggestions') {
    // hints only (invalid values allowed): an AI that writes "add" instead of "create" still works
    const hint = function (name, values) {
      sh.getRange(2, col(name), rows, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build());
    };
    hint('status', ['pending', 'approved', 'rejected']);
    hint('table', ['tasks', 'blocks', 'sessions', 'courses', 'groups']);
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
// Confirmed work blocks ("אשר תכנון") go to one of Bahr's own Google calendars, chosen per category:
// - the category's own calendar (courses.calendar, a calendar name), when it has one;
// - otherwise the default for its kind: a course (a category in a semester meta category) → settings.blocks_calendar_name
//   ('לימודים'); every other category, and a task without a category → settings.other_blocks_calendar_name ('Bahr Goren').
//   An empty default = a separate calendar the app creates, 'משימות – בלוקי עבודה'.
// Each block remembers the calendar that holds its event (blocks.calendar_id). An event stays in that calendar until the
// calendar the block belongs in changes (the category's calendar, a default, the task's category): then it is deleted
// there and created again in the new one. An event Bahr moves to another calendar himself stays there.
// Two-way: what Bahr changes in Google Calendar comes back to the block — times (moved / resized), the description (=
// the block's note), the calendar, and deleting the event deletes the block. The event's title comes from the task.
// It comes back within about a minute: every calendar that holds blocks has a calendar trigger (watchCalendars_ →
// onCalendarChange), the app asks for a pull when it opens (bootstrap {pull: 1}), and the 10-minute run pulls too.
// Task deadlines can go (one-way) to the app's calendar 'משימות – הגשות'.

const CAL = {
  deadlines: { name: 'משימות – הגשות', setting: 'deadline_calendar_id', color: 'RED', toggle: 'sync_deadlines_to_calendar' },
  blocks: { name: 'משימות – בלוקי עבודה', toggle: 'sync_blocks_to_calendar', courses: 'blocks_calendar_name',
    other: 'other_blocks_calendar_name', legacy: 'blocks_calendar_id' },
};
const APP_URL = 'https://bahrgoren-ship-it.github.io/task-tracker/';
const BLOCK_MARK = 'בלוק עבודה ממעקב המשימות'; // start of the app's footer in an event's description
const WATCH_FN = 'onCalendarChange'; // the calendar triggers' function
const PULL_DAYS = { back: 45, ahead: 180 }; // blocks pulled from Google Calendar: starting in this window

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
 * A calendar by name (Bahr's own first; names are not case-sensitive) or by id. '' or the app's own name → the app's
 * calendar 'משימות – בלוקי עבודה' (created when missing, unless noCreate). Throws 'calendar not found: <name>'.
 */
function findCalendar_(name, noCreate) {
  name = String(name || '').trim();
  if (!name || name === CAL.blocks.name) {
    const own = CalendarApp.getOwnedCalendarsByName(CAL.blocks.name)[0];
    if (own || noCreate) { if (!own) throw new Error('calendar not found: ' + CAL.blocks.name); return own; }
    return CalendarApp.createCalendar(CAL.blocks.name, { color: CalendarApp.Color.BLUE, timeZone: TZ });
  }
  const cal = CalendarApp.getOwnedCalendarsByName(name)[0] || CalendarApp.getCalendarsByName(name)[0] ||
    (name.indexOf('@') > 0 ? calendarById_(name) : null);
  if (!cal) throw new Error('calendar not found: ' + name);
  return cal;
}

/** The calendar name for a category's work blocks: its own, else the default for courses / for everything else. */
function calendarNameFor_(course, groups, defaults) {
  const own = course && String(course.calendar || '').trim();
  if (own) return own;
  const g = course && groups[course.group];
  return String((g && g.kind === 'semester' ? defaults.courses : defaults.other) || '').trim();
}

/**
 * Per-run helper for work-block calendars: the calendar each block belongs in, and the one holding its event now.
 * Calendars are looked up once per run. A chosen calendar that doesn't exist is noted in problems (not thrown), so one
 * category with a wrong calendar doesn't stop the others.
 */
function blockCals_(tasks, courses, groups) {
  const defaults = { courses: getSetting_(CAL.blocks.courses), other: getSetting_(CAL.blocks.other) };
  const legacy = getSetting_(CAL.blocks.legacy); // blocks saved before schema 8 were all in this one
  const byName = {}, byId = {}, problems = [];
  /** A calendar by name, looked up once per run; null when it doesn't exist (and the problem is noted). */
  const resolve = function (name) {
    if (!Object.prototype.hasOwnProperty.call(byName, name)) {
      try { byName[name] = findCalendar_(name); } catch (err) {
        byName[name] = null;
        if (problems.indexOf(err.message) < 0) problems.push(err.message);
      }
    }
    return byName[name];
  };
  const ctx = {
    problems: problems,
    run: { all: null }, // for locateEvent_: Bahr's calendars, read once
    /** The Calendar the block belongs in, or null (a problem was noted). */
    target: function (b) {
      const t = tasks[b.task_id];
      return resolve(calendarNameFor_(t && courses[t.course], groups, defaults));
    },
    /** Notes a problem for every chosen calendar that doesn't exist (the defaults, and each active category's own). */
    checkNames: function () {
      const names = [defaults.courses, defaults.other];
      Object.keys(courses).forEach(function (slug) {
        const c = courses[slug], g = groups[c.group];
        if (c.calendar && c.active !== 'FALSE' && !(g && g.active === 'FALSE')) names.push(c.calendar);
      });
      names.forEach(function (n) { if (String(n || '').trim()) resolve(String(n).trim()); });
    },
    /** Id of the calendar holding the block's event now. */
    heldId: function (b) { return b.calendar_id || legacy; },
    /** The Calendar holding the block's event now (null if unknown or gone). */
    holder: function (b) {
      const id = ctx.heldId(b);
      if (!id) return null;
      if (!Object.prototype.hasOwnProperty.call(byId, id)) byId[id] = calendarById_(id);
      return byId[id];
    },
  };
  return ctx;
}

/** Bahr's own calendars, for the "which calendar" choices in the app (settings, and each category). */
function calendars_() {
  const list = CalendarApp.getAllOwnedCalendars()
    .filter(function (c) { return c.getName() !== CAL.deadlines.name; })
    .map(function (c) {
      return { id: c.getId(), name: c.getName(), color: c.getColor(), primary: c.isMyPrimaryCalendar() };
    })
    .sort(function (a, b) { return (b.primary - a.primary) || a.name.localeCompare(b.name); });
  return { calendars: list, chosen: getSetting_(CAL.blocks.courses), other: getSetting_(CAL.blocks.other) };
}

/**
 * Schema 8: the default calendar for categories that aren't courses. 'Bahr Goren' if a calendar has that name;
 * otherwise his main calendar (Google may name it by the e-mail address).
 */
function otherCalendarDefault_() {
  const want = 'Bahr Goren';
  try {
    if (CalendarApp.getOwnedCalendarsByName(want).length || CalendarApp.getCalendarsByName(want).length) return want;
    const main = CalendarApp.getDefaultCalendar();
    return main ? main.getName() : want;
  } catch (err) { return want; }
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
function groupMap_() {
  const m = {};
  readTable_('groups').forEach(function (g) { m[g.id] = g; });
  return m;
}
function courseName_(courses, slug) { const c = courses[slug]; return c ? (c.short_he || c.name_he) : ''; }

/* --- a block's note ↔ its event's description ---- */

/** The description the app writes on a block's event: the note, then the app's footer. */
function blockDesc_(note) {
  return (note ? note + '\n\n' : '') + BLOCK_MARK + ': ' + APP_URL +
    '\nהזזה, מחיקה או שינוי התיאור של האירוע כאן מעדכנים את האפליקציה.';
}

/**
 * The block note held in an event's description: the text before the app's footer, as one line (lines joined with
 * ' · ', the app's note field has one line). Google Calendar may have turned the description into HTML.
 */
function noteOf_(desc) {
  let s = String(desc || '');
  if (/<[a-z][\s\S]*?>/i.test(s)) {
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
  const i = s.indexOf(BLOCK_MARK);
  if (i >= 0) s = s.slice(0, i);
  return oneLine_(s);
}
/** A note as one line: lines trimmed, empty ones dropped, joined with ' · '. */
function oneLine_(s) {
  return String(s || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).join(' · ');
}

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

/**
 * Creates / updates / moves / removes the calendar event of one work block. ctx = blockCals_(…).
 * relocate = the calendar the block belongs in may have changed: put the event there. Otherwise an existing event
 * stays in the calendar holding it (so an event Bahr moved to another calendar stays there). A block without
 * calendar_id was placed by an older version: it is put where it belongs.
 */
function syncBlockEvent_(b, ctx, enabled, tasks, courses, relocate) {
  let holder = b.calendar_event_id ? ctx.holder(b) : null;
  let ev = null;
  if (holder) { // its event, also when Bahr moved it to another calendar and that wasn't pulled yet
    const found = locateEvent_(holder, b.calendar_event_id, null, ctx.run);
    if (found === undefined) return; // Google didn't answer: the next run tries again (never make a duplicate)
    if (found) { ev = found.ev; holder = found.cal; }
  }
  if (!blockWanted_(b, enabled, tasks)) {
    if (ev) ev.deleteEvent();
    if (b.calendar_event_id || b.calendar_id) upsert_('blocks', { id: b.id, calendar_event_id: '', calendar_id: '' }, { touch: false });
    return;
  }
  let cal = ev ? holder : null;
  if (!ev || relocate || !b.calendar_id) {
    const target = ctx.target(b);
    if (!target) return; // its calendar doesn't exist: leave the block (and any event it has) as it is; the problem is reported
    if (ev && holder.getId() !== target.getId()) { ev.deleteEvent(); ev = null; } // it belongs in another calendar now
    cal = target;
  }
  const t = tasks[b.task_id];
  const course = courseName_(courses, t.course);
  const title = (b.state === 'done' ? '✓ ' : '📚 ') + t.title + (course ? ' · ' + course : '');
  const s = toDate_(b.start), e = toDate_(b.end);
  if (ev) {
    if (ev.getTitle() !== title) ev.setTitle(title);
    if (ev.getStartTime().getTime() !== s.getTime() || ev.getEndTime().getTime() !== e.getTime()) ev.setTime(s, e);
    // the note changed in the app: write it into the description (a description Bahr wrote with the same text stays)
    if (noteOf_(ev.getDescription()) !== oneLine_(b.note)) ev.setDescription(blockDesc_(b.note));
    if (b.calendar_id !== cal.getId()) upsert_('blocks', { id: b.id, calendar_id: cal.getId() }, { touch: false });
  } else {
    const created = cal.createEvent(title, s, e, { description: blockDesc_(b.note) });
    upsert_('blocks', { id: b.id, calendar_event_id: created.getId(), calendar_id: cal.getId() }, { touch: false });
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
  const ctx = blockCals_(tasks, courses, groupMap_());
  c.dead.forEach(function (d) {
    if (d.table === 'tasks') {
      const dcal = calendar_('deadlines', false);
      const dev = dcal && safeEvent_(dcal, d.id);
      if (dev) dev.deleteEvent();
      return;
    }
    const holder = ctx.holder({ calendar_id: d.cal });
    const found = holder ? locateEvent_(holder, d.id, null, ctx.run) : null; // also if Bahr moved it to another calendar
    if (found) found.ev.deleteEvent();
  });
  if (taskIds.length) {
    const cal = calendar_('deadlines', dlOn);
    taskIds.forEach(function (id) {
      if (tasks[id] && (dlOn || tasks[id].calendar_event_id)) syncTaskEvent_(tasks[id], cal, dlOn, courses);
    });
  }
  if (blockIds.length) {
    readTable_('blocks').forEach(function (b) {
      if (c.blocks[b.id] && (blOn || b.calendar_event_id)) {
        syncBlockEvent_(b, ctx, blOn, tasks, courses, !!(c.relocate && c.relocate[b.id]));
      }
    });
  }
  if (ctx.problems.length) setSetting_('calendar_status', 'error · ' + now_() + ' · ' + ctx.problems[0]);
  else if (dlOn || blOn) setSetting_('calendar_status', 'ok · ' + now_());
}

/* --- Google Calendar → Sheet ---- */

/**
 * The event in this calendar: the event, null if this calendar doesn't hold it (deleted, or moved to another
 * calendar), undefined if Google didn't answer (decide nothing). getEventById() alone isn't trusted: it can still
 * return an event that was deleted, so the event must also be listed by getEvents() at its own time.
 * listed = this calendar's events in the pull window by id, when already read.
 */
function eventIn_(cal, id, listed) {
  if (listed && listed[id]) return listed[id];
  let ev;
  try { ev = cal.getEventById(id); } catch (err) { return undefined; }
  if (!ev) return null;
  try {
    const near = cal.getEvents(new Date(ev.getStartTime().getTime() - 60000), new Date(ev.getEndTime().getTime() + 60000));
    return near.some(function (x) { return x.getId() === id; }) ? ev : null;
  } catch (err) { return undefined; }
}

/**
 * Where a block's event is now: {cal, ev}; null = it was deleted; undefined = unsure (Google didn't answer).
 * Not in its own calendar any more → looked for in Bahr's other calendars (moved there in Google Calendar).
 */
function locateEvent_(holder, id, listed, run) {
  const here = eventIn_(holder, id, listed);
  if (here) return { cal: holder, ev: here };
  if (here === undefined) return undefined;
  let unsure = false;
  if (!run.all) {
    try { run.all = CalendarApp.getAllCalendars(); } catch (err) { return undefined; }
  }
  for (let i = 0; i < run.all.length; i++) {
    const cal = run.all[i];
    if (cal.getId() === holder.getId()) continue;
    const ev = eventIn_(cal, id, null);
    if (ev) return { cal: cal, ev: ev };
    if (ev === undefined) unsure = true;
  }
  return unsure ? undefined : null;
}

/**
 * Google Calendar → Sheet for work blocks. For each block with an event (starting in the pull window):
 * moved / resized → new times; description edited → the block's note; moved to another calendar → calendar_id follows
 * (the event stays there); deleted → the block is deleted. A block is never deleted when Google didn't answer.
 * onlyCal = only the blocks held in that calendar (a calendar trigger); '' = all. Returns how many blocks changed.
 */
function pullBlocks_(onlyCal) {
  if (getSetting_(CAL.blocks.toggle) !== 'TRUE') return 0;
  const legacy = getSetting_(CAL.blocks.legacy);
  const from = new Date(Date.now() - PULL_DAYS.back * 86400000), to = new Date(Date.now() + PULL_DAYS.ahead * 86400000);
  const run = { cals: {}, lists: {}, all: null };
  let changed = 0;
  readTable_('blocks').forEach(function (b) {
    if (!b.calendar_event_id || !b.start) return;
    const hid = b.calendar_id || legacy;
    if (!hid || (onlyCal && hid !== onlyCal)) return;
    const s = toDate_(b.start);
    if (s < from || s > to) return;
    if (!Object.prototype.hasOwnProperty.call(run.cals, hid)) run.cals[hid] = calendarById_(hid);
    const holder = run.cals[hid];
    if (!holder) return; // that calendar is gone: the push makes a new event; never delete the block for it
    if (!Object.prototype.hasOwnProperty.call(run.lists, hid)) {
      try {
        const m = {};
        holder.getEvents(from, to).forEach(function (ev) { m[ev.getId()] = ev; });
        run.lists[hid] = m;
      } catch (err) { run.lists[hid] = undefined; }
    }
    if (run.lists[hid] === undefined) return; // Google didn't answer: next time
    const found = locateEvent_(holder, b.calendar_event_id, run.lists[hid], run);
    if (found === undefined) return; // unsure: next time
    if (!found) { deleteRow_('blocks', b.id); changed++; return; } // deleted in Google Calendar
    const ev = found.ev, patch = {};
    if (found.cal.getId() !== hid) patch.calendar_id = found.cal.getId(); // moved to another calendar there
    if (ev.getLastUpdated() > toDate_(b.updated_at || '2000-01-01')) { // changed there after the app last saved it
      if (!ev.isAllDayEvent()) {
        const es = fmt_(ev.getStartTime()), ee = fmt_(ev.getEndTime());
        if (es !== b.start) patch.start = es;
        if (ee !== b.end) patch.end = ee;
      }
      const note = noteOf_(ev.getDescription());
      if (note !== oneLine_(b.note)) patch.note = note;
    }
    if (!Object.keys(patch).length) return;
    const content = 'start' in patch || 'end' in patch || 'note' in patch;
    patch.id = b.id;
    upsert_('blocks', patch, { touch: content });
    changed++;
  });
  return changed;
}

/**
 * Calendar trigger (one per calendar that holds work blocks, kept by watchCalendars_): something changed in that
 * calendar → bring Bahr's changes to blocks into the Sheet now, instead of at the next 10-minute run.
 */
function onCalendarChange(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return; // busy for long: the 10-minute run catches up
  try {
    if (pullBlocks_(e && e.calendarId ? String(e.calendarId) : '')) setSetting_('calendar_status', 'ok · ' + now_());
  } catch (err) {
    setSetting_('calendar_status', 'error · ' + now_() + ' · ' + err.message);
  } finally { lock.releaseLock(); }
}

/** The app opened or came back (bootstrap {pull: 1}): pull now, unless something else holds the lock. */
function pullNow_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try { pullBlocks_(''); } catch (err) {
    setSetting_('calendar_status', 'error · ' + now_() + ' · ' + err.message);
  } finally { lock.releaseLock(); }
}

/**
 * Keeps one calendar trigger (→ onCalendarChange) on every calendar that holds a work-block event or that new blocks
 * go to, and removes the others, so a change made in Google Calendar reaches the Sheet within about a minute.
 * No calendars while the work-block sync is off. Never throws: the result goes to settings.calendar_watch.
 */
function watchCalendars_() {
  try {
    const want = {};
    if (getSetting_(CAL.blocks.toggle) === 'TRUE') {
      const legacy = getSetting_(CAL.blocks.legacy);
      readTable_('blocks').forEach(function (b) {
        const id = b.calendar_event_id ? (b.calendar_id || legacy) : '';
        if (id) want[id] = true;
      });
      const names = [getSetting_(CAL.blocks.courses), getSetting_(CAL.blocks.other)];
      readTable_('courses').forEach(function (c) { if (c.calendar) names.push(c.calendar); });
      names.forEach(function (n) {
        try { want[findCalendar_(n, true).getId()] = true; } catch (err) { /* not there (yet): the sync reports it */ }
      });
    }
    const have = {};
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() !== WATCH_FN) return;
      const id = t.getTriggerSourceId();
      if (!want[id] || have[id]) ScriptApp.deleteTrigger(t); else have[id] = true;
    });
    Object.keys(want).forEach(function (id) {
      if (!have[id]) ScriptApp.newTrigger(WATCH_FN).forUserCalendar(id).onEventUpdated().create();
    });
    const n = Object.keys(want).length;
    setSetting_('calendar_watch', 'ok · ' + n + ' calendars · ' + now_());
    return n;
  } catch (err) {
    try { setSetting_('calendar_watch', 'error · ' + now_() + ' · ' + err.message); } catch (e2) { /* nothing to do */ }
    return -1;
  }
}

/**
 * Full sync (every 10 minutes, `syncNow`, and when a calendar setting changes).
 * 1. Calendar → Sheet: pullBlocks_ (all calendars).
 * 2. Sheet → Calendar: rows changed since the last run are pushed (all rows when force). relocate = a calendar
 *    setting changed: every block is also put in the calendar it belongs in now (otherwise events stay where they are).
 * A category whose calendar doesn't exist doesn't stop the other categories or the deadlines.
 */
function syncCalendars_(force, relocate) {
  const dlOn = getSetting_(CAL.deadlines.toggle) === 'TRUE';
  const blOn = getSetting_(CAL.blocks.toggle) === 'TRUE';
  const last = force ? '' : (getSetting_('calendar_last_sync') || '').slice(0, 16);
  const startedAt = now_();

  // 1. pull changes made in Google Calendar to work blocks
  const pulled = pullBlocks_('');

  // 2. push changes from the Sheet
  const courses = courseMap_();
  const tasks = {};
  readTable_('tasks').forEach(function (t) { tasks[t.id] = t; });
  const ctx = blockCals_(tasks, courses, groupMap_());
  let pushed = 0;
  const dcal = calendar_('deadlines', dlOn);
  Object.keys(tasks).forEach(function (id) {
    const t = tasks[id];
    const want = dlOn && t.due_date && t.status !== 'cancelled';
    if (force || (t.updated_at || '') >= last || (want && !t.calendar_event_id) || (!want && t.calendar_event_id)) {
      if (dcal || t.calendar_event_id) { syncTaskEvent_(t, dcal, dlOn, courses); pushed++; }
    }
  });
  if (blOn) ctx.checkNames(); // a wrong calendar name stays reported until it's fixed, not only when a block is saved
  readTable_('blocks').forEach(function (b) {
    const want = blockWanted_(b, blOn, tasks);
    const unplaced = want && b.calendar_event_id && !b.calendar_id; // placed by an older version
    if (force || unplaced || (b.updated_at || '') >= last || (want && !b.calendar_event_id) || (!want && b.calendar_event_id)) {
      if (want || b.calendar_event_id) { syncBlockEvent_(b, ctx, blOn, tasks, courses, !!relocate); pushed++; }
    }
  });
  const problem = ctx.problems[0] || '';
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
// The announcements are also saved into the course's Moodle folder in Drive (see "לוח הודעות → Drive" below),
// so Drive stays current even while Bahr's laptop (which runs moodle-dl for all other files) is off.

const MOODLE_SITE = 'https://moodle26.technion.ac.il';
const MAX_TEXT = 40000; // full message text (a Sheet cell holds up to 50,000 characters)

// moodle-dl's User-Agent (the Moodle mobile app). Only used if Moodle refuses the script's own requests.
const MOODLE_APP_UA = 'Mozilla/5.0 (Linux; Android 7.1.1; Moto G Play Build/NPIS26.48-43-2; wv) AppleWebKit/537.36' +
  ' (KHTML, like Gecko) Version/4.0 Chrome/71.0.3578.99 Mobile Safari/537.36 MoodleMobile';

/**
 * One Moodle web-service call. Every parameter is sent as text: UrlFetchApp sends a JS number such as 550 as
 * "550.0", which Moodle rejects as an invalid integer ("invalidparameter") - that is why the forum calls, the only
 * ones with numbers in them, failed. opts.ua = also send the Moodle app's User-Agent.
 */
function moodle_(fn, params, token, opts) {
  token = token || PropertiesService.getScriptProperties().getProperty('MOODLE_TOKEN');
  if (!token) throw new Error('no Moodle token');
  const payload = { wstoken: token, wsfunction: fn, moodlewsrestformat: 'json',
    moodlewssettingfilter: 'true', moodlewssettingfileurl: 'true' };
  Object.keys(params || {}).forEach(function (k) {
    const v = params[k];
    if (v === null || v === undefined) return;
    payload[k] = typeof v === 'number' && Number.isInteger(v) ? v.toFixed(0)
      : typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  });
  const req = { method: 'post', payload: payload, muteHttpExceptions: true };
  if (opts && opts.ua) req.headers = { 'User-Agent': MOODLE_APP_UA };
  const res = UrlFetchApp.fetch(MOODLE_SITE + '/webservice/rest/server.php', req);
  if (res.getResponseCode() !== 200) throw new Error('Moodle HTTP ' + res.getResponseCode());
  const j = JSON.parse(res.getContentText());
  if (j && j.exception) {
    throw new Error((j.errorcode || 'error') + ': ' + (j.message || '') + (j.debuginfo ? ' [' + j.debuginfo + ']' : ''));
  }
  return j;
}

/** Request options that worked for the forum calls (remembered by forumDiscussions_). */
function forumOpts_() {
  return { ua: PropertiesService.getScriptProperties().getProperty('MOODLE_FORUM_VARIANT3') === '1' };
}

/**
 * Discussions of one forum, newest first (Moodle's default order: latest post first), asked exactly like moodle-dl
 * ({forumid, page, perpage: 10}), reading as many pages as needed. If Moodle refuses, the request is repeated with
 * the Moodle app's User-Agent; the variant that works is remembered.
 */
const FORUM_PAGE_SIZE = 10;
function forumDiscussions_(forumId, wanted) {
  const props = PropertiesService.getScriptProperties();
  const variants = [ // request options for mod_forum_get_forum_discussions, tried in order
    { },                 // the script's own request
    { ua: true },        // + the Moodle app's User-Agent, like moodle-dl
  ];
  const fetchPage = function (i, page) {
    const p = { forumid: forumId, page: page, perpage: FORUM_PAGE_SIZE };
    return moodle_('mod_forum_get_forum_discussions', p, null, variants[i]);
  };
  const known = props.getProperty('MOODLE_FORUM_VARIANT3');
  const order = (known !== null && variants[Number(known)] ? [Number(known)] : [])
    .concat(variants.map(function (v, i) { return i; }).filter(function (i) { return String(i) !== known; }));
  const errors = [];
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    let first;
    try { first = fetchPage(i, 0); } catch (err) {
      if (errors.length < 3) errors.push(JSON.stringify(variants[i]) + ': ' + err.message);
      continue;
    }
    if (known !== String(i)) props.setProperty('MOODLE_FORUM_VARIANT3', String(i));
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
  const parts = String(path || '').split('/').filter(String);
  if (!parts.length) return null; // never the top of Technion Studies itself
  let f = DriveApp.getFolderById(STUDIES_FOLDER_ID);
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

/* ---------------------------------------------------- לוח הודעות → Drive ---- */
// Every check also saves the announcements into Drive, exactly where and how moodle-dl (the laptop sync) saves them:
//   <course Moodle folder>/<section>/<forum name>/<yy-mm-dd subject>/[<post id>] <author>.md   (+ attachments)
// so the Drive copy stays current while the laptop is off. Discussions already in Drive are left as they are; when
// Moodle reports one as changed (edited / new reply) its files are updated. The laptop sync (moodle_sync.py) never
// overwrites anything inside these folders and skips posts that are already there.

const BOARD_STATE_KEY = 'MOODLE_BOARD_SAVED';      // {discussion id: Moodle 'modified' time when it was saved}
const BOARD_MAX_ATTACHMENT = 45 * 1024 * 1024;     // UrlFetchApp's limit is 50 MB; bigger files come from the laptop

const HTML_ENTITIES_ = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', times: '×',
  lrm: '‎', rlm: '‏', zwj: '‍', zwnj: '‌' };
function htmlUnescape_(s) {
  return String(s).replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (m, e) {
    if (e.charAt(0) === '#') {
      const n = /^#[xX]/.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES_, e) ? HTML_ENTITIES_[e] : m;
  });
}

/** moodle-dl's PathTools.to_valid_name (as on Windows), so the script and moodle-dl use the same names. */
function toValidName_(name, isFile) {
  if (name === null || name === undefined) return name;
  let s = htmlUnescape_(String(name)).normalize('NFKC');
  s = s.replace(/[\n\r\t]/g, ' ').replace(/­/g, '');
  while (s.indexOf('  ') >= 0) s = s.split('  ').join(' ');
  s = sanitizeFilename_(s);
  s = s.replace(/^[. ]+|[. ]+$/g, '').trim();
  return truncateName_(s, isFile, 200);
}

/** yt-dlp's sanitize_filename in its default mode (used by moodle-dl): forbidden characters → full-width look-alikes. */
function sanitizeFilename_(s) {
  if (s === '') return '';
  s = s.replace(/[0-9]+(?::[0-9]+)+/g, function (m) { return m.replace(/:/g, '_'); }); // times: 12:30 → 12_30
  let out = '';
  Array.from(s).forEach(function (ch) {
    const code = ch.codePointAt(0);
    if (ch === '\n') out += '\0 ';
    else if ('"*:<>?|/\\'.indexOf(ch) >= 0) {
      out += ch === '/' ? '⧸' : ch === '\\' ? '⧹' : String.fromCharCode(code + 0xFEE0);
    } else if (code >= 32 && code !== 127) out += ch;
  });
  out = out.replace(/(\0[^\n])(?:(?=\1)[^\n][^\n])+/g, '$1');
  out = out.replace(/^\0[^\n](?:\0[^\n]|[ _-])*|(?:\0[^\n]|[ _-])*\0[^\n]$/g, '');
  return out.replace(/\0/g, '') || '_';
}

function truncateName_(s, isFile, max) {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const cut = function (arr, n) { return arr.slice(0, n - 1).join('') + '…'; };
  const dot = s.lastIndexOf('.');
  const ext = isFile && dot >= 0 ? s.slice(dot + 1) : '';
  if (!ext || ext.length > 20) return cut(chars, max);
  return cut(Array.from(s.slice(0, dot)), max - ext.length - 1) + '.' + ext;
}

/** A post's HTML as readable Markdown (paragraphs, bold, italics, links, lists). */
function htmlToMarkdown_(html) {
  let s = String(html || '').replace(/\r\n?|\n/g, ' ');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<a\b[^>]*?href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, function (m, href, text) {
    const t = text.replace(/<[^>]+>/g, '').trim();
    href = htmlUnescape_(href);
    return t && t !== href ? '[' + t + '](' + href + ')' : href;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?(strong|b)(\s[^>]*)?>/gi, '**').replace(/<\/?(em|i)(\s[^>]*)?>/gi, '_');
  s = s.replace(/<li\b[^>]*>/gi, '\n* ').replace(/<h([1-6])\b[^>]*>/gi, function (m, n) {
    return '\n\n' + new Array(Number(n) + 1).join('#') + ' ';
  });
  s = s.replace(/<\/?(p|div|ul|ol|blockquote|table|tr|h[1-6])\b[^>]*>/gi, '\n\n').replace(/<\/t[dh]>/gi, ' | ');
  s = htmlUnescape_(s.replace(/<[^>]+>/g, '')).replace(/ /g, ' ');
  s = s.replace(/\*\*\s*\*\*/g, '').split('\n').map(function (line) { return line.replace(/\s+/g, ' ').trim(); }).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function boardState_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(BOARD_STATE_KEY) || '{}'); }
  catch (err) { return {}; }
}
function saveBoardState_(state) {
  let keys = Object.keys(state);
  if (keys.length > 300) { // a Script Property holds 9 KB: forget the oldest discussions
    keys.sort(function (a, b) { return state[b] - state[a]; }).slice(300).forEach(function (k) { delete state[k]; });
  }
  PropertiesService.getScriptProperties().setProperty(BOARD_STATE_KEY, JSON.stringify(state));
}
function modifiedOf_(d) { return Math.max(Number(d.timemodified) || 0, Number(d.modified) || 0); }

// {first post id: discussion id} of announcements read from Moodle, so that the Drive-copy fallback (which only
// knows the post id from the file name, ref "post:file<id>") doesn't add a message the inbox already has.
const FIRST_POSTS_KEY = 'MOODLE_FIRST_POSTS';
function firstPosts_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(FIRST_POSTS_KEY) || '{}'); }
  catch (err) { return {}; }
}
function saveFirstPosts_(map) {
  const keys = Object.keys(map);
  if (keys.length > 400) keys.sort(function (a, b) { return Number(b) - Number(a); }).slice(400)
    .forEach(function (k) { delete map[k]; });
  PropertiesService.getScriptProperties().setProperty(FIRST_POSTS_KEY, JSON.stringify(map));
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** The course forum's folder in Drive: the one moodle-dl made (<section>/<forum name>), else a new one there. */
function boardFolder_(course, forum) {
  const root = driveFolderByPath_(course.moodle_folder);
  if (!root) throw new Error('Drive folder not found: ' + course.moodle_folder);
  const name = toValidName_(forum.name, false);
  const sections = root.getFolders();
  while (sections.hasNext()) {
    const it = sections.next().getFoldersByName(name);
    if (it.hasNext()) return it.next();
  }
  let section = null; // not in Drive yet: put it in the forum's section, as moodle-dl would
  (moodle_('core_course_get_contents', { courseid: course.moodle_course_id }) || []).forEach(function (s) {
    (s.modules || []).forEach(function (m) { if (String(m.id) === String(forum.cmid)) section = s.name; });
  });
  if (section === null) throw new Error('forum ' + forum.cmid + ' is not on the course page');
  return childFolder_(childFolder_(root, toValidName_(section, false)), name);
}

/** What is already in a forum folder: {posts: {post id: folder}, folders: {name: folder}, count: {folder id: posts}}. */
function boardIndex_(board) {
  const idx = { posts: {}, folders: {}, count: {} };
  const ds = board.getFolders();
  while (ds.hasNext()) {
    const d = ds.next();
    idx.folders[d.getName()] = d;
    let n = 0;
    const fs = d.getFiles();
    while (fs.hasNext()) {
      const m = /^\[(\d+)\]/.exec(fs.next().getName());
      if (m) { idx.posts[m[1]] = d; n++; }
    }
    idx.count[d.getId()] = n;
  }
  return idx;
}

function headerOf_(res, name) {
  const h = res.getHeaders() || {};
  const k = Object.keys(h).filter(function (x) { return x.toLowerCase() === name.toLowerCase(); })[0];
  return k ? String(h[k]) : '';
}

/** Writes one discussion's posts (+ attachments) into its Drive folder. Returns the number of files written. */
function saveDiscussion_(board, idx, d, token, acc) {
  const did = d.discussion || d.id;
  const name = toValidName_(Utilities.formatDate(new Date(Number(d.created) * 1000), 'UTC', 'yy-MM-dd') + ' ' +
    (d.subject || ''), false);
  const res = moodle_('mod_forum_get_discussion_posts',
    { discussionid: did, sortby: 'modified', sortdirection: 'ASC' }, null, forumOpts_());
  const posts = ((res && res.posts) || []).filter(function (p) { return !p.isdeleted; });
  if (!posts.length) return 0;
  // the folder that already holds this discussion (moodle-dl may have named it a bit differently), else by name
  let folder = idx.posts[String(d.id)] || idx.folders[name];
  if (!folder) { folder = board.createFolder(name); idx.folders[name] = folder; }
  let written = 0;
  posts.forEach(function (p) {
    let base = toValidName_('[' + p.id + '] ' + ((p.author && p.author.fullname) || 'Unknown'), false);
    if (p.parentid) base = toValidName_(base + ' response to [' + p.parentid + ']', false);
    const fileName = toValidName_(base, true) + '.md';
    const text = htmlToMarkdown_(p.message);
    const same = folder.getFilesByName(fileName);
    const existing = same.hasNext() ? same.next() : null;
    if (existing) {
      if (text && existing.getBlob().getDataAsString('UTF-8') !== text) { existing.setContent(text); written++; }
    } else if (text && !idx.posts[String(p.id)]) {
      folder.createFile(fileName, text, 'text/markdown');
      idx.posts[String(p.id)] = folder;
      written++;
    }
    (p.attachments || []).forEach(function (a) {
      const an = toValidName_(a.filename || '', true);
      if (!an || an === '_' || folder.getFilesByName(an).hasNext()) return;
      if (Number(a.filesize) > BOARD_MAX_ATTACHMENT) { acc.tooBig++; return; }
      let url = String(a.fileurl || a.url || '');
      if (!url) return;
      if (url.indexOf('/webservice/') < 0) url = url.replace('/pluginfile.php/', '/webservice/pluginfile.php/');
      url += (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
      const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (r.getResponseCode() !== 200 || /json/i.test(headerOf_(r, 'Content-Type'))) {
        throw new Error('attachment "' + a.filename + '": HTTP ' + r.getResponseCode());
      }
      folder.createFile(r.getBlob().setName(an));
      written++;
    });
  });
  return written;
}

/** Saves a course's new / changed announcements into Drive (called by moodleCheck_ with the discussions it read). */
function boardSync_(course, forum, discussions, acc) {
  const changed = discussions.filter(function (d) {
    return acc.state[String(d.discussion || d.id)] !== modifiedOf_(d);
  });
  if (!changed.length) return;
  const token = PropertiesService.getScriptProperties().getProperty('MOODLE_TOKEN');
  const board = boardFolder_(course, forum);
  const idx = boardIndex_(board);
  changed.forEach(function (d) {
    const key = String(d.discussion || d.id);
    const have = idx.posts[String(d.id)];
    try {
      if (acc.state[key] === undefined && have && idx.count[have.getId()] >= (Number(d.numreplies) || 0) + 1) {
        acc.state[key] = modifiedOf_(d); // already complete in Drive (saved by the laptop sync)
        return;
      }
      acc.saved += saveDiscussion_(board, idx, d, token, acc);
      acc.state[key] = modifiedOf_(d);
    } catch (err) {
      acc.errors.push((course.short_he || course.slug) + ' "' + (d.subject || key) + '": ' + err.message);
    }
  });
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
  // courses only (categories with a Moodle course id), and not archived (themselves or their meta category)
  const courses = moodleCourses_();
  if (!courses.length) { // e.g. between semesters: with no course ids, Moodle would answer for every course
    const idle = 'ok · 0 new · no active courses';
    setSetting_('moodle_last_check', now_());
    setSetting_('moodle_status', idle);
    return { status: idle, added: 0, drive_saved: 0, drive_errors: [] };
  }
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
      if (isNews && (!forumOf[c.slug] || f.type === 'news')) forumOf[c.slug] = f;
    });
  } catch (err) { errors.push('forums: ' + err.message); }

  const board = { state: boardState_(), saved: 0, tooBig: 0, errors: [] }; // announcements → Drive
  const firstPost = firstPosts_();
  courses.forEach(function (c) {
    const forum = forumOf[c.slug];
    try {
      let res;
      try {
        if (!forum) throw new Error('no news forum found');
        res = forumDiscussions_(forum.id, 20);
      } catch (apiErr) {
        // API refused → use the copies moodle-dl saved in Drive (only as fresh as the last moodle-dl run)
        if (!c.moodle_folder) throw apiErr; // no Drive folder for this course: nothing to read instead
        viaDrive.push((c.short_he || c.slug) + ': ' + apiErr.message);
        driveAnnouncements_(c).forEach(function (p) {
          if (taskByRef[p.ref]) return;
          const did = firstPost[p.ref.replace('post:file', '')]; // already in the inbox, read from Moodle itself
          if (did && (inboxRefs['post:' + did] || taskByRef['post:' + did])) return;
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
        const fileRef = 'post:file' + d.id; // the same message, read earlier from the Drive copy (d.id = first post)
        firstPost[String(d.id)] = String(did);
        if (taskByRef[ref] || taskByRef[fileRef] || inboxRefs[fileRef]) return;
        const posted = new Date((d.created || d.timemodified) * 1000);
        const text = plain_(d.message);
        add({
          course: c.slug, kind: 'announcement', moodle_ref: ref, posted_at: fmt_(posted),
          title: d.subject || d.name || '', author: d.userfullname || '', text: text.slice(0, MAX_TEXT),
          detected_dates: detectDates_((d.subject || '') + '\n' + text, posted).join(', '),
          url: MOODLE_SITE + '/mod/forum/discuss.php?d=' + did,
        });
      });
      // (only with a Drive folder: without one, the folders would be made at the top of Technion Studies)
      if (c.moodle_folder) {
        try { boardSync_(c, forum, res.discussions || [], board); }
        catch (err) { board.errors.push((c.short_he || c.slug) + ': ' + err.message); }
      }
    } catch (err) { errors.push((c.short_he || c.slug) + ': ' + err.message); }
  });
  try { saveBoardState_(board.state); saveFirstPosts_(firstPost); } catch (err) { board.errors.push('state: ' + err.message); }

  try {
    const params = {};
    courses.forEach(function (c, i) { if (c.moodle_course_id) params['courseids[' + i + ']'] = c.moodle_course_id; });
    const res = moodle_('mod_assign_get_assignments', params);
    const soon = Date.now() - 3 * 86400000;
    (res.courses || []).forEach(function (mc) {
      const c = courses.filter(function (x) { return String(x.moodle_course_id) === String(mc.id); })[0];
      if (!c) return; // a course we didn't ask about
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
  const drive = (board.saved ? ' · Drive: ' + board.saved + ' file(s) saved' : '') +
    (board.tooBig ? ' · Drive: ' + board.tooBig + ' attachment(s) over 45 MB left for the laptop sync' : '') +
    (board.errors.length ? ' · saving to Drive failed: ' + board.errors.join(' | ').slice(0, 300) : '');
  const status = errors.length ? 'error: ' + errors.join(' | ') + drive
    : 'ok · ' + added + ' new' + drive +
      (viaDrive.length ? ' · via Drive copy · Moodle API: ' + viaDrive[0].slice(0, 300) : '');
  setSetting_('moodle_last_check', now_());
  setSetting_('moodle_status', status);
  return { status: status, added: added, drive_saved: board.saved, drive_errors: board.errors };
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
  const archived = archivedSlugs_(); // messages of archived courses wait (they're hidden in the app)
  const todo = data.moodle_inbox.filter(function (m) {
    if (opts.id) return m.id === opts.id;
    return m.status === 'new' && m.kind !== 'date_change' && (!m.ai_status || m.ai_status === 'pending') && !archived[m.course];
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
    // a new version was deployed and the app wasn't opened yet (a failure is retried by the next request / run)
    try { if (schemaBehind_()) migrate_(); } catch (err) { Logger.log('migration failed: ' + err.message); }
    try {
      if (getSetting_(CAL.deadlines.toggle) === 'TRUE' || getSetting_(CAL.blocks.toggle) === 'TRUE' ||
        getSetting_('deadline_calendar_id') || getSetting_('blocks_calendar_id')) syncCalendars_(false);
    } catch (err) { setSetting_('calendar_status', 'error · ' + now_() + ' · ' + err.message); }
    watchCalendars_(); // calendar triggers for instant pull-back (never throws; result in settings.calendar_watch)
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
  try { // how UrlFetchApp sends numbers (the old forum calls sent them as JS numbers)
    const echo = UrlFetchApp.fetch('https://httpbin.org/post',
      { method: 'post', payload: { number: 550, text: '550' }, muteHttpExceptions: true });
    log('UrlFetchApp sends (number 550 / text "550") as', JSON.parse(echo.getContentText()).form);
  } catch (err) { log('echo test skipped', err.message); }
  try {
    const info = moodle_('core_webservice_get_site_info', {});
    const fns = (info.functions || []).map(function (f) { return f.name; });
    log('site', { user: info.fullname, release: info.release, version: info.version });
    log('functions available', ['mod_forum_get_forums_by_courses', 'mod_forum_get_forum_discussions',
      'mod_forum_get_discussion_posts', 'mod_assign_get_assignments', 'core_course_get_contents']
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
    PropertiesService.getScriptProperties().deleteProperty('MOODLE_FORUM_VARIANT3');
    const r = forumDiscussions_(news.id, 5);
    const v = PropertiesService.getScriptProperties().getProperty('MOODLE_FORUM_VARIANT3');
    log('discussions OK (' + (v === '1' ? 'needed the Moodle app User-Agent' : 'plain request') + ')',
      (r.discussions || []).map(function (d) { return { id: d.id, discussion: d.discussion, subject: d.subject, created: d.created }; }));
    const d0 = (r.discussions || [])[0];
    if (d0) {
      const p = moodle_('mod_forum_get_discussion_posts',
        { discussionid: d0.discussion || d0.id, sortby: 'modified', sortdirection: 'ASC' }, null, forumOpts_());
      log('posts of "' + d0.subject + '"', (p.posts || []).map(function (x) {
        return { id: x.id, author: x.author && x.author.fullname, attachments: (x.attachments || []).length };
      }));
    }
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
