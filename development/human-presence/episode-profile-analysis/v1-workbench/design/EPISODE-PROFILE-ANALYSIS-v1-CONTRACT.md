# Good Shepherd Home Monitoring System
## Episode Profile Analysis v1 — Analytical Contract

VERSION
human_presence_episode_profile_analysis_v1

STATUS
Development contract

PURPOSE

Analyze repeated Schema 1.1 Human Presence episodeProfile evidence as
descriptive physical observations.

This layer is observer-only.

INPUT

A current persisted candidate_history_evidence_events event satisfying:

- evidence_schema_version = 1.1
- event_payload.episodeProfile exists
- all 12 required episodeProfile dimensions are finite numeric values
- authoritative assignment has resolved through the existing Human Presence
  interpretation pipeline

HISTORY COHORT

Historical comparison rows MUST:

- contain Schema 1.1 episodeProfile evidence
- resolve to the same authoritative resident
- resolve to the same authoritative room/location
- precede the current evidence event
- contain all 12 finite profile dimensions

Node identity alone MUST NOT define behavioral history.

The authoritative resident/location context defines the comparison cohort.

DIMENSIONS

1 movingPctMean
2 stationaryPctMean
3 target2PctMean
4 target3PctMean
5 transitionsMean
6 movingDistanceWindowMedianMeanCm
7 movingDistanceWindowIqrMeanCm
8 stationaryDistanceWindowMedianMeanCm
9 stationaryDistanceWindowIqrMeanCm
10 detectionDistanceWindowMedianMeanCm
11 movingEnergyWindowMedianMean
12 stationaryEnergyWindowMedianMean

PER-DIMENSION HISTORY OUTPUT

For each dimension:

- current
- historyCount
- historyMin
- historyMax
- historyMean
- historyMedian
- historyRange
- currentVsHistoryMeanRelativeDelta

RELATIVE DELTA

For current value C and historical reference H:

abs(C - H) / max(abs(C), abs(H), 0.00001)

This is descriptive normalization only.

It is NOT a probability, risk score, confidence score, or safety score.

PROFILE-LEVEL OUTPUT

- episodeProfileAnalysisVersion
- evidenceEventId
- evidenceSchemaVersion
- observerOnly = true
- dimensionCount = 12
- historyCount
- historyStartAt
- historyEndAt
- dimensions
- profileMeanRelativeDelta

profileMeanRelativeDelta is the arithmetic mean of the 12
currentVsHistoryMeanRelativeDelta values when historical comparison exists.

MINIMUM HISTORY

Analysis may persist immediately.

If historyCount = 0:

- current profile is preserved
- historical statistics are null
- profileMeanRelativeDelta is null

No artificial minimum sample count is required merely to preserve an
observer-only analytical row.

PERSISTENCE

Create a dedicated append/idempotent analytical table.

The analytical row MUST retain:

- evidence event identity
- analysis version
- authoritative sensor identity
- authoritative resident identity/name
- authoritative room/location
- authority resolution status
- analysis payload
- evidence received timestamp
- analysis timestamp

The unique identity MUST include evidence event identity and analysis version.

ARCHITECTURAL BOUNDARY

This layer describes physical episode-profile variation.

It MUST NOT produce:

- operationalClassification
- alertLevel
- monitoringAction
- fall classification
- emergency classification
- medical inference
- caregiver intervention
- dispatch recommendation
- risk threshold
- safety threshold
- automatic baseline modification
- firmware configuration

NO FIRMWARE CHANGE

Frozen firmware v2.4.2 remains untouched.

Parent firmware Git checkpoint:
da1590b

Validated firmware source SHA-256:
654c0f4a11379850022d6bec05b5a2643fbd95bb347d4820562716f70e839137

PRODUCTION VALIDATION SUBJECT

Node:
esp32-a02dbcabc31c

Resident:
Good shepherd office

Location:
mmWave prototype

Initial Schema 1.1 evidence audit:
16 episode profiles

Evidence audit SHA-256:
034fc1ec983808b798a802b298bbde2d2943289fc81c11fcf20b1c79b009e4cf

VALIDATION REQUIREMENTS

Before production deployment:

1. Pure analysis module passes deterministic fixtures.
2. Missing/invalid dimensions are rejected.
3. Zero-history behavior is deterministic.
4. Same resident/location history selection is verified.
5. Cross-resident history contamination is rejected.
6. Cross-location history contamination is rejected.
7. Existing Schema 1.0 pipeline remains unchanged.
8. Existing Interpretation v1 remains unchanged.
9. Existing Decision Readiness v1 remains unchanged.
10. Existing Behavioral Observation v1 remains unchanged.
11. Existing Behavioral Pattern Analysis v1 remains unchanged.
12. No operational fields are introduced.

PRODUCTION SUCCESS GATE

For a genuine Schema 1.1 event:

candidate_history_evidence_events
-> Interpretation v1
-> Decision Readiness v1
-> existing behavioral pipeline
-> Episode Profile Analysis v1

must persist successfully without changing existing operational behavior.

