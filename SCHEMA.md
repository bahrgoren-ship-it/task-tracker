# Task tracker — data schema (schema_version 9)

The tracker's data lives in ONE Google Sheet:

- **Name:** `מעקב שיעורי בית`
- **Location:** `Technion Studies/מעקב שיעורי בית/` (Google Drive)
- **Sheet ID:** `10qLYln2zUiMo7dEI3xZ8pj4ncGX7TRmATZNuZfvUfWM`
- **Link:** https://docs.google.com/spreadsheets/d/10qLYln2zUiMo7dEI3xZ8pj4ncGX7TRmATZNuZfvUfWM/edit

Rules for anyone (human or AI) who edits it:

1. Row 1 of every tab is the header. Column names are fixed English identifiers — never rename,
   reorder or delete columns. New columns go at the end and bump `settings.schema_version`.
2. All times are Israel time (`Asia/Jerusalem`). Dates are `yyyy-mm-dd`, date-times `yyyy-mm-dd hh:mm`.
   Every cell is stored as **plain text** (cell format "Plain text"), so dates never get auto-converted.
   When writing with a script, set the number format to `@` before writing.
3. `id` values are permanent. New ids: prefix + `_` + 6 random lowercase letters/digits
   (`t_` task, `s_` work session, `b_` block, `m_` Moodle inbox item, `g_` meta category; a category made in the app
   gets a readable slug from its English name, e.g. `statistics-2`, or `c_` + 6 characters).
4. Never delete a task row to "finish" it — set `status` to `done` or `cancelled`. Never delete a category or meta
   category that is used — archive it (`active` = `FALSE`).
5. Columns marked "app-managed" are written by the app / Apps Script only.
6. When you change a row, set `updated_at` to now.

## Tab `tasks` — one row per assignment / to-do

| Column | Meaning |
|---|---|
| `id` | `t_xxxxxx`. Permanent. |
| `title` | Task name (Hebrew or English). |
| `course` | The task's category: a `courses.slug` (e.g. `databases`). Empty = no category. |
| `status` | `todo` · `in_progress` · `done` · `cancelled` (UI: לא התחיל · בתהליך · הושלם · בוטל) |
| `due_date` | Deadline date. Empty = no deadline. |
| `due_time` | Optional `HH:MM`. Empty = end of that day. |
| `estimate_hours` | Optional: hours Bahr expects the task to take (הערכת זמן). |
| `spent_hours` | **App-managed.** Total time actually worked = sum of this task's `sessions.minutes` / 60 (2 decimals). |
| `notes` | Free text / instructions. |
| `links` | URLs or `Technion Studies/...` paths, one per line. |
| `source` | `manual` · `moodle` · `class` · `notion` (imported from the old Notion table on 2026-11-03). |
| `moodle_ref` | `post:<id>` or `assign:<id>` when the task came from Moodle. |
| `calendar_event_id` | App-managed: the deadline's event in the Google Calendar "משימות – הגשות". |
| `created_at`, `updated_at` | Timestamps. |

**Overdue** = `due_date` before today and `status` not `done`/`cancelled` (shown in red).

## Tab `sessions` — רישומי עבודה (time actually worked)

One row per stretch of real work: a finished pomodoro, a stopwatch run, or time added by hand.
Planned time is in `blocks`; actual time is here.

| Column | Meaning |
|---|---|
| `id` | `s_xxxxxx` (timer sessions get an id derived from task + start time, so devices never duplicate them). |
| `task_id` | The `tasks.id` worked on. |
| `start`, `end` | Date-times. Manual entries: `start` = `yyyy-mm-dd 00:00`, `end` empty. |
| `minutes` | Whole minutes worked (breaks excluded). |
| `kind` | `pomodoro` · `stopwatch` · `manual` |
| `note` | Optional. |
| `updated_at` | Timestamp. |

After any change to `sessions` the backend recomputes `tasks.spent_hours`. If you edit `sessions` by hand,
also update that task's `spent_hours`.

## Tab `blocks` — בלוקי עבודה (work blocks): scheduled time to work on a task

A task can have any number of blocks.

| Column | Meaning |
|---|---|
| `id` | `b_xxxxxx`. |
| `task_id` | The `tasks.id` it belongs to. |
| `start`, `end` | Date-times. Default length: `settings.default_block_minutes` (60). |
| `state` | `planned` · `done` · `skipped`. (`draft` is an old value: there are no drafts since schema 9 — the backend saves it as `planned`, and the schema-9 migration turned existing drafts into `planned`.) |
| `sync_calendar` | Empty = follow the setting `sync_blocks_to_calendar`; `FALSE` = never put this block in the calendar (the block's „להציג ביומן Google” box). |
| `calendar_event_id` | App-managed. |
| `note` | Optional: what to do in this block. |
| `updated_at` | Timestamp. |
| `calendar_id` | App-managed: the Google Calendar that holds the block's event now (see "Google Calendar" below). |

Per task: planned hours = sum of `planned`+`done` blocks; done hours = sum of `done` blocks.

## Tab `courses` — categories (קטגוריות)

Every task can belong to a category; a **course** is one kind of category (the one with Moodle details). Other
categories are anything Bahr groups tasks by, e.g. "בית" or a part of a project. Bahr adds, edits and archives them in
the app (the "קטגוריות" chip above the task list, or ⚙️ → קטגוריות וארכיון).

| Column | Meaning |
|---|---|
| `slug` | Permanent id, used in `tasks.course` and `moodle_inbox.course`. The courses use the same slugs as `.ai/courses.json`. |
| `name_he` | Full name. |
| `short_he` | Short label for chips and cards (empty = `name_he`). |
| `number` | Technion course number (courses only). |
| `moodle_course_id` | The course's id on moodle26.technion.ac.il (`…/course/view.php?id=575` → `575`). **Only rows with it are checked on Moodle.** |
| `moodle_news_forum_id` | Page id (cmid) of the course's לוח הודעות; optional, the backend finds the forum itself. |
| `color` | Hex colour (`#RRGGBB`), the only colour in the app besides the accent. |
| `active` | `TRUE`, or `FALSE` = **archived**. |
| `moodle_folder` | Path under `Technion Studies` of the course's Moodle folder in Drive (where the cloud check saves the לוח הודעות posts). Empty = nothing is saved to Drive from the cloud. |
| `group` | The meta category: a `groups.id`. |
| `sort` | Order inside the meta category (number). |
| `archived_at` | `yyyy-mm-dd` it was archived (empty while active). |
| `calendar` | Name of the Google Calendar for the confirmed work blocks of its tasks. Empty = the default: `settings.blocks_calendar_name` for a course (a category in a semester), `settings.other_blocks_calendar_name` for any other category. Chosen in the app (edit the category). |

## Tab `groups` — meta categories (קטגוריות־על)

What categories are grouped in: a semester (its categories are its courses), a project, general tasks
("משימות יומיות"), next semester…

| Column | Meaning |
|---|---|
| `id` | Permanent id (`g_xxxxxx`; the first one, made by the schema-7 migration from the existing courses, is `winter-2026-2027`). |
| `name` | e.g. `סמסטר חורף תשפ״ז`, `פרויקט גמר`, `משימות יומיות`. |
| `kind` | `semester` · `project` · `general`. A semester's categories are called courses and get the Moodle fields in the app. A new project / general meta category starts with one category of the same name. |
| `active` | `TRUE`, or `FALSE` = **archived** (with everything in it). |
| `sort` | Order of the meta categories (number). |
| `archived_at` | `yyyy-mm-dd` it was archived (empty while active). |
| `created_at`, `updated_at` | Timestamps. |

**Archive.** A category is archived when its own `active` is `FALSE` or its meta category's is. Archived = hidden in the
app together with its tasks (task list, chips, task editor, planner, and the inbox's "חדשות"); nothing is deleted and
Bahr can look at it and restore it from „קטגוריות” → „ארכיון”. The Moodle check and the AI review skip archived courses.
Archiving a meta category leaves its categories' own `active` as it was, so restoring it brings back exactly what was there.
A category is deleted only if no task and no Moodle message uses it, and a meta category only if it has no categories
(the backend refuses otherwise).

## Tab `moodle_inbox` — Moodle messages and the AI's suggestions (app-managed)

`id`, `course`, `kind`, `moodle_ref` (dedup key), `posted_at`, `title`, `author`, `text` (the **full** message, up to
40,000 characters), `detected_dates` (comma-separated `yyyy-mm-dd` or `yyyy-mm-dd HH:MM`), `url`,
`status` (`new` · `accepted` = handled, at least one task came from it · `ignored` = read, nothing to do), `task_id`,
`ai_status` (empty = waiting for the AI · `done` · `error: …` only for problems with that message — busy/quota never marks a message), `ai_summary` (1–2 Hebrew sentences),
`ai_suggestions` (JSON array, see below), `ai_checked_at`.

Filled every ~15 min by the backend from Technion Moodle (`moodle26.technion.ac.il`, Bahr's Moodle token in Script
Properties): `kind` = `announcement` (a post on a course's לוח הודעות, `moodle_ref` = `post:<discussion id>`),
`assignment` (an assignment with a due date, `assign:<id>`), or `date_change` (an assignment Bahr already has as a
task whose Moodle due date differs; `assign:<id>@<new date>`, `task_id` = that task).
If the Moodle API refuses, announcements are read from the Drive copy instead (`moodle_ref` = `post:file<first post id>`,
Markdown text, date only). Each check also saves the announcements themselves into Drive
(`<course moodle_folder>/<section>/לוח הודעות/<yy-mm-dd subject>/[<post id>] <author>.md` + attachments).

**A message is never a task by itself.** After each check, Gemini (key `GEMINI_KEY` in Script Properties) reads every
new `announcement`/`assignment` in full, together with Bahr's existing tasks and the open suggestions of other
messages, and writes `ai_suggestions` — a JSON array of:
- `{id, type:'new', state, title, course, due_date, due_time, estimate_hours, notes, reason, created_task_id}` — a task
  to add, only when nothing existing covers it;
- `{id, type:'update', state, task_id, title, old_due, due_date, due_time, notes_to_add, reason}` — the message changes
  an existing task (e.g. an extension);
- `{id, type:'covered', state:'info', task_id, title, reason}` — already covered by that task (shown for transparency).

`state`: `open` · `accepted` · `dismissed` (`info` for covered). Nothing becomes a task until Bahr accepts it in the app
(an AI may *suggest*, Bahr confirms). A task created from a suggestion gets `source=moodle` and the message's `moodle_ref`.
When the last open suggestion is handled, the message's `status` becomes `accepted`/`ignored`.

## Tab `settings`

Key/value pairs: `sync_deadlines_to_calendar`, `sync_blocks_to_calendar`, `default_block_minutes`,
`week_starts_on`, `timezone`, `moodle_check_minutes`, `pomodoro_focus_minutes` (25), `pomodoro_short_break_minutes` (5),
`pomodoro_long_break_minutes` (15), `pomodoro_long_break_every` (4), `pomodoro_auto_start_breaks` (TRUE),
`active_timer` (app-managed JSON of the running timer, shared by all devices — don't edit), `deadline_calendar_id`,
`blocks_calendar_name` (calendar for the work blocks of courses without a calendar of their own, default `לימודים`),
`other_blocks_calendar_name` (the same for every other category and for tasks without a category, default `Bahr Goren`;
in both, empty = the app's calendar `משימות – בלוקי עבודה`), `blocks_calendar_id` (old: the one calendar of all
block events before schema 8; only a fallback for blocks without `calendar_id`), `calendar_last_sync`, `calendar_status` (`ok · time` / `error · time · what`),
`calendar_watch` (calendars watched for changes made in Google Calendar: `ok · N calendars · time` / `error · time · what`), `moodle_last_check`,
`moodle_status` (all app-managed), `ai_model` (empty = automatic: newest Flash-Lite, then newest Flash; or a model id to try first),
`ai_status` (`ok · …` / `waiting · why · until · at` / `error · what · at`), `ai_last_error` (Gemini's text), `schema_version` (9).

## Google Calendar (optional, switched on in the app's settings)

- `sync_deadlines_to_calendar=TRUE` → each task with a due date is an all-day event in the calendar **משימות – הגשות**
  (⏰ open / ✓ done; cancelled or deleted tasks are removed). One-way: Sheet → Calendar.
- `sync_blocks_to_calendar=TRUE` → planned and done work blocks are events in Bahr's own calendars, each in its
  category's calendar: `courses.calendar` if set, else `blocks_calendar_name` for courses (**לימודים**) and
  `other_blocks_calendar_name` for every other category and for tasks without a category (**Bahr Goren**). A block
  is in the calendar as soon as it is placed on the planner (no drafts or „אשר תכנון” since schema 9); only `skipped`
  blocks and blocks with `sync_calendar` = `FALSE` stay out.
- **Two-way.** What Bahr changes in Google Calendar comes back to the block: moving or resizing the event changes the
  block's times; editing its description changes the block's `note` (the text before the app's footer, as one line);
  moving it to another calendar is followed (`calendar_id`) and the event stays there; deleting it deletes the block.
  The event's title comes from the task (rename the task in the app). Turning an event into an all-day one is ignored.
  A block is deleted only when its event is really gone — never because Google didn't answer.
- **How fast.** Every calendar that holds blocks has a calendar trigger (`onCalendarChange`, kept by
  `watchCalendars_`; result in `calendar_watch`), so a change there reaches the Sheet within about a minute. The app
  also asks for a pull when it opens or comes back to the screen (`bootstrap` with `pull: 1`, at most once a minute),
  then refreshes every 2 minutes while open. The 10-minute run pulls too, as a backstop.
- Each block remembers the calendar that holds its event (`blocks.calendar_id`). The event stays there until the
  calendar the block belongs in changes in the app — the category's calendar, a default, the task's category, a meta
  category's kind: then it is deleted there and created in the new calendar. (Editing those by hand in the Sheet
  doesn't move existing events; do it in the app.) A block without `calendar_id` was placed by an older version and is
  put where it belongs at the next run. A calendar name that doesn't exist leaves the blocks where they are and keeps
  an error in the app (`calendar_status`) until it's fixed.
- The planner also shows Bahr's other calendars as grey "busy" time (read-only).

## How programs access the data

- **Schema changes** are applied by the backend itself: `migrate_()` in `Code.gs` (runs from `setup()`, on the
  first request after a new version, and from the 10-minute trigger) reorders/creates columns and tabs by header name
  and keeps all data. Schema 7 added the `groups` tab and `courses.group/sort/archived_at`, and put the existing
  courses into the meta category `winter-2026-2027`. Schema 8 added `courses.calendar`, `blocks.calendar_id` and the
  setting `other_blocks_calendar_name` (`Bahr Goren`; his main calendar's name if no calendar is called that).
  Schema 9 added the setting `calendar_watch` (no column changes) and turned drafts into planned blocks.
- **The app** (https://bahrgoren-ship-it.github.io/task-tracker/) talks to an Apps Script web app bound to the
  Sheet (code: `apps-script/Code.gs` in the GitHub repo `bahrgoren-ship-it/task-tracker`). API: POST JSON
  `{key, action}` with `action` = `ping` · `bootstrap` (returns all tabs; `pull: 1` = first bring in changes made in Google Calendar) · `batch` (`ops: [{op:'upsert', table, row} |
  {op:'delete', table, id}]`; writable: tasks, sessions, blocks, courses, groups, moodle_inbox, settings, suggestions) · `busy` (`from`, `to` dates → events of Bahr's calendars) · `syncNow` · `moodleCheck` ·
  `setMoodleToken` (`token`) · `setGeminiKey` (`key_value`) · `aiReview` (optional `id` = review that message again). The key is secret (Script Properties) — never write it into files.
  A trigger runs `scheduledSync()` every 10 minutes (calendar two-way sync + Moodle check + AI review of new messages),
  and one calendar trigger per calendar that holds work blocks runs `onCalendarChange()` when an event there changes.
- **An AI with Google Drive / Sheets access** (Gemini, Claude with the Drive connector) can read the Sheet directly.
  To change data, edit cells following the rules above, or ask Bahr to make the change in the app.

## suggestions (schema 6; categories since schema 7)
Changes proposed by any AI that can edit the Sheet; the app shows them on the tasks screen and makes the change only when Bahr approves.
Columns: `id`, `status` (pending · approved · rejected), `summary`, `table` (tasks · blocks · sessions · courses · groups), `op` (create · update · delete), `row_id`, `fields` (JSON), `reason`, `by`, `created_at`, `decided_at`, `result` (id of the row made/changed).
How an AI writes one: [AI-SUGGESTIONS.md](AI-SUGGESTIONS.md). Rows typed without id/status get them on the next app load.
