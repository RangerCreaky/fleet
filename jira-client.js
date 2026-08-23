const fs = require('node:fs');
const path = require('node:path');
const {
  JIRA_ACCOUNT_ID_RE, currentSprintJql, textToAdf, discoverFields, normalizeIssue,
  normalizeEditableFields, normalizeTransitionFields, groupIssues, validateUpdateFields
} = require('./jira-normalize');

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{0,29}-[1-9][0-9]{0,11}$/i;
const COMMENT_ID_RE = /^[1-9][0-9]{0,18}$/;
const TRANSITION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const EMAIL_RE = /^[^\s@]{1,200}@[^\s@]{1,200}$/;
const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const MAX_MONITORED_USERS = 10;

class JiraClientError extends Error {
  constructor(code, message, retryAfter = null) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function normalizeJiraSiteUrl(raw) {
  try {
    const parsed = new URL(String(raw || '').trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
    if (!/^[a-z0-9-]+\.atlassian\.net$/i.test(parsed.hostname)) return null;
    return `https://${parsed.hostname.toLowerCase()}`;
  } catch { return null; }
}

function normalizeMonitoredUsers(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const users = [];
  for (const item of value) {
    const accountId = typeof item?.accountId === 'string' ? item.accountId.trim() : '';
    const displayName = typeof item?.displayName === 'string' ? item.displayName.trim().slice(0, 200) : '';
    if (!JIRA_ACCOUNT_ID_RE.test(accountId) || !displayName || seen.has(accountId)) continue;
    seen.add(accountId);
    users.push({ accountId, displayName });
    if (users.length === MAX_MONITORED_USERS) break;
  }
  return users;
}

function validateCredentials(input) {
  const siteUrl = normalizeJiraSiteUrl(input?.siteUrl);
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  const apiToken = typeof input?.apiToken === 'string' ? input.apiToken.trim() : '';
  if (!siteUrl) throw new JiraClientError('VALIDATION_ERROR', 'Enter your Jira Cloud URL, such as https://company.atlassian.net.');
  if (!EMAIL_RE.test(email) || email.length > 254) throw new JiraClientError('VALIDATION_ERROR', 'Enter the email address for your Atlassian account.');
  if (apiToken.length < 20 || apiToken.length > 512 || /\s/.test(apiToken)) {
    throw new JiraClientError('VALIDATION_ERROR', 'Enter a valid Atlassian API token. Jira passwords are not supported.');
  }
  const cloudId = typeof input?.cloudId === 'string' && /^[a-f0-9-]{20,80}$/i.test(input.cloudId) ? input.cloudId : '';
  const apiBase = input?.apiBase === 'scoped' && cloudId ? 'scoped' : 'site';
  return { siteUrl, email, apiToken, cloudId, apiBase, fieldMapping: {}, monitoredUsers: [] };
}

function atlassianError(status, payload, retryAfter) {
  const message = payload?.errorMessages?.[0] || (payload?.errors && Object.values(payload.errors)[0])
    || payload?.message || 'Jira could not complete that request.';
  if (status === 401) return new JiraClientError('SESSION_EXPIRED', 'The Jira email or API token was rejected. Connect again.');
  if (status === 403) return new JiraClientError('PERMISSION_DENIED', String(message));
  if (status === 404) return new JiraClientError('NOT_FOUND', String(message));
  if (status === 429) return new JiraClientError('RATE_LIMITED', 'Jira is rate limiting requests. Try again shortly.', Number(retryAfter) || 30);
  if (status >= 400 && status < 500) return new JiraClientError('VALIDATION_ERROR', String(message));
  return new JiraClientError('JIRA_ERROR', String(message));
}

function jiraOptionKey(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  return String(value.accountId || value.id || value.value || value.name || value.key || '');
}

function canonicalJiraOption(value) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (value.accountId) return { accountId: String(value.accountId) };
  if (value.id !== undefined && value.id !== null) return { id: String(value.id) };
  if (value.value !== undefined) return { value: value.value };
  if (value.name !== undefined) return { name: value.name };
  if (value.key !== undefined) return { key: value.key };
  throw new JiraClientError('VALIDATION_ERROR', 'Choose a valid Jira field value.');
}

function isEmptyTransitionValue(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.values(value).every(isEmptyTransitionValue);
  return false;
}

function prepareTransitionField(id, meta, value) {
  const schema = meta?.schema || {};
  const allowed = Array.isArray(meta?.allowedValues) ? meta.allowedValues : [];
  if (allowed.length) {
    if (isEmptyTransitionValue(value)) return schema.type === 'array' ? [] : null;
    const requested = schema.type === 'array' ? (Array.isArray(value) ? value : []) : [value];
    const selected = requested.map(item => {
      const key = jiraOptionKey(item);
      const match = allowed.find(option => jiraOptionKey(option) === key);
      if (!match) throw new JiraClientError('VALIDATION_ERROR', `${meta.name || id} contains an unavailable value.`);
      return canonicalJiraOption(match);
    });
    return schema.type === 'array' ? selected : (selected[0] ?? null);
  }
  if (schema.type === 'number') {
    if (value === null || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new JiraClientError('VALIDATION_ERROR', `${meta.name || id} must be a number.`);
    return number;
  }
  if (schema.type === 'date') {
    if (value === null || value === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new JiraClientError('VALIDATION_ERROR', `${meta.name || id} must be a date.`);
    return String(value);
  }
  if (schema.type === 'datetime') {
    if (value === null || value === '') return null;
    if (Number.isNaN(Date.parse(value))) throw new JiraClientError('VALIDATION_ERROR', `${meta.name || id} must be a date and time.`);
    return new Date(value).toISOString();
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 500) throw new JiraClientError('VALIDATION_ERROR', `${meta.name || id} must be a list.`);
    return value.map(item => typeof item === 'string' ? item.slice(0, 500) : canonicalJiraOption(item));
  }
  if (schema.type === 'string' || ['description', 'environment'].includes(id) || /textarea/i.test(schema.custom || '')) {
    const text = value === null || value === undefined ? '' : String(value);
    if (text.length > 200_000) throw new JiraClientError('VALIDATION_ERROR', `${meta.name || id} is too long.`);
    return ['description', 'environment'].includes(id) || /textarea/i.test(schema.custom || '') ? textToAdf(text) : text;
  }
  if (schema.type === 'timetracking' || id === 'timetracking') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JiraClientError('VALIDATION_ERROR', 'Invalid time tracking values.');
    return {
      originalEstimate: String(value.originalEstimate || '').slice(0, 100),
      remainingEstimate: String(value.remainingEstimate || '').slice(0, 100)
    };
  }
  throw new JiraClientError('VALIDATION_ERROR', `${meta.name || id} must be completed in Jira.`);
}

class JiraClient {
  constructor({ userDataPath, safeStorage, shell, fetchImpl = globalThis.fetch }) {
    this.credentialsPath = path.join(userDataPath, 'jira-credentials.bin');
    this.safeStorage = safeStorage;
    this.shell = shell;
    this.fetch = fetchImpl;
    this.fieldCache = null;
    this.writeLocks = new Set();
    this.userSearchCache = new Map();
    this.currentUser = null;
    // Remove an obsolete OAuth-broker session left by a pre-local build.
    try { fs.unlinkSync(path.join(userDataPath, 'jira-session.bin')); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  isConfigured() { return true; }

  loadCredentials() {
    if (!this.safeStorage.isEncryptionAvailable() || !fs.existsSync(this.credentialsPath)) return null;
    try {
      const value = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.credentialsPath)));
      const credentials = validateCredentials(value);
      credentials.fieldMapping = value.fieldMapping && typeof value.fieldMapping === 'object' ? value.fieldMapping : {};
      credentials.monitoredUsers = normalizeMonitoredUsers(value.monitoredUsers);
      return credentials;
    } catch { return null; }
  }

  saveCredentials(credentials) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new JiraClientError('NOT_CONFIGURED', 'Secure credential storage is unavailable on this Mac.');
    const validated = validateCredentials(credentials);
    validated.fieldMapping = credentials.fieldMapping && typeof credentials.fieldMapping === 'object' ? credentials.fieldMapping : {};
    validated.monitoredUsers = normalizeMonitoredUsers(credentials.monitoredUsers);
    const encrypted = this.safeStorage.encryptString(JSON.stringify(validated));
    const temporary = `${this.credentialsPath}.tmp`;
    fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
    fs.renameSync(temporary, this.credentialsPath);
    try { fs.chmodSync(this.credentialsPath, 0o600); } catch {}
  }

  clearCredentials() {
    try { if (fs.existsSync(this.credentialsPath)) fs.unlinkSync(this.credentialsPath); } catch {}
    this.fieldCache = null;
    this.userSearchCache.clear();
    this.currentUser = null;
  }

  runWriteLocked(lockKey, operation) {
    if (this.writeLocks.has(lockKey)) throw new JiraClientError('REQUEST_IN_PROGRESS', 'That Jira update is already in progress.');
    this.writeLocks.add(lockKey);
    return Promise.resolve().then(operation).finally(() => this.writeLocks.delete(lockKey));
  }

  async request(method, pathname, body, { credentials: supplied, timeout = 25_000 } = {}) {
    const credentials = supplied || this.loadCredentials();
    if (!credentials) throw new JiraClientError('NOT_CONNECTED', 'Connect Jira with an API token to continue.');
    if (typeof pathname !== 'string' || !pathname.startsWith('/rest/api/3/')) throw new JiraClientError('VALIDATION_ERROR', 'Invalid Jira operation.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      const baseUrl = credentials.apiBase === 'scoped' && credentials.cloudId
        ? `https://api.atlassian.com/ex/jira/${encodeURIComponent(credentials.cloudId)}`
        : credentials.siteUrl;
      response = await this.fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64')}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal
      });
    } catch (error) {
      throw new JiraClientError('OFFLINE', error?.name === 'AbortError' ? 'The Jira request timed out.' : 'Could not reach your Jira Cloud site.');
    } finally { clearTimeout(timer); }
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_RESPONSE_BYTES) throw new JiraClientError('JIRA_ERROR', 'Jira returned too much data.');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new JiraClientError('JIRA_ERROR', 'Jira returned too much data.');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw atlassianError(response.status, payload, response.headers.get('retry-after'));
    return payload;
  }

  sessionFor(user, credentials) {
    const siteName = new URL(credentials.siteUrl).hostname.replace(/\.atlassian\.net$/i, '');
    const site = { id: credentials.siteUrl, name: siteName, url: credentials.siteUrl };
    return {
      configured: true, connected: true, connectionMode: 'api-token', accountId: user.accountId || '',
      displayName: user.displayName || credentials.email, sites: [site], activeSite: site,
      fieldMapping: credentials.fieldMapping || {}, monitoredUsers: credentials.monitoredUsers || []
    };
  }

  async status() {
    const credentials = this.loadCredentials();
    if (!credentials) return { configured: true, connected: false, connectionMode: 'api-token' };
    try {
      const user = await this.request('GET', '/rest/api/3/myself', undefined, { credentials });
      this.currentUser = { accountId: user?.accountId || '', displayName: user?.displayName || credentials.email };
      return this.sessionFor(user || {}, credentials);
    } catch (error) {
      if (error.code === 'SESSION_EXPIRED') {
        this.clearCredentials();
        return { configured: true, connected: false, connectionMode: 'api-token', error: 'SESSION_EXPIRED' };
      }
      throw error;
    }
  }

  async connect(input) {
    let credentials = validateCredentials(input);
    let user;
    try {
      user = await this.request('GET', '/rest/api/3/myself', undefined, { credentials });
    } catch (error) {
      if (error.code !== 'SESSION_EXPIRED') throw error;
      const tenant = await this.tenantInfo(credentials.siteUrl);
      credentials = { ...credentials, cloudId: tenant.cloudId, apiBase: 'scoped' };
      user = await this.request('GET', '/rest/api/3/myself', undefined, { credentials });
    }
    this.currentUser = { accountId: user?.accountId || '', displayName: user?.displayName || credentials.email };
    this.saveCredentials(credentials);
    return this.sessionFor(user || {}, credentials);
  }

  async tenantInfo(siteUrl) {
    let response;
    try {
      response = await this.fetch(`${siteUrl}/_edge/tenant_info`, {
        method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new JiraClientError('OFFLINE', 'Could not retrieve the Jira Cloud site identifier.');
    }
    let payload = null;
    try { payload = JSON.parse(await response.text()); } catch {}
    if (!response.ok || !/^[a-f0-9-]{20,80}$/i.test(payload?.cloudId || '')) {
      throw new JiraClientError('SESSION_EXPIRED', 'The Jira email or API token was rejected. Connect again.');
    }
    return { cloudId: payload.cloudId };
  }

  async disconnect() { this.clearCredentials(); return { success: true }; }

  async selectSite(siteId) {
    const status = await this.status();
    if (!status.connected || siteId !== status.activeSite?.id) throw new JiraClientError('VALIDATION_ERROR', 'Invalid Jira site.');
    return status;
  }

  async ensureCurrentUser(credentials = this.loadCredentials()) {
    if (this.currentUser?.accountId) return this.currentUser;
    const user = await this.request('GET', '/rest/api/3/myself', undefined, { credentials });
    this.currentUser = { accountId: user?.accountId || '', displayName: user?.displayName || credentials?.email || 'You' };
    return this.currentUser;
  }

  async searchUsers(rawQuery) {
    const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    if (query.length < 2 || query.length > 100 || /[\u0000-\u001F\u007F]/.test(query)) {
      throw new JiraClientError('VALIDATION_ERROR', 'Enter at least two characters of a teammate’s name.');
    }
    const credentials = this.loadCredentials();
    if (!credentials) throw new JiraClientError('NOT_CONNECTED', 'Connect Jira to continue.');
    const currentUser = await this.ensureCurrentUser(credentials);
    const excluded = new Set([currentUser.accountId, ...(credentials.monitoredUsers || []).map(user => user.accountId)]);
    const parameters = new URLSearchParams({ query, maxResults: '20', showAvatar: 'false', excludeConnectUsers: 'true' });
    excluded.forEach(accountId => { if (accountId) parameters.append('excludeAccountIds', accountId); });
    const payload = await this.request('GET', `/rest/api/3/user/picker?${parameters.toString()}`);
    const users = [];
    const seen = new Set();
    for (const item of Array.isArray(payload?.users) ? payload.users : []) {
      const accountId = typeof item?.accountId === 'string' ? item.accountId.trim() : '';
      const displayName = typeof item?.displayName === 'string' ? item.displayName.trim().slice(0, 200) : '';
      if (!JIRA_ACCOUNT_ID_RE.test(accountId) || !displayName || item.active === false || item.accountType && item.accountType !== 'atlassian'
        || excluded.has(accountId) || seen.has(accountId)) continue;
      const user = { accountId, displayName };
      users.push(user);
      seen.add(accountId);
      this.userSearchCache.set(accountId, user);
      if (users.length === 20) break;
    }
    return { users, exactMatchMayBeRequired: users.length === 0 };
  }

  async saveMonitoredUsers(accountIds) {
    if (!Array.isArray(accountIds) || accountIds.length > MAX_MONITORED_USERS) {
      throw new JiraClientError('VALIDATION_ERROR', `Choose up to ${MAX_MONITORED_USERS} teammates.`);
    }
    const credentials = this.loadCredentials();
    if (!credentials) throw new JiraClientError('NOT_CONNECTED', 'Connect Jira to continue.');
    const currentUser = await this.ensureCurrentUser(credentials);
    const existing = new Map((credentials.monitoredUsers || []).map(user => [user.accountId, user]));
    const monitoredUsers = [];
    const seen = new Set();
    for (const rawId of accountIds) {
      const accountId = typeof rawId === 'string' ? rawId.trim() : '';
      if (!JIRA_ACCOUNT_ID_RE.test(accountId) || accountId === currentUser.accountId || seen.has(accountId)) {
        throw new JiraClientError('VALIDATION_ERROR', 'The monitored teammate list is invalid.');
      }
      const user = this.userSearchCache.get(accountId) || existing.get(accountId);
      if (!user) throw new JiraClientError('VALIDATION_ERROR', 'Search for a teammate before adding them.');
      monitoredUsers.push({ accountId: user.accountId, displayName: user.displayName });
      seen.add(accountId);
    }
    this.saveCredentials({ ...credentials, monitoredUsers });
    return { monitoredUsers };
  }

  async fields() {
    const credentials = this.loadCredentials();
    if (!credentials) throw new JiraClientError('NOT_CONNECTED', 'Connect Jira to continue.');
    if (this.fieldCache?.siteUrl === credentials.siteUrl && this.fieldCache.expires > Date.now()) return this.fieldCache.fields;
    const payload = await this.request('GET', '/rest/api/3/field');
    const fields = Array.isArray(payload) ? payload : [];
    this.fieldCache = { siteUrl: credentials.siteUrl, expires: Date.now() + 10 * 60_000, fields };
    return fields;
  }

  async currentSprint() {
    const credentials = this.loadCredentials();
    const fields = await this.fields();
    const jql = currentSprintJql(credentials?.monitoredUsers || []);
    const fieldInfo = discoverFields(fields, credentials?.fieldMapping || {});
    const names = Object.fromEntries(fields.map(field => [field.id, field.name]));
    const issues = [];
    let nextPageToken;
    do {
      const payload = await this.request('POST', '/rest/api/3/search/jql', {
        jql, maxResults: 100, fields: ['*all'], expand: 'names,schema',
        ...(nextPageToken ? { nextPageToken } : {})
      });
      issues.push(...(Array.isArray(payload?.issues) ? payload.issues : []));
      nextPageToken = payload?.nextPageToken;
      if (issues.length >= 1000) break;
    } while (nextPageToken);
    const normalized = issues.map(issue => normalizeIssue(issue, fieldInfo, names));
    return {
      jql, groups: groupIssues(normalized), total: normalized.length,
      monitoredUsers: credentials?.monitoredUsers || [],
      mappingRequired: !fieldInfo.storyPoints || !fieldInfo.acceptanceCriteria,
      fieldCandidates: {
        storyPoints: fields.filter(field => /point|estimate/i.test(field.name || '')).map(field => ({ id: field.id, name: field.name })),
        acceptanceCriteria: fields.filter(field => /accept|criteria|definition of done/i.test(field.name || '')).map(field => ({ id: field.id, name: field.name }))
      }
    };
  }

  issue(issueKey) {
    if (!ISSUE_KEY_RE.test(issueKey || '')) throw new JiraClientError('VALIDATION_ERROR', 'Invalid Jira issue key.');
    return this.issueDetail(issueKey.toUpperCase());
  }

  async issueDetail(issueKey) {
    const credentials = this.loadCredentials();
    const fields = await this.fields();
    const fieldInfo = discoverFields(fields, credentials?.fieldMapping || {});
    const names = Object.fromEntries(fields.map(field => [field.id, field.name]));
    const optional = async (pathname, fallback) => {
      try { return await this.request('GET', pathname); }
      catch (error) { if (['PERMISSION_DENIED', 'NOT_FOUND'].includes(error.code)) return fallback; throw error; }
    };
    const encoded = encodeURIComponent(issueKey);
    const [issue, editmeta, transitions, comments] = await Promise.all([
      this.request('GET', `/rest/api/3/issue/${encoded}?fields=*all&expand=names,schema`),
      optional(`/rest/api/3/issue/${encoded}/editmeta`, { fields: {} }),
      optional(`/rest/api/3/issue/${encoded}/transitions?expand=transitions.fields`, { transitions: [] }),
      optional(`/rest/api/3/issue/${encoded}/comment?maxResults=100&orderBy=created`, { comments: [] })
    ]);
    const normalized = normalizeIssue(issue, fieldInfo, names);
    return {
      ...normalized,
      editableFields: normalizeEditableFields(editmeta, issue.fields || {}),
      transitions: (transitions?.transitions || []).map(item => ({
        id: String(item.id), name: item.name || 'Transition', hasScreen: item.hasScreen === true,
        to: item.to ? {
          id: String(item.to.id || ''), name: item.to.name || '',
          category: item.to.statusCategory?.key || ''
        } : null,
        fields: normalizeTransitionFields(item.fields || {}, issue.fields || {})
      })),
      comments: (comments?.comments || []).map(comment => ({
        id: String(comment.id), body: comment.body,
        author: { accountId: comment.author?.accountId || '', displayName: comment.author?.displayName || 'Unknown' },
        created: comment.created, updated: comment.updated
      })),
      fields: fields.map(field => ({ id: field.id, name: field.name, schema: field.schema || null })),
      fieldMapping: credentials?.fieldMapping || {}, browseUrl: `${credentials.siteUrl}/browse/${issueKey}`
    };
  }

  async updateIssue(issueKey, requested, expectedUpdated) {
    if (!ISSUE_KEY_RE.test(issueKey || '') || typeof expectedUpdated !== 'string' || Number.isNaN(Date.parse(expectedUpdated))) throw new JiraClientError('VALIDATION_ERROR', 'Invalid Jira issue update.');
    const key = issueKey.toUpperCase();
    const current = await this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=updated`);
    if (current?.fields?.updated !== expectedUpdated) throw new JiraClientError('CONFLICT', 'This issue changed in Jira after you opened it. Refresh before saving.');
    const editmeta = await this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/editmeta`);
    let fields;
    const settableIds = new Set(Object.entries(editmeta?.fields || {})
      .filter(([, meta]) => !Array.isArray(meta?.operations) || !meta.operations.length || meta.operations.includes('set'))
      .map(([id]) => id));
    try { fields = validateUpdateFields(requested, settableIds); }
    catch (error) { throw new JiraClientError('VALIDATION_ERROR', error.message); }
    for (const [id, value] of Object.entries(fields)) {
      const schema = editmeta?.fields?.[id]?.schema || {};
      if (typeof value === 'string' && (id === 'description' || /textarea/i.test(schema.custom || ''))) fields[id] = textToAdf(value);
    }
    await this.request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields });
    return this.issueDetail(key);
  }

  transition(submission) {
    const issueKey = submission?.issueKey;
    const transitionId = submission?.transitionId;
    const expectedUpdated = submission?.expectedUpdated;
    const requested = submission?.fields ?? {};
    const comment = submission?.comment;
    if (!ISSUE_KEY_RE.test(issueKey || '') || !TRANSITION_ID_RE.test(transitionId || '')) throw new JiraClientError('VALIDATION_ERROR', 'Invalid Jira transition.');
    if (typeof expectedUpdated !== 'string' || Number.isNaN(Date.parse(expectedUpdated))) throw new JiraClientError('VALIDATION_ERROR', 'The issue revision is required.');
    if (!requested || typeof requested !== 'object' || Array.isArray(requested) || Object.keys(requested).length > 200) throw new JiraClientError('VALIDATION_ERROR', 'Invalid transition fields.');
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > 100_000)) throw new JiraClientError('VALIDATION_ERROR', 'Invalid transition comment.');
    const key = issueKey.toUpperCase();
    return this.runWriteLocked(`transition:${key}`, async () => {
      const current = await this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=updated`);
      if (current?.fields?.updated !== expectedUpdated) throw new JiraClientError('CONFLICT', 'This issue changed in Jira after you opened it. Refresh before changing status.');
      const available = await this.request('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`);
      const selected = (available?.transitions || []).find(item => String(item.id) === transitionId);
      if (!selected) throw new JiraClientError('VALIDATION_ERROR', 'That transition is no longer available.');
      const metadata = selected.fields || {};
      const fields = {};
      for (const id of Object.keys(requested)) {
        if (id === 'comment' || !metadata[id]) throw new JiraClientError('VALIDATION_ERROR', `Field ${id} is not available for that transition.`);
        fields[id] = prepareTransitionField(id, metadata[id], requested[id]);
      }
      for (const [id, meta] of Object.entries(metadata)) {
        const value = id === 'comment' ? comment : requested[id];
        if (meta?.required === true && isEmptyTransitionValue(value)) throw new JiraClientError('VALIDATION_ERROR', `${meta.name || id} is required.`);
      }
      if (comment && !metadata.comment) throw new JiraClientError('VALIDATION_ERROR', 'A comment is not available for that transition.');
      const body = { transition: { id: transitionId } };
      if (Object.keys(fields).length) body.fields = fields;
      if (comment) body.update = { comment: [{ add: { body: textToAdf(comment.trim()) } }] };
      await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, body);
      return this.issueDetail(key);
    });
  }

  addComment(issueKey, text) { return this.commentRequest('POST', issueKey, null, text); }
  updateComment(issueKey, commentId, text) { return this.commentRequest('PUT', issueKey, commentId, text); }
  deleteComment(issueKey, commentId) { return this.commentRequest('DELETE', issueKey, commentId); }

  commentRequest(method, issueKey, commentId, text) {
    if (!ISSUE_KEY_RE.test(issueKey || '') || (commentId !== null && !COMMENT_ID_RE.test(commentId || ''))) throw new JiraClientError('VALIDATION_ERROR', 'Invalid Jira comment request.');
    if (method !== 'DELETE' && (typeof text !== 'string' || !text.trim() || text.length > 100_000)) throw new JiraClientError('VALIDATION_ERROR', 'Comment text is required.');
    const key = issueKey.toUpperCase();
    const suffix = commentId ? `/${commentId}` : '';
    const operation = () => this.request(method, `/rest/api/3/issue/${encodeURIComponent(key)}/comment${suffix}`, method === 'DELETE' ? undefined : { body: textToAdf(text.trim()) })
      .then(() => this.issueDetail(key));
    return method === 'POST' ? this.runWriteLocked(`comment:add:${key}`, operation) : operation();
  }

  async saveFieldMapping(issueKey, mapping) {
    if (!ISSUE_KEY_RE.test(issueKey || '') || !mapping || typeof mapping !== 'object') throw new JiraClientError('VALIDATION_ERROR', 'Invalid Jira field mapping.');
    const credentials = this.loadCredentials();
    if (!credentials) throw new JiraClientError('NOT_CONNECTED', 'Connect Jira to continue.');
    const ids = new Set((await this.fields()).map(field => field.id));
    const fieldMapping = {};
    for (const name of ['storyPoints', 'acceptanceCriteria']) {
      if (typeof mapping[name] === 'string' && ids.has(mapping[name])) fieldMapping[name] = mapping[name];
    }
    this.saveCredentials({ ...credentials, fieldMapping });
    return { success: true, fieldMapping };
  }

  async openIssue(issueKey) {
    if (!ISSUE_KEY_RE.test(issueKey || '')) throw new JiraClientError('VALIDATION_ERROR', 'Invalid Jira issue key.');
    const credentials = this.loadCredentials();
    if (!credentials) throw new JiraClientError('NOT_CONNECTED', 'Connect Jira to continue.');
    await this.shell.openExternal(`${credentials.siteUrl}/browse/${issueKey.toUpperCase()}`);
    return { success: true };
  }

  async openTokenPage() { await this.shell.openExternal(TOKEN_PAGE); return { success: true }; }
}

function publicJiraError(error) {
  return {
    success: false,
    error: {
      code: error instanceof JiraClientError ? error.code : 'JIRA_ERROR',
      message: error instanceof Error ? error.message : 'Jira could not complete that request.',
      retryAfter: error instanceof JiraClientError ? error.retryAfter : null
    }
  };
}

module.exports = { JiraClient, JiraClientError, normalizeJiraSiteUrl, validateCredentials, publicJiraError };
