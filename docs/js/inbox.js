// "הודעות" screen: messages the backend found on Moodle (each course's לוח הודעות + assignments with due dates).
// A message is never a task by itself. Each message is shown in full, and an AI (Gemini, in the backend) reads it
// and suggests tasks only for things not already covered by an existing task — or an update to an existing task.
// Nothing changes until Bahr accepts a suggestion.
import { store } from './store.js';
import { shortDate, weekday, todayIL, dayDiff, dueLabel } from './dates.js';
import { aiState, aiText, moodleState, moodleText, noticeHtml, friendlyError, whenLabel } from './notices.js';

const MOODLE = 'https://moodle26.technion.ac.il';

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
const aiConnected = () => aiState().kind !== 'off';
// the AI hasn't read it yet — never read, or only failed because Gemini was busy / out of quota (older backend)
const aiPending = (m) => !m.ai_status || m.ai_status === 'pending' || /^error: Gemini (429|5\d\d)/.test(m.ai_status);

/** Line under the screen title. */
export function summary() {
  const n = store.inboxNew().length;
  const lastCheck = store.setting('moodle_last_check', '');
  return `${n ? (n === 1 ? 'חדשה אחת' : `${n} חדשות`) : 'אין חדשות'}${lastCheck ? `, נבדק ${checkedLabel(lastCheck)}` : ''}`;
}
function checkedLabel(stamp) {
  const d = stamp.slice(0, 10), time = stamp.slice(11, 16);
  return d === todayIL() ? `ב-${time}` : `ב-${shortDate(d)}`;
}

export function render(force = false) {
  if (!root || root.hidden) return;
  const showAll = store.ui('inboxAll', false);
  const sig = JSON.stringify([store.data.moodle_inbox, store.data.tasks.map((t) => [t.id, t.title, t.due_date, t.due_time]),
    showAll, store.setting('moodle_status'), store.setting('ai_status'), store.setting('ai_last_error'), store.apiVersion,
    store.data.courses, store.data.groups, [...expanded], [...reviewing], store.ui('dismissed', {})]);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  // "חדשות" leaves out messages of archived courses (they wait under "הכל")
  const fresh = new Set(store.inboxNew());
  const items = store.data.moodle_inbox
    .filter((m) => showAll || fresh.has(m))
    .sort((a, b) => (b.posted_at || '').localeCompare(a.posted_at || ''));
  const newCount = store.inboxNew().length;
  // notices only for what needs attention now: Moodle not connected / failing, or messages the AI can't read yet
  let head = '';
  if (store.apiVersion && store.apiVersion < 4) {
    head = noticeHtml({ tone: 'warn', title: 'צריך לעדכן את השרת', body: 'כדי שה-AI יעבור על ההודעות צריך לעדכן את Apps Script לגרסה החדשה (SETUP.md).' });
  } else {
    const ms = moodleState();
    if (ms.kind === 'off') head += noticeHtml({ tone: 'warn', ...moodleText(ms) });
    if (ms.kind === 'error') head += noticeHtml({ tone: 'err', ...moodleText(ms), tech: ms.tech, dismiss: `moodle:${ms.tech}` });
    const waiting = store.inboxNew().some((m) => m.kind !== 'date_change' && aiPending(m));
    const as = aiState();
    if (store.apiVersion >= 4 && waiting) {
      if (as.kind === 'off') head += noticeHtml({ tone: 'warn', ...aiText(as) });
      if (as.kind === 'waiting') head += noticeHtml({ tone: 'info', ...aiText(as), tech: as.tech, dismiss: `ai:${as.why}:${as.until}` });
      if (as.kind === 'error') head += noticeHtml({ tone: 'err', ...aiText(as), tech: as.tech, dismiss: `ai:${as.what}:${as.tech}` });
    }
  }
  root.innerHTML = `
    <div class="inbox-top">
      <div class="seg-toggle" role="group" aria-label="אילו הודעות להציג">
        <button type="button" data-all="new" aria-pressed="${!showAll}">חדשות${newCount ? ` <b>${newCount}</b>` : ''}</button>
        <button type="button" data-all="all" aria-pressed="${showAll}">הכל</button>
      </div>
      <button class="btn ghost sm" data-check>בדוק במודל עכשיו</button>
    </div>
    ${head}
    ${items.length ? `<ul class="inbox-list">${items.map(itemHtml).join('')}</ul>`
      : `<div class="empty"><p>${showAll ? 'עוד לא הגיעו הודעות ממודל.' : 'אין הודעות שמחכות לך 👌'}</p></div>`}`;
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
      ${m.posted_at ? `<span>${esc(postedLabel(m))}</span>` : ''}
      ${m.author ? `<span>${esc(m.author)}</span>` : ''}
      ${handled ? `<span class="state">${m.status === 'accepted' ? '✓ טופל' : 'נקרא'}</span>` : ''}
    </div>
    <h3>${esc(m.title)}</h3>
    ${m.ai_summary ? `<p class="ib-summary"><span aria-hidden="true">✨</span> ${esc(m.ai_summary)}</p>` : ''}
    ${m.kind === 'date_change' ? dateChangeHtml(m) : text ? `<div class="ib-text ${long && !open ? 'clamped' : ''}">${mdLite(text, fromDrive(m))}</div>
      ${long ? `<button class="linkish" data-act="expand">${open ? 'הצג פחות' : 'קרא את כל ההודעה'}</button>` : ''}` : ''}
    ${dates.length && m.ai_status !== 'done' ? `<div class="ib-dates">${dates.map((d) => `<span class="${dayDiff(todayIL(), d.slice(0, 10)) < 0 ? 'past' : ''}">📅 יום ${weekday(d.slice(0, 10))} ${shortDate(d.slice(0, 10))}${d.length > 10 ? ` ${d.slice(11)}` : ''}</span>`).join('')}</div>` : ''}
    ${linked && m.kind === 'date_change' ? `<p class="hint small">משויך למשימה „${esc(linked.title)}”</p>` : ''}
    ${m.kind === 'date_change' ? '' : aiHtml(m)}
    <div class="ib-actions">
      ${!handled && m.kind === 'date_change' && linked ? '<button class="btn primary sm" data-act="redate">עדכן את התאריך</button>' : ''}
      ${!handled ? `<button class="btn ${openSuggestions(m).length ? 'ghost' : 'primary'} sm" data-act="read">סמן כנקרא</button>`
        : '<button class="btn ghost sm" data-act="reopen">החזר לחדשות</button>'}
      <span class="quiet-acts">
        ${m.kind !== 'date_change' ? '<button class="quiet" data-act="manual">משימה ידנית</button>' : ''}
        ${m.kind !== 'date_change' && store.apiVersion >= 4 && aiConnected() ? `<button class="quiet" data-act="rereview" ${reviewing.has(m.id) ? 'disabled' : ''}>${reviewing.has(m.id) ? 'בודק…' : 'בדוק שוב עם AI'}</button>` : ''}
        ${linkHtml(m, c)}
      </span>
    </div>
  </li>`;
}

const openSuggestions = (m) => suggestionsOf(m).filter((s) => s.state === 'open');

function aiHtml(m) {
  if (reviewing.has(m.id)) return '<div class="ai-box wait">✨ ה-AI קורא את ההודעה…</div>';
  if (aiPending(m)) {
    if (store.apiVersion < 4 || !aiConnected() || m.status !== 'new') return '';
    const st = aiState();
    const when = st.kind !== 'waiting' ? ' בדקות הקרובות' : st.until ? ` ${whenLabel(st.until)}` : ' כשהמכסה תתחדש';
    return `<div class="ai-box wait">✨ ה-AI יקרא את ההודעה${when}.</div>`;
  }
  if (m.ai_status.startsWith('error')) {
    return `<div class="ai-box err">✨ ה-AI לא הצליח לקרוא את ההודעה הזו. <button class="linkish" data-act="rereview">נסה שוב</button>
      <details><summary>פרטים</summary><p dir="ltr">${esc(m.ai_status.replace(/^error:?\s*/, ''))}</p></details></div>`;
  }
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

// Posts copied from the moodle-dl folder in Drive (refs "post:file…"): Markdown text, and no real post time.
const fromDrive = (m) => String(m.moodle_ref || '').startsWith('post:file');

function postedLabel(m) {
  const d = m.posted_at.slice(0, 10), t = m.posted_at.slice(11, 16);
  return `${shortDate(d)}${t && !fromDrive(m) ? ` ${t}` : ''}`;
}

/** Where "open" goes: the post on Moodle; for a Drive copy, the course's announcements board on Moodle. */
function messageUrl(m) {
  if (!/^https:\/\/drive\.google\.com\//.test(m.url || '')) return m.url || '';
  const c = store.course(m.course);
  return c && c.moodle_news_forum_id ? `${MOODLE}/mod/forum/view.php?id=${encodeURIComponent(c.moodle_news_forum_id)}` : m.url;
}
function linkHtml(m) {
  const url = messageUrl(m);
  if (!url) return '';
  const label = /drive\.google\.com/.test(url) ? 'פתח ב-Drive' : url !== m.url ? 'לוח ההודעות במודל' : 'פתח במודל';
  return `<a class="quiet" href="${esc(url)}" target="_blank" rel="noopener">${label}</a>`;
}

function dateChangeHtml(m) {
  const r = /במודל: (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?) · אצלך: (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)/.exec(m.text || '');
  if (!r) return m.text ? `<div class="ib-text">${mdLite(m.text, false)}</div>` : '';
  return `<p class="ib-text">תאריך ההגשה במודל: <b>${esc(dueLabelFrom(r[1]))}</b>. אצלך במשימה: ${esc(dueLabelFrom(r[2]))}.</p>`;
}

/**
 * Message text → HTML. Text copied by moodle-dl is Markdown with lines wrapped at ~80 characters (wrapped = true):
 * the lines of a paragraph are joined again, and **bold**, lists and links show properly. Other text keeps its
 * line breaks.
 */
export function mdLite(text, wrapped) {
  const src = String(text || '').replace(/\r\n?/g, '\n').replace(/\\([\\`*_{}[\]()#+\-.!>|])/g, '$1');
  const out = [];
  let para = [], list = null, blank = false;
  const joinLines = (ls) => ls.map((l, i) => inline(l.trim()) +
    (i < ls.length - 1 ? (wrapped && !/ {2,}$/.test(l) ? ' ' : '<br>') : '')).join('');
  const endPara = () => { if (para.length) out.push(`<p>${joinLines(para)}</p>`); para = []; };
  const endList = () => {
    if (list) out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.map((it) => `<li>${joinLines(it)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const line of src.split('\n')) {
    if (!line.trim()) { endPara(); blank = true; continue; }
    const li = /^\s*(?:([*+-])|(\d{1,3})[.)])\s+(.*)$/.exec(line);
    if (li) {
      endPara();
      const tag = li[1] ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { endList(); list = { tag, start: li[2] ? +li[2] : 1, items: [] }; }
      list.items.push([li[3]]);
    } else if (list && (!blank || /^\s{2,}/.test(line))) {
      list.items[list.items.length - 1].push(line); // the item goes on in the next line
    } else {
      endList();
      const h = /^#{1,6}\s+(.*)$/.exec(line.trim());
      if (h) { endPara(); out.push(`<p><b>${inline(h[1])}</b></p>`); } else para.push(line);
    }
    blank = false;
  }
  endPara(); endList();
  return out.join('');
}
function inline(s) {
  const keep = [];
  const put = (html) => { keep.push(html); return `\u0000${keep.length - 1}\u0000`; };
  let h = esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => put(`<a href="${u}" target="_blank" rel="noopener">${t}</a>`))
    .replace(/https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]]/g, (u) => put(`<a href="${u}" target="_blank" rel="noopener" dir="ltr">${u.length > 60 ? `${u.slice(0, 57)}…` : u}</a>`));
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/__(.+?)__/g, '<b>$1</b>').replace(/\*\*/g, '');
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
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
  const allBtn = e.target.closest('[data-all]');
  if (allBtn) { store.setUi('inboxAll', allBtn.dataset.all === 'all'); return render(true); }
  if (e.target.closest('[data-check]')) {
    if (!store.configured || store.apiVersion < 3) return ui.toast('צריך לעדכן את השרת קודם');
    ui.toast('בודק את מודל…');
    try {
      const r = await store.action('moodleCheck');
      await store.refresh();
      const ms = moodleState();
      ui.toast(ms.kind === 'error' ? moodleText(ms).title
        : r.added ? (r.added === 1 ? 'נמצאה הודעה חדשה' : `נמצאו ${r.added} הודעות חדשות`) : 'אין חדש במודל');
      if (r.added && store.apiVersion >= 4 && aiConnected()) {
        ui.toast('ה-AI עובר על ההודעות החדשות…');
        await store.action('aiReview');
        await store.refresh();
        const as = aiState();
        if (as.kind === 'waiting' || as.kind === 'error') ui.toast(aiText(as).title);
      }
    } catch (err) { ui.toast(friendlyError(err.message)); }
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
          links: messageUrl(m), source: 'moodle', moodle_ref: m.moodle_ref,
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
      prefill: { title: '', course: m.course, notes: `מתוך ההודעה „${m.title}”`, links: messageUrl(m), source: 'moodle', moodle_ref: m.moodle_ref },
      onSaved: () => ui.toast('המשימה נוספה'),
    });
  }
  if (act === 'rereview') {
    reviewing.add(id); render(true);
    try {
      await store.flush();
      await store.action('aiReview', { id });
    } catch (err) { ui.toast(friendlyError(err.message)); }
    reviewing.delete(id);
    await store.refresh();
    const as = aiState();
    const after = store.data.moodle_inbox.find((x) => x.id === id);
    if (after && aiPending(after) && (as.kind === 'waiting' || as.kind === 'error')) ui.toast(aiText(as).title);
    render(true);
  }
}
