'use strict';

/**
 * Reno Board — kanban over a Google Spreadsheet.
 *
 * Auth model (same as GoodMetrics): Google Identity Services issues a browser-side
 * OAuth access token; the page calls the Sheets REST API directly. No backend,
 * nothing stored outside the spreadsheet. Client and spreadsheet IDs are hardcoded.
 *
 * Datasource contract (PRD R3):
 *   Tasks tab   — columns A..M: ID, Title, Status, Room, Contractor, Cost Estimate,
 *                 Cost Actual, Due Date, Priority, Notes, Created, Updated, Epic
 *   Config tab  — A: Statuses (ordered board columns), B: Rooms; row 1 is headers
 *   Archive tab — same columns as Tasks; archived rows are appended here
 *
 * Write safety (PRD R7): every mutation re-reads the Tasks tab, locates the row by
 * ID (never by position) and compares the Updated stamp before writing.
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';

const TASK_HEADERS = ['ID', 'Title', 'Status', 'Room', 'Contractor', 'Cost Estimate',
    'Cost Actual', 'Due Date', 'Priority', 'Notes', 'Created', 'Updated', 'Epic', 'Depends On', 'Assignee',
    'Title EN', 'Notes EN'];
const COST_HEADERS = ['ID', 'Date', 'Description', 'Amount', 'Epic', 'Contractor', 'Notes', 'Created', 'Updated'];
const DEFAULT_STATUSES = ['Backlog', 'Planned', 'In Progress', 'Blocked', 'Done'];
const DEFAULT_ROOMS = ['Kitchen', 'Living room', 'Bedroom', 'Bathroom', 'Hallway', 'Exterior', 'Whole house'];
const PRIORITY_ORDER = { High: 0, Medium: 1, Low: 2 };

const CLIENT_ID = '912696421333-2u23vokjb2cr44g2s7ms1pgg75eu9dhi.apps.googleusercontent.com';
const SHEET_ID = '1Ks840Vx-JlLiaSgfmIAo0Satly7wne-9qurs6QZRGtI';

const state = {
    token: null,
    tasks: [],          // [{id, title, status, room, contractor, costEst, costAct, due, priority, notes, created, updated}]
    statuses: DEFAULT_STATUSES,
    rooms: DEFAULT_ROOMS,
    filterRoom: '',
    filterContractor: '',
    filterEpic: '',
    filterAssignee: '',
    searchText: '',
    readyOnly: false,
    dueSoonOnly: false,
    view: 'board',      // 'board' | 'timeline' | 'costs'
    lang: 'sk',         // 'sk' | 'en' — EN uses the Title EN / Notes EN columns
    costs: [],          // standalone expenses without a task (Costs tab)
    editingCostId: null,
    editingId: null,    // task being edited in the modal, null = new task
    lastLoadAt: 0,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Auth (Google Identity Services token flow)
// ---------------------------------------------------------------------------

let tokenClient = null;

function gisReady() {
    return typeof google !== 'undefined' && google.accounts && google.accounts.oauth2;
}

function ensureTokenClient() {
    if (tokenClient) return true;
    if (!gisReady()) {
        toast('Google Sign-In is still loading. Try again in a moment.', 'error');
        return false;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: onToken,
    });
    return true;
}

function signIn(prompt) {
    if (!ensureTokenClient()) return;
    tokenClient.requestAccessToken({ prompt: prompt ?? 'select_account' });
}

async function onToken(response) {
    if (response.error !== undefined) {
        toast('Sign-in failed. Check that this page’s URL is an authorized origin for the client ID.', 'error');
        showView('login-view');
        return;
    }
    state.token = response.access_token;
    $('stale-banner').classList.add('hidden');
    await enterBoard();
}

function signOut() {
    if (state.token && gisReady()) google.accounts.oauth2.revoke(state.token, () => {});
    state.token = null;
    state.tasks = [];
    showView('login-view');
}

// ---------------------------------------------------------------------------
// Sheets API
// ---------------------------------------------------------------------------

class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body = null } = {}) {
    if (!state.token) throw new ApiError('Not signed in.', 401);
    const res = await fetch(`${SHEETS_API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${state.token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
        state.token = null;
        $('stale-banner').classList.remove('hidden');
        throw new ApiError('Session expired — sign in again.', 401);
    }
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error?.message || ''; } catch { /* ignore */ }
        const msg = res.status === 403
            ? 'No access to this spreadsheet. Sign in with an account that can edit it.'
            : res.status === 404
                ? 'Spreadsheet not found — was it deleted or moved?'
                : `Google Sheets error (${res.status}). ${detail}`;
        throw new ApiError(msg, res.status);
    }
    return res.json();
}

// Google Sheets serial-date → ISO string (serial 0 = 1899-12-30). Direct edits in
// the Sheets UI can turn our string dates into real date cells; normalize on read.
function fromCell(value, isDate) {
    if (value === undefined || value === null) return '';
    if (isDate && typeof value === 'number') {
        const ms = Math.round((value - 25569) * 86400 * 1000); // 25569 = days 1899-12-30 → 1970-01-01
        return new Date(ms).toISOString().slice(0, 10);
    }
    return String(value);
}

function fromCostCell(value) {
    if (value === undefined || value === null || value === '') return '';
    const n = Number(value);
    return Number.isFinite(n) ? n : '';
}

function parseTaskRow(row) {
    return {
        id: fromCell(row[0]),
        title: fromCell(row[1]),
        status: fromCell(row[2]),
        room: fromCell(row[3]),
        contractor: fromCell(row[4]),
        costEst: fromCostCell(row[5]),
        costAct: fromCostCell(row[6]),
        due: fromCell(row[7], true),
        priority: fromCell(row[8]),
        notes: fromCell(row[9]),
        created: fromCell(row[10], true),
        updated: fromCell(row[11], true),
        epic: fromCell(row[12]),
        deps: fromCell(row[13]).split(/[,;]/).map(s => s.trim()).filter(Boolean),
        assignee: fromCell(row[14]),
        titleEN: fromCell(row[15]),
        notesEN: fromCell(row[16]),
    };
}

function taskToRow(t) {
    return [t.id, t.title, t.status, t.room, t.contractor,
        t.costEst === '' ? '' : t.costEst, t.costAct === '' ? '' : t.costAct,
        t.due, t.priority, t.notes, t.created, t.updated, t.epic,
        (t.deps || []).join(', '), t.assignee || '', t.titleEN || '', t.notesEN || ''];
}

// Language toggle: EN shows the Gemini-translated columns, falling back to Slovak.
function displayTitle(t) {
    return state.lang === 'en' && t.titleEN ? t.titleEN : t.title;
}

function displayNotes(t) {
    return state.lang === 'en' && t.notesEN ? t.notesEN : t.notes;
}

function newTaskId() {
    return `T-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
}

function newCostId() {
    return `C-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
}

function parseCostRow(row) {
    return {
        id: fromCell(row[0]),
        date: fromCell(row[1], true),
        description: fromCell(row[2]),
        amount: fromCostCell(row[3]),
        epic: fromCell(row[4]),
        contractor: fromCell(row[5]),
        notes: fromCell(row[6]),
        created: fromCell(row[7], true),
        updated: fromCell(row[8], true),
    };
}

function costToRow(c) {
    return [c.id, c.date, c.description, c.amount === '' ? '' : c.amount,
        c.epic || '', c.contractor || '', c.notes || '', c.created, c.updated];
}

const nowStamp = () => new Date().toISOString();

async function loadAll() {
    const ranges = 'ranges=Tasks!A2:Q&ranges=Config!A2:B&ranges=Costs!A2:I';
    const data = await api(`/${SHEET_ID}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`);
    const [taskValues, configValues, costValues] = data.valueRanges.map(v => v.values || []);
    state.tasks = taskValues.filter(r => fromCell(r[0])).map(parseTaskRow);
    state.costs = costValues.filter(r => fromCell(r[0])).map(parseCostRow);
    const statuses = configValues.map(r => fromCell(r[0])).filter(Boolean);
    const rooms = configValues.map(r => fromCell(r[1])).filter(Boolean);
    state.statuses = statuses.length ? statuses : DEFAULT_STATUSES;
    state.rooms = rooms.length ? rooms : DEFAULT_ROOMS;
    state.lastLoadAt = Date.now();
}

/** Re-read the Tasks tab and find a task's current row by ID (PRD R7). */
async function locateTask(id) {
    const data = await api(`/${SHEET_ID}/values/Tasks!A2:Q?valueRenderOption=UNFORMATTED_VALUE`);
    const rows = data.values || [];
    const idx = rows.findIndex(r => fromCell(r[0]) === id);
    if (idx === -1) return null;
    return { rowNumber: idx + 2, remote: parseTaskRow(rows[idx]) };
}

class ConflictError extends Error {}

async function writeTask(original, changes) {
    const loc = await locateTask(original.id);
    if (!loc) throw new ConflictError('This task was deleted or archived in the spreadsheet.');
    if (loc.remote.updated !== original.updated) {
        throw new ConflictError('This task changed in the spreadsheet since you loaded it.');
    }
    const merged = { ...loc.remote, ...changes, updated: nowStamp() };
    await api(`/${SHEET_ID}/values/Tasks!A${loc.rowNumber}:Q${loc.rowNumber}?valueInputOption=RAW`, {
        method: 'PUT',
        body: { values: [taskToRow(merged)] },
    });
    return merged;
}

async function appendTask(task) {
    await api(`/${SHEET_ID}/values/Tasks!A:Q:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: { values: [taskToRow(task)] },
    });
}

async function archiveTask(original) {
    const loc = await locateTask(original.id);
    if (!loc) throw new ConflictError('This task was already removed from the spreadsheet.');
    if (loc.remote.updated !== original.updated) {
        throw new ConflictError('This task changed in the spreadsheet since you loaded it.');
    }
    const archived = { ...loc.remote, updated: nowStamp() };
    await api(`/${SHEET_ID}/values/Archive!A:Q:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: { values: [taskToRow(archived)] },
    });
    await deleteRowFromTab('Tasks', loc.rowNumber);
}

// Row numbers are 1-based, deleteDimension indices 0-based.
async function deleteRowFromTab(title, rowNumber) {
    const meta = await api(`/${SHEET_ID}?fields=sheets.properties`);
    const sheet = meta.sheets.find(s => s.properties.title === title);
    if (!sheet) throw new Error(`${title} tab not found in the spreadsheet.`);
    await api(`/${SHEET_ID}:batchUpdate`, {
        method: 'POST',
        body: {
            requests: [{
                deleteDimension: {
                    range: {
                        sheetId: sheet.properties.sheetId,
                        dimension: 'ROWS',
                        startIndex: rowNumber - 1,
                        endIndex: rowNumber,
                    },
                },
            }],
        },
    });
}

// --- Costs tab: same locate-by-ID / compare-Updated write safety as Tasks ---

async function locateCost(id) {
    const data = await api(`/${SHEET_ID}/values/Costs!A2:I?valueRenderOption=UNFORMATTED_VALUE`);
    const rows = data.values || [];
    const idx = rows.findIndex(r => fromCell(r[0]) === id);
    if (idx === -1) return null;
    return { rowNumber: idx + 2, remote: parseCostRow(rows[idx]) };
}

async function writeCost(original, changes) {
    const loc = await locateCost(original.id);
    if (!loc) throw new ConflictError('This cost entry was deleted in the spreadsheet.');
    if (loc.remote.updated !== original.updated) {
        throw new ConflictError('This cost entry changed in the spreadsheet since you loaded it.');
    }
    const merged = { ...loc.remote, ...changes, updated: nowStamp() };
    await api(`/${SHEET_ID}/values/Costs!A${loc.rowNumber}:I${loc.rowNumber}?valueInputOption=RAW`, {
        method: 'PUT',
        body: { values: [costToRow(merged)] },
    });
    return merged;
}

async function appendCosts(costs) {
    await api(`/${SHEET_ID}/values/Costs!A:I:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: { values: costs.map(costToRow) },
    });
}

async function deleteCost(original) {
    const loc = await locateCost(original.id);
    if (!loc) throw new ConflictError('This cost entry was already deleted.');
    if (loc.remote.updated !== original.updated) {
        throw new ConflictError('This cost entry changed in the spreadsheet since you loaded it.');
    }
    await deleteRowFromTab('Costs', loc.rowNumber);
}

/** Undo of archiveTask: put the task back on the board, remove its Archive copy. */
async function restoreArchived(task) {
    const restored = { ...task, updated: nowStamp() };
    await api(`/${SHEET_ID}/values/Tasks!A:Q:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: { values: [taskToRow(restored)] },
    });
    const data = await api(`/${SHEET_ID}/values/Archive!A2:Q?valueRenderOption=UNFORMATTED_VALUE`);
    let rowNumber = -1;
    (data.values || []).forEach((r, i) => { if (fromCell(r[0]) === task.id) rowNumber = i + 2; });
    if (rowNumber > 0) await deleteRowFromTab('Archive', rowNumber);
    state.tasks.push(restored);
    renderFilters();
    renderBoard();
}

/**
 * First-run provisioning: if the hardcoded spreadsheet is missing any of the
 * Tasks/Config/Archive tabs, create them (existing tabs are left untouched).
 * Returns true if anything was created.
 */
async function ensureTabs() {
    const meta = await api(`/${SHEET_ID}?fields=sheets.properties`);
    const existing = new Set(meta.sheets.map(s => s.properties.title));
    const missing = ['Tasks', 'Config', 'Archive', 'Costs'].filter(t => !existing.has(t));

    if (missing.length) {
        await api(`/${SHEET_ID}:batchUpdate`, {
            method: 'POST',
            body: { requests: missing.map(title => ({ addSheet: { properties: { title } } })) },
        });
        const data = [];
        if (missing.includes('Tasks')) data.push({ range: 'Tasks!A1:Q1', values: [TASK_HEADERS] });
        if (missing.includes('Archive')) data.push({ range: 'Archive!A1:Q1', values: [TASK_HEADERS] });
        if (missing.includes('Costs')) data.push({ range: 'Costs!A1:I1', values: [COST_HEADERS] });
        if (missing.includes('Config')) {
            const configRows = [['Statuses', 'Rooms']];
            const max = Math.max(DEFAULT_STATUSES.length, DEFAULT_ROOMS.length);
            for (let i = 0; i < max; i++) configRows.push([DEFAULT_STATUSES[i] || '', DEFAULT_ROOMS[i] || '']);
            data.push({ range: `Config!A1:B${configRows.length}`, values: configRows });
        }
        await api(`/${SHEET_ID}/values:batchUpdate`, {
            method: 'POST',
            body: { valueInputOption: 'RAW', data },
        });
    }

    // Schema upgrade: tabs provisioned before the Epic (M) / Depends On (N) /
    // Assignee (O) columns existed lack those headers.
    const head = await api(`/${SHEET_ID}/values:batchGet?ranges=Tasks!M1:Q1&ranges=Archive!M1:Q1`);
    const patches = [];
    for (const [tab, range] of [['Tasks', 0], ['Archive', 1]]) {
        const cells = head.valueRanges[range].values?.[0] || [];
        if (!cells[0]) patches.push({ range: `${tab}!M1`, values: [['Epic']] });
        if (!cells[1]) patches.push({ range: `${tab}!N1`, values: [['Depends On']] });
        if (!cells[2]) patches.push({ range: `${tab}!O1`, values: [['Assignee']] });
        if (!cells[3]) patches.push({ range: `${tab}!P1`, values: [['Title EN']] });
        if (!cells[4]) patches.push({ range: `${tab}!Q1`, values: [['Notes EN']] });
    }
    if (patches.length) {
        await api(`/${SHEET_ID}/values:batchUpdate`, {
            method: 'POST',
            body: { valueInputOption: 'RAW', data: patches },
        });
    }
    return missing.length > 0;
}

// ---------------------------------------------------------------------------
// Views & rendering
// ---------------------------------------------------------------------------

function showView(id) {
    for (const v of ['login-view', 'board-view']) {
        $(v).classList.toggle('hidden', v !== id);
    }
}

function toast(message, kind = 'info', ms = 4200) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    $('toast-container').appendChild(el);
    setTimeout(() => el.remove(), ms);
}

/** Toast with an action button (e.g. Undo). The action can only fire once. */
function toastAction(message, label, action, ms = 8000) {
    const el = document.createElement('div');
    el.className = 'toast';
    const text = document.createElement('span');
    text.textContent = message + ' ';
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        el.remove();
        try { await action(); } catch (err) { toast(err.message, 'error'); }
    });
    el.append(text, btn);
    $('toast-container').appendChild(el);
    setTimeout(() => el.remove(), ms);
}

async function enterBoard() {
    showView('board-view');
    $('open-sheet-link').href = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`;
    try {
        if (await ensureTabs()) toast('Board tabs created in the spreadsheet.', 'success');
    } catch (err) {
        toast(err.message, 'error');
        if (err instanceof ApiError && err.status === 403) showView('login-view');
        return;
    }
    await refresh(true);
}

async function refresh(showErrors) {
    try {
        await loadAll();
        renderFilters();
        renderBoard();
    } catch (err) {
        if (showErrors || !(err instanceof ApiError)) toast(err.message, 'error');
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            showView('login-view');
        }
    }
}

const eur = new Intl.NumberFormat('sk-SK', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/** Saving on a task: estimate minus actual, only meaningful once both are known. */
function taskSaving(t) {
    if (t.costEst === '' || t.costAct === '' || t.costEst === undefined || t.costAct === undefined) return null;
    return t.costEst - t.costAct;
}

function formatDue(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function isOverdue(task) {
    if (!task.due || task.status === terminalStatus()) return false;
    const d = new Date(task.due);
    if (Number.isNaN(d.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return d < today;
}

// The last configured status is treated as "done" for overdue highlighting.
function terminalStatus() {
    return state.statuses[state.statuses.length - 1];
}

function taskById(id) {
    return state.tasks.find(t => t.id === id);
}

/** Predecessors of this task that are not Done yet (unknown/archived IDs count as satisfied). */
function unmetDeps(task) {
    const done = terminalStatus();
    return (task.deps || [])
        .map(taskById)
        .filter(dep => dep && dep.status !== done);
}

/** Would making `task.deps = deps` create a dependency cycle? */
function wouldCycle(taskId, deps) {
    const visited = new Set();
    const stack = [...deps];
    while (stack.length) {
        const id = stack.pop();
        if (id === taskId) return true;
        if (visited.has(id)) continue;
        visited.add(id);
        stack.push(...(taskById(id)?.deps || []));
    }
    return false;
}

// Accent-insensitive fold so "buracie" matches "Búracie".
function fold(text) {
    return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function matchesSearch(task, needle) {
    return [task.title, task.notes, task.contractor, task.epic, task.room, task.assignee,
        task.titleEN, task.notesEN]
        .some(field => field && fold(field).includes(needle));
}

function isDueSoon(task) {
    if (!task.due || task.status === terminalStatus()) return false;
    const d = new Date(task.due);
    if (Number.isNaN(d.getTime())) return false;
    const limit = new Date();
    limit.setHours(0, 0, 0, 0);
    limit.setDate(limit.getDate() + 7);
    return d <= limit; // overdue included
}

function visibleTasks() {
    const needle = fold(state.searchText.trim());
    const done = terminalStatus();
    return state.tasks.filter(t =>
        (!state.filterRoom || t.room === state.filterRoom) &&
        (!state.filterContractor || t.contractor === state.filterContractor) &&
        (!state.filterEpic || t.epic === state.filterEpic) &&
        (!state.filterAssignee || t.assignee === state.filterAssignee) &&
        (!needle || matchesSearch(t, needle)) &&
        (!state.readyOnly || (t.status !== done && unmetDeps(t).length === 0)) &&
        (!state.dueSoonOnly || isDueSoon(t)));
}

function taskSort(a, b) {
    const pa = PRIORITY_ORDER[a.priority] ?? 3;
    const pb = PRIORITY_ORDER[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    const ba = unmetDeps(a).length ? 1 : 0;
    const bb = unmetDeps(b).length ? 1 : 0;
    if (ba !== bb) return ba - bb; // actionable tasks above blocked ones
    if (a.due !== b.due) {
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due < b.due ? -1 : 1;
    }
    return displayTitle(a).localeCompare(displayTitle(b));
}

function renderFilters() {
    const contractors = [...new Set(state.tasks.map(t => t.contractor).filter(Boolean))].sort();
    const epics = [...new Set(state.tasks.map(t => t.epic).filter(Boolean))].sort();
    const assignees = [...new Set(state.tasks.map(t => t.assignee).filter(Boolean))].sort();
    fillSelect($('filter-epic'), epics, 'All epics', state.filterEpic);
    fillSelect($('filter-room'), state.rooms, 'All rooms', state.filterRoom);
    fillSelect($('filter-contractor'), contractors, 'All contractors', state.filterContractor);
    fillSelect($('filter-assignee'), assignees, 'Anyone', state.filterAssignee);
}

function fillSelect(select, options, emptyLabel, selected) {
    select.textContent = '';
    if (emptyLabel !== null) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = emptyLabel;
        select.appendChild(opt);
    }
    for (const value of options) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        select.appendChild(opt);
    }
    select.value = options.includes(selected) ? selected : '';
}

function visibleCosts() {
    const needle = fold(state.searchText.trim());
    return state.costs.filter(c =>
        (!state.filterEpic || c.epic === state.filterEpic) &&
        (!state.filterContractor || c.contractor === state.filterContractor) &&
        (!needle || [c.description, c.notes, c.contractor, c.epic]
            .some(f => f && fold(f).includes(needle))));
}

function renderBoard() {
    const tasks = visibleTasks();
    $('board').classList.toggle('hidden', state.view !== 'board');
    $('timeline').classList.toggle('hidden', state.view !== 'timeline');
    $('costs').classList.toggle('hidden', state.view !== 'costs');
    if (state.view === 'timeline') renderTimeline(tasks);
    else if (state.view === 'costs') renderCosts();
    else renderBoardColumns(tasks);
    renderCostSummary(tasks);
}

function renderCosts() {
    const container = $('costs');
    container.textContent = '';
    const costs = visibleCosts().slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const header = document.createElement('div');
    header.className = 'costs-header';
    const title = document.createElement('span');
    title.className = 'wave-title';
    title.textContent = 'Costs without a task';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-primary small';
    addBtn.textContent = '+ Cost';
    addBtn.addEventListener('click', () => openCostModal(null));
    const total = document.createElement('span');
    total.className = 'wave-info';
    total.textContent = costs.length
        ? `${costs.length} entries · ${eur.format(costs.reduce((s, c) => s + (c.amount || 0), 0))}`
        : '';
    header.append(title, total, addBtn);
    container.appendChild(header);

    if (!costs.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-note';
        empty.textContent = 'No cost entries yet — backfill paid bills that have no task here.';
        container.appendChild(empty);
        return;
    }

    const list = document.createElement('div');
    list.className = 'costs-list';
    for (const cost of costs) {
        const row = document.createElement('div');
        row.className = 'cost-row';
        const date = document.createElement('span');
        date.className = 'cost-date';
        date.textContent = cost.date ? new Date(cost.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
        const desc = document.createElement('span');
        desc.className = 'cost-desc';
        desc.textContent = cost.description;
        if (cost.epic) desc.appendChild(tag(cost.epic, 'epic'));
        if (cost.contractor) desc.appendChild(tag(cost.contractor));
        if (cost.notes) {
            const n = document.createElement('span');
            n.className = 'cost-note';
            n.textContent = cost.notes;
            desc.appendChild(n);
        }
        const amount = document.createElement('span');
        amount.className = 'cost-amount';
        amount.textContent = cost.amount === '' ? '—' : eur.format(cost.amount);
        row.append(date, desc, amount);
        row.addEventListener('click', () => openCostModal(cost.id));
        list.appendChild(row);
    }
    container.appendChild(list);
}

function renderBoardColumns(tasks) {
    const board = $('board');
    board.textContent = '';

    // Defensive extra column for statuses that exist in data but not in Config.
    const known = new Set(state.statuses);
    const strays = [...new Set(tasks.map(t => t.status).filter(s => !known.has(s)))];
    const columns = [...state.statuses, ...strays];

    for (const status of columns) {
        const inColumn = tasks.filter(t => t.status === status).sort(taskSort);
        board.appendChild(renderColumn(status, inColumn));
    }
}

/**
 * Dependency depth of every task: 0 = no predecessors (can start first),
 * n = one more than its deepest predecessor. Cycle-safe; unknown IDs ignored.
 */
function depLevels() {
    const memo = new Map();
    function level(task, stack) {
        if (memo.has(task.id)) return memo.get(task.id);
        if (stack.has(task.id)) return 0;
        stack.add(task.id);
        const parents = (task.deps || []).map(taskById).filter(Boolean);
        const lv = parents.length ? 1 + Math.max(...parents.map(p => level(p, stack))) : 0;
        stack.delete(task.id);
        memo.set(task.id, lv);
        return lv;
    }
    for (const t of state.tasks) level(t, new Set());
    return memo;
}

function renderTimeline(tasks) {
    const container = $('timeline');
    container.textContent = '';
    if (!tasks.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-note';
        empty.textContent = 'No tasks match the current filters.';
        container.appendChild(empty);
        return;
    }

    const levels = depLevels();
    const maxLevel = Math.max(...tasks.map(t => levels.get(t.id) ?? 0));
    const done = terminalStatus();

    for (let lv = 0; lv <= maxLevel; lv++) {
        const inWave = tasks.filter(t => (levels.get(t.id) ?? 0) === lv).sort(taskSort);
        if (!inWave.length) continue;

        const wave = document.createElement('section');
        wave.className = 'wave';

        const header = document.createElement('div');
        header.className = 'wave-header';
        const name = document.createElement('span');
        name.className = 'wave-title';
        name.textContent = lv === 0 ? 'Wave 1 — can start first'
            : lv === maxLevel ? `Wave ${lv + 1} — finishes last`
            : `Wave ${lv + 1}`;
        const info = document.createElement('span');
        info.className = 'wave-info';
        const doneCount = inWave.filter(t => t.status === done).length;
        const est = inWave.reduce((s, t) => s + (t.costEst || 0), 0);
        const saved = inWave.reduce((s, t) => s + (taskSaving(t) ?? 0), 0);
        info.textContent = `${doneCount}/${inWave.length} done`
            + (est ? ` · ${eur.format(est)} est` : '')
            + (saved > 0 ? ` · ${eur.format(saved)} saved` : saved < 0 ? ` · ${eur.format(-saved)} over` : '');
        header.append(name, info);
        wave.appendChild(header);

        const cards = document.createElement('div');
        cards.className = 'wave-cards';
        for (const task of inWave) {
            const card = renderCard(task);
            card.draggable = false;
            if (task.status === done) card.classList.add('done-card');
            cards.appendChild(card);
        }
        wave.appendChild(cards);
        container.appendChild(wave);
    }
}

function renderCostSummary(tasks) {
    const el = $('cost-summary');
    el.textContent = '';
    const push = (text, cls) => {
        if (el.childNodes.length) el.appendChild(document.createTextNode(' · '));
        const span = document.createElement('span');
        if (cls) span.className = cls;
        span.textContent = text;
        el.appendChild(span);
    };
    const est = tasks.reduce((s, t) => s + (t.costEst || 0), 0);
    const act = tasks.reduce((s, t) => s + (t.costAct || 0), 0);
    const other = visibleCosts().reduce((s, c) => s + (c.amount || 0), 0);
    const saved = tasks.reduce((s, t) => s + (taskSaving(t) ?? 0), 0);
    const done = tasks.filter(t => t.status === terminalStatus()).length;
    if (tasks.length) push(`${done}/${tasks.length} done`);
    if (est || act) {
        push(`${eur.format(est)} est`);
        push(`${eur.format(act)} spent`);
    }
    if (other) push(`${eur.format(other)} other`);
    if (saved) {
        push(saved > 0 ? `${eur.format(saved)} saved` : `${eur.format(-saved)} over`,
            saved > 0 ? 'saving-pos' : 'saving-neg');
    }
    const tips = [];
    if (act || other) tips.push(`Total spent incl. backfilled costs: ${eur.format(act + other)}`);
    // The stated goal: cut the budget in half.
    if (saved > 0 && est > 0) {
        tips.push(`Goal: halve the budget → save ${eur.format(est / 2)}. Progress: ${Math.round(saved / (est / 2) * 100)} %`);
    }
    el.title = tips.join('\n');
}

function renderColumn(status, tasks) {
    const col = document.createElement('section');
    col.className = 'column';
    col.dataset.status = status;

    const header = document.createElement('div');
    header.className = 'column-header';
    const name = document.createElement('span');
    name.textContent = status;
    const count = document.createElement('span');
    count.className = 'column-count';
    count.textContent = tasks.length;
    header.append(name, count);
    col.appendChild(header);

    const cards = document.createElement('div');
    cards.className = 'column-cards';
    if (!tasks.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-note';
        empty.textContent = '—';
        cards.appendChild(empty);
    }
    for (const task of tasks) cards.appendChild(renderCard(task));
    col.appendChild(cards);

    // Drag target (desktop)
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        if (id) moveTask(id, status);
    });
    return col;
}

function renderCard(task) {
    const card = document.createElement('article');
    card.className = 'task-card';
    card.dataset.id = task.id;
    card.draggable = true;

    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = displayTitle(task);
    card.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'task-meta';
    if (task.epic) meta.appendChild(tag(task.epic, 'epic'));
    if (task.room) meta.appendChild(tag(task.room, 'room'));
    if (task.assignee) meta.appendChild(tag(`@ ${task.assignee}`, 'assignee'));
    if (task.contractor) meta.appendChild(tag(task.contractor));
    if (task.priority === 'High') meta.appendChild(tag('High', 'prio-High'));
    if (task.due) meta.appendChild(tag(formatDue(task.due), isOverdue(task) ? 'overdue' : ''));
    const blockers = unmetDeps(task);
    if (blockers.length) {
        const t = tag(`⛓ ${blockers.length} waiting`, 'waiting');
        t.title = 'Waiting on: ' + blockers.map(displayTitle).join(' · ');
        meta.appendChild(t);
        card.classList.add('blocked-card');
    } else if ((task.deps || []).length && task.status !== terminalStatus()) {
        meta.appendChild(tag('✓ ready', 'ready'));
    }
    if (meta.childElementCount) card.appendChild(meta);

    if (displayNotes(task)) {
        const notes = document.createElement('div');
        notes.className = 'task-notes';
        notes.textContent = displayNotes(task);
        card.appendChild(notes);
    }

    if (task.costEst !== '' || task.costAct !== '') {
        const cost = document.createElement('div');
        cost.className = 'task-cost';
        const push = (text, cls) => {
            if (cost.childNodes.length) cost.appendChild(document.createTextNode(' · '));
            const span = document.createElement('span');
            if (cls) span.className = cls;
            span.textContent = text;
            cost.appendChild(span);
        };
        if (task.costEst !== '') push(`${eur.format(task.costEst)} est`);
        if (task.costAct !== '') push(`${eur.format(task.costAct)} spent`, 'actual');
        const saving = taskSaving(task);
        if (saving !== null && saving !== 0) {
            push(saving > 0 ? `${eur.format(saving)} saved` : `${eur.format(-saving)} over`,
                saving > 0 ? 'saving-pos' : 'saving-neg');
        }
        card.appendChild(cost);
    }

    card.addEventListener('click', () => openTaskModal(task.id));
    card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    return card;
}

function tag(text, extra = '') {
    const el = document.createElement('span');
    el.className = `tag ${extra}`.trim();
    el.textContent = text;
    return el;
}

// ---------------------------------------------------------------------------
// Mutations from the UI
// ---------------------------------------------------------------------------

async function moveTask(id, newStatus) {
    const task = state.tasks.find(t => t.id === id);
    if (!task || task.status === newStatus) return;
    const prevStatus = task.status;

    // Optimistically show the card in its new column, greyed out while saving.
    const card = document.querySelector(`.task-card[data-id="${CSS.escape(id)}"]`);
    const targetCards = document.querySelector(`.column[data-status="${CSS.escape(newStatus)}"] .column-cards`);
    if (card && targetCards) {
        card.classList.add('saving');
        targetCards.appendChild(card);
    }

    try {
        const merged = await writeTask(task, { status: newStatus });
        Object.assign(task, merged);
        renderBoard();
        toastAction(`Moved to ${newStatus}.`, 'Undo', async () => {
            try {
                const reverted = await writeTask(task, { status: prevStatus });
                Object.assign(task, reverted);
                renderBoard();
            } catch (err) {
                await handleWriteError(err);
            }
        });
    } catch (err) {
        await handleWriteError(err); // re-renders from fresh data → card returns to its true column
    }
}

async function handleWriteError(err) {
    if (err instanceof ConflictError) {
        toast(`${err.message} The board was refreshed — please retry.`, 'error', 6000);
        await refresh(false);
    } else {
        toast(err.message, 'error');
        renderBoard();
    }
}

// ---------------------------------------------------------------------------
// Task modal
// ---------------------------------------------------------------------------

let modalDeps = [];

function renderDepsEditor() {
    const chips = $('f-deps-chips');
    chips.textContent = '';
    for (const depId of modalDeps) {
        const chip = document.createElement('span');
        chip.className = 'dep-chip';
        const label = document.createElement('span');
        const depTask = taskById(depId);
        label.textContent = depTask ? displayTitle(depTask) : depId;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'dep-remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Remove predecessor');
        remove.addEventListener('click', () => {
            modalDeps = modalDeps.filter(d => d !== depId);
            renderDepsEditor();
        });
        chip.append(label, remove);
        chips.appendChild(chip);
    }
    const select = $('f-deps-add');
    select.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '+ Add predecessor…';
    select.appendChild(placeholder);
    const candidates = state.tasks
        .filter(t => t.id !== state.editingId && !modalDeps.includes(t.id))
        .sort((a, b) => displayTitle(a).localeCompare(displayTitle(b)));
    for (const t of candidates) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.epic ? `${displayTitle(t)} (${t.epic})` : displayTitle(t);
        select.appendChild(opt);
    }
}

function openTaskModal(id) {
    state.editingId = id || null;
    const task = id ? state.tasks.find(t => t.id === id) : null;
    modalDeps = [...(task?.deps || [])];
    renderDepsEditor();

    $('modal-title').textContent = task ? 'Edit task' : 'New task';
    const statuses = task?.status && !state.statuses.includes(task.status)
        ? [...state.statuses, task.status] : state.statuses;
    fillSelect($('f-status'), statuses, null, task?.status ?? state.statuses[0]);
    const rooms = task?.room && !state.rooms.includes(task.room)
        ? [...state.rooms, task.room] : state.rooms;
    fillSelect($('f-room'), ['', ...rooms], null, task?.room ?? '');
    fillDatalist('contractor-list', state.tasks.map(t => t.contractor));
    fillDatalist('epic-list', state.tasks.map(t => t.epic));
    fillDatalist('assignee-list', state.tasks.map(t => t.assignee));

    $('f-title').value = task?.title ?? '';
    $('f-title-en').value = task?.titleEN ?? '';
    $('f-notes-en').value = task?.notesEN ?? '';
    $('f-epic').value = task?.epic ?? '';
    $('f-assignee').value = task?.assignee ?? '';
    $('f-contractor').value = task?.contractor ?? '';
    $('f-priority').value = task?.priority ?? '';
    $('f-cost-est').value = task?.costEst ?? '';
    $('f-cost-act').value = task?.costAct ?? '';
    $('f-due').value = task?.due ?? '';
    $('f-notes').value = task?.notes ?? '';
    $('archive-btn').classList.toggle('hidden', !task);

    $('modal-backdrop').classList.remove('hidden');
    $('f-title').focus();
}

function fillDatalist(id, values) {
    const datalist = $(id);
    datalist.textContent = '';
    for (const v of [...new Set(values.filter(Boolean))].sort()) {
        const opt = document.createElement('option');
        opt.value = v;
        datalist.appendChild(opt);
    }
}

function closeTaskModal() {
    $('modal-backdrop').classList.add('hidden');
    state.editingId = null;
}

function readForm() {
    return {
        title: $('f-title').value.trim(),
        epic: $('f-epic').value.trim(),
        status: $('f-status').value,
        room: $('f-room').value,
        contractor: $('f-contractor').value.trim(),
        costEst: $('f-cost-est').value === '' ? '' : Number($('f-cost-est').value),
        costAct: $('f-cost-act').value === '' ? '' : Number($('f-cost-act').value),
        due: $('f-due').value,
        priority: $('f-priority').value,
        notes: $('f-notes').value.trim(),
        deps: [...modalDeps],
        assignee: $('f-assignee').value.trim(),
        titleEN: $('f-title-en').value.trim(),
        notesEN: $('f-notes-en').value.trim(),
    };
}

async function submitTaskForm(e) {
    e.preventDefault();
    const fields = readForm();
    if (!fields.title) return;
    if (state.editingId && wouldCycle(state.editingId, fields.deps)) {
        toast('That would create a dependency loop — a task can’t (indirectly) precede itself.', 'error', 6000);
        return;
    }
    $('save-btn').disabled = true;
    try {
        if (state.editingId) {
            const task = state.tasks.find(t => t.id === state.editingId);
            const merged = await writeTask(task, fields);
            Object.assign(task, merged);
        } else {
            const now = nowStamp();
            const task = { id: newTaskId(), ...fields, created: now, updated: now };
            await appendTask(task);
            state.tasks.push(task);
        }
        closeTaskModal();
        renderFilters();
        renderBoard();
    } catch (err) {
        closeTaskModal();
        await handleWriteError(err);
    } finally {
        $('save-btn').disabled = false;
    }
}

async function onArchiveClick() {
    const task = state.tasks.find(t => t.id === state.editingId);
    if (!task) return;
    $('archive-btn').disabled = true;
    try {
        await archiveTask(task);
        state.tasks = state.tasks.filter(t => t.id !== task.id);
        closeTaskModal();
        renderFilters();
        renderBoard();
        toastAction('Task archived.', 'Undo', () => restoreArchived(task));
    } catch (err) {
        closeTaskModal();
        await handleWriteError(err);
    } finally {
        $('archive-btn').disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Cost modal
// ---------------------------------------------------------------------------

function openCostModal(id) {
    state.editingCostId = id || null;
    const cost = id ? state.costs.find(c => c.id === id) : null;
    $('cost-modal-title').textContent = cost ? 'Edit cost' : 'New cost';
    fillDatalist('epic-list', [...state.tasks.map(t => t.epic), ...state.costs.map(c => c.epic)]);
    fillDatalist('contractor-list', [...state.tasks.map(t => t.contractor), ...state.costs.map(c => c.contractor)]);
    $('c-date').value = cost?.date ?? new Date().toISOString().slice(0, 10);
    $('c-desc').value = cost?.description ?? '';
    $('c-amount').value = cost?.amount ?? '';
    $('c-epic').value = cost?.epic ?? '';
    $('c-contractor').value = cost?.contractor ?? '';
    $('c-notes').value = cost?.notes ?? '';
    $('cost-delete-btn').classList.toggle('hidden', !cost);
    $('cost-backdrop').classList.remove('hidden');
    $('c-desc').focus();
}

function closeCostModal() {
    $('cost-backdrop').classList.add('hidden');
    state.editingCostId = null;
}

async function submitCostForm(e) {
    e.preventDefault();
    const fields = {
        date: $('c-date').value,
        description: $('c-desc').value.trim(),
        amount: $('c-amount').value === '' ? '' : Number($('c-amount').value),
        epic: $('c-epic').value.trim(),
        contractor: $('c-contractor').value.trim(),
        notes: $('c-notes').value.trim(),
    };
    if (!fields.description) return;
    $('cost-save-btn').disabled = true;
    try {
        if (state.editingCostId) {
            const cost = state.costs.find(c => c.id === state.editingCostId);
            const merged = await writeCost(cost, fields);
            Object.assign(cost, merged);
        } else {
            const now = nowStamp();
            const cost = { id: newCostId(), ...fields, created: now, updated: now };
            await appendCosts([cost]);
            state.costs.push(cost);
        }
        closeCostModal();
        renderBoard();
    } catch (err) {
        closeCostModal();
        await handleWriteError(err);
    } finally {
        $('cost-save-btn').disabled = false;
    }
}

async function onCostDelete() {
    const cost = state.costs.find(c => c.id === state.editingCostId);
    if (!cost) return;
    $('cost-delete-btn').disabled = true;
    try {
        await deleteCost(cost);
        state.costs = state.costs.filter(c => c.id !== cost.id);
        closeCostModal();
        renderBoard();
        toastAction('Cost entry deleted.', 'Undo', async () => {
            const restored = { ...cost, updated: nowStamp() };
            await appendCosts([restored]);
            state.costs.push(restored);
            renderBoard();
        });
    } catch (err) {
        closeCostModal();
        await handleWriteError(err);
    } finally {
        $('cost-delete-btn').disabled = false;
    }
}

// ---------------------------------------------------------------------------
// TSV import
// ---------------------------------------------------------------------------

const HEADER_KEYS = {
    id: 'id', title: 'title', status: 'status', room: 'room', contractor: 'contractor',
    costestimate: 'costEst', estimate: 'costEst', costactual: 'costAct', actual: 'costAct',
    duedate: 'due', due: 'due', priority: 'priority', notes: 'notes', epic: 'epic',
    created: 'created', updated: 'updated',
    dependson: 'deps', depends: 'deps', blockedby: 'deps', predecessors: 'deps',
    assignee: 'assignee', assignedto: 'assignee', owner: 'assignee',
    titleen: 'titleEN', englishtitle: 'titleEN', notesen: 'notesEN', englishnotes: 'notesEN',
};

const COST_HEADER_KEYS = {
    id: 'id', date: 'date', paid: 'date', paiddate: 'date',
    description: 'description', desc: 'description', item: 'description',
    amount: 'amount', cost: 'amount', price: 'amount', sum: 'amount',
    epic: 'epic', contractor: 'contractor', supplier: 'contractor', notes: 'notes',
};

/** 'tasks' if the header has a Title column, 'costs' if Description+Amount, else null. */
function detectImportMode(text) {
    const first = text.split(/\r?\n/).find(l => l.trim());
    if (!first) return null;
    const norm = first.split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
    if (norm.some(k => HEADER_KEYS[k] === 'title')) return 'tasks';
    if (norm.some(k => COST_HEADER_KEYS[k] === 'description')
        && norm.some(k => COST_HEADER_KEYS[k] === 'amount')) return 'costs';
    return null;
}

/** Parse pasted TSV into cost entries (backfill mode). Same upsert semantics as tasks. */
function parseCostsTSV(text) {
    const warnings = [];
    const lines = text.split(/\r?\n/).map(l => l.replace(/\r/g, '')).filter(l => l.trim() !== '');
    const headers = lines[0].split('\t').map(h => COST_HEADER_KEYS[h.trim().toLowerCase().replace(/[^a-z]/g, '')] || null);
    const existingById = new Map(state.costs.map(c => [c.id, c]));
    const seenIds = new Set();
    const now = nowStamp();
    const costs = [];

    for (let i = 1; i < lines.length; i++) {
        const line = i + 1;
        const cells = lines[i].split('\t');
        const raw = {};
        headers.forEach((key, c) => { if (key) raw[key] = (cells[c] ?? '').trim(); });

        if (!raw.description) { warnings.push(`line ${line}: no description — skipped`); continue; }
        if (raw.id && seenIds.has(raw.id)) {
            warnings.push(`line ${line}: ID ${raw.id} appears twice in the paste — skipped`);
            continue;
        }
        const existing = raw.id ? existingById.get(raw.id) : undefined;
        const id = raw.id || `C-${Date.now().toString(36)}-${i}${Math.random().toString(36).slice(2, 4)}`;
        seenIds.add(id);

        const has = (key) => headers.includes(key);
        const val = (key) => has(key) ? (raw[key] || '') : (existing?.[key] ?? '');

        costs.push({
            id,
            date: has('date') ? parseImportDate(raw.date || '', warnings, line) : (existing?.date ?? ''),
            description: raw.description,
            amount: has('amount') ? parseImportCost(raw.amount || '', warnings, line) : (existing?.amount ?? ''),
            epic: val('epic'),
            contractor: val('contractor'),
            notes: val('notes'),
            created: existing?.created || now,
            updated: now,
            isUpdate: !!existing,
        });
    }
    return { costs, warnings };
}

async function confirmCostImport(costs) {
    const fresh = await api(`/${SHEET_ID}/values/Costs!A2:I?valueRenderOption=UNFORMATTED_VALUE`);
    const rowById = new Map((fresh.values || []).map((r, i) => [fromCell(r[0]), i + 2]));
    const toAppend = [];
    const patches = [];
    for (const cost of costs) {
        delete cost.isUpdate;
        const rowNumber = rowById.get(cost.id);
        if (rowNumber) patches.push({ range: `Costs!A${rowNumber}:I${rowNumber}`, values: [costToRow(cost)] });
        else toAppend.push(cost);
    }
    if (patches.length) {
        await api(`/${SHEET_ID}/values:batchUpdate`, {
            method: 'POST',
            body: { valueInputOption: 'RAW', data: patches },
        });
    }
    if (toAppend.length) await appendCosts(toAppend);
    return { appended: toAppend.length, updated: patches.length };
}

function parseImportCost(raw, warnings, line) {
    const text = raw.trim();
    if (!text) return '';
    let cleaned = text.replace(/[^0-9.,-]/g, '');
    if (cleaned.includes('.') && cleaned.includes(',')) cleaned = cleaned.replace(/,/g, '');
    else cleaned = cleaned.replace(',', '.');
    const n = Number(cleaned);
    if (!/\d/.test(cleaned) || !Number.isFinite(n)) {
        warnings.push(`line ${line}: unreadable cost "${text}"`);
        return '';
    }
    return n;
}

function parseImportDate(raw, warnings, line) {
    const text = raw.trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const dmy = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
    if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    warnings.push(`line ${line}: unreadable date "${text}"`);
    return '';
}

/** Parse pasted TSV into task objects. Returns {tasks, warnings, error}. */
function parseTSV(text) {
    const warnings = [];
    const lines = text.split(/\r?\n/).map(l => l.replace(/\r/g, '')).filter(l => l.trim() !== '');
    if (!lines.length) return { tasks: [], warnings, error: null };

    const headers = lines[0].split('\t').map(h => HEADER_KEYS[h.trim().toLowerCase().replace(/[^a-z]/g, '')] || null);
    if (!headers.includes('title')) {
        return { tasks: [], warnings, error: 'First row must be a header containing a "Title" column.' };
    }

    const existingById = new Map(state.tasks.map(t => [t.id, t]));
    const seenIds = new Set();
    const now = nowStamp();
    const tasks = [];

    for (let i = 1; i < lines.length; i++) {
        const line = i + 1;
        const cells = lines[i].split('\t');
        const raw = {};
        headers.forEach((key, c) => { if (key) raw[key] = (cells[c] ?? '').trim(); });

        if (!raw.title) { warnings.push(`line ${line}: no title — skipped`); continue; }
        if (raw.id && seenIds.has(raw.id)) {
            warnings.push(`line ${line}: ID ${raw.id} appears twice in the paste — skipped`);
            continue;
        }
        const existing = raw.id ? existingById.get(raw.id) : undefined;
        const id = raw.id || `T-${Date.now().toString(36)}-${i}${Math.random().toString(36).slice(2, 4)}`;
        seenIds.add(id);

        // A column absent from the paste never changes an existing task's field —
        // only columns present in the header can set (or clear) values.
        const has = (key) => headers.includes(key);
        const val = (key) => has(key) ? (raw[key] || '') : (existing?.[key] ?? '');

        let status = has('status') ? (raw.status || state.statuses[0]) : (existing?.status || state.statuses[0]);
        const canonical = state.statuses.find(s => s.toLowerCase() === status.toLowerCase());
        if (canonical) status = canonical;
        else warnings.push(`line ${line}: status "${status}" is not in Config — card will land in an extra column`);

        let priority = val('priority');
        const prioCanonical = ['High', 'Medium', 'Low'].find(p => p.toLowerCase() === priority.toLowerCase());
        if (priority && !prioCanonical) warnings.push(`line ${line}: priority "${priority}" is not High/Medium/Low`);
        if (prioCanonical) priority = prioCanonical;

        const room = val('room');
        if (room && !state.rooms.includes(room)) {
            warnings.push(`line ${line}: room "${room}" is not in Config`);
        }

        tasks.push({
            id,
            title: raw.title,
            status,
            room,
            contractor: val('contractor'),
            costEst: has('costEst') ? parseImportCost(raw.costEst || '', warnings, line) : (existing?.costEst ?? ''),
            costAct: has('costAct') ? parseImportCost(raw.costAct || '', warnings, line) : (existing?.costAct ?? ''),
            due: has('due') ? parseImportDate(raw.due || '', warnings, line) : (existing?.due ?? ''),
            priority,
            notes: val('notes'),
            created: raw.created || existing?.created || now,
            updated: now,
            epic: val('epic'),
            deps: has('deps')
                ? (raw.deps || '').split(/[,;]/).map(s => s.trim()).filter(Boolean)
                : (existing?.deps ?? []),
            assignee: val('assignee'),
            titleEN: val('titleEN'),
            notesEN: val('notesEN'),
            isUpdate: !!existing,
        });
    }

    // Dependency IDs may point at rows later in the paste, so validate after the loop.
    const knownIds = new Set([...existingById.keys(), ...seenIds]);
    for (const task of tasks) {
        for (const dep of task.deps) {
            if (!knownIds.has(dep)) warnings.push(`${task.id}: depends on unknown ID "${dep}"`);
        }
    }
    return { tasks, warnings, error: null };
}

function openImportModal() {
    $('import-text').value = '';
    $('import-preview').textContent = '';
    $('import-confirm-btn').disabled = true;
    $('import-backdrop').classList.remove('hidden');
    $('import-text').focus();
}

function closeImportModal() {
    $('import-backdrop').classList.add('hidden');
}

function previewImport() {
    const text = $('import-text').value;
    const preview = $('import-preview');
    const mode = detectImportMode(text);
    if (!mode) {
        preview.textContent = text.trim()
            ? 'Header not recognized — need a Title column (tasks) or Description + Amount columns (costs).'
            : '';
        $('import-confirm-btn').disabled = true;
        $('import-confirm-btn').textContent = 'Import';
        return;
    }
    const parsed = mode === 'costs' ? parseCostsTSV(text) : parseTSV(text);
    const items = mode === 'costs' ? parsed.costs : parsed.tasks;
    const { warnings, error } = parsed;
    if (error) {
        preview.textContent = error;
        $('import-confirm-btn').disabled = true;
        return;
    }
    const news = items.filter(t => !t.isUpdate).length;
    const updates = items.length - news;
    const parts = [mode === 'costs' ? 'Cost entries detected' : 'Tasks detected'];
    if (news) parts.push(`${news} new`);
    if (updates) parts.push(`${updates} update${updates === 1 ? '' : 's'} (existing IDs will be overwritten)`);
    parts.push(...warnings.slice(0, 5));
    if (warnings.length > 5) parts.push(`…and ${warnings.length - 5} more warnings`);
    preview.textContent = parts.join(' · ');
    $('import-confirm-btn').disabled = !items.length;
    $('import-confirm-btn').textContent = items.length ? `Import ${items.length}` : 'Import';
}

async function confirmImport() {
    const text = $('import-text').value;
    const mode = detectImportMode(text);
    if (mode === 'costs') {
        const { costs } = parseCostsTSV(text);
        if (!costs.length) return;
        $('import-confirm-btn').disabled = true;
        try {
            const { appended, updated } = await confirmCostImport(costs);
            closeImportModal();
            await refresh(true);
            toast(`Imported ${appended} new cost entries, updated ${updated}.`, 'success');
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            $('import-confirm-btn').disabled = false;
        }
        return;
    }
    const { tasks } = parseTSV(text);
    if (!tasks.length) return;
    $('import-confirm-btn').disabled = true;
    try {
        // Fresh row map so updates land on the row that holds each ID right now (PRD R7).
        const fresh = await api(`/${SHEET_ID}/values/Tasks!A2:Q?valueRenderOption=UNFORMATTED_VALUE`);
        const rowById = new Map((fresh.values || []).map((r, i) => [fromCell(r[0]), i + 2]));

        const toAppend = [];
        const patches = [];
        for (const task of tasks) {
            delete task.isUpdate;
            const rowNumber = rowById.get(task.id);
            if (rowNumber) patches.push({ range: `Tasks!A${rowNumber}:Q${rowNumber}`, values: [taskToRow(task)] });
            else toAppend.push(task);
        }
        if (patches.length) {
            await api(`/${SHEET_ID}/values:batchUpdate`, {
                method: 'POST',
                body: { valueInputOption: 'RAW', data: patches },
            });
        }
        if (toAppend.length) {
            await api(`/${SHEET_ID}/values/Tasks!A:Q:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
                method: 'POST',
                body: { values: toAppend.map(taskToRow) },
            });
        }
        closeImportModal();
        await refresh(true);
        toast(`Imported ${toAppend.length} new, updated ${patches.length}.`, 'success');
    } catch (err) {
        toast(err.message, 'error');
    } finally {
        $('import-confirm-btn').disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Export & preferences
// ---------------------------------------------------------------------------

/** Copy the currently visible tasks — or cost entries, in the Costs view — as TSV. */
async function exportTSV() {
    const costsMode = state.view === 'costs';
    const items = costsMode ? visibleCosts() : visibleTasks();
    if (!items.length) { toast('Nothing to export with the current filters.', 'error'); return; }
    const headers = costsMode ? COST_HEADERS : TASK_HEADERS;
    const toRow = costsMode ? costToRow : taskToRow;
    const lines = [headers.join('\t')];
    for (const item of items) {
        lines.push(toRow(item).map(cell => String(cell).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t'));
    }
    try {
        await navigator.clipboard.writeText(lines.join('\n'));
        toast(`Copied ${items.length} ${costsMode ? 'cost entries' : 'tasks'} as TSV — paste into Gemini or a sheet.`, 'success');
    } catch {
        toast('Clipboard access denied by the browser.', 'error');
    }
}

const LS_PREFS = 'rb_prefs';
const PREF_KEYS = ['view', 'lang', 'filterRoom', 'filterContractor', 'filterEpic',
    'filterAssignee', 'searchText', 'readyOnly', 'dueSoonOnly'];

function savePrefs() {
    const prefs = {};
    for (const k of PREF_KEYS) prefs[k] = state[k];
    localStorage.setItem(LS_PREFS, JSON.stringify(prefs));
}

function loadPrefs() {
    try {
        const prefs = JSON.parse(localStorage.getItem(LS_PREFS) || '{}');
        for (const k of PREF_KEYS) if (prefs[k] !== undefined) state[k] = prefs[k];
    } catch { /* corrupted prefs — defaults win */ }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
    loadPrefs();

    $('signin-btn').addEventListener('click', () => signIn());
    $('reauth-btn').addEventListener('click', () => signIn(''));

    $('refresh-btn').addEventListener('click', () => refresh(true));
    $('add-task-btn').addEventListener('click', () => openTaskModal(null));
    $('signout-btn').addEventListener('click', signOut);
    $('export-btn').addEventListener('click', exportTSV);

    $('import-btn').addEventListener('click', openImportModal);
    $('import-text').addEventListener('input', previewImport);
    $('import-cancel-btn').addEventListener('click', closeImportModal);
    $('import-confirm-btn').addEventListener('click', confirmImport);
    $('import-backdrop').addEventListener('click', (e) => { if (e.target === $('import-backdrop')) closeImportModal(); });

    $('search-input').addEventListener('input', (e) => { state.searchText = e.target.value; savePrefs(); renderBoard(); });
    const setView = (view) => {
        state.view = view;
        $('view-board-btn').classList.toggle('active', view === 'board');
        $('view-timeline-btn').classList.toggle('active', view === 'timeline');
        $('view-costs-btn').classList.toggle('active', view === 'costs');
        savePrefs();
        renderBoard();
    };
    $('view-board-btn').addEventListener('click', () => setView('board'));
    $('view-timeline-btn').addEventListener('click', () => setView('timeline'));
    $('view-costs-btn').addEventListener('click', () => setView('costs'));
    const setLang = (lang) => {
        state.lang = lang;
        $('lang-toggle').textContent = lang === 'en' ? 'SK' : 'EN';
        $('lang-toggle').classList.toggle('active', lang === 'en');
        savePrefs();
        renderBoard();
    };
    $('lang-toggle').addEventListener('click', () => setLang(state.lang === 'en' ? 'sk' : 'en'));
    $('ready-toggle').addEventListener('click', () => {
        state.readyOnly = !state.readyOnly;
        $('ready-toggle').classList.toggle('active', state.readyOnly);
        savePrefs();
        renderBoard();
    });
    $('due-soon-toggle').addEventListener('click', () => {
        state.dueSoonOnly = !state.dueSoonOnly;
        $('due-soon-toggle').classList.toggle('active', state.dueSoonOnly);
        savePrefs();
        renderBoard();
    });
    $('f-deps-add').addEventListener('change', (e) => {
        if (e.target.value) { modalDeps.push(e.target.value); renderDepsEditor(); }
    });
    const wireFilter = (id, key) => $(id).addEventListener('change', (e) => {
        state[key] = e.target.value;
        savePrefs();
        renderBoard();
    });
    wireFilter('filter-epic', 'filterEpic');
    wireFilter('filter-assignee', 'filterAssignee');
    wireFilter('filter-room', 'filterRoom');
    wireFilter('filter-contractor', 'filterContractor');

    $('task-form').addEventListener('submit', submitTaskForm);
    $('cancel-btn').addEventListener('click', closeTaskModal);
    $('archive-btn').addEventListener('click', onArchiveClick);
    $('modal-backdrop').addEventListener('click', (e) => { if (e.target === $('modal-backdrop')) closeTaskModal(); });

    $('cost-form').addEventListener('submit', submitCostForm);
    $('cost-cancel-btn').addEventListener('click', closeCostModal);
    $('cost-delete-btn').addEventListener('click', onCostDelete);
    $('cost-backdrop').addEventListener('click', (e) => { if (e.target === $('cost-backdrop')) closeCostModal(); });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeTaskModal(); closeImportModal(); closeCostModal(); }
    });

    // PRD R8: pick up direct spreadsheet edits when the tab regains focus.
    window.addEventListener('focus', () => {
        if (state.token && SHEET_ID && Date.now() - state.lastLoadAt > 15000
            && !$('board-view').classList.contains('hidden')) {
            refresh(false);
        }
    });

    // Restore persisted UI state into the controls.
    $('search-input').value = state.searchText;
    $('ready-toggle').classList.toggle('active', state.readyOnly);
    $('due-soon-toggle').classList.toggle('active', state.dueSoonOnly);
    $('view-board-btn').classList.toggle('active', state.view === 'board');
    $('view-timeline-btn').classList.toggle('active', state.view === 'timeline');
    $('view-costs-btn').classList.toggle('active', state.view === 'costs');
    $('lang-toggle').textContent = state.lang === 'en' ? 'SK' : 'EN';
    $('lang-toggle').classList.toggle('active', state.lang === 'en');

    showView('login-view');
}

document.addEventListener('DOMContentLoaded', init);
