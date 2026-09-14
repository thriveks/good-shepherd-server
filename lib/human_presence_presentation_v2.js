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

function ordinalNumber(value) {
  const n = Math.abs(Math.trunc(Number(value)));
  const mod100 = n % 100;

  if (mod100 >= 11 && mod100 <= 13) {
    return `${n}th`;
  }

  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function contributorDisplayLabel(value) {
  const code = cleanText(value);

  const labels = {
    TransitionsMean:
      "Transition frequency (TransitionsMean)",
    StationaryDistanceWindowIqrMeanCm:
      "Stationary-distance variability (IQR, cm)",
    MovingDistanceWindowIqrMeanCm:
      "Moving-distance variability (IQR, cm)"
  };

  return labels[code] || humanizeCode(code);
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
      headline = `Current pattern is around the ${ordinalNumber(pct)} percentile of prior observations`;

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
      badge: "Interpreted",
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
          label: contributorDisplayLabel(item?.dimension),
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
      pieces.push("The latest trajectory matches the previous observation");
    } else if (
      cleanText(trajectory?.current) &&
      cleanText(trajectory?.previous)
    ) {
      pieces.push("The latest trajectory differs from the previous observation");
    }

    if (historical?.sameAsPrevious === true) {
      pieces.push("Its historical position is continuing");
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


function objectOrNull(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
      ? value
      : null;
}

function getPath(value, path) {
  let current = value;

  for (const key of path) {
    if (
      !current ||
      typeof current !== "object"
    ) {
      return null;
    }

    current = current[key];
  }

  return current ?? null;
}

function firstValue(value, paths) {
  for (const path of paths) {
    const result =
      getPath(value, path);

    if (
      result !== null &&
      result !== undefined &&
      result !== ""
    ) {
      return result;
    }
  }

  return null;
}

function embeddedPayload(
  record,
  candidateKeys
) {
  const row =
    objectOrNull(record?.rowPayload) ||
    {};

  for (const key of candidateKeys) {
    const candidate =
      objectOrNull(row[key]);

    if (candidate) {
      return candidate;
    }
  }

  return row;
}

function displayNumber(
  value,
  decimals = 2
) {
  const number =
    numberOrNull(value);

  if (number === null) {
    return null;
  }

  return Number(
    number.toFixed(decimals)
  ).toString();
}

function percentText(value) {
  const number =
    numberOrNull(value);

  if (number === null) {
    return null;
  }

  const normalized =
    number <= 1
      ? number * 100
      : number;

  return `${Math.round(normalized)}%`;
}

function buildEngineeringIntelligenceSections(
  engineeringBundles
) {
  const bundles =
    Array.isArray(engineeringBundles)
      ? engineeringBundles
      : [];

  const sections = [];

  for (
    let index = 0;
    index < bundles.length;
    index += 1
  ) {
    const bundle =
      bundles[index] || {};

    const nodeId =
      cleanText(bundle?.nodeId);

    const suffix =
      nodeId
        ? nodeId
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
        : String(index);

    const location =
      cleanText(bundle?.roomName) ||
      cleanText(bundle?.sourceName) ||
      "monitored area";

    const feature =
      embeddedPayload(
        bundle?.engineeringFeature,
        [
          "engineering_feature_payload",
          "engineeringFeaturePayload",
          "feature_payload"
        ]
      );

    const signature =
      embeddedPayload(
        bundle?.spatialSignature,
        [
          "spatial_signature_payload",
          "spatialSignaturePayload",
          "signature_payload"
        ]
      );

    const stateRow =
      objectOrNull(
        bundle?.spatialState?.rowPayload
      ) || {};

    const assignmentRow =
      objectOrNull(
        bundle?.spatialAssignment?.rowPayload
      ) || {};

    const assignment =
      embeddedPayload(
        bundle?.spatialAssignment,
        [
          "assignment_payload",
          "assignmentPayload"
        ]
      );

    const temporal =
      embeddedPayload(
        bundle?.spatialTemporal,
        [
          "temporal_learning_payload",
          "temporalLearningPayload"
        ]
      );

    const rhythm =
      embeddedPayload(
        bundle?.spatialRhythm,
        [
          "rhythm_learning_payload",
          "rhythmLearningPayload"
        ]
      );

    if (
      bundle?.engineeringFeature ||
      bundle?.spatialSignature
    ) {
      const movingGate =
        firstValue(
          feature,
          [
            ["moving", "dominantGate"],
            ["movingDominantGate"]
          ]
        );

      const stationaryGate =
        firstValue(
          feature,
          [
            ["stationary", "dominantGate"],
            ["stationaryDominantGate"]
          ]
        );

      const dominantChannel =
        firstValue(
          feature,
          [
            ["combined", "dominantChannel"],
            ["dominantChannel"]
          ]
        );

      const movingCentroid =
        firstValue(
          feature,
          [
            ["moving", "meanSampleCentroid"],
            ["moving", "weightedGateCentroid"],
            ["moving", "centroid"],
            ["movingCentroid"]
          ]
        );

      const stationaryCentroid =
        firstValue(
          feature,
          [
            ["stationary", "meanSampleCentroid"],
            ["stationary", "weightedGateCentroid"],
            ["stationary", "centroid"],
            ["stationaryCentroid"]
          ]
        );

      const metrics = [
        {
          label: "Signal model",
          value:
            "9 moving + 9 stationary gates"
        },
        {
          label: "Evidence",
          value:
            "High-resolution engineering data"
        }
      ];

      if (movingGate !== null) {
        metrics.push({
          label: "Moving dominant range gate",
          value: String(movingGate)
        });
      }

      if (stationaryGate !== null) {
        metrics.push({
          label: "Stationary dominant range gate",
          value: String(stationaryGate)
        });
      }

      if (dominantChannel !== null) {
        metrics.push({
          label: "Dominant channel",
          value: humanizeCode(
            String(dominantChannel)
          )
        });
      }

      const movingCentroidText =
        displayNumber(
          movingCentroid
        );

      if (movingCentroidText) {
        metrics.push({
          label: "Moving signal centroid (gate)",
          value: movingCentroidText
        });
      }

      const stationaryCentroidText =
        displayNumber(
          stationaryCentroid
        );

      if (stationaryCentroidText) {
        metrics.push({
          label: "Stationary signal centroid (gate)",
          value:
            stationaryCentroidText
        });
      }

      sections.push({
        id:
          `human-presence-engineering-signal-${suffix}`,
        type: "metric_group",
        title: "Observed Spatial Signal",
        headline:
          `${location}: high-resolution spatial signal captured`,
        detail:
          "Good Shepherd is reading separate moving and stationary LD2410 range-gate patterns. These are sensor measurements only; they do not identify posture, furniture, room zones, falls, or medical conditions.",
        state: "informational",
        systemImage:
          "waveform.path.ecg.rectangle",
        badge: "Observed",
        metrics,
        sortOrder: 150
      });
    }

    if (
      bundle?.spatialState ||
      bundle?.spatialAssignment
    ) {
      const stateId =
        cleanText(
          firstValue(
            assignmentRow,
            [
              ["state_id"]
            ]
          )
        ) ||
        cleanText(
          firstValue(
            assignment,
            [
              ["assignedStateId"],
              ["assignment", "matchedStateId"],
              ["assignment", "nearestStateId"]
            ]
          )
        ) ||
        cleanText(
          stateRow?.state_id
        );

      const observationCount =
        numberOrNull(
          stateRow?.observation_count
        );

      const matchDistance =
        firstValue(
          assignment,
          [
            ["assignment", "distance"]
          ]
        );

      const threshold =
        firstValue(
          assignment,
          [
            ["assignment", "distanceThreshold"]
          ]
        );

      const learnedStateCount =
        numberOrNull(
          temporal?.uniqueStateCount
        );

      const metrics = [];

      if (learnedStateCount !== null) {
        metrics.push({
          label: "Learned spatial patterns",
          value: String(learnedStateCount)
        });
      }

      if (stateId) {
        metrics.push({
          label: "Current pattern ID",
          value: stateId
        });
      }

      if (observationCount !== null) {
        metrics.push({
          label: "Observations matching current pattern",
          value:
            String(observationCount)
        });
      }

      const distanceText =
        displayNumber(
          matchDistance,
          4
        );

      if (distanceText) {
        metrics.push({
          label: "Latest match distance (lower = closer)",
          value: distanceText
        });
      }

      const thresholdText =
        displayNumber(
          threshold,
          2
        );

      if (thresholdText) {
        metrics.push({
          label: "New-pattern threshold",
          value: thresholdText
        });
      }

      metrics.push({
        label: "Meaning",
        value: "Anonymous signal state"
      });

      sections.push({
        id:
          `human-presence-spatial-state-${suffix}`,
        type: "metric_group",
        title: "Learned Spatial State",
        headline:
          learnedStateCount !== null &&
          learnedStateCount > 1
            ? `${learnedStateCount} repeatable spatial patterns learned`
            : stateId
            ? `${stateId} is the current anonymous signal pattern`
            : "An anonymous spatial pattern has been learned",
        detail:
          learnedStateCount !== null &&
          learnedStateCount > 1 &&
          stateId
            ? `Good Shepherd currently matches the sensor signal to ${stateId} while preserving ${learnedStateCount} distinct learned spatial patterns. These are anonymous sensor-pattern clusters, not labels for rooms, furniture, posture, sleep, falls, or medical conditions.`
            : "The state is a learned sensor-pattern cluster only. It is not a label for a room zone, chair, bed, sitting, lying, walking, sleeping, a fall, or a medical condition.",
        state: "learning",
        systemImage:
          "brain.head.profile",
        badge: "Learned",
        metrics,
        sortOrder: 160
      });
    }

    if (
      bundle?.spatialTemporal
    ) {
      const observations =
        numberOrNull(
          temporal?.observationCount
        );

      const uniqueStates =
        numberOrNull(
          temporal?.uniqueStateCount
        );

      const currentRun =
        numberOrNull(
          temporal?.currentContext
            ?.consecutiveObservationCount
        );

      const transitionPairs =
        numberOrNull(
          temporal?.transitions
            ?.transitionPairCount
        );

      const sameStatePairs =
        numberOrNull(
          temporal?.transitions
            ?.sameStateAdjacentPairCount
        );

      const ambiguousPairs =
        numberOrNull(
          temporal?.transitions
            ?.orderingAmbiguousPairCount
        );

      const metrics = [];

      if (observations !== null) {
        metrics.push({
          label: "Observations analyzed",
          value: String(observations)
        });
      }

      if (uniqueStates !== null) {
        metrics.push({
          label: "Learned spatial patterns",
          value: String(uniqueStates)
        });
      }

      if (currentRun !== null) {
        metrics.push({
          label: "Current pattern run",
          value:
            `${currentRun} observation${
              currentRun === 1 ? "" : "s"
            }`
        });
      }

      if (sameStatePairs !== null) {
        metrics.push({
          label: "Same-pattern continuations",
          value:
            String(sameStatePairs)
        });
      }

      if (transitionPairs !== null) {
        metrics.push({
          label: "Pattern transitions observed",
          value:
            String(transitionPairs)
        });
      }

      if (
        ambiguousPairs !== null &&
        ambiguousPairs > 0
      ) {
        metrics.push({
          label:
            "Ordering withheld",
          value:
            `${ambiguousPairs} equal-time pair${
              ambiguousPairs === 1
                ? ""
                : "s"
            }`
        });
      }

      sections.push({
        id:
          `human-presence-spatial-recurrence-${suffix}`,
        type: "metric_group",
        title:
          "Recurrence & Transitions",
        headline:
          transitionPairs > 0 &&
          uniqueStates !== null &&
          uniqueStates > 1
            ? `${transitionPairs} transitions observed between ${uniqueStates} learned spatial patterns`
            : transitionPairs > 0
            ? `${transitionPairs} spatial-pattern transitions observed`
            : "Good Shepherd is learning persistence in the current pattern",
        detail:
          transitionPairs > 0
            ? "Good Shepherd has now observed the signal move between learned anonymous spatial patterns in chronological evidence order. Transition counts reflect observed pattern changes only; they do not assign posture, activity, room-zone, fall, or medical meaning."
            : "The current evidence has remained in the same anonymous spatial pattern. No distinct transition is claimed until one is actually observed.",
        state: "learning",
        systemImage:
          "arrow.triangle.branch",
        badge: "Learned",
        metrics,
        sortOrder: 170
      });
    }

    if (
      bundle?.spatialRhythm
    ) {
      const observations =
        numberOrNull(
          rhythm?.observationCount
        );

      const uniqueStates =
        numberOrNull(
          rhythm?.uniqueStateCount
        );

      const uniqueDates =
        numberOrNull(
          rhythm?.uniqueUtcDates
        );

      const stateObservationCount =
        numberOrNull(
          rhythm?.currentRecurrence
            ?.stateObservationCount
        );

      const stateDates =
        numberOrNull(
          rhythm?.currentRecurrence
            ?.stateUniqueUtcDates
        );

      const currentHourShare =
        percentText(
          rhythm?.currentRecurrence
            ?.shareOfStateObservationsAtCurrentUtcHour
        );

      const metrics = [];

      if (observations !== null) {
        metrics.push({
          label: "Rhythm observations",
          value: String(observations)
        });
      }

      if (uniqueStates !== null) {
        metrics.push({
          label: "Spatial patterns in rhythm model",
          value: String(uniqueStates)
        });
      }

      if (uniqueDates !== null) {
        metrics.push({
          label: "Evidence dates",
          value: String(uniqueDates)
        });
      }

      if (
        stateObservationCount !== null
      ) {
        metrics.push({
          label:
            "Current-state observations",
          value:
            String(
              stateObservationCount
            )
        });
      }

      if (stateDates !== null) {
        metrics.push({
          label:
            "Dates current state observed",
          value: String(stateDates)
        });
      }

      if (currentHourShare) {
        metrics.push({
          label:
            "Current time-bucket recurrence",
          value: currentHourShare
        });
      }

      sections.push({
        id:
          `human-presence-spatial-rhythm-${suffix}`,
        type: "metric_group",
        title: "Time Pattern Learning",
        headline:
          uniqueStates !== null && uniqueStates > 1
            ? `Good Shepherd is learning when ${uniqueStates} spatial patterns tend to recur`
            : "Good Shepherd is learning when this anonymous spatial pattern recurs",
        detail:
          uniqueDates !== null && uniqueDates <= 1
            ? "Time-pattern learning is active, but the current rhythm evidence spans only one UTC evidence date. The model remains descriptive and does not create routine-deviation alerts, posture labels, fall detection, medical conclusions, or operational alerts."
            : "This time-pattern layer is descriptive and resident-specific. It does not create routine-deviation alerts, operational alerts, posture labels, fall detection, or medical conclusions.",
        state: "learning",
        systemImage:
          "clock.badge.checkmark",
        badge: "Learned",
        metrics,
        sortOrder: 180
      });
    }
  }

  return sections;
}

function buildHumanPresenceRichSectionsV2({
  presenceIntelligence,
  learningLocations,
  nonOperationalInterpretation,
  longitudinalValidation,
  engineeringBundles = []
}) {
  const sensorCount = numberOrNull(
    presenceIntelligence?.presenceSensorCount
  ) || 0;

  if (sensorCount <= 0) return [];

  return [
    ...buildFreshnessSection(presenceIntelligence),
    ...buildRecentTimelineSection(presenceIntelligence),
    ...buildLearningSections(learningLocations),
    ...buildEngineeringIntelligenceSections(
      engineeringBundles
    ),
    ...buildInterpretationSections(
      nonOperationalInterpretation,
      longitudinalValidation
    )
  ];
}

module.exports = {
  buildHumanPresenceRichSectionsV2
};
