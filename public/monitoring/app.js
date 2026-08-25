const state = {
  dashboard: null,
  selectedId: null,
  selectedResident: null,
  filter: 'ALL',
  refreshSeq: 0,
  refreshing: false,
  lastSuccessfulRefresh: null,
  operator: null,
  panelScrollTop: 0,
  caseNoticeTimer: null,
  drafts: {},
  renderedCaseId: null,
};

const $ = (s) => document.querySelector(s);
const escapeHtml = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[c]));
const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
};
const fmtMinutes = (v) => Number.isFinite(Number(v)) ? `${Math.round(Number(v))} min` : '—';

async function api(url, options = {}) {
  const r = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (r.status === 401) {
    showLogin();
    throw new Error(data.error || 'Sign-in required');
  }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function showLogin() {
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
}

function showApp(operator) {
  state.operator = operator || null;
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#operatorName').textContent = operator?.displayName || operator?.username || '';
  const roleBadge = $('#operatorRole');
  if (roleBadge) roleBadge.textContent = operator?.role ? ({admin:'Administrator',supervisor:'Supervisor',operator:'Operator'}[operator.role] || operator.role) : '';
  const staffBtn = $('#staffBtn');
  if (staffBtn) staffBtn.classList.toggle('hidden', operator?.role !== 'admin');
  if (operator?.mustChangePassword && !operator?.isBootstrap) showPasswordChange();
}

function setRefreshState(active, error = false) {
  state.refreshing = active;
  const btn = $('#refreshBtn');
  if (btn) {
    btn.disabled = active;
    btn.textContent = active ? 'Updating…' : 'Refresh';
  }
  const el = $('#generatedAt');
  if (!el) return;

  if (active) {
    el.textContent = state.lastSuccessfulRefresh
      ? `Updating… · Last ${fmtDate(state.lastSuccessfulRefresh)}`
      : 'Loading live data…';
    el.classList.remove('refresh-error');
  } else if (error) {
    el.textContent = state.lastSuccessfulRefresh
      ? `Update failed · Last ${fmtDate(state.lastSuccessfulRefresh)}`
      : 'Update failed';
    el.classList.add('refresh-error');
  } else if (state.lastSuccessfulRefresh) {
    el.textContent = `Updated ${fmtDate(state.lastSuccessfulRefresh)}`;
    el.classList.remove('refresh-error');
  }
}

function showPasswordChange() {
  $('#passwordModal')?.classList.remove('hidden');
}

function hidePasswordChange() {
  $('#passwordModal')?.classList.add('hidden');
}

function activationMarkup(activation, heading = 'Staff activation ready') {
  if (!activation) return '';
  return `<div class="credential-title">${escapeHtml(heading)}</div>
    <p>Send this single-use activation link directly to the staff member. It expires ${escapeHtml(fmtDate(activation.expiresAt))}. The employee creates their own password and enrolls their own authenticator; you never need to handle their MFA secret.</p>
    <div class="credential-row"><span>Activation link</span><code>${escapeHtml(activation.url)}</code></div>
    <div class="credential-actions"><button class="ghost" type="button" id="copyActivationLink">Copy activation link</button></div>`;
}

function activationSetupText(activation) {
  return `Good Shepherd Monitoring Center staff activation
${activation.url}

This link expires ${fmtDate(activation.expiresAt)} and can be used only once.`;
}


async function openStaffManager() {
  $('#staffModal').classList.remove('hidden');
  $('#staffCredentials').classList.add('hidden');
  await loadStaffList();
}

function closeStaffManager() {
  $('#staffModal').classList.add('hidden');
}

async function loadStaffList() {
  const list = $('#staffList');
  if (!list) return;
  list.innerHTML = '<div class="loading">Loading staff…</div>';
  try {
    const data = await api('/monitoring/api/operators');
    list.innerHTML = (data.operators || []).map((op) => `
      <article class="staff-card ${op.isActive ? '' : 'staff-disabled'}" data-operator-id="${escapeHtml(op.id)}">
        <div class="staff-card-head"><div><strong>${escapeHtml(op.displayName)}</strong><span>@${escapeHtml(op.username)}</span></div><div class="staff-badges">${op.isBootstrap ? '<span class="staff-badge bootstrap">Bootstrap</span>' : ''}${!op.isActive ? '<span class="staff-badge disabled">Disabled</span>' : ''}${!op.isEnrolled ? '<span class="staff-badge pending">Activation pending</span>' : ''}</div></div>
        <div class="staff-edit-row">
          <label>Name<input class="staff-edit-name" value="${escapeHtml(op.displayName)}" ${op.isBootstrap ? 'disabled' : ''}></label>
          <label>Role<select class="staff-edit-role" ${op.isBootstrap ? 'disabled' : ''}><option value="operator" ${op.role==='operator'?'selected':''}>Operator</option><option value="supervisor" ${op.role==='supervisor'?'selected':''}>Supervisor</option><option value="admin" ${op.role==='admin'?'selected':''}>Administrator</option></select></label>
        </div>
        <div class="staff-meta">Last login: ${op.lastLoginAt ? escapeHtml(fmtDate(op.lastLoginAt)) : 'Never'} · Created: ${escapeHtml(fmtDate(op.createdAt))}${!op.isEnrolled && op.activationExpiresAt ? ` · Activation expires: ${escapeHtml(fmtDate(op.activationExpiresAt))}` : ''}</div>
        <div class="staff-card-actions">
          ${op.isBootstrap ? '<span class="muted">Protected recovery administrator</span>' : `<button type="button" class="ghost staff-save">Save</button><button type="button" class="ghost staff-toggle">${op.isActive ? 'Disable' : 'Enable'}</button><button type="button" class="ghost staff-reset">${op.isEnrolled ? 'Reset access' : 'Reissue activation'}</button>`}
        </div>
      </article>`).join('') || '<div class="empty-state">No staff accounts found.</div>';

    list.querySelectorAll('.staff-save').forEach(btn => btn.addEventListener('click', async () => {
      const card = btn.closest('.staff-card');
      btn.disabled = true;
      try {
        await api(`/monitoring/api/operators/${card.dataset.operatorId}`, {method:'PATCH', body:JSON.stringify({displayName:card.querySelector('.staff-edit-name').value, role:card.querySelector('.staff-edit-role').value})});
        await loadStaffList();
      } catch (err) { alert(err.message); } finally { btn.disabled = false; }
    }));
    list.querySelectorAll('.staff-toggle').forEach(btn => btn.addEventListener('click', async () => {
      const card = btn.closest('.staff-card');
      const enabling = btn.textContent.trim() === 'Enable';
      if (!enabling && !confirm('Disable this staff account? Their active Monitoring Center sessions will be signed out.')) return;
      btn.disabled = true;
      try { await api(`/monitoring/api/operators/${card.dataset.operatorId}`, {method:'PATCH',body:JSON.stringify({isActive:enabling})}); await loadStaffList(); }
      catch (err) { alert(err.message); } finally { btn.disabled=false; }
    }));
    list.querySelectorAll('.staff-reset').forEach(btn => btn.addEventListener('click', async () => {
      const card = btn.closest('.staff-card');
      if (!confirm('Issue a new single-use activation link? Any active Monitoring Center sessions for this staff member will be signed out.')) return;
      btn.disabled = true;
      try {
        const data = await api(`/monitoring/api/operators/${card.dataset.operatorId}/activation-link`, {method:'POST',body:'{}'});
        const box = $('#staffCredentials');
        box.innerHTML = activationMarkup(data.activation, 'New activation link issued');
        box.classList.remove('hidden');
        $('#copyActivationLink')?.addEventListener('click', () => navigator.clipboard.writeText(activationSetupText(data.activation)));
        await loadStaffList();
      } catch (err) { alert(err.message); } finally { btn.disabled=false; }
    }));
  } catch (err) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function activationTokenFromUrl() {
  return new URLSearchParams(window.location.search).get('activate') || '';
}

function showActivation() {
  $('#appView')?.classList.add('hidden');
  $('#loginView')?.classList.add('hidden');
  $('#activationView')?.classList.remove('hidden');
}

function leaveActivationForLogin(username = '') {
  history.replaceState({}, '', '/monitoring/');
  $('#activationView')?.classList.add('hidden');
  $('#loginView')?.classList.remove('hidden');
  if (username) $('#username').value = username;
}

async function bootActivation(token) {
  showActivation();
  $('#activationIntro').textContent = 'Loading your secure staff setup…';
  try {
    const data = await api(`/monitoring/api/activation/${encodeURIComponent(token)}`);
    const a = data.activation;
    $('#activationName').textContent = a.displayName;
    $('#activationRole').textContent = ({admin:'Administrator',supervisor:'Supervisor',operator:'Operator'}[a.role] || a.role);
    $('#activationUsername').textContent = `@${a.username}`;
    $('#activationQr').src = a.qrUrl;
    $('#activationSecret').textContent = a.totpSecret;
    $('#openAuthenticator').href = a.otpauthUri;
    $('#activationIntro').textContent = `This single-use setup link expires ${fmtDate(a.expiresAt)}.`;
    $('#activationSetup').classList.remove('hidden');
    $('#activationForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = $('#activationPassword').value;
      const confirmPassword = $('#activationConfirm').value;
      const code = $('#activationCode').value;
      $('#activationError').textContent = '';
      if (password !== confirmPassword) { $('#activationError').textContent = 'Passwords do not match.'; return; }
      const button = e.submitter; button.disabled = true;
      try {
        const completed = await api(`/monitoring/api/activation/${encodeURIComponent(token)}/complete`, {method:'POST',body:JSON.stringify({password,code})});
        $('#activationSetup').classList.add('hidden');
        $('#activationComplete').classList.remove('hidden');
        $('#activationSignIn').onclick = () => leaveActivationForLogin(completed.username);
      } catch (err) { $('#activationError').textContent = err.message; button.disabled = false; }
    }, { once:true });
  } catch (err) {
    $('#activationIntro').textContent = err.message;
    $('#activationIntro').classList.add('error');
  }
}

async function boot() {
  const activationToken = activationTokenFromUrl();
  if (activationToken) { await bootActivation(activationToken); return; }
  try {
    const me = await api('/monitoring/api/me');
    showApp(me.operator);
    await loadDashboard({ initial: true });
  } catch {
    showLogin();
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    const data = await api('/monitoring/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#username').value,
        password: $('#password').value,
        code: $('#code').value,
      }),
    });
    showApp(data.operator);
    $('#password').value = '';
    $('#code').value = '';
    await loadDashboard({ initial: true });
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/monitoring/api/logout', { method: 'POST', body: '{}' }); }
  finally { showLogin(); }
});

$('#refreshBtn').addEventListener('click', () => loadDashboard({ manual: true }));
$('#priorityFilter').addEventListener('change', (e) => {
  state.filter = e.target.value;
  renderQueue();
});

if ($('#priorityFilter') && !Array.from($('#priorityFilter').options).some(o => o.value === 'RESOLVED')) {
  const option = document.createElement('option');
  option.value = 'RESOLVED';
  option.textContent = 'Resolved';
  $('#priorityFilter').appendChild(option);
}



function draftKey(residentId, fieldId, caseId = null) {
  // Case documentation belongs to one incident only. AI follow-up remains resident-scoped.
  const scope = (fieldId === 'caseNote' || fieldId === 'resolutionNote')
    ? `case:${caseId || 'none'}`
    : 'resident';
  return `${residentId || 'none'}:${scope}:${fieldId}`;
}

function captureResidentDrafts(residentId = state.selectedId, caseId = state.renderedCaseId) {
  if (!residentId) return;
  ['caseNote', 'resolutionNote', 'followNote'].forEach((fieldId) => {
    const el = document.getElementById(fieldId);
    if (el) state.drafts[draftKey(residentId, fieldId, caseId)] = el.value;
  });
}

function restoreResidentDrafts(residentId = state.selectedId, caseId = null) {
  if (!residentId) return;
  ['caseNote', 'resolutionNote', 'followNote'].forEach((fieldId) => {
    const el = document.getElementById(fieldId);
    if (!el) return;
    const key = draftKey(residentId, fieldId, caseId);
    if (Object.prototype.hasOwnProperty.call(state.drafts, key)) el.value = state.drafts[key];
    el.addEventListener('input', () => { state.drafts[key] = el.value; });
  });
}

function clearResidentDraft(residentId, fieldId, caseId = state.renderedCaseId) {
  delete state.drafts[draftKey(residentId, fieldId, caseId)];
}

function residentEditorIsActive() {
  const active = document.activeElement;
  return Boolean(active && $('#residentPanel')?.contains(active) && /^(TEXTAREA|INPUT|SELECT)$/.test(active.tagName));
}

async function loadDashboard({ initial = false } = {}) {
  if (state.refreshing && !initial) return;
  const seq = ++state.refreshSeq;

  if (initial && !state.dashboard) {
    $('#queue').innerHTML = '<div class="loading">Loading live Good Shepherd data…</div>';
  }
  setRefreshState(true);

  const residentPromise = state.selectedId
    ? api(`/monitoring/api/residents/${encodeURIComponent(state.selectedId)}`)
    : Promise.resolve(null);

  const [dashboardResult, residentResult] = await Promise.allSettled([
    api('/monitoring/api/dashboard'),
    residentPromise,
  ]);

  if (seq !== state.refreshSeq) return;

  let hadError = false;

  if (dashboardResult.status === 'fulfilled') {
    state.dashboard = dashboardResult.value;
    state.lastSuccessfulRefresh = dashboardResult.value.generatedAt || new Date().toISOString();
    renderMetrics();
    renderQueue();
  } else {
    hadError = true;
    if (!state.dashboard) {
      $('#queue').innerHTML = `<div class="empty-state">Unable to load live data. ${escapeHtml(dashboardResult.reason?.message || '')}</div>`;
    }
  }

  if (state.selectedId && residentResult.status === 'fulfilled' && residentResult.value) {
    state.selectedResident = residentResult.value.resident;
    // Never tear down the operator's editor while they are typing. The queue and
    // metrics can continue refreshing in the background; the resident panel will
    // catch up on the next refresh after the field loses focus.
    if (!residentEditorIsActive()) renderResident(state.selectedResident);
  } else if (state.selectedId && residentResult.status === 'rejected') {
    hadError = true;
    // Keep the last resident view visible. Do not blank the panel during a transient failure.
  }

  setRefreshState(false, hadError);
}

function renderMetrics() {
  const c = state.dashboard?.counts || {};
  const total = state.dashboard?.residents?.length || 0;
  const items = [
    ['P1 Critical', c.P1 || 0, 'p1'],
    ['P2 Urgent', c.P2 || 0, 'p2'],
    ['P3 Technical', c.P3 || 0, 'p3'],
    ['P4 Observe', c.P4 || 0, 'p4'],
    ['Resolved', c.RESOLVED || 0, 'resolved'],
    ['Overdue', c.OVERDUE || 0, 'overdue'],
    ['P5 Normal / Info', c.P5 || 0, 'p5'],
    ['Residents', total, ''],
  ];
  $('#metrics').innerHTML = items.map(([k, v, cl]) =>
    `<div class="metric"><div class="k">${k}</div><div class="v ${cl}">${v}</div></div>`
  ).join('');
}

function caseAttentionBadge(attention, compact = false) {
  if (!attention) return '';
  if (attention.overdue) {
    const label = attention.supervisorAttention ? 'SUPERVISOR ATTENTION' : 'OVERDUE';
    const detail = attention.overdueMinutes > 0 ? ` · ${attention.overdueMinutes}m` : '';
    return `<span class="case-attention overdue${compact ? ' compact' : ''}">${label}${detail}</span>`;
  }
  return compact ? '' : `<span class="case-attention current">Next action due in ${Math.max(0, Number(attention.minutesRemaining || 0))}m</span>`;
}

function responseClockMarkup(attention) {
  if (!attention) return '';
  const last = attention.lastActionAt ? fmtDate(attention.lastActionAt) : '—';
  if (attention.overdue) {
    return `<div class="response-clock overdue"><div><div class="response-clock-label">Unattended case protection</div><strong>${attention.supervisorAttention ? 'Supervisor attention required' : 'Response action overdue'}</strong><div class="small">No meaningful case action for ${Number(attention.elapsedMinutes || 0)} min. ${escapeHtml(attention.priority || '')} response interval: ${Number(attention.thresholdMinutes || 0)} min.</div></div><div class="response-clock-meta">Last action<br><b>${escapeHtml(last)}</b></div></div>`;
  }
  return `<div class="response-clock"><div><div class="response-clock-label">Response clock</div><strong>Active — next action due in ${Math.max(0, Number(attention.minutesRemaining || 0))} min</strong><div class="small">${escapeHtml(attention.priority || '')} response interval: ${Number(attention.thresholdMinutes || 0)} min.</div></div><div class="response-clock-meta">Last action<br><b>${escapeHtml(last)}</b></div></div>`;
}

function renderQueue() {
  if (!state.dashboard) return;
  const rows = (state.dashboard.residents || []).filter((r) => state.filter === 'ALL' || (r.queuePriority || r.priority) === state.filter);
  if (!rows.length) {
    $('#queue').innerHTML = '<div class="empty-state">No residents in this priority.</div>';
    return;
  }

  $('#queue').innerHTML = rows.map((r) => `
    <div class="queue-row ${r.residentId === state.selectedId ? 'active' : ''} ${r.caseAttention?.overdue ? 'case-overdue-row' : ''}" data-id="${escapeHtml(r.residentId)}">
      <div>${r.operationalResolved ? `<span class="priority resolved-priority">RES</span>` : `<span class="priority ${String(r.queuePriority || r.priority || 'P5').toLowerCase()}">${escapeHtml(r.queuePriority || r.priority || 'P5')}</span>`}</div>
      <div><div class="resident-name">${escapeHtml(r.residentName)}</div><div class="small">${escapeHtml(r.location || 'Location not set')}</div>${!r.operationalResolved && r.activeCase && r.queuePriority && r.underlyingPriority && r.queuePriority !== r.underlyingPriority ? `<div class="small"><strong>Response ${escapeHtml(r.queuePriority)}</strong> · Underlying ${escapeHtml(r.underlyingPriority)}</div>` : ''}${r.accessCode ? `<div class="access-code-inline">Access code <strong>${escapeHtml(r.accessCode)}</strong></div>` : ''}${r.activeCase ? `<div class="case-badge">${escapeHtml(r.activeCase.assignedOperatorName ? `Assigned: ${r.activeCase.assignedOperatorName}` : 'Open case')}</div>${caseAttentionBadge(r.caseAttention, true)}` : (r.operationalResolved ? `<div class="case-badge case-badge-resolved">${escapeHtml(r.latestCase?.resolvedByOperatorName ? `Resolved: ${r.latestCase.resolvedByOperatorName}` : 'Resolved')}</div>` : '')}</div>
      <div><div class="status-title">${escapeHtml(r.operationalResolved ? 'Resolved' : (r.activeCase?.residentResponseLabel || r.actionTitle || r.aiStatus || 'Monitoring'))}</div><div class="status-summary">${escapeHtml(r.operationalResolved ? `Operator case closed. Underlying ${r.underlyingPriority || r.priority || 'monitoring'} signal remains visible for reference.` : (r.activeCase?.residentResponseCode === 'need_help' ? 'Resident responded to a Good Shepherd check-in and requested help. Immediate operator action is required.' : r.activeCase?.residentResponseCode === 'call_me' ? 'Resident responded to a Good Shepherd check-in and requested a call from staff.' : (r.actionSummary || r.aiExplanation || r.patternExplanation || 'No additional explanation')))}</div></div>
      <div class="sensor-pill">${r.onlineSensorCount || 0}/${r.sensorCount || 0} online<div class="small">${escapeHtml(r.coverageStatus || '')}</div></div>
      <div class="last-col small">${r.lastMotionAt ? fmtDate(r.lastMotionAt) : 'No activity'}</div>
    </div>`).join('');

  document.querySelectorAll('.queue-row').forEach((el) =>
    el.addEventListener('click', () => openResident(el.dataset.id, true))
  );
}

async function openResident(id, scroll) {
  const changingResident = state.selectedId !== id;
  state.selectedId = id;
  renderQueue();

  if (changingResident) {
    $('#residentPanel').classList.add('panel-loading');
  }

  try {
    const data = await api(`/monitoring/api/residents/${encodeURIComponent(id)}`);
    if (state.selectedId !== id) return;
    state.selectedResident = data.resident;
    renderResident(data.resident);
    if (scroll && window.innerWidth < 1100) {
      $('#residentPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (err) {
    if (!state.selectedResident || state.selectedResident.residentId !== id) {
      $('#residentPanel').innerHTML = `<div class="empty-state">Unable to load resident view. ${escapeHtml(err.message)}</div>`;
    }
  } finally {
    $('#residentPanel').classList.remove('panel-loading');
  }
}

function normalizeInsight(raw) {
  let value = raw;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try { value = JSON.parse(s); } catch { return { title: '', detail: s }; }
    } else {
      return { title: '', detail: s };
    }
  }

  if (value && typeof value === 'object') {
    return {
      title: value.title || value.name || value.type || value.summary || '',
      detail: value.detail || value.text || value.explanation || value.description || value.message || value.summary || '',
    };
  }
  return null;
}

function insightCards(items) {
  return items.map(normalizeInsight).filter(Boolean).map((i) => {
    const title = i.title && i.title !== i.detail ? `<strong>${escapeHtml(i.title)}</strong>` : '';
    const detail = i.detail ? `<div>${escapeHtml(i.detail)}</div>` : '';
    return `<div class="insight-card">${title}${detail}</div>`;
  }).join('');
}


function caseTimeline(incident) {
  const rows = incident?.timeline || [];
  if (!rows.length) return '<div class="muted small">No case activity recorded yet.</div>';
  return `<div class="timeline">${rows.map((e) => `<div class="timeline-row"><div class="timeline-dot"></div><div><strong>${escapeHtml(e.label)}</strong><div class="small">${fmtDate(e.createdAt)}${e.operatorName ? ` · ${escapeHtml(e.operatorName)}` : ''}</div>${e.note ? `<div class="timeline-note">${escapeHtml(e.note)}</div>` : ''}</div></div>`).join('')}</div>`;
}

function rememberPanelScroll() {
  const panel = $('#residentPanel');
  if (panel) state.panelScrollTop = panel.scrollTop;
}

function restorePanelScroll() {
  const panel = $('#residentPanel');
  if (!panel) return;
  requestAnimationFrame(() => { panel.scrollTop = state.panelScrollTop || 0; });
}

function showCaseNotice(message, kind = 'success') {
  const n = $('#caseNotice');
  if (!n) return;
  n.textContent = message;
  n.className = `notice case-flash ${kind}`;
  if (state.caseNoticeTimer) clearTimeout(state.caseNoticeTimer);
  state.caseNoticeTimer = setTimeout(() => {
    const current = $('#caseNotice');
    if (current) { current.textContent = ''; current.className = 'notice'; }
  }, 3200);
}

function confirmCaseAction(action) {
  const prompts = {
    supervisor_escalation: 'Record an escalation to a supervisor for this case?',
    field_response: 'Record that a field response has been requested?',
    emergency_escalation: 'Record an Emergency / 911 escalation for this case? This is a consequential incident action.',
  };
  return prompts[action] ? window.confirm(prompts[action]) : true;
}

const CONTACT_ACTIONS = new Set(['resident_call','contact_1_call','contact_2_call']);

function contactOutcomeOptions(action) {
  const shared = [
    ['answered_safe', action === 'resident_call' ? 'Answered — resident reports safe' : 'Answered — contact confirms resident safe'],
    ['no_answer', 'No answer'],
    ['voicemail', 'Voicemail left'],
    ['unable_to_connect', 'Unable to connect'],
  ];
  if (action === 'resident_call') shared.splice(1, 0, ['answered_needs_help', 'Answered — resident needs assistance']);
  else shared.splice(1, 0, ['answered_assisting', 'Answered — contact is checking on resident']);
  return shared;
}

function contactActionTitle(action) {
  return ({resident_call:'Call Resident',contact_1_call:'Call Contact #1',contact_2_call:'Call Contact #2'})[action] || 'Record Contact Outcome';
}

function latestProtocolGuidance(incident) {
  const rows = Array.isArray(incident?.timeline) ? incident.timeline : [];
  const priority = String(incident?.priority || 'P5').toUpperCase();

  // Derive the effective workflow state from the most recent event that can
  // change the required next step. This also repairs older open cases where
  // a supervisor/emergency escalation was recorded before protocol_next_step
  // events were introduced.
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const eventType = rows[i]?.eventType;
    if (eventType === 'emergency_escalation') {
      return {
        label: `${priority} — Emergency response initiated`,
        note: 'Emergency / 911 escalation has been recorded. Keep the case open and document response details and final disposition.'
      };
    }
    if (eventType === 'supervisor_escalation') {
      return {
        label: `${priority} — Supervisor review required`,
        note: 'Case escalated to supervisor. Maintain the current priority until a supervisor records the appropriate disposition or emergency response action.'
      };
    }
    if (eventType === 'protocol_next_step') return rows[i];
  }
  return null;
}

function caseHasEvent(incident, eventType) {
  const rows = Array.isArray(incident?.timeline) ? incident.timeline : [];
  return rows.some((row) => row?.eventType === eventType);
}

function openContactOutcomeDialog(action) {
  return new Promise((resolve) => {
    document.getElementById('contactOutcomeModal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'contactOutcomeModal';
    wrap.className = 'modal-backdrop';
    const options = contactOutcomeOptions(action).map(([value,label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('');
    wrap.innerHTML = `<form class="contact-outcome-modal">
      <div class="contact-outcome-head"><div><h2>${escapeHtml(contactActionTitle(action))}</h2><p>Record the actual result. Good Shepherd will add the outcome to the incident timeline and show the required next step.</p></div><button type="button" class="ghost" data-cancel>Cancel</button></div>
      <label>Outcome<select id="contactOutcomeSelect" required><option value="" selected disabled>Select outcome…</option>${options}</select></label>
      <label>Operator note <span class="muted">(optional)</span><textarea id="contactOutcomeNote" placeholder="What happened? Add details that will help the next operator or supervisor."></textarea></label>
      <div class="contact-outcome-actions"><button type="submit" class="primary">Record Outcome</button></div>
    </form>`;
    document.body.appendChild(wrap);
    const finish = (value) => { wrap.remove(); resolve(value); };
    wrap.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(null); });
    wrap.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const outcome = wrap.querySelector('#contactOutcomeSelect').value;
      if (!outcome) return;
      finish({ outcome, note: wrap.querySelector('#contactOutcomeNote').value.trim() });
    });
    requestAnimationFrame(() => wrap.querySelector('#contactOutcomeSelect')?.focus());
  });
}

function openSupervisorDispositionDialog(disposition, title, prompt, requireNote = true) {
  return new Promise((resolve) => {
    document.getElementById('supervisorDispositionModal')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'supervisorDispositionModal';
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<form class="contact-outcome-modal">
      <div class="contact-outcome-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(prompt)}</p></div><button type="button" class="ghost" data-cancel>Cancel</button></div>
      <label>Supervisor disposition note ${requireNote ? '' : '<span class="muted">(optional)</span>'}<textarea id="supervisorDispositionNote" placeholder="Document the reason, instructions, or disposition details." ${requireNote ? 'required' : ''}></textarea></label>
      <div class="contact-outcome-actions"><button type="submit" class="primary">Record Disposition</button></div>
    </form>`;
    document.body.appendChild(wrap);
    const finish = (value) => { wrap.remove(); resolve(value); };
    wrap.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(null); });
    wrap.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const note = wrap.querySelector('#supervisorDispositionNote').value.trim();
      if (requireNote && !note) return;
      finish({ disposition, note });
    });
    requestAnimationFrame(() => wrap.querySelector('#supervisorDispositionNote')?.focus());
  });
}

function elapsedText(openedAt, closedAt) {
  if (!openedAt) return '—';
  const start = new Date(openedAt).getTime();
  const end = closedAt ? new Date(closedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const mins = Math.max(0, Math.floor((end - start) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h}h ${m}m`;
}

async function refreshSelectedResident() {
  if (!state.selectedId) return;
  rememberPanelScroll();
  const data = await api(`/monitoring/api/residents/${encodeURIComponent(state.selectedId)}`);
  state.selectedResident = data.resident;
  renderResident(data.resident);
  restorePanelScroll();
  loadDashboard().catch(() => {});
}

async function submitCaseAction(caseId, action, note = '') {
  await api(`/monitoring/api/cases/${encodeURIComponent(caseId)}/actions`, { method:'POST', body:JSON.stringify({ action, note }) });
  await refreshSelectedResident();
}

function renderResident(r) {
  captureResidentDrafts(r?.residentId || state.selectedId);
  const panel = $('#residentPanel');
  const priorScroll = panel ? panel.scrollTop : 0;
  const insights = Array.isArray(r.behaviorInsights) ? r.behaviorInsights : [];
  const sensors = Array.isArray(r.sensors) ? r.sensors : [];
  const contextCards = insightCards(insights);
  const incident = r.incident || null;
  const activeCase = incident && ['open','accepted','escalated'].includes(incident.status);
  const mine = activeCase && incident.assignedOperatorId && String(incident.assignedOperatorId) === String(state.operator?.id);
  const sensorSummary = `${r.onlineSensorCount ?? sensors.filter(s => s.isOnline).length}/${r.sensorCount ?? sensors.length} online`;
  const resolvedCase = Boolean(r.operationalResolved && incident && incident.status === 'resolved');
  const caseState = activeCase ? String(incident.status || 'open').toUpperCase() : (resolvedCase ? 'RESOLVED' : 'NO ACTIVE CASE');
  const protocolGuidance = activeCase ? latestProtocolGuidance(incident) : null;
  const supervisorEscalated = activeCase && caseHasEvent(incident, 'supervisor_escalation');
  const canSupervisorDisposition = supervisorEscalated && ['supervisor','admin'].includes(state.operator?.role);
  const caseAttention = activeCase ? (incident.caseAttention || null) : null;

  panel.innerHTML = `
    <div class="resident-sticky-header">
      <div class="resident-head compact-head">
        <div class="resident-title-line">${resolvedCase ? `<span class="priority resolved-priority">RES</span>` : `<span class="priority ${String(r.queuePriority || r.priority || 'P5').toLowerCase()}">${escapeHtml(r.queuePriority || r.priority || 'P5')}</span>`}<div><h2>${escapeHtml(r.residentName)}</h2><div class="location">${escapeHtml(r.location || 'Location not set')}${resolvedCase ? ` · Underlying ${escapeHtml(r.underlyingPriority || r.priority || '')}` : (activeCase && r.queuePriority && r.underlyingPriority && r.queuePriority !== r.underlyingPriority ? ` · Response ${escapeHtml(r.queuePriority)} · Underlying ${escapeHtml(r.underlyingPriority)}` : '')}</div></div></div>
        <div class="sticky-facts"><span><b>${escapeHtml(caseState)}</b>${activeCase && incident.assignedOperatorName ? ` · ${escapeHtml(incident.assignedOperatorName)}` : (resolvedCase && incident.resolvedByOperatorName ? ` · ${escapeHtml(incident.resolvedByOperatorName)}` : '')}</span>${activeCase ? caseAttentionBadge(caseAttention, true) : ''}${r.accessCode ? `<span class="access-code-pill"><b>Access code</b> ${escapeHtml(r.accessCode)}</span>` : ''}<span>${activeCase ? `Open ${escapeHtml(elapsedText(incident.openedAt, incident.closedAt))}` : (resolvedCase ? `Closed ${escapeHtml(fmtDate(incident.resolvedAt))}` : '—')}</span><span>${escapeHtml(sensorSummary)}</span><span>Last ${escapeHtml(r.lastMotionAt ? fmtDate(r.lastMotionAt) : 'No activity')}</span></div>
      </div>
    </div>
    <div class="section">
      <h3>Current assessment</h3>
      <div class="callout"><strong>${escapeHtml(activeCase && incident.residentResponseLabel ? incident.residentResponseLabel : (r.actionTitle || r.aiStatus || 'Monitoring'))}</strong><div class="small assessment-detail">${escapeHtml(activeCase && incident.residentResponseCode === 'need_help' ? 'Resident requested help through the Good Shepherd check-in. Treat this as a P1 response event.' : activeCase && incident.residentResponseCode === 'call_me' ? 'Resident requested a call through the Good Shepherd check-in. Operator contact is required.' : (r.actionSummary || r.aiExplanation || r.patternExplanation || 'No additional explanation'))}</div></div>
    </div>
    <div class="section">
      <h3>Operational facts</h3>
      <div class="facts">
        <div class="fact"><span>Last activity</span><strong>${fmtDate(r.lastMotionAt)}</strong><div class="small">${escapeHtml(r.lastMotionRoom || 'Room unavailable')}</div></div>
        <div class="fact"><span>Inactive</span><strong>${fmtMinutes(r.inactiveMinutes)}</strong></div>
        <div class="fact"><span>Motion today</span><strong>${Number(r.motionCountToday || 0)}</strong></div>
        <div class="fact"><span>Last hour</span><strong>${Number(r.motionCountLastHour || 0)}</strong></div>
        <div class="fact"><span>Typical first activity</span><strong>${escapeHtml(r.typicalFirstActivityTime || '—')}</strong></div>
        <div class="fact"><span>Baseline</span><strong>${Number(r.baselineDayCount || 0)} days</strong></div>
        <div class="fact access-code-fact"><span>Resident access code</span><strong>${escapeHtml(r.accessCode || '—')}</strong></div>
      </div>
    </div>
    <div class="section case-section">
      <h3>Operator case</h3>
      ${!activeCase ? `<div class="case-empty ${resolvedCase ? 'case-resolved-summary' : ''}">${resolvedCase ? `<div><strong>Resolved</strong><div class="small">Closed ${escapeHtml(fmtDate(incident.resolvedAt))}${incident.resolvedByOperatorName ? ` · ${escapeHtml(incident.resolvedByOperatorName)}` : ''}</div>${incident.resolution ? `<div class="resolution-summary">${escapeHtml(incident.resolution)}</div>` : ''}<div class="notice">The operator case is closed. The underlying live signal is retained for reference but is removed from active P1-P4 response counts until it clears/re-triggers or a new case is accepted.</div></div>` : `<div>No active case is assigned for this resident.</div>`}<button id="acceptCaseBtn" class="primary case-primary" type="button">${resolvedCase ? 'Accept New Case' : 'Accept Case'}</button></div>` : `
        <div class="case-status"><div><strong>${escapeHtml(String(incident.status).toUpperCase())}</strong><div class="small">Opened ${fmtDate(incident.openedAt)} · ${escapeHtml(elapsedText(incident.openedAt, incident.closedAt))}</div></div><div class="case-owner">${escapeHtml(incident.assignedOperatorName ? `Assigned to ${incident.assignedOperatorName}` : 'Unassigned')}</div></div>
        ${responseClockMarkup(caseAttention)}
        ${incident.handoffToOperatorId ? `<div class="handoff-banner"><div><strong>Handoff pending → ${escapeHtml(incident.handoffToOperatorName || 'receiving staff')}</strong><div class="small">${incident.handoffReason ? `Reason: ${escapeHtml(incident.handoffReason)} · ` : ''}${incident.handoffRequestedAt ? escapeHtml(fmtDate(incident.handoffRequestedAt)) : ''}</div><div class="small">${escapeHtml(incident.assignedOperatorName || 'Current operator')} remains responsible until the handoff is accepted.</div></div><div class="handoff-banner-actions">${String(incident.handoffToOperatorId) === String(state.operator?.id) ? '<button id="acceptHandoffBtn" class="primary" type="button">Accept Handoff</button>' : ''}${mine || ['supervisor','admin'].includes(state.operator?.role) ? '<button id="cancelHandoffBtn" class="ghost" type="button">Cancel Handoff</button>' : ''}</div></div>` : ''}
        ${protocolGuidance ? `<div class="protocol-guidance"><div class="protocol-guidance-label">Required next step</div><strong>${escapeHtml(protocolGuidance.label)}</strong>${protocolGuidance.note ? `<div>${escapeHtml(protocolGuidance.note)}</div>` : ''}</div>` : ''}
        ${canSupervisorDisposition ? `<div class="action-group supervisor-disposition-group"><div class="action-group-title">Supervisor disposition</div><div class="notice">Record the supervisory decision without taking ownership away from the assigned operator.</div><div class="action-grid compact-actions">
          <button type="button" data-supervisor-disposition="continue_monitoring">Continue monitoring / contact attempts</button>
          <button type="button" data-supervisor-disposition="return_to_operator">Return to operator with instructions</button>
          <button type="button" data-supervisor-disposition="verified_safe">Resident verified safe</button>
          <button type="button" data-supervisor-disposition="field_response">Request field response / welfare check</button>
          ${caseHasEvent(incident, 'emergency_escalation') ? '<button type="button" class="danger-action" disabled>Emergency / 911 escalated ✓</button>' : '<button type="button" class="danger-action" data-supervisor-disposition="emergency_response">Initiate Emergency / 911 response</button>'}
        </div></div>` : ''}
        ${mine ? `<div class="action-groups">
          <div class="action-group"><div class="action-group-title">Contact</div><div class="action-grid compact-actions">
            <button type="button" data-case-action="resident_call" data-success="Resident call attempt recorded">Call Resident</button>
            <button type="button" data-case-action="check_in_sent" data-success="Check-in sent">Send Check-In</button>
            <button type="button" data-case-action="contact_1_call" data-success="Contact #1 call attempt recorded">Call Contact #1</button>
            <button type="button" data-case-action="contact_2_call" data-success="Contact #2 call attempt recorded">Call Contact #2</button>
          </div></div>
          <div class="action-group"><div class="action-group-title">Escalation</div><div class="action-grid compact-actions">
            ${caseHasEvent(incident, 'supervisor_escalation')
              ? '<button type="button" disabled title="Supervisor escalation already recorded">Supervisor escalated ✓</button>'
              : '<button type="button" data-case-action="supervisor_escalation" data-success="Supervisor escalation recorded">Escalate to supervisor</button>'}
            <button type="button" data-case-action="technical_review" data-success="Technical review recorded">Technical review</button>
            <button type="button" data-case-action="field_response" data-success="Field response request recorded">Field response requested</button>
            ${caseHasEvent(incident, 'emergency_escalation')
              ? '<button type="button" class="danger-action" disabled title="Emergency / 911 escalation already recorded">Emergency / 911 escalated ✓</button>'
              : '<button type="button" data-case-action="emergency_escalation" data-success="Emergency / 911 escalation recorded" class="danger-action">Emergency / 911 escalation</button>'}
          </div></div>
        </div>
        <div class="action-group documentation-group"><div class="action-group-title">Documentation</div>
          ${incident.handoffToOperatorId ? '' : '<button id="handoffCaseBtn" class="ghost handoff-case-btn" type="button">Hand Off Case</button>'}
          <form id="caseNoteForm" class="follow-form"><textarea id="caseNote" placeholder="Add operator note to this case…" required></textarea><button class="ghost" type="submit">Add note</button></form>
          <form id="resolveForm" class="resolve-form"><textarea id="resolutionNote" placeholder="Resolution / closure evidence…" required></textarea><button class="primary resolve-btn" type="submit">Resolve Case</button></form>
        </div>` : `<div class="notice">This case is being handled by ${escapeHtml(incident.assignedOperatorName || 'another operator')}.${['supervisor','admin'].includes(state.operator?.role) ? ` <button id="takeoverCaseBtn" class="ghost inline-case-action" type="button">Take Over Case</button>` : ''}</div>`}
        <div id="caseNotice" class="notice"></div>
        <div class="case-timeline-title">Incident timeline</div>${caseTimeline(incident)}
      `}
    </div>
    <div class="section">
      <h3>Sensor health</h3>
      ${sensors.length ? sensors.map((s) => `
        <div class="sensor">
          <div><strong>${escapeHtml(s.sourceName || s.nodeId || 'Sensor')}</strong><div class="small">${escapeHtml(s.roomName || s.locationName || s.sensorType || '')}</div></div>
          <div class="${s.isOnline ? 'online' : 'offline'}">${s.isOnline ? 'Online' : 'Offline'}<div class="small">${fmtDate(s.lastSeenAt)}</div></div>
        </div>`).join('') : '<div class="muted">No assigned sensors reported by the AI summary.</div>'}
    </div>
    <div class="section">
      <h3>AI / routine context</h3>
      <div class="ai-summary-line"><strong>${escapeHtml(r.aiLevel || r.aiStatus || 'AI status')}</strong><span>${escapeHtml(r.aiConfidence || 'Confidence unavailable')}${r.aiConfidenceScore != null ? ` (${escapeHtml(r.aiConfidenceScore)}%)` : ''}</span></div>
      ${r.aiExplanation ? `<div class="insight-card"><div>${escapeHtml(r.aiExplanation)}</div></div>` : ''}
      ${r.patternExplanation && r.patternExplanation !== r.aiExplanation ? `<div class="insight-card"><div>${escapeHtml(r.patternExplanation)}</div></div>` : ''}
      ${contextCards || '<div class="muted small">No additional routine insights reported.</div>'}
    </div>
    <div class="section">
      <h3>AI follow-up record</h3>
      <div class="small">${escapeHtml(r.followUpStatus || 'No status')} · ${escapeHtml(r.followUpExplanation || '')}</div>
      <form id="followForm" class="follow-form">
        <textarea id="followNote" placeholder="Record the real outcome or action taken…" required></textarea>
        <button class="primary" type="submit">Log follow-up</button>
        <div id="followNotice" class="notice"></div>
      </form>
    </div>`;

  restoreResidentDrafts(r.residentId, activeCase ? incident.id : null);
  state.renderedCaseId = activeCase ? incident.id : null;
  requestAnimationFrame(() => { panel.scrollTop = priorScroll; });

  const handoffBtn = $('#handoffCaseBtn');
  if (handoffBtn) handoffBtn.addEventListener('click', async () => {
    handoffBtn.disabled = true;
    try {
      const data = await api('/monitoring/api/handoff-targets');
      const targets = data.operators || [];
      if (!targets.length) { showCaseNotice('No other active staff accounts are available for handoff.', 'error'); handoffBtn.disabled=false; return; }
      const choices = targets.map((op,i)=>`${i+1}. ${op.displayName || op.username} (${({admin:'Administrator',supervisor:'Supervisor',operator:'Operator'}[op.role]||op.role)})`).join('\n');
      const picked = window.prompt(`Hand off this case to:\n\n${choices}\n\nEnter the number:`);
      if (picked === null) { handoffBtn.disabled=false; return; }
      const target = targets[Number(picked)-1];
      if (!target) { showCaseNotice('Choose a valid staff number.', 'error'); handoffBtn.disabled=false; return; }
      const reason = window.prompt(`Reason for handoff to ${target.displayName || target.username}:`, 'Shift handoff');
      if (reason === null) { handoffBtn.disabled=false; return; }
      if (!String(reason).trim()) { showCaseNotice('A handoff reason is required.', 'error'); handoffBtn.disabled=false; return; }
      await api(`/monitoring/api/cases/${encodeURIComponent(incident.id)}/handoff`, {method:'POST',body:JSON.stringify({targetOperatorId:target.id,reason:String(reason).trim()})});
      await refreshSelectedResident();
      showCaseNotice(`✓ Handoff requested. You remain responsible until ${target.displayName || target.username} accepts.`);
    } catch(err) { showCaseNotice(err.message,'error'); handoffBtn.disabled=false; }
  });

  const acceptHandoffBtn = $('#acceptHandoffBtn');
  if (acceptHandoffBtn) acceptHandoffBtn.addEventListener('click', async()=>{
    if(!window.confirm(`Accept this case from ${incident.assignedOperatorName || 'the current operator'}? You will become the assigned operator.`)) return;
    acceptHandoffBtn.disabled=true;
    try { await api(`/monitoring/api/cases/${encodeURIComponent(incident.id)}/handoff/accept`,{method:'POST',body:'{}'}); await refreshSelectedResident(); showCaseNotice('✓ Handoff accepted. This case is now assigned to you.'); }
    catch(err){showCaseNotice(err.message,'error');acceptHandoffBtn.disabled=false;}
  });

  const cancelHandoffBtn = $('#cancelHandoffBtn');
  if (cancelHandoffBtn) cancelHandoffBtn.addEventListener('click', async()=>{
    if(!window.confirm(`Cancel the pending handoff to ${incident.handoffToOperatorName || 'the receiving operator'}?`)) return;
    cancelHandoffBtn.disabled=true;
    try { await api(`/monitoring/api/cases/${encodeURIComponent(incident.id)}/handoff/cancel`,{method:'POST',body:'{}'}); await refreshSelectedResident(); showCaseNotice('✓ Pending handoff cancelled.'); }
    catch(err){showCaseNotice(err.message,'error');cancelHandoffBtn.disabled=false;}
  });

  const takeoverBtn = $('#takeoverCaseBtn');
  if (takeoverBtn) takeoverBtn.addEventListener('click', async () => {
    if (!window.confirm(`Take over this case from ${incident.assignedOperatorName || 'the current operator'}?`)) return;
    takeoverBtn.disabled = true;
    try {
      await api(`/monitoring/api/cases/${encodeURIComponent(incident.id)}/takeover`, { method:'POST', body:'{}' });
      await refreshSelectedResident();
      showCaseNotice('✓ Case reassigned to you.');
    } catch (err) { showCaseNotice(err.message, 'error'); takeoverBtn.disabled=false; }
  });

  const acceptBtn = $('#acceptCaseBtn');
  if (acceptBtn) acceptBtn.addEventListener('click', async () => {
    acceptBtn.disabled = true;
    try {
      await api(`/monitoring/api/residents/${encodeURIComponent(r.residentId)}/cases/accept`, { method:'POST', body:'{}' });
      await refreshSelectedResident();
      showCaseNotice('✓ Case accepted and assigned to you.');
    } catch (err) { showCaseNotice(err.message, 'error'); acceptBtn.disabled=false; }
  });

  document.querySelectorAll('[data-supervisor-disposition]').forEach((btn) => btn.addEventListener('click', async () => {
    const disposition = btn.dataset.supervisorDisposition;
    const config = {
      continue_monitoring: ['Continue monitoring / contact attempts', 'Direct the assigned operator to continue contact attempts and monitoring while the case remains open.', false],
      return_to_operator: ['Return to operator with instructions', 'Enter the specific instructions the assigned operator must complete next.', true],
      verified_safe: ['Resident verified safe', 'Document how safety was verified. The case will remain open until closure evidence is entered and the case is resolved.', true],
      field_response: ['Request field response / welfare check', 'Document the field-response or welfare-check decision and any relevant instructions.', true],
      emergency_response: ['Initiate Emergency / 911 response', 'This records a consequential emergency escalation. Document the reason and response details.', true],
    }[disposition];
    if (!config) return;
    if (disposition === 'emergency_response' && !window.confirm('Record an Emergency / 911 supervisor disposition for this case?')) return;
    const result = await openSupervisorDispositionDialog(disposition, config[0], config[1], config[2]);
    if (!result) return;
    btn.disabled = true;
    try {
      rememberPanelScroll();
      const response = await api(`/monitoring/api/cases/${encodeURIComponent(incident.id)}/supervisor-disposition`, { method:'POST', body:JSON.stringify(result) });
      const data = await api(`/monitoring/api/residents/${encodeURIComponent(state.selectedId)}`);
      state.selectedResident = data.resident;
      renderResident(data.resident);
      restorePanelScroll();
      showCaseNotice(`✓ ${response.protocolGuidance?.label || 'Supervisor disposition recorded'}`);
      loadDashboard().catch(() => {});
    } catch (err) { showCaseNotice(err.message, 'error'); btn.disabled = false; }
  }));

  document.querySelectorAll('[data-case-action]').forEach((btn) => btn.addEventListener('click', async () => {
    const action = btn.dataset.caseAction;
    if (!confirmCaseAction(action)) return;

    let contactResult = null;
    if (CONTACT_ACTIONS.has(action)) {
      contactResult = await openContactOutcomeDialog(action);
      if (!contactResult) return;
    }

    btn.disabled = true;
    let success = btn.dataset.success || 'Action recorded';
    try {
      rememberPanelScroll();
      if (action === 'check_in_sent') {
        const result = await api(`/monitoring/api/cases/${encodeURIComponent(incident.id)}/check-ins`, { method:'POST', body:JSON.stringify({}) });
        const pushDelivered = Boolean(result.checkIn?.pushDelivered);
        if (pushDelivered) {
          showCaseNotice('✓ Push notification + in-app check-in sent.');
        } else {
          showCaseNotice('⚠ In-app check-in created, but APNs push was not delivered.', 'error');
        }
      } else {
        const body = CONTACT_ACTIONS.has(action)
          ? { action, outcome:contactResult.outcome, note:contactResult.note }
          : { action, note:'' };
        const result = await api(`/monitoring/api/cases/${encodeURIComponent(incident.id)}/actions`, { method:'POST', body:JSON.stringify(body) });
        if (result.protocolGuidance?.label) success = result.protocolGuidance.label;
      }
      const data = await api(`/monitoring/api/residents/${encodeURIComponent(state.selectedId)}`);
      state.selectedResident = data.resident;
      renderResident(data.resident);
      restorePanelScroll();
      if (action !== 'check_in_sent') showCaseNotice(`✓ ${success}`);
      loadDashboard().catch(() => {});
    } catch (err) { showCaseNotice(err.message, 'error'); btn.disabled=false; }
  }));

  const noteForm = $('#caseNoteForm');
  if (noteForm) noteForm.addEventListener('submit', async (e) => {
    e.preventDefault(); const note=$('#caseNote').value.trim(); if(!note) return;
    e.submitter.disabled=true;
    try {
      rememberPanelScroll();
      await api(`/monitoring/api/cases/${encodeURIComponent(incident.id)}/actions`, { method:'POST', body:JSON.stringify({action:'note',note}) });
      clearResidentDraft(r.residentId, 'caseNote');
      const data = await api(`/monitoring/api/residents/${encodeURIComponent(state.selectedId)}`);
      state.selectedResident = data.resident; renderResident(data.resident); restorePanelScroll();
      showCaseNotice('✓ Operator note added.'); loadDashboard().catch(()=>{});
    } catch(err){ showCaseNotice(err.message,'error'); e.submitter.disabled=false; }
  });

  const resolveForm = $('#resolveForm');
  if (resolveForm) resolveForm.addEventListener('submit', async (e) => {
    e.preventDefault(); const resolution=$('#resolutionNote').value.trim(); if(!resolution) return;
    if (!window.confirm('Resolve and close this case with the entered closure evidence?')) return;
    e.submitter.disabled=true;
    try {
      rememberPanelScroll();
      await api(`/monitoring/api/cases/${encodeURIComponent(incident.id)}/resolve`, {method:'POST',body:JSON.stringify({resolution})});
      clearResidentDraft(r.residentId, 'resolutionNote');
      const data = await api(`/monitoring/api/residents/${encodeURIComponent(state.selectedId)}`);
      state.selectedResident=data.resident; renderResident(data.resident); restorePanelScroll();
      showCaseNotice('✓ Case resolved and closed.'); loadDashboard().catch(()=>{});
    } catch(err){ showCaseNotice(err.message,'error'); e.submitter.disabled=false; }
  });

  const followForm = $('#followForm');
  if (followForm) followForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = $('#followNote').value.trim();
    if (!note) return;
    const b = e.submitter; b.disabled = true;
    try {
      await api(`/monitoring/api/residents/${encodeURIComponent(r.residentId)}/follow-up`, { method:'POST', body:JSON.stringify({ note, status:'completed' }) });
      $('#followNotice').textContent = '✓ Follow-up logged to Good Shepherd.';
      clearResidentDraft(r.residentId, 'followNote');
      $('#followNote').value = '';
      loadDashboard().catch(()=>{});
    } catch (err) { $('#followNotice').textContent = err.message; }
    finally { b.disabled = false; }
  });
}

// Background refresh: preserve the queue and selected resident while fresh data loads.
setInterval(() => {
  if (!$('#appView').classList.contains('hidden')) loadDashboard().catch(() => {});
}, 15000);

$('#staffBtn')?.addEventListener('click', openStaffManager);
$('#closeStaffBtn')?.addEventListener('click', closeStaffManager);
$('#staffModal')?.addEventListener('click', (e) => { if (e.target.id === 'staffModal') closeStaffManager(); });

$('#createStaffForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#staffFormError').textContent = '';
  try {
    const data = await api('/monitoring/api/operators', {method:'POST',body:JSON.stringify({displayName:$('#staffDisplayName').value,username:$('#staffUsername').value,role:$('#staffRole').value})});
    e.target.reset();
    const box = $('#staffCredentials');
    box.innerHTML = activationMarkup(data.activation);
    box.classList.remove('hidden');
    $('#copyActivationLink')?.addEventListener('click', () => navigator.clipboard.writeText(activationSetupText(data.activation)));
    await loadStaffList();
  } catch (err) { $('#staffFormError').textContent = err.message; }
});

$('#changePasswordForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const p1 = $('#newStaffPassword').value;
  const p2 = $('#confirmStaffPassword').value;
  $('#passwordChangeError').textContent = '';
  if (p1 !== p2) { $('#passwordChangeError').textContent = 'Passwords do not match.'; return; }
  try {
    await api('/monitoring/api/change-password', {method:'POST',body:JSON.stringify({newPassword:p1})});
    state.operator.mustChangePassword = false;
    $('#newStaffPassword').value = '';
    $('#confirmStaffPassword').value = '';
    hidePasswordChange();
  } catch (err) { $('#passwordChangeError').textContent = err.message; }
});

boot();
