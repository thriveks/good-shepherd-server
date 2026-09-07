"use strict";

const VERSION =
  "human_presence_temporal_context_data_sufficiency_v1";

const PARENT_VERSION =
  "human_presence_episode_profile_temporal_context_analysis_v1";

/*
 * LOCKED EMPIRICAL CALIBRATION v1 DATA SUFFICIENCY STANDARD
 *
 * These are evidence-collection requirements only.
 * They are NOT behavioral, safety, medical, fall, alert,
 * anomaly, emergency, or risk thresholds.
 */
const MINIMUM_OBSERVATIONS = 30;
const MINIMUM_OBSERVATION_SPAN_HOURS = 48;
const MINIMUM_DISTINCT_CALENDAR_DAYS = 3;

function finiteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function validDate(value) {
  if (!value) return null;

  const d = new Date(value);

  return Number.isFinite(d.getTime())
    ? d
    : null;
}

function buildHumanPresenceTemporalContextDataSufficiencyV1({
  evidenceEventId,
  authoritativeResidentId,
  authoritativeRoomOrLocation,
  daypart,
  firstObservationAt,
  latestObservationAt,
  observationCount,
  distinctCalendarDays,
  contaminatedRows,
  duplicateCompositeKeyGroups
}) {
  if (!evidenceEventId) {
    throw new Error(
      "evidenceEventId required"
    );
  }

  if (
    !authoritativeResidentId ||
    !authoritativeRoomOrLocation ||
    !daypart
  ) {
    throw new Error(
      "resident, room, and daypart required"
    );
  }

  const first =
    validDate(firstObservationAt);

  const latest =
    validDate(latestObservationAt);

  if (!first || !latest) {
    throw new Error(
      "valid observation timestamps required"
    );
  }

  if (
    latest.getTime() <
    first.getTime()
  ) {
    throw new Error(
      "latest observation precedes first observation"
    );
  }

  const rows =
    finiteNumber(observationCount);

  const days =
    finiteNumber(distinctCalendarDays);

  const contaminated =
    finiteNumber(contaminatedRows);

  const duplicates =
    finiteNumber(
      duplicateCompositeKeyGroups
    );

  if (
    rows === null ||
    days === null ||
    contaminated === null ||
    duplicates === null
  ) {
    throw new Error(
      "finite sufficiency evidence required"
    );
  }

  const observationSpanHours =
    (
      latest.getTime() -
      first.getTime()
    ) / 3600000;

  const rowCountGate =
    rows >= MINIMUM_OBSERVATIONS;

  const spanGate =
    observationSpanHours >=
    MINIMUM_OBSERVATION_SPAN_HOURS;

  const calendarDayGate =
    days >=
    MINIMUM_DISTINCT_CALENDAR_DAYS;

  const contaminationGate =
    contaminated === 0;

  const duplicateGate =
    duplicates === 0;

  const passesDataSufficiencyGate =
    rowCountGate &&
    spanGate &&
    calendarDayGate &&
    contaminationGate &&
    duplicateGate;

  return {
    temporalContextDataSufficiencyVersion:
      VERSION,

    parentTemporalContextAnalysisVersion:
      PARENT_VERSION,

    evidenceEventId,

    observerOnly: true,
    descriptiveOnly: true,

    authoritativeResidentId,
    authoritativeRoomOrLocation,
    daypart,

    lockedStandard: {
      source:
        "human_presence_empirical_calibration_v1",

      minimumObservations:
        MINIMUM_OBSERVATIONS,

      minimumObservationSpanHours:
        MINIMUM_OBSERVATION_SPAN_HOURS,

      minimumDistinctCalendarDays:
        MINIMUM_DISTINCT_CALENDAR_DAYS,

      requiredOperationalContaminationRows:
        0,

      requiredDuplicateCompositeKeyGroups:
        0
    },

    evidence: {
      observationCount: rows,
      firstObservationAt:
        first.toISOString(),
      latestObservationAt:
        latest.toISOString(),
      observationSpanHours,
      distinctCalendarDays: days,
      contaminatedRows: contaminated,
      duplicateCompositeKeyGroups:
        duplicates
    },

    gates: {
      rowCountGate,
      spanGate,
      calendarDayGate,
      contaminationGate,
      duplicateGate
    },

    passesDataSufficiencyGate,

    empiricalCalibrationStatus:
      passesDataSufficiencyGate
        ? "CANDIDATE_INTERPRETATION_RULE_DEVELOPMENT_MAY_BEGIN"
        : "CONTINUE_NATURAL_COLLECTION",

    behavioralThresholdCreated: false,
    anomalyThresholdCreated: false,
    operationalClassification: null,
    alertLevel: null,
    monitoringAction: null,
    interventionRecommendation: null
  };
}

module.exports = {
  HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_VERSION:
    VERSION,

  HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_PARENT_VERSION:
    PARENT_VERSION,

  HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_MINIMUM_OBSERVATIONS:
    MINIMUM_OBSERVATIONS,

  HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_MINIMUM_OBSERVATION_SPAN_HOURS:
    MINIMUM_OBSERVATION_SPAN_HOURS,

  HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_MINIMUM_DISTINCT_CALENDAR_DAYS:
    MINIMUM_DISTINCT_CALENDAR_DAYS,

  buildHumanPresenceTemporalContextDataSufficiencyV1
};
