# Suggesting changes to Bahr's tasks (for any AI)

The same text is in the Sheet, tab **„AI – איך להציע”**.

```
How to suggest a change to Bahr's tasks (for any AI that can edit this Sheet)

Add ONE ROW to the tab "suggestions" for each change. Bahr sees it in the app and approves or rejects it. Never edit the
tasks / blocks / sessions tabs directly. Leave id, status, created_at, decided_at, result empty (filled automatically).

Columns:
  summary  – what the change is, short Hebrew, written to Bahr (male), e.g. "להוסיף משימה: תרגיל בית 3 בסטטיסטיקה, הגשה ב-20.11"
  table    – tasks | blocks | sessions   (tasks = the task list; blocks = planned work time in the planner; sessions = time already worked)
  op       – create | update | delete
  row_id   – for update / delete: the id of the existing row (e.g. t_ab12cd). Empty for create.
  fields   – JSON object with only the columns to set, e.g. {"title":"תרגיל בית 3","course":"statistics-1","due_date":"2026-11-20","due_time":"23:59"}
  reason   – why (one short Hebrew sentence)
  by       – who suggests it (e.g. "Gemini", "Claude")

Allowed fields:
  tasks:    title, course (a slug from the courses tab), status (todo | in_progress | done | cancelled), due_date (yyyy-mm-dd),
            due_time (HH:MM), estimate_hours (number), notes, links (one URL per line).
            create may also include "blocks": [{"start":"2026-11-10 18:00","end":"2026-11-10 19:00"}] to plan work time for it.
  blocks:   task_id, start, end ("yyyy-mm-dd HH:MM", Israel time), state (draft | planned | done | skipped), note.
  sessions: task_id, start, end, minutes (number), note.

Rules: one change per row (several rows are fine). Dates/times are Israel time. Check the tasks tab first so you don't
suggest something that already exists. Don't suggest the same thing twice — look at pending rows in "suggestions".

Examples (fields column):
  tasks create   {"title":"הכנה לבוחן אמצע","course":"algebraic-methods","due_date":"2026-12-13","estimate_hours":6}
  tasks update   row_id t_ab12cd   {"due_date":"2026-11-22","due_time":"12:00"}
  tasks update   row_id t_ab12cd   {"status":"done"}
  blocks create  {"task_id":"t_ab12cd","start":"2026-11-10 18:00","end":"2026-11-10 20:00","state":"planned"}
  blocks delete  row_id b_xy34zz   {}
```
