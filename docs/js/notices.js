// What the backend's status strings mean, in plain Hebrew — and one way to show a problem on screen.
// The backend writes short machine strings (settings.ai_status, moodle_status, calendar_status) and keeps Google's /
// Moodle's own error text separately; the app shows what happened + what to do, with the original text under "פרטים".
import { store } from './store.js';
import { todayIL, shortDate } from './dates.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "היום ב-10:05" / "מחר ב-10:05" / "ב-6.11 10:05" for a 'yyyy-mm-dd HH:MM' stamp. */
export function whenLabel(stamp) {
  if (!stamp) return '';
  const d = stamp.slice(0, 10), t = stamp.slice(11, 16);
  if (d === todayIL()) return `ב-${t}`;
  const tomorrow = new Date(`${todayIL()}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (d === tomorrow.toISOString().slice(0, 10)) return `מחר ב-${t}`;
  return `ב-${shortDate(d)} ${t}`;
}

/* ---------------------------------------------------------------- AI ---- */
// kinds: off | ok | waiting | error
export function aiState() {
  const s = store.setting('ai_status', '');
  const tech = store.setting('ai_last_error', '');
  if (!s || s === 'not connected') return { kind: 'off' };
  if (/^(connected|ok)/.test(s)) return { kind: 'ok', model: s.split(' · ').pop() };
  let m = /^waiting · ([\w-]+) · (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(s);
  if (m) return { kind: 'waiting', why: m[1], until: m[2], tech, raw: s };
  m = /^error · ([\w-]+)/.exec(s);
  if (m) return { kind: 'error', what: m[1], tech, raw: s };
  // older backend: 'error: <Gemini's text> · n reviewed · time · model'
  if (/^error/.test(s)) {
    const text = s.replace(/^error:?\s*/, '');
    if (/Gemini 429|quota/i.test(text)) return { kind: 'waiting', why: 'quota-day', until: '', tech: text, raw: s };
    if (/Gemini 5\d\d|high demand|overloaded/i.test(text)) return { kind: 'waiting', why: 'busy', until: '', tech: text, raw: s };
    if (/API key|Gemini 40[13]/i.test(text)) return { kind: 'error', what: 'key', tech: text, raw: s };
    return { kind: 'error', what: 'request', tech: text, raw: s };
  }
  return { kind: 'ok' };
}

/** Title + explanation for the AI's state. */
export function aiText(st = aiState()) {
  if (st.kind === 'waiting') {
    const at = st.until ? whenLabel(st.until) : '';
    if (st.why === 'quota-day') return { title: 'ה-AI הגיע למכסה החינמית של Gemini להיום',
      body: `ההודעות מחכות, והוא ימשיך לקרוא אותן לבד${at ? ` ${at}` : ' כשהמכסה תתחדש (בערך ב-10:00)'}.` };
    if (st.why === 'quota-minute') return { title: 'ה-AI ממתין רגע', body: 'יותר מדי בקשות בדקה האחרונה. ימשיך לבד בעוד דקה.' };
    if (st.why === 'gone') return { title: 'ה-AI עובר למודל אחר של Gemini', body: 'זה קורה לבד; ההודעות ייקראו בבדיקה הבאה.' };
    return { title: 'Gemini עמוס כרגע', body: `ה-AI ינסה שוב לבד${at ? ` ${at}` : ' בעוד כמה דקות'}.` };
  }
  if (st.kind === 'error') {
    if (st.what === 'key') return { title: 'מפתח ה-Gemini לא עובד', body: 'ב-⚙️ הגדרות → AI הדבק מפתח חדש מ-aistudio.google.com.', action: 'settings' };
    if (st.what === 'no-model') return { title: 'אין מודל Gemini זמין למפתח הזה', body: 'צור מפתח חדש ב-aistudio.google.com והדבק אותו ב-⚙️ הגדרות → AI.', action: 'settings' };
    return { title: 'ה-AI נתקל בבעיה', body: 'הוא ינסה שוב לבד בבדיקה הבאה (כל 10 דקות).' };
  }
  if (st.kind === 'off') return { title: 'ה-AI שקורא את ההודעות לא מחובר', body: 'ב-⚙️ הגדרות → AI הדבק מפתח Gemini (בחינם מ-aistudio.google.com).', action: 'settings' };
  return { title: 'ה-AI מחובר', body: st.model ? `מודל: ${st.model}` : '' };
}

/* ------------------------------------------------------------ Moodle ---- */
// kinds: off | ok | error; ok may come with drive = true (read from moodle-dl's copy in Drive)
export function moodleState() {
  const s = store.setting('moodle_status', '');
  if (!s || s === 'not connected') return { kind: 'off' };
  if (/^error/.test(s)) return { kind: 'error', tech: s.replace(/^error:?\s*/, ''), raw: s };
  const drive = /Drive copy/i.test(s);
  const api = (/Moodle API: (.*)$/.exec(s) || [])[1] || '';
  return { kind: 'ok', drive, tech: api, raw: s };
}
export function moodleText(st = moodleState()) {
  if (st.kind === 'off') return { title: 'מודל עוד לא מחובר', body: 'ב-⚙️ הגדרות → מודל הדבק את ה-token של מודל (אותו אחד ש-Update Moodle משתמש בו).', action: 'settings' };
  if (st.kind === 'error') {
    const t = st.tech;
    if (/invalidtoken|Invalid token|token.*(expired|invalid)|accessexception/i.test(t)) {
      return { title: 'ה-token של מודל לא עובד', body: 'כנראה פג תוקפו. ב-⚙️ הגדרות → מודל הדבק token חדש.', action: 'settings' };
    }
    if (/Drive folder not found/i.test(t)) return { title: 'לא מצאתי את תיקיית הקורס ב-Drive', body: 'בדוק בגיליון (courses → moodle_folder) שהנתיב נכון.' };
    if (/Moodle HTTP 5|timed? ?out|Address unavailable|DNS|Exception: (Request failed|Bandwidth)/i.test(t)) {
      return { title: 'מודל לא זמין כרגע', body: 'הבדיקה תנסה שוב לבד בעוד רבע שעה.' };
    }
    return { title: 'בדיקת מודל נכשלה', body: 'הבדיקה תנסה שוב לבד בעוד רבע שעה.' };
  }
  if (st.drive) return { title: 'ההודעות נקראות מהעותק ב-Drive', body: 'מודל לא מאפשר לקרוא את לוח ההודעות ישירות, אז הודעה חדשה מופיעה רק אחרי שהסנכרון במחשב (Update Moodle) רץ.' };
  return { title: 'מודל מחובר', body: '' };
}

/* ---------------------------------------------------------- calendar ---- */
export function calendarState() {
  let s = store.setting('calendar_status', '');
  if (!s) { // older backend kept errors in calendar_last_sync: 'time · error: …'
    const old = store.setting('calendar_last_sync', '');
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · error: (.*)$/.exec(old);
    s = m ? `error · ${m[1]} · ${m[2]}` : old ? `ok · ${old.slice(0, 16)}` : '';
  }
  const on = store.setting('sync_blocks_to_calendar') === 'TRUE' || store.setting('sync_deadlines_to_calendar') === 'TRUE';
  if (!on) return { kind: 'off' };
  let m = /^error · (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (.*)$/.exec(s);
  if (m) return { kind: 'error', at: m[1], tech: m[2], raw: s };
  m = /^ok · (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(s);
  return { kind: 'ok', at: m ? m[1] : '' };
}
export function calendarText(st = calendarState()) {
  if (st.kind === 'error') {
    const nf = /calendar not found: (.*)$/.exec(st.tech);
    if (nf) return { title: `לא מצאתי ביומן Google יומן בשם „${nf[1]}”`, body: 'הבלוקים לא נכנסים ליומן עד שתבחר יומן קיים ב-⚙️ הגדרות → יומן Google.', action: 'settings' };
    if (/permission|not allowed|forbidden|הרשאה/i.test(st.tech)) return { title: 'אין הרשאה לכתוב ליומן שנבחר', body: 'בחר יומן שלך ב-⚙️ הגדרות → יומן Google.', action: 'settings' };
    return { title: 'הסנכרון ליומן Google נכשל', body: 'הוא ינסה שוב לבד בעוד כמה דקות.' };
  }
  if (st.kind === 'off') return { title: 'הסנכרון ליומן כבוי', body: '' };
  return { title: 'היומן מסונכרן', body: st.at ? `סונכרן לאחרונה ${whenLabel(st.at)}` : '' };
}

/* ------------------------------------------------- saving to the Sheet ---- */
/** Hebrew sentence for an error from the backend / network. */
export function friendlyError(text) {
  const t = String(text || '');
  if (/unauthorized/.test(t)) return 'המפתח של המכשיר הזה לא נכון. חבר אותו מחדש ב-⚙️ הגדרות.';
  if (/unknown action/.test(t)) return 'השרת (Apps Script) בגרסה ישנה. צריך לעדכן אותו (SETUP.md).';
  if (/Lock timeout|obtain lock|timed? ?out/i.test(t)) return 'השרת היה עסוק. השינויים נשמרו במכשיר וישלחו לבד.';
  if (/HTTP \d|Failed to fetch|NetworkError|Load failed|TypeError/.test(t)) return 'אין חיבור לשרת כרגע. השינויים נשמרו במכשיר וישלחו כשהחיבור יחזור.';
  return 'השמירה בגיליון נכשלה. השינויים נשמרו במכשיר וינסו שוב לבד.';
}

/* -------------------------------------------------------------- show ---- */
/**
 * A notice: tone 'info' | 'warn' | 'err'; tech = the original text, under "פרטים" (left-to-right);
 * dismiss = a key — the notice can be hidden until the problem changes; action 'settings' → a button.
 */
export function noticeHtml({ tone = 'info', title, body = '', tech = '', dismiss = '', action = '' }) {
  if (dismiss && dismissed(dismiss)) return '';
  return `<div class="notice t-${tone}" role="status">
    <div class="n-text"><b>${esc(title)}</b>${body ? ` <span>${esc(body)}</span>` : ''}
      ${tech ? `<details><summary>פרטים</summary><p dir="ltr">${esc(tech)}</p></details>` : ''}</div>
    ${action === 'settings' ? '<button type="button" class="btn ghost sm" data-open-settings>להגדרות</button>' : ''}
    ${dismiss ? `<button type="button" class="n-x" data-dismiss="${esc(dismiss)}" aria-label="הסתר">✕</button>` : ''}
  </div>`;
}
function dismissed(key) { return !!(store.ui('dismissed', {}) || {})[key]; }
export function dismiss(key) {
  const d = store.ui('dismissed', {}) || {};
  d[key] = 1;
  const keys = Object.keys(d); // keep the list short
  if (keys.length > 30) keys.slice(0, keys.length - 30).forEach((k) => delete d[k]);
  store.setUi('dismissed', d);
}
