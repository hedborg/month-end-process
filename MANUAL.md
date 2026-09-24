# Month-End Process — Quick Guide

A shared checklist for running the monthly accounting close, with an
at-a-glance view across months.

## Signing in

Enter your first name and password. If you don't have a password yet, ask
an admin to set one for you in the **Users** modal —
there's no self-service signup or "forgot password," on purpose, for a team
this size. Once you're in, the **Users** modal lets you change your own
password and generate your own API token (for Claude/MCP); only admins can
add people or change anyone else's account. You stay signed in for 30 days; **Logout** (top right) ends that
early if you're on a shared machine.

## Overview (the home page)

- One row per task, one column per recent month.
- Colored pill = booking status for that task/month:
  🔴 Not Started · 🟠 Waiting · 🟢 In Progress · 🟢 Ready to be Booked (medium)
  · 🟢 Done (darkest) · ⚪ N/A
- **Ready to be Booked** is for the Quality Check person to set — it tells
  the Booking Responsible person "the numbers are in and checked, go ahead
  and book it."
- **Click a pill** to edit that task's full details without leaving the page.
- **Click a month's header** (e.g. "2026-07") to open the full checklist for
  that month.
- **"Show my tasks"** — checked by default when you log in, showing only
  tasks where you're Booking Responsible or Quality Check. Uncheck it (or
  the "Filter by user" dropdown next to it, which is the same thing) to see
  everyone's.
- **"Hide completed"** — same idea as on the Checklist. A task only
  disappears once it's Done/N/A in *every* month shown, so something
  finished this month but still open from an earlier one stays visible.

## Checklist (full detail view)

- One row per task for the selected month. Click into any field to edit —
  text fields save when you click away, dropdowns save immediately.
- Two independent statuses per task: **Booking Status** (doing the work) and
  **Check Status** (reviewing it).
- **Description** vs **Comment** — easy to mix up, so worth being deliberate:
  Description is the standing instructions for the task (what to do, how) and
  carries over every time you clone into a new month. Comment is this
  month's log only (what's been done, open questions, anything worth
  flagging) and starts blank again next month. Put permanent how-to changes
  in Description; put "for this month" notes in Comment.
- Drag the `⠿` handle to reorder tasks.
- **Hide completed** and **Show my tasks** (same as on the Overview,
  checked by default), plus a Booking Status dropdown, to narrow a long list.
- **+ Add Task** for something new this month.
- **Dependency** — click in for a dropdown of this month's task names, or
  type your own text (e.g. "All the above").
- **Links** column holds both a document URL and a Power BI URL; a 🔗/📊 icon
  appears once one is filled in.

## Starting a new month

Click **"Clone into new month"** — it automatically targets the next
calendar month and copies every task over: names, owners, links,
dependencies, and **Description** all carry through unchanged; statuses
reset to Not Started (N/A tasks stay N/A); finished dates and **Comments**
are cleared blank.

⚠️ Don't add the same task separately to two different months — cloning is
what links a task's history together across months in the Overview. If you
missed adding a task and cycles already exist for it, add it to the
earliest month and clone forward from there instead.

## My To-Do

Your own private list — **only you can see it**, not your colleagues and
not admins. Use it for anything that isn't a month-end task: follow-ups,
reminders, things you're waiting on.

- **Add** by typing in the box at the top and pressing Enter; optionally
  pick a due date and priority first.
- **Tick the checkbox** to mark something done (untick to reopen). Done
  items stay visible for 14 days.
- **Click a to-do's title** to edit it — add notes, change the due date, or
  set it to **Waiting on someone** with a **Follow up on** date for when to
  chase. It reappears under Today on that date.
- The list is grouped into Overdue, Today, Next 7 days, Later / no date,
  Waiting on someone, and Done.
- The panel on the right lists your outstanding month-end tasks across all
  open months, so the tab doubles as your "what's on my plate today" page.
- A ✨ means Claude added it. If you've connected Claude to MEP, you can ask
  it things like "what's in MEP today?", "remind me to chase the auditor on
  Friday", or "mark the VAT file as done".

## Users

**Users** button (top right). Everyone can change their own password and
generate their own API token for connecting Claude. Admins can also add
people, mark someone inactive, reset anyone's password, make someone an
admin, and revoke someone else's token. Nobody, admins included, can
generate a token for someone else. Passwords are hashed; nobody,
including whoever built this tool, can look up what a password actually is.

## Dark mode

🌙 button (top right) toggles dark mode. Remembered per browser.
