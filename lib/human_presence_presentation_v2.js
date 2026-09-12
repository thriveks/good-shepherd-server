"use strict";

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function humanizeCode(value) {
  const text = cleanText(value);
  if (!text) return "";
  return text
    .replace(/__/g, " — ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function learningProgress(location) {
  const observations = numberOrNull(location?.observations) || 0;
  const hoursObserved = numberOrNull(location?.hoursObserved) || 0;
  const daysObserved = numberOrNull(location?.daysObserved) || 0;

  const observationProgress = Math.min(1, observations / 30);
  const hourProgress = Math.min(1, hoursObserved / 48);
  const dayProgress = Math.min(1, daysObserved / 3);

  return Math.round(
    ((observationProgress + hourProgress + dayProgress) / 3) * 100
  );
}

function buildLearningSections(learningLocations) {
  const rows = Array.isArray(learningLocations) ? learningLocations : [];
  const sections = [];

  for (const location of rows) {
    const observations = numberOrNull(location?.observations) || 0;
    const hoursObserved = numberOrNull(location?.hoursObserved) || 0;
    const daysObserved = numberOrNull(location?.daysObserved) || 0;

    const ready =
      observations >= 30 &&
      hoursObserved >= 48 &&
      daysObserved >= 3;

    const place =
      cleanText(location?.roomOrLocation) ||
      "this monitored area";

    sections.push({
      id: `human-presence-learning-${place.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      type: "progress",
      title: "Routine Learning",
      headline: ready
        ? `${place}: baseline established`
        : `${place}: learning your routine`,
      detail: ready
        ? `Good Shepherd has enough history in ${place} to begin comparing current Human Presence activity with established patterns.`
        : `Good Shepherd has collected ${observations} observations across about ${Math.round(hoursObserved)} hours and ${daysObserved} calendar days in ${place}.`,
      state: ready ? "normal" : "learning",
      systemImage: ready ? "checkmark.circle.fill" : "brain.head.profile",
      progress: {
        value: learningProgress(location),
        label: ready ? "Baseline established" : "Learning progress",
        detail: `${learningProgress(location)}% of the minimum learning requirements completed.`
      },
      metrics: [
        {
          label: "Observations",
          value: String(observations),
          target: "30"
        },
        {
          label: "Hours observed",
          value: String(Math.round(hoursObserved)),
          target: "48"
        },
        {
          label: "Calendar days",
          value: String(daysObserved),
          target: "3"
        }
      ],
      sortOrder: 110
    });
  }

  return sections;
}

function buildRecentTimelineSection(presenceIntelligence) {
  const timeline = Array.isArray(presenceIntelligence?.recentPresenceTimeline)
    ? presenceIntelligence.recentPresenceTimeline
    : [];

  if (timeline.length === 0) return [];

  const items = timeline.slice(0, 8).map((event, index) => ({
    id: cleanText(event?.id) || `presence-timeline-${index}`,
    title: event?.active === true ? "Presence detected" : "Presence cleared",
    detail: cleanText(event?.room) || "Monitored area",
    timestamp: event?.timestamp || null,
    state: event?.active === true ? "informational" : "normal"
  }));

  return [
    {
      id: "human-presence-recent-history",
      type: "timeline",
      title: "Recent Human Presence",
      headline: "Recent presence activity",
      detail:
        "These are recent Human Presence changes observed by Good Shepherd.",
      state: "informational",
      systemImage: "clock.arrow.circlepath",
      timelineItems: items,
      sortOrder: 100
    }
  ];
}

function buildInterpretationSections(
  nonOperationalInterpretation,
  longitudinalValidation
) {
  const sections = [];

  const interpretation =
    nonOperationalInterpretation &&
    typeof nonOperationalInterpretation === "object"
      ? nonOperationalInterpretation.payload || nonOperationalInterpretation
      : null;

  if (interpretation) {
    const historicalPosition = interpretation?.historicalPosition || {};
    const trajectory = interpretation?.trajectoryContext || {};
    const recurrence = interpretation?.recurrenceContext || {};
    const temporal = interpretation?.temporalContext || {};

    const percentile = numberOrNull(historicalPosition?.percentileRank);

    let headline = "Good Shepherd is comparing this activity with prior patterns";
    let detail =
      "The current Human Presence pattern is being compared with previous observations.";

    if (historicalPosition?.available === true && percentile !== null) {
      const pct = Math.round(percentile * 100);
      headline = `Current pattern is around the ${pct}th percentile of prior observations`;

      detail =
        pct >= 75
          ? "This observation is toward the higher end of patterns previously seen, but it remains a descriptive comparison rather than an emergency or medical conclusion."
          : pct <= 25
          ? "This observation is toward the lower end of patterns previously seen, but it remains a descriptive comparison rather than an emergency or medical conclusion."
          : "This observation falls within the middle range of patterns previously seen.";
    }

    if (cleanText(trajectory?.combinedDirection)) {
      detail += ` Recent trajectory: ${humanizeCode(
        trajectory.combinedDirection
      ).toLowerCase()}.`;
    }

    if (recurrence?.available === true) {
      const comparableCount =
        numberOrNull(recurrence?.comparablePriorProfileCount);

      detail += comparableCount !== null
        ? ` Good Shepherd identified the nearest prior profile among ${comparableCount} comparison records.`
        : " Good Shepherd identified the nearest prior profile available for comparison.";
    }

    if (temporal?.available === true && cleanText(temporal?.daypart)) {
      detail += ` This comparison is being evaluated in the ${cleanText(
        temporal.daypart
      ).toLowerCase()}.`;
    }

    sections.push({
      id: "human-presence-interpretation",
      type: "insight",
      title: "What Good Shepherd Has Observed",
      headline,
      detail,
      state: "informational",
      systemImage: "sparkles",
      badge: "Descriptive observation",
      sortOrder: 120
    });

    const contributors = Array.isArray(
      interpretation?.contributorContext?.contributors
    )
      ? interpretation.contributorContext.contributors
      : [];

    if (contributors.length > 0) {
      sections.push({
        id: "human-presence-contributors",
        type: "metric_group",
        title: "What Changed Most",
        headline: "Factors contributing to this observation",
        detail:
          "These measurements contributed most strongly to the current Human Presence comparison.",
        state: "informational",
        systemImage: "chart.bar.xaxis",
        metrics: contributors.slice(0, 3).map((item) => ({
          label: humanizeCode(item?.dimension),
          value:
            numberOrNull(item?.currentVsHistoryMeanRelativeDelta) !== null
              ? `${Math.round(
                  numberOrNull(item.currentVsHistoryMeanRelativeDelta) * 100
                )}% from prior mean`
              : "Observed"
        })),
        sortOrder: 130
      });
    }
  }

  const longitudinal =
    longitudinalValidation && typeof longitudinalValidation === "object"
      ? longitudinalValidation.payload || longitudinalValidation
      : null;

  if (longitudinal) {
    const trajectory = longitudinal?.trajectorySequence || {};
    const historical = longitudinal?.historicalPositionSequence || {};
    const sequence = longitudinal?.sequenceContext || {};

    const pieces = [];

    if (numberOrNull(sequence?.priorObservationCount) !== null) {
      pieces.push(
        `Good Shepherd has ${numberOrNull(
          sequence.priorObservationCount
        )} prior observations available for comparison`
      );
    }

    if (trajectory?.sameAsPrevious === true) {
      pieces.push("the latest trajectory matches the previous observation");
    } else if (
      cleanText(trajectory?.current) &&
      cleanText(trajectory?.previous)
    ) {
      pieces.push("the latest trajectory differs from the previous observation");
    }

    if (historical?.sameAsPrevious === true) {
      pieces.push("its historical position is continuing");
    }

    if (pieces.length > 0) {
      sections.push({
        id: "human-presence-longitudinal",
        type: "observation",
        title: "Longer-Term Context",
        headline: "Good Shepherd is tracking how this pattern changes over time",
        detail: `${pieces.join(". ")}.`,
        state: "informational",
        systemImage: "waveform.path",
        badge: "Observation only",
        sortOrder: 140
      });
    }
  }

  return sections;
}

function buildFreshnessSection(presenceIntelligence) {
  if (!presenceIntelligence) return [];

  if (presenceIntelligence.presenceIsFresh === true) {
    return [
      {
        id: "human-presence-data-confidence",
        type: "status",
        title: "Current Data",
        headline: "Current presence information is up to date",
        detail:
          "The latest Human Presence event agrees with the sensor's current status information.",
        state: "normal",
        systemImage: "checkmark.shield.fill",
        sortOrder: 90
      }
    ];
  }

  const reason = cleanText(presenceIntelligence?.presenceFreshnessReason);

  if (!reason) return [];

  let detail =
    "Good Shepherd has Human Presence history, but the current room state cannot be confirmed yet.";

  if (reason === "no_retained_presence_edge") {
    detail =
      "The sensor is assigned, but Good Shepherd does not yet have a retained presence change to confirm the current room state.";
  } else if (reason === "missing_heartbeat") {
    detail =
      "Good Shepherd has recent presence history, but it is waiting for current sensor status information.";
  } else if (reason === "stale_heartbeat") {
    detail =
      "The latest sensor status is older than the current freshness window.";
  } else if (reason === "missing_presence_diagnostic") {
    detail =
      "The sensor is online, but its current Human Presence state was not included in the latest status update.";
  } else if (reason === "heartbeat_event_disagreement") {
    detail =
      "The recent presence event and the latest sensor status do not currently agree, so Good Shepherd is withholding a current-state conclusion.";
  }

  return [
    {
      id: "human-presence-data-confidence",
      type: "status",
      title: "Current Data",
      headline: "Current presence state is being verified",
      detail,
      state: "informational",
      systemImage: "arrow.triangle.2.circlepath",
      sortOrder: 90
    }
  ];
}

function buildHumanPresenceRichSectionsV2({
  presenceIntelligence,
  learningLocations,
  nonOperationalInterpretation,
  longitudinalValidation
}) {
  const sensorCount = numberOrNull(
    presenceIntelligence?.presenceSensorCount
  ) || 0;

  if (sensorCount <= 0) return [];

  return [
    ...buildFreshnessSection(presenceIntelligence),
    ...buildRecentTimelineSection(presenceIntelligence),
    ...buildLearningSections(learningLocations),
    ...buildInterpretationSections(
      nonOperationalInterpretation,
      longitudinalValidation
    )
  ];
}

module.exports = {
  buildHumanPresenceRichSectionsV2
};
