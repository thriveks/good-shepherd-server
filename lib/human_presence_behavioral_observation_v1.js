"use strict";

const VERSION = "human_presence_behavioral_observation_v1";
const DECISION_VERSION = "human_presence_decision_readiness_v1";
const INTERPRETATION_VERSION = "human_presence_candidate_interpretation_v1";

function num(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ms(v) {
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

function stats(a) {
  const v = a.filter(Number.isFinite);
  if (!v.length) return null;
  const minimum = Math.min(...v);
  const maximum = Math.max(...v);
  return {
    sampleCount: v.length,
    mean: mean(v),
    median: median(v),
    minimum,
    maximum,
    range: maximum - minimum
  };
}

function direction(current, priorMean) {
  if (current === null || priorMean === null) return "insufficient_comparable_history";
  if (current > priorMean) return "above_prior_mean";
  if (current < priorMean) return "below_prior_mean";
  return "equal_to_prior_mean";
}

function path(obj, keys) {
  let v = obj;
  for (const key of keys) {
    if (v === null || v === undefined || !Object.prototype.hasOwnProperty.call(v, key)) return undefined;
    v = v[key];
  }
  return v;
}

const METRICS = [
  "nearestVsHistoryRatio",
  "historyMeanRelativeDelta",
  "historyMinRelativeDelta",
  "historyMaxRelativeDelta",
  "historyRange",
  "absoluteSeparation",
  "relativeSeparation",
  "nearestAdvantage",
  "relativeNearestAdvantage"
];

function validateCurrent(r) {
  if (!r || typeof r !== "object") throw new Error("current Decision Readiness row required");
  if (r.decision_readiness_version !== DECISION_VERSION) throw new Error("unsupported decision readiness version");
  if (r.interpretation_version !== INTERPRETATION_VERSION) throw new Error("unsupported interpretation version");
  if (!r.authoritative_sensor_id || !r.authoritative_resident_id) throw new Error("authoritative sensor/resident required");
  if (!r.authoritative_room_or_location) throw new Error("authoritative room/location required");
  if (r.authority_resolution_status !== "resolved_assigned_sensor") throw new Error("authority must resolve to assigned sensor");
  if (ms(r.decision_readiness_at) === null) throw new Error("valid decision_readiness_at required");
}

function buildBehavioralObservationV1(current, priorRows = [], observedAt = null) {
  validateCurrent(current);
  if (!Array.isArray(priorRows)) throw new Error("priorRows must be an array");

  const currentMs = ms(current.decision_readiness_at);
  const prior = priorRows.filter((r) =>
    r &&
    r.decision_readiness_version === DECISION_VERSION &&
    r.interpretation_version === INTERPRETATION_VERSION &&
    r.authoritative_resident_id === current.authoritative_resident_id &&
    r.authoritative_room_or_location === current.authoritative_room_or_location &&
    ms(r.decision_readiness_at) !== null &&
    ms(r.decision_readiness_at) < currentMs
  ).sort((a, b) => ms(a.decision_readiness_at) - ms(b.decision_readiness_at));

  const times = prior.map((r) => ms(r.decision_readiness_at));
  const intervals = [];
  for (let i = 1; i < times.length; i += 1) intervals.push((times[i] - times[i - 1]) / 1000);
  if (times.length) intervals.push((currentMs - times[times.length - 1]) / 1000);
  const cadenceStats = stats(intervals);

  const interpretationMetricSummaries = {};
  const validMetricSampleCounts = {};

  for (const name of METRICS) {
    const currentValue = num(path(current.decision_readiness_payload || {}, ["interpretationContext", name]));
    const values = prior.map((r) =>
      num(path(r.decision_readiness_payload || {}, ["interpretationContext", name]))
    ).filter((v) => v !== null);
    const s = stats(values);
    validMetricSampleCounts[name] = values.length;
    interpretationMetricSummaries[name] = {
      sampleCount: values.length,
      currentValue,
      priorMean: s ? s.mean : null,
      priorMedian: s ? s.median : null,
      priorMinimum: s ? s.minimum : null,
      priorMaximum: s ? s.maximum : null,
      priorRange: s ? s.range : null,
      currentMinusPriorMean: currentValue !== null && s ? currentValue - s.mean : null,
      currentMinusPriorMedian: currentValue !== null && s ? currentValue - s.median : null,
      directionVsPriorMean: direction(currentValue, s ? s.mean : null)
    };
  }

  const motionValues = prior.map((r) =>
    num(path(r.decision_readiness_payload || {}, ["chronology", "secondsSincePriorMotion"]))
  ).filter((v) => v !== null);
  const motionStats = stats(motionValues);

  const missingContextFields = [];
  const payload = current.decision_readiness_payload || {};
  if (path(payload, ["interpretationContext", "historyMaturityStage"]) == null) missingContextFields.push("interpretationContext.historyMaturityStage");
  if (path(payload, ["residentActivityContext", "historicalDayCount"]) == null) missingContextFields.push("residentActivityContext.historicalDayCount");
  if (path(payload, ["chronology", "secondsSincePriorMotion"]) == null) missingContextFields.push("chronology.secondsSincePriorMotion");

  return {
    behavioralObservationVersion: VERSION,
    descriptiveOnly: true,
    identity: {
      evidenceEventId: current.evidence_event_id,
      sensorId: current.authoritative_sensor_id,
      residentId: current.authoritative_resident_id,
      residentName: current.authoritative_resident_name || null,
      roomOrLocation: current.authoritative_room_or_location
    },
    provenance: {
      interpretationVersion: current.interpretation_version,
      decisionReadinessVersion: current.decision_readiness_version,
      assignmentAuthority: current.assignment_authority || null,
      authorityResolutionStatus: current.authority_resolution_status
    },
    temporalContext: {
      evidenceReceivedAt: current.evidence_received_at || null,
      interpretedAt: current.interpreted_at || null,
      decisionReadinessAt: current.decision_readiness_at,
      behavioralObservationAt: observedAt || current.decision_readiness_at
    },
    historyContext: {
      historyAvailable: prior.length > 0,
      observationCount: prior.length,
      observationSpanSeconds: prior.length ? (currentMs - times[0]) / 1000 : null,
      firstObservationAt: prior.length ? prior[0].decision_readiness_at : null,
      latestPriorObservationAt: prior.length ? prior[prior.length - 1].decision_readiness_at : null,
      secondsSincePriorHumanPresenceObservation: prior.length ? (currentMs - times[times.length - 1]) / 1000 : null
    },
    cadence: {
      interObservationIntervalCount: intervals.length,
      meanInterObservationSeconds: cadenceStats ? cadenceStats.mean : null,
      medianInterObservationSeconds: cadenceStats ? cadenceStats.median : null,
      minInterObservationSeconds: cadenceStats ? cadenceStats.minimum : null,
      maxInterObservationSeconds: cadenceStats ? cadenceStats.maximum : null
    },
    interpretationMetricSummaries,
    motionContextSummaries: {
      priorMotionContextSampleCount: motionValues.length,
      secondsSincePriorMotionMean: motionStats ? motionStats.mean : null,
      secondsSincePriorMotionMedian: motionStats ? motionStats.median : null,
      secondsSincePriorMotionMinimum: motionStats ? motionStats.minimum : null,
      secondsSincePriorMotionMaximum: motionStats ? motionStats.maximum : null
    },
    dataSufficiency: { validMetricSampleCounts, missingContextFields },
    operationalClassification: null,
    alertLevel: null,
    monitoringAction: null,
    interventionRecommendation: null
  };
}

module.exports = { VERSION, buildBehavioralObservationV1 };
