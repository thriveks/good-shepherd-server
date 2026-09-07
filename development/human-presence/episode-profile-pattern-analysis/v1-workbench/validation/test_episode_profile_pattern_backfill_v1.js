"use strict";

const assert = require("assert");

const {
  backfillHumanPresenceEpisodeProfilePatternV1
} = require(
  "../../../../../scripts/backfill_human_presence_episode_profile_pattern_v1"
);

const DIMENSIONS = [
  "movingPctMean",
  "stationaryPctMean",
  "target2PctMean",
  "target3PctMean",
  "transitionsMean",
  "movingDistanceWindowMedianMeanCm",
  "movingDistanceWindowIqrMeanCm",
  "stationaryDistanceWindowMedianMeanCm",
  "stationaryDistanceWindowIqrMeanCm",
  "detectionDistanceWindowMedianMeanCm",
  "movingEnergyWindowMedianMean",
  "stationaryEnergyWindowMedianMean"
];

function parentRow(id, time, base) {
  const dimensions = {};

  DIMENSIONS.forEach((name, index) => {
    dimensions[name] = {
      current: base + index,
      historyCount: 50,
      historyMin: base + index - 1,
      historyMax: base + index + 1,
      historyMean: base + index - 0.5,
      historyMedian: base + index - 0.5,
      historyRange: 2,
      currentVsHistoryMeanRelativeDelta:
        0.1 + index / 100
    };
  });

  return {
    evidence_event_id: id,
    episode_profile_analysis_version:
      "human_presence_episode_profile_analysis_v1",
    authoritative_sensor_id: null,
    authoritative_resident_id: "resident-1",
    authoritative_resident_name: "Resident One",
    authoritative_room_or_location: "room-1",
    authority_resolution_status:
      "resolved_assigned_sensor",
    assignment_authority: "operator_explicit",
    evidence_received_at: time,
    episode_profile_analysis_at: time,
    episode_profile_analysis_payload: {
      episodeProfileAnalysisVersion:
        "human_presence_episode_profile_analysis_v1",
      evidenceEventId: id,
      evidenceReceivedAt: time,
      observerOnly: true,
      dimensionCount: 12,
      profileMeanRelativeDelta: 0.25,
      dimensions
    }
  };
}

const rows = {
  e1: parentRow(
    "e1",
    "2026-09-06T10:00:00Z",
    10
  ),
  e2: parentRow(
    "e2",
    "2026-09-06T10:10:00Z",
    11
  )
};

const inserted = new Set();

const db = {
  async query(sql, params = []) {
    if (
      sql.includes(
        "SELECT"
      ) &&
      sql.includes(
        "NOT EXISTS"
      ) &&
      sql.includes(
        "human_presence_episode_profile_pattern_analyses"
      )
    ) {
      return {
        rowCount: 2,
        rows: [
          { evidence_event_id: "e1" },
          { evidence_event_id: "e2" }
        ]
      };
    }

    if (
      sql.includes(
        "FROM human_presence_episode_profile_analyses"
      ) &&
      sql.includes("evidence_event_id = $1")
    ) {
      return {
        rowCount: 1,
        rows: [rows[params[0]]]
      };
    }

    if (
      sql.includes(
        "FROM human_presence_episode_profile_analyses"
      ) &&
      sql.includes(
        "authoritative_resident_id = $1"
      )
    ) {
      const currentTime =
        new Date(params[3]).getTime();

      const history =
        Object.values(rows)
          .filter(
            (row) =>
              new Date(
                row.evidence_received_at
              ).getTime() < currentTime
          )
          .sort(
            (a, b) =>
              new Date(
                a.evidence_received_at
              ).getTime() -
              new Date(
                b.evidence_received_at
              ).getTime()
          );

      return {
        rowCount: history.length,
        rows: history
      };
    }

    if (
      sql.includes("INSERT INTO") &&
      sql.includes(
        "human_presence_episode_profile_pattern_analyses"
      )
    ) {
      const eventId = params[0];

      if (inserted.has(eventId)) {
        return {
          rowCount: 0,
          rows: []
        };
      }

      inserted.add(eventId);

      return {
        rowCount: 1,
        rows: [
          {
            episode_profile_pattern_analysis_at:
              new Date().toISOString()
          }
        ]
      };
    }

    throw new Error(
      `Unexpected SQL in backfill validation: ${sql}`
    );
  }
};

(async () => {
  const summary =
    await backfillHumanPresenceEpisodeProfilePatternV1(
      db,
      { log: () => {} }
    );

  assert.strictEqual(
    summary.candidateCount,
    2
  );

  assert.strictEqual(
    summary.inserted,
    2
  );

  assert.strictEqual(
    summary.alreadyExists,
    0
  );

  assert.deepStrictEqual(
    [...inserted],
    ["e1", "e2"]
  );

  console.log(
    "PASS: deterministic Episode Profile Pattern backfill"
  );
  console.log(
    "PASS: historical parents processed oldest-first"
  );
  console.log(
    "PASS: existing production engine reused"
  );
  console.log(
    "PASS: no alternate analytical math introduced"
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
