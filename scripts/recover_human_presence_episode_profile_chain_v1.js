"use strict";

const {
  buildAndPersistHumanPresenceEpisodeProfileAnalysisV1
} = require(
  "../lib/human_presence_episode_profile_analysis_persistence_v1"
);

const {
  buildAndPersistHumanPresenceEpisodeProfilePatternAnalysisV1
} = require(
  "../lib/human_presence_episode_profile_pattern_analysis_persistence_v1"
);

const {
  buildAndPersistHumanPresenceEpisodeProfileTemporalContextAnalysisV1
} = require(
  "../lib/human_presence_episode_profile_temporal_context_analysis_persistence_v1"
);

const {
  buildAndPersistHumanPresenceTemporalContextDataSufficiencyV1
} = require(
  "../lib/human_presence_temporal_context_data_sufficiency_persistence_v1"
);

const PROFILE_VERSION =
  "human_presence_episode_profile_analysis_v1";

const PATTERN_VERSION =
  "human_presence_episode_profile_pattern_analysis_v1";

const TEMPORAL_VERSION =
  "human_presence_episode_profile_temporal_context_analysis_v1";

const SUFFICIENCY_VERSION =
  "human_presence_temporal_context_data_sufficiency_v1";

const INTERPRETATION_VERSION =
  "human_presence_candidate_interpretation_v1";

async function loadEligibleEvidence(db) {
  const result = await db.query(
    `
      SELECT
        e.*,
        e.event_id AS evidence_event_id,

        i.authoritative_sensor_id,
        i.authoritative_resident_id,
        i.authoritative_resident_name,
        i.authoritative_room_or_location,
        i.authority_resolution_status,
        i.assignment_authority,

        e.received_at AS evidence_received_at

      FROM candidate_history_evidence_events e

      JOIN human_presence_candidate_interpretations i
        ON i.evidence_event_id = e.event_id
       AND i.interpretation_version = $1

      WHERE
        e.evidence_schema_version = '1.1'

        AND e.event_payload ? 'episodeProfile'

        AND i.authority_resolution_status =
            'resolved_assigned_sensor'

      ORDER BY
        e.received_at ASC,
        e.event_id ASC
    `,
    [INTERPRETATION_VERSION]
  );

  return result.rows;
}

async function recoverHumanPresenceEpisodeProfileChainV1(
  db,
  { log = console.log } = {}
) {
  /*
   * These are observer-only analytical tables.
   *
   * Prevent live ingestion from inserting into the analytical
   * chain while its downstream history is being rebuilt.
   * SELECTs remain available.
   */
  await db.query(`
    LOCK TABLE
      human_presence_episode_profile_analyses,
      human_presence_episode_profile_pattern_analyses,
      human_presence_episode_profile_temporal_context_analyses,
      human_presence_temporal_context_data_sufficiency_analyses
    IN SHARE ROW EXCLUSIVE MODE
  `);

  const eligible = await loadEligibleEvidence(db);

  if (eligible.length === 0) {
    throw new Error(
      "Recovery aborted: no eligible Schema 1.1 episode-profile evidence"
    );
  }

  const cohortKeys =
    new Map();

  for (const row of eligible) {
    const key =
      `${row.authoritative_resident_id}::` +
      `${row.authoritative_room_or_location}`;

    if (!cohortKeys.has(key)) {
      cohortKeys.set(key, {
        residentId:
          row.authoritative_resident_id,

        room:
          row.authoritative_room_or_location
      });
    }
  }

  /*
   * Phase 1:
   * Fill only missing Episode Profile Analysis v1 rows.
   *
   * This layer reads historical episode profiles directly from
   * candidate_history_evidence_events + authoritative interpretation,
   * so existing profile rows remain valid.
   */
  let profileInserted = 0;
  let profileAlreadyExists = 0;

  for (const row of eligible) {
    const result =
      await buildAndPersistHumanPresenceEpisodeProfileAnalysisV1(
        db,
        row
      );

    if (result.persistence.inserted) {
      profileInserted += 1;
    } else {
      profileAlreadyExists += 1;
    }
  }

  /*
   * Phase 2:
   * Remove downstream v1 rows for each affected resident/room.
   *
   * These analyses consume persisted parent analyses. Because
   * historical parents were previously missing, existing downstream
   * trajectories must be rebuilt chronologically.
   *
   * No raw evidence, interpretation, decision-readiness,
   * behavioral-observation, or behavioral-pattern rows are touched.
   */
  let deletedSufficiency = 0;
  let deletedTemporal = 0;
  let deletedPattern = 0;

  for (const cohort of cohortKeys.values()) {
    const sufficiencyDelete =
      await db.query(
        `
          DELETE FROM
            human_presence_temporal_context_data_sufficiency_analyses

          WHERE
            authoritative_resident_id = $1

            AND authoritative_room_or_location = $2

            AND temporal_context_data_sufficiency_version = $3
        `,
        [
          cohort.residentId,
          cohort.room,
          SUFFICIENCY_VERSION
        ]
      );

    deletedSufficiency +=
      sufficiencyDelete.rowCount;

    const temporalDelete =
      await db.query(
        `
          DELETE FROM
            human_presence_episode_profile_temporal_context_analyses

          WHERE
            authoritative_resident_id = $1

            AND authoritative_room_or_location = $2

            AND episode_profile_temporal_context_analysis_version = $3
        `,
        [
          cohort.residentId,
          cohort.room,
          TEMPORAL_VERSION
        ]
      );

    deletedTemporal +=
      temporalDelete.rowCount;

    const patternDelete =
      await db.query(
        `
          DELETE FROM
            human_presence_episode_profile_pattern_analyses

          WHERE
            authoritative_resident_id = $1

            AND authoritative_room_or_location = $2

            AND episode_profile_pattern_analysis_version = $3
        `,
        [
          cohort.residentId,
          cohort.room,
          PATTERN_VERSION
        ]
      );

    deletedPattern +=
      patternDelete.rowCount;
  }

  /*
   * Phase 3:
   * Rebuild downstream layers in strict historical order.
   */
  let patternInserted = 0;
  let temporalInserted = 0;
  let sufficiencyInserted = 0;

  for (const row of eligible) {
    const pattern =
      await buildAndPersistHumanPresenceEpisodeProfilePatternAnalysisV1(
        db,
        row.evidence_event_id
      );

    if (!pattern.persistence.inserted) {
      throw new Error(
        `Pattern rebuild failed to insert ${row.evidence_event_id}`
      );
    }

    patternInserted += 1;

    const temporal =
      await buildAndPersistHumanPresenceEpisodeProfileTemporalContextAnalysisV1(
        db,
        row.evidence_event_id
      );

    if (!temporal.persistence.inserted) {
      throw new Error(
        `Temporal rebuild failed to insert ${row.evidence_event_id}`
      );
    }

    temporalInserted += 1;

    const sufficiency =
      await buildAndPersistHumanPresenceTemporalContextDataSufficiencyV1(
        db,
        row.evidence_event_id
      );

    if (!sufficiency.persistence.inserted) {
      throw new Error(
        `Sufficiency rebuild failed to insert ${row.evidence_event_id}`
      );
    }

    sufficiencyInserted += 1;
  }

  /*
   * Phase 4:
   * Hard validation.
   */
  const validation =
    await db.query(
      `
        WITH eligible AS (
          SELECT
            e.event_id

          FROM candidate_history_evidence_events e

          JOIN human_presence_candidate_interpretations i
            ON i.evidence_event_id = e.event_id
           AND i.interpretation_version = $1

          WHERE
            e.evidence_schema_version = '1.1'

            AND e.event_payload ? 'episodeProfile'

            AND i.authority_resolution_status =
                'resolved_assigned_sensor'
        )

        SELECT
          (SELECT COUNT(*) FROM eligible)::int
            AS eligible,

          (
            SELECT COUNT(*)
            FROM eligible e
            JOIN human_presence_episode_profile_analyses p
              ON p.evidence_event_id = e.event_id
             AND p.episode_profile_analysis_version = $2
          )::int
            AS profile,

          (
            SELECT COUNT(*)
            FROM eligible e
            JOIN human_presence_episode_profile_pattern_analyses q
              ON q.evidence_event_id = e.event_id
             AND q.episode_profile_pattern_analysis_version = $3
          )::int
            AS pattern,

          (
            SELECT COUNT(*)
            FROM eligible e
            JOIN human_presence_episode_profile_temporal_context_analyses t
              ON t.evidence_event_id = e.event_id
             AND t.episode_profile_temporal_context_analysis_version = $4
          )::int
            AS temporal,

          (
            SELECT COUNT(*)
            FROM eligible e
            JOIN human_presence_temporal_context_data_sufficiency_analyses s
              ON s.evidence_event_id = e.event_id
             AND s.temporal_context_data_sufficiency_version = $5
          )::int
            AS sufficiency
      `,
      [
        INTERPRETATION_VERSION,
        PROFILE_VERSION,
        PATTERN_VERSION,
        TEMPORAL_VERSION,
        SUFFICIENCY_VERSION
      ]
    );

  const counts =
    validation.rows[0];

  if (
    counts.eligible !== counts.profile ||
    counts.eligible !== counts.pattern ||
    counts.eligible !== counts.temporal ||
    counts.eligible !== counts.sufficiency
  ) {
    throw new Error(
      "Recovery validation failed: " +
      JSON.stringify(counts)
    );
  }

  const duplicates =
    await db.query(
      `
        SELECT
          (
            SELECT COUNT(*)
            FROM (
              SELECT
                evidence_event_id,
                episode_profile_analysis_version

              FROM human_presence_episode_profile_analyses

              GROUP BY
                evidence_event_id,
                episode_profile_analysis_version

              HAVING COUNT(*) > 1
            ) d
          )::int AS profile_duplicates,

          (
            SELECT COUNT(*)
            FROM (
              SELECT
                evidence_event_id,
                episode_profile_pattern_analysis_version

              FROM human_presence_episode_profile_pattern_analyses

              GROUP BY
                evidence_event_id,
                episode_profile_pattern_analysis_version

              HAVING COUNT(*) > 1
            ) d
          )::int AS pattern_duplicates,

          (
            SELECT COUNT(*)
            FROM (
              SELECT
                evidence_event_id,
                episode_profile_temporal_context_analysis_version

              FROM human_presence_episode_profile_temporal_context_analyses

              GROUP BY
                evidence_event_id,
                episode_profile_temporal_context_analysis_version

              HAVING COUNT(*) > 1
            ) d
          )::int AS temporal_duplicates,

          (
            SELECT COUNT(*)
            FROM (
              SELECT
                evidence_event_id,
                temporal_context_data_sufficiency_version

              FROM human_presence_temporal_context_data_sufficiency_analyses

              GROUP BY
                evidence_event_id,
                temporal_context_data_sufficiency_version

              HAVING COUNT(*) > 1
            ) d
          )::int AS sufficiency_duplicates
      `
    );

  const duplicateCounts =
    duplicates.rows[0];

  if (
    duplicateCounts.profile_duplicates !== 0 ||
    duplicateCounts.pattern_duplicates !== 0 ||
    duplicateCounts.temporal_duplicates !== 0 ||
    duplicateCounts.sufficiency_duplicates !== 0
  ) {
    throw new Error(
      "Recovery duplicate validation failed: " +
      JSON.stringify(duplicateCounts)
    );
  }

  const boundary =
    await db.query(
      `
        SELECT COUNT(*)::int AS violations

        FROM
          human_presence_temporal_context_data_sufficiency_analyses

        WHERE
          temporal_context_data_sufficiency_version = $1

          AND (
            COALESCE(
              temporal_context_data_sufficiency_payload
                ->>'observerOnly',
              'false'
            ) <> 'true'

            OR COALESCE(
              temporal_context_data_sufficiency_payload
                ->>'descriptiveOnly',
              'false'
            ) <> 'true'

            OR temporal_context_data_sufficiency_payload
                 ->>'operationalClassification'
                 IS NOT NULL

            OR temporal_context_data_sufficiency_payload
                 ->>'alertLevel'
                 IS NOT NULL

            OR temporal_context_data_sufficiency_payload
                 ->>'monitoringAction'
                 IS NOT NULL

            OR temporal_context_data_sufficiency_payload
                 ->>'interventionRecommendation'
                 IS NOT NULL
          )
      `,
      [SUFFICIENCY_VERSION]
    );

  if (boundary.rows[0].violations !== 0) {
    throw new Error(
      `Observer-only boundary violations: ` +
      `${boundary.rows[0].violations}`
    );
  }

  const summary = {
    eligible:
      counts.eligible,

    profileInserted,
    profileAlreadyExists,

    deletedPattern,
    deletedTemporal,
    deletedSufficiency,

    patternInserted,
    temporalInserted,
    sufficiencyInserted,

    finalCoverage: {
      profile:
        counts.profile,

      pattern:
        counts.pattern,

      temporal:
        counts.temporal,

      sufficiency:
        counts.sufficiency
    },

    duplicates:
      duplicateCounts,

    observerOnlyBoundaryViolations:
      boundary.rows[0].violations
  };

  log(
    "Human Presence Episode Profile chain recovery v1:",
    JSON.stringify(summary)
  );

  return summary;
}

module.exports = {
  recoverHumanPresenceEpisodeProfileChainV1
};
