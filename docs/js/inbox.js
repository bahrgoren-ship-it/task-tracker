// "הודעות" screen: messages the backend found on Moodle (each course's לוח הודעות + assignments with due dates).
// A message is never a task by itself. Each message is shown in full, and an AI (Gemini, in the backend) reads it
// and suggests tasks only for things not already covered by an existing task — or an update to an existing task.
// Nothing changes until Bahr accepts a suggestion.
import { store } from './store.js';
import { shortDate, weekday, todayIL, dayDiff, dueLabel } from './dates.js';

let root, ui = {};
let lastSig = '';
const expanded = new Set();     // message ids shown in full
const reviewing = new Set();    // message ids being re-reviewed right now
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND = { announcement: 'הודעה', assignment: 'מטלה במודל', date_change: 'תאריך השתנה' };
const LONG_TEXT = 420;          // characters before "קרא הכל"

export function initInbox(el, callbacks) {
  root = el; ui = callbacks;
  root.addEventListener('click', onClick);
}

export function suggestionsOf(m) {
  try { const a = JSON.parse(m.ai_suggestions || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
const aiConnected = () => /^(connected|ok|error)/.test(store.setting('ai_status', ''));

export function render(force = false) {
  if (!root || root.hidden) return;
  const showAll = store.ui('inboxAll', false);
  const sig = JSON.stringify([store.data.moodle_inbox, store.data.tasks.map((t) => [t.id, t.title, t.due_date, t.due_time]),
    showAll, store.setting('moodle_status'), store.setting('ai_status'), store.apiVersion, store.data.courses, [...expanded], [...reviewing]]);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  const items = store.data.moodle_inbox
    .filter((m) => showAll || m.status === 'new')
    .sort((a, b) => (b.posted_at || '').localeCompare(a.posted_at || ''));
  const newCount = store.inboxNew().length;
  const status = store.setting('moodle_status', '');
  const aiStatus = store.setting('ai_status', '');
  const lastCheck = store.setting('moodle_last_check', '');
  let head = '';
  if (store.apiVersion && store.apiVersion < 4) {
    head = `<div class="note">כדי שה-AI יעבור על ההודעות צריך לעדכן את השרת (Apps Script) לגרסה החדשה — ההוראות ב-SETUP.md.</div>`;
  } else if (!status || status === 'not connected') {
    head = `<div class="note">מודל עוד לא מחובר. ב-⚙️ הגדרות → „מודל” הדבק את ה-token של מודל (אותו אחד שמשמש את Update Moodle).</div>`;
  } else if (status.startsWith('error')) {
    head = `<div class="note err">הבדיקה האחרונה של מודל נכשלה: <span dir="ltr">${esc(status.slice(7))}</span></div>`;
  }
  if (store.apiVersion >= 4 && !aiConnected()) {
    head += `<div class="note">ה-AI שעובר על ההודעות עוד לא מחובר. ב-⚙️ הגדרות → „AI” הדבק מפתח Gemini (בחינם מ-aistudio.google.com).</div>`;
  } else if (aiStatus.startsWith('error')) {
    head += `<div class="note err">ה-AI נכשל בפעם האחרונה: <span dir="ltr">${esc(aiStatus.slice(7))}</span></div>`;
  }
  root.innerHTML = `
    <div class="inbox-top">
      <div><h2>הודעות ממודל</h2><p class="summary">${newCount ? `${newCount} חדשות` : 'אין הודעות חדשות'}${lastCheck ? ` · נבדק ${esc(lastCheck.slice(5).replace('-', '.'))}` : ''}</p></div>
      <div class="row">
        <button class="btn ghost sm" data-check>בדוק עכשיו</button>
        <button class="btn ghost sm" data-all>${showAll ? 'רק חדשות' : 'הצג הכל'}</button>
      </div>
    </div>
    ${head}
    ${items.length ? `<ul class="inbox-list">${items.map(itemHtml).join('')}</ul>`
      : `<div class="empty"><p>${showAll ? 'עוד לא הגיעו הודעות.' : 'הכל מטופל 👌'}</p></div>`}`;
}

function itemHtml(m) {
  const c = store.course(m.course);
  const dates = (m.detected_dates || '').split(',').map((s) => s.trim()).filter(Boolean);
  const linked = m.task_id && store.task(m.task_id);
  const handled = m.status !== 'new';
  const text = m.text || '';
  const long = text.length > LONG_TEXT || text.split('\n').length > 7;
  const open = expanded.has(m.id);
  return `<li class="inbox-item k-${esc(m.kind)} ${handled ? 'handled' : ''}" data-id="${esc(m.id)}" style="--c:${esc(c ? c.color : '#8A8F98')}">
    <div class="ib-meta">
      ${c ? `<span class="course"><i></i>${esc(c.short_he || c.name_he)}</span>` : ''}
      <span class="kind">${KIND[m.kind] || m.kind}</span>
      ${m.posted_at ? `<span>${esc(shortDate(m.posted_at.slice(0, 10)))} ${esc(m.posted_at.slice(11))}</span>` : ''}
      ${m.author ? `<span>${esc(m.author)}</span>` : ''}
      ${handled ? `<span class="state">${m.status === 'accepted' ? '✓ טופל' : 'נקרא'}</span>` : ''}
    </div>
    <h3>${esc(m.title)}</h3>
    ${m.ai_summary ? `<p class="ib-summary"><span aria-hidden="true">✨</span> ${esc(m.ai_summary)}</p>` : ''}
    ${text ? `<div class="ib-text ${long && !open ? 'clamped' : ''}">${linkify(text)}</div>
      ${long ? `<button class="linkish" data-act="expand">${open ? 'הצג פחות' : 'קרא את כל ההודעה'}</button>` : ''}` : ''}
    ${dates.length && m.ai_status !== 'done' ? `<div class="ib-dates">${dates.map((d) => `<span class="${dayDiff(todayIL(), d.slice(0, 10)) < 0 ? 'past' : ''}">📅 יום ${weekday(d.slice(0, 10))} ${shortDate(d.slice(0, 10))}${d.length > 10 ? ` ${d.slice(11)}` : ''}</span>`).join('')}</div>` : ''}
    ${linked && m.kind === 'date_change' ? `<p class="hint small">משויך למשימה „${esc(linked.title)}”</p>` : ''}
    ${m.kind === 'date_change' ? '' : aiHtml(m)}
    <div class="ib-actions">
      ${!handled && m.kind === 'date_change' && linked ? '<button class="btn primary sm" data-act="redate">עדכן את התאריך</button>' : ''}
      ${!handled ? `<button class="btn ${openSuggestions(m).length ? 'ghost' : 'primary'} sm" data-act="read">סמן כנקרא</button>`
        : '<button class="btn ghost sm" data-act="reopen">החזר לחדשות</button>'}
      ${m.kind !== 'date_change' ? '<button class="btn ghost sm" data-act="manual">משימה ידנית</button>' : ''}
      ${m.kind !== 'date_change' && store.apiVersion >= 4 && aiConnected() ? `<button class="btn ghost sm" data-act="rereview" ${reviewing.has(m.id) ? 'disabled' : ''}>${reviewing.has(m.id) ? 'בודק…' : 'בדוק שוב עם AI'}</button>` : ''}
      ${m.url ? `<a class="btn ghost sm" href="${esc(m.url)}" target="_blank" rel="noopener">פתח במודל</a>` : ''}
    </div>
  </li>`;
}

const openSuggestions = (m) => suggestionsOf(m).filter((s) => s.state === 'open');

function aiHtml(m) {
  if (reviewing.has(m.id)) return '<div class="ai-box wait">✨ ה-AI קורא את ההודעה…</div>';
  if (!m.ai_status) {
    if (store.apiVersion < 4 || !aiConnected()) return '';
    return m.status === 'new' ? '<div class="ai-box wait">✨ ה-AI יעבור על ההודעה בדקות הקרובות…</div>' : '';
  }
  if (m.ai_status.startsWith('error')) return `<div class="ai-box err">ה-AI לא הצליח לקרוא את ההודעה: <span dir="ltr">${esc(m.ai_status.slice(7))}</span></div>`;
  const sugg = suggestionsOf(m);
  const acts = sugg.filter((s) => s.type !== 'covered');
  const covered = sugg.filter((s) => s.type === 'covered');
  return `<div class="ai-box">
    <div class="ai-head">✨ ${acts.length ? (acts.length === 1 ? 'הצעה אחת מה-AI' : `${acts.length} הצעות מה-AI`) : 'אין כאן משימה חדשה'}</div>
    ${acts.map((s) => suggestionHtml(m, s)).join('')}
    ${covered.length ? `<ul class="ai-covered">${covered.map((s) => {
      const t = store.task(s.task_id);
      return `<li>✓ כבר קיים במשימה <button class="linkish" data-open="${esc(s.task_id)}">„${esc(t ? t.title : s.title)}”</button>${s.reason ? ` — ${esc(s.reason)}` : ''}</li>`;
    }).join('')}</ul>` : ''}
  </div>`;
}

function suggestionHtml(m, s) {
  const st = s.state;
  if (s.type === 'update') {
    const t = store.task(s.task_id);
    const newDue = s.due_date ? `${s.due_date}${s.due_time ? ` ${s.due_time}` : ''}` : '';
    return `<div class="sugg upd st-${esc(st)}" data-sg="${esc(s.id)}">
      <div class="sg-top"><span class="sg-kind">עדכון למשימה</span><b>${esc(t ? t.title : s.title)}</b></div>
      ${newDue ? `<p class="sg-line">📅 ${esc(s.old_due ? dueLabelFrom(s.old_due) : 'ללא תאריך')} ← <b>${esc(dueLabelFrom(newDue))}</b></p>` : ''}
      ${s.notes_to_add ? `<p class="sg-line">➕ ${esc(s.notes_to_add)}</p>` : ''}
      ${s.reason ? `<p class="sg-why">${esc(s.reason)}</p>` : ''}
      ${st === 'open' ? `<div class="sg-actions"><button class="btn primary sm" data-sact="apply">עדכן את המשימה</button><button class="btn ghost sm" data-sact="dismiss">לא צריך</button></div>`
        : `<p class="sg-done">${st === 'accepted' ? '✓ עודכן' : 'נדחה'} <button class="linkish" data-sact="undo">בטל</button></p>`}
    </div>`;
  }
  const made = s.created_task_id && store.task(s.created_task_id);
  return `<div class="sugg st-${esc(st)}" data-sg="${esc(s.id)}">
    <div class="sg-top"><span class="sg-kind">משימה מוצעת</span><b>${esc(s.title)}</b></div>
    <p class="sg-line">${s.due_date ? `📅 ${esc(dueLabel(s.due_date, s.due_time))}` : 'ללא תאריך'}${Number(s.estimate_hours) ? ` · ⏱ כ-${esc(s.estimate_hours)} ש׳` : ''}</p>
    ${s.notes ? `<p class="sg-notes">${esc(s.notes)}</p>` : ''}
    ${s.reason ? `<p class="sg-why">${esc(s.reason)}</p>` : ''}
    ${st === 'open' ? `<div class="sg-actions"><button class="btn primary sm" data-sact="add">הוסף משימה</button><button class="btn ghost sm" data-sact="dismiss">לא צריך</button></div>`
      : st === 'accepted' ? `<p class="sg-done">✓ נוספה${made ? ` — <button class="linkish" data-open="${esc(made.id)}">„${esc(made.title)}”</button>` : ''}</p>`
        : `<p class="sg-done">נדחה <button class="linkish" data-sact="undo">בטל</button></p>`}
  </div>`;
}

function dueLabelFrom(stamp) { return dueLabel(stamp.slice(0, 10), stamp.length > 10 ? stamp.slice(11, 16) : ''); }

function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener" dir="ltr">${u.length > 60 ? `${u.slice(0, 57)}…` : u}</a>`);
}

/* ---------------------------------------------------------------- actions ---- */

function setSuggestion(m, sgId, patch) {
  const list = suggestionsOf(m).map((s) => (s.id === sgId ? { ...s, ...patch } : s));
  const row = { id: m.id, ai_suggestions: JSON.stringify(list) };
  const stillOpen = list.filter((s) => s.state === 'open').length;
  const anyAccepted = list.some((s) => s.state === 'accepted');
  // when the last suggestion is handled, the message is done (it can be brought back from "הצג הכל")
  if (!stillOpen && m.status === 'new' && patch.state && patch.state !== 'open') {
    row.status = anyAccepted ? 'accepted' : 'ignored';
    if (anyAccepted && !m.task_id) row.task_id = list.find((s) => s.created_task_id)?.created_task_id || '';
    store.saveInbox(row);
    ui.toast('ההודעה טופלה', { label: 'בטל', fn: () => store.saveInbox({ id: m.id, status: 'new' }) });
    return;
  }
  if (patch.state === 'open' && m.status !== 'new') row.status = 'new';
  store.saveInbox(row);
}

async function onClick(e) {
  if (e.target.closest('[data-all]')) { store.setUi('inboxAll', !store.ui('inboxAll', false)); return render(true); }
  if (e.target.closest('[data-check]')) {
    if (!store.configured || store.apiVersion < 3) return ui.toast('צריך לעדכן את השרת קודם');
    ui.toast('בודק את מודל…');
    try {
      const r = await store.action('moodleCheck');
      ui.toast(r.status && r.status.startsWith('ok') ? (r.added ? `נמצאו ${r.added} חדשות` : 'אין חדש במודל') : `מודל: ${r.status}`);
      await store.refresh();
      if (r.added && store.apiVersion >= 4 && aiConnected()) {
        ui.toast('ה-AI עובר על ההודעות החדשות…');
        await store.action('aiReview');
        store.refresh();
      }
    } catch (err) { ui.toast(`הבדיקה נכשלה: ${err.message}`); }
    return;
  }
  const openT = e.target.closest('[data-open]');
  if (openT) return ui.openEditor(openT.dataset.open);
  const li = e.target.closest('[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  const m = store.data.moodle_inbox.find((x) => x.id === id);
  if (!m) return;

  const sbtn = e.target.closest('[data-sact]');
  if (sbtn) {
    const sgId = sbtn.closest('[data-sg]').dataset.sg;
    const s = suggestionsOf(m).find((x) => x.id === sgId);
    if (!s) return;
    const act = sbtn.dataset.sact;
    if (act === 'dismiss') setSuggestion(m, sgId, { state: 'dismissed' });
    if (act === 'undo') setSuggestion(m, sgId, { state: 'open' });
    if (act === 'apply') {
      const t = store.task(s.task_id);
      if (!t) return ui.toast('המשימה כבר לא קיימת');
      const patch = { id: t.id };
      if (s.due_date) { patch.due_date = s.due_date; patch.due_time = s.due_time || ''; }
      if (s.notes_to_add) patch.notes = [t.notes, s.notes_to_add].filter(Boolean).join('\n');
      const before = { id: t.id, due_date: t.due_date, due_time: t.due_time, notes: t.notes };
      store.saveTask(patch);
      setSuggestion(m, sgId, { state: 'accepted' });
      ui.toast(`„${t.title}” עודכנה`, { label: 'בטל', fn: () => { store.saveTask(before); setSuggestion(store.data.moodle_inbox.find((x) => x.id === id), sgId, { state: 'open' }); } });
    }
    if (act === 'add') {
      ui.openEditor(null, {
        prefill: {
          title: s.title, course: s.course || m.course, due_date: s.due_date || '', due_time: s.due_time || '',
          estimate_hours: Number(s.estimate_hours) ? String(s.estimate_hours) : '',
          notes: [s.notes, `מתוך ההודעה „${m.title}”${m.posted_at ? ` (${shortDate(m.posted_at.slice(0, 10))})` : ''}`].filter(Boolean).join('\n'),
          links: m.url || '', source: 'moodle', moodle_ref: m.moodle_ref,
        },
        onSaved: (taskId) => {
          setSuggestion(store.data.moodle_inbox.find((x) => x.id === id), sgId, { state: 'accepted', created_task_id: taskId });
          ui.toast('המשימה נוספה');
        },
      });
    }
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'expand') { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); return render(true); }
  if (act === 'read') {
    const anyAccepted = suggestionsOf(m).some((s) => s.state === 'accepted');
    store.saveInbox({ id, status: anyAccepted ? 'accepted' : 'ignored' });
    ui.toast('סומן כנקרא', { label: 'בטל', fn: () => store.saveInbox({ id, status: 'new' }) });
  }
  if (act === 'reopen') store.saveInbox({ id, status: 'new' });
  if (act === 'redate') {
    const d = (m.detected_dates || '').split(',')[0].trim();
    store.saveTask({ id: m.task_id, due_date: d.slice(0, 10), due_time: d.length > 10 ? d.slice(11, 16) : '' });
    store.saveInbox({ id, status: 'accepted' });
    ui.toast('התאריך עודכן');
  }
  if (act === 'manual') {
    ui.openEditor(null, {
      prefill: { title: '', course: m.course, notes: `מתוך ההודעה „${m.title}”`, links: m.url || '', source: 'moodle', moodle_ref: m.moodle_ref },
      onSaved: () => ui.toast('המשימה נוספה'),
    });
  }
  if (act === 'rereview') {
    reviewing.add(id); render(true);
    try {
      await store.flush();
      const r = await store.action('aiReview', { id });
      if (!/^ok/.test(r.status || '')) ui.toast(`AI: ${r.status}`);
    } catch (err) { ui.toast(`ה-AI נכשל: ${err.message}`); }
    reviewing.delete(id);
    await store.refresh();
    render(true);
  }
}
