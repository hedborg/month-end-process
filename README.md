# Month-End Process

A checklist tool for running the monthly accounting close. Replaces the
"Accounting action plan - Month End Overview" spreadsheet with something that
can track multiple months in parallel, assign tasks to people, and roll one
month's checklist forward into the next.

Light mode is the default; the 🌙 button in the header toggles dark mode and
remembers the choice per browser (`localStorage`, not per-user).

Using the app day-to-day? See [MANUAL.md](MANUAL.md) instead — this README
is about running/deploying it.

## Quick start (Docker)

```bash
docker compose up --build
# App: http://localhost:3001
```

The first time the `postgres` container starts, it runs everything in `db/`
in order: `01-init.sql` creates the schema, `02-seed.sql` loads the users and
the June 2026 checklist that this tool was bootstrapped from.

## Local dev (no Docker)

```bash
# 1. Start Postgres (or point to an existing one)
docker compose up postgres -d

# 2. Start backend
cd backend
cp ../.env.example .env   # edit as needed
npm install
npm run dev
# → http://localhost:3000
```

## Data model

- **users** — people tasks can be assigned to.
- **cycles** — one row per month-end close (e.g. `2026-07`). Several can be
  `open` at once, so overlapping month-ends are just a normal case, not a
  special one. Status is one of `open`, `locked`, `archived`.
- **tasks** — belong to a cycle. Each task has two independent progress
  tracks, matching how the original checklist worked: a *Booking Responsible*
  person/status (doing the work) and a *Quality Check* person/status
  (reviewing it). Status values: `not_started`, `in_progress`, `waiting`,
  `ready_to_be_booked`, `done`, `n_a`.

`ready_to_be_booked` sits between `in_progress`/`waiting` and `done` — a
medium green, distinct from the light green of `in_progress` and the dark
green of `done`. It's meant for the Quality Check person to signal to the
Booking Responsible person that the numbers are in and checked, and it's
ready to actually be booked.

A task counts as complete when its booking status is `done`/`n_a` and — if a
quality checker is assigned — the check status is also `done`/`n_a`. The
"Hide completed" toggle in the UI filters on that.

The toolbar also has dropdown filters for Booking Responsible, Booking
Status, and Quality Check (each includes an "— Unassigned —" option), plus a
"Clear filters" button. The Links column holds an editable field for both the
task URL and the Power BI URL — a 🔗/📊 icon appears next to whichever ones
are set so they stay clickable while still editable.

Dependency is a text field backed by a `<datalist>` of the current cycle's
task names — click in and pick one, or keep typing free text. It stays free
text on purpose: real checklists have dependencies like "All the above" that
don't map to a single task, so a hard dropdown would lose that.

## Overview report (home page)

The app opens on an Overview tab: a pivot of every task (rows) against the
last 6 cycles (columns, oldest to newest), showing booking status
color-coded per cell, plus the finished date under any cell marked Done.
Click a column's Year-Month header to drill straight into that cycle's full
checklist. Click a task's status pill instead to open a quick-edit modal for
just that task/month — every field (description, owners, both statuses,
finished date, comment, links) editable without leaving the Overview, plus
an "Open in Checklist" link if you need the full view (reordering, delete,
adding a task, etc.). If a task has a dependency set, it's shown as a small
muted line under the task name (its most recent month's dependency, same as
the task name itself).

A "Filter by user" dropdown above the table narrows the rows to tasks where
that person is either the Booking Responsible or the Quality Check on any of
the displayed months — a personal "what's on my plate" view, without hiding
the other months for a matched task.

"Hide completed" (same idea as on the Checklist) removes a row only once
every displayed month for that task is `done`/`n_a` — a task that's wrapped
up in the current month but still open in an earlier one stays visible.

A task is matched across months by lineage, not by name: cloning a task sets
its `cloned_from_task_id` back to the source task, and `GET
/api/report/pivot` walks that chain (via a recursive CTE) to group every
occurrence of "the same task" under one row, however many times it's been
cloned forward. A task that's new this month, or that existed once and was
later deleted, just shows a blank cell for the months it wasn't present in.

## Rolling a month forward

`POST /api/cycles/:id/clone` always targets the calendar month right after
the source cycle (`2026-06` → `2026-07`, `2026-12` → `2027-01`) — there's
nothing to fill in. It copies every task into the new cycle, keeping
names/owners/links/dependencies but resetting both status fields to
`not_started` and clearing finished dates and comments. Tasks that were
`n_a` stay `n_a` — that's the one status that carries over, since "not
applicable" is a property of the task, not the month's progress. Cloning into
a month that already exists returns a 409. The "Clone into new month" button
in the UI drives this with a one-line confirmation.

## Production (DigitalOcean Droplet)

The app runs on a DigitalOcean droplet via Docker Compose, following the same
pattern as the `recon` tool:

```bash
cd /opt/month-end-process && git pull && docker compose up -d --build
```

**View logs:**
```bash
docker compose logs -f app
```

**Check running containers:**
```bash
docker compose ps
```

Host ports default to `3001` (app) and `5433` (postgres) instead of the more
common `3000`/`5432`, so this can run on the same droplet as another
Docker Compose app without a port clash.
