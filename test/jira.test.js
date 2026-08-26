const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JiraClient, normalizeJiraSiteUrl } = require('../jira-client');
const { CURRENT_SPRINT_JQL, currentSprintJql, suggestBranchName } = require('../jira-normalize');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(Buffer.from(value).toString('base64')),
    decryptString: value => Buffer.from(value.toString(), 'base64').toString()
  };
}

function configuredClient(fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-jira-feature-'));
  const client = new JiraClient({
    userDataPath: directory, safeStorage: fakeSafeStorage(), shell: { openExternal: async () => {} }, fetchImpl
  });
  client.saveCredentials({
    siteUrl: 'https://example.atlassian.net', email: 'user@example.com', apiToken: 'token_12345678901234567890'
  });
  return client;
}

function jsonResponse(payload, status = 200) {
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status, headers: { 'content-type': 'application/json' }
  });
}

test('local Jira connection accepts only an Atlassian Cloud site origin', () => {
  assert.equal(normalizeJiraSiteUrl('https://Example.atlassian.net/browse/SIDE-1'), 'https://example.atlassian.net');
  assert.equal(normalizeJiraSiteUrl('http://example.atlassian.net'), null);
  assert.equal(normalizeJiraSiteUrl('https://atlassian.net.evil.example'), null);
  assert.equal(normalizeJiraSiteUrl('https://user:secret@example.atlassian.net'), null);
});

test('active-sprint JQL is constructed only from validated monitored account ids', () => {
  assert.equal(currentSprintJql([]), CURRENT_SPRINT_JQL);
  assert.equal(currentSprintJql([{ accountId: 'account:123' }, { accountId: 'abc-456' }]),
    '(assignee = currentUser() OR assignee in ("account:123", "abc-456")) AND sprint in openSprints() ORDER BY Rank ASC, updated DESC');
  assert.equal(currentSprintJql([{ accountId: 'abc") OR project is not EMPTY' }]), CURRENT_SPRINT_JQL);
});

test('suggested Jira branch names preserve the key and safely slugify the summary', () => {
  assert.equal(
    suggestBranchName('enip-17127', 'Tone Selection Scoped by Response Mode'),
    'ENIP-17127-tone-selection-scoped-by-response-mode'
  );
  assert.equal(suggestBranchName('SIDE-2', '  Café   login — déjà vu!  '), 'SIDE-2-cafe-login-deja-vu');
  assert.equal(suggestBranchName('SIDE-3', 'Straße & Æther'), 'SIDE-3-strasse-aether');
  assert.equal(suggestBranchName('SIDE-4', ''), 'SIDE-4');
  assert.equal(suggestBranchName('SIDE-5', '日本語だけ'), 'SIDE-5');
  const longName = suggestBranchName('SIDE-6', `Long ${'summary '.repeat(80)}`);
  assert.equal(longName.length, 200);
  assert.match(longName, /^SIDE-6-long-summary/);
  assert.doesNotMatch(longName, /-$/);
});

test('obsolete broker files and device sessions are removed', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'jira-broker')), false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-jira-migration-'));
  const oldSession = path.join(directory, 'jira-session.bin');
  fs.writeFileSync(oldSession, 'obsolete');
  new JiraClient({
    userDataPath: directory, safeStorage: fakeSafeStorage(), shell: { openExternal: async () => {} },
    fetchImpl: async () => { throw new Error('unused'); }
  });
  assert.equal(fs.existsSync(oldSession), false);
});

test('local Jira credentials are verified directly and encrypted outside note storage', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-jira-local-'));
  const calls = [];
  const client = new JiraClient({
    userDataPath: directory, safeStorage: fakeSafeStorage(), shell: { openExternal: async () => {} },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ accountId: 'account-1', displayName: 'Fleet User' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
  });
  const apiToken = 'token_12345678901234567890';
  const session = await client.connect({ siteUrl: 'https://example.atlassian.net', email: 'user@example.com', apiToken });
  assert.equal(session.connected, true);
  assert.equal(session.connectionMode, 'api-token');
  assert.equal(calls[0].url, 'https://example.atlassian.net/rest/api/3/myself');
  assert.match(calls[0].options.headers.authorization, /^Basic /);
  const credentialPath = path.join(directory, 'jira-credentials.bin');
  assert.equal(fs.existsSync(credentialPath), true);
  assert.equal(fs.existsSync(path.join(directory, 'fleet-data.json')), false);
  assert.equal(fs.readFileSync(credentialPath, 'utf8').includes(apiToken), false);
});

test('local Jira connection falls back to the Atlassian API for scoped tokens', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-jira-scoped-'));
  const urls = [];
  const cloudId = '12345678-1234-1234-1234-123456789abc';
  const client = new JiraClient({
    userDataPath: directory, safeStorage: fakeSafeStorage(), shell: { openExternal: async () => {} },
    fetchImpl: async url => {
      urls.push(url);
      if (url.endsWith('/_edge/tenant_info')) return new Response(JSON.stringify({ cloudId }), { status: 200 });
      if (url.startsWith('https://api.atlassian.com/')) return new Response(JSON.stringify({ accountId: 'a1', displayName: 'Scoped User' }), { status: 200 });
      return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
    }
  });
  const session = await client.connect({
    siteUrl: 'https://example.atlassian.net', email: 'user@example.com', apiToken: 'token_12345678901234567890'
  });
  assert.equal(session.connected, true);
  assert.deepEqual(urls, [
    'https://example.atlassian.net/rest/api/3/myself',
    'https://example.atlassian.net/_edge/tenant_info',
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`
  ]);
  assert.equal(client.loadCredentials().apiBase, 'scoped');
});

test('monitored teammates come from Jira picker results and persist without email data', async () => {
  const client = configuredClient(async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/myself')) return jsonResponse({ accountId: 'account-me', displayName: 'Me' });
    if (pathname.endsWith('/user/picker')) return jsonResponse({ users: [
      { accountId: 'account-me', displayName: 'Me', accountType: 'atlassian' },
      { accountId: 'account-alice', displayName: 'Alice Manager', emailAddress: 'alice@example.com', accountType: 'atlassian' },
      { accountId: 'app-bot', displayName: 'Automation', accountType: 'app' }
    ] });
    throw new Error(`Unexpected Jira request: ${url}`);
  });
  const found = await client.searchUsers('Alice');
  assert.deepEqual(found.users, [{ accountId: 'account-alice', displayName: 'Alice Manager' }]);
  const saved = await client.saveMonitoredUsers(['account-alice']);
  assert.deepEqual(saved.monitoredUsers, found.users);
  assert.deepEqual(client.loadCredentials().monitoredUsers, found.users);
  assert.equal(JSON.stringify(client.loadCredentials().monitoredUsers).includes('alice@example.com'), false);
  await assert.rejects(client.saveMonitoredUsers(Array.from({ length: 11 }, (_, index) => `account-${index}`)), error => error.code === 'VALIDATION_ERROR');
});

test('Jira teammate search normalizes empty, permission, rate-limit, and offline states', async () => {
  const scenarios = [
    { response: () => jsonResponse({ users: [] }), expected: 'empty' },
    { response: () => jsonResponse({ errorMessages: ['Not allowed'] }, 403), expected: 'PERMISSION_DENIED' },
    { response: () => new Response(JSON.stringify({ errorMessages: ['Slow down'] }), { status: 429, headers: { 'retry-after': '7' } }), expected: 'RATE_LIMITED' },
    { response: () => { throw new Error('offline'); }, expected: 'OFFLINE' }
  ];
  for (const scenario of scenarios) {
    const client = configuredClient(async () => scenario.response());
    client.currentUser = { accountId: 'account-me', displayName: 'Me' };
    if (scenario.expected === 'empty') {
      assert.deepEqual(await client.searchUsers('Nobody'), { users: [], exactMatchMayBeRequired: true });
    } else {
      await assert.rejects(client.searchUsers('Nobody'), error => error.code === scenario.expected);
    }
  }
});

test('current sprint query includes saved teammates and remains main-process constructed', async () => {
  let searchBody = null;
  const client = configuredClient(async (url, options) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/field')) return jsonResponse([]);
    if (pathname.endsWith('/search/jql')) {
      searchBody = JSON.parse(options.body);
      return jsonResponse({ issues: [] });
    }
    throw new Error(`Unexpected Jira request: ${options.method} ${pathname}`);
  });
  client.saveCredentials({ ...client.loadCredentials(), monitoredUsers: [{ accountId: 'account-alice', displayName: 'Alice' }] });
  const result = await client.currentSprint();
  assert.match(searchBody.jql, /assignee in \("account-alice"\)/);
  assert.deepEqual(result.monitoredUsers, [{ accountId: 'account-alice', displayName: 'Alice' }]);
});

test('Jira client rejects arbitrary issue paths and comment ids before network access', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-jira-'));
  let calls = 0;
  const client = new JiraClient({
    userDataPath: directory, safeStorage: fakeSafeStorage(), shell: { openExternal: async () => {} },
    fetchImpl: async () => { calls++; throw new Error('unexpected'); }
  });
  assert.throws(() => client.issue('../admin'), /Invalid Jira issue key/);
  assert.throws(() => client.deleteComment('SIDE-1', '../2'), /Invalid Jira comment request/);
  assert.equal(calls, 0);
});

test('renderer keeps Jira networking behind typed IPC', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(preload, /jiraCurrentSprint/);
  assert.match(preload, /jiraSearchUsers/);
  assert.match(preload, /jiraSaveMonitoredUsers/);
  assert.match(preload, /jiraUpdateIssue/);
  assert.match(html, /connect-src 'none'/);
  assert.match(main, /handleJira\(event/);
  assert.match(preload, /jiraConnect/);
  assert.match(preload, /jiraOpenTokenPage/);
  assert.doesNotMatch(preload, /jiraToken|clientSecret|password/i);
});

test('Jira UI is a separate view and does not extend the local note schema', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(html, /id="btn-jira"/);
  assert.match(html, /id="jira-list-view"/);
  assert.match(renderer, /currentView = 'jira-list'/);
  assert.match(renderer, /jiraTransition/);
  assert.doesNotMatch(main.slice(main.indexOf('function normalizeData'), main.indexOf('const store =')), /jira/i);
});

test('Jira transitions retain screen metadata and submit validated fields and comments', async () => {
  const revision = '2026-08-23T12:00:00.000Z';
  let transitionBody = null;
  const transition = {
    id: '31', name: 'Close issue', hasScreen: true,
    to: { id: '10002', name: 'Done', statusCategory: { key: 'done' } },
    fields: {
      resolution: { name: 'Resolution', required: true, schema: { type: 'resolution' }, allowedValues: [{ id: '1', name: 'Fixed' }] },
      customfield_10100: { name: 'Start date', required: true, schema: { type: 'date' } },
      fixVersions: { name: 'Fix versions', required: false, schema: { type: 'array', items: 'version' }, allowedValues: [{ id: '7', name: '1.0' }] },
      comment: { name: 'Comment', required: false, schema: { type: 'string' }, operations: ['add'] }
    }
  };
  const client = configuredClient(async (url, options) => {
    const pathname = new URL(url).pathname + new URL(url).search;
    if (options.method === 'POST' && pathname.endsWith('/transitions')) {
      transitionBody = JSON.parse(options.body);
      return jsonResponse(undefined, 204);
    }
    if (pathname.includes('?fields=updated')) return jsonResponse({ fields: { updated: revision } });
    if (pathname.endsWith('/rest/api/3/field')) return jsonResponse([]);
    if (pathname.includes('/transitions?expand=')) return jsonResponse({ transitions: [transition] });
    if (pathname.includes('?fields=*all')) return jsonResponse({ id: '1', key: 'SIDE-1', fields: { summary: 'Issue', updated: revision } });
    if (pathname.endsWith('/editmeta')) return jsonResponse({ fields: {} });
    if (pathname.includes('/comment?')) return jsonResponse({ comments: [] });
    throw new Error(`Unexpected Jira request: ${options.method} ${pathname}`);
  });

  const detail = await client.transition({
    issueKey: 'SIDE-1', transitionId: '31', expectedUpdated: revision,
    fields: { resolution: { id: '1' }, customfield_10100: '2026-08-23', fixVersions: [{ id: '7' }] },
    comment: 'Ready to close.'
  });

  assert.deepEqual(transitionBody.transition, { id: '31' });
  assert.deepEqual(transitionBody.fields, {
    resolution: { id: '1' }, customfield_10100: '2026-08-23', fixVersions: [{ id: '7' }]
  });
  assert.equal(transitionBody.update.comment[0].add.body.type, 'doc');
  assert.equal(detail.transitions[0].to.category, 'done');
  assert.equal(detail.transitions[0].fields.find(field => field.id === 'resolution').required, true);
  assert.equal(detail.transitions[0].fields.find(field => field.id === 'comment').value, '');
  assert.equal(detail.suggestedBranchName, 'SIDE-1-issue');
});

test('stale Jira transitions are rejected before a write', async () => {
  let writes = 0;
  const client = configuredClient(async (_url, options) => {
    if (options.method === 'POST') writes++;
    return jsonResponse({ fields: { updated: '2026-08-23T13:00:00.000Z' } });
  });
  await assert.rejects(client.transition({
    issueKey: 'SIDE-1', transitionId: '31', expectedUpdated: '2026-08-23T12:00:00.000Z', fields: {}
  }), error => error.code === 'CONFLICT');
  assert.equal(writes, 0);
});

test('issue updates reject fields Jira exposes without a set operation', async () => {
  const revision = '2026-08-23T12:00:00.000Z';
  let writes = 0;
  const client = configuredClient(async (url, options) => {
    const pathname = new URL(url).pathname + new URL(url).search;
    if (options.method === 'PUT') writes++;
    if (pathname.includes('?fields=updated')) return jsonResponse({ fields: { updated: revision } });
    if (pathname.endsWith('/editmeta')) return jsonResponse({ fields: {
      customfield_10042: { name: 'Product themes', operations: ['add', 'remove'], schema: { type: 'array' } }
    } });
    throw new Error(`Unexpected Jira request: ${options.method} ${pathname}`);
  });
  await assert.rejects(client.updateIssue('SIDE-1', { customfield_10042: [] }, revision), error => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    return /not editable/.test(error.message);
  });
  assert.equal(writes, 0);
});

test('repeated add-comment requests are locked per issue', async () => {
  let resolvePost;
  let addRequests = 0;
  const posted = new Promise(resolve => { resolvePost = resolve; });
  const client = configuredClient(async (url, options) => {
    const pathname = new URL(url).pathname + new URL(url).search;
    if (options.method === 'POST' && /\/comment$/.test(pathname)) {
      addRequests++;
      await posted;
      return jsonResponse({ id: '9' }, 201);
    }
    if (pathname.endsWith('/rest/api/3/field')) return jsonResponse([]);
    if (pathname.includes('?fields=*all')) return jsonResponse({ id: '1', key: 'SIDE-1', fields: { summary: 'Issue' } });
    if (pathname.endsWith('/editmeta')) return jsonResponse({ fields: {} });
    if (pathname.includes('/transitions?expand=')) return jsonResponse({ transitions: [] });
    if (pathname.includes('/comment?')) return jsonResponse({ comments: [] });
    throw new Error(`Unexpected Jira request: ${options.method} ${pathname}`);
  });
  const first = client.addComment('SIDE-1', 'Only once');
  assert.throws(() => client.addComment('SIDE-1', 'Only once'), error => error.code === 'REQUEST_IN_PROGRESS');
  resolvePost();
  await first;
  assert.equal(addRequests, 1);
});
