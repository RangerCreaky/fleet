const CURRENT_SPRINT_JQL = 'assignee = currentUser() AND sprint in openSprints() ORDER BY Rank ASC, updated DESC';
const JIRA_ACCOUNT_ID_RE = /^[A-Za-z0-9:_-]{1,256}$/;

function currentSprintJql(monitoredUsers = []) {
  const ids = Array.from(new Set((Array.isArray(monitoredUsers) ? monitoredUsers : [])
    .map(user => typeof user === 'string' ? user : user?.accountId)
    .filter(id => typeof id === 'string' && JIRA_ACCOUNT_ID_RE.test(id))));
  if (!ids.length) return CURRENT_SPRINT_JQL;
  const quoted = ids.map(id => `"${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ');
  return `(assignee = currentUser() OR assignee in (${quoted})) AND sprint in openSprints() ORDER BY Rank ASC, updated DESC`;
}

function adfToText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const own = typeof value.text === 'string' ? value.text : '';
  const children = Array.isArray(value.content) ? value.content.map(adfToText).join('') : '';
  const suffix = ['paragraph', 'heading', 'listItem'].includes(value.type) ? '\n' : '';
  return `${own}${children}${suffix}`;
}

function textToAdf(text) {
  const content = String(text).replace(/\r\n/g, '\n').split('\n').map(line => ({
    type: 'paragraph', content: line ? [{ type: 'text', text: line }] : []
  }));
  return { type: 'doc', version: 1, content };
}

function discoverFields(fields, mapping = {}) {
  const sprint = fields.find(field => /gh-sprint/i.test(field.schema?.custom || ''))
    || fields.find(field => /^sprint$/i.test(field.name || ''));
  const storyPoints = fields.find(field => field.id === mapping.storyPoints)
    || fields.find(field => /story-points/i.test(field.schema?.custom || ''))
    || fields.find(field => /^story points?$/i.test(field.name || ''));
  const acceptanceCandidates = fields.filter(field => /^(acceptance criteria|acceptance criterion|ac)$/i.test(field.name || ''));
  const acceptanceCriteria = fields.find(field => field.id === mapping.acceptanceCriteria)
    || (acceptanceCandidates.length === 1 ? acceptanceCandidates[0] : undefined);
  return { sprint, storyPoints, acceptanceCriteria, acceptanceCandidates };
}

function compactUser(user) {
  return user ? {
    accountId: user.accountId || '', displayName: user.displayName || 'Unknown',
    avatarUrl: user.avatarUrls?.['24x24'] || ''
  } : null;
}

function compactNamed(value) {
  return value ? { id: String(value.id || ''), name: value.name || value.value || '' } : null;
}

function activeSprints(raw) {
  const values = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return values.filter(sprint => sprint && typeof sprint === 'object' && sprint.state === 'active')
    .map(sprint => ({
      id: String(sprint.id || ''), name: sprint.name || 'Active sprint', state: sprint.state,
      startDate: sprint.startDate || null, endDate: sprint.endDate || null, goal: sprint.goal || ''
    }));
}

function safeFieldValue(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.slice(0, 200_000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 500).map(item => safeFieldValue(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 200)) {
      if (['self', 'emailAddress'].includes(key)) continue;
      output[key] = safeFieldValue(child, depth + 1);
    }
    return output;
  }
  return null;
}

function normalizeIssue(issue, fieldInfo, names = {}) {
  const fields = issue.fields || {};
  const sprints = activeSprints(fieldInfo.sprint ? fields[fieldInfo.sprint.id] : null)
    .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
  return {
    id: String(issue.id || ''), key: String(issue.key || ''),
    summary: String(fields.summary || 'Untitled Jira issue'),
    issueType: compactNamed(fields.issuetype),
    status: fields.status ? {
      id: String(fields.status.id || ''), name: fields.status.name || '',
      category: fields.status.statusCategory?.key || ''
    } : null,
    priority: compactNamed(fields.priority),
    project: fields.project ? {
      id: String(fields.project.id || ''), key: fields.project.key || '', name: fields.project.name || ''
    } : null,
    assignee: compactUser(fields.assignee), reporter: compactUser(fields.reporter),
    sprints, activeSprint: sprints[0] || null,
    storyPoints: fieldInfo.storyPoints ? fields[fieldInfo.storyPoints.id] ?? null : null,
    estimate: fields.timetracking ? {
      original: fields.timetracking.originalEstimate || null,
      remaining: fields.timetracking.remainingEstimate || null,
      spent: fields.timetracking.timeSpent || null
    } : null,
    description: safeFieldValue(fields.description),
    acceptanceCriteria: fieldInfo.acceptanceCriteria ? safeFieldValue(fields[fieldInfo.acceptanceCriteria.id]) : null,
    labels: Array.isArray(fields.labels) ? fields.labels.slice(0, 100) : [],
    components: Array.isArray(fields.components) ? fields.components.map(compactNamed).filter(Boolean) : [],
    fixVersions: Array.isArray(fields.fixVersions) ? fields.fixVersions.map(compactNamed).filter(Boolean) : [],
    created: fields.created || null, updated: fields.updated || null, dueDate: fields.duedate || null,
    parent: fields.parent ? {
      id: String(fields.parent.id || ''), key: fields.parent.key || '', summary: fields.parent.fields?.summary || ''
    } : null,
    subtasks: Array.isArray(fields.subtasks) ? fields.subtasks.map(item => ({
      id: String(item.id || ''), key: item.key || '', summary: item.fields?.summary || '',
      status: item.fields?.status?.name || '', assignee: compactUser(item.fields?.assignee)
    })) : [],
    attachments: Array.isArray(fields.attachment) ? fields.attachment.map(item => ({
      id: String(item.id || ''), filename: item.filename || '', size: item.size || 0,
      mimeType: item.mimeType || '', created: item.created || null, author: compactUser(item.author)
    })) : [],
    fieldValues: Object.fromEntries(Object.entries(fields).map(([id, value]) => [id, safeFieldValue(value)])),
    allFields: Object.entries(fields)
      .filter(([, value]) => value !== null && value !== '' && (!Array.isArray(value) || value.length))
      .map(([id, value]) => ({ id, name: names[id] || id, value: safeFieldValue(value) }))
  };
}

function normalizeEditableFields(editmeta, values) {
  return Object.entries(editmeta?.fields || {}).map(([id, meta]) => ({
    id, name: meta.name || id, required: meta.required === true,
    schema: safeFieldValue(meta.schema), operations: Array.isArray(meta.operations) ? meta.operations : [],
    allowedValues: safeFieldValue(meta.allowedValues || []), value: safeFieldValue(values[id])
  }));
}

function normalizeTransitionFields(fieldMap, values) {
  return Object.entries(fieldMap || {}).map(([id, meta]) => ({
    id, name: meta.name || id, required: meta.required === true,
    schema: safeFieldValue(meta.schema), operations: Array.isArray(meta.operations) ? meta.operations : [],
    allowedValues: safeFieldValue(meta.allowedValues || []),
    hasDefaultValue: meta.hasDefaultValue === true,
    defaultValue: safeFieldValue(meta.defaultValue),
    value: safeFieldValue(meta.hasDefaultValue === true ? meta.defaultValue : (id === 'comment' ? '' : values[id]))
  }));
}

function groupIssues(issues) {
  const groups = new Map();
  for (const issue of issues) {
    const sprint = issue.activeSprint || { id: 'active', name: 'Active sprint' };
    const project = issue.project || { key: 'UNKNOWN', name: 'Unknown project' };
    const key = `${sprint.id}:${project.key}`;
    if (!groups.has(key)) groups.set(key, { sprint, project, issues: [] });
    groups.get(key).issues.push(issue);
  }
  return Array.from(groups.values());
}

function validateUpdateFields(fields, editableIds) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Fields must be an object.');
  const entries = Object.entries(fields);
  if (!entries.length || entries.length > 30) throw new Error('Between 1 and 30 fields are required.');
  const output = {};
  for (const [id, value] of entries) {
    if (!/^(?:[a-z][a-zA-Z0-9_]{0,79}|customfield_[0-9]{1,12})$/.test(id) || !editableIds.has(id)) {
      throw new Error(`Field ${id} is not editable.`);
    }
    output[id] = value;
  }
  return output;
}

module.exports = {
  CURRENT_SPRINT_JQL, JIRA_ACCOUNT_ID_RE, currentSprintJql, adfToText, textToAdf, discoverFields, normalizeIssue,
  normalizeEditableFields, normalizeTransitionFields, groupIssues, validateUpdateFields
};
