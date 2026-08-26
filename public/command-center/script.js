(() => {
  "use strict";

  const state = {
    apiBase: "https://good-shepherd-server-j06f.onrender.com",
    secret: "",
    intervalMs: 5000,
    timer: null,
    selectedNodeId: null,
    latestFirmware: null,
    commandHistoryNodeId: null,
    actionStatus: { text: "No action in progress.", kind: "" },
    treeOpenState: new Map(),
    interactionLocked: false,
    commandInFlight: false,
    data: { nodes: [], sensors: [], residents: [] }
  };

  const APP_HEADERS = {
    "x-app-build": "1",
    "x-app-version": "command-center-1.0",
    "x-app-client": "Good Shepherd Command Center"
  };

  const el = (id) => document.getElementById(id);
  const tree = el("tree");
  const details = el("details");
  const messageBox = el("messageBox");
  const settingsDialog = el("settingsDialog");
  const residentDialog = el("residentDialog");
  const assignmentDialog = el("assignmentDialog");
  let assignmentSensor = null;

  const clean = (v, fallback = "") => String(v ?? "").trim() || fallback;
  const esc = (v) => String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const attr = (v) => esc(JSON.stringify(v));

  function makeHeaders({ secret = false, json = false, appWrite = false } = {}) {
    const h = { Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    if (secret && state.secret) h["x-webhook-secret"] = state.secret;
    if (appWrite) Object.assign(h, APP_HEADERS);
    return h;
  }

  async function request(path, { method = "GET", body, secret = false, appWrite = false } = {}) {
    const response = await fetch(`${state.apiBase}${path}`, {
      method,
      headers: makeHeaders({ secret, json: body !== undefined, appWrite }),
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`${path} returned non-JSON data (HTTP ${response.status})`); }
    if (!response.ok || data?.success === false) {
      throw new Error(data?.error || `${method} ${path} failed with HTTP ${response.status}`);
    }
    return data;
  }

  async function loadData({ force = false } = {}) {
    if (state.interactionLocked && !force) return;
    setConnection("waiting", "Refreshing live data…");
    try {
      const [nodes, inventory, dashboard, firmware, residents] = await Promise.all([
        request("/nodes?includeArchived=true"),
        request("/sensor-inventory?includeArchived=true", { secret: true }),
        request("/ai/dashboard"),
        request("/firmware/latest", { secret: true }).catch(() => null),
        request("/residents", { secret: true })
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
      state.latestFirmware = firmware?.release || null;

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
      showMessage(/unauthorized/i.test(error.message)
        ? "Unauthorized: click Connection and enter WEBHOOK_SECRET."
        : error.message, "error");
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

  function firmwareState(version) {
    const latest = clean(state.latestFirmware?.firmwareVersion);
    const current = clean(version);
    if (!latest) return { key: "unknown", label: "Latest unknown" };
    if (!current) return { key: "unknown", label: `Unknown · latest ${latest}` };
    if (current === latest) return { key: "current", label: "Current" };
    return { key: "update", label: `Update available: ${latest}` };
  }

  function normalizeSensor(sensor) {
    const node = nodeFor(sensor);
    const online = typeof sensor.isOnline === "boolean"
      ? sensor.isOnline
      : typeof node?.isOnline === "boolean" ? node.isOnline : null;
    const version = clean(sensor.softwareVersion || node?.softwareVersion);
    return {
      ...sensor,
      node,
      resident: residentFor(sensor),
      online,
      version,
      firmware: firmwareState(version),
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
    if (filter === "offline" && sensor.online !== false) return false;
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
    const count = rooms.reduce((n, [, sensors]) => n + sensors.length, 0);
    const updates = rooms.flatMap(([, sensors]) => sensors)
      .filter((s) => s.firmware.key === "update").length;

    return `<details open>
      <summary data-kind="resident" data-json="${attr(resident)}">
        <span class="summary-main"><span class="title">${esc(resident.name)}</span>
        <span class="subtitle">${esc(resident.location)} · ${count} sensor(s)</span></span>
        ${updates ? `<span class="badge warning">${updates} update</span>` : ""}
      </summary>
      <div class="branch">${rooms.map(([room, sensors]) => `
        <details open>
          <summary data-kind="room" data-json="${attr({ resident: resident.name, room, sensors })}">
            <span class="summary-main"><span class="title">${esc(room)}</span>
            <span class="subtitle">${sensors.filter((s) => s.online === true).length}/${sensors.length} online</span></span>
          </summary>
          <div class="branch">${sensors.map(renderSensor).join("")}</div>
        </details>`).join("")}
      </div>
    </details>`;
  }

  function renderSensor(sensor) {
    const cls = sensor.online === true ? "online" : sensor.online === false ? "offline" : "unknown";
    const label = sensor.online === true ? "Online" : sensor.online === false ? "Offline" : "Unknown";
    return `<button class="item-button ${state.selectedNodeId === sensor.nodeId ? "selected" : ""}"
      type="button" data-kind="sensor" data-json="${attr(sensor)}">
      <span class="sensor-dot ${cls}"></span>
      <span><span class="title">${esc(sensor.sourceName)}</span>
      <span class="subtitle">${esc(sensor.sensorType)} · ${esc(sensor.nodeId)}</span></span>
      <span><span class="badge ${cls}">${label}</span>
      ${sensor.firmware.key === "update" && !sensor.isArchived ? '<span class="badge warning">Update</span>' : ""}
      ${sensor.isArchived ? '<span class="badge archived">Archived</span>' : ""}</span>
    </button>`;
  }

  function bindTree() {
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
          lockInteraction(`Controlling ${data.sourceName || data.nodeId}`);
          showSensor(data);
          render();
        } else if (item.dataset.kind === "resident") {
          lockInteraction(`Resident controls: ${data.name || "selected resident"}`);
          showResident(data);
        } else {
          showGeneric(item.dataset.kind, data);
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
    const fields = [
      ["Resident", sensor.residentName], ["Location", sensor.locationName],
      ["Room", sensor.roomName], ["Sensor", sensor.sourceName],
      ["Sensor type", sensor.sensorType],
      ["Online", sensor.online === true ? "Yes" : sensor.online === false ? "No" : "Unknown"],
      ["Archived", sensor.isArchived ? "Yes" : "No"],
      ["Archive reason", sensor.archivedReason],
      ["Node ID", sensor.nodeId], ["Source key", sensor.sourceKey],
      ["Setup state", sensor.setupState], ["Assignment authority", sensor.assignmentAuthority],
      ["Firmware", sensor.version || "Unknown"],
      ["Latest firmware", state.latestFirmware?.firmwareVersion || "Unknown"],
      ["Firmware status", sensor.firmware.label],
      ["Wi-Fi", sensor.wifiSsid || sensor.node?.wifiSsid],
      ["Wi-Fi quality", `${wifi.label}${Number.isFinite(Number(rssi)) ? ` (${rssi} dBm)` : ""}`],
      ["Last heartbeat", ageText(heartbeatSeconds)]
    ];

    details.classList.remove("muted");
    details.innerHTML = `<div class="control-lock-banner">Automatic live refresh is paused while you control this device. Your command history and status will stay on screen until you choose Resume live monitoring.</div><dl>${rows(fields)}</dl>
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
          <button data-action="unassign" class="wide">Remove from resident</button>
          <button data-action="archive" class="danger">Archive device</button>
          <button data-action="factory" class="danger">Factory reset</button>
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
    const sensors = [...resident.rooms.values()].flat();
    const raw = resident.raw || {};
    details.classList.remove("muted");
    details.innerHTML = `<div class="control-lock-banner">Automatic live refresh is paused while you work with this resident.</div><dl>${rows([
      ["Resident ID", resident.id], ["Name", resident.name], ["Location", resident.location],
      ["Sensors", sensors.length], ["Offline sensors", sensors.filter((s) => s.online === false).length],
      ["Updates available", sensors.filter((s) => s.firmware.key === "update").length],
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

  async function sensorAction(action, sensor) {
    try {
      if (["ping", "identify", "reboot"].includes(action)) {
        if (!confirm(`Send ${action === "reboot" ? "restart" : action} to ${sensor.sourceName}?`)) return;
        state.commandInFlight = true;
        setAction("Sending command…");
        const result = await request("/sensor-commands", {
          method: "POST", secret: true,
          body: { nodeId: sensor.nodeId, commandType: action, payload: {}, requestedBy: "Good Shepherd Command Center" }
        });
        setAction(`Command queued: ${result.command?.status || "pending"}. Control lock remains active.`, "success");
        await loadCommands(sensor.nodeId);
        return;
      }

      if (action === "firmware") {
        if (!state.latestFirmware) throw new Error("Latest firmware release unavailable.");
        if (!confirm(`Update ${sensor.sourceName} to ${state.latestFirmware.firmwareVersion}?`)) return;
        state.commandInFlight = true;
        setAction("Queueing firmware update…");
        await request("/firmware/update-node", {
          method: "POST", secret: true,
          body: { nodeId: sensor.nodeId, requestedBy: "Good Shepherd Command Center" }
        });
        setAction("Firmware update queued. Control lock remains active.", "success");
        await loadCommands(sensor.nodeId);
        return;
      }

      if (action === "cleanup") {
        if (!confirm(`Clean stale commands for ${sensor.sourceName}?`)) return;

        setAction("Checking command queue…");

        const result = await request(
          `/sensor-commands/${encodeURIComponent(sensor.nodeId)}/cleanup`,
          {
            method: "POST",
            secret: true
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
          method: "PATCH", secret: true, appWrite: true,
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
          method: "PATCH", secret: true
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
          method: "DELETE", secret: true
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
          method: "PATCH", secret: true,
          body: { reason: "Archived from Good Shepherd Command Center" }
        });
        state.selectedNodeId = null;
        state.commandHistoryNodeId = null;
        state.interactionLocked = false;
        setAction("Device archived.", "success");
        await loadData({ force: true }); return;
      }

      if (action === "factory") {
        if (prompt(`Type the full node ID to factory reset:\n${sensor.nodeId}`) !== sensor.nodeId) return;
        state.commandInFlight = true;
        setAction("Queueing factory reset…");
        await request("/sensor-commands", {
          method: "POST", secret: true,
          body: { nodeId: sensor.nodeId, commandType: "factory_reset", payload: {}, requestedBy: "Good Shepherd Command Center" }
        });
        setAction("Factory reset queued. Control lock remains active.", "success");
        await loadCommands(sensor.nodeId);
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
        method: "POST", secret: true, appWrite: true,
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
          secret: true,
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
          method: "PATCH", secret: true, appWrite: true, body: { name, location }
        });
        setAction("Resident updated.", "success");
        await loadData({ force: true });
        return;
      }

      if (action === "delete") {
        if (prompt(`Type DELETE ${resident.name} to delete this resident.`) !== `DELETE ${resident.name}`) return;
        setAction("Deleting resident…");
        await request(`/residents/${encodeURIComponent(residentId)}`, {
          method: "DELETE", secret: true, appWrite: true
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
      const payload = await request(`/sensor-commands/${encodeURIComponent(nodeId)}`, { secret: true });
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
      if (residentDialog.open || assignmentDialog.open || settingsDialog.open) return;
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
  el("viewSelect").addEventListener("change", render);
  el("refreshButton").addEventListener("click", async () => {
    if (state.interactionLocked && state.selectedNodeId) {
      if (state.commandHistoryNodeId === state.selectedNodeId) {
        await loadCommands(state.selectedNodeId);
        setAction("Command history refreshed. Live tree remains paused.", "success");
      } else {
        setAction("Control lock is active. Use Resume live monitoring to refresh the full tree.", "");
      }
      return;
    }
    loadData({ force: true });
  });
  el("resumeLiveButton").addEventListener("click", resumeLiveMonitoring);
  el("settingsButton").addEventListener("click", () => settingsDialog.showModal());
  el("searchInput").addEventListener("input", render);
  el("filterSelect").addEventListener("change", render);
  el("expandAllButton").addEventListener("click", () => {
    const items = [...tree.querySelectorAll("details")];
    const open = items.some((item) => !item.open);
    items.forEach((item) => item.open = open);
    el("expandAllButton").textContent = open ? "Collapse all" : "Expand all";
  });

  el("connectButton").addEventListener("click", (event) => {
    event.preventDefault();
    state.apiBase = clean(el("apiBaseInput").value).replace(/\/+$/, "");
    state.secret = el("secretInput").value;
    state.intervalMs = Number(el("intervalInput").value) || 5000;
    settingsDialog.close();
    restartTimer();
    loadData({ force: true });
  });

  settingsDialog.showModal();
})();
