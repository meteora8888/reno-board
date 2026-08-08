# Reno Board

A kanban board for the house reconstruction, hosted on GitHub Pages. The datasource
is a Google Spreadsheet — the browser signs in with Google (Google Identity Services)
and calls the Sheets REST API directly. **No backend**; the same model as
[GoodMetrics](../../../Internal/GoodMetrics).

PRD: [docs/prd/2026-08-08-reconstruction-kanban-board.md](docs/prd/2026-08-08-reconstruction-kanban-board.md)

## How it works

- `Tasks` tab is the source of truth. Columns `A..L`:
  `ID, Title, Status, Room, Contractor, Cost Estimate, Cost Actual, Due Date, Priority, Notes, Created, Updated`
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

## One-time setup

### 1. Google OAuth client

1. Open [Google Cloud console](https://console.cloud.google.com/) → create (or pick)
   a project → **APIs & Services**.
2. **Enabled APIs** → enable **Google Sheets API**.
3. **OAuth consent screen** → External, app name "Reno Board", add yourself and the
   family accounts as **test users**. Leave it in *Testing* — no verification needed.
   (Note: in testing mode tokens last ~1 h, then the board shows a one-click
   "Sign in again" banner.)
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorized JavaScript origins:
   - `https://<your-github-username>.github.io`
   - `http://localhost:8000` (for local development)
   No redirect URIs needed (token flow uses a popup).
5. Copy the client ID into `DEFAULT_CLIENT_ID` in `app.js` (or paste it in the
   login view's "Configure client ID" — it's stored in localStorage). The client ID
   is not a secret; committing it is fine.

### 2. Spreadsheet

Sign in on the board, then either click **Create new spreadsheet** (it creates the
tabs, headers and default config for you) or paste the ID of a sheet that already
follows the schema. Then, in Google Sheets, **share the spreadsheet** with the
family accounts as editors — sheet permissions are the only access control.

### 3. GitHub Pages

```bash
# from this directory, into a new public repo (personal identity)
git init && git add . && git commit -m "Reno Board"
git remote add origin git@personal:<your-github-username>/reno-board.git
git push -u origin main
```

Repo → Settings → Pages → deploy from `main` / root. The site appears at
`https://<your-github-username>.github.io/reno-board/`. Make sure that origin's
host is listed in the OAuth client's authorized origins (step 1.4).

Nothing sensitive ships in the repo: only the OAuth client ID and (in localStorage,
not in code) the spreadsheet ID. All data stays in the sheet behind Google auth.

## Local development

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

GIS requires the origin to be authorized — hence the `localhost:8000` origin in
step 1.4. Opening `index.html` via `file://` will not work.
