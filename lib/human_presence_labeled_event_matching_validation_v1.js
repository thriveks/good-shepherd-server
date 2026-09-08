"use strict";

const VERSION = "human_presence_labeled_event_matching_validation_v1";

function finiteDate(value, name) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return d;
}

function secondsBetween(later, earlier) {
  return (later.getTime() - earlier.getTime()) / 1000;
}

function normalizePoint(row) {
  if (!row || typeof row !== "object") {
    throw new Error("analytical event must be an object");
  }

  const evidenceReceivedAt = finiteDate(
    row.evidenceReceivedAt,
    "analytical event evidenceReceivedAt"
  );

  return {
    evidenceEventId: row.evidenceEventId ?? null,
    evidenceReceivedAt: evidenceReceivedAt.toISOString(),

    authoritativeResidentId:
      row.authoritativeResidentId ?? null,

    authoritativeRoomOrLocation:
      row.authoritativeRoomOrLocation ?? null,

    payload:
      row.payload === undefined ? null : row.payload
  };
}

function buildLabeledEventMatch({
  label,
  analyticalEvents = []
}) {
  if (!label || typeof label !== "object") {
    throw new Error("label is required");
  }

  const startedAt = finiteDate(label.startedAt, "label startedAt");
  const endedAt = finiteDate(label.endedAt, "label endedAt");

  if (endedAt < startedAt) {
    throw new Error("label endedAt cannot precede startedAt");
  }

  if (!label.labeledEventId) {
    throw new Error("label labeledEventId is required");
  }

  if (!label.eventType) {
    throw new Error("label eventType is required");
  }

  if (!label.residentId) {
    throw new Error("label residentId is required");
  }

  if (!label.roomOrLocation) {
    throw new Error("label roomOrLocation is required");
  }

  const sameAuthority = analyticalEvents
    .map(normalizePoint)
    .filter((point) =>
      point.authoritativeResidentId === label.residentId &&
      point.authoritativeRoomOrLocation === label.roomOrLocation
    )
    .sort((a, b) => {
      const ta = new Date(a.evidenceReceivedAt).getTime();
      const tb = new Date(b.evidenceReceivedAt).getTime();

      if (ta !== tb) return ta - tb;

      return String(a.evidenceEventId ?? "")
        .localeCompare(String(b.evidenceEventId ?? ""));
    });

  const inside = sameAuthority.filter((point) => {
    const t = new Date(point.evidenceReceivedAt);
    return t >= startedAt && t <= endedAt;
  });

  const before = sameAuthority.filter(
    (point) =>
      new Date(point.evidenceReceivedAt) < startedAt
  );

  const after = sameAuthority.filter(
    (point) =>
      new Date(point.evidenceReceivedAt) > endedAt
  );

  const nearestBefore =
    before.length > 0 ? before[before.length - 1] : null;

  const nearestAfter =
    after.length > 0 ? after[0] : null;

  const nearestToStart =
    sameAuthority.length === 0
      ? null
      : sameAuthority.reduce((best, point) => {
          const distance = Math.abs(
            secondsBetween(
              new Date(point.evidenceReceivedAt),
              startedAt
            )
          );

          if (!best || distance < best.distanceSeconds) {
            return {
              evidenceEventId: point.evidenceEventId,
              evidenceReceivedAt: point.evidenceReceivedAt,
              distanceSeconds: distance
            };
          }

          return best;
        }, null);

  const nearestToEnd =
    sameAuthority.length === 0
      ? null
      : sameAuthority.reduce((best, point) => {
          const distance = Math.abs(
            secondsBetween(
              new Date(point.evidenceReceivedAt),
              endedAt
            )
          );

          if (!best || distance < best.distanceSeconds) {
            return {
              evidenceEventId: point.evidenceEventId,
              evidenceReceivedAt: point.evidenceReceivedAt,
              distanceSeconds: distance
            };
          }

          return best;
        }, null);

  return {
    version: VERSION,

    observerOnly: true,
    descriptiveOnly: true,

    labeledEvent: {
      labeledEventId: label.labeledEventId,
      eventType: label.eventType,
      captureSource: label.captureSource ?? null,
      testSessionId: label.testSessionId ?? null,
      residentId: label.residentId,
      residentName: label.residentName ?? null,
      roomOrLocation: label.roomOrLocation,
      observerName: label.observerName ?? null,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs:
        label.durationMs ??
        endedAt.getTime() - startedAt.getTime()
    },

    analyticalContext: {
      authoritativeAnalyticalEventCount:
        sameAuthority.length,

      insideInterval: {
        count: inside.length,
        events: inside
      },

      nearestBefore: nearestBefore
        ? {
            ...nearestBefore,
            secondsBeforeLabelStart:
              secondsBetween(
                startedAt,
                new Date(nearestBefore.evidenceReceivedAt)
              )
          }
        : null,

      nearestAfter: nearestAfter
        ? {
            ...nearestAfter,
            secondsAfterLabelEnd:
              secondsBetween(
                new Date(nearestAfter.evidenceReceivedAt),
                endedAt
              )
          }
        : null,

      nearestToStart,
      nearestToEnd
    },

    matchThresholdSeconds: null,
    matchClassification: null,
    anomalyClassification: null,
    operationalClassification: null,
    riskClassification: null,
    severityClassification: null,
    fallInterpretation: null,
    emergencyInterpretation: null,
    medicalInterpretation: null,
    alertLevel: null,
    monitoringAction: null,
    caregiverRecommendation: null
  };
}

module.exports = {
  VERSION,
  buildLabeledEventMatch
};
