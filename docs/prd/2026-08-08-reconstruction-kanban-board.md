# PRD: Reconstruction Kanban Board

- **Project**: others/reno-board
- **Date**: 2026-08-08
- **Status**: Approved <!-- Draft | Approved | Shipped | Superseded | Retired -->
- **Supersedes / Superseded by**: —

## Summary

A static webpage, hosted on GitHub Pages, that displays and manages the house-reconstruction task list as a kanban board. A Google Spreadsheet is the single source of truth; the page signs the user in with their Google account and reads/writes the sheet directly — no backend.

## Problem / Motivation

Reconstruction tasks live in a spreadsheet because it's easy to enter data and share with family. But a flat grid gives no at-a-glance picture of what's planned, in progress, blocked, or done, and reshuffling work between stages means editing status cells by hand. A kanban view over the same spreadsheet keeps the sheet's strengths (shared, durable, editable anywhere Google Sheets works) while adding the board UX for day-to-day management.

## Goals

- One glance shows the state of the whole reconstruction: every task in a column matching its status.
- Moving a task between stages is a single drag (or equivalent tap action), persisted to the spreadsheet immediately.
- Tasks can be created and edited from the board without opening Google Sheets.
- The spreadsheet remains fully usable directly: edits made in Sheets appear on the board, and board edits never corrupt or reorder unrelated rows.
- Both the owner and partner/family accounts can use the board with full edit rights.

## Non-Goals

- **No backend or database.** No server, no Supabase, no Apps Script web app — the browser talks to Google APIs directly (same model as GoodMetrics).
- **No photos or file attachments** (would require Drive scope) — a future PRD if wanted.
- **No comments/activity feed, notifications, or reminders.**
- **No budget analytics** beyond showing cost fields on cards and simple per-column/room totals; this is not a budgeting tool.
- **No public or anonymous access** — the board is useless without signing in with an authorized Google account; there is no read-only guest mode.
- **No offline editing.** The board requires connectivity; it is not a PWA with sync.
- ~~**No migration tooling** — the spreadsheet starts from the schema this PRD defines; there is no importer for pre-existing sheets.~~ *(Superseded 2026-08-09 by R14: TSV paste import.)*

## User Stories

- As the homeowner, I want to see all reconstruction tasks grouped by stage so that I know instantly what's blocked and what's next.
- As the homeowner, I want to drag a task from "Planned" to "In Progress" so that status updates take one gesture instead of editing a cell.
- As the homeowner, I want to add a task from my phone while standing in the room so that nothing gets forgotten.
- As a partner/family member, I want to open the same board with my own Google account so that we coordinate on one shared state.
- As the homeowner, I want to filter the board by room and by contractor so that I can prepare for a specific contractor's visit.
- As the homeowner, I want cost estimate vs. actual visible on cards so that money conversations happen from the same view as the work.
- As a spreadsheet user, I want any edit I make directly in Google Sheets to show up on the board so that the sheet stays the source of truth.

## Requirements

1. **R1 — Google sign-in.** The page authenticates via Google (browser-side OAuth token, the GoodMetrics pattern). Until sign-in succeeds, no data is shown. Any Google account may attempt sign-in; only accounts with edit access to the spreadsheet can load/modify data — the board surfaces Google's permission error as a clear "no access" message.
2. **R2 — Spreadsheet is the datasource.** All task data lives in one Google Spreadsheet defined by the app (see R3). The board holds no state that isn't in the sheet; a full page reload reproduces the board purely from the sheet.
3. **R3 — App-defined schema.** The spreadsheet has a `Tasks` tab whose columns are: `ID` (stable unique identifier, never reused), `Title`, `Status`, `Room`, `Contractor`, `Cost Estimate`, `Cost Actual`, `Due Date`, `Priority`, `Notes`, `Created`, `Updated`. A `Config` tab defines the ordered list of statuses (default: Backlog, Planned, In Progress, Blocked, Done) and the list of rooms. The board renders exactly the columns/rooms the Config tab defines.
4. **R4 — Kanban display.** Tasks render as cards in columns by `Status`, ordered by `Priority` then `Due Date`. Cards show title, room, contractor, due date, and cost (estimate, plus actual when present). Overdue tasks are visually flagged.
5. **R5 — Drag to move.** Dragging a card to another column (or an equivalent explicit action on touch devices) updates that task's `Status` and `Updated` in the sheet. The card must not appear "moved" if the write failed — on failure it returns to its origin with an error message.
6. **R6 — Create and edit.** The board can create a task (auto-assigning a new `ID` and `Created`) and edit any field of an existing task through a card detail form. Field inputs for `Status` and `Room` are constrained to Config-tab values.
7. **R7 — Safe writes.** Every write locates the row by `ID`, never by row position, and re-reads the sheet immediately before writing. If the task was modified or deleted since the board last loaded it, the board refreshes and asks the user to retry rather than overwriting.
8. **R8 — Freshness.** The board refreshes data on load, on window focus, and via a manual refresh control, so direct spreadsheet edits appear without a full page reload.
9. **R9 — Filters and totals.** The board can filter by room and by contractor, and shows a cost summary (estimate and actual totals) for the current filter.
10. **R10 — Delete/archive.** A task can be archived from the board (moved to an `Archive` tab in the sheet), keeping the `Tasks` tab clean without losing history. Hard delete only happens in Sheets directly.
11. **R11 — Mobile-usable.** All flows in R4–R10 work on a phone-sized screen, including moving a card between columns without drag-and-drop.
12. **R12 — Multi-user.** The owner and partner/family accounts (added as spreadsheet editors and, while the OAuth app is in testing mode, as test users) all get identical full edit capability. Two people using the board at once must not corrupt each other's rows (guaranteed by R7).
13. **R13 — Epics as labels.** Each task can carry a free-text `Epic` label grouping related tasks. Cards display it as a tag; the board can filter by epic, showing done-count and cost totals for the group. No hierarchy, roll-up statuses, or subtasks.
14. **R14 — TSV import.** The board can import tasks from pasted TSV. The first row must be a header naming at least `Title`; recognized columns map by name in any order, unknown columns are ignored. Missing IDs/timestamps are generated; rows whose ID already exists are skipped; malformed costs/dates and unknown statuses/rooms/priorities produce warnings shown before import, never silent data mangling. All parsed rows are appended in a single write.

## UX Notes

- **Login view** → **Board view**, mirroring GoodMetrics' two-view structure: a minimal landing card with a "Sign in with Google" button, then the board.
- Board: horizontal columns from the Config tab; on mobile, columns collapse to horizontally swipeable panes or a segmented status switcher.
- Card tap opens a detail sheet/modal with all fields editable; "Move to…" status picker doubles as the touch alternative to drag-and-drop.
- Filter bar (room, contractor) pinned above the board; cost totals for the active filter next to it.
- Error states: not-signed-in, no-access-to-sheet, write-conflict (per R7), offline/API failure — each with plain-language messaging and a retry path.
- Visual language can start from GoodMetrics' clean static-page styling; no design system exists for this project yet.

## Success Metrics

- The spreadsheet's `Status` column is maintained through the board: after the first month, status changes are made via the board rather than manual cell edits (observable from `Updated` stamps vs. sheet edit history).
- Both household members have signed in and moved/created at least one task (visible in sheet revision history under both accounts).
- Zero data-loss incidents: no task rows corrupted, duplicated, or mis-updated by board writes during the reconstruction.
- The board stays in use for the duration of the reconstruction (weekly edits visible in sheet history) instead of drifting back to spreadsheet-only management.

## Links

- Spec / plan (working artifacts, may be deleted later): —
- Related PRDs: —
- Reference implementation for auth/data pattern: `Repos/Internal/GoodMetrics` (GIS browser OAuth + direct Sheets REST, static GitHub Pages hosting)
- Shipping release / build: —

## Decision Log

| Date | Decision | Why |
|------|----------|-----|
| 2026-08-08 | Direction A: read/write kanban over the sheet (rejected B: read-only board; C: full task manager with photos/comments) | B fails the "manages" requirement; C adds Drive scope and large surface for marginal value on a single-house project. A covers display + management at medium effort; C features can be follow-up PRDs. |
| 2026-08-08 | Fresh app-defined spreadsheet schema | No existing sheet structure to preserve; a canonical schema with a stable `ID` column makes safe writes (R7) possible. |
| 2026-08-08 | Google auth via browser-side OAuth, no backend, GitHub Pages hosting | User constraint; proven by GoodMetrics/LogenEditor. Keeps secrets out of the repo (only client ID + sheet ID are public) and hosting free. |
| 2026-08-08 | Full edit rights for all users; no roles/guest mode | Only owner + partner/family use it; access control delegated to Google's own sheet permissions. |
| 2026-08-08 | Archive tab instead of delete | Preserves history for a long-running project while keeping the board clean. |
| 2026-08-09 | Client + spreadsheet IDs hardcoded; config UI removed | Single-household tool with one fixed datasource; app auto-creates missing tabs in the user's existing spreadsheet instead of creating new spreadsheets. |
| 2026-08-09 | Epics as free-text labels (R13), rejected real parent/subtask hierarchy | Hierarchy fights the flat-row sheet model and kanban form; labels + filter give the grouping/progress view at a fraction of the complexity. |
| 2026-08-09 | TSV paste import (R14) supersedes the "no migration tooling" non-goal | The user migrates their pre-existing task list via LLM-generated TSV; paste-with-preview is the cheapest safe path in. |
