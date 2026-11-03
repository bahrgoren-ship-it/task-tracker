// Main UI: tasks screen, task editor, timer, settings. Plain JS, no build step.
import { store } from './store.js';
import { bucketOf, dueLabel, todayIL, addDays, shortDate, weekday, fmtMinutes, fmtClock } from './dates.js';
import * as timer from './timer.js';
import * as planner from './planner.js';
import * as inbox from './inbox.js';

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/10qLYln2zUiMo7dEI3xZ8pj4ncGX7TRmATZNuZfvUfWM/edit';

const STATUS = {
  todo: { label: 'לא התחיל', next: 'in_progress' },
  in_progress: { label: 'בתהליך', next: 'done' },
  done: { label: 'הושלם', next: 'todo' },
  cancelled: { label: 'בוטל', next: 'todo' },
};
const SECTIONS = [
  ['overdue', 'באיחור'], ['today', 'היום'], ['tomorrow', 'מחר'], ['week', 'השבוע הקרוב'],
  ['later', 'בהמשך'], ['nodate', 'ללא תאריך'], ['done', 'הושלמו ובוטלו'],
];
const SCREENS = { tasks: 'משימות', planner: 'תכנון', inbox: 'הודעות' };
const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5-10-6.5Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------ boot ---- */

function boot() {
  // A setup link like ...?api=<url>&key=<key> configures this device in one tap.
  const qs = new URLSearchParams(location.search);
  if (qs.get('api') && qs.get('key')) {
    store.setConfig({ url: qs.get('api'), key: qs.get('key') });
    history.replaceState(null, '', location.pathname);
    toast('המכשיר חובר');
  }

  store.subscribe(render);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#syncPill').addEventListener('click', () => (store.configured ? store.refresh() : openSettings()));
  $('#addBtn').addEventListener('click', () => openEditor(null));
  $('#filters').addEventListener('click', onFilterClick);
  $('#main').addEventListener('click', onMainClick);
  $('#timerBar').addEventListener('click', onTimerBarClick);
  document.querySelector('.tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (b && !b.disabled) showTab(b.dataset.tab);
  });
  planner.initPlanner($('#planner'), { openEditor, openTimer, toast, onRender: () => renderSummary() });
  inbox.initInbox($('#inbox'), { openEditor, toast });
  showTab(store.ui('tab', 'tasks'));
  // the "new task" button shrinks to a round button while scrolling, so it covers less of the list
  let lastY = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    $('#addBtn').classList.toggle('compact', y > 40 && y >= lastY);
    lastY = y;
  }, { passive: true });
  document.addEventListener('timer:phase', (e) => toast(`${e.detail.title} · ${e.detail.body}`));
  document.addEventListener('timer:stopped', (e) => toast(e.detail.minutes
    ? `נשמרו ${e.detail.minutes} דק׳ ל„${store.task(e.detail.task_id)?.title || ''}”` : 'פחות מדקה — לא נשמר זמן'));
  setInterval(onSecond, 1000);

  window.addEventListener('online', () => store.refresh());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) store.refresh(); });
  setInterval(() => { if (!document.hidden) store.refresh(); }, 120000);

  render();
  if (store.configured) store.refresh(); else openSettings();

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { // a new version was installed: show it
      if (hadController && !reloaded && !document.querySelector('dialog[open]')) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
  }
}

/* ---------------------------------------------------------- render ---- */

// Re-draw the list only when something visible changed, so a tap is never lost to a
// background sync re-rendering the cards under the finger.
let lastSig = '';
function showTab(name) {
  if (!['tasks', 'planner', 'inbox'].includes(name)) name = 'tasks';
  store.setUi('tab', name);
  document.body.dataset.tab = name;
  document.querySelectorAll('.tabbar [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('#main').hidden = name !== 'tasks';
  $('#filters').hidden = name !== 'tasks';
  $('#planner').hidden = name !== 'planner';
  $('#inbox').hidden = name !== 'inbox';
  $('#addBtn').hidden = name !== 'tasks';
  $('#addBtn').classList.remove('compact');
  $('#screenTitle').textContent = SCREENS[name];
  if (name === 'planner') planner.render(true);
  if (name === 'inbox') inbox.render(true);
  renderSummary();
  window.scrollTo(0, 0);
}

// The line under the screen title: what matters on the screen you're looking at.
function renderSummary() {
  const tab = document.body.dataset.tab;
  let text = '';
  if (!store.configured) text = '';
  else if (tab === 'planner') text = planner.summary();
  else if (tab === 'inbox') text = inbox.summary();
  else {
    const open = store.data.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    const overdue = open.filter((t) => bucketOf(t) === 'overdue').length;
    text = open.length ? `${open.length} פתוחות${overdue ? `, ${overdue} באיחור` : ''}` : 'אין משימות פתוחות';
  }
  const el = $('#summary');
  if (el.textContent !== text) el.textContent = text;
}

function render() {
  renderSync();
  renderTimerBar();
  planner.render();
  inbox.render();
  renderSummary();
  const n = store.inboxNew().length;
  const badge = $('#inboxBadge');
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = !n;
  if ($('#timerSheet').open) renderTimerSheet();
  const sig = JSON.stringify([store.data.tasks, store.data.sessions, store.setting('active_timer'), store.data.courses, store.ui('course', 'all'),
    store.ui('showDone', false), store.configured, store.status === 'syncing' && !store.data.tasks.length, todayIL()]);
  if (sig === lastSig) return;
  lastSig = sig;
  renderFilters();
  renderTasks();
}

function renderSync() {
  const pill = $('#syncPill');
  const pending = store.queue.length;
  let cls = 'ok', text = 'מסונכרן';
  if (!store.configured) { cls = 'warn'; text = 'לא מחובר'; }
  else if (store.status === 'syncing') { cls = 'busy'; text = 'מסנכרן…'; }
  else if (store.status === 'offline') { cls = 'warn'; text = pending ? `לא מקוון · ${pending} ממתינים` : 'לא מקוון'; }
  else if (store.status === 'error') { cls = 'err'; text = 'שגיאה'; }
  else if (pending) { cls = 'busy'; text = `${pending} ממתינים`; }
  if (store.isDemo) text += ' · הדגמה';
  pill.className = `sync-pill ${cls}`;
  pill.innerHTML = `<i></i>${esc(text)}`;
  pill.title = store.error ? `שגיאה: ${store.error}` : (store.lastSync ? `סונכרן לאחרונה: ${store.lastSync}` : '');
}

function activeCourses() {
  return store.data.courses.filter((c) => c.active !== 'FALSE');
}

function renderFilters() {
  const current = store.ui('course', 'all');
  const chips = [`<button class="chip ${current === 'all' ? 'on' : ''}" data-course="all">הכל</button>`];
  for (const c of activeCourses()) {
    chips.push(`<button class="chip ${current === c.slug ? 'on' : ''}" data-course="${esc(c.slug)}" style="--c:${esc(c.color)}"><i></i>${esc(c.short_he || c.name_he)}</button>`);
  }
  $('#filters').innerHTML = chips.join('');
}

function visibleTasks() {
  const course = store.ui('course', 'all');
  return store.data.tasks.filter((t) => course === 'all' || t.course === course);
}

function sortKey(t) { return `${t.due_date || '9999-99-99'} ${t.due_time || '99:99'} ${t.title}`; }

function renderTasks() {
  const main = $('#main');
  const tasks = visibleTasks();

  if (!store.configured) {
    main.innerHTML = `<div class="empty"><p>האפליקציה עוד לא מחוברת לגיליון.</p><button class="btn primary" data-action="settings">חיבור</button></div>`;
    return;
  }
  if (!store.data.tasks.length && store.status === 'syncing') {
    main.innerHTML = `<div class="empty"><p>טוען…</p></div>`;
    return;
  }

  const groups = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
  for (const t of tasks) groups[bucketOf(t)].push(t);
  const showDone = store.ui('showDone', false);

  let html = '';
  for (const [key, label] of SECTIONS) {
    const list = groups[key];
    if (!list.length) continue;
    list.sort((a, b) => (key === 'done' ? sortKey(b).localeCompare(sortKey(a)) : sortKey(a).localeCompare(sortKey(b))));
    if (key === 'done') {
      html += `<section class="group done-group">
        <button class="group-toggle" data-action="toggleDone" aria-expanded="${showDone}">
          <span class="lbl">${label}</span><span class="count">${list.length}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        ${showDone ? `<ul class="cards">${list.map(card).join('')}</ul>` : ''}
      </section>`;
    } else {
      html += `<section class="group g-${key}"><h2><span class="lbl">${label}</span>${groupDate(key)}<span class="count">${list.length}</span></h2>
        <ul class="cards">${list.map(card).join('')}</ul></section>`;
    }
  }
  if (!html) html = `<div class="empty"><p>${store.ui('course', 'all') === 'all' ? 'עוד אין משימות.' : 'אין משימות בקורס הזה.'}</p><button class="btn primary" data-action="new">משימה חדשה</button></div>`;
  else if (!tasks.some((t) => bucketOf(t) !== 'done')) html = `<div class="empty small"><p>אין משימות פתוחות 🎉</p></div>` + html;
  main.innerHTML = html;
}

// "היום" and "מחר" headings also show the actual day, like a diary page.
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function groupDate(key) {
  const d = key === 'today' ? todayIL() : key === 'tomorrow' ? addDays(todayIL(), 1) : '';
  return d ? `<span class="date">${DAY_NAMES[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${shortDate(d)}</span>` : '';
}

// The deadline shown at the end of a task's first line. The group heading already says the day for
// today / tomorrow, so there only the hour is shown.
function dueHtml(t, bucket) {
  if (!t.due_date) return '';
  let day = '';
  if (bucket === 'overdue') day = dueLabel(t.due_date, '');
  else if (bucket === 'week') day = `${weekday(t.due_date)} ${shortDate(t.due_date)}`;
  else if (bucket === 'later' || bucket === 'done') day = shortDate(t.due_date);
  if (!day && !t.due_time) return '';
  return `<span class="due ${bucket === 'overdue' ? 'late' : ''}" title="${esc(dueLabel(t.due_date, t.due_time))}">${day ? `<span>${esc(day)}</span>` : ''}${t.due_time ? `<b>${esc(t.due_time)}</b>` : ''}</span>`;
}

function card(t) {
  const c = store.course(t.course);
  const bucket = bucketOf(t);
  const links = (t.links || '').split('\n').filter((x) => x.trim()).length;
  const meta = [];
  if (c) meta.push(`<span class="course"><i></i>${esc(c.short_he || c.name_he)}</span>`);
  if (t.status === 'in_progress') meta.push(`<span class="state">בתהליך</span>`);
  if (t.status === 'cancelled') meta.push(`<span class="state">בוטל</span>`);
  const spent = store.spentMinutes(t.id);
  const est = Number(t.estimate_hours) || 0;
  if (spent || est) {
    const over = est && spent > est * 60;
    const pct = est ? Math.min(100, Math.round((spent / (est * 60)) * 100)) : 0;
    meta.push(`<span class="time ${over ? 'over' : ''}" title="זמן בפועל מתוך ההערכה">${est ? `<b class="bar"><i style="width:${pct}%"></i></b>` : ICON.clock}<span>${spent ? fmtMinutes(spent) : '0:00'}${est ? ` / ${fmtMinutes(est * 60)}` : ''}</span></span>`);
  }
  if (links) meta.push(`<span class="links" title="קישורים">${ICON.link}${links}</span>`);
  const active = timer.state();
  const running = active && active.task_id === t.id;
  const open = t.status !== 'done' && t.status !== 'cancelled';
  return `<li class="card s-${esc(t.status)} ${running ? 'timing' : ''}" data-id="${esc(t.id)}" style="--c:${esc(c ? c.color : '#8A8F98')}">
    <button class="status" data-action="cycle" aria-label="סטטוס: ${esc(STATUS[t.status]?.label || t.status)} — הקש לשינוי"><span></span></button>
    <div class="body" data-action="edit">
      <div class="line1"><span class="title">${esc(t.title)}</span>${dueHtml(t, bucket)}</div>
      ${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}
      ${t.notes ? `<div class="notes">${esc(t.notes)}</div>` : ''}
    </div>
    ${open || running ? `<button class="play" data-action="timer" aria-label="${running ? 'טיימר פעיל — פתח' : 'התחל טיימר'}">
      ${running ? '<span class="live"></span>' : ICON.play}</button>` : '<span class="play-gap"></span>'}
  </li>`;
}

/* ---------------------------------------------------------- events ---- */

function onFilterClick(e) {
  const b = e.target.closest('[data-course]');
  if (!b) return;
  store.setUi('course', b.dataset.course);
  render();
}

function onMainClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'settings') return openSettings();
  if (action === 'new') return openEditor(null);
  if (action === 'toggleDone') { store.setUi('showDone', !store.ui('showDone', false)); return render(); }
  const id = el.closest('[data-id]')?.dataset.id;
  if (!id) return;
  if (action === 'cycle') {
    const t = store.task(id);
    const next = STATUS[t.status]?.next || 'todo';
    store.saveTask({ id, status: next });
    if (next === 'done') toast(`„${t.title}” הושלם`, { label: 'בטל', fn: () => store.saveTask({ id, status: t.status }) });
  }
  if (action === 'edit') openEditor(id);
  if (action === 'timer') openTimer(id);
}

/* ---------------------------------------------------------- editor ---- */

// opts.prefill: values for a new task (e.g. from a Moodle message); opts.onSaved(newId) after creating it.
function openEditor(id, opts = {}) {
  const dlg = $('#editor');
  const t = id ? { ...store.task(id) } : {
    title: '', course: store.ui('course', 'all') === 'all' ? '' : store.ui('course', 'all'),
    status: 'todo', due_date: '', due_time: '', estimate_hours: '', notes: '', links: '', ...(opts.prefill || {}),
  };
  const today = todayIL();
  const courses = activeCourses();
  dlg.innerHTML = `<form method="dialog" class="sheet-form" novalidate>
    <header class="sheet-head">
      <h2 ${id ? 'tabindex="-1" autofocus' : ''}>${id ? 'עריכת משימה' : 'משימה חדשה'}</h2>
      <button type="button" class="icon-btn" data-close aria-label="סגור">${ICON.close}</button>
    </header>
    <div class="sheet-body">
      <label class="field"><span>שם המשימה</span>
        <input name="title" required autocomplete="off" value="${esc(t.title)}" placeholder="למשל: תרגיל בית 2" ${id ? '' : 'autofocus'}></label>

      <fieldset class="field"><legend>קורס</legend>
        <div class="chips wrap">
          <label class="chip"><input type="radio" name="course" value="" ${!t.course ? 'checked' : ''}><span>ללא</span></label>
          ${courses.map((c) => `<label class="chip" style="--c:${esc(c.color)}"><input type="radio" name="course" value="${esc(c.slug)}" ${t.course === c.slug ? 'checked' : ''}><span><i></i>${esc(c.short_he || c.name_he)}</span></label>`).join('')}
        </div></fieldset>

      <fieldset class="field"><legend>סטטוס</legend>
        <div class="segmented">
          ${Object.entries(STATUS).map(([k, v]) => `<label><input type="radio" name="status" value="${k}" ${t.status === k ? 'checked' : ''}><span>${v.label}</span></label>`).join('')}
        </div></fieldset>

      <div class="row">
        <label class="field grow"><span>תאריך הגשה</span><input type="date" name="due_date" value="${esc(t.due_date)}"></label>
        <label class="field"><span>שעה</span><input type="time" name="due_time" value="${esc(t.due_time)}"></label>
      </div>
      <div class="chips quick">
        <button type="button" class="chip" data-date="${today}">היום</button>
        <button type="button" class="chip" data-date="${addDays(today, 1)}">מחר</button>
        <button type="button" class="chip" data-date="${addDays(today, 7)}">בעוד שבוע</button>
        <button type="button" class="chip" data-date="">ללא תאריך</button>
      </div>

      <section class="time-box">
        <div class="row">
          <label class="field"><span>הערכת זמן (שעות)</span><input type="number" name="estimate_hours" min="0" step="0.25" inputmode="decimal" value="${esc(t.estimate_hours)}"></label>
          <div class="field"><span>זמן בפועל</span><div class="spent" id="spentLine"></div></div>
        </div>
        <div class="progress" id="spentBar"><i></i></div>
        ${id ? `<div class="sessions" id="sessionsBox"></div>
        <div class="add-time">
          <label class="field"><span>הוספת דקות</span><input type="number" name="add_minutes" min="1" step="5" inputmode="numeric" placeholder="45"></label>
          <label class="field"><span>בתאריך</span><input type="date" name="add_date" value="${today}"></label>
          <button type="button" class="btn ghost" data-addtime>הוסף</button>
        </div>
        <button type="button" class="btn ghost play-wide" data-starttimer>${ICON.play}התחל טיימר</button>` : ''}
      </section>

      <label class="field"><span>הערות / הנחיות</span><textarea name="notes" rows="3">${esc(t.notes)}</textarea></label>
      <label class="field"><span>קישורים (אחד בכל שורה)</span><textarea name="links" rows="2" dir="ltr">${esc(t.links)}</textarea></label>
      ${linkList(t.links)}
    </div>
    <footer class="sheet-foot">
      ${id ? '<button type="button" class="btn danger ghost" data-delete>מחיקה</button>' : '<span></span>'}
      <div class="foot-actions">
        <button type="button" class="btn ghost" data-close>ביטול</button>
        <button type="submit" class="btn primary">שמירה</button>
      </div>
    </footer>
  </form>`;

  const form = $('form', dlg);
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.querySelectorAll('[data-date]').forEach((b) => b.addEventListener('click', () => {
    form.due_date.value = b.dataset.date;
    if (!b.dataset.date) form.due_time.value = '';
  }));
  $('[data-delete]', dlg)?.addEventListener('click', () => {
    if (confirm(`למחוק את „${t.title}”? (אפשר גם לסמן "בוטל" במקום)`)) {
      store.deleteTask(id); dlg.close(); toast('המשימה נמחקה');
    }
  });
  form.addEventListener('submit', (e) => {
    const title = form.title.value.trim();
    if (!title) { e.preventDefault(); form.title.focus(); form.title.classList.add('invalid'); return; }
    const fd = new FormData(form);
    const patch = { title };
    for (const k of ['course', 'status', 'due_date', 'due_time', 'estimate_hours', 'notes', 'links']) {
      patch[k] = String(fd.get(k) ?? '').trim();
    }
    if (!patch.due_date) patch.due_time = '';
    if (id) {
      // send only what changed
      const orig = store.task(id);
      for (const k of Object.keys(patch)) if ((orig[k] || '') === patch[k]) delete patch[k];
      if (Object.keys(patch).length) { store.saveTask({ id, ...patch }); toast('נשמר'); }
    } else {
      if (opts.prefill?.source) patch.source = opts.prefill.source;
      if (opts.prefill?.moodle_ref) patch.moodle_ref = opts.prefill.moodle_ref;
      const newId = store.saveTask(patch);
      if (opts.onSaved) opts.onSaved(newId); else toast('המשימה נוספה');
    }
  });
  // time section
  const drawTime = () => {
    const spent = id ? store.spentMinutes(id) : 0;
    const est = Number(form.estimate_hours.value) || 0;
    const planned = id ? store.plannedMinutes(id) : 0;
    $('#spentLine', dlg).textContent = `${fmtMinutes(spent)} ש׳${est ? ` מתוך ${fmtMinutes(est * 60)}` : ''}${planned ? ` · מתוכנן ${fmtMinutes(planned)}` : ''}`;
    const bar = $('#spentBar', dlg);
    bar.hidden = !est;
    bar.classList.toggle('over', est > 0 && spent > est * 60);
    $('i', bar).style.width = `${Math.min(100, est ? (spent / (est * 60)) * 100 : 0)}%`;
    const box = $('#sessionsBox', dlg);
    if (box) {
      const list = store.sessionsOf(id);
      box.innerHTML = list.length ? `<div class="sessions-head">רישומי עבודה</div><ul>${list.slice(0, 30).map((x) => `
        <li><span class="k">${x.kind === 'pomodoro' ? '🍅' : x.kind === 'stopwatch' ? '⏱' : '✍️'}</span>
          <span class="d"><bdi dir="ltr">${esc(shortDate(x.start.slice(0, 10)))}${x.kind === 'manual' ? '' : ` · ${esc(x.start.slice(11))}${x.end ? `–${esc(x.end.slice(11))}` : ''}`}</bdi></span>
          <span class="m">${esc(x.minutes)} דק׳</span>
          <button type="button" class="x" data-delsession="${esc(x.id)}" aria-label="מחק רישום">×</button></li>`).join('')}</ul>` : '';
    }
  };
  drawTime();
  form.estimate_hours.addEventListener('input', drawTime);
  dlg.onclick = (e) => { // (onclick, not addEventListener: the dialog element is reused)
    const del = e.target.closest('[data-delsession]');
    if (del && confirm('למחוק את הרישום הזה?')) { store.deleteSession(del.dataset.delsession); drawTime(); }
  };
  $('[data-addtime]', dlg)?.addEventListener('click', () => {
    const m = Math.round(Number(form.add_minutes.value));
    if (!m || m < 1) { form.add_minutes.focus(); return; }
    const date = form.add_date.value || todayIL();
    store.saveSession({ task_id: id, start: `${date} 00:00`, end: '', minutes: String(m), kind: 'manual' });
    form.add_minutes.value = '';
    drawTime(); toast(`נוספו ${m} דק׳`);
  });
  $('[data-starttimer]', dlg)?.addEventListener('click', () => { dlg.close(); openTimer(id); });

  dlg.showModal();
}

function linkList(links) {
  const items = (links || '').split('\n').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
  if (!items.length) return '';
  return `<ul class="link-list">${items.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(prettyUrl(u))}</a></li>`).join('')}</ul>`;
}
function prettyUrl(u) {
  try { const x = new URL(u); return decodeURIComponent(x.hostname + x.pathname).slice(0, 70); } catch { return u; }
}

/* -------------------------------------------------------- settings ---- */

function openSettings() {
  const dlg = $('#settings');
  const cfg = store.cfg || { url: '', key: '' };
  const deviceLink = store.configured && !store.isDemo
    ? `${location.origin}${location.pathname}?api=${encodeURIComponent(cfg.url)}&key=${encodeURIComponent(cfg.key)}` : '';
  dlg.innerHTML = `<form method="dialog" class="sheet-form">
    <header class="sheet-head">
      <h2 tabindex="-1" autofocus>חיבור והגדרות</h2>
      <button type="button" class="icon-btn" data-close aria-label="סגור">${ICON.close}</button>
    </header>
    <div class="sheet-body">
      <p class="hint">האפליקציה שומרת את הנתונים בגיליון Google שלך. כדי לחבר מכשיר, הדבק את כתובת השרת (Web app URL) ואת המפתח שקיבלת בהתקנה — או פתח במכשיר את קישור ההגדרה.</p>
      <label class="field"><span>כתובת השרת</span><input name="url" dir="ltr" value="${esc(cfg.url === 'demo' ? '' : cfg.url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
      <label class="field"><span>מפתח</span><input name="key" dir="ltr" value="${esc(cfg.url === 'demo' ? '' : cfg.key)}" autocomplete="off"></label>
      <p class="msg" id="connMsg"></p>
      <div class="row wrap">
        <button type="button" class="btn primary" data-connect>חיבור</button>
        <button type="button" class="btn ghost" data-demo>נסה במצב הדגמה</button>
      </div>
      ${store.configured ? `<hr>
        <dl class="info">
          <div><dt>מצב</dt><dd>${store.isDemo ? 'הדגמה (נתונים רק במכשיר הזה)' : 'מחובר לגיליון'}</dd></div>
          <div><dt>סנכרון אחרון</dt><dd>${esc(store.lastSync || '—')}</dd></div>
          <div><dt>שינויים שממתינים לשליחה</dt><dd>${store.queue.length}</dd></div>
          ${store.error ? `<div><dt>שגיאה אחרונה</dt><dd dir="ltr">${esc(store.error)}</dd></div>` : ''}
        </dl>
        ${deviceLink ? `<button type="button" class="btn ghost" data-copy>העתק קישור הגדרה למכשיר נוסף</button>
          <p class="hint small">פתח את הקישור בטלפון / באייפד והמכשיר יתחבר. הקישור מכיל את המפתח — אל תשתף אותו.</p>` : ''}
        <hr>
        <h3 class="sub-h">יומן Google</h3>
        ${store.apiVersion && store.apiVersion < 3 ? '<p class="hint small">כדי להפעיל צריך קודם לעדכן את השרת (Apps Script) — ראה SETUP.md.</p>' : ''}
        <label class="check"><input type="checkbox" data-set="sync_deadlines_to_calendar" ${store.setting('sync_deadlines_to_calendar') === 'TRUE' ? 'checked' : ''}> להציג תאריכי הגשה ביומן „משימות – הגשות”</label>
        <label class="check"><input type="checkbox" data-set="sync_blocks_to_calendar" ${store.setting('sync_blocks_to_calendar') === 'TRUE' ? 'checked' : ''}> להציג בלוקי עבודה מאושרים ביומן „משימות – בלוקי עבודה” (דו-כיווני)</label>
        <p class="hint small">סנכרון אחרון: ${esc(store.setting('calendar_last_sync') || '—')}</p>
        <hr>
        <h3 class="sub-h">מודל</h3>
        <p class="hint small">מצב: <span dir="auto">${esc(store.setting('moodle_status') || 'לא מחובר')}</span>${store.setting('moodle_last_check') ? ` · נבדק ${esc(store.setting('moodle_last_check'))}` : ''}</p>
        <div class="row wrap">
          <label class="field grow"><span>Moodle token</span><input name="moodle_token" dir="ltr" autocomplete="off" placeholder="מתוך config.json → token"></label>
          <button type="button" class="btn ghost" data-moodle>חבר</button>
        </div>
        <p class="hint small">ה-token נשמר רק בשרת שלך (Script Properties), לא בגיליון ולא באפליקציה.</p>
        <hr>
        <h3 class="sub-h">AI להודעות ממודל</h3>
        <p class="hint small">Gemini קורא כל הודעה ממודל ומציע משימה רק כשיש בה משהו לעשות שעוד לא קיים במשימות שלך.</p>
        <p class="hint small">מצב: <span dir="auto">${esc(store.setting('ai_status') || 'לא מחובר')}</span></p>
        <div class="row wrap">
          <label class="field grow"><span>מפתח Gemini API</span><input name="gemini_key" dir="ltr" autocomplete="off" placeholder="AIza…"></label>
          <button type="button" class="btn ghost" data-gemini>חבר</button>
        </div>
        <p class="hint small">מפתח בחינם: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> → Create API key. נשמר רק בשרת שלך (Script Properties). המודל נבחר אוטומטית (Gemini Flash העדכני); אפשר לקבוע אחר בגיליון: settings → ai_model.</p>
        <hr>
        <h3 class="sub-h">פומודורו</h3>
        <div class="row wrap pomo">
          <label class="field"><span>ריכוז (דק׳)</span><input type="number" min="1" data-set="pomodoro_focus_minutes" value="${esc(timer.settingsP().focus)}"></label>
          <label class="field"><span>הפסקה קצרה</span><input type="number" min="1" data-set="pomodoro_short_break_minutes" value="${esc(timer.settingsP().short)}"></label>
          <label class="field"><span>הפסקה ארוכה</span><input type="number" min="1" data-set="pomodoro_long_break_minutes" value="${esc(timer.settingsP().long)}"></label>
          <label class="field"><span>ארוכה כל</span><input type="number" min="1" data-set="pomodoro_long_break_every" value="${esc(timer.settingsP().every)}"></label>
        </div>
        <label class="check"><input type="checkbox" data-set="pomodoro_auto_start_breaks" ${timer.settingsP().autoBreak ? 'checked' : ''}> להתחיל הפסקה אוטומטית בסוף ריכוז</label>
        <hr>
        <div class="row wrap">
          <a class="btn ghost" href="${SHEET_URL}" target="_blank" rel="noopener">פתח את הגיליון</a>
          <button type="button" class="btn danger ghost" data-logout>נתק מכשיר זה</button>
        </div>` : ''}
    </div>
  </form>`;

  const form = $('form', dlg);
  const msg = $('#connMsg', dlg);
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  $('[data-connect]', dlg).addEventListener('click', async () => {
    const url = form.url.value.trim(), key = form.key.value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url) || !key) {
      msg.textContent = 'צריך כתובת שמתחילה ב-https://script.google.com/… ומפתח.'; msg.className = 'msg err'; return;
    }
    msg.textContent = 'בודק חיבור…'; msg.className = 'msg';
    try {
      await store.testConnection({ url, key });
      store.setConfig({ url, key });
      dlg.close(); toast('מחובר'); store.refresh();
    } catch (e) {
      msg.textContent = e.message === 'unauthorized' ? 'המפתח לא נכון.'
        : (e instanceof TypeError || e.network) ? 'לא הצלחתי להגיע לשרת — בדוק את הכתובת ואת החיבור לאינטרנט.'
          : `החיבור נכשל: ${e.message}`;
      msg.className = 'msg err';
    }
  });
  $('[data-demo]', dlg).addEventListener('click', () => {
    store.setConfig({ url: 'demo', key: 'demo' }); dlg.close(); store.refresh(); toast('מצב הדגמה — הנתונים לא נשמרים בגיליון');
  });
  $('[data-copy]', dlg)?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(deviceLink); toast('הקישור הועתק'); }
    catch { prompt('העתק את הקישור:', deviceLink); }
  });
  dlg.querySelectorAll('[data-set]').forEach((inp) => inp.addEventListener('change', () => {
    const v = inp.type === 'checkbox' ? (inp.checked ? 'TRUE' : 'FALSE') : String(Math.max(1, Math.round(Number(inp.value) || 1)));
    store.setSetting(inp.dataset.set, v);
    toast(/calendar/.test(inp.dataset.set) && v === 'TRUE' ? 'נשמר — היומן יתעדכן בעוד רגע' : 'נשמר');
  }));
  $('[data-moodle]', dlg)?.addEventListener('click', async () => {
    const token = form.moodle_token.value.trim();
    if (!token) { form.moodle_token.focus(); return; }
    if (store.apiVersion < 3) { toast('צריך לעדכן את השרת קודם'); return; }
    toast('בודק את ה-token…');
    try {
      const r = await store.action('setMoodleToken', { token });
      form.moodle_token.value = '';
      toast(`מודל מחובר — ${r.fullname || ''}`);
      const c = await store.action('moodleCheck');
      toast(c.added ? `נמצאו ${c.added} הודעות/מטלות במודל` : 'מודל מחובר, אין חדש');
      store.refresh();
    } catch (err) { toast(`לא הצלחתי להתחבר למודל: ${err.message}`); }
  });
  $('[data-gemini]', dlg)?.addEventListener('click', async () => {
    const key = form.gemini_key.value.trim();
    if (!key) { form.gemini_key.focus(); return; }
    if (store.apiVersion < 4) { toast('צריך לעדכן את השרת קודם (SETUP.md)'); return; }
    toast('בודק את המפתח…');
    try {
      const r = await store.action('setGeminiKey', { key_value: key });
      form.gemini_key.value = '';
      toast(`ה-AI מחובר (${r.model}) — עובר על ההודעות…`);
      await store.refresh();
      const a = await store.action('aiReview');
      toast(a.reviewed ? `ה-AI עבר על ${a.reviewed} הודעות` : `AI: ${a.status}`);
      store.refresh();
    } catch (err) { toast(`המפתח לא עבד: ${err.message}`); }
  });
  $('[data-logout]', dlg)?.addEventListener('click', () => {
    if (store.queue.length && !confirm('יש שינויים שעוד לא נשלחו. לנתק בכל זאת?')) return;
    store.clearConfig(); dlg.close();
  });
  if (!dlg.open) dlg.showModal();
}

/* ------------------------------------------------------------ timer ---- */

const PHASE = { focus: 'ריכוז', short: 'הפסקה קצרה', long: 'הפסקה ארוכה' };

function timerView(st) {
  const len = timer.phaseLength(st);
  const el = Math.max(0, timer.elapsed(st)); // (another device's clock may be slightly ahead)
  const pomodoro = st.mode === 'pomodoro';
  return {
    clock: pomodoro ? fmtClock(len - el) : fmtClock(el),
    progress: pomodoro ? Math.min(1, el / len) : 0,
    label: pomodoro
      ? (st.running ? PHASE[st.phase] : (st.phase === 'focus' && st.acc === 0 ? 'מוכן לפומודורו הבא' : st.acc === 0 ? `${PHASE[st.phase]} — מוכן` : 'מושהה'))
      : (st.running ? 'סטופר' : 'מושהה'),
  };
}

function onSecond() {
  timer.tick();
  const st = timer.state();
  if (st) {
    const v = timerView(st);
    const c = $('#timerBar .clock'); if (c) c.textContent = v.clock;
    const sc = $('#timerSheet .big-clock'); if (sc) sc.textContent = v.clock;
    const ring = $('#timerSheet .ring-fg'); if (ring) ring.style.strokeDashoffset = String(565.5 * (1 - v.progress));
    const tl = $('#timerSheet .phase-label'); if (tl) tl.textContent = v.label;
    document.title = `${v.clock} · ${store.task(st.task_id)?.title || 'טיימר'}`;
  } else if (document.title !== 'משימות') document.title = 'משימות';
}

let lastBarSig = '';
function renderTimerBar() {
  const bar = $('#timerBar');
  const st = timer.state();
  document.body.classList.toggle('has-timer', !!st);
  const sig = JSON.stringify([st && { ...st, seg_start: 0, acc: st.running ? 0 : st.acc }, st && store.task(st.task_id)?.title]);
  if (sig === lastBarSig) return;
  lastBarSig = sig;
  if (!st) { bar.hidden = true; bar.innerHTML = ''; return; }
  const t = store.task(st.task_id);
  const c = t && store.course(t.course);
  const v = timerView(st);
  bar.hidden = false;
  bar.style.setProperty('--c', c ? c.color : 'var(--accent)');
  bar.className = `timer-bar ${st.running ? 'running' : 'paused'} ${timer.isBreak(st) ? 'break' : ''}`;
  bar.innerHTML = `
    <button class="tb-main" data-t="open">
      <span class="clock">${v.clock}</span>
      <span class="tb-text"><b dir="auto">${esc(t ? t.title : 'משימה')}</b><small>${esc(st.mode === 'pomodoro' ? `🍅 ${v.label}` : `⏱ ${v.label}`)}</small></span>
    </button>
    <button class="icon-btn" data-t="${st.running ? 'pause' : 'resume'}" aria-label="${st.running ? 'השהה' : 'המשך'}">
      ${st.running ? '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5-10-6.5Z"/></svg>'}</button>
    <button class="icon-btn" data-t="stop" aria-label="עצור ושמור"><svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>`;
}

function onTimerBarClick(e) {
  const b = e.target.closest('[data-t]'); if (!b) return;
  const a = b.dataset.t;
  if (a === 'open') openTimer(timer.state()?.task_id);
  if (a === 'pause') timer.pause();
  if (a === 'resume') timer.resume();
  if (a === 'stop') timer.stop();
}

let timerTask = null;     // task shown in the timer sheet
let lastSheetSig = '';
function openTimer(taskId) {
  if (!taskId) return;
  const st = timer.state();
  if (st && st.task_id !== taskId) {
    const other = store.task(st.task_id)?.title || 'משימה אחרת';
    if (!confirm(`הטיימר רץ על „${other}”. לעצור אותו (הזמן יישמר) ולעבור למשימה הזאת?`)) return;
    timer.stop();
  }
  timerTask = taskId;
  lastSheetSig = '';
  const dlg = $('#timerSheet');
  renderTimerSheet();
  if (!dlg.open) dlg.showModal();
}

function renderTimerSheet() {
  const dlg = $('#timerSheet');
  const st = timer.state();
  const id = st ? st.task_id : timerTask;
  const t = store.task(id);
  if (!t) { if (dlg.open) dlg.close(); return; }
  const sig = JSON.stringify([id, st && { ...st, seg_start: 0, acc: st.running ? 0 : st.acc }, store.spentMinutes(id), t.estimate_hours]);
  if (sig === lastSheetSig) return;
  lastSheetSig = sig;
  const c = store.course(t.course);
  const p = timer.settingsP();
  const spent = store.spentMinutes(id);
  const est = Number(t.estimate_hours) || 0;
  const head = `<header class="sheet-head">
      <div><h2 tabindex="-1" autofocus>${esc(t.title)}</h2>${c ? `<p class="sub"><i style="--c:${esc(c.color)}"></i>${esc(c.short_he || c.name_he)}</p>` : ''}</div>
      <button type="button" class="icon-btn" data-close aria-label="סגור">${ICON.close}</button>
    </header>`;
  const totals = `<p class="totals">סה״כ במשימה: <b>${fmtMinutes(spent)}</b> ש׳${est ? ` מתוך ${fmtMinutes(est * 60)}` : ''}</p>`;
  let body;
  if (!st) {
    const last = store.ui('timerMode', 'pomodoro');
    body = `<p class="hint center">איך לעבוד?</p>
      <div class="mode-pick">
        <button type="button" class="mode ${last === 'pomodoro' ? 'last' : ''}" data-mode="pomodoro"><span class="emoji">🍅</span><b>פומודורו</b><small>${p.focus} דק׳ ריכוז · ${p.short} דק׳ הפסקה</small></button>
        <button type="button" class="mode ${last === 'stopwatch' ? 'last' : ''}" data-mode="stopwatch"><span class="emoji">⏱</span><b>סטופר</b><small>מודד עד שתעצור</small></button>
      </div>${totals}`;
  } else {
    const v = timerView(st);
    const pom = st.mode === 'pomodoro';
    const dots = pom ? `<div class="dots">${Array.from({ length: p.every }, (_, i) => `<i class="${i < st.cycle % p.every || (st.cycle && st.cycle % p.every === 0 && st.phase === 'long') ? 'on' : ''}"></i>`).join('')}</div>` : '';
    const waiting = !st.running && st.acc === 0;
    body = `<div class="ring-wrap ${timer.isBreak(st) ? 'break' : ''}" style="--c:${esc(c ? c.color : 'var(--accent)')}">
        ${pom ? `<svg class="ring" viewBox="0 0 200 200"><circle class="ring-bg" cx="100" cy="100" r="90"/><circle class="ring-fg" cx="100" cy="100" r="90" style="stroke-dashoffset:${565.5 * (1 - v.progress)}"/></svg>` : ''}
        <div class="ring-center"><div class="big-clock">${v.clock}</div><div class="phase-label">${esc(v.label)}</div>${dots}</div>
      </div>
      ${totals}
      <div class="timer-actions">
        <button type="button" class="btn primary big" data-ta="${st.running ? 'pause' : 'resume'}">${st.running ? 'השהה' : waiting ? (st.phase === 'focus' ? 'התחל ריכוז' : 'התחל הפסקה') : 'המשך'}</button>
        <div class="pair">
          ${pom ? `<button type="button" class="btn ghost" data-ta="skip">${st.phase === 'focus' ? 'סיים ריכוז עכשיו' : 'דלג על ההפסקה'}</button>` : ''}
          <button type="button" class="btn ghost" data-ta="stop">עצור ושמור</button>
        </div>
        <button type="button" class="btn ghost ok" data-ta="done">✓ סיימתי את המשימה</button>
      </div>`;
  }
  dlg.innerHTML = `<div class="sheet-form timer-sheet">${head}<div class="sheet-body">${body}</div></div>`;
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  dlg.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    store.setUi('timerMode', b.dataset.mode);
    timer.start(id, b.dataset.mode);
  }));
  dlg.querySelectorAll('[data-ta]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.ta;
    if (a === 'pause') timer.pause();
    if (a === 'resume') timer.resume();
    if (a === 'skip') timer.skip();
    if (a === 'stop') { timer.stop(); dlg.close(); }
    if (a === 'done') { timer.stop({ silent: true }); store.saveTask({ id, status: 'done' }); dlg.close(); toast(`„${t.title}” הושלם · ${fmtMinutes(store.spentMinutes(id))} ש׳`); }
  }));
}

/* ------------------------------------------------------------ toast ---- */

let toastTimer;
function toast(text, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) $('button', el).addEventListener('click', () => { action.fn(); el.classList.remove('show'); });
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 5000 : 2200);
}

boot();
