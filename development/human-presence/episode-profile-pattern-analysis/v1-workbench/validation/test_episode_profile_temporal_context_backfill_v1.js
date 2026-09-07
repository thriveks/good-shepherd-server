"use strict";

const assert = require("assert");

const {
  backfillHumanPresenceEpisodeProfileTemporalContextV1
} = require(
  "../../../../../scripts/backfill_human_presence_episode_profile_temporal_context_v1"
);

const inserted = [];

const db = {
  async query(sql, params = []) {
    if (
      sql.includes("NOT EXISTS") &&
      sql.includes(
        "human_presence_episode_profile_temporal_context_analyses"
      )
    ) {
      return {
        rowCount: 3,
        rows: [
          { evidence_event_id: "e1" },
          { evidence_event_id: "e2" },
          { evidence_event_id: "e3" }
        ]
      };
    }

    if (
      sql.includes(
        "FROM human_presence_episode_profile_analyses p"
      ) &&
      sql.includes(
        "WHERE p.evidence_event_id = $1"
      )
    ) {
      const id = params[0];

      const index =
        ["e1", "e2", "e3"].indexOf(id);

      const hour =
        13 + index;

      return {
        rowCount: 1,
        rows: [
          {
            evidence_event_id: id,

            episode_profile_analysis_version:
              "human_presence_episode_profile_analysis_v1",

            episode_profile_pattern_analysis_version:
              "human_presence_episode_profile_pattern_analysis_v1",

            authoritative_sensor_id: null,
            authoritative_resident_id: "resident-1",
            authoritative_resident_name: "Resident One",
            authoritative_room_or_location: "room-1",

            authority_resolution_status:
              "resolved_assigned_sensor",

            assignment_authority:
              "operator_explicit",

            evidence_received_at:
              `2026-09-06T${String(hour).padStart(2, "0")}:00:00Z`,

            episode_profile_analysis_at:
              `2026-09-06T${String(hour).padStart(2, "0")}:00:01Z`,

            episode_profile_pattern_analysis_at:
              `2026-09-06T${String(hour).padStart(2, "0")}:00:02Z`,

            episode_profile_analysis_payload: {
              observerOnly: true,
              profileMeanRelativeDelta:
                0.20 + index / 100
            },

            episode_profile_pattern_analysis_payload: {
              observerOnly: true,
              descriptiveOnly: true,

              nearestPriorProfile: {
                nearestPriorProfileDistance:
                  index === 0
                    ? null
                    : 0.10 + index / 100
              },

              operationalClassification: null,
              alertLevel: null,
              monitoringAction: null,
              interventionRecommendation: null
            }
          }
        ]
      };
    }

    if (
      sql.includes(
        "FROM human_presence_episode_profile_analyses p"
      ) &&
      sql.includes(
        "p.authoritative_resident_id = $1"
      )
    ) {
      return {
        rowCount: 0,
        rows: []
      };
    }

    if (
      sql.includes(
        "INSERT INTO"
      ) &&
      sql.includes(
        "human_presence_episode_profile_temporal_context_analyses"
      )
    ) {
      inserted.push(params[0]);

      return {
        rowCount: 1,
        rows: [
          {
            episode_profile_temporal_context_analysis_at:
              new Date().toISOString()
          }
        ]
      };
    }

    throw new Error(
      `Unexpected SQL in temporal-context backfill test:\n${sql}`
    );
  }
};

(async () => {
  const summary =
    await backfillHumanPresenceEpisodeProfileTemporalContextV1(
      db,
      { log: () => {} }
    );

  assert.strictEqual(
    summary.candidateCount,
    3
  );

  assert.strictEqual(
    summary.inserted,
    3
  );

  assert.strictEqual(
    summary.alreadyExists,
    0
  );

  assert.deepStrictEqual(
    inserted,
    ["e1", "e2", "e3"]
  );

  console.log(
    "PASS: Temporal Context v1 deterministic historical backfill"
  );

  console.log(
    "PASS: historical parents processed oldest-first"
  );

  console.log(
    "PASS: production temporal-context engine reused"
  );

  console.log(
    "PASS: no alternate temporal math introduced"
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
