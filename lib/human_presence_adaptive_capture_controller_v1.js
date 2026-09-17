"use strict";

const http = require("http");
const { Pool } = require("pg");

const ENABLED = String(
  process.env.HUMAN_PRESENCE_ADAPTIVE_CAPTURE_ENABLED || "true"
).toLowerCase() !== "false";

const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

const TICK_MS = 60 * 1000;
const START_DELAY_MS = 20 * 1000;
const FRESH_HEARTBEAT_SECONDS = 180;
const MIN_COOLDOWN_MINUTES = 15;
const DAILY_CAPTURE_BUDGET = 12;
const LOCK_NAME = "good-shepherd-human-presence-adaptive-capture-v1";

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 30000
    })
  : null;

let timer = null;
let tickRunning = false;

function cleanText(value) {
  return value == null ? "" : String(value).trim();
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function minutesSince(value, nowMs = Date.now()) {
  if (!value) return Infinity;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms)
    ? Math.max(0, (nowMs - ms) / 60000)
    : Infinity;
}

function deterministicJitterMinutes(nodeId, maxMinutes) {
  let hash = 2166136261;

  for (const char of cleanText(nodeId)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return maxMinutes > 0
    ? hash % (maxMinutes + 1)
    : 0;
}

function readAssignmentMetric(assignment, names) {
  for (const name of names) {
    const value = finiteNumber(assignment?.[name]);
    if (value !== null) return value;
  }
  return null;
}

function policyForNode({
  nodeId,
  evidenceCount,
  lastCaptureAt,
  latestAssignment,
  nowMs = Date.now()
}) {
  const captureAgeMinutes = minutesSince(lastCaptureAt, nowMs);
  const jitter = deterministicJitterMinutes(nodeId, 10);

  const assignment =
    latestAssignment && typeof latestAssignment === "object"
      ? latestAssignment
      : {};

  const matchDistance = readAssignmentMetric(
    assignment,
    ["match_distance", "matchDistance", "distance", "assignment_distance"]
  );

  const matchThreshold = readAssignmentMetric(
    assignment,
    ["match_threshold", "matchThreshold", "threshold", "assignment_threshold"]
  );

  const assignmentObservedAt =
    assignment.evidence_received_at ??
    assignment.evidenceReceivedAt ??
    assignment.observed_at ??
    assignment.observedAt ??
    null;

  const assignmentIsNewer =
    assignmentObservedAt &&
    (!lastCaptureAt || new Date(assignmentObservedAt) > new Date(lastCaptureAt));

  const noveltyRatio =
    matchDistance !== null &&
    matchThreshold !== null &&
    matchThreshold > 0
      ? matchDistance / matchThreshold
      : null;

  if (assignmentIsNewer && noveltyRatio !== null && noveltyRatio >= 0.85) {
    return {
      due: captureAgeMinutes >= MIN_COOLDOWN_MINUTES,
      mode: "triggered",
      durationMs: 20000,
      reason: "adaptive_spatial_novelty_sample",
      targetIntervalMinutes: MIN_COOLDOWN_MINUTES
    };
  }

  if (evidenceCount < 12) {
    const target = 30 + jitter;
    return {
      due: captureAgeMinutes >= target,
      mode: "learning",
      durationMs: 30000,
      reason: "adaptive_initial_learning_sample",
      targetIntervalMinutes: target
    };
  }

  if (evidenceCount < 48) {
    const target = 120 + jitter;
    return {
      due: captureAgeMinutes >= target,
      mode: "learning",
      durationMs: 20000,
      reason: "adaptive_learning_backoff_sample",
      targetIntervalMinutes: target
    };
  }

  const target = 360 + jitter;
  return {
    due: captureAgeMinutes >= target,
    mode: "learning",
    durationMs: 10000,
    reason: "adaptive_representative_ordinary_state_sample",
    targetIntervalMinutes: target
  };
}

function postSensorCommand(body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: "/sensor-commands",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          "x-webhook-secret": WEBHOOK_SECRET
        },
        timeout: 10000
      },
      res => {
        let raw = "";

        res.setEncoding("utf8");
        res.on("data", chunk => {
          raw += chunk;
        });

        res.on("end", () => {
          let parsed = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (_) {
            parsed = { raw };
          }

          resolve({
            statusCode: res.statusCode || 0,
            body: parsed
          });
        });
      }
    );

    req.on("timeout", () =>
      req.destroy(new Error("adaptive capture request timed out"))
    );

    req.on("error", reject);
    req.end(payload);
  });
}

async function loadEligibleNodes(client) {
  const result = await client.query(
    `
      SELECT
        s.node_id AS "nodeId",
        MAX(s.location_name) AS "locationName",
        MAX(h.software_version) AS "softwareVersion",
        MAX(h.checked_in_at) AS "checkedInAt",
        EXTRACT(EPOCH FROM (NOW() - MAX(h.checked_in_at)))::int AS "secondsSinceCheckIn"
      FROM sensors s
      JOIN node_health h ON h.node_id = s.node_id
      WHERE s.sensor_type = 'human_presence'
        AND COALESCE(s.is_active, TRUE) = TRUE
        AND COALESCE(s.is_deleted, FALSE) = FALSE
        AND COALESCE(h.monitor_status, '') <> 'offline'
        AND h.checked_in_at >= NOW() - ($1 * INTERVAL '1 second')
        AND COALESCE(h.software_version, '') LIKE '%v2.4.7-adaptive-capture-v1%'
      GROUP BY s.node_id
      ORDER BY s.node_id
    `,
    [FRESH_HEARTBEAT_SECONDS]
  );

  return result.rows;
}

async function loadNodePolicyContext(client, nodeId) {
  const [evidenceResult, commandResult, assignmentResult] = await Promise.all([
    client.query(
      `
        SELECT
          COUNT(*)::int AS "evidenceCount",
          MAX(timestamp) AS "lastEvidenceAt"
        FROM webhook_events
        WHERE node_id = $1
          AND event_type = 'high_resolution_activity_evidence'
          AND timestamp >= NOW() - INTERVAL '30 days'
      `,
      [nodeId]
    ),

    client.query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE requested_at >= date_trunc('day', NOW())
          )::int AS "capturesToday",
          MAX(requested_at) AS "lastCaptureAt",
          COUNT(*) FILTER (
            WHERE status IN ('pending', 'running')
          )::int AS "activeCaptureCommands"
        FROM node_commands
        WHERE node_id = $1
          AND command_type = 'high_res_capture'
      `,
      [nodeId]
    ),

    client.query(
      `
        SELECT to_jsonb(t) AS payload
        FROM human_presence_spatial_state_assignments t
        WHERE node_id = $1
        ORDER BY evidence_received_at DESC
        LIMIT 1
      `,
      [nodeId]
    )
  ]);

  return {
    evidenceCount: Number(evidenceResult.rows[0]?.evidenceCount || 0),
    lastEvidenceAt: evidenceResult.rows[0]?.lastEvidenceAt || null,
    capturesToday: Number(commandResult.rows[0]?.capturesToday || 0),
    lastCaptureAt: commandResult.rows[0]?.lastCaptureAt || null,
    activeCaptureCommands: Number(
      commandResult.rows[0]?.activeCaptureCommands || 0
    ),
    latestAssignment: assignmentResult.rows[0]?.payload || null
  };
}

async function evaluateNode(client, node) {
  const context = await loadNodePolicyContext(client, node.nodeId);

  if (context.activeCaptureCommands > 0) {
    return {
      nodeId: node.nodeId,
      action: "skip",
      reason: "active_capture_command"
    };
  }

  if (context.capturesToday >= DAILY_CAPTURE_BUDGET) {
    return {
      nodeId: node.nodeId,
      action: "skip",
      reason: "daily_budget_reached"
    };
  }

  const policy = policyForNode({
    nodeId: node.nodeId,
    evidenceCount: context.evidenceCount,
    lastCaptureAt: context.lastCaptureAt || context.lastEvidenceAt,
    latestAssignment: context.latestAssignment
  });

  if (!policy.due) {
    return {
      nodeId: node.nodeId,
      action: "skip",
      reason: "not_due",
      mode: policy.mode,
      targetIntervalMinutes: policy.targetIntervalMinutes
    };
  }

  const response = await postSensorCommand({
    nodeId: node.nodeId,
    commandType: "high_res_capture",
    payload: {
      durationMs: policy.durationMs,
      mode: policy.mode,
      reason: policy.reason
    },
    requestedBy: "Human Presence Adaptive Capture Controller v1"
  });

  if (response.statusCode !== 201) {
    return {
      nodeId: node.nodeId,
      action: "command_rejected",
      statusCode: response.statusCode,
      error: cleanText(response.body?.error) || null
    };
  }

  return {
    nodeId: node.nodeId,
    action: "capture_requested",
    mode: policy.mode,
    durationMs: policy.durationMs,
    reason: policy.reason,
    commandId: response.body?.command?.commandId || null,
    mqttPublished: response.body?.mqttDispatch?.published === true
  };
}

async function runTick() {
  if (!ENABLED || !pool || !WEBHOOK_SECRET || tickRunning) {
    return;
  }

  tickRunning = true;
  let client;
  let lockHeld = false;

  try {
    client = await pool.connect();

    const lockResult = await client.query(
      `
        SELECT pg_try_advisory_lock(hashtext($1)) AS locked
      `,
      [LOCK_NAME]
    );

    lockHeld = lockResult.rows[0]?.locked === true;
    if (!lockHeld) {
      return;
    }

    const nodes = await loadEligibleNodes(client);

    for (const node of nodes) {
      try {
        const result = await evaluateNode(client, node);

        if (result.action !== "skip") {
          console.log("Human Presence Adaptive Capture v1:", result);
        }
      } catch (error) {
        console.warn(
          "Human Presence Adaptive Capture v1 node evaluation failed:",
          node.nodeId,
          error.message
        );
      }
    }
  } catch (error) {
    console.warn(
      "Human Presence Adaptive Capture v1 tick failed:",
      error.message
    );
  } finally {
    if (client) {
      if (lockHeld) {
        try {
          await client.query(
            `
              SELECT pg_advisory_unlock(hashtext($1))
            `,
            [LOCK_NAME]
          );
        } catch (_) {}
      }

      client.release();
    }

    tickRunning = false;
  }
}

function startHumanPresenceAdaptiveCaptureControllerV1() {
  if (!ENABLED) {
    console.log(
      "Human Presence Adaptive Capture v1 disabled by environment."
    );
    return;
  }

  if (!pool || !WEBHOOK_SECRET) {
    console.warn(
      "Human Presence Adaptive Capture v1 not started: DATABASE_URL or WEBHOOK_SECRET missing."
    );
    return;
  }

  if (timer) {
    return;
  }

  console.log(
    `Human Presence Adaptive Capture v1 enabled: fresh<=${FRESH_HEARTBEAT_SECONDS}s, cooldown>=${MIN_COOLDOWN_MINUTES}m, dailyBudget=${DAILY_CAPTURE_BUDGET}.`
  );

  const starter = setTimeout(() => {
    runTick().catch(() => {});

    timer = setInterval(() => {
      runTick().catch(() => {});
    }, TICK_MS);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }, START_DELAY_MS);

  if (typeof starter.unref === "function") {
    starter.unref();
  }
}

module.exports = {
  startHumanPresenceAdaptiveCaptureControllerV1,
  policyForNode,
  runTick
};
