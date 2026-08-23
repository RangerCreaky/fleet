/**
 * Fleet – Main Application Logic
 * Uses a narrow IPC bridge to communicate with the main-process store.
 */

// ===== State =====
let state = {
    folders: [],
    trash: [],
    settings: { defaultFontSize: 13, updatesEnabled: false },
    currentView: 'folders',
    currentFolderId: null,
    searchQuery: '',
    activeNoteId: null,
    newNoteId: null,
    editingNoteIds: new Set() // tracks which notes are in edit mode
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
            notes: Array.isArray(folder.notes) ? folder.notes.filter(note => note && typeof note === 'object').map((note, noteIndex) => ({
                ...note,
                id: typeof note.id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(note.id) ? note.id : generateId(),
                content: typeof note.content === 'string' ? note.content.slice(0, 1024 * 1024) : '',
                fontSize: Number.isFinite(Number(note.fontSize)) ? Math.max(10, Math.min(24, Math.round(Number(note.fontSize)))) : 13,
                colorTag: NOTE_COLORS.includes(note.colorTag) ? note.colorTag : NOTE_COLORS[noteIndex % NOTE_COLORS.length]
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
    storageStatus.classList.toggle('hidden', !persistent && stateName !== 'saving');
    storageStatus.classList.toggle('error', stateName === 'error' || stateName === 'needs-reset');
    storageStatus.classList.toggle('recovery', stateName === 'recovered');
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

function renderMarkdown(text) {
    if (!text || !text.trim()) return '<p style="color:var(--text-muted);font-style:italic">Empty note — click to edit</p>';
    try {
        configureMarkdown();
        const cacheKey = String(text);
        if (markdownCache.has(cacheKey)) return markdownCache.get(cacheKey);

        let html = marked.parse(String(text));
        if (!window.fleetSecurity) return escapeHtml(text);
        html = window.fleetSecurity.sanitizeMarkdownHtml(html);

        // Remove 'disabled' from checkboxes so they're clickable
        html = html.replace(/<input\s+type="checkbox"\s*disabled\s*/gi, '<input type="checkbox" ');
        html = html.replace(/<input\s+disabled\s+type="checkbox"\s*/gi, '<input type="checkbox" ');
        html = html.replace(/<input\s+checked=""\s+disabled\s*/gi, '<input checked="" ');
        html = html.replace(/<input\s+disabled\s+checked=""\s*/gi, '<input checked="" ');

        // Fallback: if marked didn't render checkboxes, manually convert them
        // This handles `- [ ] text` and `- [x] text` patterns
        html = html.replace(
            /<li>\s*\[\s*\]\s*/gi,
            '<li><input type="checkbox" /> '
        );
        html = html.replace(
            /<li>\s*\[x\]\s*/gi,
            '<li><input type="checkbox" checked="" /> '
        );

        const result = window.fleetSecurity.sanitizeMarkdownHtml(html);
        if (markdownCache.size > 300) markdownCache.delete(markdownCache.keys().next().value);
        markdownCache.set(cacheKey, result);
        return result;
    } catch (e) {
        return escapeHtml(text);
    }
}

// ===== Color Palettes =====
const NOTE_COLORS = [
    '#e94560', '#533483', '#58a6ff', '#3fb950', '#d29922',
    '#bc8cff', '#f778ba', '#79c0ff', '#56d364', '#e3b341'
];

const FOLDER_COLORS = [
    { bg: 'rgba(233, 69, 96, 0.15)', fg: '#e94560' },
    { bg: 'rgba(88, 166, 255, 0.15)', fg: '#58a6ff' },
    { bg: 'rgba(63, 185, 80, 0.15)', fg: '#3fb950' },
    { bg: 'rgba(188, 140, 255, 0.15)', fg: '#bc8cff' },
    { bg: 'rgba(210, 153, 34, 0.15)', fg: '#d29922' },
    { bg: 'rgba(247, 120, 186, 0.15)', fg: '#f778ba' },
];

// ===== DOM References =====
const collapsedStrip = document.getElementById('collapsed-strip');
const expandedPanel = document.getElementById('expanded-panel');
const topTitle = document.getElementById('top-title');
const btnBack = document.getElementById('btn-back');
const btnCollapse = document.getElementById('btn-collapse');
const btnSearchToggle = document.getElementById('btn-search-toggle');
const btnFavourites = document.getElementById('btn-favourites');
const btnTrash = document.getElementById('btn-trash');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const folderListView = document.getElementById('folder-list-view');
const notesView = document.getElementById('notes-view');
const folderList = document.getElementById('folder-list');
const notesList = document.getElementById('notes-list');
const btnAddFolder = document.getElementById('btn-add-folder');
const btnAddNote = document.getElementById('btn-add-note');
const contextMenu = document.getElementById('context-menu');
const formatDropdown = document.getElementById('format-dropdown');
const resizeHandle = document.getElementById('resize-handle');
const btnSettings = document.getElementById('btn-settings');
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
    if (view === 'favourites') openFavourites();
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

collapsedStrip.addEventListener('click', () => {
    window.electronAPI.expand();
});
collapsedStrip.addEventListener('mouseenter', () => {
    window.electronAPI.expand();
});

btnCollapse.addEventListener('click', () => {
    window.electronAPI.collapse();
});

// ===== Resize Handle =====
let isResizing = false;
let resizeStartX = 0;
let resizeStartWidth = 0;
let pendingResize = false;

resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizeStartX = e.screenX;
    resizeStartWidth = expandedPanel.offsetWidth;
    resizeHandle.classList.add('resizing');
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
    if (!isResizing || pendingResize) return;
    const deltaX = resizeStartX - e.screenX;
    const newWidth = Math.max(260, Math.min(800, resizeStartWidth + deltaX));
    pendingResize = true;
    requestAnimationFrame(() => {
        window.electronAPI.resizeWindow(newWidth);
        pendingResize = false;
    });
});

document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    pendingResize = false;
    resizeHandle.classList.remove('resizing');
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
    clearTimeout(window.fleetSearchTimer);
    window.fleetSearchTimer = setTimeout(() => renderCurrentView(), 150);
});

function clearActiveSearch() {
    state.searchQuery = '';
    searchInput.value = '';
    if (searchVisible) {
        searchVisible = false;
        searchBar.classList.add('hidden');
    }
}

function searchableText(item) {
    const key = item.id;
    const content = `${item.name || ''}\n${(item.notes || []).map(note => `${note.id}:${note.content}`).join('\n')}`;
    const cached = searchIndexCache.get(key);
    if (cached?.source === content) return cached.value;
    const value = content.toLowerCase();
    searchIndexCache.set(key, { source: content, value });
    return value;
}

// ===== Back Button =====
let previousView = null;
let trashReturnView = null;
let trashReturnFocus = null;
btnBack.addEventListener('click', () => {
    if (state.currentView === 'trash') {
        const destination = trashReturnView || { view: 'folders', folderId: null };
        state.currentView = destination.view;
        state.currentFolderId = destination.folderId;
        trashReturnView = null;
        renderCurrentView();
        const focusTarget = trashReturnFocus;
        trashReturnFocus = null;
        if (focusTarget && typeof focusTarget.focus === 'function') setTimeout(() => focusTarget.focus(), 0);
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
        colorTag: NOTE_COLORS[folder.notes.length % NOTE_COLORS.length],
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

    let folders = state.folders;
    if (state.searchQuery) {
        folders = folders.filter(f => {
            return searchableText(f).includes(state.searchQuery);
        });
    }

    if (folders.length === 0 && !state.searchQuery) {
        folderList.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <p>No folders yet.<br>Click below to create one.</p>
      </div>
    `;
        return;
    }

    if (folders.length === 0 && state.searchQuery) {
        folderList.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <p>No results found</p>
      </div>
    `;
        return;
    }

    folderList.innerHTML = folders.map(folder => {
        const color = FOLDER_COLORS[folder.colorIndex || 0];
        const noteCount = folder.notes.length;
        const folderId = escapeHtml(folder.id);
        return `
      <div class="folder-item" data-id="${folderId}" role="button" tabindex="0" aria-label="Open folder ${escapeHtml(folder.name)}">
        <div class="folder-icon" style="background: ${color.bg}; color: ${color.fg}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div class="folder-info">
          <div class="folder-name">${state.searchQuery ? highlightInHtml(escapeHtml(folder.name), state.searchQuery) : escapeHtml(folder.name)}</div>
          <div class="folder-count">${noteCount} note${noteCount !== 1 ? 's' : ''}</div>
        </div>
        <button class="btn-icon folder-menu-btn" data-folder-id="${folderId}" title="Options" aria-label="Folder options">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>
          </svg>
        </button>
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
        favourite.querySelector('svg')?.setAttribute('fill', note.favourite ? 'currentColor' : 'none');
    }
    const pin = card.querySelector('.note-pin-btn');
    if (pin) {
        const label = note.pinned ? 'Unpin from top' : 'Pin to top';
        pin.classList.toggle('pinned', note.pinned);
        pin.title = label;
        pin.setAttribute('aria-label', label);
        pin.querySelector('svg')?.setAttribute('fill', note.pinned ? 'currentColor' : 'none');
    }
    const strip = card.querySelector('.note-color-strip');
    if (strip) strip.style.background = NOTE_COLORS.includes(note.colorTag) ? note.colorTag : NOTE_COLORS[0];
}

function scheduleNoteVisualUpdate(noteId, needsReorder = false) {
    pendingVisualUpdates.add(noteId);
    visualUpdateNeedsReorder = visualUpdateNeedsReorder || needsReorder;
    if (visualUpdateFrame) return;
    const flush = () => {
        visualUpdateFrame = null;
        const ids = Array.from(pendingVisualUpdates);
        pendingVisualUpdates.clear();
        const reorder = visualUpdateNeedsReorder;
        visualUpdateNeedsReorder = false;
        ids.forEach(updateNoteCardVisual);
        if (reorder) {
            const folder = state.folders.find(item => item.id === state.currentFolderId);
            if (folder) syncNoteCardOrder(folder);
        }
    };
    visualUpdateFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flush) : setTimeout(flush, 0);
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

    const notes = orderedVisibleNotes(folder);

    if (notes.length === 0 && !state.searchQuery) {
        notesList.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
        <p>No notes yet.<br>Click below to add one.</p>
      </div>
    `;
        return;
    }

    notesList.innerHTML = notes.map(note => {
        const wc = wordCount(note.content);
        const isEditing = state.editingNoteIds.has(note.id);
        const noteId = escapeHtml(note.id);
        const colorTag = NOTE_COLORS.includes(note.colorTag) ? note.colorTag : NOTE_COLORS[0];

        // Build the content area: either editor (textarea) or rendered preview
        let contentHtml;
        if (isEditing) {
            contentHtml = `
              <div class="note-editor-wrapper">
                <textarea
                  class="note-editor"
                  data-note-id="${noteId}"
                  placeholder="Type your note here... (Markdown supported)"
                  style="font-size: ${note.fontSize || 13}px"
                >${escapeHtml(note.content)}</textarea>
              </div>
              <div class="note-mode-indicator editing"><span class="mode-dot"></span>editing</div>`;
        } else {
            contentHtml = `
              <div class="note-preview" data-note-id="${noteId}">
                <div class="note-preview-content" style="font-size: ${Math.max(10, Math.min(24, Number(note.fontSize) || state.settings.defaultFontSize || 13))}px">
                ${highlightInHtml(renderMarkdown(note.content), state.searchQuery)}
                </div>
              </div>
              <div class="note-preview-hint">click to edit</div>`;
        }

        return `
      <div class="note-card ${note.pinned ? 'pinned' : ''} ${note.favourite ? 'favourite' : ''}" data-note-id="${noteId}" tabindex="0" aria-label="Note">
        <div class="note-card-header">
          <div class="note-drag-handle" title="Drag to reorder"><svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.2"/><circle cx="7.5" cy="2.5" r="1.2"/><circle cx="2.5" cy="7" r="1.2"/><circle cx="7.5" cy="7" r="1.2"/><circle cx="2.5" cy="11.5" r="1.2"/><circle cx="7.5" cy="11.5" r="1.2"/></svg></div>
          <span class="note-timestamp">${formatDate(note.updatedAt)}</span>
          <button class="note-favourite-btn ${note.favourite ? 'favourited' : ''}" data-note-id="${noteId}" title="${note.favourite ? 'Remove from favourites' : 'Add to favourites'}" aria-label="${note.favourite ? 'Remove from favourites' : 'Add to favourites'}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="${note.favourite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
              <path d="M12 2l3 9h9l-7.5 5.5L19 26l-7-5.5L5 26l2.5-9.5L0 11h9z"/>
            </svg>
          </button>
          <button class="note-pin-btn ${note.pinned ? 'pinned' : ''}" data-note-id="${noteId}" title="${note.pinned ? 'Unpin from top' : 'Pin to top'}" aria-label="${note.pinned ? 'Unpin from top' : 'Pin to top'}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="${note.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
              <path d="M12 17v5"/>
              <path d="M8 3h8l-2 6v4l2 2H8l2-2V9z"/>
            </svg>
          </button>
        </div>
        ${contentHtml}
        <div class="note-toolbar">
          <button class="btn-tool btn-format-toggle" data-note-id="${noteId}" title="Formatting (Aa)" aria-label="Formatting">
            <span style="font-weight:700;font-size:13px;">Aa</span>
          </button>
          <button class="btn-tool btn-upload" data-note-id="${noteId}" title="Upload image" aria-label="Upload image">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </button>
          <button class="btn-tool btn-note-settings" data-note-id="${noteId}" title="Settings" aria-label="Note settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <button class="btn-tool btn-download" data-note-id="${noteId}" title="Download .md" aria-label="Export Markdown">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="btn-tool btn-copy-clipboard" data-note-id="${noteId}" title="Copy Markdown" aria-label="Copy Markdown">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <div class="toolbar-spacer"></div>
          <span class="note-word-count">${wc} word${wc !== 1 ? 's' : ''}</span>
          <button class="btn-tool btn-delete-note" data-note-id="${noteId}" title="Delete" aria-label="Delete note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
        <div class="note-color-strip" style="background: ${colorTag}"></div>
      </div>
    `;
    }).join('');

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
function switchToEdit(noteId) {
    state.editingNoteIds.add(noteId);
    state.activeNoteId = noteId;
    renderNotes();
    setTimeout(() => {
        const editor = document.querySelector(`.note-editor[data-note-id="${noteId}"]`);
        if (editor) {
            editor.focus();
            // Move cursor to end
            editor.selectionStart = editor.selectionEnd = editor.value.length;
        }
    }, 50);
}

function switchToPreview(noteId) {
    state.editingNoteIds.delete(noteId);
    renderNotes();
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
    setTimeout(() => notesList.querySelector(`.note-card[data-note-id="${CSS.escape(noteId)}"]`)?.focus(), 0);
}

// ===== Attach Note Events =====
function attachNoteEvents() {
    // Attach checkbox handlers FIRST, directly on each checkbox
    notesList.querySelectorAll('.note-preview').forEach(preview => {
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
    notesList.querySelectorAll('.note-editor').forEach(editor => {
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

        // Blur → switch to preview (unless clicking toolbar)
        editor.addEventListener('blur', (e) => {
            setTimeout(() => {
                const card = document.querySelector(`.note-card[data-note-id="${noteId}"]`);
                if (card && !card.contains(document.activeElement) && !document.querySelector('.format-dropdown:not(.hidden)')) {
                    switchToPreview(noteId);
                }
            }, 200);
        });

        editor.addEventListener('keydown', (e) => {
            handleEditorShortcut(e, editor);
        });

        autoResize(editor);
    });

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
            btn.focus();
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
            btn.focus();
        });
    });

    notesList.querySelectorAll('.note-card').forEach(card => {
        card.addEventListener('keydown', event => {
            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            moveNote(card.dataset.noteId, event.key === 'ArrowUp' ? -1 : 1);
        });
    });

    notesList.querySelectorAll('.btn-format-toggle').forEach(btn => {
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

    notesList.querySelectorAll('.btn-upload').forEach(btn => {
        btn.addEventListener('click', () => handleUpload(btn.dataset.noteId));
    });

    notesList.querySelectorAll('.btn-note-settings').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showNoteSettings(btn, btn.dataset.noteId);
        });
    });

    notesList.querySelectorAll('.btn-download').forEach(btn => {
        btn.addEventListener('click', () => handleDownload(btn.dataset.noteId));
    });

    notesList.querySelectorAll('.btn-delete-note').forEach(btn => {
        btn.addEventListener('click', () => {
            showConfirm('Delete Note', 'Are you sure? This cannot be undone.', () => {
                deleteNote(btn.dataset.noteId);
            });
        });
    });

    // ===== Copy to Clipboard =====
    notesList.querySelectorAll('.btn-copy-clipboard').forEach(btn => {
        btn.addEventListener('click', async () => {
            const folder = state.folders.find(f => f.id === state.currentFolderId);
            if (!folder) return;
            const note = folder.notes.find(n => n.id === btn.dataset.noteId);
            if (!note) return;
            try {
                await navigator.clipboard.writeText(note.content);
                btn.classList.add('copied');
                const origTitle = btn.title;
                btn.title = 'Copied!';
                setTimeout(() => { btn.classList.remove('copied'); btn.title = origTitle; }, 1500);
            } catch (e) {
                showToast('Could not copy note to the clipboard.', 'error');
            }
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
                setTimeout(() => notesList.querySelector(`.note-card[data-note-id="${CSS.escape(dragSourceNoteId || noteId)}"]`)?.focus(), 0);
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

function openFavourites() {
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
    btnBack.classList.add('hidden');
    folderListView.classList.add('hidden');
    notesView.classList.add('hidden');
    settingsView.classList.add('hidden');
    favouritesView.classList.remove('hidden');
    trashView.classList.add('hidden');
    const matches = state.folders.flatMap(folder => folder.notes
        .filter(note => note.favourite === true)
        .map(note => ({ folder, note })))
        .filter(({ folder, note }) => !state.searchQuery || searchableText({ id: note.id, content: `${folder.name}\n${note.content}` }).includes(state.searchQuery));
    if (!matches.length) {
        favouritesList.innerHTML = '<div class="empty-state"><p>No favourite notes yet.<br>Use the star on a note to add one here.</p></div>';
        return;
    }
    favouritesList.innerHTML = matches.map(({ folder, note }) => `
      <article class="note-card favourite favourite-result" data-folder-id="${escapeHtml(folder.id)}" data-note-id="${escapeHtml(note.id)}" tabindex="0" aria-label="Favourite note in ${escapeHtml(folder.name)}">
        <div class="note-card-header"><span class="note-timestamp">${escapeHtml(folder.name)}</span><span class="note-timestamp">${formatDate(note.updatedAt)}</span></div>
        <div class="note-preview" style="font-size:${Math.max(10, Math.min(24, Number(note.fontSize) || state.settings.defaultFontSize || 13))}px">${highlightInHtml(renderMarkdown(note.content), state.searchQuery)}</div>
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
    if (!state.trash.length) {
        trashList.innerHTML = '<div class="empty-state"><p>Trash is empty.</p></div>';
        return;
    }
    trashList.innerHTML = state.trash.slice().reverse().map(item => {
        const label = item.type === 'folder' ? item.folder?.name || 'Folder' : item.note?.content?.split('\n')[0] || 'Note';
        return `<article class="trash-item" data-trash-id="${escapeHtml(item.id)}"><div><strong>${escapeHtml(label.slice(0, 100))}</strong><div class="note-timestamp">${item.type === 'folder' ? 'Folder' : 'Note'} · deleted ${formatDate(item.deletedAt)}</div></div><div class="trash-actions"><button type="button" class="btn-reset-shortcut trash-restore">Restore</button><button type="button" class="btn-reset-shortcut trash-delete">Delete permanently</button></div></article>`;
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

function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
}

// ===== Context Menu (Folders) =====
let contextMenuTarget = null;

function showContextMenu(event, folderId) {
    contextMenuTarget = folderId;
    const rect = event.target.getBoundingClientRect();
    contextMenu.classList.remove('hidden');
    contextMenu.style.top = rect.bottom + 4 + 'px';
    contextMenu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
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
function showConfirm(title, text, onConfirm) {
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
        <button class="btn-confirm danger">Delete</button>
      </div>
    </div>
  `;
    document.body.appendChild(overlay);

    const cancel = () => { overlay.remove(); if (previousFocus?.focus) previousFocus.focus(); };
    overlay.querySelector('.cancel').addEventListener('click', cancel);
    overlay.querySelector('.danger').addEventListener('click', () => { onConfirm(); cancel(); });
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
    const rect = anchorBtn.getBoundingClientRect();
    formatDropdown.classList.remove('hidden');
    const dropdownHeight = formatDropdown.offsetHeight;
    let top = rect.top - dropdownHeight - 4;
    if (top < 10) top = rect.bottom + 4;
    formatDropdown.style.top = top + 'px';
    formatDropdown.style.left = Math.max(10, rect.left - 80) + 'px';
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
        if (searchVisible) {
            searchVisible = false;
            searchBar.classList.add('hidden');
            searchInput.value = '';
            state.searchQuery = '';
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
    const existing = document.querySelector('.settings-dropdown');
    if (existing) existing.remove();

    const folder = state.folders.find(f => f.id === state.currentFolderId);
    if (!folder) return;
    const note = folder.notes.find(n => n.id === noteId);
    if (!note) return;

    const rect = anchorBtn.getBoundingClientRect();
    const dropdown = document.createElement('div');
    dropdown.className = 'settings-dropdown';

    dropdown.innerHTML = `
    <div class="settings-label">Font Size</div>
    <div class="settings-row">
      <div class="font-size-control">
        <button class="btn-font-dec">−</button>
        <span class="font-size-val">${note.fontSize || 13}</span>
        <button class="btn-font-inc">+</button>
      </div>
    </div>
    <div class="settings-label" style="margin-top:10px">Color Tag</div>
    <div class="color-picker-grid">
      ${NOTE_COLORS.map(c => `<button type="button" class="color-swatch ${note.colorTag === c ? 'active' : ''}" data-color="${c}" aria-label="Use color ${c}" style="background:${c}"></button>`).join('')}
    </div>
  `;

    let top = rect.top - 180;
    if (top < 10) top = rect.bottom + 4;
    dropdown.style.top = top + 'px';
    dropdown.style.left = Math.max(10, rect.left - 100) + 'px';
    document.body.appendChild(dropdown);

    const fontVal = dropdown.querySelector('.font-size-val');
    dropdown.querySelector('.btn-font-dec').addEventListener('click', (e) => {
        e.stopPropagation();
        note.fontSize = Math.max(10, (note.fontSize || 13) - 1);
        fontVal.textContent = note.fontSize;
            const editor = document.querySelector(`.note-editor[data-note-id="${noteId}"]`);
            if (editor) editor.style.fontSize = note.fontSize + 'px';
            const previewContent = document.querySelector(`.note-preview[data-note-id="${noteId}"] .note-preview-content`);
            if (previewContent) previewContent.style.fontSize = note.fontSize + 'px';
        queueMutation({ type: 'upsert-note', folderId: folder.id, note: { ...note } });
    });
    dropdown.querySelector('.btn-font-inc').addEventListener('click', (e) => {
        e.stopPropagation();
        note.fontSize = Math.min(24, (note.fontSize || 13) + 1);
        fontVal.textContent = note.fontSize;
            const editor = document.querySelector(`.note-editor[data-note-id="${noteId}"]`);
            if (editor) editor.style.fontSize = note.fontSize + 'px';
            const previewContent = document.querySelector(`.note-preview[data-note-id="${noteId}"] .note-preview-content`);
            if (previewContent) previewContent.style.fontSize = note.fontSize + 'px';
        queueMutation({ type: 'upsert-note', folderId: folder.id, note: { ...note } });
    });
    dropdown.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', (e) => {
            e.stopPropagation();
            note.colorTag = swatch.dataset.color;
            queueMutation({ type: 'upsert-note', folderId: folder.id, note: { ...note } });
            scheduleNoteVisualUpdate(noteId);
        });
    });
}

// ===== Settings View =====
const DEFAULT_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+Space';
let isRecordingShortcut = false;

function acceleratorToDisplay(accel) {
    if (!accel) return '';
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    return accel
        .replace(/CommandOrControl/g, isMac ? '⌘' : 'Ctrl')
        .replace(/Command/g, '⌘')
        .replace(/Control/g, 'Ctrl')
        .replace(/Shift/g, isMac ? '⇧' : 'Shift')
        .replace(/Alt/g, isMac ? '⌥' : 'Alt')
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

    const shortcut = await window.electronAPI.getToggleShortcut();
    const currentShortcut = shortcut?.accelerator || DEFAULT_TOGGLE_SHORTCUT;
    shortcutDisplay.textContent = shortcut?.enabled === false ? 'Disabled' : acceleratorToDisplay(currentShortcut);
    shortcutDisplay.dataset.accelerator = currentShortcut;
    shortcutError.classList.add('hidden');
    stopRecording();
    const prefs = await window.electronAPI.getUpdatePreferences().catch(() => ({ enabled: false }));
    updatesEnabled.checked = prefs.enabled === true;
    defaultFontSizeValue.textContent = `${Math.max(10, Math.min(24, Number(state.settings.defaultFontSize) || 13))} px`;
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
    defaultFontSizeValue.textContent = `${state.settings.defaultFontSize} px`;
    try { await window.electronAPI.setDefaultFontSize(state.settings.defaultFontSize); } catch { showToast('Could not save font-size setting.', 'error'); }
});
btnDefaultFontInc.addEventListener('click', async () => {
    state.settings.defaultFontSize = Math.min(24, (Number(state.settings.defaultFontSize) || 13) + 1);
    defaultFontSizeValue.textContent = `${state.settings.defaultFontSize} px`;
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

btnSettings.addEventListener('click', () => {
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
});
btnFavourites.addEventListener('click', openFavourites);
btnTrash.addEventListener('click', openTrash);

// ===== Render Router =====
function renderCurrentView() {
    if (state.currentView === 'folders') renderFolders();
    else if (state.currentView === 'notes') renderNotes();
    else if (state.currentView === 'favourites') renderFavourites();
    else if (state.currentView === 'trash') renderTrash();
    else if (state.currentView === 'settings') showSettings();
}

// ===== Initialize =====
async function init() {
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
