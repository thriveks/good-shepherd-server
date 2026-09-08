"use strict";

const {
  execFileSync
} = require("child_process");

const {
  buildLabeledEventMatch,
  VERSION
} = require(
  "../../lib/human_presence_labeled_event_matching_validation_v1"
);

const DB =
  process.env.GS_LABEL_DB_ID ||
  "dpg-d7h6nh28qa3s73cvl42g-a";

const PARENT_VERSION =
  "human_presence_longitudinal_interpretation_validation_v1";

function sqlLiteral(value) {
  return "'" +
    String(value).replace(/'/g, "''") +
    "'";
}

function runPsql(sql) {
  return execFileSync(
    "render",
    [
      "psql",
      DB,
      `--command=${sql}`,
      "-o",
      "text"
    ],
    {
      encoding: "utf8",
      stdio: [
        "ignore",
        "pipe",
        "inherit"
      ]
    }
  );
}

function queryJson(sql) {
  const wrapped = `
COPY (
  SELECT COALESCE(
    json_agg(row_to_json(x)),
    '[]'::json
  )::text
  FROM (
    ${sql}
  ) x
) TO STDOUT;
`;

  const output =
    runPsql(wrapped).trim();

  return JSON.parse(output || "[]");
}

function insertResult(label, result) {
  const nearestBefore =
    result.analyticalContext.nearestBefore || null;

  const nearestAfter =
    result.analyticalContext.nearestAfter || null;

  const nearestStart =
    result.analyticalContext.nearestToStart || null;

  const nearestEnd =
    result.analyticalContext.nearestToEnd || null;

  const payload =
    JSON.stringify(result);

  const payloadBase64 =
    Buffer.from(
      payload,
      "utf8"
    ).toString("base64");

  const sql = `
INSERT INTO
  human_presence_labeled_event_matching_validations
(
  labeled_event_id,
  matching_validation_version,
  parent_analytics_version,
  event_type,
  capture_source,
  test_session_id,
  resident_id,
  resident_name,
  room_or_location,
  observer_name,
  started_at,
  ended_at,
  duration_ms,
  analytical_event_count,
  inside_interval_count,
  nearest_before_evidence_event_id,
  nearest_before_seconds,
  nearest_after_evidence_event_id,
  nearest_after_seconds,
  nearest_start_evidence_event_id,
  nearest_start_seconds,
  nearest_end_evidence_event_id,
  nearest_end_seconds,
  matching_validation_payload
)
VALUES (
  ${sqlLiteral(label.labeledEventId)},
  ${sqlLiteral(VERSION)},
  ${sqlLiteral(PARENT_VERSION)},
  ${sqlLiteral(label.eventType)},
  ${sqlLiteral(label.captureSource || "")},
  ${sqlLiteral(label.testSessionId || "")},
  ${sqlLiteral(label.residentId)}::uuid,
  ${sqlLiteral(label.residentName || "")},
  ${sqlLiteral(label.roomOrLocation)},
  ${sqlLiteral(label.observerName || "")},
  ${sqlLiteral(label.startedAt)}::timestamptz,
  ${sqlLiteral(label.endedAt)}::timestamptz,
  ${Number(label.durationMs)},
  ${Number(result.analyticalContext.authoritativeAnalyticalEventCount || 0)},
  ${Number(result.analyticalContext.insideInterval.count || 0)},
  ${
    nearestBefore
      ? sqlLiteral(nearestBefore.evidenceEventId)
      : "NULL"
  },
  ${
    nearestBefore
      ? Number(nearestBefore.secondsBeforeLabelStart)
      : "NULL"
  },
  ${
    nearestAfter
      ? sqlLiteral(nearestAfter.evidenceEventId)
      : "NULL"
  },
  ${
    nearestAfter
      ? Number(nearestAfter.secondsAfterLabelEnd)
      : "NULL"
  },
  ${
    nearestStart
      ? sqlLiteral(nearestStart.evidenceEventId)
      : "NULL"
  },
  ${
    nearestStart
      ? Number(nearestStart.distanceSeconds)
      : "NULL"
  },
  ${
    nearestEnd
      ? sqlLiteral(nearestEnd.evidenceEventId)
      : "NULL"
  },
  ${
    nearestEnd
      ? Number(nearestEnd.distanceSeconds)
      : "NULL"
  },
  convert_from(
    decode(
      ${sqlLiteral(payloadBase64)},
      'base64'
    ),
    'UTF8'
  )::jsonb
)
ON CONFLICT (
  labeled_event_id,
  matching_validation_version
)
DO NOTHING;
`;

  runPsql(sql);
}

function loadMissingLabels(sessionId) {
  return queryJson(`
SELECT
  l.labeled_event_id AS "labeledEventId",
  l.event_type AS "eventType",
  l.capture_source AS "captureSource",
  l.test_session_id AS "testSessionId",
  l.resident_id::text AS "residentId",
  l.resident_name AS "residentName",
  l.room_or_location AS "roomOrLocation",
  l.observer_name AS "observerName",
  l.started_at AS "startedAt",
  l.ended_at AS "endedAt",
  l.duration_ms AS "durationMs"
FROM human_presence_labeled_events l
LEFT JOIN
  human_presence_labeled_event_matching_validations m
ON
  m.labeled_event_id =
    l.labeled_event_id
AND
  m.matching_validation_version =
    ${sqlLiteral(VERSION)}
WHERE
  l.test_session_id =
    ${sqlLiteral(sessionId)}
AND
  l.ground_truth_only IS TRUE
AND
  l.sensor_derived IS FALSE
AND
  m.labeled_event_id IS NULL
ORDER BY
  l.started_at ASC,
  l.labeled_event_id ASC
  `);
}

function loadAnalyticalContext(label) {
  return queryJson(`
SELECT
  evidence_event_id AS "evidenceEventId",
  evidence_received_at AS "evidenceReceivedAt",
  authoritative_resident_id::text
    AS "authoritativeResidentId",
  authoritative_room_or_location
    AS "authoritativeRoomOrLocation",
  longitudinal_interpretation_validation_payload
    AS "payload"
FROM
  human_presence_longitudinal_interpretation_validations
WHERE
  longitudinal_interpretation_validation_version =
    ${sqlLiteral(PARENT_VERSION)}
AND
  authoritative_resident_id =
    ${sqlLiteral(label.residentId)}::uuid
AND
  authoritative_room_or_location =
    ${sqlLiteral(label.roomOrLocation)}
ORDER BY
  evidence_received_at ASC,
  evidence_event_id ASC
  `);
}

function main() {
  const sessionId =
    process.argv[2];

  if (!sessionId) {
    console.error(
      "Usage: node labeled-event-session-matcher-v1.js SESSION_ID"
    );
    process.exit(1);
  }

  console.log(
    `MATCHING_VERSION=${VERSION}`
  );
  console.log(
    `SESSION_ID=${sessionId}`
  );

  const labels =
    loadMissingLabels(sessionId);

  console.log(
    `MISSING_LABELS=${labels.length}`
  );

  if (labels.length === 0) {
    console.log(
      "SESSION_MATCHING=ALREADY_COMPLETE"
    );
    return;
  }

  let saved = 0;

  for (const label of labels) {
    const analyticalEvents =
      loadAnalyticalContext(label);

    const result =
      buildLabeledEventMatch({
        label,
        analyticalEvents
      });

    insertResult(
      label,
      result
    );

    saved += 1;

    console.log(
      `MATCH_SAVED=${label.eventType}`
    );
    console.log(
      `LABEL_ID=${label.labeledEventId}`
    );
    console.log(
      `INSIDE_INTERVAL_COUNT=${result.analyticalContext.insideInterval.count}`
    );
  }

  console.log(
    `MATCHES_SAVED=${saved}`
  );
  console.log(
    "SESSION_MATCHING=COMPLETE"
  );
  console.log(
    "ARBITRARY_MATCH_THRESHOLD=NONE"
  );
  console.log(
    "OPERATIONAL_POLICY=NONE"
  );
}

main();
