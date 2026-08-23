/**
 * Fleet – Main Application Logic
 * Uses a narrow IPC bridge to communicate with the main-process store.
 */

// ===== State =====
let state = {
    folders: [],
    trash: [],
    settings: {
        defaultFontSize: 13,
        updatesEnabled: false,
        dockSide: 'right',
        collapsedStyle: 'capsule',
        dockOffset: 0.5
    },
    currentView: 'folders',
    currentFolderId: null,
    searchQuery: '',
    activeNoteId: null,
    newNoteId: null,
    editingNoteIds: new Set(), // tracks which notes are in edit mode
    jira: {
        session: null,
        work: null,
        detail: null,
        loading: false,
        error: null,
        workError: null,
        returnView: null,
        assigneeFilter: null,
        pendingCommentIssueKey: null,
        pendingTransitionId: null
    }
};

let dragSourceNoteId = null;
let storageState = { state: 'ok', message: '', canWrite: true };
let saveTimeout = null;
let saveInFlight = null;
let saveGeneration = 0;
let dirty = false;
let lastDeletedTrashId = null;
const pendingMutations = new Map();
let mutationFlushInFlight = null;
const searchIndexCache = new Map();
const pendingVisualUpdates = new Set();
let visualUpdateFrame = null;
let visualUpdateNeedsReorder = false;

// ===== Storage via IPC =====
function normalizeNoteFlags(note) {
    if (!note || typeof note !== 'object') return false;
    let changed = false;

    if (typeof note.pinned !== 'boolean') {
        note.pinned = false;
        changed = true;
    }
    if (typeof note.favourite !== 'boolean') {
        note.favourite = false;
        changed = true;
    }

    return changed;
}

function normalizeStoredFolders(folders) {
    if (!Array.isArray(folders)) return { folders: [], changed: true };

    let changed = false;
    const normalizedFolders = folders.filter(folder => folder && typeof folder === 'object').map((folder, folderIndex) => {
        const safeFolder = {
            ...folder,
            id: typeof folder.id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(folder.id) ? folder.id : generateId(),
            name: typeof folder.name === 'string' && folder.name.trim() ? folder.name.trim().slice(0, 200) : 'Untitled',
            colorIndex: Number.isInteger(folder.colorIndex) ? Math.max(0, Math.min(5, folder.colorIndex)) : folderIndex % 6,
            notes: Array.isArray(folder.notes) ? folder.notes.filter(note => note && typeof note === 'object').map(note => ({
                ...note,
                id: typeof note.id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(note.id) ? note.id : generateId(),
                content: typeof note.content === 'string' ? note.content.slice(0, 1024 * 1024) : '',
                fontSize: Number.isFinite(Number(note.fontSize)) ? Math.max(10, Math.min(24, Math.round(Number(note.fontSize)))) : 13
            })).slice(0, 5000) : []
        };
        safeFolder.notes.forEach(note => { if (normalizeNoteFlags(note)) changed = true; });
        if (safeFolder.id !== folder.id || safeFolder.name !== folder.name || safeFolder.colorIndex !== folder.colorIndex || !Array.isArray(folder.notes)) changed = true;
        return safeFolder;
    }).slice(0, 500);
    if (normalizedFolders.length !== folders.length) changed = true;
    return { folders: normalizedFolders, changed };
}

async function loadData() {
    const result = (await window.electronAPI.loadFolders()) || {};
    const storedFolders = Array.isArray(result) ? result : result.folders;
    storageState = result.storage || { state: 'ok', message: '', canWrite: true };
    state.settings = { ...state.settings, ...(result.settings || {}) };
    applyDockAppearance();
    updateStorageStatus(storageState);
    const normalized = normalizeStoredFolders(storedFolders);
    state.folders = normalized.folders;
    if (normalized.changed) await save();
}

async function loadTrash() {
    try {
        const result = await window.electronAPI.loadTrash();
        state.trash = Array.isArray(result?.trash) ? result.trash : [];
    } catch {
        state.trash = [];
        showToast('Could not load Trash.', 'error');
    }
}

async function save() {
    if (!storageState.canWrite) {
        updateStorageStatus(storageState);
        return false;
    }
    const token = ++saveGeneration;
    dirty = true;
    updateStorageStatus({ state: 'saving', message: 'Saving…', canWrite: true });
    if (saveInFlight) {
        const previousResult = await saveInFlight;
        if (previousResult === false) return false;
        if (saveGeneration !== token) return save();
        return true;
    }
    const snapshot = state.folders.map(folder => ({ ...folder, notes: folder.notes.map(note => ({ ...note })) }));
    saveInFlight = window.electronAPI.saveFolders(snapshot)
        .then(result => {
            if (!result?.success) throw new Error(result?.error || 'Could not save notes.');
        })
        .catch(error => {
            updateStorageStatus({ state: 'error', message: 'Could not save notes. Click Retry to try again.', canWrite: true });
            return false;
        });
    const success = await saveInFlight;
    saveInFlight = null;
    if (success !== false && saveGeneration === token) {
        pendingMutations.clear();
        dirty = false;
        storageState = { state: 'ok', message: '', canWrite: true };
        updateStorageStatus(storageState);
        return true;
    }
    return success !== false;
}

function debouncedSave() {
    dirty = true;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => { saveTimeout = null; save(); }, 500);
}

function mutationKey(mutation) {
    if (mutation.type === 'restore-trash' || mutation.type === 'permanent-delete-trash') return `trash:${mutation.trashId}`;
    if (mutation.type === 'trash-folder') return `trash-folder:${mutation.folderId}`;
    if (mutation.type === 'trash-note') return `trash-note:${mutation.folderId}:${mutation.noteId}`;
    if (mutation.type === 'upsert-note' || mutation.type === 'delete-note') return `note:${mutation.folderId}:${mutation.note?.id || mutation.noteId}`;
    if (mutation.type === 'upsert-folder' || mutation.type === 'delete-folder') return `folder:${mutation.folder?.id || mutation.folderId}`;
    return `${mutation.type}:${mutation.folderId}`;
}

async function persistMutation(mutation) {
    if (!storageState.canWrite) return false;
    updateStorageStatus({ state: 'saving', message: 'Saving…', canWrite: true });
    try {
        const result = await window.electronAPI.applyMutation(mutation);
        if (!result?.success) throw new Error(result?.error || 'Could not save notes.');
        const key = mutationKey(mutation);
        if (pendingMutations.get(key) === mutation) pendingMutations.delete(key);
        if (!pendingMutations.size && !saveInFlight) {
            dirty = false;
            storageState = { state: 'ok', message: '', canWrite: true };
            updateStorageStatus(storageState);
        }
        return true;
    } catch {
        updateStorageStatus({ state: 'error', message: 'Could not save notes. Click Retry to try again.', canWrite: true });
        return false;
    }
}

function queueMutation(mutation) {
    pendingMutations.set(mutationKey(mutation), mutation);
    dirty = true;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => { saveTimeout = null; flushMutations(); }, 500);
}

async function flushMutations() {
    if (mutationFlushInFlight) return mutationFlushInFlight;
    mutationFlushInFlight = (async () => {
        for (const mutation of Array.from(pendingMutations.values())) {
            const success = await persistMutation(mutation);
            if (!success) break;
        }
    })().finally(() => { mutationFlushInFlight = null; });
    return mutationFlushInFlight;
}

async function flushPendingSave() {
    clearTimeout(saveTimeout);
    saveTimeout = null;
    while (pendingMutations.size) {
        const before = pendingMutations.size;
        await flushMutations();
        if (pendingMutations.size >= before) throw new Error('Could not flush pending note changes.');
    }
    if (dirty && !pendingMutations.size && !saveInFlight) await save();
    await window.electronAPI.flushPendingSave();
}

function updateStorageStatus(next) {
    storageState = { ...storageState, ...next };
    if (typeof storageStatus === 'undefined' || !storageStatus) return;
    const stateName = storageState.state;
    const persistent = ['error', 'recovered', 'needs-reset'].includes(stateName);
    const visible = stateName === 'saving' || persistent;
    storageStatus.dataset.state = stateName;
    storageStatus.classList.toggle('saving', stateName === 'saving');
    storageStatus.classList.toggle('error', stateName === 'error' || stateName === 'needs-reset');
    storageStatus.classList.toggle('recovery', stateName === 'recovered');
    storageStatus.classList.toggle('visible', visible);
    storageStatus.setAttribute('aria-hidden', visible ? 'false' : 'true');
    storageStatusMessage.textContent = storageState.message || (stateName === 'saving' ? 'Saving…' : 'Saved');
    storageStatusAction.classList.toggle('hidden', !persistent);
    storageStatusAction.textContent = stateName === 'needs-reset' ? 'Start fresh' : 'Retry';
    storageStatus.setAttribute('role', stateName === 'error' || stateName === 'needs-reset' ? 'alert' : 'status');
}

// ===== Helpers =====
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function formatDate(iso) {
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function wordCount(text) {
    if (!text || !text.trim()) return 0;
    return text.trim().split(/\s+/).length;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeHtmlAttribute(text) {
    return escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function highlightInHtml(html, query) {
    return window.fleetSecurity.highlightSafeHtml(html, query);
}

const markdownCache = new Map();
let markdownConfigured = false;

function configureMarkdown() {
    if (markdownConfigured || !window.marked) return;
    marked.use({
        gfm: true,
        breaks: true,
        extensions: [{
            name: 'highlight',
            level: 'inline',
            start(source) {
                const match = source.match(/==/);
                return match ? match.index : undefined;
            },
            tokenizer(source) {
                const match = /^==([^=\n]+)==/.exec(source);
                if (!match) return;
                return { type: 'highlight', raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) };
            },
            renderer(token) {
                return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
            }
        }]
    });
    markdownConfigured = true;
}

// A single backtick span containing a raw newline is valid CommonMark inline
// code, and per spec its line breaks collapse to spaces - so pasted code
// wrapped in `single backticks` instead of a ``` fence renders as one run-on
// line. That reads as broken even though it is spec-correct, so previews
// upgrade it to a proper fenced block. The stored note content is untouched;
// this only reshapes what gets handed to the parser.
function upgradeMultilineInlineCode(text) {
    // Skip past already-fenced blocks (``` ... ```) so their contents are
    // never touched, then only transform single-backtick spans elsewhere.
    return text.split(/(```[\s\S]*?```)/).map((segment, i) => {
        if (i % 2 === 1) return segment; // inside an existing fence
        return segment.replace(/`([^`]*\n[^`]*)`/g, (match, code) => {
            const trimmed = code.replace(/^\n+|\n+$/g, '');
            return '```\n' + trimmed + '\n```';
        });
    }).join('');
}

function renderMarkdown(text) {
    if (!text || !text.trim()) return '<p class="note-preview-empty">Empty note</p>';
    try {
        configureMarkdown();
        const cacheKey = String(text);
        if (markdownCache.has(cacheKey)) return markdownCache.get(cacheKey);

        const html = marked.parse(upgradeMultilineInlineCode(String(text)));
        if (!window.fleetSecurity) return escapeHtml(text);

        // 'disabled' is not in ALLOWED_ATTR, so the sanitizer already drops it
        // and the checkboxes come back clickable. No post-processing needed.
        const result = window.fleetSecurity.sanitizeMarkdownHtml(html);
        if (markdownCache.size > 300) markdownCache.delete(markdownCache.keys().next().value);
        markdownCache.set(cacheKey, result);
        return result;
    } catch (e) {
        return escapeHtml(text);
    }
}

// ===== Color Palettes =====
// Fixed hex only - no alpha-derived tints anywhere in the UI.
const FOLDER_COLORS = [
    { bg: '#2A1F2B', fg: '#D98BAE' },
    { bg: '#1B2432', fg: '#6BA0FF' },
    { bg: '#182619', fg: '#5FC97A' },
    { bg: '#241F2E', fg: '#B88CFF' },
    { bg: '#2A2418', fg: '#D9A93C' },
    { bg: '#1C2A2A', fg: '#5FBFC9' },
];

// ===== Icons =====
// One 16px, 1.5px-stroke, round-cap family used across every surface.
const svgIcon = (paths, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICON_STAR = svgIcon('<path d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.78L12 16.77l-5.2 2.73.99-5.78-4.21-4.1 5.82-.85z"/>', 14);
const ICON_PIN = svgIcon('<path d="M12 16.5V21"/><path d="M8.5 3h7l-1.2 6.2 2.2 2.3v1.5H7.5V11.5l2.2-2.3z"/>', 14);
const ICON_MORE = svgIcon('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>', 15);
const ICON_IMAGE = svgIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15.5L16 11l-8 8"/>', 15);
const ICON_DOWNLOAD = svgIcon('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M12 15V3"/>', 15);
const ICON_COPY = svgIcon('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 15);
const ICON_TRASH = svgIcon('<path d="M3.5 6h17"/><path d="M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6"/><path d="M18.5 6l-.9 13.1a1.5 1.5 0 0 1-1.5 1.4H7.9a1.5 1.5 0 0 1-1.5-1.4L5.5 6"/><path d="M10 10.5v6M14 10.5v6"/>');
const ICON_CHEVRON_RIGHT = svgIcon('<path d="M9 5l7 7-7 7"/>');

const ICON_EMPTY_FOLDER = svgIcon('<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4L10.5 8H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>', 32);
const ICON_EMPTY_NOTE = svgIcon('<path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14.5 3v5.5H20"/><path d="M8.5 13h7M8.5 16.5h4.5"/>', 32);
const ICON_EMPTY_SEARCH = svgIcon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.9-3.9"/>', 32);
const ICON_EMPTY_STAR = svgIcon('<path d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.78L12 16.77l-5.2 2.73.99-5.78-4.21-4.1 5.82-.85z"/>', 32);
const ICON_EMPTY_TRASH = svgIcon('<path d="M3.5 6h17"/><path d="M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6"/><path d="M18.5 6l-.9 13.1a1.5 1.5 0 0 1-1.5 1.4H7.9a1.5 1.5 0 0 1-1.5-1.4L5.5 6"/>', 32);

// One empty-state treatment for every screen.
function emptyStateHtml(icon, title, message) {
    return `<div class="empty-state">${icon}<div class="empty-state-title">${escapeHtml(title)}</div><p>${escapeHtml(message)}</p></div>`;
}

// Selectors are built from generated ids, but escape defensively so a stray
// character can never produce an invalid query.
function cssEscape(value) {
    const str = String(value);
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(str);
    return str.replace(/["\\\]]/g, '\\$&');
}

// ===== DOM References =====
const collapsedStrip = document.getElementById('collapsed-strip');
const expandedPanel = document.getElementById('expanded-panel');
const topTitle = document.getElementById('top-title');
const btnBack = document.getElementById('btn-back');
const btnSearchToggle = document.getElementById('btn-search-toggle');
const btnJira = document.getElementById('btn-jira');
const btnOverflow = document.getElementById('btn-overflow');
const btnCollapse = document.getElementById('btn-collapse');
const topBar = document.getElementById('top-bar');
const overflowMenu = document.getElementById('overflow-menu');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const btnSearchClear = document.getElementById('btn-search-clear');
const folderListView = document.getElementById('folder-list-view');
const notesView = document.getElementById('notes-view');
const jiraListView = document.getElementById('jira-list-view');
const jiraDetailView = document.getElementById('jira-detail-view');
const jiraContent = document.getElementById('jira-content');
const jiraDetail = document.getElementById('jira-detail');
const folderList = document.getElementById('folder-list');
const notesList = document.getElementById('notes-list');
const btnAddFolder = document.getElementById('btn-add-folder');
const btnAddNote = document.getElementById('btn-add-note');
const contextMenu = document.getElementById('context-menu');
const formatDropdown = document.getElementById('format-dropdown');
const resizeHandle = document.getElementById('resize-handle');
const resizeHandleV = document.getElementById('resize-handle-v');
const resizeHandleCorner = document.getElementById('resize-handle-corner');
const appRoot = document.getElementById('app');
const settingsView = document.getElementById('settings-view');
const favouritesView = document.getElementById('favourites-view');
const favouritesList = document.getElementById('favourites-list');
const trashView = document.getElementById('trash-view');
const trashList = document.getElementById('trash-list');
const shortcutRecorder = document.getElementById('shortcut-recorder');
const shortcutDisplay = document.getElementById('shortcut-display');
const shortcutError = document.getElementById('shortcut-error');
const btnResetShortcut = document.getElementById('btn-reset-shortcut');
const btnDisableShortcut = document.getElementById('btn-disable-shortcut');
const defaultFontSizeValue = document.getElementById('default-font-size-value');
const btnDefaultFontDec = document.getElementById('btn-default-font-dec');
const btnDefaultFontInc = document.getElementById('btn-default-font-inc');
const btnExportBackup = document.getElementById('btn-export-backup');
const btnRestoreBackup = document.getElementById('btn-restore-backup');
const btnExportDiagnostics = document.getElementById('btn-export-diagnostics');
const updatesEnabled = document.getElementById('updates-enabled');
const btnCheckUpdates = document.getElementById('btn-check-updates');
const btnOpenRelease = document.getElementById('btn-open-release');
const fontPreview = document.getElementById('font-preview');
const dockSideGroup = document.getElementById('dock-side');
const dockStyleGroup = document.getElementById('dock-style');
const btnResetDock = document.getElementById('btn-reset-dock');
const updateStatus = document.getElementById('update-status');
const shortcutOnboarding = document.getElementById('shortcut-onboarding');
const shortcutOnboardingKeep = document.getElementById('shortcut-onboarding-keep');
const shortcutOnboardingCustomize = document.getElementById('shortcut-onboarding-customize');
const shortcutOnboardingDisable = document.getElementById('shortcut-onboarding-disable');
const toastRegion = document.getElementById('toast-region');
const toastMessage = document.getElementById('toast-message');
const toastAction = document.getElementById('toast-action');
const storageStatus = document.getElementById('storage-status');
const storageStatusMessage = document.getElementById('storage-status-message');
const storageStatusAction = document.getElementById('storage-status-action');

function showToast(message, type = 'info', action = null) {
    toastMessage.textContent = message;
    toastRegion.dataset.type = type;
    toastRegion.classList.add('visible');
    toastAction.classList.toggle('hidden', !action);
    toastAction.onclick = action ? async () => { await action(); toastRegion.classList.remove('visible'); } : null;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toastRegion.classList.remove('visible'), 3500);
}

window.electronAPI.onOpenView(view => {
    if (view === 'favourites') openFavourites(true);
    else if (view === 'trash') openTrash(true);
    else if (view === 'settings') showSettings();
});
window.electronAPI.onRequestBackupExport(() => exportBackup());
window.electronAPI.onUpdateStatus(status => updateUpdateStatus(status));

window.addEventListener('error', event => {
    window.electronAPI.reportRendererError?.({ message: event.message, stack: event.error?.stack });
});
window.addEventListener('unhandledrejection', event => {
    window.electronAPI.reportRendererError?.({ message: String(event.reason?.message || event.reason) });
});

function hideShortcutOnboarding() {
    shortcutOnboarding.classList.add('hidden');
}

async function setShortcutPreference(options) {
    try {
        const result = await window.electronAPI.setToggleShortcut({ ...options, onboardingSeen: true });
        if (!result?.success) throw new Error(result?.error || 'Could not update shortcut.');
        hideShortcutOnboarding();
        shortcutDisplay.dataset.accelerator = result.accelerator || shortcutDisplay.dataset.accelerator;
        shortcutDisplay.textContent = result.enabled === false ? 'Disabled' : acceleratorToDisplay(shortcutDisplay.dataset.accelerator);
        showToast(result.enabled === false ? 'Global shortcut disabled.' : 'Global shortcut enabled.', 'success');
        return result;
    } catch (error) {
        showToast(error.message || 'Could not update shortcut.', 'error');
        return null;
    }
}

shortcutOnboardingKeep.addEventListener('click', () => setShortcutPreference({ accelerator: 'CommandOrControl+Shift+Space', enabled: true }));
shortcutOnboardingCustomize.addEventListener('click', async () => {
    await setShortcutPreference({ accelerator: 'CommandOrControl+Shift+Space', enabled: true });
    showSettings();
});
shortcutOnboardingDisable.addEventListener('click', () => setShortcutPreference({ accelerator: 'CommandOrControl+Shift+Space', enabled: false }));

storageStatusAction.addEventListener('click', async () => {
    if (storageState.state === 'needs-reset') {
        try {
            const result = await window.electronAPI.startFreshStorage();
            if (result?.success) {
                storageState = result.storage || { state: 'ok', message: '', canWrite: true };
                updateStorageStatus(storageState);
                await save();
            }
        } catch {
            updateStorageStatus({ state: 'error', message: 'Could not start fresh. Please try again.', canWrite: false });
        }
        return;
    }
    await save();
});

window.electronAPI.onStorageSaveError(details => {
    updateStorageStatus({ state: 'error', message: details?.message || 'Could not save notes. Click Retry to try again.', canWrite: true });
});

window.electronAPI.onPrepareToQuit(async () => {
    try {
        await flushPendingSave();
        window.electronAPI.notifySaveFlushed({ success: true });
    } catch (error) {
        updateStorageStatus({ state: 'error', message: 'Could not save notes before quitting. Click Retry to try again.', canWrite: true });
        window.electronAPI.notifySaveFlushed({ success: false, error: 'Could not save notes before quitting.' });
    }
});

// ===== Expansion State =====
window.electronAPI.onExpansionState((expanded) => {
    if (expanded) {
        collapsedStrip.classList.add('hidden');
        expandedPanel.classList.remove('hidden');
    } else {
        expandedPanel.classList.add('hidden');
        collapsedStrip.classList.remove('hidden');
    }
});

// ===== Collapsed dock handle =====
// A press that travels more than DRAG_THRESHOLD px is a reposition, not a
// click, so dragging the handle never accidentally opens the panel.
const DRAG_THRESHOLD = 4;
let dockDrag = null;
let suppressStripClick = false;

function applyDockAppearance() {
    const side = state.settings.dockSide === 'left' ? 'left' : 'right';
    const style = state.settings.collapsedStyle === 'icon' ? 'icon' : 'capsule';
    appRoot.dataset.side = side;
    collapsedStrip.classList.toggle('collapsed-strip--icon', style === 'icon');
    collapsedStrip.classList.toggle('collapsed-strip--capsule', style !== 'icon');
    dockSideGroup?.querySelectorAll('button').forEach(btn =>
        btn.setAttribute('aria-pressed', btn.dataset.side === side ? 'true' : 'false'));
    dockStyleGroup?.querySelectorAll('button').forEach(btn =>
        btn.setAttribute('aria-pressed', btn.dataset.style === style ? 'true' : 'false'));
}

collapsedStrip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dockDrag = { startX: e.screenX, startY: e.screenY, moved: false };
    e.preventDefault();
});

collapsedStrip.addEventListener('click', () => {
    // Suppressed when the press was actually a drag.
    if (suppressStripClick) return;
    window.electronAPI.expand();
});

// Deliberately no hover-to-open: the handle has to be draggable, and on
// collapse the window lands under the cursor, so a mouseenter listener
// re-expanded it immediately.

btnCollapse.addEventListener('click', () => {
    window.electronAPI.collapse();
});

// ===== Drag the expanded panel by its header =====
// grabOffsetY keeps the exact point the user grabbed under the cursor.
let headerDrag = null;

topBar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, [contenteditable="true"]')) return;
    headerDrag = { grabOffsetY: e.screenY - window.screenY, startY: e.screenY, moved: false };
    e.preventDefault();
});

// ===== Resize handles =====
let isResizing = false;
let resizeAxis = null;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;
let pendingResize = false;

function beginResize(axis, e) {
    isResizing = true;
    resizeAxis = axis;
    resizeStartX = e.screenX;
    resizeStartY = e.screenY;
    resizeStartWidth = expandedPanel.offsetWidth;
    resizeStartHeight = expandedPanel.offsetHeight;
    document.body.style.cursor = axis === 'y' ? 'ns-resize' : (axis === 'x' ? 'ew-resize' : '');
    e.preventDefault();
}

resizeHandle.addEventListener('mousedown', (e) => { resizeHandle.classList.add('resizing'); beginResize('x', e); });
resizeHandleV.addEventListener('mousedown', (e) => { resizeHandleV.classList.add('resizing'); beginResize('y', e); });
resizeHandleCorner.addEventListener('mousedown', (e) => {
    resizeHandle.classList.add('resizing');
    resizeHandleV.classList.add('resizing');
    beginResize('both', e);
});

document.addEventListener('mousemove', (e) => {
    if (headerDrag) {
        if (!headerDrag.moved && Math.abs(e.screenY - headerDrag.startY) < DRAG_THRESHOLD) return;
        headerDrag.moved = true;
        topBar.classList.add('dragging');
        window.electronAPI.moveDock({ screenX: e.screenX, screenY: e.screenY, axis: 'y', grabOffsetY: headerDrag.grabOffsetY });
        return;
    }

    if (dockDrag) {
        if (!dockDrag.moved
            && Math.abs(e.screenX - dockDrag.startX) < DRAG_THRESHOLD
            && Math.abs(e.screenY - dockDrag.startY) < DRAG_THRESHOLD) return;
        dockDrag.moved = true;
        collapsedStrip.classList.add('dragging');
        window.electronAPI.moveDock({ screenX: e.screenX, screenY: e.screenY });
        return;
    }

    if (!isResizing || pendingResize) return;

    // The window grows toward the screen centre, so the delta sign depends on
    // which edge we are docked to.
    const towardCentre = state.settings.dockSide === 'left' ? 1 : -1;
    const deltaX = (e.screenX - resizeStartX) * towardCentre;
    const payload = {};
    if (resizeAxis === 'x' || resizeAxis === 'both') payload.width = resizeStartWidth + deltaX;
    if (resizeAxis === 'y' || resizeAxis === 'both') payload.height = resizeStartHeight + (e.screenY - resizeStartY);

    pendingResize = true;
    requestAnimationFrame(() => {
        window.electronAPI.resizeWindow(payload);
        pendingResize = false;
    });
});

document.addEventListener('mouseup', () => {
    if (headerDrag) {
        topBar.classList.remove('dragging');
        headerDrag = null;
    }
    if (dockDrag) {
        const wasDrag = dockDrag.moved;
        collapsedStrip.classList.remove('dragging');
        dockDrag = null;
        // click fires after mouseup, so hold the suppression one tick longer.
        if (wasDrag) {
            suppressStripClick = true;
            setTimeout(() => { suppressStripClick = false; }, 0);
        }
    }
    if (!isResizing) return;
    isResizing = false;
    resizeAxis = null;
    pendingResize = false;
    resizeHandle.classList.remove('resizing');
    resizeHandleV.classList.remove('resizing');
    document.body.style.cursor = '';
});

// ===== Search =====
let searchVisible = false;

btnSearchToggle.addEventListener('click', () => {
    searchVisible = !searchVisible;
    if (searchVisible) {
        searchBar.classList.remove('hidden');
        searchInput.focus();
    } else {
        searchBar.classList.add('hidden');
        searchInput.value = '';
        state.searchQuery = '';
        renderCurrentView();
    }
});

searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.toLowerCase();
    btnSearchClear.classList.toggle('hidden', !state.searchQuery);
    clearTimeout(window.fleetSearchTimer);
    window.fleetSearchTimer = setTimeout(() => renderCurrentView(), 150);
});

btnSearchClear.addEventListener('click', () => {
    searchInput.value = '';
    state.searchQuery = '';
    btnSearchClear.classList.add('hidden');
    updateSearchCount(null);
    searchInput.focus();
    renderCurrentView();
});

// Live result count next to the query.
function updateSearchCount(count) {
    if (!state.searchQuery || count === null) { searchCount.textContent = ''; return; }
    searchCount.textContent = count === 0 ? 'No results' : `${count} result${count !== 1 ? 's' : ''}`;
}

function clearActiveSearch() {
    state.searchQuery = '';
    searchInput.value = '';
    btnSearchClear.classList.add('hidden');
    updateSearchCount(null);
    if (searchVisible) {
        searchVisible = false;
        searchBar.classList.add('hidden');
    }
}

function searchableText(item) {
    const key = item.id;
    const content = typeof item.content === 'string'
        ? `${item.id || ''}\n${item.content}`
        : `${item.name || ''}\n${(item.notes || []).map(note => `${note.id}:${note.content}`).join('\n')}`;
    const cached = searchIndexCache.get(key);
    if (cached?.source === content) return cached.value;
    const value = content.toLowerCase();
    searchIndexCache.set(key, { source: content, value });
    return value;
}

// ===== Back Button =====
let previousView = null;
let trashReturnView = null;
let favouritesReturnView = null;
let favouritesReturnFocus = null;
let trashReturnFocus = null;
btnBack.addEventListener('click', () => {
    if (state.currentView === 'jira-detail') {
        state.currentView = 'jira-list';
        state.jira.detail = null;
        renderJiraList();
        return;
    }
    if (state.currentView === 'jira-list') {
        returnToLocalSpace();
        return;
    }
    if (state.currentView === 'favourites') {
        const destination = favouritesReturnView || { view: 'folders', folderId: null };
        state.currentView = destination.view;
        state.currentFolderId = destination.folderId;
        favouritesReturnView = null;
        renderCurrentView();
        const focusTarget = favouritesReturnFocus;
        favouritesReturnFocus = null;
        if (focusTarget && typeof focusTarget.focus === 'function') setTimeout(() => focusTarget.focus({ preventScroll: true }), 0);
        return;
    }
    if (state.currentView === 'trash') {
        const destination = trashReturnView || { view: 'folders', folderId: null };
        state.currentView = destination.view;
        state.currentFolderId = destination.folderId;
        trashReturnView = null;
        renderCurrentView();
        const focusTarget = trashReturnFocus;
        trashReturnFocus = null;
        if (focusTarget && typeof focusTarget.focus === 'function') setTimeout(() => focusTarget.focus({ preventScroll: true }), 0);
    } else if (state.currentView === 'settings' && previousView) {
        state.currentView = previousView.view;
        state.currentFolderId = previousView.folderId;
        previousView = null;
    } else {
        state.currentView = 'folders';
        state.currentFolderId = null;
        state.activeNoteId = null;
    }
    renderCurrentView();
});

// ===== Add Folder =====
btnAddFolder.addEventListener('click', () => {
    clearActiveSearch();
    const colorIndex = state.folders.length % FOLDER_COLORS.length;
    const folder = {
        id: generateId(),
        name: 'New Folder',
        createdAt: new Date().toISOString(),
        colorIndex,
        notes: []
    };
    state.folders.push(folder);
    queueMutation({ type: 'upsert-folder', folder: { ...folder } });
    renderFolders();

    setTimeout(() => {
        const item = folderList.querySelector(`[data-id="${CSS.escape(folder.id)}"]`);
        if (item) startRenameFolder(folder.id, item);
    }, 50);
});

// ===== Add Note =====
btnAddNote.addEventListener('click', () => addNote());

function addNote() {
    clearActiveSearch();
    const folder = state.folders.find(f => f.id === state.currentFolderId);
    if (!folder) return;

    const note = {
        id: generateId(),
        content: '',
        favourite: false,
        pinned: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        fontSize: Math.max(10, Math.min(24, Number(state.settings.defaultFontSize) || 13))
    };
    folder.notes.unshift(note);
    state.newNoteId = note.id;
    state.editingNoteIds.add(note.id); // new notes start in edit mode
    queueMutation({ type: 'upsert-note', folderId: folder.id, note: { ...note } });
    renderNotes();

    setTimeout(() => {
        const editor = notesList.querySelector(`.note-editor[data-note-id="${CSS.escape(note.id)}"]`);
        if (editor) {
            editor.focus();
        }
    }, 100);
}

// ===== Render Folders =====
function renderFolders() {
    topTitle.textContent = 'Fleet';
    btnBack.classList.add('hidden');
    folderListView.classList.remove('hidden');
    notesView.classList.add('hidden');
    settingsView.classList.add('hidden');
    favouritesView.classList.add('hidden');
    trashView.classList.add('hidden');
    jiraListView.classList.add('hidden');
    jiraDetailView.classList.add('hidden');
    btnJira.classList.remove('active');
    btnJira.setAttribute('aria-pressed', 'false');

    let folders = state.folders;
    if (state.searchQuery) {
        folders = folders.filter(f => {
            return searchableText(f).includes(state.searchQuery);
        });
    }

    updateSearchCount(state.searchQuery ? folders.length : null);

    if (folders.length === 0) {
        folderList.innerHTML = state.searchQuery
            ? emptyStateHtml(ICON_EMPTY_SEARCH, 'No matching folders', 'Try a different search term.')
            : emptyStateHtml(ICON_EMPTY_FOLDER, 'No folders yet', 'Create one to start collecting notes.');
        return;
    }

    folderList.innerHTML = folders.map(folder => {
        const color = FOLDER_COLORS[folder.colorIndex || 0];
        const noteCount = folder.notes.length;
        const folderId = escapeHtml(folder.id);
        return `
      <div class="folder-item" data-id="${folderId}" role="button" tabindex="0" aria-label="Open folder ${escapeHtml(folder.name)}">
        <div class="folder-icon" style="background: ${color.bg}; color: ${color.fg}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4L10.5 8H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>
          </svg>
        </div>
        <div class="folder-info">
          <div class="folder-name">${state.searchQuery ? highlightInHtml(escapeHtml(folder.name), state.searchQuery) : escapeHtml(folder.name)}</div>
          <div class="folder-count">${noteCount} note${noteCount !== 1 ? 's' : ''}</div>
        </div>
        <button class="icon-btn folder-menu-btn" data-folder-id="${folderId}" title="Folder options" aria-label="Folder options">${ICON_MORE}</button>
      </div>
    `;
    }).join('');

    // Attach click events
    folderList.querySelectorAll('.folder-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.folder-menu-btn')) return;
            openFolder(item.dataset.id);
        });
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openFolder(item.dataset.id);
            }
        });
    });

    folderList.querySelectorAll('.folder-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showContextMenu(e, btn.dataset.folderId);
        });
    });
}

// ===== Open Folder =====
function openFolder(folderId) {
    state.currentView = 'notes';
    state.currentFolderId = folderId;
    renderCurrentView();
}

function orderedVisibleNotes(folder) {
    let notes = [...folder.notes];
    if (state.searchQuery) {
        notes = notes.filter(note => searchableText({ id: note.id, content: note.content }).includes(state.searchQuery));
    }
    const newNote = state.newNoteId ? notes.find(note => note.id === state.newNoteId) : null;
    if (newNote) notes = notes.filter(note => note.id !== state.newNoteId);
    const pinnedNotes = notes.filter(note => note.pinned);
    const unpinnedNotes = notes.filter(note => !note.pinned);
    return newNote ? [newNote, ...pinnedNotes, ...unpinnedNotes] : [...pinnedNotes, ...unpinnedNotes];
}

function syncNoteCardOrder(folder) {
    const ordered = orderedVisibleNotes(folder);
    const cards = new Map(Array.from(notesList.querySelectorAll('.note-card[data-note-id]')).map(card => [card.dataset.noteId, card]));
    ordered.forEach(note => {
        const card = cards.get(note.id);
        if (card) notesList.appendChild(card);
    });
}

function updateNoteCardVisual(noteId) {
    const folder = state.folders.find(item => item.id === state.currentFolderId);
    const note = folder?.notes.find(item => item.id === noteId);
    const card = notesList.querySelector(`.note-card[data-note-id="${CSS.escape(noteId)}"]`);
    if (!note || !card) return;
    normalizeNoteFlags(note);
    card.classList.toggle('favourite', note.favourite);
    card.classList.toggle('pinned', note.pinned);
    const favourite = card.querySelector('.note-favourite-btn');
    if (favourite) {
        const label = note.favourite ? 'Remove from favourites' : 'Add to favourites';
        favourite.classList.toggle('favourited', note.favourite);
        favourite.title = label;
        favourite.setAttribute('aria-label', label);
        favourite.setAttribute('aria-pressed', note.favourite ? 'true' : 'false');
    }
    const pin = card.querySelector('.note-pin-btn');
    if (pin) {
        const label = note.pinned ? 'Unpin from top' : 'Pin to top';
        pin.classList.toggle('pinned', note.pinned);
        pin.title = label;
        pin.setAttribute('aria-label', label);
        pin.setAttribute('aria-pressed', note.pinned ? 'true' : 'false');
    }
    card.classList.toggle('pinned', !!note.pinned);
    card.classList.toggle('favourite', !!note.favourite);
}

function scheduleNoteVisualUpdate(noteId, needsReorder = false) {
    pendingVisualUpdates.add(noteId);
    visualUpdateNeedsReorder = visualUpdateNeedsReorder || needsReorder;
    if (visualUpdateFrame) return;
    const flush = () => {
        visualUpdateFrame = null;
        const scroller = notesList.closest('.content-area');
        const scrollTop = scroller?.scrollTop;
        const scrollLeft = scroller?.scrollLeft;
        const ids = Array.from(pendingVisualUpdates);
        pendingVisualUpdates.clear();
        const reorder = visualUpdateNeedsReorder;
        visualUpdateNeedsReorder = false;
        ids.forEach(updateNoteCardVisual);
        if (reorder) {
            const folder = state.folders.find(item => item.id === state.currentFolderId);
            if (folder) syncNoteCardOrder(folder);
        }
        if (scroller) {
            scroller.scrollTop = scrollTop;
            scroller.scrollLeft = scrollLeft;
        }
    };
    visualUpdateFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : setTimeout(flush, 0);
}

// ===== Note Card Markup =====
// Split into header / body / footer so a mode switch can swap only the
// regions that actually changed instead of rebuilding the whole list.
function notePreviewFontSize(note) {
    return Math.max(10, Math.min(24, Number(note.fontSize) || state.settings.defaultFontSize || 13));
}

function noteHeaderHtml(note) {
    const noteId = escapeHtml(note.id);
    const favLabel = note.favourite ? 'Remove from favourites' : 'Add to favourites';
    const pinLabel = note.pinned ? 'Unpin from top' : 'Pin to top';
    return `
        <div class="note-card-header">
          <div class="note-drag-handle" title="Drag to reorder" aria-hidden="true">
            <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="3" cy="3" r="1.1"/><circle cx="7" cy="3" r="1.1"/><circle cx="3" cy="8" r="1.1"/><circle cx="7" cy="8" r="1.1"/><circle cx="3" cy="13" r="1.1"/><circle cx="7" cy="13" r="1.1"/></svg>
          </div>
          <span class="note-timestamp">${formatDate(note.updatedAt)}</span>
          <button class="icon-btn note-favourite-btn ${note.favourite ? 'favourited' : ''}" data-note-id="${noteId}" title="${favLabel}" aria-label="${favLabel}" aria-pressed="${note.favourite ? 'true' : 'false'}">
            ${ICON_STAR}
          </button>
          <button class="icon-btn note-pin-btn ${note.pinned ? 'pinned' : ''}" data-note-id="${noteId}" title="${pinLabel}" aria-label="${pinLabel}" aria-pressed="${note.pinned ? 'true' : 'false'}">
            ${ICON_PIN}
          </button>
        </div>`;
}

function noteBodyHtml(note) {
    const noteId = escapeHtml(note.id);
    if (state.editingNoteIds.has(note.id)) {
        return `
              <div class="note-editor-wrapper">
                <textarea
                  class="note-editor"
                  data-note-id="${noteId}"
                  placeholder="Write in Markdown"
                  style="font-size: ${notePreviewFontSize(note)}px"
                >${escapeHtml(note.content)}</textarea>
              </div>`;
    }
    return `
              <div class="note-preview" data-note-id="${noteId}" role="button" tabindex="-1" aria-label="Edit note">
                <div class="note-preview-content" style="font-size: ${notePreviewFontSize(note)}px">${highlightInHtml(renderMarkdown(note.content), state.searchQuery)}</div>
              </div>`;
}

function noteFooterHtml(note) {
    const noteId = escapeHtml(note.id);
    const wc = wordCount(note.content);
    const count = `<span class="note-word-count">${wc} word${wc !== 1 ? 's' : ''}</span>`;

    // Preview mode keeps the card calm: just the word count and an overflow
    // menu. The full toolbar only appears while the note is being edited.
    if (!state.editingNoteIds.has(note.id)) {
        return `
        <div class="note-toolbar note-toolbar--compact">
          ${count}
          <div class="toolbar-spacer"></div>
          <button class="btn-tool btn-note-settings" data-note-id="${noteId}" title="More actions" aria-label="More actions">${ICON_MORE}</button>
        </div>`;
    }

    return `
        <div class="note-toolbar">
          <button class="btn-tool btn-format-toggle" data-note-id="${noteId}" title="Formatting" aria-label="Formatting"><span class="btn-tool-label">Aa</span></button>
          <button class="btn-tool btn-upload" data-note-id="${noteId}" title="Insert image" aria-label="Insert image">${ICON_IMAGE}</button>
          <button class="btn-tool btn-download" data-note-id="${noteId}" title="Export Markdown" aria-label="Export Markdown">${ICON_DOWNLOAD}</button>
          <button class="btn-tool btn-copy-clipboard" data-note-id="${noteId}" title="Copy Markdown" aria-label="Copy Markdown">${ICON_COPY}</button>
          <div class="toolbar-spacer"></div>
          ${count}
          <button class="btn-tool btn-note-settings" data-note-id="${noteId}" title="More actions" aria-label="More actions">${ICON_MORE}</button>
        </div>`;
}

function noteCardHtml(note) {
    const noteId = escapeHtml(note.id);
    const classes = ['note-card'];
    if (note.pinned) classes.push('pinned');
    if (note.favourite) classes.push('favourite');
    if (state.editingNoteIds.has(note.id)) classes.push('editing');
    return `
      <div class="${classes.join(' ')}" data-note-id="${noteId}" tabindex="0" aria-label="Note">
        ${noteHeaderHtml(note)}
        <div class="note-body" data-note-id="${noteId}">${noteBodyHtml(note)}</div>
        <div class="note-footer" data-note-id="${noteId}">${noteFooterHtml(note)}</div>
      </div>`;
}

// Swap a single card between edit and preview without touching the rest of
// the list. Rebuilding everything through renderNotes() destroyed the focused
// textarea, which re-fired blur and cascaded into repeated renders.
function renderNoteContent(noteId) {
    const folder = state.folders.find(f => f.id === state.currentFolderId);
    if (!folder) return;
    const note = folder.notes.find(n => n.id === noteId);
    if (!note) return;
    const card = notesList.querySelector(`.note-card[data-note-id="${cssEscape(noteId)}"]`);
    if (!card) return;

    const body = card.querySelector('.note-body');
    const footer = card.querySelector('.note-footer');
    if (!body || !footer) return;

    body.innerHTML = noteBodyHtml(note);
    footer.innerHTML = noteFooterHtml(note);
    card.classList.toggle('editing', state.editingNoteIds.has(noteId));
    attachNoteBodyEvents(card);
}

// ===== Render Notes =====
function renderNotes() {
    const folder = state.folders.find(f => f.id === state.currentFolderId);
    if (!folder) return;

    let normalizedChanged = false;
    folder.notes.forEach(note => {
        if (normalizeNoteFlags(note)) normalizedChanged = true;
    });
    if (normalizedChanged) folder.notes.forEach(note => queueMutation({ type: 'upsert-note', folderId: folder.id, note: { ...note } }));

    topTitle.textContent = folder.name;
    btnBack.classList.remove('hidden');
    folderListView.classList.add('hidden');
    notesView.classList.remove('hidden');
    settingsView.classList.add('hidden');
    favouritesView.classList.add('hidden');
    trashView.classList.add('hidden');
    jiraListView.classList.add('hidden');
    jiraDetailView.classList.add('hidden');
    btnJira.classList.remove('active');
    btnJira.setAttribute('aria-pressed', 'false');

    const notes = orderedVisibleNotes(folder);

    updateSearchCount(state.searchQuery ? notes.length : null);

    if (notes.length === 0) {
        notesList.innerHTML = state.searchQuery
            ? emptyStateHtml(ICON_EMPTY_SEARCH, 'No matching notes', 'Try a different search term.')
            : emptyStateHtml(ICON_EMPTY_NOTE, 'No notes yet', 'Add your first note to this folder.');
        return;
    }

    // Pinned notes are grouped under their own header rather than each carrying
    // a separate border treatment.
    const pinned = notes.filter(note => note.pinned);
    const rest = notes.filter(note => !note.pinned);
    let markup = '';
    if (pinned.length && rest.length) {
        markup += `<div class="section-header">Pinned</div>`;
        markup += pinned.map(noteCardHtml).join('');
        markup += `<div class="section-header">Notes</div>`;
        markup += rest.map(noteCardHtml).join('');
    } else {
        markup = notes.map(noteCardHtml).join('');
    }
    notesList.innerHTML = markup;

    attachNoteEvents();
}

// ===== Toggle Checkbox in Preview =====
function toggleCheckbox(noteId, checkboxIndex) {
    const folder = state.folders.find(f => f.id === state.currentFolderId);
    if (!folder) return;
    const note = folder.notes.find(n => n.id === noteId);
    if (!note) return;

    // Find the Nth `- [ ]` or `- [x]` in the markdown and toggle it
    const lines = note.content.split('\n');
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        const unchecked = /^(\s*-\s*)\[\s\](.*)$/.exec(lines[i]);
        const checked = /^(\s*-\s*)\[x\](.*)$/i.exec(lines[i]);
        if (unchecked || checked) {
            if (count === checkboxIndex) {
                if (unchecked) {
                    lines[i] = unchecked[1] + '[x]' + unchecked[2];
                } else {
                    lines[i] = checked[1] + '[ ]' + checked[2];
                }
                break;
            }
            count++;
        }
    }

    note.content = lines.join('\n');
    note.updatedAt = new Date().toISOString();
    queueMutation({ type: 'upsert-note', folderId: folder.id, note: { ...note } });

    // Re-render the preview in place
    const preview = document.querySelector(`.note-preview[data-note-id="${noteId}"]`);
    if (preview) {
        const content = preview.querySelector('.note-preview-content') || preview;
        content.innerHTML = state.searchQuery ? highlightInHtml(renderMarkdown(note.content), state.searchQuery) : renderMarkdown(note.content);
        content.style.fontSize = `${Math.max(10, Math.min(24, Number(note.fontSize) || state.settings.defaultFontSize || 13))}px`;

        // Update word count and timestamp
        const card = preview.closest('.note-card');
        const wcEl = card.querySelector('.note-word-count');
        const wc = wordCount(note.content);
        wcEl.textContent = `${wc} word${wc !== 1 ? 's' : ''}`;
        const tsEl = card.querySelector('.note-timestamp');
        tsEl.textContent = formatDate(note.updatedAt);

        // Re-attach checkbox handlers on the newly rendered checkboxes
        preview.querySelectorAll('input[type="checkbox"]').forEach((cb, idx) => {
            cb.addEventListener('click', (e) => {
                e.stopPropagation();
                e.stopImmediatePropagation();
                e.preventDefault();
                toggleCheckbox(noteId, idx);
            }, true);
        });
    }
}

// ===== Switch between edit and preview =====
// Single entry point for every edit/preview transition.
//
// Previously switchToEdit and switchToPreview each called renderNotes(), a full
// innerHTML rebuild of the list. That destroyed the focused textarea, which
// fired blur, which queued another deferred render - so clicking note B while
// editing note A produced three renders (t=0, t=200, t=400). Now only the
// affected cards are swapped in place, and the pending blur is cancellable.
function setEditingNote(noteId, { focus = true } = {}) {
    cancelPendingBlur();

    const previous = Array.from(state.editingNoteIds);
    const next = noteId ? [noteId] : [];
    const changed = new Set([...previous, ...next]);

    state.editingNoteIds.clear();
    if (noteId) {
        state.editingNoteIds.add(noteId);
        state.activeNoteId = noteId;
    }

    changed.forEach(id => renderNoteContent(id));

    if (noteId && focus) {
        const editor = notesList.querySelector(`.note-editor[data-note-id="${cssEscape(noteId)}"]`);
        if (editor) {
            editor.focus({ preventScroll: true });
            editor.selectionStart = editor.selectionEnd = editor.value.length;
            autoResize(editor);
        }
    }
}

async function copyNoteMarkdown(noteId) {
    const folder = state.folders.find(f => f.id === state.currentFolderId);
    if (!folder) return false;
    const note = folder.notes.find(n => n.id === noteId);
    if (!note) return false;
    try {
        const result = await window.electronAPI.copyToClipboard(note.content);
        if (!result?.success) throw new Error(result?.error);
        return true;
    } catch (e) {
        showToast('Could not copy note to the clipboard.', 'error');
        return false;
    }
}

// Cmd+S / Ctrl+S: commit whatever is being edited and drop back to preview.
async function saveActiveNote() {
    const editing = Array.from(state.editingNoteIds);
    if (editing.length) setEditingNote(null);
    try {
        await flushMutations();
        showToast('Note saved.', 'success');
    } catch {
        showToast('Could not save the note.', 'error');
    }
}

function switchToEdit(noteId) {
    setEditingNote(noteId);
}

function switchToPreview(noteId) {
    if (!state.editingNoteIds.has(noteId)) return;
    setEditingNote(null);
}

function moveNote(noteId, delta) {
    const folder = state.folders.find(item => item.id === state.currentFolderId);
    if (!folder) return;
    const index = folder.notes.findIndex(note => note.id === noteId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= folder.notes.length) return;
    [folder.notes[index], folder.notes[target]] = [folder.notes[target], folder.notes[index]];
    state.newNoteId = null;
    queueMutation({ type: 'reorder-notes', folderId: folder.id, noteIds: folder.notes.map(note => note.id) });
    syncNoteCardOrder(folder);
    updateNoteCardVisual(noteId);
    setTimeout(() => notesList.querySelector(`.note-card[data-note-id="${CSS.escape(noteId)}"]`)?.focus({ preventScroll: true }), 0);
}

// ===== Attach Note Events =====
// Only one deferred blur can ever be outstanding. The old code called
// setTimeout without keeping the handle, so stale timers fired after the user
// had already moved on and kicked notes back out of edit mode.
let pendingBlurTimer = null;

function cancelPendingBlur() {
    if (pendingBlurTimer === null) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pendingBlurTimer);
    clearTimeout(pendingBlurTimer);
    pendingBlurTimer = null;
}

function attachNoteEvents() {
    attachNoteBodyEvents(notesList);

    notesList.querySelectorAll('.note-favourite-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const noteId = btn.dataset.noteId;
            const folder = state.folders.find(f => f.id === state.currentFolderId);
            if (!folder) return;
            const note = folder.notes.find(n => n.id === noteId);
            if (!note) return;
            normalizeNoteFlags(note);
            note.favourite = !note.favourite;
            queueMutation({ type: 'upsert-note', folderId: folder.id, note: { ...note } });
            scheduleNoteVisualUpdate(noteId);
            btn.focus({ preventScroll: true });
        });
    });

    notesList.querySelectorAll('.note-pin-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const noteId = btn.dataset.noteId;
            const folder = state.folders.find(f => f.id === state.currentFolderId);
            if (!folder) return;
            const note = folder.notes.find(n => n.id === noteId);
            if (!note) return;
            normalizeNoteFlags(note);
            note.pinned = !note.pinned;
            queueMutation({ type: 'upsert-note', folderId: folder.id, note: { ...note } });
            scheduleNoteVisualUpdate(noteId, true);
            btn.focus({ preventScroll: true });
        });
    });

    attachNoteChromeEvents();
}

// Everything inside .note-body / .note-footer, which get swapped on every
// mode change. Scoped to a root so a single card can be rebound in isolation.
function attachNoteBodyEvents(root) {
    // Attach checkbox handlers FIRST, directly on each checkbox
    root.querySelectorAll('.note-preview').forEach(preview => {
        const noteId = preview.dataset.noteId;

        // Direct handlers on each checkbox (capture phase)
        preview.querySelectorAll('input[type="checkbox"]').forEach((cb, index) => {
            cb.addEventListener('click', (e) => {
                e.stopPropagation();
                e.stopImmediatePropagation();
                e.preventDefault();
                toggleCheckbox(noteId, index, cb.checked);
            }, true); // capture phase
        });

        // Non-checkbox clicks → switch to edit mode
        preview.addEventListener('click', (e) => {
            // Skip if it was a checkbox click
            if (e.target.tagName === 'INPUT') return;
            switchToEdit(noteId);
        });
    });

    // Editor events
    root.querySelectorAll('.note-editor').forEach(editor => {
        const noteId = editor.dataset.noteId;

        editor.addEventListener('input', () => {
            const folder = state.folders.find(f => f.id === state.currentFolderId);
            if (!folder) return;
            const note = folder.notes.find(n => n.id === noteId);
            if (!note) return;
            note.content = editor.value;
            note.updatedAt = new Date().toISOString();

            const card = editor.closest('.note-card');
            const wcEl = card.querySelector('.note-word-count');
            const wc = wordCount(note.content);
            wcEl.textContent = `${wc} word${wc !== 1 ? 's' : ''}`;

            const tsEl = card.querySelector('.note-timestamp');
            tsEl.textContent = formatDate(note.updatedAt);

            queueMutation({ type: 'upsert-note', folderId: state.currentFolderId, note: { ...note } });
            autoResize(editor);
        });

        editor.addEventListener('focus', () => {
            state.activeNoteId = noteId;
        });

        // Blur → switch to preview, unless focus stayed inside this card (a
        // toolbar button) or moved into an open popover. One frame is enough
        // for focus to settle; setEditingNote cancels this if the user landed
        // on another note first.
        editor.addEventListener('blur', () => {
            cancelPendingBlur();
            const check = () => {
                pendingBlurTimer = null;
                const card = notesList.querySelector(`.note-card[data-note-id="${cssEscape(noteId)}"]`);
                if (!card || card.contains(document.activeElement)) return;
                if (document.querySelector('.format-dropdown:not(.hidden)')) return;
                if (document.querySelector('.settings-dropdown')) return;
                switchToPreview(noteId);
            };
            pendingBlurTimer = typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame(check)
                : setTimeout(check, 0);
        });

        editor.addEventListener('keydown', (e) => {
            handleEditorShortcut(e, editor);
        });

        autoResize(editor);
    });


    root.querySelectorAll('.btn-format-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const noteId = btn.dataset.noteId;
            state.activeNoteId = noteId;
            // If not editing, switch to edit first, then show dropdown
            if (!state.editingNoteIds.has(noteId)) {
                switchToEdit(noteId);
                setTimeout(() => {
                    const newBtn = notesList.querySelector(`.btn-format-toggle[data-note-id="${noteId}"]`);
                    if (newBtn) showFormatDropdown(newBtn);
                }, 100);
            } else {
                showFormatDropdown(btn);
            }
        });
    });

    root.querySelectorAll('.btn-upload').forEach(btn => {
        btn.addEventListener('click', () => handleUpload(btn.dataset.noteId));
    });

    root.querySelectorAll('.btn-note-settings').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showNoteSettings(btn, btn.dataset.noteId);
        });
    });

    root.querySelectorAll('.btn-download').forEach(btn => {
        btn.addEventListener('click', () => handleDownload(btn.dataset.noteId));
    });

    root.querySelectorAll('.btn-delete-note').forEach(btn => {
        btn.addEventListener('click', () => {
            showConfirm('Delete Note', 'Are you sure? This cannot be undone.', () => {
                deleteNote(btn.dataset.noteId);
            });
        });
    });

    // ===== Copy to Clipboard =====
    root.querySelectorAll('.btn-copy-clipboard').forEach(btn => {
        btn.addEventListener('click', async () => {
            const copied = await copyNoteMarkdown(btn.dataset.noteId);
            if (!copied) return;
            btn.classList.add('copied');
            const origTitle = btn.title;
            btn.title = 'Copied';
            setTimeout(() => { btn.classList.remove('copied'); btn.title = origTitle; }, 1500);
        });
    });

}

// Listeners bound to elements that live for the whole card lifetime, so they
// must NOT be re-bound when only the body/footer is swapped.
function attachNoteChromeEvents() {
    notesList.querySelectorAll('.note-card').forEach(card => {
        card.addEventListener('keydown', event => {
            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            moveNote(card.dataset.noteId, event.key === 'ArrowUp' ? -1 : 1);
        });
    });

    // ===== Note Drag-to-Reorder + Image Drag-and-Drop =====
    notesList.querySelectorAll('.note-card').forEach(card => {
        const noteId = card.dataset.noteId;
        const handle = card.querySelector('.note-drag-handle');

        // Enable card dragging only when user grabs the drag handle
        handle.addEventListener('mousedown', () => {
            card.setAttribute('draggable', 'true');
            const cleanup = () => {
                if (!dragSourceNoteId) card.removeAttribute('draggable');
            };
            document.addEventListener('mouseup', cleanup, { once: true });
        });

        card.addEventListener('dragstart', (e) => {
            dragSourceNoteId = noteId;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', noteId);
            requestAnimationFrame(() => card.classList.add('note-dragging'));
        });

        card.addEventListener('dragend', () => {
            card.removeAttribute('draggable');
            card.classList.remove('note-dragging');
            notesList.querySelectorAll('.note-card').forEach(c => {
                c.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-image-over');
            });
            dragSourceNoteId = null;
        });

        card.addEventListener('dragover', (e) => {
            if (dragSourceNoteId) {
                // Note reorder drag
                if (dragSourceNoteId === noteId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = card.getBoundingClientRect();
                notesList.querySelectorAll('.note-card').forEach(c => c.classList.remove('drag-over-top', 'drag-over-bottom'));
                card.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom');
            } else {
                // Image file from desktop
                const hasImage = Array.from(e.dataTransfer.items).some(item => item.kind === 'file' && item.type.startsWith('image/'));
                if (!hasImage) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                card.classList.add('drag-image-over');
            }
        });

        card.addEventListener('dragleave', (e) => {
            if (!card.contains(e.relatedTarget)) {
                card.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-image-over');
            }
        });

        card.addEventListener('drop', async (e) => {
            e.preventDefault();
            card.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-image-over');

            if (dragSourceNoteId && dragSourceNoteId !== noteId) {
                // Reorder: move source note to this position
                const folder = state.folders.find(f => f.id === state.currentFolderId);
                if (!folder) return;
                const srcNote = folder.notes.find(n => n.id === dragSourceNoteId);
                const tgtNote = folder.notes.find(n => n.id === noteId);
                if (!srcNote || !tgtNote) return;
                normalizeNoteFlags(srcNote);
                normalizeNoteFlags(tgtNote);
                if (srcNote.pinned !== tgtNote.pinned) return;
                const srcIdx = folder.notes.findIndex(n => n.id === dragSourceNoteId);
                const tgtIdx = folder.notes.findIndex(n => n.id === noteId);
                if (srcIdx === -1 || tgtIdx === -1) return;
                const rect = card.getBoundingClientRect();
                const insertAfter = e.clientY >= rect.top + rect.height / 2;
                const [removed] = folder.notes.splice(srcIdx, 1);
                const newTgt = folder.notes.findIndex(n => n.id === noteId);
                folder.notes.splice(insertAfter ? newTgt + 1 : newTgt, 0, removed);
                queueMutation({ type: 'reorder-notes', folderId: folder.id, noteIds: folder.notes.map(note => note.id) });
                state.newNoteId = null;
                syncNoteCardOrder(folder);
                setTimeout(() => notesList.querySelector(`.note-card[data-note-id="${CSS.escape(dragSourceNoteId || noteId)}"]`)?.focus({ preventScroll: true }), 0);
            } else if (!dragSourceNoteId) {
                // Image drop from desktop
                const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
                if (files.length === 0) return;
                if (!state.editingNoteIds.has(noteId)) {
                    switchToEdit(noteId);
                    await new Promise(r => setTimeout(r, 150));
                }
                const editor = document.querySelector(`.note-editor[data-note-id="${noteId}"]`);
                if (!editor) return;
                const pos = editor.selectionStart;
                const importedImages = [];
                for (const file of files.filter(f => f.path).slice(0, 5)) {
                    const imported = await window.electronAPI.importDroppedImage(file.path);
                    if (imported?.success) importedImages.push(`![${escapeMarkdownLabel(imported.name)}](${imported.assetUrl})`);
                    else showToast(imported?.error || 'Could not import image.', 'error');
                }
                const insertText = importedImages.join('\n') + (importedImages.length ? '\n' : '');
                if (!insertText.trim()) return;
                editor.value = editor.value.substring(0, pos) + insertText + editor.value.substring(pos);
                editor.dispatchEvent(new Event('input'));
                editor.focus();
            }
        });
    });
}

function openFavourites(fromTray = false) {
    if (state.currentView !== 'favourites') {
        favouritesReturnView = fromTray ? { view: 'folders', folderId: null } : { view: state.currentView, folderId: state.currentFolderId };
        favouritesReturnFocus = fromTray ? null : document.activeElement;
    }
    state.currentView = 'favourites';
    state.currentFolderId = null;
    renderFavourites();
}

function openTrash(fromTray = false) {
    if (state.currentView !== 'trash') {
        trashReturnView = fromTray ? { view: 'folders', folderId: null } : { view: state.currentView, folderId: state.currentFolderId };
        trashReturnFocus = fromTray ? null : document.activeElement;
    }
    state.currentView = 'trash';
    state.currentFolderId = null;
    flushMutations().catch(() => {}).finally(() => loadTrash().finally(renderTrash));
}

function renderFavourites() {
    topTitle.textContent = 'Favourites';
    btnBack.classList.remove('hidden');
    btnBack.title = 'Back';
    btnBack.setAttribute('aria-label', 'Back');
    folderListView.classList.add('hidden');
    notesView.classList.add('hidden');
    settingsView.classList.add('hidden');
    favouritesView.classList.remove('hidden');
    trashView.classList.add('hidden');
    jiraListView.classList.add('hidden');
    jiraDetailView.classList.add('hidden');
    btnJira.classList.remove('active');
    btnJira.setAttribute('aria-pressed', 'false');
    const matches = state.folders.flatMap(folder => folder.notes
        .filter(note => note.favourite === true)
        .map(note => ({ folder, note })))
        .filter(({ folder, note }) => !state.searchQuery || searchableText({ id: note.id, content: `${folder.name}\n${note.content}` }).includes(state.searchQuery));
    updateSearchCount(state.searchQuery ? matches.length : null);

    if (!matches.length) {
        favouritesList.innerHTML = state.searchQuery
            ? emptyStateHtml(ICON_EMPTY_SEARCH, 'No matching favourites', 'Try a different search term.')
            : emptyStateHtml(ICON_EMPTY_STAR, 'No favourites yet', 'Star a note and it will show up here.');
        return;
    }
    favouritesList.innerHTML = matches.map(({ folder, note }) => `
      <article class="note-card favourite favourite-result" data-folder-id="${escapeHtml(folder.id)}" data-note-id="${escapeHtml(note.id)}" tabindex="0" aria-label="Favourite note in ${escapeHtml(folder.name)}">
        <div class="favourite-source"><span class="badge">${escapeHtml(folder.name)}</span>${ICON_CHEVRON_RIGHT}</div>
        <div class="note-card-header"><span class="note-timestamp">${formatDate(note.updatedAt)}</span></div>
        <div class="note-preview"><div class="note-preview-content" style="font-size:${notePreviewFontSize(note)}px">${highlightInHtml(renderMarkdown(note.content), state.searchQuery)}</div></div>
      </article>`).join('');
    favouritesList.querySelectorAll('.favourite-result').forEach(card => {
        const open = () => { state.currentView = 'notes'; state.currentFolderId = card.dataset.folderId; state.activeNoteId = card.dataset.noteId; renderNotes(); };
        card.addEventListener('click', open);
        card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    });
}

async function restoreTrashEntry(trashId) {
    try {
        await flushMutations();
        const result = await window.electronAPI.restoreTrashItem(trashId);
        if (!result?.success) throw new Error(result?.error || 'Could not restore item.');
        state.folders = result.folders || state.folders;
        state.trash = result.trash || state.trash.filter(item => item.id !== trashId);
        lastDeletedTrashId = null;
        renderCurrentView();
        showToast('Item restored.', 'success');
    } catch { showToast('Could not restore that item.', 'error'); }
}

function renderTrash() {
    topTitle.textContent = 'Trash';
    btnBack.classList.remove('hidden');
    btnBack.title = 'Back to notes';
    btnBack.setAttribute('aria-label', 'Back to notes');
    folderListView.classList.add('hidden');
    notesView.classList.add('hidden');
    settingsView.classList.add('hidden');
    favouritesView.classList.add('hidden');
    trashView.classList.remove('hidden');
    jiraListView.classList.add('hidden');
    jiraDetailView.classList.add('hidden');
    btnJira.classList.remove('active');
    btnJira.setAttribute('aria-pressed', 'false');
    if (!state.trash.length) {
        trashList.innerHTML = emptyStateHtml(ICON_EMPTY_TRASH, 'Trash is empty', 'Deleted notes and folders rest here before they are gone for good.');
        return;
    }
    const items = state.trash.slice().reverse();
    trashList.innerHTML = `<div class="section-header">Deleted<span class="badge">${items.length}</span></div>` + items.map(item => {
        const label = item.type === 'folder' ? item.folder?.name || 'Folder' : item.note?.content?.split('\n')[0] || 'Note';
        return `<article class="trash-item" data-trash-id="${escapeHtml(item.id)}">
          <div class="trash-text">
            <div class="trash-label">${escapeHtml(label.slice(0, 100))}</div>
            <div class="trash-meta">${item.type === 'folder' ? 'Folder' : 'Note'} · deleted ${formatDate(item.deletedAt)}</div>
          </div>
          <div class="trash-actions">
            <button type="button" class="btn btn--sm trash-restore">Restore</button>
            <button type="button" class="btn btn--sm btn--ghost btn--danger trash-delete">Delete</button>
          </div>
        </article>`;
    }).join('');
    trashList.querySelectorAll('.trash-restore').forEach(button => button.addEventListener('click', () => restoreTrashEntry(button.closest('[data-trash-id]').dataset.trashId)));
    trashList.querySelectorAll('.trash-delete').forEach(button => button.addEventListener('click', () => {
        const id = button.closest('[data-trash-id]').dataset.trashId;
        showConfirm('Delete permanently', 'This item cannot be recovered. Continue?', async () => {
            try {
                const result = await window.electronAPI.permanentlyDeleteTrashItem(id);
                if (!result?.success) throw new Error();
                state.trash = result.trash || state.trash.filter(item => item.id !== id);
                renderTrash();
                showToast('Item permanently deleted.', 'success');
            } catch { showToast('Could not delete the Trash item.', 'error'); }
        });
    }));
}

// ===== Jira Cloud Space =====
function jiraUnwrap(result) {
    if (result?.success) return result.data;
    const error = new Error(result?.error?.message || 'Jira could not complete that request.');
    error.code = result?.error?.code || 'JIRA_ERROR';
    error.retryAfter = result?.error?.retryAfter || null;
    throw error;
}

function jiraErrorMessage(error) {
    if (error?.code === 'PERMISSION_DENIED') return 'Jira does not allow your account to perform that action.';
    if (error?.code === 'SESSION_EXPIRED') return 'Your Jira connection expired. Connect again.';
    if (error?.code === 'RATE_LIMITED') return `Jira is busy. Try again${error.retryAfter ? ` in ${error.retryAfter} seconds` : ' shortly'}.`;
    if (error?.code === 'CONFLICT') return 'This issue changed in Jira after you opened it. Refresh it before saving.';
    if (error?.code === 'REQUEST_IN_PROGRESS') return 'That Jira update is already being submitted.';
    if (error?.code === 'OFFLINE') return 'Jira is unavailable. Your local notes are still available.';
    return error?.message || 'Jira could not complete that request.';
}

function adfToPlainText(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    const own = typeof value.text === 'string' ? value.text : '';
    const child = Array.isArray(value.content) ? value.content.map(adfToPlainText).join('') : '';
    const suffix = ['paragraph', 'heading', 'listItem'].includes(value.type) ? '\n' : '';
    return `${own}${child}${suffix}`;
}

function jiraTextHtml(value, empty = 'Not provided') {
    const text = adfToPlainText(value).trim();
    return text ? escapeHtml(text).replace(/\n/g, '<br>') : `<span class="jira-empty-value">${escapeHtml(empty)}</span>`;
}

function compactJiraValue(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(compactJiraValue).filter(Boolean).join(', ');
    if (typeof value === 'object') {
        if (value.type === 'doc') return adfToPlainText(value).trim();
        return value.displayName || value.name || value.value || value.key || '';
    }
    return '';
}

function setJiraChrome(title = 'Jira', localBack = false) {
    topTitle.textContent = title;
    btnBack.classList.remove('hidden');
    btnBack.title = localBack ? 'Back to local notes' : 'Back to Jira work';
    btnBack.setAttribute('aria-label', localBack ? 'Back to local notes' : 'Back to Jira work');
    folderListView.classList.add('hidden');
    notesView.classList.add('hidden');
    settingsView.classList.add('hidden');
    favouritesView.classList.add('hidden');
    trashView.classList.add('hidden');
    btnJira.classList.add('active');
    btnJira.setAttribute('aria-pressed', 'true');
    searchInput.placeholder = 'Search sprint work';
}

function returnToLocalSpace() {
    const destination = state.jira.returnView || { view: 'folders', folderId: null };
    state.currentView = destination.view;
    state.currentFolderId = destination.folderId;
    state.jira.returnView = null;
    state.jira.detail = null;
    btnBack.title = 'Back';
    btnBack.setAttribute('aria-label', 'Back');
    clearActiveSearch();
    renderCurrentView();
}

function jiraLoadingHtml(message) {
    return `<div class="jira-state"><div class="jira-spinner" aria-hidden="true"></div><div class="jira-state-title">${escapeHtml(message)}</div></div>`;
}

function jiraFailureHtml(error, retryAction = 'reload') {
    return `<div class="jira-state jira-state--error">
      <div class="jira-state-icon" aria-hidden="true">!</div>
      <div class="jira-state-title">Could not load Jira</div>
      <p>${escapeHtml(jiraErrorMessage(error))}</p>
      <button type="button" class="btn btn--primary jira-retry" data-action="${retryAction}">Retry</button>
    </div>`;
}

async function openJiraSpace() {
    if (!state.currentView.startsWith('jira')) {
        state.jira.returnView = { view: state.currentView, folderId: state.currentFolderId };
        state.jira.assigneeFilter = null;
    }
    state.currentView = 'jira-list';
    clearActiveSearch();
    renderJiraList();
    await loadJiraSession();
}

btnJira.addEventListener('click', () => {
    if (state.currentView.startsWith('jira')) { returnToLocalSpace(); return; }
    openJiraSpace();
});

async function loadJiraSession() {
    state.jira.loading = true;
    state.jira.error = null;
    renderJiraList();
    try {
        state.jira.session = jiraUnwrap(await window.electronAPI.jiraStatus());
        if (state.jira.session.connected) await loadJiraWork();
        else { state.jira.loading = false; renderJiraList(); }
    } catch (error) {
        state.jira.loading = false;
        state.jira.error = error;
        renderJiraList();
    }
}

async function loadJiraWork(render = true) {
    state.jira.loading = true;
    if (render) state.jira.error = null;
    state.jira.workError = null;
    if (render) renderJiraList();
    try {
        state.jira.work = jiraUnwrap(await window.electronAPI.jiraCurrentSprint());
    } catch (error) {
        if (render) state.jira.error = error;
        else state.jira.workError = error;
    } finally {
        state.jira.loading = false;
        if (render && state.currentView === 'jira-list') renderJiraList();
    }
}

async function connectJiraWithToken(form) {
    const siteUrl = form.querySelector('[name="jira-site-url"]')?.value || '';
    const email = form.querySelector('[name="jira-email"]')?.value || '';
    const tokenInput = form.querySelector('[name="jira-api-token"]');
    const credentials = { siteUrl, email, apiToken: tokenInput?.value || '' };
    state.jira.loading = true;
    state.jira.error = null;
    renderJiraList();
    try {
        state.jira.session = jiraUnwrap(await window.electronAPI.jiraConnect(credentials));
        credentials.apiToken = '';
        if (tokenInput) tokenInput.value = '';
        state.jira.loading = false;
        await loadJiraWork();
        showToast('Jira connected on this Mac.', 'success');
    } catch (error) {
        credentials.apiToken = '';
        if (tokenInput) tokenInput.value = '';
        state.jira.loading = false;
        state.jira.error = error;
        state.jira.session = { configured: true, connected: false, connectionMode: 'api-token' };
        renderJiraList();
    }
}

function issueSearchText(issue) {
    return `${issue.key || ''} ${issue.summary || ''} ${issue.status?.name || ''} ${issue.issueType?.name || ''} ${issue.project?.name || ''} ${issue.assignee?.displayName || ''}`.toLowerCase();
}

function jiraMonitoredPeople() {
    const session = state.jira.session || {};
    const teammates = state.jira.work?.monitoredUsers || session.monitoredUsers || [];
    const people = [{ accountId: session.accountId || '', displayName: session.displayName || 'You', isSelf: true }, ...teammates];
    const seen = new Set();
    return people.filter(person => person.accountId && !seen.has(person.accountId) && seen.add(person.accountId));
}

function jiraAssigneeFilterHtml(people, issues) {
    if (people.length < 2) return '';
    const selected = state.jira.assigneeFilter;
    const selectedPeople = selected ? people.filter(person => selected.has(person.accountId)) : people;
    const label = !selected || selectedPeople.length === people.length
      ? 'Everyone monitored'
      : selectedPeople.length === 1 ? (selectedPeople[0].isSelf ? 'Me' : selectedPeople[0].displayName) : `${selectedPeople.length} people`;
    const counts = new Map();
    issues.forEach(issue => {
        const accountId = issue.assignee?.accountId || '';
        counts.set(accountId, (counts.get(accountId) || 0) + 1);
    });
    return `<div class="jira-people-filter-row"><span>Showing</span><details class="jira-people-filter">
      <summary><span>${escapeHtml(label)}</span><span class="jira-multiselect-chevron" aria-hidden="true">⌄</span></summary>
      <div class="jira-people-filter-menu">
        <button type="button" class="jira-people-filter-all ${!selected ? 'is-selected' : ''}">Everyone monitored<span>${issues.length}</span></button>
        ${people.map(person => `<label class="jira-people-filter-option"><input type="checkbox" value="${escapeHtmlAttribute(person.accountId)}" ${!selected || selected.has(person.accountId) ? 'checked' : ''}><span class="jira-person-avatar" aria-hidden="true">${escapeHtml(jiraInitials(person.displayName))}</span><span>${escapeHtml(person.isSelf ? `${person.displayName} (Me)` : person.displayName)}</span><small>${counts.get(person.accountId) || 0}</small></label>`).join('')}
      </div>
    </details></div>`;
}

function showJiraPeopleDialog() {
    const session = state.jira.session;
    if (!session?.connected) return;
    const previousFocus = document.activeElement;
    const selected = [...(session.monitoredUsers || [])];
    let results = [];
    let searchTimer = null;
    let searchVersion = 0;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay jira-people-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'jira-people-title');
    overlay.innerHTML = `<div class="confirm-dialog jira-people-dialog">
      <div class="confirm-title" id="jira-people-title">Monitored people</div>
      <div class="confirm-text">Fleet will show active-sprint work for you and up to 10 selected teammates.</div>
      <div class="jira-people-list" aria-live="polite"></div>
      <label class="jira-people-search-label" for="jira-people-search">Find a teammate</label>
      <input id="jira-people-search" class="field" type="search" autocomplete="off" placeholder="Search by name…">
      <div class="jira-people-search-status" aria-live="polite">Enter at least two characters. Jira permissions may require an exact full name.</div>
      <div class="jira-people-results"></div>
      <div class="confirm-actions"><button type="button" class="btn-confirm cancel">Cancel</button><button type="button" class="btn-confirm primary jira-people-save">Save people</button></div>
    </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#jira-people-search');
    const status = overlay.querySelector('.jira-people-search-status');
    const saveButton = overlay.querySelector('.jira-people-save');
    const close = () => { clearTimeout(searchTimer); overlay.remove(); previousFocus?.focus?.(); };
    const renderSelected = () => {
        const list = overlay.querySelector('.jira-people-list');
        list.innerHTML = `<div class="jira-person-row is-self"><span class="jira-person-avatar" aria-hidden="true">${escapeHtml(jiraInitials(session.displayName))}</span><span><strong>${escapeHtml(session.displayName || 'You')}</strong><small>Me · always included</small></span></div>
          ${selected.map(person => `<div class="jira-person-row" data-account-id="${escapeHtmlAttribute(person.accountId)}"><span class="jira-person-avatar" aria-hidden="true">${escapeHtml(jiraInitials(person.displayName))}</span><span><strong>${escapeHtml(person.displayName)}</strong><small>Monitored teammate</small></span><button type="button" class="btn-icon jira-person-remove" aria-label="Remove ${escapeHtmlAttribute(person.displayName)}">×</button></div>`).join('')}`;
        list.querySelectorAll('.jira-person-remove').forEach(button => button.addEventListener('click', () => {
            const accountId = button.closest('[data-account-id]').dataset.accountId;
            const index = selected.findIndex(person => person.accountId === accountId);
            if (index >= 0) results.push(...selected.splice(index, 1));
            renderSelected();
            renderResults();
        }));
        input.disabled = selected.length >= 10;
        input.placeholder = selected.length >= 10 ? '10-teammate limit reached' : 'Search by name…';
    };
    const renderResults = () => {
        const container = overlay.querySelector('.jira-people-results');
        const selectedIds = new Set(selected.map(person => person.accountId));
        const available = results.filter(person => !selectedIds.has(person.accountId));
        container.innerHTML = available.map(person => `<button type="button" class="jira-people-result" data-account-id="${escapeHtmlAttribute(person.accountId)}" ${selected.length >= 10 ? 'disabled' : ''}><span class="jira-person-avatar" aria-hidden="true">${escapeHtml(jiraInitials(person.displayName))}</span><span>${escapeHtml(person.displayName)}</span><small>Add</small></button>`).join('');
        container.querySelectorAll('.jira-people-result').forEach(button => button.addEventListener('click', () => {
            const person = available.find(item => item.accountId === button.dataset.accountId);
            if (!person || selected.length >= 10) return;
            selected.push(person);
            results = results.filter(item => item.accountId !== person.accountId);
            input.value = '';
            status.textContent = 'Teammate added. Search for another person or save.';
            renderSelected();
            renderResults();
        }));
    };
    input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        const query = input.value.trim();
        const version = ++searchVersion;
        results = [];
        renderResults();
        if (query.length < 2) { status.textContent = 'Enter at least two characters. Jira permissions may require an exact full name.'; return; }
        status.textContent = 'Searching Jira…';
        searchTimer = setTimeout(async () => {
            try {
                const response = jiraUnwrap(await window.electronAPI.jiraSearchUsers(query));
                if (version !== searchVersion) return;
                results = response.users || [];
                status.textContent = results.length ? `${results.length} teammate${results.length === 1 ? '' : 's'} found.` : 'No matches. Try the person’s exact full name; Jira may restrict user discovery.';
                renderResults();
            } catch (error) {
                if (version !== searchVersion) return;
                status.textContent = jiraErrorMessage(error);
            }
        }, 300);
    });
    overlay.querySelector('.cancel').addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
    saveButton.addEventListener('click', async () => {
        saveButton.disabled = true;
        saveButton.textContent = 'Saving…';
        try {
            const response = jiraUnwrap(await window.electronAPI.jiraSaveMonitoredUsers(selected.map(person => person.accountId)));
            state.jira.session = { ...state.jira.session, monitoredUsers: response.monitoredUsers || [] };
            state.jira.assigneeFilter = null;
            state.jira.work = null;
            close();
            await loadJiraWork();
            showToast('Monitored people updated.', 'success');
        } catch (error) {
            saveButton.disabled = false;
            saveButton.textContent = 'Save people';
            status.textContent = jiraErrorMessage(error);
        }
    });
    renderSelected();
    renderResults();
    input.focus();
}

function jiraIssueCardHtml(issue) {
    const sprint = issue.activeSprint?.name || 'Active sprint';
    return `<article class="jira-card" data-issue-key="${escapeHtml(issue.key)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(issue.key)} ${escapeHtml(issue.summary)}">
      <div class="jira-card-topline">
        <span class="jira-key">${escapeHtml(issue.key)}</span>
        <span class="jira-type">${escapeHtml(issue.issueType?.name || 'Work item')}</span>
        <span class="jira-status jira-status--${escapeHtml(issue.status?.category || 'new')}">${escapeHtml(issue.status?.name || 'Unknown')}</span>
      </div>
      <div class="jira-summary">${state.searchQuery ? highlightInHtml(escapeHtml(issue.summary), state.searchQuery) : escapeHtml(issue.summary)}</div>
      ${issue.parent ? `<div class="jira-parent-context">Parent: ${escapeHtml(issue.parent.key)} · ${escapeHtml(issue.parent.summary || 'Parent work item')}</div>` : ''}
      <div class="jira-card-meta">
        <span>${escapeHtml(sprint)}</span>
        ${issue.assignee?.displayName ? `<span class="jira-card-assignee"><span class="jira-person-avatar" aria-hidden="true">${escapeHtml(jiraInitials(issue.assignee.displayName))}</span>${escapeHtml(issue.assignee.displayName)}</span>` : '<span>Unassigned</span>'}
        ${issue.priority?.name ? `<span>${escapeHtml(issue.priority.name)}</span>` : ''}
        ${issue.storyPoints !== null && issue.storyPoints !== undefined ? `<span>${escapeHtml(String(issue.storyPoints))} pts</span>` : ''}
        ${issue.estimate?.remaining ? `<span>${escapeHtml(issue.estimate.remaining)} left</span>` : ''}
      </div>
      ${issue.subtasks?.length ? `<div class="jira-subtask-count">${issue.subtasks.length} subtask${issue.subtasks.length === 1 ? '' : 's'}</div>` : ''}
    </article>`;
}

function renderJiraList() {
    setJiraChrome('Jira', true);
    jiraListView.classList.remove('hidden');
    jiraDetailView.classList.add('hidden');
    const session = state.jira.session;
    if (state.jira.loading) {
        jiraContent.innerHTML = jiraLoadingHtml('Loading Jira…');
        return;
    }
    if ((state.jira.error || state.jira.workError) && session?.connected) {
        jiraContent.innerHTML = jiraFailureHtml(state.jira.error || state.jira.workError);
        jiraContent.querySelector('.jira-retry')?.addEventListener('click', state.jira.session?.connected ? () => loadJiraWork() : loadJiraSession);
        return;
    }
    if (!session?.configured) {
        jiraContent.innerHTML = `<div class="jira-state"><div class="jira-logo-large">J</div><div class="jira-state-title">Secure storage is unavailable</div><p>Fleet cannot safely store a Jira API token on this device.</p></div>`;
        return;
    }
    if (!session.connected) {
        jiraContent.innerHTML = `<div class="jira-state">
          <div class="jira-logo-large">J</div><div class="jira-state-title">Connect Jira Cloud</div>
          <p>Connect directly from this Mac. No Fleet server is required.</p>
          <form class="jira-token-form">
            <label><span>Jira site URL</span><input class="field" name="jira-site-url" type="url" required autocomplete="url" placeholder="https://company.atlassian.net"></label>
            <label><span>Atlassian email</span><input class="field" name="jira-email" type="email" required autocomplete="username" placeholder="you@company.com"></label>
            <label><span>API token</span><input class="field" name="jira-api-token" type="password" required autocomplete="off" spellcheck="false" placeholder="Paste your Atlassian API token"></label>
            ${state.jira.error ? `<div class="jira-connect-error" role="alert">${escapeHtml(jiraErrorMessage(state.jira.error))}</div>` : ''}
            <button type="submit" class="btn btn--primary jira-connect">Connect Jira</button>
            <button type="button" class="btn btn--sm btn--ghost jira-create-token">Create an API token</button>
          </form>
          <p class="jira-privacy">Use an API token—not your Jira password. The encrypted credential stays in this Mac's secure application storage and is excluded from Fleet notes and backups.</p>
        </div>`;
        jiraContent.querySelector('.jira-token-form')?.addEventListener('submit', event => {
            event.preventDefault();
            connectJiraWithToken(event.currentTarget);
        });
        jiraContent.querySelector('.jira-create-token')?.addEventListener('click', async () => {
            try { jiraUnwrap(await window.electronAPI.jiraOpenTokenPage()); }
            catch (error) { showToast(jiraErrorMessage(error), 'error'); }
        });
        return;
    }
    const work = state.jira.work || { groups: [], total: 0 };
    const people = jiraMonitoredPeople();
    const allIssues = (work.groups || []).flatMap(group => group.issues || []);
    const assigneeFilter = state.jira.assigneeFilter;
    const groups = (work.groups || []).map(group => ({
        ...group, issues: (group.issues || []).filter(issue => (!assigneeFilter || assigneeFilter.has(issue.assignee?.accountId || ''))
          && (!state.searchQuery || issueSearchText(issue).includes(state.searchQuery)))
    })).filter(group => group.issues.length);
    const count = groups.reduce((sum, group) => sum + group.issues.length, 0);
    updateSearchCount(state.searchQuery ? count : null);
    const siteOptions = (session.sites || []).map(site => `<option value="${escapeHtml(site.id)}" ${site.id === session.activeSite?.id ? 'selected' : ''}>${escapeHtml(site.name)}</option>`).join('');
    jiraContent.innerHTML = `<div class="jira-account-bar">
      <div class="jira-account"><strong>${escapeHtml(session.activeSite?.name || 'Jira')}</strong><span>${escapeHtml(session.displayName || '')}</span></div>
      ${session.sites?.length > 1 ? `<label class="sr-only" for="jira-site-select">Jira site</label><select id="jira-site-select" class="jira-select">${siteOptions}</select>` : ''}
      <button type="button" class="btn btn--sm jira-people-button">People${session.monitoredUsers?.length ? `<span class="badge">${session.monitoredUsers.length}</span>` : ''}</button>
      <button type="button" class="btn-icon jira-refresh" title="Refresh Jira" aria-label="Refresh Jira">↻</button>
      <button type="button" class="btn btn--sm btn--ghost jira-disconnect">Disconnect</button>
    </div>
    ${jiraAssigneeFilterHtml(people, allIssues)}
    ${work.mappingRequired ? '<div class="jira-notice">Story points or acceptance criteria could not be mapped automatically. Open an issue to configure them.</div>' : ''}
    ${groups.length ? groups.map(group => `<section class="jira-group">
      <div class="jira-group-heading"><div><strong>${escapeHtml(group.sprint?.name || 'Active sprint')}</strong><span>${escapeHtml(group.project?.name || group.project?.key || '')}</span></div><span class="badge">${group.issues.length}</span></div>
      <div class="jira-card-list">${group.issues.map(jiraIssueCardHtml).join('')}</div>
    </section>`).join('') : emptyStateHtml(ICON_EMPTY_SEARCH, state.searchQuery || assigneeFilter ? 'No matching Jira work' : 'No active-sprint work', state.searchQuery ? 'Try a different search term.' : assigneeFilter ? 'No active-sprint work matches the selected people.' : people.length > 1 ? 'No visible active-sprint work was found for the monitored people.' : 'No work assigned to you was found in an active sprint.')}`;
    jiraContent.querySelector('.jira-people-button')?.addEventListener('click', showJiraPeopleDialog);
    jiraContent.querySelector('.jira-refresh')?.addEventListener('click', () => loadJiraWork());
    jiraContent.querySelector('.jira-people-filter-all')?.addEventListener('click', () => {
        state.jira.assigneeFilter = null;
        renderJiraList();
    });
    jiraContent.querySelectorAll('.jira-people-filter-option input').forEach(input => input.addEventListener('change', () => {
        const checked = Array.from(jiraContent.querySelectorAll('.jira-people-filter-option input:checked')).map(item => item.value);
        if (!checked.length) { input.checked = true; showToast('Keep at least one person selected.', 'info'); return; }
        state.jira.assigneeFilter = checked.length === people.length ? null : new Set(checked);
        renderJiraList();
    }));
    jiraContent.querySelector('#jira-site-select')?.addEventListener('change', async event => {
        try {
            state.jira.loading = true; renderJiraList();
            state.jira.session = { configured: true, ...jiraUnwrap(await window.electronAPI.jiraSelectSite(event.target.value)) };
            state.jira.work = null;
            state.jira.assigneeFilter = null;
            await loadJiraWork();
        } catch (error) { state.jira.loading = false; state.jira.error = error; renderJiraList(); }
    });
    jiraContent.querySelector('.jira-disconnect')?.addEventListener('click', () => showConfirm('Disconnect Jira', 'Fleet will remove this device connection. Your local notes are not affected.', async () => {
        try {
            jiraUnwrap(await window.electronAPI.jiraDisconnect());
            state.jira.session = { configured: true, connected: false };
            state.jira.work = null;
            state.jira.detail = null;
            state.jira.assigneeFilter = null;
            renderJiraList();
        } catch (error) { showToast(jiraErrorMessage(error), 'error'); }
    }));
    jiraContent.querySelectorAll('.jira-card').forEach(card => {
        const open = () => openJiraIssue(card.dataset.issueKey);
        card.addEventListener('click', open);
        card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    });
}

async function openJiraIssue(issueKey) {
    state.currentView = 'jira-detail';
    state.jira.detail = null;
    state.jira.loading = true;
    state.jira.error = null;
    clearActiveSearch();
    renderJiraDetail();
    try {
        state.jira.detail = jiraUnwrap(await window.electronAPI.jiraIssue(issueKey));
    } catch (error) {
        state.jira.error = error;
    } finally {
        state.jira.loading = false;
        renderJiraDetail();
    }
}

function jiraAllowedValueLabel(value) {
    return compactJiraValue(value) || String(value?.id || 'Option');
}

function jiraAllowedValueKey(value) {
    return String(value?.id || value?.value || value?.name || value || '');
}

function jiraSelectedOptionsText(options) {
    if (!options.length) return 'Select options';
    const labels = options.map(jiraAllowedValueLabel);
    return labels.length > 2 ? `${labels.slice(0, 2).join(', ')} +${labels.length - 2}` : labels.join(', ');
}

function jiraInitials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || '?';
}

function jiraFieldIsSupported(field) {
    const type = field.schema?.type || 'string';
    const operations = Array.isArray(field.operations) ? field.operations : [];
    if (operations.length && !operations.includes('set')) return false;
    return field.id === 'timetracking' || (Array.isArray(field.allowedValues) && field.allowedValues.length > 0)
      || ['number', 'date', 'datetime', 'string'].includes(type)
      || (type === 'array' && (!field.schema?.items || field.schema.items === 'string'))
      || field.id === 'description' || /textarea/.test(field.schema?.custom || '');
}

function jiraEditableFieldHtml(field, prefix = 'jira-edit') {
    const id = escapeHtmlAttribute(field.id);
    const controlId = `${prefix}-${String(field.id).replace(/[^A-Za-z0-9_-]/g, '-')}`;
    const type = field.schema?.type || 'string';
    const custom = field.schema?.custom || '';
    const value = field.value;
    const plain = compactJiraValue(value);
    const allowed = Array.isArray(field.allowedValues) ? field.allowedValues : [];
    const common = `data-jira-field="${id}" data-jira-type="${escapeHtmlAttribute(type)}" data-jira-custom="${escapeHtmlAttribute(custom)}"`;
    let control = '';
    if (!jiraFieldIsSupported(field)) {
        control = `<div class="jira-readonly-field" data-unsupported-field="${id}">${escapeHtml(plain || 'This field cannot be updated from Fleet')}</div>`;
    } else if (field.id === 'timetracking') {
        const timeOriginal = { originalEstimate: value?.originalEstimate || '', remainingEstimate: value?.remainingEstimate || '' };
        control = `<div class="jira-time-fields" ${common} data-original="${escapeHtmlAttribute(JSON.stringify(timeOriginal))}">
          <input class="field" data-time="originalEstimate" value="${escapeHtmlAttribute(value?.originalEstimate || '')}" placeholder="Original, e.g. 2d">
          <input class="field" data-time="remainingEstimate" value="${escapeHtmlAttribute(value?.remainingEstimate || '')}" placeholder="Remaining, e.g. 4h">
        </div>`;
    } else if (allowed.length) {
        const multiple = type === 'array';
        const current = new Set((multiple ? (Array.isArray(value) ? value : []) : [value]).map(jiraAllowedValueKey));
        if (multiple) {
            const selected = allowed.filter(option => current.has(jiraAllowedValueKey(option)));
            control = `<details class="jira-field-control jira-multiselect" ${common} data-original-keys="${escapeHtmlAttribute(JSON.stringify(Array.from(current).sort()))}">
              <summary id="${controlId}"><span class="jira-multiselect-value ${selected.length ? '' : 'is-placeholder'}">${escapeHtml(jiraSelectedOptionsText(selected))}</span><span class="jira-multiselect-chevron" aria-hidden="true">⌄</span></summary>
              <div class="jira-multiselect-menu" role="group" aria-labelledby="${controlId}">
                ${allowed.map((option, index) => {
                    const key = jiraAllowedValueKey(option);
                    return `<label class="jira-multiselect-option"><input type="checkbox" value="${index}" ${current.has(key) ? 'checked' : ''}><span>${escapeHtml(jiraAllowedValueLabel(option))}</span></label>`;
                }).join('')}
              </div>
            </details>`;
        } else {
            control = `<select id="${controlId}" class="jira-field-control jira-select" ${common} data-original-keys="${escapeHtmlAttribute(JSON.stringify(Array.from(current).sort()))}">
              ${!current.size ? `<option value="" selected>${field.required ? 'Choose an option…' : 'None'}</option>` : (!field.required ? '<option value="">None</option>' : '')}
              ${allowed.map((option, index) => `<option value="${index}" ${current.has(jiraAllowedValueKey(option)) ? 'selected' : ''}>${escapeHtml(jiraAllowedValueLabel(option))}</option>`).join('')}
            </select>`;
        }
    } else if (type === 'number') {
        control = `<input id="${controlId}" class="field jira-field-control" type="number" step="any" ${common} value="${escapeHtmlAttribute(value ?? '')}" data-original="${escapeHtmlAttribute(JSON.stringify(value ?? null))}">`;
    } else if (type === 'date' || type === 'datetime') {
        const displayValue = type === 'datetime' && value ? new Date(value).toISOString().slice(0, 16) : (value || '');
        control = `<input id="${controlId}" class="field jira-field-control" type="${type === 'date' ? 'date' : 'datetime-local'}" ${common} value="${escapeHtmlAttribute(displayValue)}" data-original="${escapeHtmlAttribute(JSON.stringify(displayValue))}">`;
    } else if (type === 'array' && (!field.schema?.items || field.schema.items === 'string')) {
        control = `<input id="${controlId}" class="field jira-field-control" ${common} value="${escapeHtmlAttribute(plain)}" data-original="${escapeHtmlAttribute(JSON.stringify(value ?? []))}" placeholder="Comma-separated values">`;
    } else if (type === 'string' || field.id === 'description' || /textarea/.test(custom)) {
        const multiline = field.id === 'description' || /textarea/.test(custom) || plain.length > 100;
        control = multiline
          ? `<textarea id="${controlId}" class="field jira-field-control jira-field-textarea" ${common} data-original="${escapeHtmlAttribute(JSON.stringify(adfToPlainText(value).trim()))}">${escapeHtml(adfToPlainText(value).trim())}</textarea>`
          : `<input id="${controlId}" class="field jira-field-control" ${common} value="${escapeHtmlAttribute(plain)}" data-original="${escapeHtmlAttribute(JSON.stringify(value ?? ''))}">`;
    }
    const labelFor = field.id === 'timetracking' || control.includes('jira-multiselect') || control.includes('jira-readonly-field') ? '' : ` for="${controlId}"`;
    return `<div class="jira-edit-field"><label class="jira-edit-label"${labelFor}>${escapeHtml(field.name)}${field.required ? ' *' : ''}</label>${control}</div>`;
}

function jiraStatusClass(category) {
    return ['done', 'indeterminate', 'new'].includes(category) ? category : 'new';
}

function jiraTransitionIsCompletion(transition) {
    const destination = `${transition?.to?.category || ''} ${transition?.to?.name || ''} ${transition?.name || ''}`;
    return transition?.to?.category === 'done' || /\b(done|close|closed|resolve|resolved|complete|completed)\b/i.test(destination);
}

function jiraStatusControlHtml(detail) {
    const transitions = detail.transitions || [];
    const currentClass = jiraStatusClass(detail.status?.category || 'new');
    const current = escapeHtml(detail.status?.name || 'Unknown');
    const statusContents = `<span class="jira-status-button-dot jira-status-button-dot--${currentClass}" aria-hidden="true"></span><span>${current}</span>`;
    if (!transitions.length) return `<span class="jira-status-button is-static">${statusContents}</span>`;
    const pending = state.jira.pendingTransitionId;
    return `<details class="jira-status-control" ${pending ? 'aria-busy="true"' : ''}>
      <summary class="jira-status-button" ${pending ? 'aria-disabled="true" tabindex="-1"' : ''}>
        ${pending ? '<span class="jira-button-spinner" aria-hidden="true"></span><span>Updating…</span>' : `${statusContents}<span class="jira-status-chevron" aria-hidden="true"></span>`}
      </summary>
      ${pending ? '' : `<div class="jira-status-menu" role="menu" aria-label="Allowed status changes">
        ${transitions.map(transition => `<button type="button" class="jira-transition-option" role="menuitem" data-transition-id="${escapeHtmlAttribute(transition.id)}"><span>${escapeHtml(transition.name)}</span><span class="jira-transition-arrow" aria-hidden="true">→</span><span class="jira-status jira-status--${jiraStatusClass(transition.to?.category || 'new')}">${escapeHtml(transition.to?.name || 'Next status')}</span></button>`).join('')}
      </div>`}
    </details>`;
}

function renderJiraDetail() {
    const detail = state.jira.detail;
    setJiraChrome(detail?.key || 'Jira issue');
    jiraListView.classList.add('hidden');
    jiraDetailView.classList.remove('hidden');
    if (state.jira.loading) { jiraDetail.innerHTML = jiraLoadingHtml('Loading Jira issue…'); return; }
    if (state.jira.error) {
        jiraDetail.innerHTML = jiraFailureHtml(state.jira.error, 'issue');
        jiraDetail.querySelector('.jira-retry')?.addEventListener('click', () => openJiraIssue(detail?.key || ''));
        return;
    }
    if (!detail) { jiraDetail.innerHTML = jiraFailureHtml(new Error('The Jira issue is unavailable.')); return; }
    const editable = (detail.editableFields || []).filter(field => !['status', 'project', 'issuetype'].includes(field.id));
    const allFields = (detail.allFields || []).filter(field => !['summary', 'description', 'status', 'subtasks', 'comment'].includes(field.id)).slice(0, 120);
    jiraDetail.innerHTML = `<article class="jira-issue-detail">
      <div class="jira-detail-heading">
        <div class="jira-detail-heading-main"><div class="jira-card-topline"><span class="jira-key">${escapeHtml(detail.key)}</span><span class="jira-type">${escapeHtml(detail.issueType?.name || '')}</span></div>
        <h2>${escapeHtml(detail.summary)}</h2></div>
        <div class="jira-detail-heading-actions">${jiraStatusControlHtml(detail)}<button type="button" class="btn btn--sm jira-open-external">Open in Jira</button></div>
      </div>
      <div class="jira-meta-grid">
        <div><span>Project</span><strong>${escapeHtml(detail.project?.name || '—')}</strong></div>
        <div><span>Sprint</span><strong>${escapeHtml(detail.activeSprint?.name || '—')}</strong></div>
        <div><span>Priority</span><strong>${escapeHtml(detail.priority?.name || '—')}</strong></div>
        <div><span>Story points</span><strong>${escapeHtml(detail.storyPoints ?? '—')}</strong></div>
        <div><span>Remaining</span><strong>${escapeHtml(detail.estimate?.remaining || '—')}</strong></div>
        <div><span>Assignee</span><strong>${escapeHtml(detail.assignee?.displayName || 'Unassigned')}</strong></div>
        <div><span>Updated</span><strong>${escapeHtml(formatDate(detail.updated))}</strong></div>
      </div>
      <section class="jira-detail-section"><h3>Description</h3><div class="jira-rich-text">${jiraTextHtml(detail.description)}</div></section>
      <section class="jira-detail-section"><h3>Acceptance criteria</h3><div class="jira-rich-text">${jiraTextHtml(detail.acceptanceCriteria, 'No acceptance criteria field is mapped.')}</div></section>
      ${detail.subtasks?.length ? `<section class="jira-detail-section"><h3>Subtasks</h3><div class="jira-subtasks">${detail.subtasks.map(subtask => `<button type="button" class="jira-subtask" data-issue-key="${escapeHtml(subtask.key)}"><span>${escapeHtml(subtask.key)} · ${escapeHtml(subtask.summary)}</span><small>${escapeHtml(subtask.status || '')}${subtask.assignee?.displayName ? ` · ${escapeHtml(subtask.assignee.displayName)}` : ''}</small></button>`).join('')}</div></section>` : ''}
      ${editable.length ? `<details class="jira-detail-section jira-edit-section" open><summary>Edit issue</summary><div class="jira-edit-fields">${editable.map(jiraEditableFieldHtml).join('')}</div><button type="button" class="btn btn--primary jira-save-issue" disabled>Save changes</button></details>` : '<div class="jira-notice">You do not have permission to edit fields on this issue.</div>'}
      <section class="jira-detail-section jira-comments-section"><div class="jira-section-heading"><h3>Comments</h3><span class="badge">${detail.comments?.length || 0}</span></div>
        <div class="jira-comments">${(detail.comments || []).map(comment => {
            const author = comment.author?.displayName || 'Unknown';
            return `<article class="jira-comment" data-comment-id="${escapeHtml(comment.id)}"><div class="jira-comment-avatar" aria-hidden="true">${escapeHtml(jiraInitials(author))}</div><div class="jira-comment-content"><div class="jira-comment-head"><strong>${escapeHtml(author)}</strong><span>${escapeHtml(formatDate(comment.created))}</span></div><div class="jira-comment-body">${jiraTextHtml(comment.body)}</div>${comment.author?.accountId === state.jira.session?.accountId ? '<div class="jira-comment-actions"><button class="btn btn--sm btn--ghost jira-edit-comment">Edit</button><button class="btn btn--sm btn--ghost btn--danger jira-delete-comment">Delete</button></div>' : ''}</div></article>`;
        }).join('') || '<p class="jira-empty-value jira-no-comments">No comments yet.</p>'}</div>
        <div class="jira-comment-composer" aria-busy="${state.jira.pendingCommentIssueKey === detail.key ? 'true' : 'false'}"><label for="jira-comment-input">Add a comment</label><textarea id="jira-comment-input" class="field jira-comment-input" placeholder="Write a comment…" ${state.jira.pendingCommentIssueKey === detail.key ? 'disabled' : ''}></textarea><div class="jira-comment-composer-footer"><span>Posted to Jira as you</span><button type="button" class="btn btn--primary jira-add-comment-btn" ${state.jira.pendingCommentIssueKey === detail.key ? 'disabled' : ''}>${state.jira.pendingCommentIssueKey === detail.key ? '<span class="jira-button-spinner" aria-hidden="true"></span>Posting…' : 'Comment'}</button></div></div>
      </section>
      ${(detail.attachments || []).length ? `<section class="jira-detail-section"><h3>Attachments</h3>${detail.attachments.map(item => `<div class="jira-attachment"><span>${escapeHtml(item.filename)}</span><small>${Math.round((item.size || 0) / 1024)} KB</small></div>`).join('')}</section>` : ''}
      <details class="jira-detail-section jira-all-fields"><summary>All fields</summary>${allFields.map(field => `<div class="jira-all-field"><span>${escapeHtml(field.name)}</span><div>${escapeHtml(compactJiraValue(field.value).slice(0, 1000) || '—')}</div></div>`).join('')}</details>
      <details class="jira-detail-section jira-field-mapping"><summary>Custom field mapping</summary><p>Choose this Jira site's fields for consistent story metadata.</p>
        <label>Story points<select class="jira-select" data-map="storyPoints"><option value="">Not mapped</option>${(detail.fields || []).filter(field => /point|estimate/i.test(field.name)).map(field => `<option value="${escapeHtml(field.id)}" ${detail.fieldMapping?.storyPoints === field.id ? 'selected' : ''}>${escapeHtml(field.name)}</option>`).join('')}</select></label>
        <label>Acceptance criteria<select class="jira-select" data-map="acceptanceCriteria"><option value="">Not mapped</option>${(detail.fields || []).filter(field => /accept|criteria|definition of done/i.test(field.name)).map(field => `<option value="${escapeHtml(field.id)}" ${detail.fieldMapping?.acceptanceCriteria === field.id ? 'selected' : ''}>${escapeHtml(field.name)}</option>`).join('')}</select></label>
        <button type="button" class="btn btn--sm jira-save-mapping">Save mapping</button>
      </details>
    </article>`;
    attachJiraDetailEvents();
}

function readJiraFields(root, metadataFields, includeUnchanged = false, onlyDirty = false) {
    const updates = {};
    root.querySelectorAll('[data-jira-field]').forEach(control => {
        if (control.closest('.jira-time-fields')) return;
        const id = control.dataset.jiraField;
        const metadata = metadataFields.find(field => field.id === id);
        if (!metadata || control.classList.contains('jira-readonly-field')) return;
        if (onlyDirty && control.dataset.jiraDirty !== 'true') return;
        let value;
        let changed;
        if (control.classList.contains('jira-multiselect')) {
            const selected = Array.from(control.querySelectorAll('input[type="checkbox"]:checked')).map(input => metadata.allowedValues[Number(input.value)]);
            value = selected;
            let originalKeys = [];
            try { originalKeys = JSON.parse(control.dataset.originalKeys || '[]'); } catch {}
            const selectedKeys = selected.map(jiraAllowedValueKey).sort();
            changed = JSON.stringify(selectedKeys) !== JSON.stringify(originalKeys);
        } else if (control.tagName === 'SELECT') {
            const selectedOptions = Array.from(control.selectedOptions).filter(option => option.value !== '');
            const selected = selectedOptions.map(option => metadata.allowedValues[Number(option.value)]);
            value = control.multiple ? selected : (selected[0] ?? null);
            let originalKeys = [];
            try { originalKeys = JSON.parse(control.dataset.originalKeys || '[]'); } catch {}
            const selectedKeys = selected.map(jiraAllowedValueKey).sort();
            changed = JSON.stringify(selectedKeys) !== JSON.stringify(originalKeys);
        } else if (control.dataset.jiraType === 'number') {
            value = control.value === '' ? null : Number(control.value);
        } else if (control.dataset.jiraType === 'array') {
            value = control.value.split(',').map(item => item.trim()).filter(Boolean);
        } else if (control.dataset.jiraType === 'datetime') {
            value = control.value ? new Date(control.value).toISOString() : null;
        } else {
            value = control.value;
        }
        let original;
        try { original = JSON.parse(control.dataset.original || 'null'); } catch { original = null; }
        const comparisonValue = control.dataset.jiraType === 'datetime' && value ? String(value).slice(0, 16) : value;
        if (includeUnchanged || (changed ?? JSON.stringify(comparisonValue) !== JSON.stringify(original))) updates[id] = value;
    });
    root.querySelectorAll('.jira-time-fields[data-jira-field]').forEach(container => {
        if (onlyDirty && container.dataset.jiraDirty !== 'true') return;
        const value = Object.fromEntries(Array.from(container.querySelectorAll('[data-time]')).map(input => [input.dataset.time, input.value]));
        let original;
        try { original = JSON.parse(container.dataset.original || '{}'); } catch { original = {}; }
        if (includeUnchanged || JSON.stringify(value) !== JSON.stringify(original)) updates[container.dataset.jiraField] = value;
    });
    return updates;
}

function readJiraEditFields() {
    return readJiraFields(jiraDetail, state.jira.detail?.editableFields || [], false, true);
}

function syncJiraSaveButton() {
    const button = jiraDetail.querySelector('.jira-save-issue');
    if (button) button.disabled = Object.keys(readJiraEditFields()).length === 0;
}

async function applyJiraDetailMutation(button, operation, successMessage) {
    button.disabled = true;
    try {
        state.jira.detail = jiraUnwrap(await operation());
        await loadJiraWork(false);
        renderJiraDetail();
        showToast(successMessage, 'success');
    } catch (error) {
        button.disabled = false;
        showToast(jiraErrorMessage(error), 'error');
    }
}

function bindJiraMultiselects(root, metadataFields) {
    root.querySelectorAll('.jira-multiselect').forEach(control => {
        control.addEventListener('toggle', () => {
            if (!control.open) return;
            root.querySelectorAll('.jira-multiselect[open]').forEach(other => { if (other !== control) other.open = false; });
        });
        control.querySelectorAll('input[type="checkbox"]').forEach(input => input.addEventListener('change', () => {
            const metadata = metadataFields.find(field => field.id === control.dataset.jiraField);
            const selected = Array.from(control.querySelectorAll('input[type="checkbox"]:checked'))
                .map(item => metadata?.allowedValues?.[Number(item.value)]).filter(Boolean);
            const value = control.querySelector('.jira-multiselect-value');
            value.textContent = jiraSelectedOptionsText(selected);
            value.classList.toggle('is-placeholder', !selected.length);
        }));
    });
}

function jiraValueIsEmpty(value) {
    if (value === null || value === undefined || value === '') return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.values(value).every(jiraValueIsEmpty);
    return false;
}

async function submitJiraTransition(transition, fields = {}, comment) {
    if (state.jira.pendingTransitionId) return false;
    const detail = state.jira.detail;
    state.jira.pendingTransitionId = transition.id;
    renderJiraDetail();
    try {
        state.jira.detail = jiraUnwrap(await window.electronAPI.jiraTransition({
            issueKey: detail.key,
            transitionId: transition.id,
            fields,
            ...(comment !== undefined ? { comment } : {}),
            expectedUpdated: detail.updated
        }));
        await loadJiraWork(false);
        state.jira.pendingTransitionId = null;
        renderJiraDetail();
        showToast(`Status changed to ${transition.to?.name || transition.name}.`, 'success');
        return true;
    } catch (error) {
        state.jira.pendingTransitionId = null;
        renderJiraDetail();
        showToast(jiraErrorMessage(error), 'error');
        return false;
    }
}

function openJiraTransitionForm(transition) {
    const previousFocus = document.activeElement;
    const fields = transition.fields || [];
    const commentField = fields.find(field => field.id === 'comment');
    const regularFields = fields.filter(field => field.id !== 'comment');
    const unsupportedRequired = regularFields.filter(field => field.required && !jiraFieldIsSupported(field));
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay jira-transition-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'jira-transition-dialog-title');
    overlay.innerHTML = `<form class="confirm-dialog jira-transition-dialog">
      <div class="jira-transition-dialog-heading">
        <div><div class="confirm-title" id="jira-transition-dialog-title">${escapeHtml(transition.name)}</div><div class="confirm-text">Review Jira's transition fields before changing this issue.</div></div>
        <div class="jira-transition-route"><span class="jira-status jira-status--${jiraStatusClass(state.jira.detail?.status?.category || 'new')}">${escapeHtml(state.jira.detail?.status?.name || 'Current')}</span><span aria-hidden="true">→</span><span class="jira-status jira-status--${jiraStatusClass(transition.to?.category || 'new')}">${escapeHtml(transition.to?.name || 'Next status')}</span></div>
      </div>
      <div class="jira-transition-fields">
        ${regularFields.length ? regularFields.map(field => jiraEditableFieldHtml(field, 'jira-transition')).join('') : '<p class="jira-empty-value">No additional Jira fields are required.</p>'}
        ${commentField ? `<div class="jira-edit-field"><label class="jira-edit-label" for="jira-transition-comment">${escapeHtml(commentField.name || 'Comment')}${commentField.required ? ' *' : ''}</label><textarea id="jira-transition-comment" class="field jira-field-textarea" placeholder="Add context for this status change…">${escapeHtml(adfToPlainText(commentField.value).trim())}</textarea></div>` : ''}
        ${unsupportedRequired.length ? `<div class="jira-notice jira-transition-blocker">${escapeHtml(unsupportedRequired.map(field => field.name).join(', '))} ${unsupportedRequired.length === 1 ? 'is' : 'are'} required but cannot be edited in Fleet. Complete this transition in Jira.</div>` : ''}
        <div class="jira-transition-validation" role="alert" aria-live="polite"></div>
      </div>
      <div class="confirm-actions jira-transition-actions">
        ${unsupportedRequired.length ? '<button type="button" class="btn-confirm jira-transition-open">Open in Jira</button>' : ''}
        <button type="button" class="btn-confirm cancel">Cancel</button>
        <button type="submit" class="btn-confirm primary jira-transition-submit" ${unsupportedRequired.length ? 'disabled' : ''}>${escapeHtml(transition.name)}</button>
      </div>
    </form>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector('form');
    const cancel = () => { overlay.remove(); previousFocus?.focus?.(); };
    overlay.querySelector('.cancel').addEventListener('click', cancel);
    overlay.querySelector('.jira-transition-open')?.addEventListener('click', async () => {
        try { jiraUnwrap(await window.electronAPI.jiraOpenIssue(state.jira.detail.key)); }
        catch (error) { showToast(jiraErrorMessage(error), 'error'); }
    });
    overlay.addEventListener('click', event => { if (event.target === overlay && !state.jira.pendingTransitionId) cancel(); });
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape' && !state.jira.pendingTransitionId) { event.preventDefault(); cancel(); } });
    bindJiraMultiselects(overlay, regularFields);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (state.jira.pendingTransitionId || unsupportedRequired.length) return;
        const values = readJiraFields(overlay, regularFields.filter(jiraFieldIsSupported), true);
        const comment = commentField ? overlay.querySelector('#jira-transition-comment').value : undefined;
        const missing = regularFields.filter(field => field.required && jiraFieldIsSupported(field) && jiraValueIsEmpty(values[field.id]));
        if (commentField?.required && !comment.trim()) missing.push(commentField);
        const validation = overlay.querySelector('.jira-transition-validation');
        if (missing.length) {
            validation.textContent = `${missing.map(field => field.name).join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.`;
            const first = Array.from(overlay.querySelectorAll('[data-jira-field]')).find(control => control.dataset.jiraField === missing[0].id)
              || overlay.querySelector('#jira-transition-comment');
            first?.focus?.();
            return;
        }
        validation.textContent = '';
        const button = overlay.querySelector('.jira-transition-submit');
        button.disabled = true;
        button.innerHTML = '<span class="jira-button-spinner" aria-hidden="true"></span>Updating…';
        form.setAttribute('aria-busy', 'true');
        const succeeded = await submitJiraTransition(transition, values, comment);
        if (succeeded) overlay.remove();
        else {
            button.disabled = false;
            button.textContent = transition.name;
            form.setAttribute('aria-busy', 'false');
        }
    });
    overlay.querySelector('.cancel').focus();
}

async function continueJiraTransition(transition) {
    if (jiraTransitionIsCompletion(transition) || (transition.fields || []).length || transition.hasScreen) openJiraTransitionForm(transition);
    else await submitJiraTransition(transition);
}

function chooseJiraTransition(transitionId) {
    const transition = state.jira.detail?.transitions?.find(item => item.id === transitionId);
    if (!transition || state.jira.pendingTransitionId) return;
    const unsaved = readJiraEditFields();
    if (!Object.keys(unsaved).length) { continueJiraTransition(transition); return; }
    showConfirm('Save issue changes first?', 'Fleet will save your unsaved Jira fields, refresh the allowed statuses, and then continue.', async () => {
        const originalId = transition.id;
        const detail = state.jira.detail;
        state.jira.detail = jiraUnwrap(await window.electronAPI.jiraUpdateIssue(detail.key, unsaved, detail.updated));
        await loadJiraWork(false);
        renderJiraDetail();
        const refreshed = state.jira.detail.transitions?.find(item => item.id === originalId);
        if (!refreshed) {
            showToast('Jira’s allowed status changes changed after saving. Choose a status again.', 'info');
            return;
        }
        await continueJiraTransition(refreshed);
    }, { confirmText: 'Save and continue', destructive: false });
}

async function submitJiraComment() {
    const detail = state.jira.detail;
    const input = jiraDetail.querySelector('.jira-comment-input');
    const button = jiraDetail.querySelector('.jira-add-comment-btn');
    const composer = jiraDetail.querySelector('.jira-comment-composer');
    const draft = input?.value || '';
    if (!draft.trim()) { input?.focus(); return; }
    if (state.jira.pendingCommentIssueKey === detail.key) return;
    state.jira.pendingCommentIssueKey = detail.key;
    composer?.setAttribute('aria-busy', 'true');
    input.disabled = true;
    button.disabled = true;
    button.innerHTML = '<span class="jira-button-spinner" aria-hidden="true"></span>Posting…';
    try {
        state.jira.detail = jiraUnwrap(await window.electronAPI.jiraAddComment(detail.key, draft));
        await loadJiraWork(false);
        state.jira.pendingCommentIssueKey = null;
        renderJiraDetail();
        showToast('Comment added.', 'success');
    } catch (error) {
        state.jira.pendingCommentIssueKey = null;
        composer?.setAttribute('aria-busy', 'false');
        input.disabled = false;
        input.value = draft;
        button.disabled = false;
        button.textContent = 'Comment';
        input.focus();
        showToast(jiraErrorMessage(error), 'error');
    }
}

function attachJiraDetailEvents() {
    const detail = state.jira.detail;
    jiraDetail.querySelector('.jira-open-external')?.addEventListener('click', async () => {
        try { jiraUnwrap(await window.electronAPI.jiraOpenIssue(detail.key)); }
        catch (error) { showToast(jiraErrorMessage(error), 'error'); }
    });
    bindJiraMultiselects(jiraDetail, detail.editableFields || []);
    const editSection = jiraDetail.querySelector('.jira-edit-section');
    const markJiraFieldDirty = event => {
        const control = event.target.closest('[data-jira-field]');
        if (!control || control.classList.contains('jira-readonly-field')) return;
        control.dataset.jiraDirty = 'true';
        syncJiraSaveButton();
    };
    editSection?.addEventListener('input', markJiraFieldDirty);
    editSection?.addEventListener('change', markJiraFieldDirty);
    jiraDetail.querySelector('.jira-status-control')?.addEventListener('toggle', event => {
        if (state.jira.pendingTransitionId && event.currentTarget.open) event.currentTarget.open = false;
    });
    jiraDetail.querySelectorAll('.jira-transition-option').forEach(button => button.addEventListener('click', () => chooseJiraTransition(button.dataset.transitionId)));
    jiraDetail.querySelectorAll('.jira-subtask').forEach(button => button.addEventListener('click', () => openJiraIssue(button.dataset.issueKey)));
    jiraDetail.querySelector('.jira-save-issue')?.addEventListener('click', event => {
        const fields = readJiraEditFields();
        if (!Object.keys(fields).length) { showToast('No Jira fields changed.', 'info'); return; }
        applyJiraDetailMutation(event.currentTarget, () => window.electronAPI.jiraUpdateIssue(detail.key, fields, detail.updated), 'Jira issue updated.');
    });
    jiraDetail.querySelector('.jira-add-comment-btn')?.addEventListener('click', submitJiraComment);
    jiraDetail.querySelector('.jira-comment-input')?.addEventListener('input', event => autoResize(event.currentTarget));
    jiraDetail.querySelectorAll('.jira-delete-comment').forEach(button => button.addEventListener('click', () => {
        const commentId = button.closest('.jira-comment').dataset.commentId;
        showConfirm('Delete Jira comment', 'This deletes the comment in Jira and cannot be undone here.', () => applyJiraDetailMutation(button, () => window.electronAPI.jiraDeleteComment(detail.key, commentId), 'Comment deleted.'));
    }));
    jiraDetail.querySelectorAll('.jira-edit-comment').forEach(button => button.addEventListener('click', () => {
        const comment = button.closest('.jira-comment');
        const commentId = comment.dataset.commentId;
        const current = detail.comments.find(item => item.id === commentId);
        comment.querySelector('.jira-comment-body').innerHTML = `<div class="jira-comment-edit"><textarea class="field jira-field-textarea">${escapeHtml(adfToPlainText(current?.body).trim())}</textarea><div class="jira-comment-edit-footer"><button type="button" class="btn btn--sm btn--primary jira-save-comment">Save comment</button></div></div>`;
        comment.querySelector('.jira-comment-actions').classList.add('hidden');
        comment.querySelector('.jira-save-comment').addEventListener('click', event => {
            const text = comment.querySelector('textarea').value;
            applyJiraDetailMutation(event.currentTarget, () => window.electronAPI.jiraUpdateComment(detail.key, commentId, text), 'Comment updated.');
        });
    }));
    jiraDetail.querySelector('.jira-save-mapping')?.addEventListener('click', async event => {
        const mapping = Object.fromEntries(Array.from(jiraDetail.querySelectorAll('[data-map]')).map(select => [select.dataset.map, select.value]).filter(([, value]) => value));
        event.currentTarget.disabled = true;
        try {
            jiraUnwrap(await window.electronAPI.jiraSaveFieldMapping(detail.key, mapping));
            await loadJiraWork(false);
            await openJiraIssue(detail.key);
            showToast('Jira field mapping saved.', 'success');
        } catch (error) { event.currentTarget.disabled = false; showToast(jiraErrorMessage(error), 'error'); }
    });
}

function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
}

// ===== Context Menu (Folders) =====
let contextMenuTarget = null;

function showContextMenu(event, folderId) {
    contextMenuTarget = folderId;
    contextMenu.classList.remove('hidden');
    positionPopover(contextMenu, event.currentTarget || event.target);
}

function hideContextMenu() {
    contextMenu.classList.add('hidden');
    contextMenuTarget = null;
}

contextMenu.querySelectorAll('.context-item').forEach(item => {
    item.addEventListener('click', () => {
        const action = item.dataset.action;
        const targetId = contextMenuTarget; // capture before hideContextMenu nulls it
        hideContextMenu();
        if (action === 'rename') {
            const folderEl = folderList.querySelector(`[data-id="${targetId}"]`);
            if (folderEl) startRenameFolder(targetId, folderEl);
        } else if (action === 'delete') {
            showConfirm('Delete Folder', 'All notes inside will be deleted. Continue?', () => {
                deleteFolder(targetId);
            });
        }
    });
});

document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) hideContextMenu();
    if (!formatDropdown.contains(e.target) && !e.target.closest('.btn-format-toggle')) hideFormatDropdown();
    const sd = document.querySelector('.settings-dropdown');
    if (sd && !sd.contains(e.target) && !e.target.closest('.btn-note-settings')) sd.remove();
    if (!overflowMenu.contains(e.target) && !e.target.closest('#btn-overflow')) hideOverflowMenu();
    if (!e.target.closest('.jira-multiselect')) document.querySelectorAll('.jira-multiselect[open]').forEach(control => { control.open = false; });
    if (!e.target.closest('.jira-status-control')) document.querySelectorAll('.jira-status-control[open]').forEach(control => { control.open = false; });
    if (!e.target.closest('.jira-people-filter')) document.querySelectorAll('.jira-people-filter[open]').forEach(control => { control.open = false; });
});

// ===== Rename Folder =====
function startRenameFolder(folderId, folderEl) {
    const nameEl = folderEl.querySelector('.folder-name');
    const folder = state.folders.find(f => f.id === folderId);
    if (!folder) return;

    const input = document.createElement('input');
    input.className = 'folder-name-input';
    input.value = folder.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const finishRename = () => {
        const newName = input.value.trim() || 'Untitled';
        folder.name = newName;
        queueMutation({ type: 'upsert-folder', folder: { ...folder, notes: folder.notes.map(note => ({ ...note })) } });
        renderFolders();
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = folder.name; input.blur(); }
    });
}

// ===== Delete =====
function deleteFolder(folderId) {
    const folder = state.folders.find(item => item.id === folderId);
    const index = state.folders.findIndex(item => item.id === folderId);
    if (!folder || index < 0) return;
    state.folders = state.folders.filter(f => f.id !== folderId);
    const trashId = generateId();
    lastDeletedTrashId = trashId;
    state.trash.push({ id: trashId, type: 'folder', deletedAt: new Date().toISOString(), folderId, index, folder: { ...folder, notes: folder.notes.map(note => ({ ...note })) } });
    queueMutation({ type: 'trash-folder', folderId, trashId });
    renderFolders();
    showToast('Folder moved to Trash.', 'success', () => restoreTrashEntry(trashId));
}

function deleteNote(noteId) {
    const folder = state.folders.find(f => f.id === state.currentFolderId);
    if (!folder) return;
    const index = folder.notes.findIndex(note => note.id === noteId);
    const note = folder.notes[index];
    if (!note || index < 0) return;
    folder.notes = folder.notes.filter(n => n.id !== noteId);
    const trashId = generateId();
    lastDeletedTrashId = trashId;
    state.trash.push({ id: trashId, type: 'note', deletedAt: new Date().toISOString(), folderId: folder.id, noteId, index, note: { ...note } });
    queueMutation({ type: 'trash-note', folderId: folder.id, noteId, trashId });
    renderNotes();
    showToast('Note moved to Trash.', 'success', () => restoreTrashEntry(trashId));
}

// ===== Confirm Dialog =====
function showConfirm(title, text, onConfirm, options = {}) {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const titleId = `confirm-title-${Date.now()}`;
    const textId = `confirm-text-${Date.now()}`;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', titleId);
    overlay.setAttribute('aria-describedby', textId);
    overlay.innerHTML = `
    <div class="confirm-dialog">
      <div id="${titleId}" class="confirm-title">${escapeHtml(title)}</div>
      <div id="${textId}" class="confirm-text">${escapeHtml(text)}</div>
      <div class="confirm-actions">
        <button class="btn-confirm cancel">Cancel</button>
        <button class="btn-confirm ${options.destructive === false ? 'primary' : 'danger'}">${escapeHtml(options.confirmText || 'Delete')}</button>
      </div>
    </div>
  `;
    document.body.appendChild(overlay);

    const cancel = () => { overlay.remove(); if (previousFocus?.focus) previousFocus.focus(); };
    overlay.querySelector('.cancel').addEventListener('click', cancel);
    const confirmButton = overlay.querySelector(options.destructive === false ? '.primary' : '.danger');
    confirmButton.addEventListener('click', async () => {
        confirmButton.disabled = true;
        overlay.querySelector('.cancel').disabled = true;
        try { await onConfirm(); cancel(); }
        catch (error) {
            confirmButton.disabled = false;
            overlay.querySelector('.cancel').disabled = false;
            showToast(error?.code ? jiraErrorMessage(error) : (error?.message || 'That action could not be completed.'), 'error');
        }
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
        if (e.key !== 'Tab') return;
        const focusable = Array.from(overlay.querySelectorAll('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    overlay.querySelector('.cancel').focus();
}

// ===== Format Dropdown =====
function showFormatDropdown(anchorBtn) {
    formatDropdown.classList.remove('hidden');
    positionPopover(formatDropdown, anchorBtn);
}

function hideFormatDropdown() {
    formatDropdown.classList.add('hidden');
}

formatDropdown.querySelectorAll('.format-item').forEach(item => {
    item.addEventListener('click', () => {
        applyFormat(item.dataset.format);
        hideFormatDropdown();
    });
});

// ===== Apply Markdown Format =====
function applyFormat(format) {
    // Make sure we're in edit mode first
    if (!state.editingNoteIds.has(state.activeNoteId)) {
        switchToEdit(state.activeNoteId);
    }
    const editor = document.querySelector(`.note-editor[data-note-id="${state.activeNoteId}"]`);
    if (!editor) return;

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const selected = editor.value.substring(start, end);
    let replacement = '';
    let cursorOffset = 0;

    switch (format) {
        case 'bold':
            replacement = `**${selected || 'bold text'}**`;
            cursorOffset = selected ? replacement.length : 2;
            break;
        case 'italic':
            replacement = `*${selected || 'italic text'}*`;
            cursorOffset = selected ? replacement.length : 1;
            break;
        case 'strike':
            replacement = `~~${selected || 'strikethrough'}~~`;
            cursorOffset = selected ? replacement.length : 2;
            break;
        case 'highlight':
            replacement = `==${selected || 'highlighted text'}==`;
            cursorOffset = selected ? replacement.length : 2;
            break;
        case 'code':
            if (selected.includes('\n')) {
                replacement = '```\n' + (selected || 'code') + '\n```';
            } else {
                replacement = '`' + (selected || 'code') + '`';
            }
            cursorOffset = selected ? replacement.length : 1;
            break;
        case 'header':
            replacement = `## ${selected || 'Heading'}`;
            cursorOffset = replacement.length;
            break;
        case 'quote':
            replacement = selected ? selected.split('\n').map(l => `> ${l}`).join('\n') : '> quote';
            cursorOffset = replacement.length;
            break;
        case 'link':
            replacement = `[${selected || 'link text'}](url)`;
            cursorOffset = selected ? replacement.length - 4 : 1;
            break;
        case 'picture':
            replacement = `![${selected || 'alt text'}](image-url)`;
            cursorOffset = selected ? replacement.length : 1;
            break;
        case 'list':
            replacement = selected ? selected.split('\n').map(l => `- ${l}`).join('\n') : '- item';
            cursorOffset = replacement.length;
            break;
        case 'ordered_list':
            replacement = selected ? selected.split('\n').map((l, i) => `${i + 1}. ${l}`).join('\n') : '1. item';
            cursorOffset = replacement.length;
            break;
        case 'todo':
            replacement = selected ? selected.split('\n').map(l => `- [ ] ${l}`).join('\n') : '- [ ] task';
            cursorOffset = replacement.length;
            break;
    }

    editor.value = editor.value.substring(0, start) + replacement + editor.value.substring(end);
    editor.dispatchEvent(new Event('input'));
    const newPos = start + cursorOffset;
    editor.setSelectionRange(newPos, newPos);
    editor.focus();
}

// ===== Keyboard Shortcuts =====
function handleEditorShortcut(e, editor) {
    const meta = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;

    if (meta && !shift && e.key === 'b') { e.preventDefault(); e.stopPropagation(); applyFormat('bold'); }
    else if (meta && !shift && e.key === 'i') { e.preventDefault(); e.stopPropagation(); applyFormat('italic'); }
    else if (meta && !shift && e.key === 'k') { e.preventDefault(); e.stopPropagation(); applyFormat('link'); }
    else if (meta && !shift && e.key === 'e') { e.preventDefault(); e.stopPropagation(); applyFormat('code'); }
    else if (meta && shift && (e.key === 'T' || e.key === 't')) { e.preventDefault(); e.stopPropagation(); applyFormat('todo'); }
    else if (meta && shift && (e.key === 'I' || e.key === 'i')) { e.preventDefault(); e.stopPropagation(); applyFormat('picture'); }
    else if (meta && shift && (e.key === 'H' || e.key === 'h')) { e.preventDefault(); e.stopPropagation(); applyFormat('header'); }
    else if (meta && shift && (e.key === "'" || e.key === '"')) { e.preventDefault(); e.stopPropagation(); applyFormat('quote'); }
    else if (meta && shift && (e.key === 'M' || e.key === 'm')) { e.preventDefault(); e.stopPropagation(); applyFormat('highlight'); }
    else if (meta && shift && (e.key === 'X' || e.key === 'x')) { e.preventDefault(); e.stopPropagation(); applyFormat('strike'); }
    else if (meta && shift && (e.key === 'L' || e.key === 'l')) { e.preventDefault(); e.stopPropagation(); applyFormat('list'); }
    else if (meta && shift && (e.key === 'O' || e.key === 'o')) { e.preventDefault(); e.stopPropagation(); applyFormat('ordered_list'); }
}

// Global shortcuts
document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 'n' && state.currentView === 'notes') { e.preventDefault(); addNote(); }
    if (meta && !e.shiftKey && e.key.toLowerCase() === 's') {
        // Reaches us even from inside a textarea: handleEditorShortcut only
        // stops propagation for the formatting keys it claims.
        e.preventDefault();
        saveActiveNote();
    }
    if (meta && e.key === 'f') {
        e.preventDefault();
        if (!searchVisible) { searchVisible = true; searchBar.classList.remove('hidden'); }
        searchInput.focus();
    }
    if (meta && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.target.closest('textarea, input, [contenteditable="true"]') && lastDeletedTrashId) {
        e.preventDefault();
        restoreTrashEntry(lastDeletedTrashId);
    }
    if (e.key === 'Escape') {
        hideContextMenu();
        hideFormatDropdown();
        hideOverflowMenu();
        document.querySelector('.settings-dropdown')?.remove();
        if (searchVisible) {
            searchVisible = false;
            searchBar.classList.add('hidden');
            searchInput.value = '';
            state.searchQuery = '';
            btnSearchClear.classList.add('hidden');
            updateSearchCount(null);
            renderCurrentView();
        }
    }
});

// ===== Upload =====
async function handleUpload(noteId) {
    let result;
    try { result = await window.electronAPI.pickAndImportImage(); } catch { showToast('Could not open the image picker.', 'error'); return; }
    if (result.canceled) return;
    if (!result.success) { showToast(result.error || 'Could not import image.', 'error'); return; }
    // Switch to edit mode if needed
    if (!state.editingNoteIds.has(noteId)) {
        switchToEdit(noteId);
        await new Promise(r => setTimeout(r, 100));
    }
    const editor = document.querySelector(`.note-editor[data-note-id="${noteId}"]`);
    if (!editor) return;
    const pos = editor.selectionStart;
    const insertion = `![${escapeMarkdownLabel(result.name)}](${result.assetUrl})\n`;
    editor.value = editor.value.substring(0, pos) + insertion + editor.value.substring(pos);
    editor.dispatchEvent(new Event('input'));
}

// ===== Download =====
async function handleDownload(noteId) {
    const folder = state.folders.find(f => f.id === state.currentFolderId);
    if (!folder) return;
    const note = folder.notes.find(n => n.id === noteId);
    if (!note) return;
    const defaultName = note.content.split('\n')[0]?.replace(/[#*[\]]/g, '').trim().substring(0, 40) || 'note';
    try {
        const result = await window.electronAPI.exportMarkdown({ defaultName, content: note.content });
        if (result?.success) showToast('Markdown exported successfully.', 'success');
        else if (!result?.canceled) showToast(result?.error || 'Could not export Markdown.', 'error');
    } catch { showToast('Could not export Markdown.', 'error'); }
}

function escapeMarkdownLabel(value) {
    return String(value || 'image').replace(/[\\[\]`]/g, '\\$&');
}

// ===== Note Settings =====
function showNoteSettings(anchorBtn, noteId) {
    document.querySelector('.settings-dropdown')?.remove();

    const folder = state.folders.find(f => f.id === state.currentFolderId);
    if (!folder) return;
    const note = folder.notes.find(n => n.id === noteId);
    if (!note) return;

    const dropdown = document.createElement('div');
    dropdown.className = 'popover settings-dropdown';
    dropdown.setAttribute('role', 'menu');

    dropdown.innerHTML = `
    <div class="popover-label">Font size</div>
    <div class="stepper">
      <button type="button" class="btn-font-dec" aria-label="Decrease font size">&#8722;</button>
      <span class="font-size-val">${notePreviewFontSize(note)}</span>
      <button type="button" class="btn-font-inc" aria-label="Increase font size">+</button>
    </div>
    <div class="popover-divider"></div>
    <button type="button" class="popover-item" data-act="copy" role="menuitem">${ICON_COPY}<span>Copy Markdown</span></button>
    <button type="button" class="popover-item" data-act="export" role="menuitem">${ICON_DOWNLOAD}<span>Export .md</span></button>
    <div class="popover-divider"></div>
    <button type="button" class="popover-item popover-item--danger" data-act="delete" role="menuitem">${ICON_TRASH}<span>Delete note</span></button>
  `;

    document.body.appendChild(dropdown);
    positionPopover(dropdown, anchorBtn);

    const fontVal = dropdown.querySelector('.font-size-val');
    const applyFontSize = (delta) => {
        note.fontSize = Math.max(10, Math.min(24, notePreviewFontSize(note) + delta));
        fontVal.textContent = note.fontSize;
        const editor = notesList.querySelector(`.note-editor[data-note-id="${cssEscape(noteId)}"]`);
        if (editor) editor.style.fontSize = note.fontSize + 'px';
        const previewContent = notesList.querySelector(`.note-preview[data-note-id="${cssEscape(noteId)}"] .note-preview-content`);
        if (previewContent) previewContent.style.fontSize = note.fontSize + 'px';
        queueMutation({ type: 'upsert-note', folderId: folder.id, note: { ...note } });
    };

    dropdown.querySelector('.btn-font-dec').addEventListener('click', (e) => { e.stopPropagation(); applyFontSize(-1); });
    dropdown.querySelector('.btn-font-inc').addEventListener('click', (e) => { e.stopPropagation(); applyFontSize(1); });

    dropdown.querySelectorAll('.popover-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const act = item.dataset.act;
            dropdown.remove();
            if (act === 'copy') copyNoteMarkdown(noteId);
            else if (act === 'export') handleDownload(noteId);
            else if (act === 'delete') showConfirm('Delete note', 'This note moves to Trash. You can restore it from there.', () => deleteNote(noteId));
        });
    });
}

// Shared popover placement: flip above the anchor when there is no room below,
// and never let the panel spill outside the window.
function positionPopover(popover, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    let left = rect.right - width;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
}

// ===== Settings View =====
const DEFAULT_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+Space';
let isRecordingShortcut = false;

function acceleratorToDisplay(accel) {
    if (!accel) return '';
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    // Spelled out rather than using the Mac glyph symbols, to match the
    // shortcut labels in the formatting menu.
    return accel
        .replace(/CommandOrControl/g, isMac ? 'Cmd' : 'Ctrl')
        .replace(/Command/g, 'Cmd')
        .replace(/Control/g, 'Ctrl')
        .replace(/\+/g, ' + ');
}

async function showSettings() {
    previousView = { view: state.currentView, folderId: state.currentFolderId };
    state.currentView = 'settings';

    topTitle.textContent = 'Settings';
    btnBack.classList.remove('hidden');
    folderListView.classList.add('hidden');
    notesView.classList.add('hidden');
    settingsView.classList.remove('hidden');
    favouritesView.classList.add('hidden');
    trashView.classList.add('hidden');
    jiraListView.classList.add('hidden');
    jiraDetailView.classList.add('hidden');
    btnJira.classList.remove('active');
    btnJira.setAttribute('aria-pressed', 'false');

    const shortcut = await window.electronAPI.getToggleShortcut();
    const currentShortcut = shortcut?.accelerator || DEFAULT_TOGGLE_SHORTCUT;
    shortcutDisplay.textContent = shortcut?.enabled === false ? 'Disabled' : acceleratorToDisplay(currentShortcut);
    shortcutDisplay.dataset.accelerator = currentShortcut;
    shortcutError.classList.add('hidden');
    stopRecording();
    const prefs = await window.electronAPI.getUpdatePreferences().catch(() => ({ enabled: false }));
    updatesEnabled.checked = prefs.enabled === true;
    syncFontSizeControls();
    applyDockAppearance();
}

// Font stepper output plus the live preview line beneath it.
function syncFontSizeControls() {
    const size = Math.max(10, Math.min(24, Number(state.settings.defaultFontSize) || 13));
    defaultFontSizeValue.textContent = `${size} px`;
    if (fontPreview) fontPreview.style.fontSize = `${size}px`;
}

async function exportBackup() {
    try {
        const result = await window.electronAPI.exportBackup();
        if (result?.success) showToast('Backup exported successfully.', 'success');
        else if (!result?.canceled) showToast(result?.error || 'Could not export backup.', 'error');
    } catch { showToast('Could not export backup.', 'error'); }
}

async function restoreBackup() {
    showConfirm('Restore backup', 'Current notes will be replaced by the selected backup. Continue?', async () => {
        try {
            const result = await window.electronAPI.restoreBackup();
            if (!result?.success) {
                if (!result?.canceled) showToast(result?.error || 'Could not restore backup.', 'error');
                return;
            }
            state.folders = result.folders || [];
            state.settings = { ...state.settings, ...(result.settings || {}) };
            storageState = result.storage || { state: 'ok', message: '', canWrite: true };
            updateStorageStatus(storageState);
            await loadTrash();
            renderCurrentView();
            showToast('Backup restored.', 'success');
        } catch { showToast('Could not restore backup.', 'error'); }
    });
}

async function exportDiagnostics() {
    try {
        const result = await window.electronAPI.exportDiagnostics();
        if (result?.success) showToast('Diagnostics exported.', 'success');
        else if (!result?.canceled) showToast(result?.error || 'Could not export diagnostics.', 'error');
    } catch { showToast('Could not export diagnostics.', 'error'); }
}

function updateUpdateStatus(status) {
    if (!updateStatus || !status) return;
    const labels = {
        checking: 'Checking for updates…', current: 'Fleet is up to date.',
        available: `Update ${status.version || ''} is available.`,
        downloaded: `Update ${status.version || ''} is ready in the release page.`,
        error: 'Could not check for updates.', downloading: `Downloading update (${status.percent || 0}%)…`
    };
    updateStatus.textContent = labels[status.state] || '';
    if (status.state === 'available' || status.state === 'downloaded') showToast('A new Fleet version is available.', 'info');
}

btnDefaultFontDec.addEventListener('click', async () => {
    state.settings.defaultFontSize = Math.max(10, (Number(state.settings.defaultFontSize) || 13) - 1);
    syncFontSizeControls();
    try { await window.electronAPI.setDefaultFontSize(state.settings.defaultFontSize); } catch { showToast('Could not save font-size setting.', 'error'); }
});
btnDefaultFontInc.addEventListener('click', async () => {
    state.settings.defaultFontSize = Math.min(24, (Number(state.settings.defaultFontSize) || 13) + 1);
    syncFontSizeControls();
    try { await window.electronAPI.setDefaultFontSize(state.settings.defaultFontSize); } catch { showToast('Could not save font-size setting.', 'error'); }
});
btnExportBackup.addEventListener('click', exportBackup);
btnRestoreBackup.addEventListener('click', restoreBackup);
btnExportDiagnostics.addEventListener('click', exportDiagnostics);
updatesEnabled.addEventListener('change', async () => {
    try {
        const result = await window.electronAPI.setUpdatePreferences({ enabled: updatesEnabled.checked });
        if (!result?.success) throw new Error();
        showToast(updatesEnabled.checked ? 'Update checks enabled.' : 'Update checks disabled.', 'success');
    } catch {
        updatesEnabled.checked = !updatesEnabled.checked;
        showToast('Could not save update preference.', 'error');
    }
});
btnCheckUpdates.addEventListener('click', async () => {
    try {
        const result = await window.electronAPI.checkForUpdates();
        if (result?.disabled) showToast('Enable update checks first.', 'info');
        else if (!result?.success) showToast(result?.error || 'Could not check for updates.', 'error');
    } catch { showToast('Could not check for updates.', 'error'); }
});
btnOpenRelease.addEventListener('click', async () => {
    try {
        const result = await window.electronAPI.openReleasePage();
        if (!result?.success) showToast('Could not open the release page.', 'error');
    } catch { showToast('Could not open the release page.', 'error'); }
});

function startRecording() {
    isRecordingShortcut = true;
    shortcutRecorder.classList.add('recording');
    shortcutDisplay.textContent = 'Press key combination...';
    shortcutError.classList.add('hidden');
}

function stopRecording() {
    isRecordingShortcut = false;
    shortcutRecorder.classList.remove('recording');
}

function buildAccelerator(e) {
    const parts = [];
    if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');

    const ignoredKeys = ['Meta', 'Control', 'Shift', 'Alt', 'Dead'];
    if (ignoredKeys.includes(e.key)) return null;

    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key === 'Escape') return 'Escape';
    else if (key.length === 1) key = key.toUpperCase();
    else if (key.startsWith('Arrow')) key = key;
    else if (/^F\d+$/.test(key)) { /* F-keys are fine */ }
    else key = key.charAt(0).toUpperCase() + key.slice(1);

    if (parts.length === 0) return null;

    parts.push(key);
    return parts.join('+');
}

shortcutRecorder.addEventListener('click', () => {
    if (!isRecordingShortcut) startRecording();
});

shortcutRecorder.addEventListener('keydown', async (e) => {
    if (!isRecordingShortcut) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
        stopRecording();
        shortcutDisplay.textContent = acceleratorToDisplay(shortcutDisplay.dataset.accelerator);
        return;
    }

    const accelerator = buildAccelerator(e);
    if (!accelerator) return;

    shortcutDisplay.textContent = acceleratorToDisplay(accelerator);

    try {
        const result = await window.electronAPI.setToggleShortcut({ accelerator, enabled: true, onboardingSeen: true });
        if (result.success) {
            shortcutDisplay.dataset.accelerator = accelerator;
            shortcutError.classList.add('hidden');
            stopRecording();
            return;
        }
        shortcutError.textContent = result.error;
        shortcutError.classList.remove('hidden');
        shortcutDisplay.textContent = acceleratorToDisplay(shortcutDisplay.dataset.accelerator);
        stopRecording();
    } catch {
        updateStorageStatus({ state: 'error', message: 'Could not save settings. Click Retry to try again.', canWrite: true });
        stopRecording();
    }
});

btnResetShortcut.addEventListener('click', async () => {
    try {
    const result = await window.electronAPI.setToggleShortcut({ accelerator: DEFAULT_TOGGLE_SHORTCUT, enabled: true, onboardingSeen: true });
        if (result.success) {
            shortcutDisplay.textContent = acceleratorToDisplay(DEFAULT_TOGGLE_SHORTCUT);
            shortcutDisplay.dataset.accelerator = DEFAULT_TOGGLE_SHORTCUT;
            shortcutError.classList.add('hidden');
        }
    } catch {
        updateStorageStatus({ state: 'error', message: 'Could not save settings. Click Retry to try again.', canWrite: true });
    }
});

btnDisableShortcut.addEventListener('click', async () => {
    const result = await setShortcutPreference({ accelerator: shortcutDisplay.dataset.accelerator || DEFAULT_TOGGLE_SHORTCUT, enabled: false });
    if (result) shortcutError.classList.add('hidden');
});

// ===== Overflow menu =====
// Favourites / Trash / Settings used to sit in the top bar. At 400px that bar
// was five icons wide; they live behind one menu now.
function toggleSettingsView() {
    if (state.currentView === 'settings') {
        if (previousView) {
            state.currentView = previousView.view;
            state.currentFolderId = previousView.folderId;
            previousView = null;
        } else {
            state.currentView = 'folders';
        }
        renderCurrentView();
    } else {
        showSettings();
    }
}

function hideOverflowMenu() {
    overflowMenu.classList.add('hidden');
    btnOverflow.setAttribute('aria-expanded', 'false');
}

btnOverflow.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !overflowMenu.classList.contains('hidden');
    if (isOpen) { hideOverflowMenu(); return; }
    overflowMenu.classList.remove('hidden');
    btnOverflow.setAttribute('aria-expanded', 'true');
    positionPopover(overflowMenu, btnOverflow);
});

overflowMenu.querySelectorAll('.popover-item').forEach(item => {
    item.addEventListener('click', () => {
        const view = item.dataset.view;
        hideOverflowMenu();
        if (view === 'favourites') openFavourites();
        else if (view === 'trash') openTrash();
        else if (view === 'settings') toggleSettingsView();
    });
});

// ===== Dock preferences =====
async function updateDockPreferences(patch) {
    state.settings = { ...state.settings, ...patch };
    applyDockAppearance();
    const result = await window.electronAPI.setDockPreferences(patch);
    if (!result?.success) showToast('Could not save the dock preference.', 'error');
}

dockSideGroup?.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => updateDockPreferences({ dockSide: btn.dataset.side }));
});

dockStyleGroup?.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => updateDockPreferences({ collapsedStyle: btn.dataset.style }));
});

btnResetDock?.addEventListener('click', () => updateDockPreferences({ dockOffset: 0.5 }));

// ===== Render Router =====
function renderCurrentView() {
    if (!state.currentView.startsWith('jira')) searchInput.placeholder = 'Search notes';
    if (state.currentView === 'folders') renderFolders();
    else if (state.currentView === 'notes') renderNotes();
    else if (state.currentView === 'favourites') renderFavourites();
    else if (state.currentView === 'trash') renderTrash();
    else if (state.currentView === 'settings') showSettings();
    else if (state.currentView === 'jira-list') renderJiraList();
    else if (state.currentView === 'jira-detail') renderJiraDetail();
}

// ===== Initialize =====
async function init() {
    // Main pushes the new edge/offset while the handle is being dragged, so the
    // panel chrome flips sides in step with the window.
    window.electronAPI.onDockChanged?.(payload => {
        state.settings = { ...state.settings, ...payload };
        applyDockAppearance();
    });
    await loadData();
    await loadTrash();
    const shortcut = await window.electronAPI.getToggleShortcut();
    if (!shortcut?.onboardingSeen) {
        shortcutOnboarding.classList.remove('hidden');
        shortcutOnboardingKeep.focus();
    }
    const expanded = await window.electronAPI.getExpandedState();
    if (expanded) {
        collapsedStrip.classList.add('hidden');
        expandedPanel.classList.remove('hidden');
    }
    renderCurrentView();
}

init();
