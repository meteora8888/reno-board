'use strict';

/**
 * Reno Board — kanban over a Google Spreadsheet.
 *
 * Auth model (same as GoodMetrics): Google Identity Services issues a browser-side
 * OAuth access token; the page calls the Sheets REST API directly. No backend,
 * nothing stored outside the spreadsheet. Client and spreadsheet IDs are hardcoded.
 *
 * Datasource contract (PRD R3):
 *   Tasks tab   — columns A..L: ID, Title, Status, Room, Contractor, Cost Estimate,
 *                 Cost Actual, Due Date, Priority, Notes, Created, Updated
 *   Config tab  — A: Statuses (ordered board columns), B: Rooms; row 1 is headers
 *   Archive tab — same columns as Tasks; archived rows are appended here
 *
 * Write safety (PRD R7): every mutation re-reads the Tasks tab, locates the row by
 * ID (never by position) and compares the Updated stamp before writing.
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';

const TASK_HEADERS = ['ID', 'Title', 'Status', 'Room', 'Contractor', 'Cost Estimate',
    'Cost Actual', 'Due Date', 'Priority', 'Notes', 'Created', 'Updated'];
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
    };
}

function taskToRow(t) {
    return [t.id, t.title, t.status, t.room, t.contractor,
        t.costEst === '' ? '' : t.costEst, t.costAct === '' ? '' : t.costAct,
        t.due, t.priority, t.notes, t.created, t.updated];
}

function newTaskId() {
    return `T-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
}

const nowStamp = () => new Date().toISOString();

async function loadAll() {
    const ranges = 'ranges=Tasks!A2:L&ranges=Config!A2:B';
    const data = await api(`/${SHEET_ID}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`);
    const [taskValues, configValues] = data.valueRanges.map(v => v.values || []);
    state.tasks = taskValues.filter(r => fromCell(r[0])).map(parseTaskRow);
    const statuses = configValues.map(r => fromCell(r[0])).filter(Boolean);
    const rooms = configValues.map(r => fromCell(r[1])).filter(Boolean);
    state.statuses = statuses.length ? statuses : DEFAULT_STATUSES;
    state.rooms = rooms.length ? rooms : DEFAULT_ROOMS;
    state.lastLoadAt = Date.now();
}

/** Re-read the Tasks tab and find a task's current row by ID (PRD R7). */
async function locateTask(id) {
    const data = await api(`/${SHEET_ID}/values/Tasks!A2:L?valueRenderOption=UNFORMATTED_VALUE`);
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
    await api(`/${SHEET_ID}/values/Tasks!A${loc.rowNumber}:L${loc.rowNumber}?valueInputOption=RAW`, {
        method: 'PUT',
        body: { values: [taskToRow(merged)] },
    });
    return merged;
}

async function appendTask(task) {
    await api(`/${SHEET_ID}/values/Tasks!A:L:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
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
    await api(`/${SHEET_ID}/values/Archive!A:L:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: { values: [taskToRow(archived)] },
    });
    // Row numbers are 1-based, deleteDimension indices 0-based.
    const meta = await api(`/${SHEET_ID}?fields=sheets.properties`);
    const tasksSheet = meta.sheets.find(s => s.properties.title === 'Tasks');
    if (!tasksSheet) throw new Error('Tasks tab not found in the spreadsheet.');
    await api(`/${SHEET_ID}:batchUpdate`, {
        method: 'POST',
        body: {
            requests: [{
                deleteDimension: {
                    range: {
                        sheetId: tasksSheet.properties.sheetId,
                        dimension: 'ROWS',
                        startIndex: loc.rowNumber - 1,
                        endIndex: loc.rowNumber,
                    },
                },
            }],
        },
    });
}

/**
 * First-run provisioning: if the hardcoded spreadsheet is missing any of the
 * Tasks/Config/Archive tabs, create them (existing tabs are left untouched).
 * Returns true if anything was created.
 */
async function ensureTabs() {
    const meta = await api(`/${SHEET_ID}?fields=sheets.properties`);
    const existing = new Set(meta.sheets.map(s => s.properties.title));
    const missing = ['Tasks', 'Config', 'Archive'].filter(t => !existing.has(t));
    if (!missing.length) return false;

    await api(`/${SHEET_ID}:batchUpdate`, {
        method: 'POST',
        body: { requests: missing.map(title => ({ addSheet: { properties: { title } } })) },
    });

    const data = [];
    if (missing.includes('Tasks')) data.push({ range: 'Tasks!A1:L1', values: [TASK_HEADERS] });
    if (missing.includes('Archive')) data.push({ range: 'Archive!A1:L1', values: [TASK_HEADERS] });
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
    return true;
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

function visibleTasks() {
    return state.tasks.filter(t =>
        (!state.filterRoom || t.room === state.filterRoom) &&
        (!state.filterContractor || t.contractor === state.filterContractor));
}

function taskSort(a, b) {
    const pa = PRIORITY_ORDER[a.priority] ?? 3;
    const pb = PRIORITY_ORDER[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    if (a.due !== b.due) {
        if (!a.due) return 1;
        if (!b.due) return -1;
        return a.due < b.due ? -1 : 1;
    }
    return a.title.localeCompare(b.title);
}

function renderFilters() {
    const contractors = [...new Set(state.tasks.map(t => t.contractor).filter(Boolean))].sort();
    fillSelect($('filter-room'), state.rooms, 'All rooms', state.filterRoom);
    fillSelect($('filter-contractor'), contractors, 'All contractors', state.filterContractor);
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

function renderBoard() {
    const board = $('board');
    board.textContent = '';
    const tasks = visibleTasks();

    // Defensive extra column for statuses that exist in data but not in Config.
    const known = new Set(state.statuses);
    const strays = [...new Set(tasks.map(t => t.status).filter(s => !known.has(s)))];
    const columns = [...state.statuses, ...strays];

    for (const status of columns) {
        const inColumn = tasks.filter(t => t.status === status).sort(taskSort);
        board.appendChild(renderColumn(status, inColumn));
    }
    renderCostSummary(tasks);
}

function renderCostSummary(tasks) {
    const est = tasks.reduce((s, t) => s + (t.costEst || 0), 0);
    const act = tasks.reduce((s, t) => s + (t.costAct || 0), 0);
    $('cost-summary').textContent = (est || act)
        ? `${eur.format(est)} est · ${eur.format(act)} spent`
        : '';
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
    title.textContent = task.title;
    card.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'task-meta';
    if (task.room) meta.appendChild(tag(task.room, 'room'));
    if (task.contractor) meta.appendChild(tag(task.contractor));
    if (task.priority === 'High') meta.appendChild(tag('High', 'prio-High'));
    if (task.due) meta.appendChild(tag(formatDue(task.due), isOverdue(task) ? 'overdue' : ''));
    if (meta.childElementCount) card.appendChild(meta);

    if (task.costEst !== '' || task.costAct !== '') {
        const cost = document.createElement('div');
        cost.className = 'task-cost';
        const parts = [];
        if (task.costEst !== '') parts.push(`${eur.format(task.costEst)} est`);
        if (task.costAct !== '') parts.push(`${eur.format(task.costAct)} spent`);
        cost.innerHTML = parts.map((p, i) => i === 1 ? `<span class="actual">${p}</span>` : p).join(' · ');
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

function openTaskModal(id) {
    state.editingId = id || null;
    const task = id ? state.tasks.find(t => t.id === id) : null;

    $('modal-title').textContent = task ? 'Edit task' : 'New task';
    const statuses = task?.status && !state.statuses.includes(task.status)
        ? [...state.statuses, task.status] : state.statuses;
    fillSelect($('f-status'), statuses, null, task?.status ?? state.statuses[0]);
    const rooms = task?.room && !state.rooms.includes(task.room)
        ? [...state.rooms, task.room] : state.rooms;
    fillSelect($('f-room'), ['', ...rooms], null, task?.room ?? '');
    const datalist = $('contractor-list');
    datalist.textContent = '';
    for (const c of [...new Set(state.tasks.map(t => t.contractor).filter(Boolean))].sort()) {
        const opt = document.createElement('option');
        opt.value = c;
        datalist.appendChild(opt);
    }

    $('f-title').value = task?.title ?? '';
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

function closeTaskModal() {
    $('modal-backdrop').classList.add('hidden');
    state.editingId = null;
}

function readForm() {
    return {
        title: $('f-title').value.trim(),
        status: $('f-status').value,
        room: $('f-room').value,
        contractor: $('f-contractor').value.trim(),
        costEst: $('f-cost-est').value === '' ? '' : Number($('f-cost-est').value),
        costAct: $('f-cost-act').value === '' ? '' : Number($('f-cost-act').value),
        due: $('f-due').value,
        priority: $('f-priority').value,
        notes: $('f-notes').value.trim(),
    };
}

async function submitTaskForm(e) {
    e.preventDefault();
    const fields = readForm();
    if (!fields.title) return;
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
        toast('Task archived.', 'success');
    } catch (err) {
        closeTaskModal();
        await handleWriteError(err);
    } finally {
        $('archive-btn').disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
    $('signin-btn').addEventListener('click', () => signIn());
    $('reauth-btn').addEventListener('click', () => signIn(''));

    $('refresh-btn').addEventListener('click', () => refresh(true));
    $('add-task-btn').addEventListener('click', () => openTaskModal(null));
    $('signout-btn').addEventListener('click', signOut);

    $('filter-room').addEventListener('change', (e) => { state.filterRoom = e.target.value; renderBoard(); });
    $('filter-contractor').addEventListener('change', (e) => { state.filterContractor = e.target.value; renderBoard(); });

    $('task-form').addEventListener('submit', submitTaskForm);
    $('cancel-btn').addEventListener('click', closeTaskModal);
    $('archive-btn').addEventListener('click', onArchiveClick);
    $('modal-backdrop').addEventListener('click', (e) => { if (e.target === $('modal-backdrop')) closeTaskModal(); });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeTaskModal();
    });

    // PRD R8: pick up direct spreadsheet edits when the tab regains focus.
    window.addEventListener('focus', () => {
        if (state.token && SHEET_ID && Date.now() - state.lastLoadAt > 15000
            && !$('board-view').classList.contains('hidden')) {
            refresh(false);
        }
    });

    showView('login-view');
}

document.addEventListener('DOMContentLoaded', init);
