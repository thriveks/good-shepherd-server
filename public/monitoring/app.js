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

async function boot() {
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
    renderResident(state.selectedResident);
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
    ['P5 Normal / Info', c.P5 || 0, 'p5'],
    ['Residents', total, ''],
  ];
  $('#metrics').innerHTML = items.map(([k, v, cl]) =>
    `<div class="metric"><div class="k">${k}</div><div class="v ${cl}">${v}</div></div>`
  ).join('');
}

function renderQueue() {
  if (!state.dashboard) return;
  const rows = (state.dashboard.residents || []).filter((r) => state.filter === 'ALL' || r.priority === state.filter);
  if (!rows.length) {
    $('#queue').innerHTML = '<div class="empty-state">No residents in this priority.</div>';
    return;
  }

  $('#queue').innerHTML = rows.map((r) => `
    <div class="queue-row ${r.residentId === state.selectedId ? 'active' : ''}" data-id="${escapeHtml(r.residentId)}">
      <div><span class="priority ${String(r.priority || 'P5').toLowerCase()}">${escapeHtml(r.priority || 'P5')}</span></div>
      <div><div class="resident-name">${escapeHtml(r.residentName)}</div><div class="small">${escapeHtml(r.location || 'Location not set')}</div>${r.activeCase ? `<div class="case-badge">${escapeHtml(r.activeCase.assignedOperatorName ? `Assigned: ${r.activeCase.assignedOperatorName}` : 'Open case')}</div>` : ''}</div>
      <div><div class="status-title">${escapeHtml(r.actionTitle || r.aiStatus || 'Monitoring')}</div><div class="status-summary">${escapeHtml(r.actionSummary || r.aiExplanation || r.patternExplanation || 'No additional explanation')}</div></div>
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
  const panel = $('#residentPanel');
  const priorScroll = panel ? panel.scrollTop : 0;
  const insights = Array.isArray(r.behaviorInsights) ? r.behaviorInsights : [];
  const sensors = Array.isArray(r.sensors) ? r.sensors : [];
  const contextCards = insightCards(insights);
  const incident = r.incident || null;
  const activeCase = incident && ['open','accepted','escalated'].includes(incident.status);
  const mine = activeCase && incident.assignedOperatorId && String(incident.assignedOperatorId) === String(state.operator?.id);
  const sensorSummary = `${r.onlineSensorCount ?? sensors.filter(s => s.isOnline).length}/${r.sensorCount ?? sensors.length} online`;
  const caseState = activeCase ? String(incident.status || 'open').toUpperCase() : 'NO ACTIVE CASE';

  panel.innerHTML = `
    <div class="resident-sticky-header">
      <div class="resident-head compact-head">
        <div class="resident-title-line"><span class="priority ${String(r.priority || 'P5').toLowerCase()}">${escapeHtml(r.priority || 'P5')}</span><div><h2>${escapeHtml(r.residentName)}</h2><div class="location">${escapeHtml(r.location || 'Location not set')}</div></div></div>
        <div class="sticky-facts"><span><b>${escapeHtml(caseState)}</b>${activeCase && incident.assignedOperatorName ? ` · ${escapeHtml(incident.assignedOperatorName)}` : ''}</span><span>${activeCase ? `Open ${escapeHtml(elapsedText(incident.openedAt, incident.closedAt))}` : '—'}</span><span>${escapeHtml(sensorSummary)}</span><span>Last ${escapeHtml(r.lastMotionAt ? fmtDate(r.lastMotionAt) : 'No activity')}</span></div>
      </div>
    </div>
    <div class="section">
      <h3>Current assessment</h3>
      <div class="callout"><strong>${escapeHtml(r.actionTitle || r.aiStatus || 'Monitoring')}</strong><div class="small assessment-detail">${escapeHtml(r.actionSummary || r.aiExplanation || r.patternExplanation || 'No additional explanation')}</div></div>
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
      </div>
    </div>
    <div class="section case-section">
      <h3>Operator case</h3>
      ${!activeCase ? `<div class="case-empty"><div>No active case is assigned for this resident.</div><button id="acceptCaseBtn" class="primary case-primary" type="button">Accept Case</button></div>` : `
        <div class="case-status"><div><strong>${escapeHtml(String(incident.status).toUpperCase())}</strong><div class="small">Opened ${fmtDate(incident.openedAt)} · ${escapeHtml(elapsedText(incident.openedAt, incident.closedAt))}</div></div><div class="case-owner">${escapeHtml(incident.assignedOperatorName ? `Assigned to ${incident.assignedOperatorName}` : 'Unassigned')}</div></div>
        ${mine ? `<div class="action-groups">
          <div class="action-group"><div class="action-group-title">Contact</div><div class="action-grid compact-actions">
            <button type="button" data-case-action="resident_call" data-success="Resident call attempt recorded">Resident call attempt</button>
            <button type="button" data-case-action="check_in_sent" data-success="Check-in recorded">Check-in sent</button>
            <button type="button" data-case-action="contact_1_call" data-success="Contact #1 call attempt recorded">Contact #1 call attempt</button>
            <button type="button" data-case-action="contact_2_call" data-success="Contact #2 call attempt recorded">Contact #2 call attempt</button>
          </div></div>
          <div class="action-group"><div class="action-group-title">Escalation</div><div class="action-grid compact-actions">
            <button type="button" data-case-action="supervisor_escalation" data-success="Supervisor escalation recorded">Escalate to supervisor</button>
            <button type="button" data-case-action="technical_review" data-success="Technical review recorded">Technical review</button>
            <button type="button" data-case-action="field_response" data-success="Field response request recorded">Field response requested</button>
            <button type="button" data-case-action="emergency_escalation" data-success="Emergency / 911 escalation recorded" class="danger-action">Emergency / 911 escalation</button>
          </div></div>
        </div>
        <div class="action-group documentation-group"><div class="action-group-title">Documentation</div>
          <form id="caseNoteForm" class="follow-form"><textarea id="caseNote" placeholder="Add operator note to this case…" required></textarea><button class="ghost" type="submit">Add note</button></form>
          <form id="resolveForm" class="resolve-form"><textarea id="resolutionNote" placeholder="Resolution / closure evidence…" required></textarea><button class="primary resolve-btn" type="submit">Resolve Case</button></form>
        </div>` : `<div class="notice">This case is being handled by ${escapeHtml(incident.assignedOperatorName || 'another operator')}.</div>`}
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

  requestAnimationFrame(() => { panel.scrollTop = priorScroll; });

  const acceptBtn = $('#acceptCaseBtn');
  if (acceptBtn) acceptBtn.addEventListener('click', async () => {
    acceptBtn.disabled = true;
    try {
      await api(`/monitoring/api/residents/${encodeURIComponent(r.residentId)}/cases/accept`, { method:'POST', body:'{}' });
      await refreshSelectedResident();
      showCaseNotice('✓ Case accepted and assigned to you.');
    } catch (err) { showCaseNotice(err.message, 'error'); acceptBtn.disabled=false; }
  });

  document.querySelectorAll('[data-case-action]').forEach((btn) => btn.addEventListener('click', async () => {
    const action = btn.dataset.caseAction;
    if (!confirmCaseAction(action)) return;
    btn.disabled = true;
    const success = btn.dataset.success || 'Action recorded';
    try {
      rememberPanelScroll();
      await api(`/monitoring/api/cases/${encodeURIComponent(incident.id)}/actions`, { method:'POST', body:JSON.stringify({ action, note:'' }) });
      const data = await api(`/monitoring/api/residents/${encodeURIComponent(state.selectedId)}`);
      state.selectedResident = data.resident;
      renderResident(data.resident);
      restorePanelScroll();
      showCaseNotice(`✓ ${success}`);
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

boot();
