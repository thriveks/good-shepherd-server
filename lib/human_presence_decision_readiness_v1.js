'use strict';

const HUMAN_PRESENCE_DECISION_READINESS_VERSION =
  'human_presence_decision_readiness_v1';

const REQUIRED_PARENT_PERSISTENCE_VERSION =
  'human_presence_candidate_interpretation_v1';

const REQUIRED_PARENT_ENGINE_VERSION =
  'human_presence_interpretation_v1';

const REQUIRED_AUTHORITY_STATUS =
  'resolved_assigned_sensor';

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function parsePayload(value) {
  if (typeof value === 'string') {
    return requireObject(JSON.parse(value), 'interpretation_payload');
  }
  return requireObject(value, 'interpretation_payload');
}

function parseTimestamp(value, name) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return date;
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDailyRows(rows, residentId) {
  if (!Array.isArray(rows)) {
    throw new Error('dailyActivityRows must be an array');
  }

  return rows
    .filter((row) => row && String(row.resident_id) === String(residentId))
    .map((row) => ({
      residentId: String(row.resident_id),
      activityDate: nullableText(row.activity_date),
      motionCount: numericOrNull(row.motion_count),
      firstMotionAt: nullableText(row.first_motion_at),
      lastMotionAt: nullableText(row.last_motion_at),
      roomCounts: row.room_counts && typeof row.room_counts === 'object'
        ? row.room_counts
        : {},
      hourlyCounts: row.hourly_counts && typeof row.hourly_counts === 'object'
        ? row.hourly_counts
        : {}
    }))
    .sort((a, b) =>
      String(a.activityDate || '').localeCompare(String(b.activityDate || ''))
    );
}

function normalizeMotionRows(rows, residentId, episodeTime) {
  if (!Array.isArray(rows)) {
    throw new Error('motionEvents must be an array');
  }

  const accepted = [];

  for (const row of rows) {
    if (!row || String(row.resident_id) !== String(residentId)) continue;

    const timestamp = parseTimestamp(
      row.event_timestamp,
      'motion event_timestamp'
    );

    accepted.push({
      residentId: String(row.resident_id),
      sensorId: nullableText(row.sensor_id),
      nodeId: nullableText(row.node_id),
      sourceKey: nullableText(row.source_key),
      sourceName: nullableText(row.source_name),
      locationName: nullableText(row.location_name),
      roomName: nullableText(row.room_name),
      eventTimestamp: timestamp.toISOString(),
      relationToEpisode:
        timestamp.getTime() < episodeTime.getTime()
          ? 'before'
          : timestamp.getTime() > episodeTime.getTime()
            ? 'after'
            : 'same_timestamp'
    });
  }

  accepted.sort((a, b) =>
    new Date(a.eventTimestamp).getTime() -
    new Date(b.eventTimestamp).getTime()
  );

  return accepted;
}

function buildHumanPresenceDecisionReadinessV1(input) {
  requireObject(input, 'input');

  const interpretation = requireObject(
    input.interpretation,
    'interpretation'
  );

  if (
    interpretation.interpretation_version !==
    REQUIRED_PARENT_PERSISTENCE_VERSION
  ) {
    throw new Error('unsupported parent interpretation_version');
  }

  if (
    interpretation.authority_resolution_status !==
    REQUIRED_AUTHORITY_STATUS
  ) {
    throw new Error('parent authority is not resolved_assigned_sensor');
  }

  if (
    !interpretation.authoritative_sensor_id ||
    !interpretation.authoritative_resident_id
  ) {
    throw new Error('authoritative sensor/resident identity is required');
  }

  const payload = parsePayload(
    interpretation.interpretation_payload
  );

  if (
    payload.interpretationVersion !==
    REQUIRED_PARENT_ENGINE_VERSION
  ) {
    throw new Error('unsupported parent analytical engine version');
  }

  if (payload.descriptiveOnly !== true) {
    throw new Error('parent interpretation is not descriptive-only');
  }

  if (
    payload.operationalClassification !== null ||
    payload.alertLevel !== null ||
    payload.monitoringAction !== null
  ) {
    throw new Error('parent interpretation contains operational output');
  }

  const episodeTime = parseTimestamp(
    interpretation.evidence_received_at,
    'evidence_received_at'
  );

  parseTimestamp(
    interpretation.interpreted_at,
    'interpreted_at'
  );

  const residentId =
    String(interpretation.authoritative_resident_id);

  const dailyRows = normalizeDailyRows(
    input.dailyActivityRows || [],
    residentId
  );

  const motionRows = normalizeMotionRows(
    input.motionEvents || [],
    residentId,
    episodeTime
  );

  const before = motionRows.filter(
    (row) => row.relationToEpisode === 'before'
  );

  const after = motionRows.filter(
    (row) => row.relationToEpisode === 'after'
  );

  const sameTimestamp = motionRows.filter(
    (row) => row.relationToEpisode === 'same_timestamp'
  );

  const latestPriorMotion =
    before.length ? before[before.length - 1] : null;

  const earliestFollowingMotion =
    after.length ? after[0] : null;

  const secondsSincePriorMotion = latestPriorMotion
    ? Math.floor(
        (
          episodeTime.getTime() -
          new Date(latestPriorMotion.eventTimestamp).getTime()
        ) / 1000
      )
    : null;

  const secondsUntilFollowingMotion = earliestFollowingMotion
    ? Math.floor(
        (
          new Date(earliestFollowingMotion.eventTimestamp).getTime() -
          episodeTime.getTime()
        ) / 1000
      )
    : null;

  const authoritativeRoom =
    nullableText(
      interpretation.authoritative_room_or_location
    );

  const sameRoomMotionCount = authoritativeRoom
    ? motionRows.filter(
        (row) =>
          nullableText(row.roomName) === authoritativeRoom ||
          (
            !nullableText(row.roomName) &&
            nullableText(row.locationName) === authoritativeRoom
          )
      ).length
    : 0;

  return {
    decisionReadinessVersion:
      HUMAN_PRESENCE_DECISION_READINESS_VERSION,

    descriptiveOnly: true,

    evidenceEventId:
      String(interpretation.evidence_event_id),

    parentInterpretationVersion:
      String(interpretation.interpretation_version),

    parentEngineInterpretationVersion:
      String(payload.interpretationVersion),

    authority: {
      status:
        String(interpretation.authority_resolution_status),
      assignmentAuthority:
        nullableText(interpretation.assignment_authority),
      sensorId:
        String(interpretation.authoritative_sensor_id),
      residentId,
      residentName:
        nullableText(
          interpretation.authoritative_resident_name
        ),
      roomOrLocation: authoritativeRoom
    },

    chronology: {
      evidenceReceivedAt: episodeTime.toISOString(),
      interpretedAt:
        new Date(
          interpretation.interpreted_at
        ).toISOString(),
      priorMotionEventCount: before.length,
      followingMotionEventCount: after.length,
      sameTimestampMotionEventCount: sameTimestamp.length,
      latestPriorMotionAt:
        latestPriorMotion
          ? latestPriorMotion.eventTimestamp
          : null,
      earliestFollowingMotionAt:
        earliestFollowingMotion
          ? earliestFollowingMotion.eventTimestamp
          : null,
      secondsSincePriorMotion,
      secondsUntilFollowingMotion
    },

    interpretationContext: {
      historyCount:
        numericOrNull(payload.historyCount),
      priorCount:
        numericOrNull(payload.priorCount),
      historyCapacity:
        numericOrNull(payload.historyCapacity),
      historyCapacityRatio:
        numericOrNull(payload.historyCapacityRatio),
      historyMaturityStage:
        nullableText(payload.historyMaturityStage),
      nearestRelativeDelta:
        numericOrNull(payload.nearestRelativeDelta),
      secondNearestRelativeDelta:
        numericOrNull(payload.secondNearestRelativeDelta),
      historyMeanRelativeDelta:
        numericOrNull(payload.historyMeanRelativeDelta),
      historyRange:
        numericOrNull(payload.historyRange),
      nearestVsSecondRatio:
        numericOrNull(payload.nearestVsSecondRatio),
      nearestVsHistoryRatio:
        numericOrNull(payload.nearestVsHistoryRatio),
      historySpreadVsMeanRatio:
        numericOrNull(payload.historySpreadVsMeanRatio),
      similarityObservation:
        nullableText(payload.similarityObservation),
      distinctivenessObservation:
        nullableText(payload.distinctivenessObservation),
      evidenceStabilityObservation:
        nullableText(payload.evidenceStabilityObservation)
    },

    residentActivityContext: {
      historicalDayCount: dailyRows.length,
      dailyActivityRows: dailyRows,
      suppliedMotionEventCount: motionRows.length,
      sameRoomMotionEventCount: sameRoomMotionCount,
      motionEvents: motionRows
    },

    dataAvailability: {
      residentActivityDailyAvailable:
        dailyRows.length > 0,
      motionChronologyAvailable:
        motionRows.length > 0,
      priorMotionAvailable:
        Boolean(latestPriorMotion),
      followingMotionAvailable:
        Boolean(earliestFollowingMotion),
      authoritativeRoomAvailable:
        Boolean(authoritativeRoom)
    },

    provenance: {
      interpretationEvidenceEventId:
        String(interpretation.evidence_event_id),
      interpretationTimestamp:
        new Date(
          interpretation.interpreted_at
        ).toISOString(),
      activityContextSource:
        'resident_activity_daily',
      motionChronologySource:
        'motion_events'
    },

    operationalClassification: null,
    alertLevel: null,
    monitoringAction: null,
    interventionRecommendation: null
  };
}

module.exports = {
  HUMAN_PRESENCE_DECISION_READINESS_VERSION,
  REQUIRED_PARENT_PERSISTENCE_VERSION,
  REQUIRED_PARENT_ENGINE_VERSION,
  buildHumanPresenceDecisionReadinessV1
};
