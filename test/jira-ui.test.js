const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { marked } = require('marked');
const createDOMPurify = require('dompurify');

const root = path.join(__dirname, '..');

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

test('Jira header navigation boots into the isolated local connection state', async () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///renderer/index.html', pretendToBeVisual: true });
  const { window } = dom;
  window.marked = marked;
  window.DOMPurify = createDOMPurify(window);
  window.confirm = () => true;
  window.electronAPI = {
    loadFolders: async () => ({ folders: [{ id: 'folder-1', name: 'Work notes', colorIndex: 0, notes: [] }], settings: {}, storage: { state: 'ok', canWrite: true } }),
    saveFolders: async () => ({ success: true }),
    loadTrash: async () => ({ trash: [] }),
    getToggleShortcut: async () => ({ accelerator: 'CommandOrControl+Shift+Space', enabled: true, onboardingSeen: true }),
    getExpandedState: async () => true,
    jiraStatus: async () => ({ success: true, data: { configured: true, connected: false, connectionMode: 'api-token' } }),
    onDockChanged() {}, onStorageSaveError() {}, onPrepareToQuit() {}, onExpansionState() {},
    onOpenView() {}, onRequestBackupExport() {}, onUpdateStatus() {},
    setDockPreferences: async () => ({ success: true }),
    getUpdatePreferences: async () => ({ enabled: false })
  };
  window.eval(fs.readFileSync(path.join(root, 'renderer', 'security.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8'));
  await tick();
  await tick();

  window.document.querySelector('.folder-item').click();
  assert.equal(window.document.getElementById('notes-view').classList.contains('hidden'), false);
  window.document.getElementById('btn-jira').click();
  await tick();
  await tick();

  assert.equal(window.document.getElementById('jira-list-view').classList.contains('hidden'), false);
  assert.match(window.document.getElementById('jira-content').textContent, /Connect Jira Cloud/);
  assert.match(window.document.getElementById('jira-content').textContent, /No Fleet server is required/);
  assert.ok(window.document.querySelector('[name="jira-site-url"]'));
  assert.ok(window.document.querySelector('[name="jira-email"]'));
  assert.ok(window.document.querySelector('[name="jira-api-token"]'));
  assert.equal(window.document.getElementById('folder-list-view').classList.contains('hidden'), true);
  const back = window.document.getElementById('btn-back');
  assert.equal(back.getAttribute('aria-label'), 'Back to local notes');
  assert.equal(back.textContent.trim(), '');

  window.document.getElementById('btn-jira').click();
  assert.equal(window.document.getElementById('notes-view').classList.contains('hidden'), false);
  assert.equal(window.document.getElementById('top-title').textContent, 'Work notes');

  window.document.getElementById('btn-jira').click();
  await tick(); await tick();
  window.document.getElementById('btn-back').click();
  assert.equal(window.document.getElementById('notes-view').classList.contains('hidden'), false);
  assert.equal(window.document.getElementById('top-title').textContent, 'Work notes');
  dom.window.close();
});

test('Jira issue editor uses collapsed multi-choice controls and a bottom comment composer', async () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///renderer/index.html', pretendToBeVisual: true });
  const { window } = dom;
  window.marked = marked;
  window.DOMPurify = createDOMPurify(window);
  window.confirm = () => true;
  const issue = {
    key: 'SIDE-1', summary: 'Improve Jira editing', updated: '2026-08-23T12:00:00.000Z',
    status: { name: 'In progress', category: 'indeterminate' }, issueType: { name: 'Story' },
    project: { key: 'FLEET', name: 'Fleet' }, activeSprint: { id: '1', name: 'Sprint 1' },
    priority: { name: 'Medium' }, assignee: { displayName: 'Fleet User' }, estimate: {},
    editableFields: [{
      id: 'components', name: 'Components', required: true, schema: { type: 'array' },
      allowedValues: [{ id: '1', name: 'Editor' }, { id: '2', name: 'Jira' }], value: [{ id: '1', name: 'Editor' }]
    }, {
      id: 'fixVersions', name: 'Fix versions', required: false, schema: { type: 'array' },
      allowedValues: [{ id: '10', name: '1.1' }, { id: '11', name: '1.2' }], value: []
    }],
    comments: [{
      id: '9', author: { accountId: 'account-1', displayName: 'Fleet User' },
      created: '2026-08-23T11:00:00.000Z', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good.' }] }] }
    }],
    transitions: [], subtasks: [], attachments: [], allFields: [], fields: [], fieldMapping: {}
  };
  let submittedFields = null;
  window.electronAPI = {
    loadFolders: async () => ({ folders: [], settings: {}, storage: { state: 'ok', canWrite: true } }),
    saveFolders: async () => ({ success: true }), loadTrash: async () => ({ trash: [] }),
    getToggleShortcut: async () => ({ accelerator: 'CommandOrControl+Shift+Space', enabled: true, onboardingSeen: true }),
    getExpandedState: async () => true,
    jiraStatus: async () => ({ success: true, data: {
      configured: true, connected: true, accountId: 'account-1', displayName: 'Fleet User',
      sites: [{ id: 'site', name: 'Fleet', url: 'https://fleet.atlassian.net' }],
      activeSite: { id: 'site', name: 'Fleet', url: 'https://fleet.atlassian.net' }
    } }),
    jiraCurrentSprint: async () => ({ success: true, data: { groups: [{ sprint: issue.activeSprint, project: issue.project, issues: [issue] }], total: 1 } }),
    jiraIssue: async () => ({ success: true, data: issue }),
    jiraUpdateIssue: async (_key, fields) => { submittedFields = fields; return { success: true, data: issue }; },
    onDockChanged() {}, onStorageSaveError() {}, onPrepareToQuit() {}, onExpansionState() {},
    onOpenView() {}, onRequestBackupExport() {}, onUpdateStatus() {},
    setDockPreferences: async () => ({ success: true }), getUpdatePreferences: async () => ({ enabled: false })
  };
  window.eval(fs.readFileSync(path.join(root, 'renderer', 'security.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8'));
  await tick(); await tick();
  window.document.getElementById('btn-jira').click();
  await tick(); await tick();
  window.document.querySelector('.jira-card').click();
  await tick(); await tick();

  const controls = window.document.querySelectorAll('.jira-multiselect');
  assert.equal(controls.length, 2);
  assert.equal(window.document.querySelector('select[multiple]'), null);
  assert.match(controls[0].querySelector('summary').textContent, /Editor/);
  assert.equal(controls[0].querySelectorAll('input[type="checkbox"]').length, 2);
  assert.ok(window.document.querySelector('.jira-comment-avatar'));
  const composer = window.document.querySelector('.jira-comment-composer');
  assert.ok(composer.querySelector('.jira-comment-input'));
  assert.ok(composer.querySelector('.jira-comment-composer-footer .jira-add-comment-btn'));
  assert.equal(window.document.querySelector('.jira-save-issue').disabled, true);

  controls[0].querySelector('input[value="1"]').click();
  assert.equal(window.document.querySelector('.jira-save-issue').disabled, false);
  window.document.querySelector('.jira-save-issue').click();
  await tick(); await tick();
  assert.equal(Array.from(submittedFields.components, item => item.id).join(','), '1,2');
  dom.window.close();
});

test('Jira monitored people are shown by default and can be filtered and configured', async () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///renderer/index.html', pretendToBeVisual: true });
  const { window } = dom;
  window.marked = marked;
  window.DOMPurify = createDOMPurify(window);
  const self = { accountId: 'account-me', displayName: 'Manager User' };
  const alice = { accountId: 'account-alice', displayName: 'Alice Teammate' };
  const bob = { accountId: 'account-bob', displayName: 'Bob Teammate' };
  let roster = [alice];
  const issue = (key, assignee) => ({
    key, summary: `${assignee.displayName} work`, status: { name: 'Open', category: 'new' }, issueType: { name: 'Story' },
    project: { key: 'FLEET', name: 'Fleet' }, activeSprint: { id: '1', name: 'Sprint 1' }, assignee, estimate: {}, subtasks: []
  });
  const work = () => {
    const issues = [issue('SIDE-1', self), ...roster.map((person, index) => issue(`SIDE-${index + 2}`, person))];
    return { groups: [{ sprint: { id: '1', name: 'Sprint 1' }, project: { key: 'FLEET', name: 'Fleet' }, issues }], total: issues.length, monitoredUsers: roster };
  };
  let searchCalls = 0;
  let savedIds = null;
  window.electronAPI = {
    loadFolders: async () => ({ folders: [], settings: {}, storage: { state: 'ok', canWrite: true } }),
    saveFolders: async () => ({ success: true }), loadTrash: async () => ({ trash: [] }),
    getToggleShortcut: async () => ({ accelerator: 'CommandOrControl+Shift+Space', enabled: true, onboardingSeen: true }), getExpandedState: async () => true,
    jiraStatus: async () => ({ success: true, data: { configured: true, connected: true, ...self, monitoredUsers: roster, sites: [{ id: 'site', name: 'Fleet', url: 'https://fleet.atlassian.net' }], activeSite: { id: 'site', name: 'Fleet', url: 'https://fleet.atlassian.net' } } }),
    jiraCurrentSprint: async () => ({ success: true, data: work() }),
    jiraSearchUsers: async query => { searchCalls++; assert.equal(query, 'Bob'); return { success: true, data: { users: [bob] } }; },
    jiraSaveMonitoredUsers: async ids => { savedIds = ids; roster = ids.map(id => id === alice.accountId ? alice : bob); return { success: true, data: { monitoredUsers: roster } }; },
    onDockChanged() {}, onStorageSaveError() {}, onPrepareToQuit() {}, onExpansionState() {}, onOpenView() {}, onRequestBackupExport() {}, onUpdateStatus() {},
    setDockPreferences: async () => ({ success: true }), getUpdatePreferences: async () => ({ enabled: false })
  };
  window.eval(fs.readFileSync(path.join(root, 'renderer', 'security.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8'));
  await tick(); await tick();
  window.document.getElementById('btn-jira').click(); await tick(); await tick();

  assert.equal(window.document.querySelectorAll('.jira-card').length, 2);
  assert.match(window.document.querySelector('.jira-people-button').textContent, /People1/);
  assert.equal(window.document.querySelectorAll('.jira-card-assignee').length, 2);
  const selfFilter = window.document.querySelector(`.jira-people-filter-option input[value="${self.accountId}"]`);
  selfFilter.click();
  assert.equal(window.document.querySelectorAll('.jira-card').length, 1);
  assert.match(window.document.querySelector('.jira-card').textContent, /Alice Teammate/);

  window.document.querySelector('.jira-people-button').click();
  assert.match(window.document.querySelector('.jira-people-list').textContent, /Manager User/);
  assert.match(window.document.querySelector('.jira-people-list').textContent, /Alice Teammate/);
  window.document.querySelector('.jira-person-remove').click();
  const input = window.document.querySelector('#jira-people-search');
  input.value = 'Bob';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 325));
  await tick();
  assert.equal(searchCalls, 1);
  window.document.querySelector('.jira-people-result').click();
  window.document.querySelector('.jira-people-save').click();
  await tick(); await tick();
  assert.deepEqual(Array.from(savedIds), ['account-bob']);
  assert.equal(window.document.querySelector('.jira-people-dialog'), null);
  assert.equal(window.document.querySelectorAll('.jira-card').length, 2);
  assert.match(window.document.querySelector('.jira-card-list').textContent, /Bob Teammate/);
  assert.doesNotMatch(window.document.querySelector('.jira-card-list').textContent, /Alice Teammate/);

  const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.jira-account\s*\{[^}]*gap:\s*var\(--sp-1\)/s);
  assert.match(css, /\.jira-group-heading > div\s*\{[^}]*gap:\s*var\(--sp-1\)/s);
  dom.window.close();
});

test('Jira status actions live in the header and closing uses Jira transition fields', async () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///renderer/index.html', pretendToBeVisual: true });
  const { window } = dom;
  window.marked = marked;
  window.DOMPurify = createDOMPurify(window);
  const issue = {
    key: 'SIDE-2', summary: 'Ship workflow controls', updated: '2026-08-23T12:00:00.000Z',
    status: { id: '1', name: 'Open', category: 'new' }, issueType: { name: 'Task' },
    project: { key: 'FLEET', name: 'Fleet' }, activeSprint: { id: '1', name: 'Sprint 1' },
    priority: { name: 'High' }, assignee: { displayName: 'Fleet User' }, estimate: {},
    editableFields: [{ id: 'summary', name: 'Summary', required: true, schema: { type: 'string' }, allowedValues: [], value: 'Ship workflow controls' },
      { id: 'customfield_10042', name: 'Product themes', required: false, operations: ['add', 'remove'], schema: { type: 'array', items: 'option' }, allowedValues: [{ id: '2', name: 'Current theme' }], value: [{ id: '1', name: 'Archived theme' }] }],
    comments: [], subtasks: [], attachments: [], allFields: [], fields: [], fieldMapping: {},
    transitions: [{ id: '11', name: 'Start work', hasScreen: false, to: { id: '2', name: 'In Progress', category: 'indeterminate' }, fields: [] }, {
      id: '31', name: 'Close issue', hasScreen: true, to: { id: '3', name: 'Done', category: 'done' },
      fields: [{ id: 'resolution', name: 'Resolution', required: true, schema: { type: 'resolution' }, allowedValues: [{ id: '1', name: 'Fixed' }], value: null },
        { id: 'customfield_10100', name: 'Start date', required: true, schema: { type: 'date' }, allowedValues: [], value: null },
        { id: 'comment', name: 'Comment', required: false, schema: { type: 'string' }, allowedValues: [], value: '' }]
    }]
  };
  const submissions = [];
  let savedBeforeTransition = null;
  window.electronAPI = {
    loadFolders: async () => ({ folders: [], settings: {}, storage: { state: 'ok', canWrite: true } }),
    saveFolders: async () => ({ success: true }), loadTrash: async () => ({ trash: [] }),
    getToggleShortcut: async () => ({ accelerator: 'CommandOrControl+Shift+Space', enabled: true, onboardingSeen: true }),
    getExpandedState: async () => true,
    jiraStatus: async () => ({ success: true, data: { configured: true, connected: true, accountId: 'account-1', displayName: 'Fleet User', sites: [{ id: 'site', name: 'Fleet', url: 'https://fleet.atlassian.net' }], activeSite: { id: 'site', name: 'Fleet', url: 'https://fleet.atlassian.net' } } }),
    jiraCurrentSprint: async () => ({ success: true, data: { groups: [{ sprint: issue.activeSprint, project: issue.project, issues: [issue] }], total: 1 } }),
    jiraIssue: async () => ({ success: true, data: issue }),
    jiraUpdateIssue: async (_key, fields) => { savedBeforeTransition = fields; return { success: true, data: issue }; },
    jiraTransition: async submission => { submissions.push(submission); return { success: true, data: issue }; },
    jiraOpenIssue: async () => ({ success: true, data: { success: true } }),
    onDockChanged() {}, onStorageSaveError() {}, onPrepareToQuit() {}, onExpansionState() {},
    onOpenView() {}, onRequestBackupExport() {}, onUpdateStatus() {},
    setDockPreferences: async () => ({ success: true }), getUpdatePreferences: async () => ({ enabled: false })
  };
  window.eval(fs.readFileSync(path.join(root, 'renderer', 'security.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8'));
  await tick(); await tick();
  window.document.getElementById('btn-jira').click();
  await tick(); await tick();
  window.document.querySelector('.jira-card').click();
  await tick(); await tick();

  assert.ok(window.document.querySelector('.jira-status-control'));
  assert.ok(window.document.querySelector('.jira-detail-heading-actions .jira-status-control'));
  assert.ok(window.document.querySelector('.jira-status-control > .jira-status-button'));
  assert.equal(window.document.querySelector('.jira-status-control > .jira-status'), null);
  assert.equal(window.document.querySelector('.jira-transition-select'), null);
  assert.doesNotMatch(window.document.querySelector('.jira-issue-detail').textContent, /Workflow/);
  assert.equal(window.document.querySelector('.jira-save-issue').disabled, true);
  assert.ok(window.document.querySelector('[data-unsupported-field="customfield_10042"]'));
  const start = window.document.querySelector('[data-transition-id="11"]');
  assert.match(start.textContent, /Start work/);
  assert.match(start.textContent, /In Progress/);
  start.click();
  await tick(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(submissions[0])), {
    issueKey: 'SIDE-2', transitionId: '11', fields: {}, expectedUpdated: issue.updated
  });

  const summary = window.document.querySelector('[data-jira-field="summary"]');
  summary.value = 'Ship workflow controls safely';
  summary.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(window.document.querySelector('.jira-save-issue').disabled, false);
  window.document.querySelector('[data-transition-id="31"]').click();
  assert.match(window.document.querySelector('.confirm-dialog').textContent, /Save issue changes first/);
  window.document.querySelector('.confirm-dialog .primary').click();
  await tick(); await tick();
  assert.equal(savedBeforeTransition.summary, 'Ship workflow controls safely');
  const dialog = window.document.querySelector('.jira-transition-dialog');
  assert.ok(dialog);
  assert.match(dialog.textContent, /Resolution/);
  assert.match(dialog.textContent, /Start date/);
  dialog.querySelector('[data-jira-field="resolution"]').value = '0';
  dialog.querySelector('[data-jira-field="customfield_10100"]').value = '2026-08-23';
  dialog.querySelector('#jira-transition-comment').value = 'Ready to close';
  dialog.querySelector('.jira-transition-submit').click();
  await tick(); await tick();
  assert.equal(submissions[1].transitionId, '31');
  assert.equal(submissions[1].fields.resolution.id, '1');
  assert.equal(submissions[1].fields.customfield_10100, '2026-08-23');
  assert.equal(submissions[1].comment, 'Ready to close');
  dom.window.close();
});

test('Jira comment composer visibly locks repeated submissions and keeps the draft on failure', async () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///renderer/index.html', pretendToBeVisual: true });
  const { window } = dom;
  window.marked = marked;
  window.DOMPurify = createDOMPurify(window);
  const issue = {
    key: 'SIDE-3', summary: 'Protect comments', updated: '2026-08-23T12:00:00.000Z',
    status: { name: 'Open', category: 'new' }, issueType: { name: 'Bug' }, project: { key: 'FLEET', name: 'Fleet' },
    activeSprint: { id: '1', name: 'Sprint 1' }, estimate: {}, editableFields: [], comments: [], transitions: [], subtasks: [], attachments: [], allFields: [], fields: [], fieldMapping: {}
  };
  let rejectComment;
  let commentCalls = 0;
  window.electronAPI = {
    loadFolders: async () => ({ folders: [], settings: {}, storage: { state: 'ok', canWrite: true } }),
    saveFolders: async () => ({ success: true }), loadTrash: async () => ({ trash: [] }),
    getToggleShortcut: async () => ({ accelerator: 'CommandOrControl+Shift+Space', enabled: true, onboardingSeen: true }), getExpandedState: async () => true,
    jiraStatus: async () => ({ success: true, data: { configured: true, connected: true, accountId: 'account-1', sites: [{ id: 'site', name: 'Fleet', url: 'https://fleet.atlassian.net' }], activeSite: { id: 'site', name: 'Fleet', url: 'https://fleet.atlassian.net' } } }),
    jiraCurrentSprint: async () => ({ success: true, data: { groups: [{ sprint: issue.activeSprint, project: issue.project, issues: [issue] }], total: 1 } }),
    jiraIssue: async () => ({ success: true, data: issue }),
    jiraAddComment: async () => { commentCalls++; return new Promise((_resolve, reject) => { rejectComment = reject; }); },
    onDockChanged() {}, onStorageSaveError() {}, onPrepareToQuit() {}, onExpansionState() {}, onOpenView() {}, onRequestBackupExport() {}, onUpdateStatus() {},
    setDockPreferences: async () => ({ success: true }), getUpdatePreferences: async () => ({ enabled: false })
  };
  window.eval(fs.readFileSync(path.join(root, 'renderer', 'security.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8'));
  await tick(); await tick();
  window.document.getElementById('btn-jira').click(); await tick(); await tick();
  window.document.querySelector('.jira-card').click(); await tick(); await tick();
  const input = window.document.querySelector('.jira-comment-input');
  const button = window.document.querySelector('.jira-add-comment-btn');
  input.value = 'Please keep this draft';
  button.click();
  button.click();
  assert.equal(commentCalls, 1);
  assert.equal(input.disabled, true);
  assert.match(button.textContent, /Posting/);
  assert.equal(button.closest('.jira-comment-composer').getAttribute('aria-busy'), 'true');
  const error = new Error('Jira failed');
  error.code = 'JIRA_ERROR';
  rejectComment(error);
  await tick(); await tick();
  assert.equal(input.disabled, false);
  assert.equal(input.value, 'Please keep this draft');
  assert.equal(button.disabled, false);
  dom.window.close();
});
