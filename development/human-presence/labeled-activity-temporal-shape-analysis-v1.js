"use strict";

const { execFileSync } = require("child_process");

const DB_ID = "dpg-d7h6nh28qa3s73cvl42g-a";
const NODE_ID = "esp32-a02dbcabc31c";

const SESSION_IDS = [
  "hp-test-20260909140250-7e43045e",
  "hp-test-20260909141923-37e068b2",
  "hp-test-20260909143648-891e137c",
  "hp-test-20260909180221-22535bc7",
  "hp-test-20260909180415-7e4f1940",
  "hp-test-20260909180608-de9aa6ff"
];

const EVENT_TYPES = [
  "stand_up",
  "sit_down",
  "intentional_lie_down",
  "intentional_rise_from_lying"
];

function sqlLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function runPsql(sql) {
  return execFileSync(
    "render",
    [
      "psql",
      DB_ID,
      "--command",
      sql,
      "-o",
      "text"
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
}

function main() {
  const sessionSql = SESSION_IDS.map(sqlLiteral).join(",");
  const eventSql = EVENT_TYPES.map(sqlLiteral).join(",");
  const nodeSql = sqlLiteral(NODE_ID);

  const sql = `
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
    AND event_type IN (${eventSql})
),
bounds AS (
  SELECT
    MIN(started_at) - interval '5 seconds' AS min_at,
    MAX(ended_at) + interval '5 seconds' AS max_at
  FROM labels
),
raw_batches AS (
  SELECT
    w.timestamp,
    w.event_payload,
    w.event_payload->>'bootSessionId' AS boot_session_id,
    (
      w.timestamp -
      (
        (w.event_payload->>'batchEndUptimeMs')::bigint
        * interval '1 millisecond'
      )
    ) AS batch_clock_offset
  FROM webhook_events w
  CROSS JOIN bounds b
  WHERE w.node_id = ${nodeSql}
    AND w.event_type = 'high_resolution_activity_evidence'
    AND w.timestamp BETWEEN b.min_at AND b.max_at
),
clock_anchor AS (
  SELECT
    boot_session_id,
    percentile_cont(0.5)
      WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM batch_clock_offset)
      ) AS median_offset_epoch
  FROM raw_batches
  GROUP BY boot_session_id
),
samples AS (
  SELECT
    to_timestamp(
      c.median_offset_epoch +
      ((sample.value->>1)::bigint / 1000.0)
    ) AS sample_at,

    (sample.value->>4)::integer AS moving_target,
    (sample.value->>5)::double precision AS moving_distance_cm,
    (sample.value->>7)::integer AS stationary_target,
    (sample.value->>8)::double precision AS stationary_distance_cm

  FROM raw_batches b
  JOIN clock_anchor c
    ON c.boot_session_id = b.boot_session_id
  CROSS JOIN LATERAL
    jsonb_array_elements(b.event_payload->'samples') sample(value)
),
joined AS (
  SELECT
    l.test_session_id,
    l.labeled_event_id,
    l.event_type,
    l.started_at,
    l.ended_at,
    l.duration_ms,
    s.sample_at,
    s.moving_target,
    s.moving_distance_cm,
    s.stationary_target,
    s.stationary_distance_cm,

    LEAST(
      9,
      GREATEST(
        0,
        FLOOR(
          (
            EXTRACT(EPOCH FROM (s.sample_at - l.started_at))
            /
            NULLIF(
              EXTRACT(EPOCH FROM (l.ended_at - l.started_at)),
              0
            )
          ) * 10
        )::integer
      )
    ) AS segment

  FROM labels l
  JOIN samples s
    ON s.sample_at BETWEEN l.started_at AND l.ended_at
),
segments AS (
  SELECT
    test_session_id,
    labeled_event_id,
    event_type,
    segment,
    COUNT(*) AS sample_count,

    100.0 * AVG(
      CASE WHEN moving_target = 1 THEN 1.0 ELSE 0.0 END
    ) AS moving_pct,

    percentile_cont(0.5)
      WITHIN GROUP (ORDER BY moving_distance_cm)
      FILTER (WHERE moving_target = 1)
      AS moving_median_cm,

    percentile_cont(0.5)
      WITHIN GROUP (ORDER BY stationary_distance_cm)
      FILTER (WHERE stationary_target = 1)
      AS stationary_median_cm

  FROM joined
  GROUP BY
    test_session_id,
    labeled_event_id,
    event_type,
    segment
),
event_summary AS (
  SELECT
    test_session_id,
    labeled_event_id,
    event_type,

    MIN(moving_median_cm)
      AS min_moving_cm,

    MAX(moving_median_cm)
      AS max_moving_cm,

    MAX(moving_median_cm) -
    MIN(moving_median_cm)
      AS excursion_cm,

    (
      array_agg(
        segment
        ORDER BY moving_median_cm ASC NULLS LAST
      )
    )[1] AS min_segment,

    (
      array_agg(
        segment
        ORDER BY moving_median_cm DESC NULLS LAST
      )
    )[1] AS max_segment,

    AVG(moving_pct)
      AS mean_moving_pct

  FROM segments
  GROUP BY
    test_session_id,
    labeled_event_id,
    event_type
)

SELECT
  RIGHT(test_session_id, 8) AS session,
  event_type,
  ROUND(min_moving_cm::numeric,1) AS min_cm,
  min_segment,
  ROUND(max_moving_cm::numeric,1) AS max_cm,
  max_segment,
  ROUND(excursion_cm::numeric,1) AS excursion_cm,
  ROUND(mean_moving_pct::numeric,1) AS moving_pct
FROM event_summary
ORDER BY
  event_type,
  test_session_id;
`;

  console.log("==================================================");
  console.log("GOOD SHEPHERD TEMPORAL SHAPE ANALYSIS v1");
  console.log("==================================================");
  console.log("NODE_ID=" + NODE_ID);
  console.log("NORMALIZED_SEGMENTS=10");
  console.log("CLOCK_SOURCE=ESP32_UPTIME");
  console.log("WALL_CLOCK_ANCHOR=MEDIAN_BATCH_OFFSET");
  console.log("OBSERVER_ONLY=TRUE");
  console.log("READ_ONLY=TRUE");
  console.log("CLASSIFICATION_THRESHOLDS=NONE");
  console.log("FALL_INFERENCE=NONE");
  console.log("");

  process.stdout.write(runPsql(sql));

  console.log("");
  console.log("TEMPORAL_SHAPE_ANALYSIS=PASS");
  console.log("DATABASE_WRITES=NONE");
  console.log("OPERATIONAL_POLICY_CHANGES=NONE");
}

main();
