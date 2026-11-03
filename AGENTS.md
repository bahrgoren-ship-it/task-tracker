# Instructions for AI agents working on this repo

Bahr's task tracker (homework first; may grow to all tasks): a Hebrew (RTL) installable web app + a Google Sheet as the database.

## Map
| Path | What |
|---|---|
| `SCHEMA.md` | **Read first.** Tabs, columns and editing rules of the Google Sheet (the data). |
| `docs/` | The app (served by GitHub Pages at https://bahrgoren-ship-it.github.io/task-tracker/). Plain HTML/CSS/JS ES modules, **no build step**. |
| `docs/js/app.js` | UI: tasks screen, task editor, settings dialog. |
| `docs/js/store.js` | Local copy of the data + queue of unsent changes + calls to the backend. |
| `docs/js/dates.js` | Date helpers (everything in Israel time, strings `yyyy-mm-dd` / `HH:MM`). |
| `docs/js/timer.js` | Stopwatch / pomodoro. State lives in the Sheet (`settings.active_timer`) so devices share it; focus time is saved to `sessions`. |
| `docs/js/planner.js` | Planner: custom RTL week grid, drag tasks from the tray into work blocks (`blocks`), move/resize, tap-to-place, "אשר תכנון", busy layer from Google Calendar. No external libraries. |
| `docs/js/inbox.js` | "הודעות" screen: `moodle_inbox` items → create task / update date / ignore. |
| `docs/js/demo.js` | In-browser fake backend ("demo mode"). Keep its API identical to the real one. |
| `docs/sw.js` | Service worker (offline). **Bump `VERSION` whenever anything in `docs/` changes.** |
| `apps-script/Code.gs` | Backend: Google Apps Script bound to the Sheet. JSON API (`ping`, `bootstrap`, `batch`, `busy`, `syncNow`, `moodleCheck`, `setMoodleToken`), schema migration, Google Calendar sync, Moodle check, 10-minute trigger. |
| `SETUP.md` | How Bahr installs/updates the backend and connects devices. |

## Rules
- UI text is Hebrew, addressed to a male user. Layout is RTL — use logical CSS properties (`inline-start`, etc.).
- Column names in the Sheet are fixed English ids. To change columns: edit `SCHEMA` in `Code.gs` (+ `DROPPED`
  for removed ones, `DEFAULT_SETTINGS` for new settings), bump `SCHEMA_VERSION`, update `SCHEMA.md` and `demo.js`.
  The backend migrates the Sheet by itself.
- Never put the API key, the Web-app URL or the Moodle token in the repo (the repo is public).
- Changing `Code.gs` only takes effect after Bahr pastes it into the Apps Script editor and creates a new
  deployment version (see SETUP.md) — tell him when that's needed.
- Test UI changes in demo mode (settings → "נסה במצב הדגמה") on phone, iPad and desktop widths.

## Roadmap
1. ✅ Sheet + Notion import. 2. ✅ Tasks screen + time tracking (estimate, total, stopwatch/pomodoro).
3. ✅ Planner + Google Calendar sync (deadlines one-way, work blocks two-way). 4. ✅ Moodle inbox (announcements +
assignments, every 15 min); ⏳ Windows Task Scheduler for the file sync (moodle-dl) on Bahr's PC. 5. AI procedures.
Tests (Playwright + fake Apps Script services) are not in the repo; keep behaviour covered when changing things.
