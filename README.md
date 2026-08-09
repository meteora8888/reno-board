# Reno Board

A kanban board for the house reconstruction, hosted on GitHub Pages. The datasource
is a Google Spreadsheet — the browser signs in with Google (Google Identity Services)
and calls the Sheets REST API directly. **No backend**; the same model as
[GoodMetrics](../../../Internal/GoodMetrics).

PRD: [docs/prd/2026-08-08-reconstruction-kanban-board.md](docs/prd/2026-08-08-reconstruction-kanban-board.md)

## How it works

- `Tasks` tab is the source of truth. Columns `A..Q`:
  `ID, Title, Status, Room, Contractor, Cost Estimate, Cost Actual, Due Date, Priority, Notes, Created, Updated, Epic, Depends On, Assignee, Title EN, Notes EN`
- Savings: `Cost Estimate − Cost Actual` per task, shown on cards and totaled in the
  summary (tooltip tracks progress toward halving the budget).
- `Title EN`/`Notes EN` power the SK/EN toggle (fill via LLM; Slovak is the fallback).
- Export copies visible tasks as TSV; import updates touch only pasted columns;
  archive/moves have Undo; UI state persists in localStorage.
- `Assignee` is the household member who owns/follows up the task (vs. `Contractor`,
  the hired company). Shown as an @ tag on cards, with its own filter.
- `Epic` is a free-text label grouping related tasks (e.g. "Bathroom renovation");
  the board shows it as a card tag and a filter with done-count and cost totals.
- `Depends On` holds comma-separated predecessor task IDs. Cards with unfinished
  predecessors get a ⛓ badge and sort below actionable ones; the ⚡ Ready toggle
  shows only tasks you can start now. Cycles are rejected; archived/unknown IDs
  count as satisfied.
- `Config` tab drives the board: column **A** = ordered statuses (board columns),
  column **B** = rooms. Rename/reorder there — no code change needed. The last
  status in the list is treated as "done" (no overdue highlighting).
- `Archive` tab receives archived tasks (same columns).
- Every write re-reads the sheet, locates the row by `ID` (never by position) and
  compares the `Updated` stamp first — concurrent edits from the board and from
  Google Sheets can't corrupt each other. On conflict the board refreshes and asks
  you to retry.
- The board refreshes on load, on window focus, and via the ↻ button.

You can always edit the spreadsheet directly in Google Sheets; the board picks the
changes up on the next refresh.

**Import**: the Import button accepts pasted TSV. First row = header with at least
`Title`; recognized columns (any order): ID, Title, Status, Room, Contractor,
Cost Estimate, Cost Actual, Due Date, Priority, Notes, Epic. Missing IDs and
timestamps are generated. Import is an **upsert**: rows whose ID already exists
overwrite that task in place (re-pasting a corrected TSV is the intended way to
fix bulk mistakes); parse warnings are shown before anything is written. The
search bar filters cards accent-insensitively across title, notes, contractor,
epic and room.

## Deployment

Live at **https://meteora8888.github.io/reno-board/** (GitHub Pages, `main` branch,
repo `meteora8888/reno-board`).

The OAuth client ID and the spreadsheet ID are hardcoded in `app.js` (`CLIENT_ID`,
`SHEET_ID`). Neither is a secret — data stays in the sheet behind Google auth and
sheet permissions. On first sign-in the app creates any missing `Tasks`/`Config`/
`Archive` tabs in the spreadsheet; other tabs are left untouched.

The Google Cloud setup behind it (project with Sheets API enabled, OAuth consent
screen in *Testing* mode, web client with the `meteora8888.github.io` and
`localhost:8000` origins): access control is (a) the **test users** list on the
consent screen and (b) **editor sharing on the spreadsheet** — a new family member
needs both. In testing mode tokens last ~1 h; the board then shows a one-click
"Sign in again" banner.

## Local development

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

GIS requires the origin to be authorized — hence the `localhost:8000` origin in
step 1.4. Opening `index.html` via `file://` will not work.
