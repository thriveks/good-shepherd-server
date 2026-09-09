"use strict";

const {
  execFileSync
} = require("child_process");

const VERSION =
  "human_presence_labeled_activity_profile_analysis_v1";

const DB =
  process.env.GS_LABEL_DB_ID ||
  "dpg-d7h6nh28qa3s73cvl42g-a";

const NODE_ID =
  process.env.GS_HIGH_RES_NODE_ID ||
  "esp32-a02dbcabc31c";

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

function median(values) {
  const clean =
    values
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

  if (!clean.length) {
    return null;
  }

  const middle =
    Math.floor(clean.length / 2);

  if (clean.length % 2) {
    return clean[middle];
  }

  return (
    clean[middle - 1] +
    clean[middle]
  ) / 2;
}

function direction(delta) {
  if (!Number.isFinite(delta)) {
    return "UNKNOWN";
  }

  if (delta > 0) {
    return "AWAY";
  }

  if (delta < 0) {
    return "TOWARD";
  }

  return "FLAT";
}

function main() {
  const sessionIds =
    process.argv
      .slice(2)
      .filter(Boolean);

  if (!sessionIds.length) {
    console.error(
      "Usage: node labeled-activity-profile-analysis-v1.js SESSION_ID [SESSION_ID ...]"
    );
    process.exit(1);
  }

  const sessionSql =
    sessionIds
      .map(sqlLiteral)
      .join(",");

  const nodeSql =
    sqlLiteral(NODE_ID);

  const rows =
    queryJson(`
WITH labels AS (
  SELECT
    test_session_id,
    labeled_event_id,
    event_type,
    started_at,
    ended_at,
    duration_ms
  FROM human_presence_labeled_events
  WHERE test_session_id IN (${sessionSql})
),
bounds AS (
  SELECT
    MIN(started_at) - interval '5 seconds' AS min_at,
    MAX(ended_at) + interval '5 seconds' AS max_at
  FROM labels
),
samples AS (
  SELECT
    w.timestamp -
      (
        (
          (w.event_payload->>'batchEndUptimeMs')::bigint -
          (sample.value->>1)::bigint
        ) * interval '1 millisecond'
      ) AS sample_at,

    (sample.value->>4)::integer
      AS moving_target,

    (sample.value->>5)::double precision
      AS moving_distance_cm,

    (sample.value->>7)::integer
      AS stationary_target,

    (sample.value->>8)::double precision
      AS stationary_distance_cm

  FROM webhook_events w

  CROSS JOIN LATERAL
    jsonb_array_elements(
      w.event_payload->'samples'
    ) sample(value)

  CROSS JOIN bounds b

  WHERE
    w.node_id = ${nodeSql}
    AND
    w.event_type =
      'high_resolution_activity_evidence'
    AND
    w.timestamp BETWEEN
      b.min_at AND b.max_at
),
features AS (
  SELECT
    l.test_session_id,
    l.labeled_event_id,
    l.event_type,
    l.started_at,
    l.ended_at,
    l.duration_ms,

    COUNT(s.sample_at)
      AS sample_count,

    COUNT(s.sample_at) /
      NULLIF(
        l.duration_ms / 1000.0,
        0
      )
      AS sample_hz,

    100.0 *
      AVG(
        s.moving_target::numeric
      )
      AS moving_pct,

    percentile_cont(0.5)
      WITHIN GROUP (
        ORDER BY s.moving_distance_cm
      )
      FILTER (
        WHERE s.moving_target = 1
      )
      AS moving_distance_p50_cm,

    (
      percentile_cont(0.75)
        WITHIN GROUP (
          ORDER BY s.moving_distance_cm
        )
        FILTER (
          WHERE s.moving_target = 1
        )
      -
      percentile_cont(0.25)
        WITHIN GROUP (
          ORDER BY s.moving_distance_cm
        )
        FILTER (
          WHERE s.moving_target = 1
        )
    )
      AS moving_distance_iqr_cm,

    percentile_cont(0.5)
      WITHIN GROUP (
        ORDER BY s.stationary_distance_cm
      )
      FILTER (
        WHERE s.stationary_target = 1
      )
      AS stationary_distance_p50_cm,

    (
      percentile_cont(0.75)
        WITHIN GROUP (
          ORDER BY s.stationary_distance_cm
        )
        FILTER (
          WHERE s.stationary_target = 1
        )
      -
      percentile_cont(0.25)
        WITHIN GROUP (
          ORDER BY s.stationary_distance_cm
        )
        FILTER (
          WHERE s.stationary_target = 1
        )
    )
      AS stationary_distance_iqr_cm,

    AVG(s.moving_distance_cm)
      FILTER (
        WHERE
          s.moving_target = 1
          AND
          s.sample_at <
            l.started_at +
            interval '3 seconds'
      )
      AS first3_moving_distance_cm,

    AVG(s.moving_distance_cm)
      FILTER (
        WHERE
          s.moving_target = 1
          AND
          s.sample_at >
            l.ended_at -
            interval '3 seconds'
      )
      AS last3_moving_distance_cm

  FROM labels l

  LEFT JOIN samples s
    ON s.sample_at BETWEEN
      l.started_at AND l.ended_at

  GROUP BY
    l.test_session_id,
    l.labeled_event_id,
    l.event_type,
    l.started_at,
    l.ended_at,
    l.duration_ms
)

SELECT
  test_session_id,
  labeled_event_id,
  event_type,
  started_at,
  ended_at,
  duration_ms,
  sample_count,
  sample_hz,
  moving_pct,
  moving_distance_p50_cm,
  moving_distance_iqr_cm,
  stationary_distance_p50_cm,
  stationary_distance_iqr_cm,
  first3_moving_distance_cm,
  last3_moving_distance_cm,
  (
    last3_moving_distance_cm -
    first3_moving_distance_cm
  ) AS trajectory_delta_cm

FROM features

ORDER BY
  started_at
`);

  if (!rows.length) {
    console.error(
      "No labeled activity evidence found."
    );
    process.exit(2);
  }

  const grouped =
    new Map();

  for (const row of rows) {
    const key =
      row.event_type;

    if (!grouped.has(key)) {
      grouped.set(
        key,
        []
      );
    }

    grouped
      .get(key)
      .push({
        sessionId:
          row.test_session_id,

        sampleCount:
          Number(row.sample_count),

        sampleHz:
          Number(row.sample_hz),

        movingPct:
          Number(row.moving_pct),

        movingP50:
          Number(
            row.moving_distance_p50_cm
          ),

        movingIqr:
          Number(
            row.moving_distance_iqr_cm
          ),

        stationaryP50:
          Number(
            row.stationary_distance_p50_cm
          ),

        stationaryIqr:
          Number(
            row.stationary_distance_iqr_cm
          ),

        trajectoryDelta:
          Number(
            row.trajectory_delta_cm
          )
      });
  }

  console.log(
    "=============================================="
  );
  console.log(
    "GOOD SHEPHERD LABELED ACTIVITY PROFILE ANALYSIS"
  );
  console.log(
    "=============================================="
  );
  console.log(
    `VERSION=${VERSION}`
  );
  console.log(
    `NODE_ID=${NODE_ID}`
  );
  console.log(
    `SESSION_COUNT=${sessionIds.length}`
  );
  console.log(
    "OBSERVER_ONLY=TRUE"
  );
  console.log(
    "READ_ONLY=TRUE"
  );
  console.log(
    "AUTOMATIC_CLASSIFICATION=NONE"
  );
  console.log(
    "FALL_EMERGENCY_MEDICAL_INFERENCE=NONE"
  );
  console.log("");

  for (
    const [eventType, events]
    of grouped.entries()
  ) {
    const deltas =
      events.map(
        (event) =>
          event.trajectoryDelta
      );

    const directions =
      events.map(
        (event) =>
          direction(
            event.trajectoryDelta
          )
      );

    const repeatedDirection =
      directions.length > 0 &&
      directions.every(
        (value) =>
          value === directions[0]
      );

    console.log(
      `ACTIVITY=${eventType}`
    );

    console.log(
      `  SESSIONS=${events.length}`
    );

    console.log(
      "  SAMPLE_HZ=" +
      events
        .map(
          (event) =>
            event.sampleHz.toFixed(2)
        )
        .join(" / ")
    );

    console.log(
      "  MOVING_PCT=" +
      events
        .map(
          (event) =>
            event.movingPct.toFixed(1)
        )
        .join(" / ")
    );

    console.log(
      "  MOVING_IQR_CM=" +
      events
        .map(
          (event) =>
            event.movingIqr.toFixed(1)
        )
        .join(" / ")
    );

    console.log(
      "  STATIONARY_IQR_CM=" +
      events
        .map(
          (event) =>
            event.stationaryIqr.toFixed(1)
        )
        .join(" / ")
    );

    console.log(
      "  TRAJECTORY_DELTA_CM=" +
      deltas
        .map(
          (value) =>
            value.toFixed(1)
        )
        .join(" / ")
    );

    console.log(
      "  DIRECTION=" +
      directions.join(" / ")
    );

    console.log(
      "  DIRECTION_REPEATABILITY=" +
      (
        repeatedDirection
          ? `${events.length}_OF_${events.length}`
          : "VARIABLE"
      )
    );

    console.log(
      "  MEDIAN_TRAJECTORY_DELTA_CM=" +
      median(deltas).toFixed(1)
    );

    console.log("");
  }

  console.log(
    "ANALYSIS_COMPLETE=PASS"
  );
  console.log(
    "DATABASE_WRITES=NONE"
  );
  console.log(
    "CLASSIFICATION_THRESHOLDS=NONE"
  );
  console.log(
    "OPERATIONAL_POLICY_CHANGES=NONE"
  );
}

try {
  main();
} catch (error) {
  console.error(
    "ANALYSIS_COMPLETE=FAIL"
  );

  console.error(
    error &&
    error.message
      ? error.message
      : error
  );

  process.exit(1);
}
