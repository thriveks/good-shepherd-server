"use strict";

function createAIBriefingService({ cleanText, normalizeInteger }) {
  function aiBriefingResidentPriorityScore(resident) {
    const followUpStatus = cleanText(resident.followUpStatus).toLowerCase();
    const actionLevel = cleanText(resident.actionLevel).toLowerCase();
    const aiLevel = cleanText(resident.aiLevel || resident.aiStatus).toLowerCase();

    let score = 0;

    if (followUpStatus === "due now") {
      score += 120;
    } else if (followUpStatus === "due again") {
      score += 110;
    } else if (
      followUpStatus === "not logged" &&
      !["normal", "observe", "learning"].includes(actionLevel)
    ) {
      score += 85;
    } else if (followUpStatus === "logged") {
      score += 20;
    }

    if (actionLevel === "immediate") {
      score += 100;
    } else if (actionLevel === "technical") {
      score += 80;
    } else if (actionLevel === "review") {
      score += 65;
    } else if (actionLevel === "watch") {
      score += 50;
    } else if (actionLevel === "setup") {
      score += 40;
    } else if (actionLevel === "observe") {
      score += 20;
    }

    if (aiLevel === "critical") {
      score += 90;
    } else if (aiLevel === "sensor issue") {
      score += 80;
    } else if (aiLevel === "warning") {
      score += 70;
    } else if (aiLevel === "watch") {
      score += 55;
    } else if (aiLevel === "setup needed") {
      score += 35;
    }

    score += Math.min(normalizeInteger(resident.recentCriticalOpenAlertCount, 0), 5) * 20;
    score += Math.min(normalizeInteger(resident.recentCautionOpenAlertCount, 0), 5) * 10;
    score += Math.min(normalizeInteger(resident.offlineSensorCount, 0), 5) * 8;

    return score;
  }

  function aiBriefingResidentSummary(resident) {
    const onlineSensorCount = normalizeInteger(resident.onlineSensorCount, 0);
    const offlineSensorCount = normalizeInteger(resident.offlineSensorCount, 0);

    if (normalizeInteger(resident.sensorCount, 0) === 0) {
      return "No ESP32 motion sensors assigned";
    }

    if (offlineSensorCount > 0) {
      return `${onlineSensorCount} online / ${offlineSensorCount} offline`;
    }

    return `${onlineSensorCount} online`;
  }

  function aiBriefingPriorityLevel(resident) {
    const followUpStatus = cleanText(resident.followUpStatus).toLowerCase();
    const actionLevel = cleanText(resident.actionLevel).toLowerCase();
    const aiLevel = cleanText(resident.aiLevel || resident.aiStatus).toLowerCase();

    if (followUpStatus === "due now" || followUpStatus === "due again" || actionLevel === "immediate" || aiLevel === "critical") {
      return "Immediate";
    }

    if (actionLevel === "technical" || aiLevel === "sensor issue") {
      return "Technical";
    }

    if (followUpStatus === "not logged" || actionLevel === "review" || aiLevel === "warning") {
      return "Review";
    }

    if (actionLevel === "watch" || aiLevel === "watch") {
      return "Watch";
    }

    if (actionLevel === "setup" || aiLevel === "setup needed") {
      return "Setup";
    }

    if (actionLevel === "learning" || aiLevel === "learning") {
      return "Learning";
    }

    return "Normal";
  }

  function aiBriefingPriorityItem(resident) {
    return {
      residentId: resident.residentId,
      residentName: resident.residentName,
      location: resident.location,
      priorityLevel: aiBriefingPriorityLevel(resident),
      aiStatus: resident.aiStatus,
      aiLevel: resident.aiLevel,
      aiExplanation: resident.aiExplanation,
      actionLevel: resident.actionLevel,
      actionTitle: resident.actionTitle,
      actionSummary: resident.actionSummary,
      followUpStatus: resident.followUpStatus,
      followUpExplanation: resident.followUpExplanation,
      followUpDueAt: resident.followUpDueAt,
      minutesUntilFollowUpDue: resident.minutesUntilFollowUpDue,
      sensorSummary: aiBriefingResidentSummary(resident),
      sensorCount: resident.sensorCount,
      onlineSensorCount: resident.onlineSensorCount,
      offlineSensorCount: resident.offlineSensorCount,
      motionCountToday: resident.motionCountToday,
      motionCountLastHour: resident.motionCountLastHour,
      lastMotionAt: resident.lastMotionAt,
      lastMotionRoom: resident.lastMotionRoom,
      lastMotionSourceName: resident.lastMotionSourceName,
      coverageStatus: resident.coverageStatus,
      patternStatus: resident.patternStatus,
      presenceStatus: resident.presenceStatus,
      aiConfidence: resident.aiConfidence,
      aiConfidenceScore: resident.aiConfidenceScore,
      lastActionAt: resident.lastActionAt,
      lastActionBy: resident.lastActionBy,
      lastActionStatus: resident.lastActionStatus
    };
  }

  function buildAIBriefingFromSummary(summary) {
    const residents = Array.isArray(summary?.residents) ? summary.residents : [];
    const nonNormalActionResidents = [];
    const followUpDueResidents = [];
    const unloggedFollowUpResidents = [];
    const technicalResidents = [];
    const setupResidents = [];
    const residentReviewResidents = [];
    const normalResidents = [];

    let offlineSensorCount = 0;
    let motionCountToday = 0;
    let motionCountLastHour = 0;
    let activePresenceCount = 0;

    for (const resident of residents) {
      const actionLevel = cleanText(resident.actionLevel).toLowerCase();
      const aiLevel = cleanText(resident.aiLevel).toLowerCase();
      const followUpStatus = cleanText(resident.followUpStatus).toLowerCase();
      const isNormalAction = ["normal", "observe", "learning"].includes(actionLevel);

      if (isNormalAction) {
        normalResidents.push(resident);
      } else {
        nonNormalActionResidents.push(resident);
      }

      if (followUpStatus === "due now" || followUpStatus === "due again") {
        followUpDueResidents.push(resident);
      }

      if (followUpStatus === "not logged" && !isNormalAction) {
        unloggedFollowUpResidents.push(resident);
      }

      if (actionLevel === "technical" || aiLevel === "sensor issue") {
        technicalResidents.push(resident);
      }

      if (actionLevel === "setup" || aiLevel === "setup needed") {
        setupResidents.push(resident);
      }

      if (aiLevel === "watch" || aiLevel === "warning" || aiLevel === "critical") {
        residentReviewResidents.push(resident);
      }

      offlineSensorCount += normalizeInteger(resident.offlineSensorCount, 0);
      motionCountToday += normalizeInteger(resident.motionCountToday, 0);
      motionCountLastHour += normalizeInteger(resident.motionCountLastHour, 0);
      activePresenceCount += resident.latestPresenceState === true ? 1 : 0;
    }

    const sortedPriorities = nonNormalActionResidents
      .slice()
      .sort((first, second) => {
        const firstScore = aiBriefingResidentPriorityScore(first);
        const secondScore = aiBriefingResidentPriorityScore(second);

        if (firstScore !== secondScore) {
          return secondScore - firstScore;
        }

        return cleanText(first.residentName).localeCompare(cleanText(second.residentName));
      });

    const topPriorities = sortedPriorities.slice(0, 12).map(aiBriefingPriorityItem);

    let headline = "All monitored residents are in normal AI monitoring.";
    let overallLevel = "Normal";

    if (followUpDueResidents.length > 0) {
      headline = `${followUpDueResidents.length} follow-up item(s) are due now or overdue.`;
      overallLevel = "Immediate";
    } else if (unloggedFollowUpResidents.length > 0) {
      headline = `${unloggedFollowUpResidents.length} AI action item(s) still need a logged follow-up.`;
      overallLevel = "Review";
    } else if (technicalResidents.length > 0) {
      headline = `${technicalResidents.length} resident(s) have sensor connectivity or technical issues.`;
      overallLevel = "Technical";
    } else if (residentReviewResidents.length > 0) {
      headline = `${residentReviewResidents.length} resident(s) need behavior review.`;
      overallLevel = "Review";
    } else if (setupResidents.length > 0) {
      headline = `${setupResidents.length} resident(s) still need ESP32 monitoring setup.`;
      overallLevel = "Setup";
    }

    const briefingItems = [];

    if (followUpDueResidents.length > 0) {
      briefingItems.push(`${followUpDueResidents.length} follow-up item(s) are due now or overdue.`);
    }

    if (unloggedFollowUpResidents.length > 0) {
      briefingItems.push(`${unloggedFollowUpResidents.length} non-normal recommendation(s) have not been logged yet.`);
    }

    if (technicalResidents.length > 0) {
      briefingItems.push(`${technicalResidents.length} resident(s) have sensor or node connectivity work to resolve.`);
    }

    if (setupResidents.length > 0) {
      briefingItems.push(`${setupResidents.length} resident(s) need sensor assignment before AI monitoring is complete.`);
    }

    if (normalResidents.length > 0) {
      briefingItems.push(`${normalResidents.length} resident(s) are currently in normal monitoring.`);
    }

    if (briefingItems.length === 0) {
      briefingItems.push("No immediate AI action items are currently visible.");
    }

    return {
      success: true,
      generatedAt: new Date().toISOString(),
      sourceGeneratedAt: summary.generatedAt,
      overallLevel,
      headline,
      briefingItems,
      counts: {
        residentCount: residents.length,
        normalCount: normalResidents.length,
        nonNormalActionCount: nonNormalActionResidents.length,
        followUpDueCount: followUpDueResidents.length,
        unloggedFollowUpCount: unloggedFollowUpResidents.length,
        technicalCount: technicalResidents.length,
        setupNeededCount: setupResidents.length,
        residentReviewCount: residentReviewResidents.length,
        offlineSensorCount,
        motionCountToday,
        motionCountLastHour,
        activePresenceCount
      },
      topPriorities,
      followUpDueResidents: followUpDueResidents.map(aiBriefingPriorityItem),
      unloggedFollowUpResidents: unloggedFollowUpResidents.map(aiBriefingPriorityItem),
      technicalResidents: technicalResidents.map(aiBriefingPriorityItem),
      setupResidents: setupResidents.map(aiBriefingPriorityItem)
    };
  }

  return {
    buildAIBriefingFromSummary
  };
}

module.exports = {
  createAIBriefingService
};
