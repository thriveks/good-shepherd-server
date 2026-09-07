"use strict";

const {
  HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_VERSION,
  HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_PARENT_VERSION,
  buildHumanPresenceTemporalContextDataSufficiencyV1
} = require(
  "./human_presence_temporal_context_data_sufficiency_v1"
);

const TIME_ZONE =
  "America/Chicago";

async function loadCurrentTemporalContextV1(
  db,
  evidenceEventId
) {
  const result =
    await db.query(
      `
        SELECT
          evidence_event_id,
          authoritative_sensor_id,
          authoritative_resident_id,
          authoritative_resident_name,
          authoritative_room_or_location,
          authority_resolution_status,
          assignment_authority,
          evidence_received_at,
          episode_profile_temporal_context_analysis_version,
          episode_profile_temporal_context_analysis_payload

        FROM human_presence_episode_profile_temporal_context_analyses

        WHERE evidence_event_id = $1

          AND
          episode_profile_temporal_context_analysis_version =
          $2

        LIMIT 1
      `,
      [
        evidenceEventId,
        HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_PARENT_VERSION
      ]
    );

  const row =
    result.rows[0] || null;

  if (!row) {
    throw new Error(
      `Temporal Context v1 parent missing for ${evidenceEventId}`
    );
  }

  return row;
}

async function loadTemporalContextSufficiencyEvidenceV1(
  db,
  current
) {
  const daypart =
    current
      .episode_profile_temporal_context_analysis_payload
      ?.temporalContext
      ?.daypart;

  if (!daypart) {
    throw new Error(
      "Temporal Context parent daypart missing"
    );
  }

  const result =
    await db.query(
      `
        WITH cohort AS (
          SELECT
            evidence_event_id,

            episode_profile_temporal_context_analysis_version,

            evidence_received_at,

            episode_profile_temporal_context_analysis_payload

          FROM
            human_presence_episode_profile_temporal_context_analyses

          WHERE
            authoritative_resident_id = $1

            AND
            authoritative_room_or_location = $2

            AND
            episode_profile_temporal_context_analysis_version =
            $3

            AND
            episode_profile_temporal_context_analysis_payload
              ->'temporalContext'
              ->>'daypart' = $4

            AND
            evidence_received_at <= $5
        ),

        duplicate_groups AS (
          SELECT
            evidence_event_id,
            episode_profile_temporal_context_analysis_version,
            COUNT(*) AS row_count

          FROM cohort

          GROUP BY
            evidence_event_id,
            episode_profile_temporal_context_analysis_version

          HAVING COUNT(*) > 1
        )

        SELECT
          COUNT(*)::int AS observation_count,

          MIN(evidence_received_at)
            AS first_observation_at,

          MAX(evidence_received_at)
            AS latest_observation_at,

          COUNT(
            DISTINCT (
              evidence_received_at
              AT TIME ZONE '${TIME_ZONE}'
            )::date
          )::int AS distinct_calendar_days,

          COUNT(*) FILTER (
            WHERE
              episode_profile_temporal_context_analysis_payload
                ->>'observerOnly'
                IS DISTINCT FROM 'true'

              OR

              episode_profile_temporal_context_analysis_payload
                ->>'descriptiveOnly'
                IS DISTINCT FROM 'true'

              OR

              episode_profile_temporal_context_analysis_payload
                ->'operationalClassification'
                IS DISTINCT FROM 'null'::jsonb

              OR

              episode_profile_temporal_context_analysis_payload
                ->'alertLevel'
                IS DISTINCT FROM 'null'::jsonb

              OR

              episode_profile_temporal_context_analysis_payload
                ->'monitoringAction'
                IS DISTINCT FROM 'null'::jsonb

              OR

              episode_profile_temporal_context_analysis_payload
                ->'interventionRecommendation'
                IS DISTINCT FROM 'null'::jsonb
          )::int AS contaminated_rows,

          (
            SELECT COUNT(*)::int
            FROM duplicate_groups
          ) AS duplicate_composite_key_groups

        FROM cohort
      `,
      [
        current.authoritative_resident_id,
        current.authoritative_room_or_location,
        HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_PARENT_VERSION,
        daypart,
        current.evidence_received_at
      ]
    );

  return {
    daypart,
    ...result.rows[0]
  };
}

async function persistHumanPresenceTemporalContextDataSufficiencyV1(
  db,
  current,
  analysis
) {
  const result =
    await db.query(
      `
        INSERT INTO
          human_presence_temporal_context_data_sufficiency_analyses (
            evidence_event_id,
            temporal_context_analysis_version,
            temporal_context_data_sufficiency_version,

            authoritative_sensor_id,
            authoritative_resident_id,
            authoritative_resident_name,
            authoritative_room_or_location,
            authority_resolution_status,
            assignment_authority,

            daypart,
            evidence_received_at,

            temporal_context_data_sufficiency_payload,
            temporal_context_data_sufficiency_at
          )

        VALUES (
          $1,$2,$3,
          $4,$5,$6,$7,$8,$9,
          $10,$11,
          $12::jsonb,
          NOW()
        )

        ON CONFLICT (
          evidence_event_id,
          temporal_context_data_sufficiency_version
        )
        DO NOTHING

        RETURNING
          temporal_context_data_sufficiency_at
      `,
      [
        current.evidence_event_id,

        HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_PARENT_VERSION,

        HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_VERSION,

        current.authoritative_sensor_id,
        current.authoritative_resident_id,
        current.authoritative_resident_name,
        current.authoritative_room_or_location,
        current.authority_resolution_status,
        current.assignment_authority,

        analysis.daypart,
        current.evidence_received_at,

        JSON.stringify(analysis)
      ]
    );

  return {
    inserted:
      result.rowCount === 1,

    temporalContextDataSufficiencyVersion:
      HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_VERSION
  };
}

async function buildAndPersistHumanPresenceTemporalContextDataSufficiencyV1(
  db,
  evidenceEventId
) {
  const current =
    await loadCurrentTemporalContextV1(
      db,
      evidenceEventId
    );

  const evidence =
    await loadTemporalContextSufficiencyEvidenceV1(
      db,
      current
    );

  const analysis =
    buildHumanPresenceTemporalContextDataSufficiencyV1({
      evidenceEventId:
        current.evidence_event_id,

      authoritativeResidentId:
        current.authoritative_resident_id,

      authoritativeRoomOrLocation:
        current.authoritative_room_or_location,

      daypart:
        evidence.daypart,

      firstObservationAt:
        evidence.first_observation_at,

      latestObservationAt:
        evidence.latest_observation_at,

      observationCount:
        evidence.observation_count,

      distinctCalendarDays:
        evidence.distinct_calendar_days,

      contaminatedRows:
        evidence.contaminated_rows,

      duplicateCompositeKeyGroups:
        evidence.duplicate_composite_key_groups
    });

  const persistence =
    await persistHumanPresenceTemporalContextDataSufficiencyV1(
      db,
      current,
      analysis
    );

  return {
    temporalContextDataSufficiencyAnalysis:
      analysis,

    persistence
  };
}

module.exports = {
  TIME_ZONE,

  loadCurrentTemporalContextV1,
  loadTemporalContextSufficiencyEvidenceV1,

  persistHumanPresenceTemporalContextDataSufficiencyV1,

  buildAndPersistHumanPresenceTemporalContextDataSufficiencyV1
};
