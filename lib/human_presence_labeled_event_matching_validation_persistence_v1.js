"use strict";

const {
  VERSION,
  buildLabeledEventMatch
} = require("./human_presence_labeled_event_matching_validation_v1");

const PARENT_ANALYTICS_VERSION =
  "human_presence_longitudinal_interpretation_validation_v1";

function mapLabelRow(row) {
  return {
    labeledEventId: row.labeled_event_id,
    eventType: row.event_type,
    captureSource: row.capture_source,
    testSessionId: row.test_session_id,
    residentId: row.resident_id,
    residentName: row.resident_name,
    roomOrLocation: row.room_or_location,
    observerName: row.observer_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: Number(row.duration_ms)
  };
}

function mapAnalyticalRow(row) {
  return {
    evidenceEventId: row.evidence_event_id,
    evidenceReceivedAt: row.evidence_received_at,
    authoritativeResidentId: row.authoritative_resident_id,
    authoritativeRoomOrLocation:
      row.authoritative_room_or_location,
    payload:
      row.longitudinal_interpretation_validation_payload
  };
}

async function loadLabel(client, labeledEventId) {
  const result = await client.query(
    `
      SELECT
        labeled_event_id,
        labeled_event_capture_version,
        event_type,
        capture_source,
        resident_id,
        resident_name,
        room_or_location,
        observer_name,
        test_session_id,
        started_at,
        ended_at,
        duration_ms,
        ground_truth_only,
        sensor_derived
      FROM human_presence_labeled_events
      WHERE labeled_event_id = $1
    `,
    [labeledEventId]
  );

  if (result.rowCount !== 1) {
    throw new Error(
      `Expected exactly one labeled event for ${labeledEventId}`
    );
  }

  const row = result.rows[0];

  if (
    row.ground_truth_only !== true ||
    row.sensor_derived !== false
  ) {
    throw new Error(
      `Ground-truth boundary violation for ${labeledEventId}`
    );
  }

  return row;
}

async function loadAnalyticalContext(client, labelRow) {
  /*
   * Deliberately no arbitrary temporal cutoff.
   *
   * We load the authoritative analytical history for this resident/room
   * and allow the pure engine to identify:
   *   - events inside the labeled interval
   *   - nearest event before
   *   - nearest event after
   *   - nearest event to start/end
   *
   * This is descriptive matching context, not an operational threshold.
   */
  const result = await client.query(
    `
      SELECT
        evidence_event_id,
        evidence_received_at,
        authoritative_resident_id,
        authoritative_room_or_location,
        longitudinal_interpretation_validation_payload
      FROM human_presence_longitudinal_interpretation_validations
      WHERE longitudinal_interpretation_validation_version = $1
        AND authoritative_resident_id = $2
        AND authoritative_room_or_location = $3
      ORDER BY evidence_received_at ASC, evidence_event_id ASC
    `,
    [
      PARENT_ANALYTICS_VERSION,
      labelRow.resident_id,
      labelRow.room_or_location
    ]
  );

  return result.rows;
}

async function buildForLabeledEvent(client, labeledEventId) {
  const labelRow = await loadLabel(client, labeledEventId);
  const analyticalRows =
    await loadAnalyticalContext(client, labelRow);

  return buildLabeledEventMatch({
    label: mapLabelRow(labelRow),
    analyticalEvents: analyticalRows.map(mapAnalyticalRow)
  });
}

async function persistForLabeledEvent(client, labeledEventId) {
  const match = await buildForLabeledEvent(
    client,
    labeledEventId
  );

  const label = match.labeledEvent;
  const context = match.analyticalContext;

  await client.query(
    `
      INSERT INTO human_presence_labeled_event_matching_validations (
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
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24
      )
      ON CONFLICT (
        labeled_event_id,
        matching_validation_version
      )
      DO NOTHING
    `,
    [
      label.labeledEventId,
      VERSION,
      PARENT_ANALYTICS_VERSION,
      label.eventType,
      label.captureSource,
      label.testSessionId,
      label.residentId,
      label.residentName,
      label.roomOrLocation,
      label.observerName,
      label.startedAt,
      label.endedAt,
      label.durationMs,

      context.authoritativeAnalyticalEventCount,
      context.insideInterval.count,

      context.nearestBefore?.evidenceEventId ?? null,
      context.nearestBefore?.secondsBeforeLabelStart ?? null,

      context.nearestAfter?.evidenceEventId ?? null,
      context.nearestAfter?.secondsAfterLabelEnd ?? null,

      context.nearestToStart?.evidenceEventId ?? null,
      context.nearestToStart?.distanceSeconds ?? null,

      context.nearestToEnd?.evidenceEventId ?? null,
      context.nearestToEnd?.distanceSeconds ?? null,

      JSON.stringify(match)
    ]
  );

  return match;
}

module.exports = {
  VERSION,
  PARENT_ANALYTICS_VERSION,
  buildForLabeledEvent,
  persistForLabeledEvent
};
