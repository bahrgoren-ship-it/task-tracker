# Task tracker — data schema (schema_version 3)

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
   (`t_` task, `s_` work session, `b_` block, `m_` Moodle inbox item).
4. Never delete a task row to "finish" it — set `status` to `done` or `cancelled`.
5. Columns marked "app-managed" are written by the app / Apps Script only.
6. When you change a row, set `updated_at` to now.

## Tab `tasks` — one row per assignment / to-do

| Column | Meaning |
|---|---|
| `id` | `t_xxxxxx`. Permanent. |
| `title` | Task name (Hebrew or English). |
| `course` | A `courses.slug` (e.g. `databases`). Empty = not course-specific. |
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
| `state` | `draft` (planning, never on the calendar) · `planned` · `done` · `skipped` |
| `sync_calendar` | Empty = follow the setting `sync_blocks_to_calendar`; `FALSE` = never put this block in the calendar. |
| `calendar_event_id` | App-managed. |
| `note` | Optional: what to do in this block. |
| `updated_at` | Timestamp. |

Per task: planned hours = sum of `planned`+`done` blocks; done hours = sum of `done` blocks.

## Tab `courses`

`slug`, `name_he`, `short_he` (chip label), `number`, `moodle_course_id` (on moodle26.technion.ac.il),
`moodle_news_forum_id` (the course's לוח הודעות forum module), `color` (hex), `active`,
`moodle_folder` (path under `Technion Studies`). Same slugs as `.ai/courses.json`.

## Tab `moodle_inbox` — new Moodle items waiting for Bahr's decision (app-managed)

`id`, `course`, `kind`, `moodle_ref` (dedup key), `posted_at`, `title`, `author`, `text`, `detected_dates`
(comma-separated `yyyy-mm-dd` or `yyyy-mm-dd HH:MM`), `url`, `status` (`new` · `accepted` · `ignored`), `task_id`.

Filled every ~15 min by the backend from Technion Moodle (`moodle26.technion.ac.il`, Bahr's Moodle token in Script
Properties): `kind` = `announcement` (a post on a course's לוח הודעות, `moodle_ref` = `post:<discussion id>`),
`assignment` (an assignment with a due date, `assign:<id>`), or `date_change` (an assignment Bahr already has as a
task whose Moodle due date differs; `assign:<id>@<new date>`, `task_id` = that task).
Nothing here becomes a task until Bahr accepts it (an AI may *suggest*, Bahr confirms). A task created from an item
gets `source=moodle` and the item's `moodle_ref`.

## Tab `settings`

Key/value pairs: `sync_deadlines_to_calendar`, `sync_blocks_to_calendar`, `default_block_minutes`,
`week_starts_on`, `timezone`, `moodle_check_minutes`, `pomodoro_focus_minutes` (25), `pomodoro_short_break_minutes` (5),
`pomodoro_long_break_minutes` (15), `pomodoro_long_break_every` (4), `pomodoro_auto_start_breaks` (TRUE),
`active_timer` (app-managed JSON of the running timer, shared by all devices — don't edit), `deadline_calendar_id`,
`blocks_calendar_id`, `calendar_last_sync`, `moodle_last_check`, `moodle_status` (all app-managed), `schema_version`.

## Google Calendar (optional, switched on in the app's settings)

- `sync_deadlines_to_calendar=TRUE` → each task with a due date is an all-day event in the calendar **משימות – הגשות**
  (⏰ open / ✓ done; cancelled or deleted tasks are removed). One-way: Sheet → Calendar.
- `sync_blocks_to_calendar=TRUE` → planned and done work blocks are events in **משימות – בלוקי עבודה**. Two-way:
  moving an event there changes the block's times; deleting it deletes the block. Drafts never go to the calendar.
- The planner also shows Bahr's other calendars as grey "busy" time (read-only).

## How programs access the data

- **Schema changes** are applied by the backend itself: `migrate_()` in `Code.gs` (runs from `setup()` and on the
  first request after a new version) reorders/creates columns and tabs by header name and keeps all data.
- **The app** (https://bahrgoren-ship-it.github.io/task-tracker/) talks to an Apps Script web app bound to the
  Sheet (code: `apps-script/Code.gs` in the GitHub repo `bahrgoren-ship-it/task-tracker`). API: POST JSON
  `{key, action}` with `action` = `ping` · `bootstrap` (returns all tabs) · `batch` (`ops: [{op:'upsert', table, row} |
  {op:'delete', table, id}]`) · `busy` (`from`, `to` dates → events of Bahr's calendars) · `syncNow` · `moodleCheck` ·
  `setMoodleToken` (`token`). The key is secret (Script Properties) — never write it into files.
  A trigger runs `scheduledSync()` every 10 minutes (calendar two-way sync + Moodle check).
- **An AI with Google Drive / Sheets access** (Gemini, Claude with the Drive connector) can read the Sheet directly.
  To change data, edit cells following the rules above, or ask Bahr to make the change in the app.
