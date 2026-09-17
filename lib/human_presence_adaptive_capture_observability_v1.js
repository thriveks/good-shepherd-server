"use strict";

const OBSERVABILITY_VERSION =
  "human_presence_adaptive_capture_observability_v1";

const DECISIONS_TABLE =
  "human_presence_adaptive_capture_decisions";

const REPEAT_SKIP_HEARTBEAT_MINUTES = 15;

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS
    human_presence_adaptive_capture_decisions (
      decision_id BIGSERIAL PRIMARY KEY,
      node_id TEXT NOT NULL,
      controller_version TEXT NOT NULL,
      observability_version TEXT NOT NULL,

      action TEXT NOT NULL,
      reason TEXT,
      learning_stage TEXT,
      mode TEXT,
      trigger_name TEXT,

      duration_ms INTEGER,
      target_interval_minutes INTEGER,

      captures_today INTEGER,
      evidence_count INTEGER,
      temporal_observation_count INTEGER,
      rhythm_observation_count INTEGER,
      unique_utc_dates INTEGER,
      state_count INTEGER,
      data_sufficient BOOLEAN,

      last_capture_at TIMESTAMPTZ,
      last_evidence_at TIMESTAMPTZ,

      command_id TEXT,
      mqtt_published BOOLEAN,
      response_status_code INTEGER,
      error_text TEXT,

      decision_fingerprint TEXT NOT NULL,
      decision_payload JSONB NOT NULL,

      decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

  CREATE INDEX IF NOT EXISTS
    human_presence_adaptive_capture_decisions_node_time_idx
  ON human_presence_adaptive_capture_decisions (
    node_id,
    decided_at DESC
  );

  CREATE INDEX IF NOT EXISTS
    human_presence_adaptive_capture_decisions_action_time_idx
  ON human_presence_adaptive_capture_decisions (
    action,
    decided_at DESC
  );
`;

function cleanText(value) {
  return value == null
    ? ""
    : String(value).trim();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n)
    ? n
    : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean"
    ? value
    : null;
}

function buildFingerprint(result) {
  const context =
    result?.decisionContext &&
    typeof result.decisionContext === "object"
      ? result.decisionContext
      : {};

  return [
    cleanText(result?.action),
    cleanText(result?.reason),
    cleanText(result?.learningStage),
    cleanText(result?.mode),
    cleanText(result?.trigger),
    numberOrNull(result?.durationMs),
    numberOrNull(result?.targetIntervalMinutes),
    numberOrNull(context.evidenceCount),
    numberOrNull(context.temporalObservationCount),
    numberOrNull(context.rhythmObservationCount),
    numberOrNull(context.uniqueUtcDates),
    numberOrNull(context.stateCount),
    booleanOrNull(context.dataSufficient)
  ].join("|");
}

async function ensureAdaptiveCaptureObservabilityV1(db) {
  await db.query(TABLE_SQL);
}

async function shouldPersistDecision(
  db,
  nodeId,
  result,
  fingerprint
) {
  if (result?.action !== "skip") {
    return true;
  }

  const previous =
    await db.query(
      `
        SELECT
          decision_fingerprint,
          decided_at
        FROM ${DECISIONS_TABLE}
        WHERE node_id = $1
        ORDER BY decided_at DESC
        LIMIT 1
      `,
      [nodeId]
    );

  const row =
    previous.rows[0] || null;

  if (!row) {
    return true;
  }

  if (
    cleanText(row.decision_fingerprint) !==
    fingerprint
  ) {
    return true;
  }

  const ageMs =
    Date.now() -
    new Date(row.decided_at).getTime();

  return (
    !Number.isFinite(ageMs) ||
    ageMs >=
      REPEAT_SKIP_HEARTBEAT_MINUTES *
      60 *
      1000
  );
}

async function persistAdaptiveCaptureDecisionV1(
  db,
  node,
  result,
  controllerVersion
) {
  const nodeId =
    cleanText(node?.nodeId);

  if (!nodeId) {
    throw new Error(
      "adaptive capture observability nodeId required"
    );
  }

  const context =
    result?.decisionContext &&
    typeof result.decisionContext === "object"
      ? result.decisionContext
      : {};

  const fingerprint =
    buildFingerprint(result);

  const persist =
    await shouldPersistDecision(
      db,
      nodeId,
      result,
      fingerprint
    );

  if (!persist) {
    return {
      inserted: false,
      suppressedRepeatSkip: true
    };
  }

  const payload = {
    node: {
      nodeId,
      locationName:
        cleanText(node?.locationName) || null,
      softwareVersion:
        cleanText(node?.softwareVersion) || null,
      checkedInAt:
        node?.checkedInAt || null,
      secondsSinceCheckIn:
        numberOrNull(node?.secondsSinceCheckIn)
    },
    decision: {
      action:
        cleanText(result?.action) || null,
      reason:
        cleanText(result?.reason) || null,
      learningStage:
        cleanText(result?.learningStage) || null,
      mode:
        cleanText(result?.mode) || null,
      trigger:
        cleanText(result?.trigger) || null,
      durationMs:
        numberOrNull(result?.durationMs),
      targetIntervalMinutes:
        numberOrNull(
          result?.targetIntervalMinutes
        ),
      commandId:
        cleanText(result?.commandId) || null,
      mqttPublished:
        booleanOrNull(result?.mqttPublished),
      responseStatusCode:
        numberOrNull(result?.statusCode),
      error:
        cleanText(result?.error) || null
    },
    evidenceMaturity: {
      capturesToday:
        numberOrNull(context.capturesToday),
      evidenceCount:
        numberOrNull(context.evidenceCount),
      temporalObservationCount:
        numberOrNull(
          context.temporalObservationCount
        ),
      rhythmObservationCount:
        numberOrNull(
          context.rhythmObservationCount
        ),
      uniqueUtcDates:
        numberOrNull(context.uniqueUtcDates),
      stateCount:
        numberOrNull(context.stateCount),
      dataSufficient:
        booleanOrNull(context.dataSufficient),
      lastCaptureAt:
        context.lastCaptureAt || null,
      lastEvidenceAt:
        context.lastEvidenceAt || null
    }
  };

  const inserted =
    await db.query(
      `
        INSERT INTO ${DECISIONS_TABLE} (
          node_id,
          controller_version,
          observability_version,

          action,
          reason,
          learning_stage,
          mode,
          trigger_name,

          duration_ms,
          target_interval_minutes,

          captures_today,
          evidence_count,
          temporal_observation_count,
          rhythm_observation_count,
          unique_utc_dates,
          state_count,
          data_sufficient,

          last_capture_at,
          last_evidence_at,

          command_id,
          mqtt_published,
          response_status_code,
          error_text,

          decision_fingerprint,
          decision_payload,
          decided_at
        )
        VALUES (
          $1,$2,$3,
          $4,$5,$6,$7,$8,
          $9,$10,
          $11,$12,$13,$14,$15,$16,$17,
          $18,$19,
          $20,$21,$22,$23,
          $24,$25::jsonb,NOW()
        )
        RETURNING
          decision_id,
          decided_at
      `,
      [
        nodeId,
        cleanText(controllerVersion),
        OBSERVABILITY_VERSION,

        cleanText(result?.action) || "unknown",
        cleanText(result?.reason) || null,
        cleanText(result?.learningStage) || null,
        cleanText(result?.mode) || null,
        cleanText(result?.trigger) || null,

        numberOrNull(result?.durationMs),
        numberOrNull(
          result?.targetIntervalMinutes
        ),

        numberOrNull(context.capturesToday),
        numberOrNull(context.evidenceCount),
        numberOrNull(
          context.temporalObservationCount
        ),
        numberOrNull(
          context.rhythmObservationCount
        ),
        numberOrNull(context.uniqueUtcDates),
        numberOrNull(context.stateCount),
        booleanOrNull(context.dataSufficient),

        context.lastCaptureAt || null,
        context.lastEvidenceAt || null,

        cleanText(result?.commandId) || null,
        booleanOrNull(result?.mqttPublished),
        numberOrNull(result?.statusCode),
        cleanText(result?.error) || null,

        fingerprint,
        JSON.stringify(payload)
      ]
    );

  return {
    inserted: inserted.rowCount === 1,
    decisionId:
      inserted.rows[0]?.decision_id || null,
    decidedAt:
      inserted.rows[0]?.decided_at || null
  };
}

module.exports = {
  OBSERVABILITY_VERSION,
  DECISIONS_TABLE,
  TABLE_SQL,
  ensureAdaptiveCaptureObservabilityV1,
  persistAdaptiveCaptureDecisionV1
};
