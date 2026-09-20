"use strict";

const http = require("http");
const { Pool } = require("pg");

const {
  ensureAdaptiveCaptureObservabilityV1,
  persistAdaptiveCaptureDecisionV1
} = require(
  "./human_presence_adaptive_capture_observability_v1"
);

const CONTROLLER_VERSION =
  "human_presence_adaptive_capture_controller_v3";

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

const BOOTSTRAP_EVIDENCE_COUNT = 12;
const DEVELOPING_EVIDENCE_COUNT = 48;
const MATURE_TEMPORAL_OBSERVATIONS = 72;
const MIN_RHYTHM_DATES = 3;
const MATURE_RHYTHM_DATES = 7;

const STALE_MODEL_MINUTES = 12 * 60;

const LOCK_NAME =
  "good-shepherd-human-presence-adaptive-capture-v2";

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

function integerOrZero(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function minutesSince(value, nowMs = Date.now()) {
  if (!value) return Infinity;

  const ms = new Date(value).getTime();

  return Number.isFinite(ms)
    ? Math.max(0, (nowMs - ms) / 60000)
    : Infinity;
}

function isNewerThan(value, reference) {
  if (!value) return false;
  if (!reference) return true;

  const left = new Date(value).getTime();
  const right = new Date(reference).getTime();

  return Number.isFinite(left) &&
    Number.isFinite(right) &&
    left > right;
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

function assignmentCore(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  if (
    payload.assignment &&
    typeof payload.assignment === "object"
  ) {
    return payload.assignment;
  }

  if (
    payload.assignment_payload &&
    typeof payload.assignment_payload === "object"
  ) {
    return assignmentCore(payload.assignment_payload);
  }

  return payload;
}

function latestLearningTimestamp(context) {
  const candidates = [
    context.latestAssignmentAt,
    context.latestTemporalAt,
    context.latestRhythmAt,
    context.lastEvidenceAt
  ]
    .filter(Boolean)
    .map(value => new Date(value).getTime())
    .filter(Number.isFinite);

  if (candidates.length === 0) {
    return null;
  }

  return new Date(Math.max(...candidates)).toISOString();
}

function classifyLearningStage(context) {
  const evidenceCount =
    integerOrZero(context.evidenceCount);

  const temporalObservationCount =
    integerOrZero(
      context.temporal?.observationCount
    );

  const rhythmObservationCount =
    integerOrZero(
      context.rhythm?.observationCount
    );

  const uniqueUtcDates =
    integerOrZero(
      context.rhythm?.uniqueUtcDates
    );

  const dataSufficient =
    context.sufficiency
      ?.passesDataSufficiencyGate === true;

  if (evidenceCount < BOOTSTRAP_EVIDENCE_COUNT) {
    return {
      stage: "bootstrap",
      targetIntervalMinutes: 30,
      durationMs: 30000,
      reason: "adaptive_bootstrap_learning_sample"
    };
  }

  if (
    evidenceCount < DEVELOPING_EVIDENCE_COUNT ||
    temporalObservationCount < DEVELOPING_EVIDENCE_COUNT ||
    rhythmObservationCount < DEVELOPING_EVIDENCE_COUNT ||
    uniqueUtcDates < MIN_RHYTHM_DATES
  ) {
    return {
      stage: "developing",
      targetIntervalMinutes: 120,
      durationMs: 20000,
      reason: "adaptive_developing_model_sample"
    };
  }

  if (
    temporalObservationCount < MATURE_TEMPORAL_OBSERVATIONS ||
    uniqueUtcDates < MATURE_RHYTHM_DATES ||
    !dataSufficient
  ) {
    return {
      stage: "maturing",
      targetIntervalMinutes: 240,
      durationMs: 15000,
      reason: "adaptive_maturing_model_sample"
    };
  }

  return {
    stage: "mature",
    targetIntervalMinutes: 480,
    durationMs: 10000,
    reason: "adaptive_mature_representative_sample"
  };
}

function triggeredPolicy({
  context,
  lastCaptureAt
}) {
  const latestPresenceDetectedAt =
    context.latestPresenceDetectedAt ||
    null;

  const latestPresenceClearedAt =
    context.latestPresenceClearedAt ||
    null;

  const presenceEntryIsNew =
    isNewerThan(
      latestPresenceDetectedAt,
      lastCaptureAt
    );

  const presenceStillCurrent =
    Boolean(
      latestPresenceDetectedAt
    ) &&
    (
      !latestPresenceClearedAt ||
      isNewerThan(
        latestPresenceDetectedAt,
        latestPresenceClearedAt
      )
    );

  if (
    presenceEntryIsNew &&
    presenceStillCurrent
  ) {
    return {
      mode: "triggered",
      durationMs: 15000,
      reason:
        "adaptive_presence_entry_sample",
      trigger:
        "presence_entry"
    };
  }

  const assignment =
    assignmentCore(context.assignment);

  const assignmentAt =
    context.latestAssignmentAt ||
    context.assignmentEvidenceAt ||
    null;

  const assignmentIsNewer =
    isNewerThan(assignmentAt, lastCaptureAt);

  if (
    assignmentIsNewer &&
    cleanText(assignment.action) ===
      "create_new_state"
  ) {
    return {
      mode: "triggered",
      durationMs: 25000,
      reason: "adaptive_new_spatial_state",
      trigger: "new_spatial_state"
    };
  }

  const distance =
    finiteNumber(assignment.distance);

  const threshold =
    finiteNumber(
      assignment.distanceThreshold
    );

  const noveltyRatio =
    distance !== null &&
    threshold !== null &&
    threshold > 0
      ? distance / threshold
      : null;

  if (
    assignmentIsNewer &&
    noveltyRatio !== null &&
    noveltyRatio >= 0.85
  ) {
    return {
      mode: "triggered",
      durationMs: 20000,
      reason: "adaptive_spatial_novelty_sample",
      trigger: "near_state_boundary"
    };
  }

  const currentContext =
    context.temporal?.currentContext;

  const temporalIsNewer =
    isNewerThan(
      context.latestTemporalAt,
      lastCaptureAt
    );

  if (
    temporalIsNewer &&
    currentContext &&
    cleanText(
      currentContext.previousDifferentStateId
    ) &&
    integerOrZero(
      currentContext.consecutiveObservationCount
    ) <= 2
  ) {
    return {
      mode: "triggered",
      durationMs: 20000,
      reason: "adaptive_recent_state_transition",
      trigger: "state_transition"
    };
  }

  return null;
}

function policyForNode({
  nodeId,
  context,
  nowMs = Date.now()
}) {
  const lastCaptureAt =
    context.lastCaptureAt ||
    context.lastEvidenceAt ||
    null;

  const captureAgeMinutes =
    minutesSince(lastCaptureAt, nowMs);

  const trigger =
    triggeredPolicy({
      context,
      lastCaptureAt
    });

  if (trigger) {
    return {
      due:
        captureAgeMinutes >=
        MIN_COOLDOWN_MINUTES,
      targetIntervalMinutes:
        MIN_COOLDOWN_MINUTES,
      learningStage:
        classifyLearningStage(context).stage,
      ...trigger
    };
  }

  const latestLearningAt =
    latestLearningTimestamp(context);

  const modelAgeMinutes =
    minutesSince(latestLearningAt, nowMs);

  if (
    modelAgeMinutes >= STALE_MODEL_MINUTES &&
    captureAgeMinutes >= MIN_COOLDOWN_MINUTES
  ) {
    return {
      due: true,
      mode: "triggered",
      durationMs: 15000,
      reason: "adaptive_stale_model_refresh",
      trigger: "stale_model",
      learningStage:
        classifyLearningStage(context).stage,
      targetIntervalMinutes:
        STALE_MODEL_MINUTES
    };
  }

  const stage =
    classifyLearningStage(context);

  const jitter =
    deterministicJitterMinutes(
      nodeId,
      stage.stage === "mature"
        ? 30
        : 10
    );

  const target =
    stage.targetIntervalMinutes +
    jitter;

  return {
    due:
      captureAgeMinutes >= target,
    mode: "learning",
    durationMs:
      stage.durationMs,
    reason:
      stage.reason,
    trigger: null,
    learningStage:
      stage.stage,
    targetIntervalMinutes:
      target
  };
}

function postSensorCommand(body) {
  return new Promise((resolve, reject) => {
    const payload =
      Buffer.from(
        JSON.stringify(body)
      );

    const req =
      http.request(
        {
          hostname: "127.0.0.1",
          port: PORT,
          path: "/sensor-commands",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length":
              payload.length,
            "x-webhook-secret":
              WEBHOOK_SECRET
          },
          timeout: 10000
        },
        res => {
          let raw = "";

          res.setEncoding("utf8");

          res.on(
            "data",
            chunk => {
              raw += chunk;
            }
          );

          res.on(
            "end",
            () => {
              let parsed = {};

              try {
                parsed =
                  raw
                    ? JSON.parse(raw)
                    : {};
              } catch (_) {
                parsed = { raw };
              }

              resolve({
                statusCode:
                  res.statusCode || 0,
                body: parsed
              });
            }
          );
        }
      );

    req.on(
      "timeout",
      () =>
        req.destroy(
          new Error(
            "adaptive capture request timed out"
          )
        )
    );

    req.on("error", reject);
    req.end(payload);
  });
}

async function loadEligibleNodes(client) {
  const result =
    await client.query(
      `
        SELECT
          s.node_id AS "nodeId",
          MAX(s.location_name)
            AS "locationName",
          MAX(h.software_version)
            AS "softwareVersion",
          MAX(h.checked_in_at)
            AS "checkedInAt",
          EXTRACT(
            EPOCH FROM
            (NOW() - MAX(h.checked_in_at))
          )::int
            AS "secondsSinceCheckIn"

        FROM sensors s

        JOIN node_health h
          ON h.node_id = s.node_id

        WHERE
          LOWER(
            BTRIM(
              COALESCE(
                s.sensor_type,
                ''
              )
            )
          ) IN (
            'human_presence',
            'human presence sensor'
          )

          AND
          COALESCE(
            s.is_active,
            TRUE
          ) = TRUE

          AND
          COALESCE(
            s.is_deleted,
            FALSE
          ) = FALSE

          AND
          COALESCE(
            h.monitor_status,
            ''
          ) <> 'offline'

          AND
          h.checked_in_at >=
            NOW() -
            ($1 * INTERVAL '1 second')

          AND
          COALESCE(
            h.software_version,
            ''
          ) LIKE
            '%v2.4.7-adaptive-capture-v1%'

        GROUP BY
          s.node_id

        ORDER BY
          s.node_id
      `,
      [FRESH_HEARTBEAT_SECONDS]
    );

  return result.rows;
}

async function loadNodePolicyContext(
  client,
  nodeId
) {
  const [
    evidenceResult,
    commandResult,
    presenceEventResult,
    assignmentResult,
    stateResult,
    temporalResult,
    rhythmResult,
    sufficiencyResult
  ] =
    await Promise.all([
      client.query(
        `
          SELECT
            COUNT(*)::int
              AS "evidenceCount",
            MAX(timestamp)
              AS "lastEvidenceAt"

          FROM webhook_events

          WHERE
            node_id = $1
            AND event_type =
              'high_resolution_activity_evidence'
            AND timestamp >=
              NOW() - INTERVAL '30 days'
        `,
        [nodeId]
      ),

      client.query(
        `
          SELECT
            COUNT(*) FILTER (
              WHERE
                requested_at >=
                date_trunc(
                  'day',
                  NOW()
                )
            )::int
              AS "capturesToday",

            MAX(requested_at)
              AS "lastCaptureAt",

            COUNT(*) FILTER (
              WHERE status IN (
                'pending',
                'running'
              )
            )::int
              AS "activeCaptureCommands",

            COUNT(*) FILTER (
              WHERE requested_at + (
                LEAST(GREATEST(
                  CASE
                    WHEN COALESCE(payload->>'durationMs', '') ~ '^[0-9]+$'
                    THEN (payload->>'durationMs')::int
                    ELSE 30000
                  END, 5000
                ), 120000) * INTERVAL '1 millisecond'
              ) > NOW()
            )::int AS "activePhysicalCaptureLeases",

            MAX(requested_at + (
              LEAST(GREATEST(
                CASE
                  WHEN COALESCE(payload->>'durationMs', '') ~ '^[0-9]+$'
                  THEN (payload->>'durationMs')::int
                  ELSE 30000
                END, 5000
              ), 120000) * INTERVAL '1 millisecond'
            )) FILTER (
              WHERE requested_at + (
                LEAST(GREATEST(
                  CASE
                    WHEN COALESCE(payload->>'durationMs', '') ~ '^[0-9]+$'
                    THEN (payload->>'durationMs')::int
                    ELSE 30000
                  END, 5000
                ), 120000) * INTERVAL '1 millisecond'
              ) > NOW()
            ) AS "physicalCaptureLeaseUntil"

          FROM node_commands

          WHERE
            node_id = $1
            AND command_type =
              'high_res_capture'
        `,
        [nodeId]
      ),

        client.query(
          `
            SELECT
              MAX(timestamp) FILTER (
                WHERE event_type =
                  'presence_detected'
              )
                AS "latestPresenceDetectedAt",

              MAX(timestamp) FILTER (
                WHERE event_type =
                  'presence_cleared'
              )
                AS "latestPresenceClearedAt"

            FROM webhook_events

            WHERE
              node_id = $1

              AND event_type IN (
                'presence_detected',
                'presence_cleared'
              )

              AND timestamp >=
                NOW() - INTERVAL '24 hours'
          `,
          [nodeId]
        ),

      client.query(
        `
          SELECT
            assignment_payload
              AS payload,
            evidence_received_at
              AS "evidenceReceivedAt",
            assignment_at
              AS "assignmentAt"

          FROM
            human_presence_spatial_state_assignments

          WHERE
            node_id = $1

          ORDER BY
            evidence_received_at DESC

          LIMIT 1
        `,
        [nodeId]
      ),

      client.query(
        `
          SELECT
            COUNT(*)::int
              AS "stateCount",
            COALESCE(
              SUM(observation_count),
              0
            )::int
              AS "totalStateObservations",
            COALESCE(
              MAX(observation_count),
              0
            )::int
              AS "largestStateObservationCount",
            MAX(last_observed_at)
              AS "latestStateObservedAt"

          FROM
            human_presence_spatial_states

          WHERE
            node_id = $1
        `,
        [nodeId]
      ),

      client.query(
        `
          SELECT
            temporal_learning_payload
              AS payload,
            evidence_received_at
              AS "evidenceReceivedAt"

          FROM
            human_presence_spatial_temporal_snapshots

          WHERE
            node_id = $1

          ORDER BY
            evidence_received_at DESC

          LIMIT 1
        `,
        [nodeId]
      ),

      client.query(
        `
          SELECT
            rhythm_learning_payload
              AS payload,
            evidence_received_at
              AS "evidenceReceivedAt"

          FROM
            human_presence_spatial_rhythm_snapshots

          WHERE
            node_id = $1

          ORDER BY
            evidence_received_at DESC

          LIMIT 1
        `,
        [nodeId]
      ),

      client.query(
        `
          SELECT
            d.temporal_context_data_sufficiency_payload
              AS payload,
            d.evidence_received_at
              AS "evidenceReceivedAt"

          FROM
            human_presence_temporal_context_data_sufficiency_analyses d

          JOIN sensors s
            ON s.id =
              d.authoritative_sensor_id

          WHERE
            s.node_id = $1

          ORDER BY
            d.evidence_received_at DESC

          LIMIT 1
        `,
        [nodeId]
      )
    ]);

  const evidence =
    evidenceResult.rows[0] || {};

  const commands =
    commandResult.rows[0] || {};

    const presenceEvents =
      presenceEventResult.rows[0] || {};

  const assignment =
    assignmentResult.rows[0] || {};

  const states =
    stateResult.rows[0] || {};

  const temporal =
    temporalResult.rows[0] || {};

  const rhythm =
    rhythmResult.rows[0] || {};

  const sufficiency =
    sufficiencyResult.rows[0] || {};

  return {
    evidenceCount:
      integerOrZero(
        evidence.evidenceCount
      ),

    lastEvidenceAt:
      evidence.lastEvidenceAt || null,

    capturesToday:
      integerOrZero(
        commands.capturesToday
      ),

    lastCaptureAt:
      commands.lastCaptureAt || null,

      latestPresenceDetectedAt:
        presenceEvents.latestPresenceDetectedAt ||
        null,

      latestPresenceClearedAt:
        presenceEvents.latestPresenceClearedAt ||
        null,

    activeCaptureCommands:
      integerOrZero(
        commands.activeCaptureCommands
      ),

    activePhysicalCaptureLeases:
      integerOrZero(
        commands.activePhysicalCaptureLeases
      ),

    physicalCaptureLeaseUntil:
      commands.physicalCaptureLeaseUntil || null,

    assignment:
      assignment.payload || null,

    latestAssignmentAt:
      assignment.assignmentAt ||
      assignment.evidenceReceivedAt ||
      null,

    assignmentEvidenceAt:
      assignment.evidenceReceivedAt ||
      null,

    stateCount:
      integerOrZero(
        states.stateCount
      ),

    totalStateObservations:
      integerOrZero(
        states.totalStateObservations
      ),

    largestStateObservationCount:
      integerOrZero(
        states.largestStateObservationCount
      ),

    latestStateObservedAt:
      states.latestStateObservedAt || null,

    temporal:
      temporal.payload || null,

    latestTemporalAt:
      temporal.evidenceReceivedAt || null,

    rhythm:
      rhythm.payload || null,

    latestRhythmAt:
      rhythm.evidenceReceivedAt || null,

    sufficiency:
      sufficiency.payload || null,

    latestSufficiencyAt:
      sufficiency.evidenceReceivedAt || null
  };
}

async function evaluateNode(
  client,
  node
) {
  const context =
    await loadNodePolicyContext(
      client,
      node.nodeId
    );

  const decisionContext = {
    capturesToday:
      context.capturesToday,

    evidenceCount:
      context.evidenceCount,

    temporalObservationCount:
      integerOrZero(
        context.temporal?.observationCount
      ),

    rhythmObservationCount:
      integerOrZero(
        context.rhythm?.observationCount
      ),

    uniqueUtcDates:
      integerOrZero(
        context.rhythm?.uniqueUtcDates
      ),

    stateCount:
      context.stateCount,

    dataSufficient:
      context.sufficiency
        ?.passesDataSufficiencyGate === true,

    lastCaptureAt:
      context.lastCaptureAt || null,

    lastEvidenceAt:
      context.lastEvidenceAt || null,

      latestPresenceDetectedAt:
        context.latestPresenceDetectedAt ||
        null,

      latestPresenceClearedAt:
        context.latestPresenceClearedAt ||
        null
  };

  const finish =
    result => ({
      ...result,
      decisionContext
    });

  if (
    context.activeCaptureCommands > 0
  ) {
    return finish({
      nodeId: node.nodeId,
      action: "skip",
      reason:
        "active_capture_command"
    });
  }

  // Command success means capture started, not that its timed physical
  // window ended. This DB-derived lease survives process restarts.
  if (
    context.activePhysicalCaptureLeases > 0
  ) {
    return finish({
      nodeId: node.nodeId,
      action: "skip",
      reason: "physical_capture_lease_active",
      physicalCaptureLeaseUntil:
        context.physicalCaptureLeaseUntil
    });
  }

  if (
    context.capturesToday >=
    DAILY_CAPTURE_BUDGET
  ) {
    return finish({
      nodeId: node.nodeId,
      action: "skip",
      reason:
        "daily_budget_reached"
    });
  }

  const policy =
    policyForNode({
      nodeId: node.nodeId,
      context
    });

  if (!policy.due) {
    return finish({
      nodeId: node.nodeId,
      action: "skip",
      reason: "not_due",
      learningStage:
        policy.learningStage,
      mode:
        policy.mode,
      targetIntervalMinutes:
        policy.targetIntervalMinutes
    });
  }

  const response =
    await postSensorCommand({
      nodeId:
        node.nodeId,

      commandType:
        "high_res_capture",

      payload: {
        durationMs:
          policy.durationMs,
        mode:
          policy.mode,
        reason:
          policy.reason
      },

      requestedBy:
        "Human Presence Adaptive Capture Controller v3"
    });

  if (
    response.statusCode !== 201
  ) {
    return finish({
      nodeId:
        node.nodeId,
      action:
        "command_rejected",
      learningStage:
        policy.learningStage,
      trigger:
        policy.trigger,
      mode:
        policy.mode,
      durationMs:
        policy.durationMs,
      reason:
        policy.reason,
      targetIntervalMinutes:
        policy.targetIntervalMinutes,
      statusCode:
        response.statusCode,
      error:
        cleanText(
          response.body?.error
        ) || null
    });
  }

  return finish({
    nodeId:
      node.nodeId,
    action:
      "capture_requested",
    learningStage:
      policy.learningStage,
    trigger:
      policy.trigger,
    mode:
      policy.mode,
    durationMs:
      policy.durationMs,
    reason:
      policy.reason,
    targetIntervalMinutes:
      policy.targetIntervalMinutes,
    commandId:
      response.body?.command
        ?.commandId || null,
    mqttPublished:
      response.body
        ?.mqttDispatch
        ?.published === true
  });
}

async function runTick() {
  if (
    !ENABLED ||
    !pool ||
    !WEBHOOK_SECRET ||
    tickRunning
  ) {
    return;
  }

  tickRunning = true;

  let client;
  let lockHeld = false;

  try {
    client =
      await pool.connect();

    const lockResult =
      await client.query(
        `
          SELECT
            pg_try_advisory_lock(
              hashtext($1)
            ) AS locked
        `,
        [LOCK_NAME]
      );

    lockHeld =
      lockResult.rows[0]
        ?.locked === true;

    if (!lockHeld) {
      return;
    }

    await ensureAdaptiveCaptureObservabilityV1(
      client
    );

    const nodes =
      await loadEligibleNodes(
        client
      );

    for (const node of nodes) {
      try {
        const result =
          await evaluateNode(
            client,
            node
          );

        await persistAdaptiveCaptureDecisionV1(
          client,
          node,
          result,
          CONTROLLER_VERSION
        );

        if (
          result.action !== "skip"
        ) {
          console.log(
            "Human Presence Adaptive Capture v2:",
            result
          );
        }
      } catch (error) {
        console.warn(
          "Human Presence Adaptive Capture v2 node evaluation failed:",
          node.nodeId,
          error.message
        );
      }
    }
  } catch (error) {
    console.warn(
      "Human Presence Adaptive Capture v2 tick failed:",
      error.message
    );
  } finally {
    if (client) {
      if (lockHeld) {
        try {
          await client.query(
            `
              SELECT
                pg_advisory_unlock(
                  hashtext($1)
                )
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
      "Human Presence Adaptive Capture v2 disabled by environment."
    );
    return;
  }

  if (
    !pool ||
    !WEBHOOK_SECRET
  ) {
    console.warn(
      "Human Presence Adaptive Capture v2 not started: DATABASE_URL or WEBHOOK_SECRET missing."
    );
    return;
  }

  if (timer) {
    return;
  }

  console.log(
    `Human Presence Adaptive Capture v2 enabled: fresh<=${FRESH_HEARTBEAT_SECONDS}s, cooldown>=${MIN_COOLDOWN_MINUTES}m, dailyBudget=${DAILY_CAPTURE_BUDGET}.`
  );

  const starter =
    setTimeout(
      () => {
        runTick().catch(
          () => {}
        );

        timer =
          setInterval(
            () => {
              runTick().catch(
                () => {}
              );
            },
            TICK_MS
          );

        if (
          typeof timer.unref ===
          "function"
        ) {
          timer.unref();
        }
      },
      START_DELAY_MS
    );

  if (
    typeof starter.unref ===
    "function"
  ) {
    starter.unref();
  }
}

module.exports = {
  CONTROLLER_VERSION,
  startHumanPresenceAdaptiveCaptureControllerV1,
  classifyLearningStage,
  policyForNode,
  runTick
};
