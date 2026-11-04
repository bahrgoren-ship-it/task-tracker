# Instructions for AI agents working on this repo

Bahr's task tracker (homework first; may grow to all tasks): a Hebrew (RTL) installable web app + a Google Sheet as the database.

## Map
| Path | What |
|---|---|
| `SCHEMA.md` | **Read first.** Tabs, columns and editing rules of the Google Sheet (the data). |
| `docs/` | The app (served by GitHub Pages at https://bahrgoren-ship-it.github.io/task-tracker/). Plain HTML/CSS/JS ES modules, **no build step**. |
| `docs/js/app.js` | UI: tasks screen, task editor, settings dialog. |
| `docs/js/categories.js` | Categories (tab `courses`; a course is one kind) and meta categories (tab `groups`: a semester, a project, general tasks): the filter chips, the task editor's picker, the "קטגוריות" sheet (add / edit / archive / restore / delete-if-unused), the archive view. |
| `docs/js/store.js` | Local copy of the data + queue of unsent changes + calls to the backend. |
| `docs/js/dates.js` | Date helpers (everything in Israel time, strings `yyyy-mm-dd` / `HH:MM`). |
| `docs/js/timer.js` | Stopwatch / pomodoro. State lives in the Sheet (`settings.active_timer`) so devices share it; focus time is saved to `sessions`. |
| `docs/js/planner.js` | Planner: custom RTL week grid, drag tasks from the tray into work blocks (`blocks`), move/resize, tap-to-place, "אשר תכנון", busy layer from Google Calendar. No external libraries. |
| `docs/js/notices.js` | Status strings (`ai_status`, `moodle_status`, `calendar_status`) → plain Hebrew + what to do; `noticeHtml` (original text under „פרטים”, dismissable). |
| `docs/js/suggestions.js` | Card on the tasks screen: pending rows of the `suggestions` tab (any AI proposes, Bahr approves): tasks, blocks, sessions, categories, meta categories. Validates, shows before → after, applies through store, undo. |
| `docs/js/inbox.js` | "הודעות" screen: full Moodle messages + the AI's suggestions (add task / update task / not needed). A message is never a task by itself. |
| `docs/js/demo.js` | In-browser fake backend ("demo mode"). Keep its API identical to the real one. |
| `docs/sw.js` | Service worker (offline). **Bump `VERSION` whenever anything in `docs/` changes.** |
| `apps-script/Code.gs` | Backend: Google Apps Script bound to the Sheet. JSON API (`ping`, `bootstrap`, `batch`, `busy`, `syncNow`, `moodleCheck`, `setMoodleToken`, `setGeminiKey`, `aiReview`), schema migration, Google Calendar sync, Moodle check, AI review of Moodle messages (Gemini), 10-minute trigger. |
| `SETUP.md` | How Bahr installs/updates the backend and connects devices. |

## Rules
- **Want to change Bahr's tasks/plan? Don't edit the tabs: add a row to `suggestions`** (see AI-SUGGESTIONS.md).
- UI text is Hebrew, addressed to a male user. Layout is RTL — use logical CSS properties (`inline-start`, etc.).
- Column names in the Sheet are fixed English ids. To change columns: edit `SCHEMA` in `Code.gs` (+ `DROPPED`
  for removed ones, `DEFAULT_SETTINGS` for new settings), bump `SCHEMA_VERSION`, update `SCHEMA.md` and `demo.js`.
  The backend migrates the Sheet by itself.
- Never put the API key, the Web-app URL, the Moodle token or the Gemini key in the repo (the repo is public).
- Send every Moodle web-service parameter as text: UrlFetchApp sends a JS number like 550 as "550.0", which Moodle
  rejects (`invalidparameter`). `moodle_()` does this for you. (This, not the page size, is why the forum calls failed.)
- The Moodle check also saves each course's לוח הודעות into Drive (`boardSync_`), with moodle-dl's exact folder/file
  names (`toValidName_` = moodle-dl's `PathTools.to_valid_name`, Windows rules). Bahr's laptop sync (moodle-dl +
  `Technion Studies/.ai/moodle-sync/moodle_sync.py`) never overwrites inside those folders and skips posts already there.
- Changing `Code.gs` only takes effect after Bahr pastes it into the Apps Script editor and creates a new
  deployment version (see SETUP.md) — tell him when that's needed.
- Test UI changes in demo mode (settings → "נסה במצב הדגמה") on phone, iPad and desktop widths.
- **Archive, not delete.** A category is archived when its own `active` is `FALSE` or its meta category's is
  (`store.categoryArchived(slug)`, `store.taskArchived(task)`). Archived = hidden everywhere a task is offered (list,
  chips, editor, planner tray and deadlines, inbox "חדשות") but kept in the Sheet, shown in the archive view and
  restorable. Anything new that lists tasks must skip archived ones. The backend deletes a category / meta category
  only while nothing uses it, and the Moodle check reads only courses with a `moodle_course_id` that aren't archived.
- Saving categories needs backend v7: the app checks `store.canSaveCategories` (an older backend would refuse the
  whole batch, so nothing for `courses` / `groups` may be queued before that).
- Look ("a student diary on graph paper"): colour tokens live at the top of `styles.css` — ink on cool paper,
  one blue accent, red only for overdue / due times, course colour as the only other colour. Font: IBM Plex Sans
  Hebrew. Tasks are grouped by day into one list per day (rows with dividers), with the deadline at the end of
  the title line. Below 900px the tabs are a bottom bar; from 900px they sit in the header.

- AI on the Gemini free tier: one request per batch of messages, Flash-Lite first, models that answer 429/5xx rest
  (`AI_REST` in Script Properties). Never mark a message as failed for busy/quota.
- CSS class `.busy` belongs to the sync pill; the planner's calendar layer is `.cal-busy`.
- `batch` drops upserts that would create half a row (REQUIRED) and returns fresh rows; the app applies them.

## Roadmap
1. ✅ Sheet + Notion import. 2. ✅ Tasks screen + time tracking (estimate, total, stopwatch/pomodoro).
3. ✅ Planner + Google Calendar sync (deadlines one-way, work blocks two-way). 4. ✅ Moodle inbox (announcements +
assignments, every 15 min) + AI review (Gemini suggests tasks not already covered); ✅ Windows Task Scheduler for the file sync (moodle-dl) on Bahr's PC; ✅ announcements saved to Drive from the cloud. 5. AI procedures.
6. ✅ Categories and meta categories edited in the app, with an archive (schema 7).
Tests (Playwright + fake Apps Script services) are not in the repo; keep behaviour covered when changing things.
