// "הודעות" screen: new items the backend found on Moodle (each course's לוח הודעות + assignments with
// due dates). Nothing becomes a task by itself — Bahr decides per item: create a task, update a date, or ignore.
import { store } from './store.js';
import { shortDate, weekday, todayIL, dayDiff } from './dates.js';

let root, ui = {};
let lastSig = '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KIND = { announcement: 'הודעה', assignment: 'מטלה במודל', date_change: 'תאריך השתנה' };

export function initInbox(el, callbacks) {
  root = el; ui = callbacks;
  root.addEventListener('click', onClick);
}

export function render(force = false) {
  if (!root || root.hidden) return;
  const showAll = store.ui('inboxAll', false);
  const sig = JSON.stringify([store.data.moodle_inbox, showAll, store.setting('moodle_status'), store.apiVersion, store.data.courses]);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  const items = store.data.moodle_inbox
    .filter((m) => showAll || m.status === 'new')
    .sort((a, b) => (b.posted_at || '').localeCompare(a.posted_at || ''));
  const newCount = store.inboxNew().length;
  const status = store.setting('moodle_status', '');
  const lastCheck = store.setting('moodle_last_check', '');
  let head = '';
  if (store.apiVersion && store.apiVersion < 3) {
    head = `<div class="note">כדי שההודעות ממודל יגיעו לכאן צריך לעדכן את השרת (Apps Script) לגרסה החדשה — ההוראות ב-SETUP.md.</div>`;
  } else if (!status || status === 'not connected') {
    head = `<div class="note">מודל עוד לא מחובר. ב-⚙️ הגדרות → „מודל” הדבק את ה-token של מודל (אותו אחד שמשמש את Update Moodle).</div>`;
  } else if (status.startsWith('error')) {
    head = `<div class="note err">הבדיקה האחרונה של מודל נכשלה: <span dir="ltr">${esc(status.slice(7))}</span></div>`;
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
  return `<li class="inbox-item k-${esc(m.kind)} ${handled ? 'handled' : ''}" data-id="${esc(m.id)}" style="--c:${esc(c ? c.color : '#8A8F98')}">
    <div class="ib-meta">
      ${c ? `<span class="course"><i></i>${esc(c.short_he || c.name_he)}</span>` : ''}
      <span class="kind">${KIND[m.kind] || m.kind}</span>
      ${m.posted_at ? `<span>${esc(shortDate(m.posted_at.slice(0, 10)))} ${esc(m.posted_at.slice(11))}</span>` : ''}
      ${m.author ? `<span>${esc(m.author)}</span>` : ''}
      ${handled ? `<span class="state">${m.status === 'accepted' ? '✓ טופל' : 'הוסתר'}</span>` : ''}
    </div>
    <h3>${esc(m.title)}</h3>
    ${m.text ? `<p class="ib-text">${esc(m.text)}</p>` : ''}
    ${dates.length ? `<div class="ib-dates">${dates.map((d) => `<span class="${dayDiff(todayIL(), d.slice(0, 10)) < 0 ? 'past' : ''}">📅 יום ${weekday(d.slice(0, 10))} ${shortDate(d.slice(0, 10))}${d.length > 10 ? ` ${d.slice(11)}` : ''}</span>`).join('')}</div>` : ''}
    ${linked ? `<p class="hint small">משויך למשימה „${esc(linked.title)}”</p>` : ''}
    <div class="ib-actions">
      ${!handled && m.kind === 'date_change' && linked ? '<button class="btn primary sm" data-act="redate">עדכן את התאריך</button>' : ''}
      ${!handled && m.kind !== 'date_change' ? '<button class="btn primary sm" data-act="task">צור משימה</button>' : ''}
      ${!handled ? '<button class="btn ghost sm" data-act="ignore">אין צורך</button>' : '<button class="btn ghost sm" data-act="reopen">החזר לחדשות</button>'}
      ${m.url ? `<a class="btn ghost sm" href="${esc(m.url)}" target="_blank" rel="noopener">פתח במודל</a>` : ''}
    </div>
  </li>`;
}

async function onClick(e) {
  if (e.target.closest('[data-all]')) { store.setUi('inboxAll', !store.ui('inboxAll', false)); return render(true); }
  if (e.target.closest('[data-check]')) {
    if (!store.configured || store.apiVersion < 3) return ui.toast('צריך לעדכן את השרת קודם');
    ui.toast('בודק את מודל…');
    try {
      const r = await store.action('moodleCheck');
      ui.toast(r.status && r.status.startsWith('ok') ? (r.added ? `נמצאו ${r.added} חדשות` : 'אין חדש במודל') : `מודל: ${r.status}`);
      store.refresh();
    } catch (err) { ui.toast(`הבדיקה נכשלה: ${err.message}`); }
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]').dataset.id;
  const m = store.data.moodle_inbox.find((x) => x.id === id);
  const act = btn.dataset.act;
  if (act === 'ignore') { store.saveInbox({ id, status: 'ignored' }); ui.toast('הוסתר'); }
  if (act === 'reopen') store.saveInbox({ id, status: 'new' });
  if (act === 'redate') {
    const d = (m.detected_dates || '').split(',')[0].trim();
    store.saveTask({ id: m.task_id, due_date: d.slice(0, 10), due_time: d.length > 10 ? d.slice(11, 16) : '' });
    store.saveInbox({ id, status: 'accepted' });
    ui.toast('התאריך עודכן');
  }
  if (act === 'task') {
    const d = (m.detected_dates || '').split(',').map((s) => s.trim()).filter(Boolean)
      .find((x) => dayDiff(todayIL(), x.slice(0, 10)) >= 0) || '';
    ui.openEditor(null, {
      prefill: {
        title: m.title, course: m.course, due_date: d.slice(0, 10), due_time: d.length > 10 ? d.slice(11, 16) : '',
        notes: m.kind === 'announcement' ? m.text.slice(0, 600) : m.text.slice(0, 300), links: m.url || '',
        source: 'moodle', moodle_ref: m.moodle_ref,
      },
      onSaved: (taskId) => { store.saveInbox({ id, status: 'accepted', task_id: taskId }); ui.toast('נוצרה משימה מההודעה'); },
    });
  }
}
