(() => {
  "use strict";

  // Safari can deny Web Storage in restricted/private contexts. Startup must
  // still reach the sign-in dialog when that happens.
  const sessionValue = (key) => {
    try { return sessionStorage.getItem(key) || ""; }
    catch { return ""; }
  };
  const saveSessionValue = (key, value) => {
    try { sessionStorage.setItem(key, value); }
    catch { /* A temporary in-memory staff session still works. */ }
  };
  const removeSessionValue = (key) => {
    try { sessionStorage.removeItem(key); }
    catch { /* Nothing persisted to remove. */ }
  };

  const state = {
    apiBase: "https://good-shepherd-server-j06f.onrender.com",
    staffToken: sessionValue("gsCommandCenterStaffToken"),
    staffExpiresAt: sessionValue("gsCommandCenterStaffExpiresAt"),
    intervalMs: 5000,
    timer: null,
    selectedNodeId: null,
    latestFirmware: {
      motion: null,
      humanPresence: null
    },
    commandHistoryNodeId: null,
    actionStatus: { text: "No action in progress.", kind: "" },
    treeOpenState: new Map(),
    interactionLocked: false,
    commandInFlight: false,
    fleetMode: false,
    selectedNodeIds: new Set(),
    selectedResidentIds: new Set(),
    fleetActionInFlight: false,
    data: { nodes: [], sensors: [], residents: [] }
  };

  const APP_HEADERS = {
    "x-app-build": "1",
    "x-app-version": "command-center-2.0",
    "x-app-client": "Good Shepherd Command Center"
  };

  const el = (id) => document.getElementById(id);
  const tree = el("tree");
  const details = el("details");
  const messageBox = el("messageBox");
  const settingsDialog = el("settingsDialog");
  const residentDialog = el("residentDialog");
  const assignmentDialog = el("assignmentDialog");
  const fleetAssignmentDialog = el("fleetAssignmentDialog");
  const fleetResidentDialog = el("fleetResidentDialog");
  const fleetOtaDialog = el("fleetOtaDialog");
  const fleetResultsDialog = el("fleetResultsDialog");
  const detailsPanel = el("detailsPanel");
  const detailsBackdrop = el("detailsBackdrop");
  let assignmentSensor = null;

  const clean = (v, fallback = "") => String(v ?? "").trim() || fallback;
  const esc = (v) => String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const attr = (v) => esc(JSON.stringify(v));

  function makeHeaders({ auth = true, json = false, appWrite = false } = {}) {
    const h = { Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    if (auth && state.staffToken) h.Authorization = `Bearer ${state.staffToken}`;
    if (appWrite) Object.assign(h, APP_HEADERS);
    return h;
  }

  function clearStaffSession() {
    state.staffToken = "";
    state.staffExpiresAt = "";
    removeSessionValue("gsCommandCenterStaffToken");
    removeSessionValue("gsCommandCenterStaffExpiresAt");
  }

  async function request(path, { method = "GET", body, auth = true, appWrite = false, allowPartial = false } = {}) {
    const response = await fetch(`${state.apiBase}${path}`, {
      method,
      headers: makeHeaders({ auth, json: body !== undefined, appWrite }),
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch {
      const error = new Error(`${path} returned non-JSON data (HTTP ${response.status})`);
      error.status = response.status;
      throw error;
    }
    if (!response.ok || (!allowPartial && data?.success === false)) {
      const error = new Error(data?.error || `${method} ${path} failed with HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function loadData({ force = false } = {}) {
    if (state.interactionLocked && !force) return;
    setConnection("waiting", "Refreshing live data…");
    try {
      const [nodes, inventory, dashboard, motionFirmware, humanPresenceFirmware, residents] = await Promise.all([
        request("/nodes?includeArchived=true"),
        request("/sensor-inventory?includeArchived=true", {  }),
        request("/ai/dashboard"),
        request("/firmware/latest", {  }).catch(() => null),
        request("/firmware/human-presence/latest", {  }).catch(() => null),
        request("/residents", {  })
      ]);

      state.data.nodes = Array.isArray(nodes.nodes) ? nodes.nodes : [];
      state.data.sensors = Array.isArray(inventory.sensors) ? inventory.sensors : [];
      const residentRecords = Array.isArray(residents?.residents) ? residents.residents : [];
      const dashboardResidents = Array.isArray(dashboard?.summary?.residents)
        ? dashboard.summary.residents
        : Array.isArray(dashboard?.residents) ? dashboard.residents : [];

      state.data.residents = residentRecords.map((resident) => {
        const intelligence = dashboardResidents.find((item) =>
          clean(item.residentId || item.id) === clean(resident.id) ||
          clean(item.residentName || item.name).toLowerCase() === clean(resident.name).toLowerCase()
        );
        return { ...intelligence, ...resident, residentId: resident.id, residentName: resident.name };
      });

      state.latestFirmware.motion = motionFirmware?.release || null;
      state.latestFirmware.humanPresence = humanPresenceFirmware?.release || null;

      reconcileFleetSelection();
      render();
      if (state.selectedNodeId) {
        const sensor = allSensors().find((s) => s.nodeId === state.selectedNodeId);
        if (sensor) {
          showSensor(sensor);
          if (state.commandHistoryNodeId === sensor.nodeId) {
            await loadCommands(sensor.nodeId, { preserveSelection: true });
          }
        }
      }
      setConnection("online", `Live · updated ${new Date().toLocaleTimeString()}`);
      hideMessage();
    } catch (error) {
      setConnection("offline", "Connection failed");
      if (error.status === 401 || /unauthorized/i.test(error.message)) {
        clearStaffSession();
        showMessage("Staff session required. Enter your 4-digit staff code.", "error");
        openSettingsDialog();
        return;
      }
      showMessage(error.message, "error");
    }
  }

  function lockInteraction(reason = "Device controls active") {
    state.interactionLocked = true;
    el("modeBadge").textContent = "CONTROL LOCK";
    el("modeBadge").className = "mode-badge locked";
    el("resumeLiveButton").classList.remove("hidden");
    el("statusText").textContent = `${reason} · automatic refresh paused`;
  }

  function resumeLiveMonitoring() {
    state.interactionLocked = false;
    state.commandInFlight = false;
    state.selectedNodeId = null;
    state.commandHistoryNodeId = null;
    state.actionStatus = { text: "No action in progress.", kind: "" };
    el("modeBadge").textContent = "LIVE";
    el("modeBadge").className = "mode-badge live";
    el("resumeLiveButton").classList.add("hidden");
    details.classList.add("muted");
    details.innerHTML = "Select a resident, room, or sensor.";
    loadData();
  }

  function setConnection(kind, text) {
    el("statusText").textContent = text;
    el("liveDot").className = `dot ${kind}`;
  }

  function showMessage(text, kind = "") {
    messageBox.textContent = text;
    messageBox.className = `message ${kind}`;
  }

  function hideMessage() { messageBox.classList.add("hidden"); }

  function isCompactLayout() {
    return window.matchMedia("(max-width: 980px)").matches;
  }

  function openDetailsPanel() {
    if (!detailsPanel || !isCompactLayout()) return;
    document.body.classList.add("details-open");
    detailsBackdrop?.classList.remove("hidden");
  }

  function closeDetailsPanel() {
    document.body.classList.remove("details-open");
    detailsBackdrop?.classList.add("hidden");
  }

  function openSettingsDialog() {
    // Avoid an uncaught exception on iPads with an incomplete dialog API.
    if (settingsDialog.open) return;
    if (typeof settingsDialog.showModal === "function") {
      settingsDialog.showModal();
      return;
    }
    settingsDialog.setAttribute("open", "");
  }

  function closeSettingsDialog() {
    if (typeof settingsDialog.close === "function") settingsDialog.close();
    else settingsDialog.removeAttribute("open");
  }

  function nodeFor(sensor) {
    return state.data.nodes.find((n) => clean(n.nodeId) === clean(sensor.nodeId)) || null;
  }

  function residentFor(sensor) {
    return state.data.residents.find((r) =>
      clean(r.residentId || r.id) === clean(sensor.residentId)
    ) || state.data.residents.find((r) =>
      clean(r.residentName || r.name).toLowerCase() === clean(sensor.residentName).toLowerCase()
    ) || null;
  }

  function firmwareFamilyForSensor(sensor, node = null) {
    const signals = [
      sensor?.sensorType,
      sensor?.sourceKey,
      sensor?.sourceName,
      sensor?.displayName,
      sensor?.sensorMode,
      sensor?.diagnostics?.sensorMode,
      sensor?.softwareVersion,
      node?.nodeName,
      node?.softwareVersion
    ].map((value) => clean(value).toLowerCase()).join(" ");

    const isHumanPresence =
      signals.includes("human presence") ||
      signals.includes("presence-") ||
      signals.includes("presence sensor") ||
      signals.includes("ld2410") ||
      signals.includes("motion_presence") ||
      signals.includes("motion-presence") ||
      signals.includes("motion + presence");

    return isHumanPresence ? "humanPresence" : "motion";
  }

  function latestFirmwareForSensor(sensor, node = null) {
    const family = firmwareFamilyForSensor(sensor, node);
    return {
      family,
      release: state.latestFirmware[family] || null
    };
  }

  function firmwareState(version, sensor, node = null) {
    const resolved = latestFirmwareForSensor(sensor, node);
    const latest = clean(resolved.release?.firmwareVersion);
    const current = clean(version);
    if (!latest) return { key: "unknown", label: "Latest unknown", family: resolved.family, release: null };
    if (!current) return { key: "unknown", label: `Unknown · latest ${latest}`, family: resolved.family, release: resolved.release };
    if (current === latest) return { key: "current", label: "Current", family: resolved.family, release: resolved.release };
    return { key: "update", label: `Update available: ${latest}`, family: resolved.family, release: resolved.release };
  }

  function normalizeSensor(sensor) {
    const node = nodeFor(sensor);
    const online = typeof sensor.isOnline === "boolean"
      ? sensor.isOnline
      : typeof node?.isOnline === "boolean" ? node.isOnline : null;
    const version = clean(sensor.softwareVersion || node?.softwareVersion);
    const firmware = firmwareState(version, sensor, node);
    return {
      ...sensor,
      node,
      resident: residentFor(sensor),
      online,
      version,
      firmware,
      latestFirmware: firmware.release,
      firmwareFamily: firmware.family,
      isArchived: sensor.isArchived === true || node?.isArchived === true,
      archivedReason: sensor.archivedReason || node?.archivedReason || null,
      residentName: clean(sensor.residentName, "Unassigned"),
      locationName: clean(sensor.locationName || sensor.nodeLocationName, "Unassigned Location"),
      roomName: clean(sensor.roomName, "No Room"),
      sourceName: clean(sensor.sourceName || sensor.displayName || sensor.nodeName, "Unnamed Sensor"),
      sensorType: clean(sensor.sensorType, "Sensor"),
      nodeId: clean(sensor.nodeId, "No node ID"),
      sourceKey: clean(sensor.sourceKey, "No source key"),
      assigned: sensor.isAssigned === true || Boolean(sensor.residentId) ||
        clean(sensor.setupState).toLowerCase() === "assigned" ||
        clean(sensor.residentName).toLowerCase() !== "unassigned"
    };
  }

  const allSensors = () => state.data.sensors.map(normalizeSensor);

  function sensorByNodeId(nodeId) {
    return allSensors().find((sensor) => clean(sensor.nodeId) === clean(nodeId)) || null;
  }

  function selectedSensors() {
    const selected = state.selectedNodeIds;
    return allSensors().filter((sensor) => selected.has(sensor.nodeId));
  }

  function selectedResidents() {
    return state.data.residents.filter((resident) =>
      state.selectedResidentIds.has(clean(resident.id || resident.residentId))
    );
  }

  function visibleSensors() {
    const sensors = allSensors();
    if (el("viewSelect").value === "inventory") {
      return sensors.filter(matches);
    }
    return sensors.filter((sensor) => !sensor.isArchived && matches(sensor));
  }

  function residentNodeIds(residentId) {
    const id = clean(residentId);
    if (!id) return [];
    return allSensors()
      .filter((sensor) => clean(sensor.residentId) === id && !sensor.isArchived)
      .map((sensor) => sensor.nodeId);
  }

  function reconcileResidentSelections() {
    for (const residentId of [...state.selectedResidentIds]) {
      const nodeIds = residentNodeIds(residentId);
      if (!nodeIds.length || nodeIds.some((nodeId) => !state.selectedNodeIds.has(nodeId))) {
        state.selectedResidentIds.delete(residentId);
      }
    }
  }

  function reconcileFleetSelection() {
    const validNodes = new Set(allSensors().map((sensor) => sensor.nodeId));
    for (const nodeId of [...state.selectedNodeIds]) {
      if (!validNodes.has(nodeId)) state.selectedNodeIds.delete(nodeId);
    }

    const validResidents = new Set(
      state.data.residents.map((resident) => clean(resident.id || resident.residentId)).filter(Boolean)
    );
    for (const residentId of [...state.selectedResidentIds]) {
      if (!validResidents.has(residentId)) state.selectedResidentIds.delete(residentId);
    }

    reconcileResidentSelections();
  }

  function setNodeSelection(nodeIds, selected) {
    for (const nodeId of nodeIds.map(clean).filter(Boolean)) {
      if (selected) state.selectedNodeIds.add(nodeId);
      else state.selectedNodeIds.delete(nodeId);
    }
    reconcileResidentSelections();
  }

  function setResidentSelection(residentId, nodeIds, selected) {
    const id = clean(residentId);
    setNodeSelection(nodeIds, selected);
    if (id) {
      if (selected) state.selectedResidentIds.add(id);
      else state.selectedResidentIds.delete(id);
    }
  }

  function selectionStateFor(nodeIds) {
    const ids = nodeIds.map(clean).filter(Boolean);
    const selectedCount = ids.filter((nodeId) => state.selectedNodeIds.has(nodeId)).length;
    return {
      checked: ids.length > 0 && selectedCount === ids.length,
      indeterminate: selectedCount > 0 && selectedCount < ids.length
    };
  }

  function hierarchy() {
    const residents = new Map();
    const unassigned = [];
    for (const sensor of allSensors()) {
      if (sensor.isArchived) continue;
      if (!sensor.assigned) { unassigned.push(sensor); continue; }
      const name = sensor.residentName;
      if (!residents.has(name)) {
        const raw = residentFor(sensor);
        residents.set(name, {
          id: raw?.residentId || raw?.id || sensor.residentId || null,
          name,
          location: sensor.locationName,
          raw,
          rooms: new Map()
        });
      }
      const resident = residents.get(name);
      if (!resident.rooms.has(sensor.roomName)) resident.rooms.set(sensor.roomName, []);
      resident.rooms.get(sensor.roomName).push(sensor);
    }
    return {
      residents: [...residents.values()].sort((a, b) => a.name.localeCompare(b.name)),
      unassigned
    };
  }

  function matches(sensor) {
    const filter = el("filterSelect").value;
    const term = el("searchInput").value.trim().toLowerCase();
    const text = [
      sensor.residentName, sensor.locationName, sensor.roomName, sensor.nodeId,
      sensor.sourceKey, sensor.sourceName, sensor.sensorType, sensor.version,
      sensor.node?.wifiSsid
    ].join(" ").toLowerCase();
    if (term && !text.includes(term)) return false;
    if (filter === "assigned" && !sensor.assigned) return false;
    if (filter === "unassigned" && sensor.assigned) return false;
    if (filter === "online" && sensor.online !== true) return false;
    if (filter === "offline" &&
        (sensor.online !== false || sensorReadyForSetup(sensor))) return false;
    if (filter === "updates" && sensor.firmware.key !== "update") return false;
    return true;
  }

  function treeKeyForDetails(detailsElement) {
    const summary = detailsElement.querySelector(":scope > summary");
    if (!summary) return null;

    if (summary.dataset.kind === "resident") {
      try {
        const data = JSON.parse(summary.dataset.json);
        return `resident:${clean(data.id || data.name)}`;
      } catch {}
    }

    if (summary.dataset.kind === "room") {
      try {
        const data = JSON.parse(summary.dataset.json);
        return `room:${clean(data.resident)}:${clean(data.room)}`;
      } catch {}
    }

    const title = summary.querySelector(".title")?.textContent?.trim();
    return title ? `group:${title}` : null;
  }

  function captureTreeOpenState() {
    const next = new Map();
    tree.querySelectorAll("details").forEach((item) => {
      const key = treeKeyForDetails(item);
      if (key) next.set(key, item.open);
    });
    state.treeOpenState = next;
  }

  function restoreTreeOpenState() {
    if (!state.treeOpenState?.size) return;
    tree.querySelectorAll("details").forEach((item) => {
      const key = treeKeyForDetails(item);
      if (key && state.treeOpenState.has(key)) {
        item.open = state.treeOpenState.get(key);
      }
    });
  }

  function render() {
    captureTreeOpenState();
    const pageScrollY = window.scrollY;
    const h = hierarchy();
    const sensors = allSensors();
    el("residentCount").textContent = h.residents.length;
    el("sensorCount").textContent = sensors.length;
    el("onlineCount").textContent = sensors.filter((s) => s.online === true && !s.isArchived).length;
    el("offlineCount").textContent = sensors.filter((s) => s.online === false && !s.isArchived).length;
    el("unassignedCount").textContent = h.unassigned.filter((s) => !s.isArchived).length;
    el("updateCount").textContent = sensors.filter((s) => s.firmware.key === "update" && !s.isArchived).length;
    el("archivedCount").textContent = sensors.filter((s) => s.isArchived).length;

    if (el("viewSelect").value === "inventory") {
      el("treeHeading").textContent = "All Sensors";
      tree.innerHTML = renderInventory(sensors);
    } else {
      el("treeHeading").textContent = "Resident → Room → Sensor";
      const residents = h.residents.map(renderResident).join("");
      const unassigned = h.unassigned.filter((s) => matches(s) && !s.isArchived);
      const unassignedHtml = `
        <details open>
          <summary><span class="summary-main"><span class="title">Unassigned Devices</span>
          <span class="subtitle">${unassigned.length} device(s)</span></span>
          <span class="badge unassigned">${unassigned.length}</span></summary>
          <div class="branch">${unassigned.length ? unassigned.map(renderSensor).join("") : '<p class="muted">None</p>'}</div>
        </details>`;

      tree.innerHTML = residents + unassignedHtml || '<p class="muted">No matching records.</p>';
    }

    restoreTreeOpenState();
    bindTree();
    renderFleetControls();
    requestAnimationFrame(() => window.scrollTo({ top: pageScrollY, behavior: "auto" }));
  }

  function renderInventory(sensors) {
    const groups = [
      ["Unassigned", sensors.filter((s) => !s.assigned && !s.isArchived), "unassigned"],
      ["Assigned", sensors.filter((s) => s.assigned && !s.isArchived), "online"],
      ["Offline", sensors.filter((s) => s.online === false && !s.isArchived), "offline"],
      ["Updates Available", sensors.filter((s) => s.firmware.key === "update" && !s.isArchived), "warning"],
      ["Archived", sensors.filter((s) => s.isArchived), "archived"]
    ];

    return `<div class="inventory-section">${groups.map(([title, items, badge]) => {
      const filtered = items.filter(matches);
      return `<details open>
        <summary>
          <span class="summary-main">
            <span class="title">${esc(title)}</span>
            <span class="subtitle">${filtered.length} sensor(s)</span>
          </span>
          <span class="badge ${badge}">${filtered.length}</span>
        </summary>
        <div class="branch">${filtered.length ? filtered.map(renderSensor).join("") : '<p class="muted">None</p>'}</div>
      </details>`;
    }).join("")}</div>`;
  }

  function renderResident(resident) {
    const rooms = [...resident.rooms.entries()]
      .map(([name, sensors]) => [name, sensors.filter(matches)])
      .filter(([, sensors]) => sensors.length);
    if (!rooms.length) return "";

    const flatSensors = rooms.flatMap(([, sensors]) => sensors);
    const count = flatSensors.length;
    const updates = flatSensors.filter((sensor) => sensor.firmware.key === "update").length;
    const residentId = clean(resident.id);
    const residentSelection = selectionStateFor(flatSensors.map((sensor) => sensor.nodeId));
    const residentPayload = {
      id: resident.id,
      name: resident.name,
      location: resident.location,
      raw: resident.raw,
      sensors: flatSensors
    };

    return `<details open>
      <summary data-kind="resident" data-json="${attr(residentPayload)}">
        ${state.fleetMode ? `
          <span class="branch-select-control" title="Select every visible sensor for ${esc(resident.name)}">
            <input type="checkbox"
              data-fleet-select="resident"
              data-resident-id="${esc(residentId)}"
              data-node-ids="${attr(flatSensors.map((sensor) => sensor.nodeId))}"
              ${residentSelection.checked ? "checked" : ""}>
          </span>` : ""}
        <span class="summary-main"><span class="title">${esc(resident.name)}</span>
        <span class="subtitle">${esc(resident.location)} · ${count} sensor(s)</span></span>
        ${updates ? `<span class="badge warning">${updates} update${updates === 1 ? "" : "s"}</span>` : ""}
      </summary>
      <div class="branch">${rooms.map(([room, sensors]) => {
        const roomSelection = selectionStateFor(sensors.map((sensor) => sensor.nodeId));
        return `
        <details open>
          <summary data-kind="room" data-json="${attr({ resident: resident.name, room, sensors })}">
            ${state.fleetMode ? `
              <span class="branch-select-control" title="Select every visible sensor in ${esc(room)}">
                <input type="checkbox"
                  data-fleet-select="room"
                  data-node-ids="${attr(sensors.map((sensor) => sensor.nodeId))}"
                  ${roomSelection.checked ? "checked" : ""}>
              </span>` : ""}
            <span class="summary-main"><span class="title">${esc(room)}</span>
            <span class="subtitle">${sensors.filter((sensor) => sensor.online === true).length}/${sensors.length} online</span></span>
          </summary>
          <div class="branch">${sensors.map(renderSensor).join("")}</div>
        </details>`;
      }).join("")}
      </div>
    </details>`;
  }

  function sensorReadyForSetup(sensor) {
    const setupState = clean(sensor?.setupState).toLowerCase();

    return !sensor?.isArchived &&
      (setupState === "unassigned" || sensor?.assigned === false);
  }

  function sensorStatus(sensor) {
    if (sensorReadyForSetup(sensor)) {
      return { cls: "unknown", label: "Ready for Setup" };
    }

    if (sensor?.online === true) {
      return { cls: "online", label: "Online" };
    }

    if (sensor?.online === false) {
      return { cls: "offline", label: "Offline" };
    }

    return { cls: "unknown", label: "Unknown" };
  }

  function renderSensor(sensor) {
    const status = sensorStatus(sensor);
    const cls = status.cls;
    const label = status.label;
    const checked = state.selectedNodeIds.has(sensor.nodeId);

    return `<div class="sensor-row ${state.selectedNodeId === sensor.nodeId ? "selected" : ""}">
      ${state.fleetMode ? `
        <label class="sensor-select-control" title="Select ${esc(sensor.sourceName)}">
          <input type="checkbox" data-fleet-select="sensor" data-node-id="${esc(sensor.nodeId)}" ${checked ? "checked" : ""}>
        </label>` : ""}
      <button class="item-button ${state.selectedNodeId === sensor.nodeId ? "selected" : ""}"
        type="button" data-kind="sensor" data-json="${attr(sensor)}">
        <span class="sensor-dot ${cls}"></span>
        <span><span class="title">${esc(sensor.sourceName)}</span>
        <span class="subtitle">${esc(sensor.sensorType)} · ${esc(sensor.nodeId)}</span></span>
        <span><span class="badge ${cls}">${label}</span>
        ${sensor.firmware.key === "update" && !sensor.isArchived ? '<span class="badge warning">Update</span>' : ""}
        ${sensor.isArchived ? '<span class="badge archived">Archived</span>' : ""}</span>
      </button>
    </div>`;
  }

  function bindTree() {
    tree.querySelectorAll("[data-fleet-select]").forEach((checkbox) => {
      const nodeIds = checkbox.dataset.nodeIds
        ? JSON.parse(checkbox.dataset.nodeIds)
        : checkbox.dataset.nodeId ? [checkbox.dataset.nodeId] : [];

      const selection = selectionStateFor(nodeIds);
      checkbox.checked = selection.checked;
      checkbox.indeterminate = selection.indeterminate;

      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", (event) => {
        event.stopPropagation();

        if (checkbox.dataset.fleetSelect === "resident") {
          setResidentSelection(checkbox.dataset.residentId, nodeIds, checkbox.checked);
        } else {
          setNodeSelection(nodeIds, checkbox.checked);
        }

        render();
      });
    });

    tree.querySelectorAll(".branch-select-control, .sensor-select-control").forEach((control) => {
      control.addEventListener("click", (event) => event.stopPropagation());
    });

    tree.querySelectorAll("[data-json]").forEach((item) => {
      item.addEventListener("click", (event) => {
        if (item.tagName === "SUMMARY") {
          event.preventDefault();
          item.parentElement.open = !item.parentElement.open;
        }

        const data = JSON.parse(item.dataset.json);
        if (item.dataset.kind === "sensor") {
          if (state.selectedNodeId !== data.nodeId) {
            state.commandHistoryNodeId = null;
            state.actionStatus = { text: "No action in progress.", kind: "" };
          }
          state.selectedNodeId = data.nodeId;
          showSensor(sensorByNodeId(data.nodeId) || data);
          render();
          openDetailsPanel();
        } else if (item.dataset.kind === "resident") {
          showResident(data);
          openDetailsPanel();
        } else {
          showGeneric(item.dataset.kind, data);
          openDetailsPanel();
        }
      });
    });
  }

  const rows = (fields) => fields
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("");

  function ageText(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return "Unknown";
    if (value < 60) return `${Math.max(0, Math.round(value))} seconds ago`;
    if (value < 3600) return `${Math.round(value / 60)} minutes ago`;
    return `${Math.round(value / 3600)} hours ago`;
  }

  function wifiQuality(rssi) {
    const value = Number(rssi);
    if (!Number.isFinite(value)) return { label: "Unknown", cls: "" };
    if (value >= -60) return { label: "Strong", cls: "strong" };
    if (value >= -72) return { label: "Fair", cls: "fair" };
    return { label: "Weak", cls: "weak" };
  }

  function showSensor(sensor) {
    const rssi = sensor.wifiRssi ?? sensor.node?.wifiRssi;
    const wifi = wifiQuality(rssi);
    const heartbeatSeconds = sensor.secondsSinceHealthCheckIn ?? sensor.node?.secondsSinceHealthCheckIn;
    const latestFirmware = sensor.latestFirmware || latestFirmwareForSensor(sensor, sensor.node).release;
    const localStateChangeDisabled = sensor.online !== true;
    const localStateChangeTitle = localStateChangeDisabled
      ? "Sensor must be online for this operation."
      : "";
    const fields = [
      ["Resident", sensor.residentName], ["Location", sensor.locationName],
      ["Room", sensor.roomName], ["Sensor", sensor.sourceName],
      ["Sensor type", sensor.sensorType],
      ["Status", sensorStatus(sensor).label],
      ["Cloud connection", sensor.online === true ? "Online" : sensor.online === false ? "Offline" : "Unknown"],
      ["Archived", sensor.isArchived ? "Yes" : "No"],
      ["Archive reason", sensor.archivedReason],
      ["Node ID", sensor.nodeId], ["Source key", sensor.sourceKey],
      ["Setup state", sensor.setupState], ["Assignment authority", sensor.assignmentAuthority],
      ["Firmware", sensor.version || "Unknown"],
      ["Latest firmware", latestFirmware?.firmwareVersion || "Unknown"],
      ["Firmware status", sensor.firmware.label],
      ["Wi-Fi", sensor.wifiSsid || sensor.node?.wifiSsid],
      ["Wi-Fi quality", `${wifi.label}${Number.isFinite(Number(rssi)) ? ` (${rssi} dBm)` : ""}`],
      ["Last heartbeat", ageText(heartbeatSeconds)]
    ];

    details.classList.remove("muted");
    details.innerHTML = `<div class="live-control-banner">Live monitoring remains active while you work with this device.</div><dl>${rows(fields)}</dl>
      <div class="copy-row"><code>${esc(sensor.nodeId)}</code><button data-copy="${esc(sensor.nodeId)}">Copy Node ID</button></div>
      <div class="copy-row"><code>${esc(sensor.sourceKey)}</code><button data-copy="${esc(sensor.sourceKey)}">Copy Source Key</button></div>
      <h3>Device controls</h3>
      <div class="action-grid">
        ${sensor.isArchived ? `
          <button data-action="restore" class="wide">Restore archived device</button>
          <button data-action="delete-permanent" class="danger wide">Permanently Delete Device</button>
        ` : `
          <button data-action="ping">Ping</button>
          <button data-action="identify">Identify</button>
          <button data-action="reboot" class="warning">Restart</button>
          <button data-action="firmware">Update firmware</button>
          <button data-action="cleanup" class="wide">Clean command queue</button>
          <button data-action="assign" class="wide">Assign / move</button>
          ${sensorReadyForSetup(sensor) ? "" : `<button data-action="reconfigure" class="warning wide" ${localStateChangeDisabled ? "disabled" : ""} title="${esc(localStateChangeTitle)}">Reconfigure sensor${localStateChangeDisabled ? " (online only)" : ""}</button>`}
          <button data-action="unassign" class="wide">Remove from resident</button>
          <button data-action="archive" class="danger">Archive device</button>
          <button data-action="factory" class="danger" ${localStateChangeDisabled ? "disabled" : ""} title="${esc(localStateChangeTitle)}">Factory reset${localStateChangeDisabled ? " (online only)" : ""}</button>
        `}
      </div>
      <div id="actionStatus" class="action-status ${state.actionStatus.kind || "muted"}">${esc(state.actionStatus.text)}</div>
      <h3>Command history</h3>
      <button id="loadCommandsButton">Load command history</button>
      <div id="commandHistory" class="command-list"></div>
      <h3>Raw data</h3>
      <pre class="raw">${esc(JSON.stringify(sensor, null, 2))}</pre>`;

    details.querySelectorAll("[data-action]").forEach((button) =>
      button.addEventListener("click", () => sensorAction(button.dataset.action, sensor))
    );
    details.querySelectorAll("[data-copy]").forEach((button) =>
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copy);
          setAction("Copied.", "success");
        } catch {
          setAction("Copy failed. Select and copy the value manually.", "error");
        }
      })
    );
    el("loadCommandsButton").addEventListener("click", () => loadCommands(sensor.nodeId));
  }

  function showResident(resident) {
    const sensors = Array.isArray(resident.sensors)
      ? resident.sensors
      : resident.rooms && typeof resident.rooms.values === "function"
        ? [...resident.rooms.values()].flat()
        : [];
    const raw = resident.raw || {};
    details.classList.remove("muted");
    details.innerHTML = `<div class="live-control-banner">Live monitoring remains active while you work with this resident.</div><dl>${rows([
      ["Resident ID", resident.id], ["Name", resident.name], ["Location", resident.location],
      ["Sensors", sensors.length], ["Offline sensors", sensors.filter((sensor) => sensor.online === false).length],
      ["Updates available", sensors.filter((sensor) => sensor.firmware?.key === "update").length],
      ["AI status", raw.aiStatus || raw.aiLevel], ["Last motion", raw.lastMotionAt],
      ["Presence", raw.presenceStatus]
    ])}</dl>
      <h3>Resident controls</h3>
      <div class="action-grid">
        <button data-resident-action="edit" class="wide">Edit resident</button>
        <button data-resident-action="delete" class="danger wide">Delete resident</button>
      </div>
      <div id="actionStatus" class="action-status ${state.actionStatus.kind || "muted"}">${esc(state.actionStatus.text)}</div>
      <h3>Raw data</h3><pre class="raw">${esc(JSON.stringify(raw || resident, null, 2))}</pre>`;

    details.querySelectorAll("[data-resident-action]").forEach((button) =>
      button.addEventListener("click", () => residentAction(button.dataset.residentAction, resident))
    );
  }

  function showGeneric(kind, data) {
    details.classList.remove("muted");
    details.innerHTML = `<dl>${rows([
      ["Type", kind], ["Name", data.name || data.room],
      ["Location", data.location], ["Sensor count", data.sensors?.length]
    ])}</dl><h3>Raw data</h3><pre class="raw">${esc(JSON.stringify(data, null, 2))}</pre>`;
  }


  function clearFleetSelection() {
    state.selectedNodeIds.clear();
    state.selectedResidentIds.clear();
    render();
  }

  function toggleFleetMode() {
    state.fleetMode = !state.fleetMode;
    if (!state.fleetMode) {
      state.selectedNodeIds.clear();
      state.selectedResidentIds.clear();
    }
    render();
  }

  function toggleVisibleSelection() {
    const nodeIds = [...new Set(visibleSensors().map((sensor) => sensor.nodeId))];
    if (!nodeIds.length) return;
    const allSelected = nodeIds.every((nodeId) => state.selectedNodeIds.has(nodeId));
    setNodeSelection(nodeIds, !allSelected);
    render();
  }

  function renderFleetControls() {
    const fleetModeButton = el("fleetModeButton");
    const selectVisibleButton = el("selectVisibleButton");
    const fleetBar = el("fleetBar");
    if (!fleetModeButton || !selectVisibleButton || !fleetBar) return;

    fleetModeButton.textContent = state.fleetMode ? "Exit fleet mode" : "Manage fleet";
    fleetModeButton.classList.toggle("active", state.fleetMode);
    selectVisibleButton.classList.toggle("hidden", !state.fleetMode);

    const visible = visibleSensors();
    const visibleIds = [...new Set(visible.map((sensor) => sensor.nodeId))];
    const allVisibleSelected = visibleIds.length > 0 &&
      visibleIds.every((nodeId) => state.selectedNodeIds.has(nodeId));
    selectVisibleButton.textContent = allVisibleSelected ? "Clear visible" : "Select visible";
    selectVisibleButton.disabled = !visibleIds.length || state.fleetActionInFlight;

    const sensors = selectedSensors();
    const residents = selectedResidents();
    const count = sensors.length;

    if (count === 0 && residents.length === 0) {
      fleetBar.classList.add("hidden");
      return;
    }

    fleetBar.classList.remove("hidden");
    el("fleetCount").textContent =
      `${count} sensor${count === 1 ? "" : "s"} selected` +
      (residents.length ? ` · ${residents.length} resident${residents.length === 1 ? "" : "s"}` : "");

    const online = sensors.filter((sensor) => sensor.online === true && !sensor.isArchived).length;
    const offline = sensors.filter((sensor) => sensor.online === false && !sensor.isArchived).length;
    const updates = sensors.filter((sensor) => sensor.firmware.key === "update" && !sensor.isArchived).length;
    const archived = sensors.filter((sensor) => sensor.isArchived).length;
    el("fleetSummary").textContent =
      `${online} online · ${offline} offline · ${updates} update${updates === 1 ? "" : "s"}` +
      (archived ? ` · ${archived} archived` : "");

    fleetBar.querySelectorAll("[data-fleet-action]").forEach((button) => {
      const action = button.dataset.fleetAction;
      const residentOnly = action === "resident-edit";
      button.disabled = state.fleetActionInFlight ||
        (residentOnly ? residents.length === 0 : sensors.length === 0);
    });
  }

  function fleetResultRow(item, success) {
    const nodeId = clean(item?.nodeId || item?.residentId || item?.id, "Unknown");
    const detail = clean(
      item?.error ||
      item?.message ||
      item?.command?.status ||
      item?.status ||
      (success ? "Completed" : "Failed")
    );
    return `<div class="fleet-result-row ${success ? "success" : "error"}">
      <strong>${esc(nodeId)}</strong>
      <span>${esc(detail)}</span>
    </div>`;
  }

  function showFleetResults(title, payload = {}) {
    if (!fleetResultsDialog) return;

    const results = Array.isArray(payload.results) ? payload.results : [];
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const requestedCount = Number(payload.requestedCount ?? (results.length + errors.length));
    const successCount = Number(payload.successCount ?? results.length);
    const errorCount = Number(payload.errorCount ?? errors.length);

    const queuedCommandBatch = results.some((item) => item?.command);

    el("fleetResultsTitle").textContent = title;
    el("fleetResultsSummary").textContent = queuedCommandBatch
      ? `${requestedCount || 0} requested · ${successCount || 0} queued · ${errorCount || 0} rejected`
      : `${requestedCount || 0} requested · ${successCount || 0} succeeded · ${errorCount || 0} failed`;

    const rowsHtml = [
      ...results.map((item) => fleetResultRow(item, true)),
      ...errors.map((item) => fleetResultRow(item, false))
    ].join("");

    el("fleetResultsList").innerHTML =
      rowsHtml || `<div class="muted">${esc(payload.message || "No per-device results were returned.")}</div>`;

    if (!fleetResultsDialog.open) {
      fleetResultsDialog.showModal();
    }
  }


  async function commandById(nodeId, commandId) {
    const payload = await request(`/sensor-commands/${encodeURIComponent(nodeId)}`);
    const commands = Array.isArray(payload.commands) ? payload.commands : [];
    return commands.find((item) => clean(item.commandId) === clean(commandId)) || null;
  }

  function factoryResetStatusLabel(status) {
    if (status === "success") return "reset confirmed";
    if (status === "failed") return "failed";
    if (status === "running") return "sensor received command";
    if (status === "pending") return "waiting for sensor";
    return "status unavailable";
  }

  async function monitorFactoryResetCommand({ nodeId, commandId, sourceName }) {
    if (!nodeId || !commandId) {
      state.commandInFlight = false;
      setAction(
        "Factory reset was queued, but its command ID was not returned. Check command history before trying again.",
        "error"
      );
      return;
    }

    const timeoutMs = 6 * 60 * 1000;
    const startedAt = Date.now();
    let lastStatus = "";
    let readFailures = 0;

    while (Date.now() - startedAt < timeoutMs) {
      try {
        const command = await commandById(nodeId, commandId);
        const status = clean(command?.status, "unknown").toLowerCase();
        const commandError = clean(command?.error);
        readFailures = 0;

        if (status !== lastStatus) {
          lastStatus = status;

          if (status === "pending") {
            setAction("Factory reset sent. Waiting for the sensor to receive the command…");
          } else if (status === "running") {
            setAction("Sensor received the factory reset. Waiting for physical reset confirmation…");
          }

          await loadCommands(nodeId);
        }

        if (status === "success") {
          state.commandInFlight = false;
          const message = `Factory reset confirmed by ${clean(sourceName, nodeId)}. The sensor is rebooting into first-use setup.`;
          setAction(message, "success");
          showMessage(message, "success");
          await loadCommands(nodeId);
          await loadData({ force: true });
          return;
        }

        if (status === "failed") {
          state.commandInFlight = false;
          const message = commandError
            ? `Factory reset failed: ${commandError}`
            : "Factory reset failed before the sensor confirmed completion.";
          setAction(message, "error");
          showMessage(message, "error");
          await loadCommands(nodeId);
          return;
        }
      } catch (error) {
        readFailures += 1;
        if (readFailures >= 3) {
          setAction(
            `Factory reset is still awaiting confirmation. Status checks are temporarily failing: ${error.message}`,
            "error"
          );
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    state.commandInFlight = false;
    const message =
      "Factory reset was not confirmed before the command window expired. The sensor has not been treated as reset. Check connectivity and command history before trying again.";
    setAction(message, "error");
    showMessage(message, "error");
    await loadCommands(nodeId);
  }

  async function monitorFleetFactoryResetCommands(queuedResults) {
    const targets = queuedResults
      .map((item) => ({
        nodeId: clean(item?.nodeId),
        commandId: clean(item?.command?.commandId)
      }))
      .filter((item) => item.nodeId && item.commandId);

    if (!targets.length) return;

    const timeoutMs = 6 * 60 * 1000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const outcome = await runWithConcurrency(targets, 8, async (target) => {
        const command = await commandById(target.nodeId, target.commandId);
        return {
          nodeId: target.nodeId,
          commandId: target.commandId,
          status: clean(command?.status, "unknown").toLowerCase(),
          error: clean(command?.error)
        };
      });

      const rows = [];
      let terminalCount = 0;
      let successCount = 0;
      let failedCount = 0;
      let runningCount = 0;
      let pendingCount = 0;

      outcome.forEach((entry, index) => {
        const target = targets[index];

        if (!entry.ok) {
          rows.push({
            nodeId: target.nodeId,
            status: "unknown",
            error: entry.error.message
          });
          return;
        }

        const item = entry.value;
        rows.push(item);
        if (item.status === "success") {
          terminalCount += 1;
          successCount += 1;
        } else if (item.status === "failed") {
          terminalCount += 1;
          failedCount += 1;
        } else if (item.status === "running") {
          runningCount += 1;
        } else {
          pendingCount += 1;
        }
      });

      if (fleetResultsDialog?.open) {
        el("fleetResultsTitle").textContent = "Fleet factory reset";
        el("fleetResultsSummary").textContent =
          `${targets.length} queued · ${successCount} confirmed · ${failedCount} failed · ` +
          `${runningCount} received · ${pendingCount} waiting`;

        el("fleetResultsList").innerHTML = rows.map((item) => {
          const success = item.status === "success";
          const failed = item.status === "failed";
          const detail = factoryResetStatusLabel(item.status);
          return `<div class="fleet-result-row ${success ? "success" : failed ? "error" : ""}">
            <strong>${esc(item.nodeId)}</strong>
            <span>${esc(detail)}${item.error ? ` · ${esc(item.error)}` : ""}</span>
          </div>`;
        }).join("");
      }

      if (terminalCount === targets.length) {
        showMessage(
          `Fleet factory reset finished: ${successCount} confirmed, ${failedCount} failed.`,
          failedCount ? "error" : "success"
        );
        await loadData({ force: true });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    showMessage(
      "Fleet factory reset confirmation timed out. Any sensor not marked confirmed has not been treated as reset; review command status before retrying.",
      "error"
    );
    await loadData({ force: true });
  }

  async function monitorFleetOtaCommands(queuedResults) {
    const targets = queuedResults
      .map((item) => ({
        nodeId: clean(item?.nodeId),
        commandId: clean(item?.command?.commandId)
      }))
      .filter((item) => item.nodeId && item.commandId);

    if (!targets.length) return;

    const timeoutMs = 12 * 60 * 1000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const outcome = await runWithConcurrency(targets, 8, async (target) => {
        const payload = await request(`/sensor-commands/${encodeURIComponent(target.nodeId)}`);
        const commands = Array.isArray(payload.commands) ? payload.commands : [];
        const command = commands.find((item) => clean(item.commandId) === target.commandId) || null;
        return {
          nodeId: target.nodeId,
          commandId: target.commandId,
          status: clean(command?.status, "unknown"),
          error: clean(command?.error)
        };
      });

      const rows = [];
      let terminalCount = 0;
      let successCount = 0;
      let failedCount = 0;
      let runningCount = 0;
      let pendingCount = 0;

      outcome.forEach((entry, index) => {
        const target = targets[index];

        if (!entry.ok) {
          rows.push({
            nodeId: target.nodeId,
            status: "unknown",
            error: entry.error.message
          });
          return;
        }

        const item = entry.value;
        rows.push(item);
        if (item.status === "success") {
          terminalCount += 1;
          successCount += 1;
        } else if (item.status === "failed") {
          terminalCount += 1;
          failedCount += 1;
        } else if (item.status === "running") {
          runningCount += 1;
        } else {
          pendingCount += 1;
        }
      });

      if (fleetResultsDialog?.open) {
        el("fleetResultsTitle").textContent = "Fleet firmware deployment";
        el("fleetResultsSummary").textContent =
          `${targets.length} queued · ${successCount} succeeded · ${failedCount} failed · ` +
          `${runningCount} running · ${pendingCount} pending`;

        el("fleetResultsList").innerHTML = rows.map((item) => {
          const success = item.status === "success";
          const failed = item.status === "failed";
          return `<div class="fleet-result-row ${success ? "success" : failed ? "error" : ""}">
            <strong>${esc(item.nodeId)}</strong>
            <span>${esc(item.status)}${item.error ? ` · ${esc(item.error)}` : ""}</span>
          </div>`;
        }).join("");
      }

      if (terminalCount === targets.length) {
        showMessage(
          `Fleet firmware deployment finished: ${successCount} succeeded, ${failedCount} failed.`,
          failedCount ? "error" : "success"
        );
        await loadData({ force: true });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    showMessage(
      "Fleet firmware deployment is still in progress. The queued commands remain on the server and can be reviewed from command history.",
      ""
    );
  }

  async function withFleetAction(label, work) {
    state.fleetActionInFlight = true;
    renderFleetControls();
    showMessage(label);
    try {
      const result = await work();
      return result;
    } finally {
      state.fleetActionInFlight = false;
      renderFleetControls();
    }
  }

  async function runBulkCommand(action, label) {
    const selectedActive = selectedSensors().filter((sensor) => !sensor.isArchived);
    if (!selectedActive.length) {
      showMessage("No active sensors are selected.", "error");
      return;
    }

    const requiresOnlineStateChange = action === "factory_reset" || action === "reconfigure";
    const skippedOffline = requiresOnlineStateChange
      ? selectedActive.filter((sensor) => sensor.online !== true)
      : [];
    const sensors = requiresOnlineStateChange
      ? selectedActive.filter((sensor) => sensor.online === true)
      : selectedActive;

    if (!sensors.length) {
      showMessage(
        `${label} requires an online sensor. ${skippedOffline.length} selected sensor${skippedOffline.length === 1 ? " is" : "s are"} offline or unavailable.`,
        "error"
      );
      return;
    }

    const skippedText = skippedOffline.length
      ? `\n\n${skippedOffline.length} offline/unavailable selected sensor${skippedOffline.length === 1 ? " will" : "s will"} be skipped.`
      : "";

    if (action === "factory_reset") {
      const phrase = `RESET ${sensors.length} SENSORS`;
      const entered = prompt(
        `FACTORY RESET ${sensors.length} ONLINE SENSOR${sensors.length === 1 ? "" : "S"}\n\n` +
        "This erases local configuration and returns each confirmed sensor to factory setup mode. " +
        "Server inventory is preserved until each physical sensor confirms that its reset completed." +
        skippedText + "\n\n" +
        `Type exactly:\n${phrase}`
      );
      if (entered !== phrase) return;
    } else if (action === "reconfigure") {
      if (!confirm(
        `Reconfigure ${sensors.length} online selected sensor${sensors.length === 1 ? "" : "s"}?\n\n` +
        "Resident/location/room assignments will be released and the sensors will return to BLE setup mode. " +
        "Wi-Fi, firmware, setup identity, and historical monitoring data are preserved." + skippedText
      )) return;
    } else if (action === "reboot") {
      if (!confirm(`Restart ${sensors.length} selected sensor${sensors.length === 1 ? "" : "s"}?`)) return;
    }

    const result = await withFleetAction(`Sending ${label.toLowerCase()} to ${sensors.length} sensor(s)…`, async () =>
      request("/sensor-bulk-actions", {
        method: "POST",
        appWrite: true,
        allowPartial: true,
        body: {
          action,
          nodeIds: sensors.map((sensor) => sensor.nodeId),
          payload: {},
          requestedBy: "Good Shepherd Command Center Fleet"
        }
      })
    );

    showFleetResults(label, result);

    if (action === "factory_reset") {
      showMessage(
        `Factory reset sent to ${Number(result.successCount || 0)} sensor(s). Waiting for physical confirmation.`,
        Number(result.errorCount || 0) ? "error" : ""
      );
      monitorFleetFactoryResetCommands(result.results || []).catch((error) => {
        console.error("Fleet factory reset monitor failed:", error);
        showMessage(`Fleet factory reset status monitor failed: ${error.message}`, "error");
      });
    } else {
      showMessage(
        `${label}: ${Number(result.successCount || 0)} queued, ${Number(result.errorCount || 0)} failed.`,
        Number(result.errorCount || 0) ? "error" : "success"
      );
    }

    await loadData({ force: true });
  }

  async function runWithConcurrency(items, limit, worker) {
    const results = [];
    let cursor = 0;

    async function next() {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        try {
          results[index] = { ok: true, value: await worker(item) };
        } catch (error) {
          results[index] = { ok: false, error };
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, () => next())
    );

    return results;
  }

  async function runBulkCleanup() {
    const sensors = selectedSensors().filter((sensor) => !sensor.isArchived);
    if (!sensors.length) return showMessage("No active sensors are selected.", "error");
    if (!confirm(`Clean stale command queues for ${sensors.length} selected sensor${sensors.length === 1 ? "" : "s"}?`)) return;

    const outcome = await withFleetAction("Cleaning selected command queues…", () =>
      runWithConcurrency(sensors, 6, async (sensor) => {
        const result = await request(`/sensor-commands/${encodeURIComponent(sensor.nodeId)}/cleanup`, {
          method: "POST"
        });
        return {
          nodeId: sensor.nodeId,
          message:
            `Pending expired ${Number(result.expiredPendingCount || 0)} · ` +
            `Running expired ${Number(result.expiredRunningCount || 0)} · ` +
            `Active ${Number(result.activeCount || 0)}`
        };
      })
    );

    const results = [];
    const errors = [];
    outcome.forEach((entry, index) => {
      if (entry.ok) results.push(entry.value);
      else errors.push({ nodeId: sensors[index].nodeId, error: entry.error.message });
    });

    showFleetResults("Command queue cleanup", {
      requestedCount: sensors.length,
      successCount: results.length,
      errorCount: errors.length,
      results,
      errors
    });
    await loadData({ force: true });
  }

  async function runBulkHealthCheck() {
    const sensors = selectedSensors();
    if (!sensors.length) return showMessage("No sensors are selected.", "error");

    const outcome = await withFleetAction("Running fleet health check…", () =>
      runWithConcurrency(sensors, 8, async (sensor) => {
        const result = await request(`/node-health/${encodeURIComponent(sensor.nodeId)}`);
        const health = result.health || result.nodeHealth || result;
        return {
          nodeId: sensor.nodeId,
          message: [
            health.isOnline === true ? "Online" : health.isOnline === false ? "Offline" : "Health received",
            clean(health.wifiSsid),
            Number.isFinite(Number(health.wifiRssi)) ? `${health.wifiRssi} dBm` : ""
          ].filter(Boolean).join(" · ")
        };
      })
    );

    const results = [];
    const errors = [];
    outcome.forEach((entry, index) => {
      if (entry.ok) results.push(entry.value);
      else errors.push({ nodeId: sensors[index].nodeId, error: entry.error.message });
    });

    showFleetResults("Fleet health check", {
      requestedCount: sensors.length,
      successCount: results.length,
      errorCount: errors.length,
      results,
      errors
    });
  }

  async function runBulkArchive() {
    const sensors = selectedSensors().filter((sensor) => !sensor.isArchived);
    if (!sensors.length) return showMessage("No active sensors are selected.", "error");
    const phrase = `ARCHIVE ${sensors.length}`;
    if (prompt(
      `Archive ${sensors.length} selected sensor${sensors.length === 1 ? "" : "s"}?\n\n` +
      `Type ${phrase} to continue.`
    ) !== phrase) return;

    const outcome = await withFleetAction("Archiving selected sensors…", () =>
      runWithConcurrency(sensors, 5, async (sensor) => {
        await request(`/nodes/${encodeURIComponent(sensor.nodeId)}/archive`, {
          method: "PATCH",
          body: { reason: "Bulk archived from Good Shepherd Command Center" }
        });
        return { nodeId: sensor.nodeId, message: "Archived" };
      })
    );

    const results = [];
    const errors = [];
    outcome.forEach((entry, index) => {
      if (entry.ok) results.push(entry.value);
      else errors.push({ nodeId: sensors[index].nodeId, error: entry.error.message });
    });

    showFleetResults("Archive sensors", {
      requestedCount: sensors.length,
      successCount: results.length,
      errorCount: errors.length,
      results,
      errors
    });
    state.selectedNodeIds.clear();
    state.selectedResidentIds.clear();
    await loadData({ force: true });
  }

  async function runBulkRestore() {
    const sensors = selectedSensors().filter((sensor) => sensor.isArchived);
    if (!sensors.length) return showMessage("No archived sensors are selected.", "error");
    if (!confirm(`Restore ${sensors.length} archived sensor${sensors.length === 1 ? "" : "s"}?`)) return;

    const outcome = await withFleetAction("Restoring selected sensors…", () =>
      runWithConcurrency(sensors, 5, async (sensor) => {
        await request(`/nodes/${encodeURIComponent(sensor.nodeId)}/restore`, { method: "PATCH" });
        return { nodeId: sensor.nodeId, message: "Restored" };
      })
    );

    const results = [];
    const errors = [];
    outcome.forEach((entry, index) => {
      if (entry.ok) results.push(entry.value);
      else errors.push({ nodeId: sensors[index].nodeId, error: entry.error.message });
    });

    showFleetResults("Restore sensors", {
      requestedCount: sensors.length,
      successCount: results.length,
      errorCount: errors.length,
      results,
      errors
    });
    await loadData({ force: true });
  }

  function openFleetAssignmentDialog() {
    const sensors = selectedSensors().filter((sensor) => !sensor.isArchived);
    if (!sensors.length) return showMessage("No active sensors are selected.", "error");

    const select = el("fleetAssignmentResidentSelect");
    const residents = state.data.residents
      .filter((resident) => resident.isDeleted !== true)
      .sort((a, b) => clean(a.name || a.residentName).localeCompare(clean(b.name || b.residentName)));

    select.innerHTML = residents.map((resident) => {
      const id = resident.id || resident.residentId;
      const name = resident.name || resident.residentName;
      return `<option value="${esc(id)}">${esc(name)}</option>`;
    }).join("");

    const firstResident = residents[0] || null;
    el("fleetAssignmentSummary").textContent =
      `${sensors.length} sensor${sensors.length === 1 ? "" : "s"} will be moved together.`;
    el("fleetAssignmentLocationInput").value = clean(firstResident?.location);
    el("fleetAssignmentRoomInput").value = "";
    el("fleetAssignmentStatus").textContent = residents.length ? "Ready to save." : "Create a resident first.";
    el("fleetAssignmentStatus").className = `dialog-status ${residents.length ? "muted" : "error"}`;
    el("saveFleetAssignmentButton").disabled = !residents.length;
    fleetAssignmentDialog.showModal();
  }

  async function saveFleetAssignment(event) {
    event.preventDefault();
    const sensors = selectedSensors().filter((sensor) => !sensor.isArchived);
    const residentId = clean(el("fleetAssignmentResidentSelect").value);
    const resident = state.data.residents.find((item) =>
      clean(item.id || item.residentId) === residentId
    );

    if (!sensors.length || !resident) return;

    const residentName = clean(resident.name || resident.residentName);
    const locationName = clean(
      el("fleetAssignmentLocationInput").value,
      clean(resident.location, "Unassigned Location")
    );
    const roomName = clean(el("fleetAssignmentRoomInput").value);

    el("saveFleetAssignmentButton").disabled = true;
    el("fleetAssignmentStatus").textContent = `Moving ${sensors.length} sensor(s)…`;
    el("fleetAssignmentStatus").className = "dialog-status saving";

    try {
      const assignments = sensors.map((sensor) => ({
        nodeId: sensor.nodeId,
        residentId,
        residentName,
        locationName,
        roomName,
        sourceName: sensor.sourceName,
        sourceKey: sensor.sourceKey,
        sensorType: sensor.sensorType,
        sensorMode: sensor.sensorMode || sensor.diagnostics?.sensorMode || null
      }));

      const result = await withFleetAction("Moving selected sensors…", () =>
        request("/sensor-bulk-actions", {
          method: "POST",
          appWrite: true,
          allowPartial: true,
          body: {
            action: "assign",
            assignments,
            requestedBy: "Good Shepherd Command Center Fleet"
          }
        })
      );

      fleetAssignmentDialog.close();
      showFleetResults("Assign / move sensors", result);
      showMessage(
        `Move complete: ${Number(result.successCount || 0)} succeeded, ${Number(result.errorCount || 0)} failed.`,
        Number(result.errorCount || 0) ? "error" : "success"
      );
      await loadData({ force: true });
    } catch (error) {
      el("fleetAssignmentStatus").textContent = error.message;
      el("fleetAssignmentStatus").className = "dialog-status error";
    } finally {
      el("saveFleetAssignmentButton").disabled = false;
    }
  }

  async function runBulkUnassign() {
    const sensors = selectedSensors().filter((sensor) => !sensor.isArchived && sensor.assigned);
    if (!sensors.length) return showMessage("No assigned active sensors are selected.", "error");
    if (!confirm(`Remove ${sensors.length} selected sensor${sensors.length === 1 ? "" : "s"} from their residents?`)) return;

    const assignments = sensors.map((sensor) => ({
      nodeId: sensor.nodeId,
      residentId: null,
      residentName: "Unassigned",
      locationName: "Unassigned Location",
      roomName: "",
      sourceName: sensor.sensorType,
      sourceKey: sensor.sourceKey,
      sensorType: sensor.sensorType,
      sensorMode: sensor.sensorMode || sensor.diagnostics?.sensorMode || null
    }));

    const result = await withFleetAction("Removing selected assignments…", () =>
      request("/sensor-bulk-actions", {
        method: "POST",
        appWrite: true,
        allowPartial: true,
        body: {
          action: "assign",
          assignments,
          requestedBy: "Good Shepherd Command Center Fleet"
        }
      })
    );

    showFleetResults("Remove from residents", result);
    await loadData({ force: true });
  }

  function openFleetResidentDialog() {
    const residents = selectedResidents();
    if (!residents.length) {
      showMessage("Select one or more resident checkboxes first.", "error");
      return;
    }

    el("fleetResidentSummary").textContent =
      `${residents.length} resident${residents.length === 1 ? "" : "s"} selected.`;
    el("fleetResidentApplyLocation").checked = false;
    el("fleetResidentLocationInput").value = "";
    el("fleetResidentApplyAlert").checked = false;
    el("fleetResidentAlertSelect").value = "Normal";
    el("fleetResidentStatus").textContent = "Choose the fields to apply to every selected resident.";
    el("fleetResidentStatus").className = "dialog-status muted";
    fleetResidentDialog.showModal();
  }

  async function saveFleetResidents(event) {
    event.preventDefault();
    const residents = selectedResidents();
    const applyLocation = el("fleetResidentApplyLocation").checked;
    const applyAlert = el("fleetResidentApplyAlert").checked;

    if (!applyLocation && !applyAlert) {
      el("fleetResidentStatus").textContent = "Select at least one field to update.";
      el("fleetResidentStatus").className = "dialog-status error";
      return;
    }

    const location = clean(el("fleetResidentLocationInput").value);
    if (applyLocation && !location) {
      el("fleetResidentStatus").textContent = "Enter a location to apply.";
      el("fleetResidentStatus").className = "dialog-status error";
      return;
    }

    const alertLevel = el("fleetResidentAlertSelect").value;
    el("saveFleetResidentButton").disabled = true;
    el("fleetResidentStatus").textContent = `Updating ${residents.length} resident(s)…`;
    el("fleetResidentStatus").className = "dialog-status saving";

    const outcome = await withFleetAction("Updating selected residents…", () =>
      runWithConcurrency(residents, 5, async (resident) => {
        const residentId = clean(resident.id || resident.residentId);
        const body = {};
        if (applyLocation) body.location = location;
        if (applyAlert) body.alertLevel = alertLevel;
        const result = await request(`/residents/${encodeURIComponent(residentId)}`, {
          method: "PATCH",
          appWrite: true,
          body
        });
        return {
          residentId,
          nodeId: clean(resident.name || resident.residentName, residentId),
          message: "Resident updated"
        };
      })
    );

    const results = [];
    const errors = [];
    outcome.forEach((entry, index) => {
      const resident = residents[index];
      const residentId = clean(resident.id || resident.residentId);
      const name = clean(resident.name || resident.residentName, residentId);
      if (entry.ok) results.push(entry.value);
      else errors.push({ residentId, nodeId: name, error: entry.error.message });
    });

    fleetResidentDialog.close();
    showFleetResults("Update residents", {
      requestedCount: residents.length,
      successCount: results.length,
      errorCount: errors.length,
      results,
      errors
    });
    el("saveFleetResidentButton").disabled = false;
    await loadData({ force: true });
  }

  function fleetOtaCandidates({ includeOffline = false } = {}) {
    return selectedSensors().filter((sensor) =>
      !sensor.isArchived &&
      sensor.firmware.key === "update" &&
      sensor.latestFirmware &&
      (includeOffline || sensor.online === true)
    );
  }

  function openFleetOtaDialog() {
    const sensors = selectedSensors().filter((sensor) => !sensor.isArchived);
    if (!sensors.length) return showMessage("No active sensors are selected.", "error");

    const updates = sensors.filter((sensor) => sensor.firmware.key === "update");
    const onlineUpdates = updates.filter((sensor) => sensor.online === true);
    const current = sensors.filter((sensor) => sensor.firmware.key === "current").length;
    const offlineUpdates = updates.filter((sensor) => sensor.online !== true).length;

    el("fleetOtaSummary").innerHTML = `
      <div class="ota-stat-grid">
        <div><span>Selected</span><strong>${sensors.length}</strong></div>
        <div><span>Updates</span><strong>${updates.length}</strong></div>
        <div><span>Online eligible</span><strong>${onlineUpdates.length}</strong></div>
        <div><span>Already current</span><strong>${current}</strong></div>
        <div><span>Offline updates</span><strong>${offlineUpdates}</strong></div>
      </div>`;

    const familyRows = ["motion", "humanPresence"].map((family) => {
      const familySensors = updates.filter((sensor) => sensor.firmwareFamily === family);
      const release = state.latestFirmware[family];
      const label = family === "humanPresence" ? "Human Presence" : "Motion";
      return `<div class="ota-family-row">
        <strong>${esc(label)}</strong>
        <span>${familySensors.length} selected update${familySensors.length === 1 ? "" : "s"} · latest ${esc(release?.firmwareVersion || "unknown")}</span>
      </div>`;
    }).join("");

    el("fleetOtaFamilies").innerHTML = familyRows;
    el("fleetOtaIncludeOffline").checked = false;
    el("fleetOtaStatus").textContent =
      onlineUpdates.length ? "Ready to queue updates." : "No online selected sensors currently need an update.";
    el("fleetOtaStatus").className = `dialog-status ${onlineUpdates.length ? "muted" : "error"}`;
    el("startFleetOtaButton").disabled = onlineUpdates.length === 0;
    fleetOtaDialog.showModal();
  }

  async function runFleetOta(event) {
    event.preventDefault();

    const includeOffline = el("fleetOtaIncludeOffline").checked;
    const candidates = fleetOtaCandidates({ includeOffline });

    if (!candidates.length) {
      el("fleetOtaStatus").textContent = "No eligible selected sensors need an update.";
      el("fleetOtaStatus").className = "dialog-status error";
      return;
    }

    if (!confirm(
      `Queue firmware updates for ${candidates.length} sensor${candidates.length === 1 ? "" : "s"}?\n\n` +
      "Motion and Human Presence devices will automatically receive their correct firmware family."
    )) return;

    el("startFleetOtaButton").disabled = true;
    el("fleetOtaStatus").textContent = `Queueing ${candidates.length} firmware update(s)…`;
    el("fleetOtaStatus").className = "dialog-status saving";

    try {
      const aggregate = {
        requestedCount: 0,
        successCount: 0,
        errorCount: 0,
        results: [],
        errors: []
      };

      for (const family of ["motion", "humanPresence"]) {
        const familySensors = candidates.filter((sensor) => sensor.firmwareFamily === family);
        if (!familySensors.length) continue;

        const release = state.latestFirmware[family] || familySensors[0]?.latestFirmware;
        const firmwareVersion = clean(release?.firmwareVersion);
        const firmwareUrl = clean(release?.firmwareUrl || release?.downloadUrl || release?.url);
        const sha256 = clean(release?.sha256);

        if (!firmwareVersion || !firmwareUrl) {
          familySensors.forEach((sensor) => aggregate.errors.push({
            nodeId: sensor.nodeId,
            error: `Latest ${family === "humanPresence" ? "Human Presence" : "Motion"} firmware release is incomplete`
          }));
          aggregate.requestedCount += familySensors.length;
          aggregate.errorCount += familySensors.length;
          continue;
        }

        const result = await withFleetAction(
          `Queueing ${family === "humanPresence" ? "Human Presence" : "Motion"} firmware…`,
          () => request("/sensor-bulk-actions", {
            method: "POST",
            appWrite: true,
            allowPartial: true,
            body: {
              action: "update_firmware",
              nodeIds: familySensors.map((sensor) => sensor.nodeId),
              payload: {
                firmwareVersion,
                firmwareUrl,
                sha256: sha256 || null,
                firmwareFamily: family === "humanPresence" ? "human_presence" : "motion"
              },
              requestedBy: "Good Shepherd Command Center Fleet OTA"
            }
          })
        );

        aggregate.requestedCount += Number(result.requestedCount || familySensors.length);
        aggregate.successCount += Number(result.successCount || 0);
        aggregate.errorCount += Number(result.errorCount || 0);
        aggregate.results.push(...(result.results || []));
        aggregate.errors.push(...(result.errors || []));
      }

      fleetOtaDialog.close();
      showFleetResults("Fleet firmware deployment", aggregate);
      showMessage(
        `Firmware deployment queued: ${aggregate.successCount} accepted, ${aggregate.errorCount} failed to queue.`,
        aggregate.errorCount ? "error" : "success"
      );
      monitorFleetOtaCommands(aggregate.results).catch((error) => {
        console.error("Fleet OTA monitor failed:", error);
      });
      await loadData({ force: true });
    } catch (error) {
      el("fleetOtaStatus").textContent = error.message;
      el("fleetOtaStatus").className = "dialog-status error";
    } finally {
      el("startFleetOtaButton").disabled = false;
    }
  }

  async function handleFleetAction(action) {
    try {
      if (action === "ping") return runBulkCommand("ping", "Fleet ping");
      if (action === "identify") return runBulkCommand("identify", "Identify sensors");
      if (action === "reboot") return runBulkCommand("reboot", "Restart sensors");
      if (action === "reconfigure") return runBulkCommand("reconfigure", "Reconfigure sensors");
      if (action === "factory") return runBulkCommand("factory_reset", "Factory reset");
      if (action === "cleanup") return runBulkCleanup();
      if (action === "health") return runBulkHealthCheck();
      if (action === "assign") return openFleetAssignmentDialog();
      if (action === "unassign") return runBulkUnassign();
      if (action === "firmware") return openFleetOtaDialog();
      if (action === "resident-edit") return openFleetResidentDialog();
      if (action === "archive") return runBulkArchive();
      if (action === "restore") return runBulkRestore();
    } catch (error) {
      showMessage(error.message, "error");
    }
  }

  async function sensorAction(action, sensor) {
    try {
      if (["ping", "identify", "reboot"].includes(action)) {
        if (!confirm(`Send ${action === "reboot" ? "restart" : action} to ${sensor.sourceName}?`)) return;
        state.commandInFlight = true;
        setAction("Sending command…");
        const result = await request("/sensor-commands", {
          method: "POST", body: { nodeId: sensor.nodeId, commandType: action, payload: {}, requestedBy: "Good Shepherd Command Center" }
        });
        setAction(`Command queued: ${result.command?.status || "pending"}. Live monitoring remains active.`, "success");
        await loadCommands(sensor.nodeId);
        return;
      }

      if (action === "reconfigure") {
        if (sensor.online !== true) {
          setAction("Reconfigure requires the sensor to be online. Refresh status and try again.", "error");
          return;
        }

        if (sensorReadyForSetup(sensor)) {
          setAction(
            "Sensor is already unassigned and ready for setup.",
            "success"
          );
          return;
        }

        const residentText =
          clean(sensor.residentName, "its current resident");

        const roomText =
          clean(sensor.roomName)
            ? ` / ${clean(sensor.roomName)}`
            : "";

        const confirmed = confirm(
          `Reconfigure ${sensor.sourceName}?\n\n` +
          `This will release it from ${residentText}${roomText} and restart it in BLE setup mode.\n\n` +
          "Preserved:\n" +
          "• Wi-Fi credentials\n" +
          "• Setup ID\n" +
          "• Firmware\n" +
          "• Physical device identity\n" +
          "• Historical monitoring data\n\n" +
          "Cleared:\n" +
          "• Current resident\n" +
          "• Location\n" +
          "• Room assignment\n\n" +
          "This is NOT a factory reset."
        );

        if (!confirmed) return;

        state.commandInFlight = true;
        setAction("Queueing safe reconfigure…");

        const result = await request("/sensor-commands", {
          method: "POST",
          body: {
            nodeId: sensor.nodeId,
            commandType: "reconfigure",
            payload: {},
            requestedBy: "Good Shepherd Command Center"
          }
        });

        setAction(
          `Reconfigure queued: ${result.command?.status || "pending"}. ` +
          "Sensor will move to Ready for Setup.",
          "success"
        );

        await loadCommands(sensor.nodeId);
        await loadData({ force: true });
        return;
      }

      if (action === "firmware") {
        const latestFirmware = sensor.latestFirmware || latestFirmwareForSensor(sensor, sensor.node).release;
        if (!latestFirmware) throw new Error("Latest firmware release unavailable for this sensor family.");
        if (!confirm(`Update ${sensor.sourceName} to ${latestFirmware.firmwareVersion}?`)) return;
        state.commandInFlight = true;
        setAction("Queueing firmware update…");
        await request("/firmware/update-node", {
          method: "POST", body: { nodeId: sensor.nodeId, requestedBy: "Good Shepherd Command Center" }
        });
        setAction("Firmware update queued. Live monitoring remains active.", "success");
        await loadCommands(sensor.nodeId);
        return;
      }

      if (action === "cleanup") {
        if (!confirm(`Clean stale commands for ${sensor.sourceName}?`)) return;

        setAction("Checking command queue…");

        const result = await request(
          `/sensor-commands/${encodeURIComponent(sensor.nodeId)}/cleanup`,
          {
            method: "POST"
          }
        );

        const expiredPending = Number(result.expiredPendingCount || 0);
        const expiredRunning = Number(result.expiredRunningCount || 0);
        const active = Number(result.activeCount || 0);

        setAction(
          `Command queue cleaned. Pending expired: ${expiredPending}. Running expired: ${expiredRunning}. Still active: ${active}.`,
          "success"
        );

        await loadCommands(sensor.nodeId);
        return;
      }

      if (action === "assign") {
        openAssignmentDialog(sensor);
        return;
      }

      if (action === "unassign") {
        if (!confirm(`Remove ${sensor.sourceName} from ${sensor.residentName}?`)) return;
        setAction("Removing assignment…");
        await request(`/sensors/${encodeURIComponent(sensor.nodeId)}/assignment`, {
          method: "PATCH", appWrite: true,
          body: {
            residentId: null, residentName: "Unassigned",
            locationName: "Unassigned Location", roomName: "",
            sourceName: sensor.sensorType, sourceKey: sensor.sourceKey,
            sensorType: sensor.sensorType
          }
        });
        state.selectedNodeId = null;
        state.commandHistoryNodeId = null;
        state.interactionLocked = false;
        setAction("Sensor unassigned.", "success");
        await loadData({ force: true }); return;
      }

      if (action === "restore") {
        if (!confirm(`Restore ${sensor.nodeId}?`)) return;
        setAction("Restoring device…");
        await request(`/nodes/${encodeURIComponent(sensor.nodeId)}/restore`, {
          method: "PATCH"
        });
        setAction("Device restored.", "success");
        state.interactionLocked = false;
        await loadData({ force: true });
        return;
      }

      if (action === "delete-permanent") {
        const confirmation = prompt(
          `PERMANENT DELETE\n\nThis will remove ${sensor.sourceName} and its archived inventory record.\nHistorical monitoring events will be preserved.\n\nType the full node ID to continue:\n${sensor.nodeId}`
        );
        if (confirmation !== sensor.nodeId) return;

        if (!confirm(`Permanently delete archived device ${sensor.nodeId}? This cannot be undone.`)) return;

        setAction("Permanently deleting archived device…");
        const result = await request(`/nodes/${encodeURIComponent(sensor.nodeId)}`, {
          method: "DELETE"
        });

        const deletedSensors = Number(result?.cleanup?.sensorsDeleted || 0);
        const deletedCommands = Number(result?.cleanup?.commandRowsDeleted || 0);
        showMessage(
          `Deleted ${sensor.nodeId}. Sensor records removed: ${deletedSensors}. Command records removed: ${deletedCommands}.`,
          "success"
        );

        state.selectedNodeId = null;
        state.commandHistoryNodeId = null;
        state.interactionLocked = false;
        state.commandInFlight = false;
        state.actionStatus = { text: "No action in progress.", kind: "" };
        details.classList.add("muted");
        details.innerHTML = "Select a resident, room, or sensor.";
        await loadData({ force: true });
        return;
      }

      if (action === "archive") {
        if (prompt(`Type ARCHIVE to archive ${sensor.nodeId}.`) !== "ARCHIVE") return;
        setAction("Archiving device…");
        await request(`/nodes/${encodeURIComponent(sensor.nodeId)}/archive`, {
          method: "PATCH", body: { reason: "Archived from Good Shepherd Command Center" }
        });
        state.selectedNodeId = null;
        state.commandHistoryNodeId = null;
        state.interactionLocked = false;
        setAction("Device archived.", "success");
        await loadData({ force: true }); return;
      }

      if (action === "factory") {
        if (sensor.online !== true) {
          setAction("Factory reset requires the sensor to be online. Refresh status and try again.", "error");
          return;
        }

        const confirmed = confirm(
          `Factory reset ${sensor.sourceName}?\n\n` +
          `Node: ${sensor.nodeId}\n\n` +
          "This will erase the sensor's configuration and return it to factory setup mode.\n\n" +
          "This action cannot be undone."
        );

        if (!confirmed) return;

        state.commandInFlight = true;
        setAction("Sending factory reset…");
        const result = await request("/sensor-commands", {
          method: "POST",
          body: {
            nodeId: sensor.nodeId,
            commandType: "factory_reset",
            payload: {},
            requestedBy: "Good Shepherd Command Center"
          }
        });

        const commandId = clean(result?.command?.commandId);
        setAction("Factory reset sent. Waiting for the sensor to receive the command…");
        await loadCommands(sensor.nodeId);
        await monitorFactoryResetCommand({
          nodeId: sensor.nodeId,
          commandId,
          sourceName: sensor.sourceName
        });
      }
    } catch (error) {
      setAction(error.message, "error");
      showMessage(error.message, "error");
    }
  }

  function setAssignmentStatus(text, kind = "") {
    const box = el("assignmentStatus");
    if (!box) return;
    box.textContent = text;
    box.className = `dialog-status ${kind || "muted"}`;
  }

  function openAssignmentDialog(sensor) {
    assignmentSensor = sensor;
    const select = el("assignmentResidentSelect");
    const residents = state.data.residents
      .filter((resident) => resident.isDeleted !== true)
      .sort((a, b) => clean(a.name || a.residentName).localeCompare(clean(b.name || b.residentName)));

    select.innerHTML = residents.map((resident) => {
      const id = resident.id || resident.residentId;
      const name = resident.name || resident.residentName;
      const selected = clean(id) === clean(sensor.residentId) ? " selected" : "";
      return `<option value="${esc(id)}"${selected}>${esc(name)}</option>`;
    }).join("");

    if (!residents.length) {
      select.innerHTML = '<option value="">Create a resident first</option>';
    }

    const selectedResident = residents.find((resident) =>
      clean(resident.id || resident.residentId) === clean(sensor.residentId)
    ) || residents[0];

    el("assignmentSensorLabel").textContent = `${sensor.sourceName} · ${sensor.nodeId}`;
    el("assignmentLocationInput").value = sensor.assigned
      ? sensor.locationName
      : clean(selectedResident?.location, "");
    el("assignmentRoomInput").value = sensor.roomName === "No Room" ? "" : sensor.roomName;
    setAssignmentStatus("Ready to save.");
    el("saveAssignmentButton").disabled = false;
    assignmentDialog.showModal();
  }

  async function createResident(event) {
    event.preventDefault();
    const name = clean(el("residentNameInput").value);
    const location = clean(el("residentLocationInput").value);
    const alertLevel = el("residentAlertInput").value;

    if (!name || !location) return;

    try {
      showMessage("Creating resident…");
      await request("/residents", {
        method: "POST", appWrite: true,
        body: { name, location, alertLevel }
      });
      residentDialog.close();
      el("residentForm").reset();
      showMessage("Resident created.", "success");
      await loadData({ force: true });
    } catch (error) {
      showMessage(error.message, "error");
    }
  }

  async function saveAssignment(event) {
    event.preventDefault();

    if (!assignmentSensor) {
      setAssignmentStatus("No sensor is selected for assignment.", "error");
      return;
    }

    const saveButton = el("saveAssignmentButton");
    const residentId = clean(el("assignmentResidentSelect").value);
    const resident = state.data.residents.find((item) =>
      clean(item.id || item.residentId) === residentId
    );

    if (!resident) {
      setAssignmentStatus("Select a resident before saving.", "error");
      return;
    }

    const residentName = clean(resident.name || resident.residentName);
    const locationName = clean(el("assignmentLocationInput").value, clean(resident.location, "Unassigned location"));
    const roomName = clean(el("assignmentRoomInput").value);

    if (!residentName) {
      setAssignmentStatus("The selected resident has no usable name.", "error");
      return;
    }

    saveButton.disabled = true;
    setAssignmentStatus(`Saving ${assignmentSensor.sourceName} to ${residentName}…`, "saving");

    try {
      const payload = {
        residentId,
        residentName,
        locationName,
        roomName,
        sourceName: assignmentSensor.sourceName,
        sourceKey: assignmentSensor.sourceKey,
        sensorType: assignmentSensor.sensorType,
        sensorMode: assignmentSensor.sensorMode || assignmentSensor.diagnostics?.sensorMode || null
      };

      const result = await request(
        `/sensors/${encodeURIComponent(assignmentSensor.nodeId)}/assignment`,
        {
          method: "PATCH",
          appWrite: true,
          body: payload
        }
      );

      setAssignmentStatus(
        result?.message || `Saved to ${residentName}${roomName ? ` / ${roomName}` : ""}.`,
        "success"
      );

      showMessage(
        `${assignmentSensor.sourceName} assigned to ${residentName}${roomName ? ` · ${roomName}` : ""}.`,
        "success"
      );

      state.interactionLocked = false;
      state.selectedNodeId = assignmentSensor.nodeId;

      await new Promise((resolve) => setTimeout(resolve, 650));

      assignmentDialog.close();
      assignmentSensor = null;
      await loadData({ force: true });
    } catch (error) {
      console.error("Assignment save failed:", error);
      setAssignmentStatus(`Save failed: ${error.message}`, "error");
      saveButton.disabled = false;
    }
  }

  async function residentAction(action, resident) {
    const residentId = resident.id || resident.raw?.residentId || resident.raw?.id;
    if (!residentId) return showMessage("Resident ID unavailable.", "error");

    try {
      if (action === "edit") {
        const name = prompt("Resident name:", resident.name); if (name === null) return;
        const location = prompt("Location:", resident.location); if (location === null) return;
        setAction("Updating resident…");
        await request(`/residents/${encodeURIComponent(residentId)}`, {
          method: "PATCH", appWrite: true, body: { name, location }
        });
        setAction("Resident updated.", "success");
        await loadData({ force: true });
        return;
      }

      if (action === "delete") {
        if (prompt(`Type DELETE ${resident.name} to delete this resident.`) !== `DELETE ${resident.name}`) return;
        setAction("Deleting resident…");
        await request(`/residents/${encodeURIComponent(residentId)}`, {
          method: "DELETE", appWrite: true
        });
        setAction("Resident deleted.", "success");
        state.interactionLocked = false;
        await loadData({ force: true });
      }
    } catch (error) {
      setAction(error.message, "error");
      showMessage(error.message, "error");
    }
  }

  async function loadCommands(nodeId, options = {}) {
    state.commandHistoryNodeId = nodeId;
    const box = el("commandHistory");
    if (!box) return;
    box.innerHTML = '<div class="muted">Loading…</div>';
    try {
      const payload = await request(`/sensor-commands/${encodeURIComponent(nodeId)}`, {  });
      const commands = Array.isArray(payload.commands) ? payload.commands : [];
      box.innerHTML = commands.length ? commands.slice(0, 10).map((c) => `
        <div class="command-row"><strong><span>${esc(c.commandType)}</span>
        <span class="badge ${c.status === "success" ? "current" : c.status === "failed" ? "offline" : "warning"}">${esc(c.status)}</span></strong>
        <div class="meta">${esc(formatDate(c.requestedAt))}${c.error ? ` · ${esc(c.error)}` : ""}</div></div>
      `).join("") : '<div class="muted">No command history.</div>';
    } catch (error) {
      box.innerHTML = `<div class="muted">${esc(error.message)}</div>`;
    }
  }

  function formatDate(value) {
    if (!value) return "Unknown time";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  }

  function setAction(text, kind = "") {
    state.actionStatus = { text, kind };
    const box = el("actionStatus");
    if (!box) return;
    box.textContent = text;
    box.className = `action-status ${kind || "muted"}`;
  }

  function restartTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (state.interactionLocked) return;
      if (
        residentDialog.open ||
        assignmentDialog.open ||
        settingsDialog.open ||
        fleetAssignmentDialog?.open ||
        fleetResidentDialog?.open ||
        fleetOtaDialog?.open ||
        fleetResultsDialog?.open
      ) return;
      loadData();
    }, state.intervalMs);
  }

  el("newResidentButton").addEventListener("click", () => residentDialog.showModal());
  el("residentForm").addEventListener("submit", createResident);
  el("cancelResidentButton").addEventListener("click", () => residentDialog.close());
  el("assignmentForm").addEventListener("submit", saveAssignment);
  el("saveAssignmentButton").addEventListener("click", () => {
    setAssignmentStatus("Validating assignment…", "saving");
  });
  el("cancelAssignmentButton").addEventListener("click", () => {
    assignmentSensor = null;
    assignmentDialog.close();
  });
  el("assignmentResidentSelect").addEventListener("change", () => {
    const resident = state.data.residents.find((item) =>
      clean(item.id || item.residentId) === clean(el("assignmentResidentSelect").value)
    );
    if (resident) {
      el("assignmentLocationInput").value = clean(resident.location);
      setAssignmentStatus("Ready to save.");
    }
  });
  el("fleetModeButton").addEventListener("click", toggleFleetMode);
  el("selectVisibleButton").addEventListener("click", toggleVisibleSelection);
  el("clearFleetSelectionButton").addEventListener("click", clearFleetSelection);

  el("fleetBar").querySelectorAll("[data-fleet-action]").forEach((button) => {
    button.addEventListener("click", () => handleFleetAction(button.dataset.fleetAction));
  });

  el("fleetAssignmentForm").addEventListener("submit", saveFleetAssignment);
  el("cancelFleetAssignmentButton").addEventListener("click", () => fleetAssignmentDialog.close());
  el("fleetAssignmentResidentSelect").addEventListener("change", () => {
    const resident = state.data.residents.find((item) =>
      clean(item.id || item.residentId) === clean(el("fleetAssignmentResidentSelect").value)
    );
    if (resident) {
      el("fleetAssignmentLocationInput").value = clean(resident.location);
      el("fleetAssignmentStatus").textContent = "Ready to save.";
      el("fleetAssignmentStatus").className = "dialog-status muted";
    }
  });

  el("fleetResidentForm").addEventListener("submit", saveFleetResidents);
  el("cancelFleetResidentButton").addEventListener("click", () => fleetResidentDialog.close());

  el("fleetOtaForm").addEventListener("submit", runFleetOta);
  el("cancelFleetOtaButton").addEventListener("click", () => fleetOtaDialog.close());
  el("fleetOtaIncludeOffline").addEventListener("change", () => {
    const includeOffline = el("fleetOtaIncludeOffline").checked;
    const count = fleetOtaCandidates({ includeOffline }).length;
    el("fleetOtaStatus").textContent = count
      ? `${count} selected sensor${count === 1 ? "" : "s"} will be queued.`
      : "No eligible selected sensors need an update.";
    el("fleetOtaStatus").className = `dialog-status ${count ? "muted" : "error"}`;
    el("startFleetOtaButton").disabled = count === 0;
  });

  const closeFleetResults = () => {
    if (fleetResultsDialog?.open) {
      fleetResultsDialog.close();
    }
  };

  el("closeFleetResultsButton").addEventListener("click", closeFleetResults);
  el("closeFleetResultsTopButton").addEventListener("click", closeFleetResults);

  // iPad Safari does not provide a reliable hardware Escape path.
  // A tap on the dimmed backdrop should always dismiss this non-destructive results view.
  fleetResultsDialog.addEventListener("click", (event) => {
    if (event.target === fleetResultsDialog) closeFleetResults();
  });

  el("closeDetailsButton").addEventListener("click", closeDetailsPanel);
  detailsBackdrop.addEventListener("click", closeDetailsPanel);
  window.addEventListener("resize", () => {
    if (!isCompactLayout()) closeDetailsPanel();
  });
  el("viewSelect").addEventListener("change", render);
  el("refreshButton").addEventListener("click", async () => {
    await loadData({ force: true });
    if (state.selectedNodeId && state.commandHistoryNodeId === state.selectedNodeId) {
      await loadCommands(state.selectedNodeId);
    }
  });
  el("resumeLiveButton").addEventListener("click", resumeLiveMonitoring);
  el("settingsButton").addEventListener("click", openSettingsDialog);
  el("searchInput").addEventListener("input", render);
  el("filterSelect").addEventListener("change", render);
  el("expandAllButton").addEventListener("click", () => {
    const items = [...tree.querySelectorAll("details")];
    const open = items.some((item) => !item.open);
    items.forEach((item) => item.open = open);
    el("expandAllButton").textContent = open ? "Collapse all" : "Expand all";
  });

  el("connectButton").addEventListener("click", async (event) => {
    event.preventDefault();

    const status = el("connectionStatus");
    const code = clean(el("staffCodeInput").value);

    if (!/^\d{4}$/.test(code)) {
      status.textContent = "Enter the 4-digit staff code.";
      status.className = "dialog-status error";
      return;
    }

    state.apiBase = clean(el("apiBaseInput").value).replace(/\/+$/, "");
    state.intervalMs = Number(el("intervalInput").value) || 5000;
    status.textContent = "Signing in…";
    status.className = "dialog-status saving";
    el("connectButton").disabled = true;

    try {
      const access = await request("/customer/access", {
        method: "POST", auth: false, body: { code }
      });
      if (access?.mode !== "staff" || !access?.token) {
        throw new Error("That code does not provide staff access.");
      }
      state.staffToken = access.token;
      state.staffExpiresAt = access.expiresAt || "";
      saveSessionValue("gsCommandCenterStaffToken", state.staffToken);
      saveSessionValue("gsCommandCenterStaffExpiresAt", state.staffExpiresAt);
      el("staffCodeInput").value = "";
      closeSettingsDialog();
      restartTimer();
      await loadData({ force: true });
    } catch (error) {
      clearStaffSession();
      status.textContent = error.message;
      status.className = "dialog-status error";
    } finally {
      el("connectButton").disabled = false;
    }
  });

  async function startCommandCenter() {
    if (state.staffToken) {
      try {
        const session = await request("/staff/session");
        if (session?.mode === "staff") {
          state.staffExpiresAt = session.expiresAt || state.staffExpiresAt;
          saveSessionValue("gsCommandCenterStaffExpiresAt", state.staffExpiresAt);
          restartTimer();
          await loadData({ force: true });
          return;
        }
      } catch {
        clearStaffSession();
      }
    }
    setConnection("waiting", "Staff sign-in required");
    openSettingsDialog();
  }

  startCommandCenter();
})();
