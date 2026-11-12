// Categories (קטגוריות) and meta categories (קטגוריות־על), and the archive.
//
// - A category is a row of the Sheet's tab `courses`: a course is one kind of category (it has Moodle details).
//   Every category belongs to a meta category, a row of `groups`: a semester, a project, general tasks. A task points
//   to a category (tasks.course = its slug).
// - Archive: a category or a whole meta category can be archived (active = FALSE). It disappears from the filter
//   chips, the task editor, the planner and the inbox, together with its tasks. Nothing is deleted: "ארכיון" in the
//   manager shows it again (and its tasks) and restores it. Only something nothing uses can be deleted.
// - The task list's filter (store.ui('course')) is 'all', a category slug, or 'g:<meta category id>'. A filter that
//   points at something archived is the archive view (with a banner and a chip to leave it).
// - The manager sheet (#catSheet) lists everything; its forms (add / edit) open in the same sheet.
// - Saving needs backend v7 (store.canSaveCategories). With an older backend the manager is read-only.
// - Google Calendar: each category's confirmed work blocks go to its own calendar (column `calendar`), or when it has
//   none to the default for its kind: courses (categories in a semester) → settings.blocks_calendar_name ('לימודים'),
//   every other category and tasks without one → settings.other_blocks_calendar_name ('Bahr Goren'). The choice is in
//   the category form. Needs backend v8 (CALENDAR_API); before that every block went to blocks_calendar_name.
import { store } from './store.js';
import { todayIL, shortDate } from './dates.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root) => root.querySelector(sel);
const MOODLE = 'https://moodle26.technion.ac.il';

// Hebrew forms per kind: the meta category ("the semester … in it") and what it holds (a course is masculine).
export const KIND = {
  semester: { label: 'סמסטר', the: 'הסמסטר', inIt: 'שבו', child: 'קורס', children: 'קורסים', newChild: 'קורס חדש', one: 'קורס אחד', m: true },
  project: { label: 'פרויקט', the: 'הפרויקט', inIt: 'שבו', child: 'קטגוריה', children: 'קטגוריות', newChild: 'קטגוריה חדשה', one: 'קטגוריה אחת', m: false },
  general: { label: 'כללי', the: 'קטגוריית־העל', inIt: 'שבה', child: 'קטגוריה', children: 'קטגוריות', newChild: 'קטגוריה חדשה', one: 'קטגוריה אחת', m: false },
};
// ink colours that sit well on the "paper" in light and dark mode (the first five are the courses' colours)
export const PALETTE = ['#3B6FB6', '#C8742B', '#3F8F5B', '#8B5E3C', '#7B5AA6', '#B04A6F', '#2E8A87', '#6E7F2E', '#B8902A', '#5C6B85'];
// categories whose meta category is unknown (e.g. an older backend that has no meta categories yet)
const NO_GROUP = { id: '', name: 'ללא קטגוריית־על', kind: 'general', active: 'TRUE', implicit: true };

export const ICON = {
  chevron: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
};

/* ------------------------------------------------------------ the data ---- */

const isActive = (row) => !!row && row.active !== 'FALSE';

/* ------------------------------------------------- Google Calendar per category ---- */

export const CALENDAR_API = 8;
export const APP_CALENDAR = 'משימות – בלוקי עבודה'; // the app's own calendar ('' in a setting = this one)
export const hasCalendarPerCategory = () => store.isDemo || store.apiVersion >= CALENDAR_API;
/** A calendar name for showing ('' = the app's own calendar). */
export const calLabel = (name) => name || APP_CALENDAR;
/** The default calendar of the categories in meta category g (no g: not a course). */
export function defaultCalendar(g) {
  if (!hasCalendarPerCategory() || (g && g.kind === 'semester')) return store.setting('blocks_calendar_name', '');
  return store.setting('other_blocks_calendar_name', '');
}
/** The calendar a category's confirmed work blocks go to ('' = the app's own). c = a row of courses, or none. */
export function calendarOf(c) {
  const own = hasCalendarPerCategory() && c ? String(c.calendar || '').trim() : '';
  return own || defaultCalendar(c ? groupOf(c) : null);
}
let calendarList = null; // Bahr's own calendars, asked from the backend once per page load
const sortNum = (v) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : 1e9);
const bySort = (key) => (a, b) => sortNum(a.sort) - sortNum(b.sort) || String(a[key] || '').localeCompare(String(b[key] || ''), 'he');
export const kindOf = (g) => KIND[g && g.kind] || KIND.general;
export const nameOf = (c) => (c ? c.short_he || c.name_he || c.slug : '');

/** All meta categories, sorted; plus a "no meta category" bucket when some category has no (known) meta category. */
export function allGroups() {
  const list = [...store.data.groups].sort(bySort('name'));
  if (store.data.courses.some((c) => !c.group || !store.group(c.group))) list.push(NO_GROUP);
  return list;
}
export const activeGroups = () => allGroups().filter(isActive);
export const groupOf = (c) => (c && c.group && store.group(c.group)) || NO_GROUP;

/** The categories of a meta category, sorted (archived ones too with archived = true). */
export function categoriesOf(g, { archived = false } = {}) {
  return store.data.courses
    .filter((c) => groupOf(c).id === g.id && (archived || isActive(c)))
    .sort(bySort('name_he'));
}

/** Meta categories with at least one category that is not archived, each with those categories. */
function visibleGroups() {
  return activeGroups().map((g) => ({ g, cats: categoriesOf(g) })).filter((x) => x.cats.length);
}

/** Label of a category on cards: its short name, or "<meta category> · <name>" when two visible categories share it. */
export function label(slug) {
  const c = store.course(slug);
  if (!c) return '';
  const n = nameOf(c);
  const twin = store.data.courses.some((x) => x.slug !== slug && nameOf(x) === n && !store.categoryArchived(x.slug));
  return twin ? `${groupOf(c).name} · ${n}` : n;
}

/** "קורס" when every meta category in use is a semester, else "קטגוריה". */
export function noun() {
  const gs = visibleGroups();
  return gs.length && gs.every(({ g }) => g.kind === 'semester') ? 'קורס' : 'קטגוריה';
}

function counts() {
  const by = {};
  for (const t of store.data.tasks) {
    const k = t.course || '';
    const o = by[k] || (by[k] = { all: 0, open: 0 });
    o.all++;
    if (t.status !== 'done' && t.status !== 'cancelled') o.open++;
  }
  return (slug) => by[slug] || { all: 0, open: 0 };
}
const inboxUses = (slug) => store.data.moodle_inbox.some((m) => m.course === slug);

/* -------------------------------------------------------------- filter ---- */

/** What a filter value points at: {kind: 'all'} | {kind: 'cat', c, g, archived} | {kind: 'group', g, archived}. */
export function parseFilter(f) {
  if (!f || f === 'all') return { kind: 'all' };
  if (f.startsWith('g:')) {
    const id = f.slice(2);
    const g = id ? store.group(id) : (allGroups().includes(NO_GROUP) ? NO_GROUP : null);
    return g ? { kind: 'group', g, archived: !isActive(g) } : { kind: 'all' };
  }
  const c = store.course(f);
  return c ? { kind: 'cat', c, g: groupOf(c), archived: store.categoryArchived(f) } : { kind: 'all' };
}

/** Is task t in the list under filter f? Archived categories show only in their archive view. */
export function matches(t, f) {
  const p = parseFilter(f);
  if (p.kind === 'all') return !store.taskArchived(t);
  if (p.kind === 'cat') return t.course === p.c.slug;
  const c = store.course(t.course);
  if (!c || groupOf(c).id !== p.g.id) return false;
  return p.archived || isActive(c); // an archived meta category shows everything that was in it
}

/** The category a new task gets from the current filter ('' = none). */
export function defaultFor(f) {
  const p = parseFilter(f);
  if (p.archived) return '';
  if (p.kind === 'cat') return p.c.slug;
  if (p.kind === 'group') { const cats = categoriesOf(p.g); return cats.length === 1 ? cats[0].slug : ''; }
  return '';
}

/** Name of what the archive view shows ('' when the filter isn't an archive view). */
export function archiveName(f) {
  const p = parseFilter(f);
  if (!p.archived) return '';
  return p.kind === 'cat' ? nameOf(p.c) : p.g.name;
}

/**
 * The chips above the task list. One meta category: its categories, as before. Several: one chip per meta category;
 * the selected one opens to show its categories. A meta category (not a semester) with a single category is one chip.
 */
export function filtersHtml(f) {
  const p = parseFilter(f);
  const groups = visibleGroups();
  const flat = groups.length <= 1;
  const catChip = (c) => `<button class="chip ${p.kind === 'cat' && p.c.slug === c.slug ? 'on' : ''}" data-course="${esc(c.slug)}" style="--c:${esc(c.color)}"><i></i>${esc(nameOf(c))}</button>`;
  const chips = [`<button class="chip ${p.kind === 'all' ? 'on' : ''}" data-course="all">הכל</button>`];
  if (p.archived) {
    chips.push(`<button class="chip on archived" data-course="all" title="סגור את הארכיון" aria-label="סגור את הארכיון: ${esc(archiveName(f))}">${ICON.archive}<span>${esc(archiveName(f))}</span>${ICON.close}</button>`);
  }
  for (const { g, cats } of groups) {
    if (flat) { chips.push(...cats.map(catChip)); continue; }
    const live = !p.archived && p.kind !== 'all';
    const groupOn = live && p.kind === 'group' && p.g.id === g.id;
    const inside = live && p.kind === 'cat' && groupOf(p.c).id === g.id;
    if (cats.length === 1 && g.kind !== 'semester') { // the meta category is its one category
      const c = cats[0];
      chips.push(`<button class="chip grp single ${groupOn || inside ? 'on' : ''}" data-course="${esc(c.slug)}" style="--c:${esc(c.color)}"><i></i>${esc(g.name)}</button>`);
      continue;
    }
    chips.push(`<button class="chip grp ${groupOn ? 'on' : ''} ${inside ? 'open' : ''}" data-course="g:${esc(g.id)}" aria-expanded="${groupOn || inside}">${esc(g.name)}${ICON.chevron}</button>`);
    if (groupOn || inside) chips.push(...cats.map((c) => catChip(c).replace('class="chip', 'class="chip sub')));
  }
  if (store.configured) chips.push(`<button class="chip manage" data-manage title="הוספה, עריכה וארכיון">${ICON.sliders}קטגוריות</button>`);
  return chips.join('');
}

/* ------------------------------------------------- task editor: picker ---- */

/** Category chips for the task editor (radio name="course"); the task's own category shows even if archived. */
export function pickerHtml(selected) {
  const groups = visibleGroups();
  const chip = (c, extra = '') => `<label class="chip" style="--c:${esc(c.color)}"><input type="radio" name="course" value="${esc(c.slug)}" ${selected === c.slug ? 'checked' : ''}><span><i></i>${esc(nameOf(c))}${extra}</span></label>`;
  const none = `<label class="chip"><input type="radio" name="course" value="" ${!selected ? 'checked' : ''}><span>ללא</span></label>`;
  let html;
  if (groups.length <= 1) html = `<div class="chips wrap">${none}${(groups[0]?.cats || []).map((c) => chip(c)).join('')}</div>`;
  else {
    // a meta category that is just one category of the same name (e.g. "משימות יומיות") sits next to "ללא";
    // the others get a heading with their categories under it
    const alone = ({ g, cats }) => g.kind !== 'semester' && cats.length === 1 && nameOf(cats[0]) === g.name;
    html = `<div class="chips wrap">${none}${groups.filter(alone).map(({ cats }) => chip(cats[0])).join('')}</div>` +
      groups.filter((x) => !alone(x)).map(({ g, cats }) =>
        `<div class="pick-group"><span class="pick-name">${esc(g.name)}</span><div class="chips wrap">${cats.map((c) => chip(c)).join('')}</div></div>`).join('');
  }
  const listed = groups.some(({ cats }) => cats.some((c) => c.slug === selected));
  if (selected && !listed) { // the task's own category (archived, or not in the Sheet): kept unless another is chosen
    const c = store.course(selected);
    const where = c ? `בארכיון${groupOf(c).implicit ? '' : ` · ${groupOf(c).name}`}` : 'לא נמצאה בגיליון';
    html += `<div class="pick-group"><span class="pick-name">${esc(where)}</span><div class="chips wrap">${
      c ? chip(c) : `<label class="chip"><input type="radio" name="course" value="${esc(selected)}" checked><span>${esc(selected)}</span></label>`}</div></div>`;
  }
  return html;
}

/* ------------------------------------------------------------- manager ---- */

let ui = {};                  // from app.js: toast, render, showFilter
let view = { mode: 'list' };  // list | group | cat
let lastSig = '';
const dlg = () => document.querySelector('#catSheet');

export function init(callbacks) {
  ui = callbacks;
  const d = dlg();
  d.addEventListener('click', onClick);
  d.addEventListener('submit', onSubmit);
  d.addEventListener('change', onChange);
  d.addEventListener('close', () => { view = { mode: 'list' }; });
}

function show() { const d = dlg(); if (!d.open) d.showModal(); }

/** The list of meta categories and categories, with the archive. opts.archive: open the archive section. */
export function openManager(opts = {}) {
  view = { mode: 'list', archiveOpen: !!opts.archive };
  draw(); show();
}
/** Add (slug = null) or edit a category. opts.group: its meta category; opts.onSaved(slug): called after adding. */
export function openCategoryForm(slug, opts = {}) {
  view = { mode: 'cat', slug, group: opts.group || '', onSaved: opts.onSaved || null, standalone: !!opts.onSaved };
  draw(); show();
}
export function openGroupForm(id) { view = { mode: 'group', id: id || null }; draw(); show(); }

/** Called by app.js on every data change: the list redraws (counts, a change from another device); forms don't. */
export function refresh() {
  if (!dlg()?.open || view.mode !== 'list') return;
  draw();
}

function draw() {
  const d = dlg();
  if (view.mode === 'list') {
    const sig = JSON.stringify([store.data.groups, store.data.courses, store.data.tasks.map((t) => [t.course, t.status]), store.canSaveCategories, view.archiveOpen]);
    if (sig === lastSig && d.innerHTML) return;
    lastSig = sig;
    d.innerHTML = listHtml();
  } else {
    lastSig = '';
    d.innerHTML = view.mode === 'group' ? groupFormHtml() : catFormHtml();
    if (view.mode === 'cat') fillCalendarChoices($('form', d));
  }
}

function head(title, back) {
  return `<header class="sheet-head">
    ${back ? `<button type="button" class="icon-btn back" data-back aria-label="חזרה">${ICON.back}</button>` : ''}
    <h2 tabindex="-1" autofocus>${esc(title)}</h2>
    <button type="button" class="icon-btn" data-close aria-label="סגור">${ICON.close}</button>
  </header>`;
}

function countOf(n, k) { return n === 1 ? k.one : `${n} ${k.children}`; }
function openLabel(n) { return n.open ? (n.open === 1 ? 'פתוחה אחת' : `${n.open} פתוחות`) : n.all ? 'אין פתוחות' : 'אין משימות'; }
function tasksLabel(n) { return n === 1 ? 'משימה אחת' : `${n} משימות`; }
function since(date) { return date ? ` מ-${shortDate(date)}.${date.slice(0, 4)}` : ''; }

function listHtml() {
  const can = store.canSaveCategories;
  const count = counts();
  const groups = activeGroups();
  const groupHtml = (g) => {
    const k = kindOf(g);
    const cats = categoriesOf(g);
    const open = cats.reduce((s, c) => s + count(c.slug).open, 0);
    const editable = can && !g.implicit;
    return `<section class="cg">
      <div class="cg-head">
        <div class="cg-title"><b>${esc(g.name)}</b><small>${g.implicit ? '' : `<span class="tag">${k.label}</span>`}${countOf(cats.length, k)} · ${open ? `${open === 1 ? 'משימה פתוחה אחת' : `${open} משימות פתוחות`}` : 'אין משימות פתוחות'}</small></div>
        ${editable ? `<button type="button" class="btn ghost sm" data-edit-group="${esc(g.id)}">עריכה</button>` : ''}
      </div>
      ${cats.length ? `<ul class="cg-cats">${cats.map((c) => `<li><button type="button" class="cg-cat" data-edit-cat="${esc(c.slug)}" style="--c:${esc(c.color)}" ${can ? '' : 'disabled'}>
          <i></i><span class="n">${esc(c.name_he || c.slug)}</span><small>${openLabel(count(c.slug))}</small>${can ? ICON.back.replace('<svg', '<svg class="go"') : ''}</button></li>`).join('')}</ul>`
        : `<p class="hint small cg-empty">עוד אין כאן ${k.children}.</p>`}
      ${editable ? `<button type="button" class="linkish cg-add" data-add-cat="${esc(g.id)}">+ ${k.child}</button>` : ''}
    </section>`;
  };
  // the archive: archived meta categories, and archived categories of meta categories that are not archived
  const arGroups = allGroups().filter((g) => !isActive(g)).sort((a, b) => String(b.archived_at).localeCompare(String(a.archived_at)));
  const arCats = store.data.courses.filter((c) => !isActive(c) && isActive(groupOf(c)))
    .sort((a, b) => String(b.archived_at).localeCompare(String(a.archived_at)));
  const n = arGroups.length + arCats.length;
  const arItem = (title, sub, filter, restore, color) => `<li class="ar-item" ${color ? `style="--c:${esc(color)}"` : ''}>
      <div class="ar-text"><b>${color ? '<i></i>' : ''}${esc(title)}</b><small>${esc(sub)}</small></div>
      <div class="ar-acts"><button type="button" class="btn ghost sm" data-view="${esc(filter)}">הצג משימות</button>
        ${can ? `<button type="button" class="btn ghost sm" ${restore}>שחזר</button>` : ''}</div></li>`;
  const archive = `<details class="archive" ${view.archiveOpen ? 'open' : ''} data-archive-box>
      <summary>${ICON.archive}<span>ארכיון</span><span class="count">${n}</span>${ICON.chevron}</summary>
      ${n ? `<ul class="ar-list">
        ${arGroups.map((g) => {
          const cats = categoriesOf(g, { archived: true });
          const t = cats.reduce((s, c) => s + count(c.slug).all, 0);
          return arItem(g.name, `${kindOf(g).label} · בארכיון${since(g.archived_at)} · ${countOf(cats.length, kindOf(g))} · ${tasksLabel(t)}`, `g:${g.id}`, `data-restore-group="${esc(g.id)}"`, '');
        }).join('')}
        ${arCats.map((c) => arItem(c.name_he || c.slug, `${groupOf(c).implicit ? '' : `מתוך ${groupOf(c).name} · `}בארכיון${since(c.archived_at)} · ${tasksLabel(count(c.slug).all)}`, c.slug, `data-restore-cat="${esc(c.slug)}"`, c.color)).join('')}
      </ul>` : '<p class="hint small">אין כלום בארכיון. כשסמסטר נגמר או פרויקט מסתיים — פתח אותו ובחר „העבר לארכיון”.</p>'}
    </details>`;
  return `<div class="sheet-form cat-sheet">
    ${head('קטגוריות', false)}
    <div class="sheet-body">
      ${can ? '' : `<div class="notice t-warn" role="status"><div class="n-text"><b>צריך לעדכן את השרת</b> <span>כדי להוסיף קטגוריות ולהעביר לארכיון צריך לעדכן את Apps Script לגרסה החדשה (SETUP.md).</span></div></div>`}
      <p class="hint small">משימה שייכת לקטגוריה (למשל קורס), וקטגוריה — לקטגוריית־על: סמסטר, פרויקט או משימות יומיות. מה שכבר לא רלוונטי עובר לארכיון: נעלם מהמסכים עם המשימות שלו, ושום דבר לא נמחק.</p>
      ${groups.map(groupHtml).join('') || '<p class="hint">עוד אין קטגוריות.</p>'}
      ${can ? '<button type="button" class="btn ghost add-group" data-add-group>+ קטגוריית־על חדשה</button>' : ''}
      ${archive}
    </div>
  </div>`;
}

/* --------------------------------------------------- meta category form ---- */

function groupFormHtml() {
  const g = view.id ? store.group(view.id) : null;
  const kind = g ? g.kind || 'general' : view.kind || 'semester';
  const cats = g ? categoriesOf(g, { archived: true }) : [];
  const count = counts();
  const tasks = cats.reduce((s, c) => s + count(c.slug).all, 0);
  const open = cats.reduce((s, c) => s + count(c.slug).open, 0);
  const unused = cats.every((c) => !count(c.slug).all && !inboxUses(c.slug));
  const k = KIND[kind] || KIND.general;
  return `<form class="sheet-form" novalidate data-form="group">
    ${head(g ? 'עריכת קטגוריית־על' : 'קטגוריית־על חדשה', true)}
    <div class="sheet-body">
      <label class="field"><span>שם</span>
        <input name="name" required autocomplete="off" value="${esc(g ? g.name : '')}" placeholder="למשל: סמסטר אביב תשפ״ז, פרויקט גמר, משימות יומיות" ${g ? '' : 'autofocus'}></label>
      <fieldset class="field"><legend>סוג</legend>
        <div class="segmented three">
          ${Object.entries(KIND).map(([key, v]) => `<label><input type="radio" name="kind" value="${key}" ${kind === key ? 'checked' : ''}><span>${v.label}</span></label>`).join('')}
        </div></fieldset>
      ${g ? '' : `<p class="hint small" data-kind-hint>${kindHint(kind)}</p>`}
      ${g ? archiveBox({ archived: !isActive(g), at: g.archived_at, open,
        when: 'כשהסמסטר נגמר או שהפרויקט הסתיים',
        text: `${k.the} וכל מה ש${k.inIt.slice(1)} (${countOf(cats.length, k)}, ${tasksLabel(tasks)}) ייעלמו מהמסכים.` }) : ''}
    </div>
    <footer class="sheet-foot">
      ${g && unused ? '<button type="button" class="btn danger ghost" data-delete>מחיקה</button>' : '<span></span>'}
      <div class="foot-actions">
        <button type="button" class="btn ghost" data-back>ביטול</button>
        <button type="submit" class="btn primary">שמירה</button>
      </div>
    </footer>
  </form>`;
}

function kindHint(kind) {
  return kind === 'semester' ? 'אחרי השמירה תוסיף לה את הקורסים.'
    : 'תיווצר בה קטגוריה אחת באותו שם, כך שאפשר מיד לשייך אליה משימות. אפשר להוסיף עוד קטגוריות אחר כך.';
}

/** "Archive" / "restore" box at the bottom of a form. */
function archiveBox({ archived, at, when, text, open }) {
  if (archived) {
    return `<section class="arch-box is-archived">
      <div><b>${ICON.archive}בארכיון${since(at)}</b><p class="hint small">מוסתר מהמסכים יחד עם המשימות. אפשר להחזיר אותו בכל רגע.</p></div>
      <button type="button" class="btn ghost" data-restore>שחזר מהארכיון</button>
    </section>`;
  }
  return `<section class="arch-box">
    <div><b>${ICON.archive}העבר לארכיון</b><p class="hint small">${esc(when)}: ${esc(text)} שום דבר לא נמחק — אפשר לראות ולשחזר מ„ארכיון”.${open ? ` <b class="warn-text">${open === 1 ? 'משימה אחת עדיין פתוחה' : `${open} משימות עדיין פתוחות`}.</b>` : ''}</p></div>
    <button type="button" class="btn ghost" data-archive>העבר לארכיון</button>
  </section>`;
}

/* ------------------------------------------------------- category form ---- */

function nextColor() {
  const used = new Set(store.data.courses.filter((c) => !store.categoryArchived(c.slug)).map((c) => String(c.color).toUpperCase()));
  return PALETTE.find((p) => !used.has(p.toUpperCase())) || PALETTE[store.data.courses.length % PALETTE.length];
}
function nextSort(rows) { return String(rows.reduce((m, r) => Math.max(m, sortNum(r.sort) < 1e9 ? sortNum(r.sort) : 0), 0) + 1); }

/** Adds a category (fields: name_he, group, …); fills colour, order and the empty columns. Returns its slug. */
export function createCategory(fields) {
  const row = { slug: '', short_he: '', color: nextColor(), number: '', moodle_course_id: '', moodle_news_forum_id: '',
    moodle_folder: '', ...fields, active: fields.active === 'FALSE' ? 'FALSE' : 'TRUE' };
  row.archived_at = row.active === 'FALSE' ? todayIL() : '';
  row.sort = row.sort || nextSort(store.data.courses.filter((x) => x.group === row.group));
  return store.saveCategory(row);
}

/**
 * Adds a meta category (fields: name, kind). A project / general one starts with one category of the same name, so
 * tasks can go into it at once. Returns {id, slug} (slug = that first category, if any).
 */
export function createGroup(fields) {
  const kind = KIND[fields.kind] ? fields.kind : 'general';
  const active = fields.active === 'FALSE' ? 'FALSE' : 'TRUE';
  const id = store.saveGroup({ name: fields.name, kind, active, sort: nextSort(store.data.groups), archived_at: active === 'FALSE' ? todayIL() : '' });
  const slug = kind === 'semester' ? '' : createCategory({ name_he: fields.name, group: id, sort: '1' });
  return { id, slug };
}

function catFormHtml() {
  const c = view.slug ? store.course(view.slug) : null;
  const gid = c ? (groupOf(c).implicit ? '' : c.group) : view.group || (activeGroups().find((g) => !g.implicit) || {}).id || '';
  const g = gid ? store.group(gid) : null;
  const k = kindOf(g);
  const color = c ? c.color : nextColor();
  const colors = PALETTE.includes(String(color).toUpperCase()) || !color ? PALETTE : [color, ...PALETTE];
  const showMoodle = (g && g.kind === 'semester') || (c && (c.moodle_course_id || c.number || c.moodle_folder));
  const options = allGroups().filter((x) => !x.implicit && (isActive(x) || x.id === gid));
  const count = c ? counts()(c.slug) : { all: 0, open: 0 };
  const unused = c && !count.all && !inboxUses(c.slug);
  const sample = (store.data.courses.find((x) => x.moodle_folder && x.group === gid) || store.data.courses.find((x) => x.moodle_folder) || {}).moodle_folder || '';
  const exampleFolder = sample.includes('/') ? `${sample.replace(/[^/]*$/, '')}…` : '';
  return `<form class="sheet-form" novalidate data-form="cat">
    ${head(c ? `עריכת ${k.child}` : k.newChild, !view.standalone)}
    <div class="sheet-body">
      <label class="field"><span>שם</span>
        <input name="name_he" required autocomplete="off" value="${esc(c ? c.name_he : '')}" placeholder="${g && g.kind === 'semester' ? 'למשל: סטטיסטיקה 2' : 'למשל: בית, סידורים, כתיבה'}" ${c ? '' : 'autofocus'}></label>
      <label class="field"><span>שם קצר לתוויות (לא חובה)</span>
        <input name="short_he" autocomplete="off" value="${esc(c ? c.short_he : '')}" placeholder="כמו השם"></label>
      ${c ? '' : `<label class="field"><span>שם באנגלית (לא חובה)</span>
        <input name="name_en" dir="ltr" autocomplete="off" placeholder="Statistics 2"></label>
        <p class="hint small field-hint">משמש כמזהה קבוע בגיליון (למשל statistics-2), כדי ש-AI יזהה את הקטגוריה. אם ריק — נוצר מזהה אוטומטי.</p>`}
      <label class="field"><span>קטגוריית־על</span>
        <select name="group">${options.map((x) => `<option value="${esc(x.id)}" ${x.id === gid ? 'selected' : ''}>${esc(x.name)}${isActive(x) ? '' : ' (בארכיון)'}</option>`).join('')}</select></label>
      <fieldset class="field"><legend>צבע</legend>
        <div class="swatches">${colors.map((p) => `<label style="--c:${esc(p)}"><input type="radio" name="color" value="${esc(p)}" ${String(p).toUpperCase() === String(color).toUpperCase() ? 'checked' : ''} aria-label="${esc(p)}"><span></span></label>`).join('')}</div>
      </fieldset>
      ${calendarFieldHtml(c, g)}
      <details class="moodle-box" data-moodle ${showMoodle ? '' : 'hidden'} ${c && (c.moodle_course_id || c.moodle_folder) ? '' : 'open'}>
        <summary>מודל ו-Drive (לקורס, לא חובה)</summary>
        <div class="moodle-fields">
          <label class="field"><span>מספר קורס</span><input name="number" dir="ltr" inputmode="numeric" autocomplete="off" value="${esc(c ? c.number : '')}" placeholder="00960411"></label>
          <label class="field"><span>אתר הקורס במודל</span><input name="moodle" dir="ltr" autocomplete="off" value="${esc(c && c.moodle_course_id ? `${MOODLE}/course/view.php?id=${c.moodle_course_id}` : '')}" placeholder="${MOODLE}/course/view.php?id=…"></label>
          <p class="hint small field-hint">הדבק את הקישור לדף הקורס. כך הודעות ומטלות של הקורס ייכנסו ל„הודעות”.</p>
          <label class="field"><span>תיקיית הקורס ב-Drive</span><input name="moodle_folder" dir="ltr" autocomplete="off" value="${esc(c ? c.moodle_folder : '')}" placeholder="${esc(exampleFolder || 'Winter Semester 2026-2027/Moodle/…')}"></label>
          <p class="hint small field-hint">הנתיב בתוך Technion Studies (כמו אצל הקורסים האחרים). כשהוא ממולא, הודעות הקורס נשמרות לשם גם כשהמחשב כבוי.</p>
        </div>
      </details>
      <p class="msg err form-msg" data-msg></p>
      ${c ? archiveBox({ archived: !isActive(c), at: c.archived_at, open: count.open,
        when: k.m ? 'כשהקורס נגמר' : 'כשהקטגוריה כבר לא רלוונטית',
        text: `${k.m ? 'הקורס והמשימות שלו' : 'הקטגוריה והמשימות שלה'}${count.all ? ` (${tasksLabel(count.all)})` : ''} ייעלמו מהמסכים.` })
        + (isActive(c) && !isActive(groupOf(c)) ? '<p class="hint small">קטגוריית־העל שלה בארכיון, ולכן גם היא מוסתרת.</p>' : '') : ''}
      ${c ? `<p class="hint small slug">מזהה בגיליון: <bdi dir="ltr">${esc(c.slug)}</bdi></p>` : ''}
    </div>
    <footer class="sheet-foot">
      ${unused ? '<button type="button" class="btn danger ghost" data-delete>מחיקה</button>' : '<span></span>'}
      <div class="foot-actions">
        <button type="button" class="btn ghost" data-back>ביטול</button>
        <button type="submit" class="btn primary">שמירה</button>
      </div>
    </footer>
  </form>`;
}

/** The "which Google Calendar" field of the category form (backend v8+). */
function calendarFieldHtml(c, g) {
  if (!hasCalendarPerCategory()) return '';
  const own = c ? String(c.calendar || '').trim() : '';
  const off = store.setting('sync_blocks_to_calendar') !== 'TRUE';
  return `<label class="field"><span>יומן Google לבלוקי עבודה</span>
      <select name="calendar" data-cal-pick>
        <option value="" ${own ? '' : 'selected'}>${esc(defaultOptionLabel(g))}</option>
        ${own ? `<option value="${esc(own)}" selected>${esc(own)}</option>` : ''}
      </select></label>
    <p class="hint small field-hint">${off ? 'הסנכרון ליומן כבוי כרגע (⚙️ הגדרות → יומן Google).'
      : 'הבלוקים המאושרים של המשימות כאן נכנסים ליומן הזה. כשמחליפים יומן, הבלוקים עוברים אליו.'}</p>`;
}
function defaultOptionLabel(g) {
  return `ברירת המחדל${g && g.kind === 'semester' ? ' לקורסים' : ''}: ${calLabel(defaultCalendar(g))}`;
}

/** Fills the category form's calendar list with Bahr's calendars (keeps the current choice). */
async function fillCalendarChoices(form) {
  const sel = form && $('[data-cal-pick]', form);
  if (!sel || !store.configured) return;
  try {
    if (!calendarList) calendarList = (await store.action('calendars')).calendars || [];
  } catch { return; } // offline / older backend: only the current choice is shown
  if (!sel.isConnected) return;
  const current = sel.value;
  const names = calendarList.filter((x) => x.name !== APP_CALENDAR)
    .map((x) => ({ value: x.name, label: x.primary ? `${x.name} (היומן הראשי)` : x.name }));
  if (current && current !== APP_CALENDAR && !names.some((n) => n.value === current)) names.unshift({ value: current, label: `${current} (לא נמצא)` });
  names.push({ value: APP_CALENDAR, label: `יומן נפרד: ${APP_CALENDAR}` });
  sel.innerHTML = `<option value="">${esc(sel.options[0].textContent)}</option>`
    + names.map((n) => `<option value="${esc(n.value)}">${esc(n.label)}</option>`).join('');
  sel.value = current;
}

/** "575" or a course link (…/course/view.php?id=575#section-2) → "575"; '' → ''; null = not understood. */
export function moodleId(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const m = /[?&]id=(\d+)/.exec(s) || /^(\d+)$/.exec(s);
  return m ? m[1] : null;
}

/** A readable, unique slug from an English name ('' when there is nothing to make it from). */
export function slugFrom(en) {
  const base = String(en || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (!base) return '';
  let s = base, n = 2;
  while (store.course(s) || store.group(s)) s = `${base}-${n++}`;
  return s;
}

/* --------------------------------------------------------------- events ---- */

function back() {
  if (view.standalone) { dlg().close(); return; }
  view = { mode: 'list', archiveOpen: view.archiveOpen };
  draw();
}

function setFilterIfShowing(values) {
  if (values.includes(store.ui('course', 'all'))) store.setUi('course', 'all');
}

function onChange(e) {
  const form = e.target.form;
  if (!form) return;
  if (e.target.name === 'kind' && form.dataset.form === 'group') {
    const h = $('[data-kind-hint]', form);
    if (h) h.textContent = kindHint(e.target.value);
  }
  if (e.target.name === 'group' && form.dataset.form === 'cat') {
    const g = store.group(e.target.value);
    const box = $('[data-moodle]', form);
    if (box && g && g.kind === 'semester') box.hidden = false;
    const def = $('[data-cal-pick] option[value=""]', form); // the default calendar depends on the meta category
    if (def) def.textContent = defaultOptionLabel(g);
  }
}

function onClick(e) {
  const t = e.target;
  if (t.closest('[data-close]')) { dlg().close(); return; }
  if (t.closest('[data-back]')) { back(); return; }
  const sum = t.closest('[data-archive-box] > summary');
  if (sum) { // (the browser toggles it)
    view.archiveOpen = !sum.parentElement.open;
    if (view.archiveOpen) setTimeout(() => sum.parentElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
    return;
  }
  const b = (sel) => t.closest(sel);
  let el;
  if (b('[data-add-group]')) { view = { mode: 'group', id: null, archiveOpen: view.archiveOpen }; draw(); return; }
  if ((el = b('[data-edit-group]'))) { view = { mode: 'group', id: el.dataset.editGroup, archiveOpen: view.archiveOpen }; draw(); return; }
  if ((el = b('[data-add-cat]'))) { view = { mode: 'cat', slug: null, group: el.dataset.addCat, archiveOpen: view.archiveOpen }; draw(); return; }
  if ((el = b('[data-edit-cat]'))) { view = { mode: 'cat', slug: el.dataset.editCat, archiveOpen: view.archiveOpen }; draw(); return; }
  if ((el = b('[data-view]'))) { dlg().close(); ui.showFilter(el.dataset.view); return; }
  if ((el = b('[data-restore-group]'))) { restoreGroup(el.dataset.restoreGroup); return; }
  if ((el = b('[data-restore-cat]'))) { restoreCat(el.dataset.restoreCat); return; }
  if (b('[data-archive]')) { if (view.mode === 'group') archiveGroup(view.id); else archiveCat(view.slug); return; }
  if (b('[data-restore]')) { if (view.mode === 'group') restoreGroup(view.id); else restoreCat(view.slug); return; }
  if (b('[data-delete]')) { if (view.mode === 'group') deleteGroup(view.id); else deleteCat(view.slug); }
}

function onSubmit(e) {
  e.preventDefault();
  const form = e.target;
  if (form.dataset.form === 'group') saveGroupForm(form); else saveCatForm(form);
}

function saveGroupForm(form) {
  const name = form.name.value.trim();
  if (!name) { form.name.classList.add('invalid'); form.name.focus(); return; }
  const kind = form.kind.value || 'general';
  if (view.id) {
    const g = store.group(view.id);
    const patch = {};
    if (name !== g.name) patch.name = name;
    if (kind !== (g.kind || 'general')) patch.kind = kind;
    if (Object.keys(patch).length) { store.saveGroup({ id: g.id, ...patch }); ui.toast('נשמר'); }
    back();
    return;
  }
  const { id } = createGroup({ name, kind });
  if (kind === 'semester') {
    ui.toast(`נוצר: „${name}”. עכשיו הוסף את הקורסים`);
    view = { mode: 'cat', slug: null, group: id, archiveOpen: view.archiveOpen };
    draw();
    return;
  }
  ui.toast(`נוצר: „${name}”`);
  back();
}

function saveCatForm(form) {
  const msg = $('[data-msg]', form);
  const name = form.name_he.value.trim();
  if (!name) { form.name_he.classList.add('invalid'); form.name_he.focus(); return; }
  const mid = form.moodle ? moodleId(form.moodle.value) : '';
  if (mid === null) { msg.textContent = 'לא הצלחתי למצוא את מספר הקורס בקישור. הדבק את הקישור לדף הקורס במודל (…/course/view.php?id=…).'; form.moodle.focus(); return; }
  const fields = {
    name_he: name, short_he: form.short_he.value.trim(), group: form.group.value, color: form.color.value,
    number: form.number.value.trim(), moodle_course_id: mid,
    moodle_folder: form.moodle_folder.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/^Technion Studies\//, ''),
  };
  if (form.calendar) fields.calendar = form.calendar.value;
  if (!fields.group) { msg.textContent = 'בחר קטגוריית־על.'; return; }
  if (view.slug) {
    const c = store.course(view.slug);
    const patch = {};
    for (const [k, v] of Object.entries(fields)) if ((c[k] || '') !== v) patch[k] = v;
    if (patch.group) patch.sort = nextSort(store.data.courses.filter((x) => x.group === patch.group));
    if (Object.keys(patch).length) { store.saveCategory({ slug: c.slug, ...patch }); ui.toast('נשמר'); }
    back();
    return;
  }
  const slug = createCategory({ slug: slugFrom(form.name_en.value), ...fields });
  const g = store.group(fields.group);
  ui.toast(g ? `נוסף ל„${g.name}”: „${name}”` : `נוסף: „${name}”`);
  if (view.onSaved) { const cb = view.onSaved; view.onSaved = null; dlg().close(); cb(slug); return; }
  back();
}

/* -------------------------------------------------------- archive / delete ---- */

export function archiveGroup(id) {
  const g = store.group(id);
  if (!g) return;
  const cats = categoriesOf(g, { archived: true });
  const count = counts();
  const open = cats.reduce((s, c) => s + count(c.slug).open, 0);
  const moodle = cats.some((c) => c.moodle_course_id && isActive(c));
  const k = kindOf(g);
  const t = cats.reduce((s, c) => s + count(c.slug).all, 0);
  if (!confirm(`להעביר את „${g.name}” לארכיון?\n\n${k.the} וכל מה ש${k.inIt.slice(1)} (${countOf(cats.length, k)}, ${tasksLabel(t)}) ייעלמו מהמסכים. שום דבר לא נמחק, ואפשר לשחזר בכל רגע מ„קטגוריות” ← „ארכיון”.${open ? `\n\nשים לב: ${open === 1 ? 'משימה אחת עדיין פתוחה' : `${open} משימות עדיין פתוחות`}.` : ''}${moodle ? '\nבדיקת ההודעות במודל לקורסים שבה תיפסק.' : ''}`)) return;
  const before = { id, active: g.active || 'TRUE', archived_at: g.archived_at || '' };
  store.saveGroup({ id, active: 'FALSE', archived_at: todayIL() });
  setFilterIfShowing([`g:${id}`, ...cats.map((c) => c.slug)]);
  ui.toast(`הועבר לארכיון: „${g.name}”`, { label: 'בטל', fn: () => store.saveGroup(before) });
  view = { mode: 'list', archiveOpen: view.archiveOpen };
  draw();
}

export function archiveCat(slug) {
  const c = store.course(slug);
  if (!c) return;
  const n = counts()(slug);
  const m = kindOf(groupOf(c)).m;
  if (!confirm(`להעביר את „${c.name_he}” לארכיון?\n\n${m ? 'הקורס והמשימות שלו' : 'הקטגוריה והמשימות שלה'} ייעלמו מהמסכים. שום דבר לא נמחק, ואפשר לשחזר בכל רגע מ„קטגוריות” ← „ארכיון”.${n.open ? `\n\nשים לב: ${n.open === 1 ? 'משימה אחת עדיין פתוחה' : `${n.open} משימות עדיין פתוחות`}.` : ''}${c.moodle_course_id ? '\nבדיקת ההודעות במודל לקורס הזה תיפסק.' : ''}`)) return;
  const before = { slug, active: c.active || 'TRUE', archived_at: c.archived_at || '' };
  store.saveCategory({ slug, active: 'FALSE', archived_at: todayIL() });
  setFilterIfShowing([slug]);
  ui.toast(`הועבר לארכיון: „${nameOf(c)}”`, { label: 'בטל', fn: () => store.saveCategory(before) });
  view = { mode: 'list', archiveOpen: view.archiveOpen };
  draw();
}

function restoreGroup(id) {
  const g = store.group(id);
  if (!g) return;
  store.saveGroup({ id, active: 'TRUE', archived_at: '' });
  ui.toast(`שוחזר מהארכיון: „${g.name}”`, { label: 'בטל', fn: () => store.saveGroup({ id, active: 'FALSE', archived_at: g.archived_at || todayIL() }) });
  if (view.mode !== 'list') view = { mode: 'list', archiveOpen: view.archiveOpen };
  draw();
}

function restoreCat(slug) {
  const c = store.course(slug);
  if (!c) return;
  store.saveCategory({ slug, active: 'TRUE', archived_at: '' });
  ui.toast(`שוחזר מהארכיון: „${nameOf(c)}”`, { label: 'בטל', fn: () => store.saveCategory({ slug, active: 'FALSE', archived_at: c.archived_at || todayIL() }) });
  if (view.mode !== 'list') view = { mode: 'list', archiveOpen: view.archiveOpen };
  draw();
}

function deleteCat(slug) {
  const c = store.course(slug);
  if (!c || counts()(slug).all || inboxUses(slug)) return;
  if (!confirm(`למחוק את „${c.name_he}”? אין ${kindOf(groupOf(c)).m ? 'בו' : 'בה'} משימות.`)) return;
  const copy = { ...c };
  store.deleteCategory(slug);
  setFilterIfShowing([slug]);
  ui.toast(`נמחק: „${nameOf(c)}”`, { label: 'בטל', fn: () => store.saveCategory(copy) });
  back();
}

function deleteGroup(id) {
  const g = store.group(id);
  if (!g) return;
  const cats = categoriesOf(g, { archived: true });
  const count = counts();
  if (cats.some((c) => count(c.slug).all || inboxUses(c.slug))) return;
  if (!confirm(`למחוק את „${g.name}”?${cats.length ? ` (${countOf(cats.length, kindOf(g))} בלי משימות יימחקו איתה)` : ''}`)) return;
  const copies = cats.map((c) => ({ ...c }));
  const copy = { ...g };
  cats.forEach((c) => store.deleteCategory(c.slug)); // (first the categories: the backend keeps a meta category that still has some)
  store.deleteGroup(id);
  setFilterIfShowing([`g:${id}`, ...cats.map((c) => c.slug)]);
  ui.toast(`נמחק: „${g.name}”`, { label: 'בטל', fn: () => { store.saveGroup(copy); copies.forEach((c) => store.saveCategory(c)); } });
  view = { mode: 'list', archiveOpen: view.archiveOpen };
  draw();
}
