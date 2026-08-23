const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  expand: () => ipcRenderer.send('expand'),
  collapse: () => ipcRenderer.send('collapse'),
  toggle: () => ipcRenderer.send('toggle'),
  getExpandedState: () => ipcRenderer.invoke('get-expanded-state'),
  onExpansionState: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('expansion-state', (_event, state) => callback(state === true));
  },

  loadFolders: () => ipcRenderer.invoke('load-folders'),
  saveFolders: (folders) => ipcRenderer.invoke('save-folders', folders),
  applyMutation: (mutation) => ipcRenderer.invoke('apply-mutation', mutation),
  loadTrash: () => ipcRenderer.invoke('load-trash'),
  restoreTrashItem: (trashId) => ipcRenderer.invoke('restore-trash-item', trashId),
  permanentlyDeleteTrashItem: (trashId) => ipcRenderer.invoke('permanently-delete-trash-item', trashId),
  startFreshStorage: () => ipcRenderer.invoke('start-fresh-storage'),
  flushPendingSave: () => ipcRenderer.invoke('flush-pending-save'),
  onPrepareToQuit: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('prepare-to-quit', () => callback());
  },
  notifySaveFlushed: (result) => ipcRenderer.send('renderer-save-flushed', result),
  onStorageSaveError: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('storage-save-error', (_event, details) => callback(details));
  },
  reportRendererError: (details) => ipcRenderer.send('renderer-error', details),
  onOpenView: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('open-view', (_event, view) => callback(typeof view === 'string' ? view : 'folders'));
  },
  onRequestBackupExport: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('request-backup-export', () => callback());
  },
  onUpdateStatus: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('update-status', (_event, status) => callback(status));
  },

  getToggleShortcut: () => ipcRenderer.invoke('get-toggle-shortcut'),
  setToggleShortcut: (accelerator) => ipcRenderer.invoke('set-toggle-shortcut', accelerator),

  pickAndImportImage: () => ipcRenderer.invoke('pick-and-import-image'),
  importDroppedImage: (sourcePath) => ipcRenderer.invoke('import-dropped-image', sourcePath),
  exportMarkdown: (payload) => ipcRenderer.invoke('export-markdown', payload),
  exportBackup: () => ipcRenderer.invoke('export-backup'),
  restoreBackup: () => ipcRenderer.invoke('restore-backup'),
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  getUpdatePreferences: () => ipcRenderer.invoke('get-update-preferences'),
  setUpdatePreferences: (options) => ipcRenderer.invoke('set-update-preferences', options),
  setDefaultFontSize: (value) => ipcRenderer.invoke('set-default-font-size', value),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openReleasePage: () => ipcRenderer.invoke('open-release-page'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  resizeWindow: (size) => ipcRenderer.send('resize-window', size),
  moveDock: (position) => ipcRenderer.send('move-dock', position),
  setDockPreferences: (options) => ipcRenderer.invoke('set-dock-preferences', options),
  onDockChanged: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('dock-changed', (_event, payload) => callback(payload));
  },

  jiraStatus: () => ipcRenderer.invoke('jira-status'),
  jiraConnect: (credentials) => ipcRenderer.invoke('jira-connect', credentials),
  jiraDisconnect: () => ipcRenderer.invoke('jira-disconnect'),
  jiraSelectSite: (cloudId) => ipcRenderer.invoke('jira-select-site', cloudId),
  jiraCurrentSprint: () => ipcRenderer.invoke('jira-current-sprint'),
  jiraSearchUsers: query => ipcRenderer.invoke('jira-search-users', query),
  jiraSaveMonitoredUsers: accountIds => ipcRenderer.invoke('jira-save-monitored-users', accountIds),
  jiraIssue: (issueKey) => ipcRenderer.invoke('jira-issue', issueKey),
  jiraUpdateIssue: (issueKey, fields, expectedUpdated) => ipcRenderer.invoke('jira-update-issue', issueKey, fields, expectedUpdated),
  jiraTransition: submission => ipcRenderer.invoke('jira-transition', submission),
  jiraAddComment: (issueKey, text) => ipcRenderer.invoke('jira-add-comment', issueKey, text),
  jiraUpdateComment: (issueKey, commentId, text) => ipcRenderer.invoke('jira-update-comment', issueKey, commentId, text),
  jiraDeleteComment: (issueKey, commentId) => ipcRenderer.invoke('jira-delete-comment', issueKey, commentId),
  jiraSaveFieldMapping: (issueKey, mapping) => ipcRenderer.invoke('jira-save-field-mapping', issueKey, mapping),
  jiraOpenIssue: (issueKey) => ipcRenderer.invoke('jira-open-issue', issueKey),
  jiraOpenTokenPage: () => ipcRenderer.invoke('jira-open-token-page')
});
