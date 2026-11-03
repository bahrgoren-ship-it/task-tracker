// Date helpers. All dates in the data are plain strings in Israel time:
//   date "yyyy-mm-dd", time "HH:MM", date-time "yyyy-mm-dd HH:MM".
// "Today" is always computed in Asia/Jerusalem, whatever the device's time zone is.

const TZ = 'Asia/Jerusalem';

export function nowIL(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export const todayIL = () => nowIL().date;
export const nowStampIL = () => stampIL(Date.now());
// "yyyy-mm-dd HH:MM" (Israel time) of an epoch-milliseconds moment
export const stampIL = (ms) => { const n = nowIL(ms); return `${n.date} ${n.time}`; };

// 75 -> "1:15"
export function fmtMinutes(min) {
  min = Math.round(Number(min) || 0);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}
// milliseconds -> "mm:ss" or "h:mm:ss"
export function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Day difference between two yyyy-mm-dd strings (b - a), calendar days.
export function dayDiff(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

const WEEKDAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
export function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function shortDate(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${d}.${m}`;
}

// Human Hebrew label for a due date relative to today.
export function dueLabel(date, time) {
  if (!date) return '';
  const diff = dayDiff(todayIL(), date);
  let s;
  if (diff === 0) s = 'היום';
  else if (diff === 1) s = 'מחר';
  else if (diff === -1) s = 'אתמול';
  else if (diff < -1) s = `לפני ${-diff} ימים`;
  else if (diff < 7) s = `יום ${weekday(date)} ${shortDate(date)}`;
  else s = `${shortDate(date)} (יום ${weekday(date)})`;
  return time ? `${s} · ${time}` : s;
}

// Which section of the list a task falls into.
export function bucketOf(task) {
  if (task.status === 'done' || task.status === 'cancelled') return 'done';
  if (!task.due_date) return 'nodate';
  const diff = dayDiff(todayIL(), task.due_date);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff < 7) return 'week';
  return 'later';
}
