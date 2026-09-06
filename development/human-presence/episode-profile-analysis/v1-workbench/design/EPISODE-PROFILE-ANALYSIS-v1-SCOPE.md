# Good Shepherd Home Monitoring System
## Human Presence — Episode Profile Analysis v1

### Purpose

Episode Profile Analysis v1 is an observer-only server analytics increment
for empirical analysis of Human Presence Schema 1.1 episodeProfile evidence.

The firmware evidence contract is already validated and frozen.

This increment MUST NOT modify Human Presence firmware.

### Evidence Source

Production table:

candidate_history_evidence_events

Required evidence:

- evidence_schema_version = 1.1
- event_payload.episodeProfile exists
- episodeProfile contains the validated 12-dimensional physical profile

### Validated Episode Profile Dimensions

1. movingPctMean
2. stationaryPctMean
3. target2PctMean
4. target3PctMean
5. transitionsMean
6. movingDistanceWindowMedianMeanCm
7. movingDistanceWindowIqrMeanCm
8. stationaryDistanceWindowMedianMeanCm
9. stationaryDistanceWindowIqrMeanCm
10. detectionDistanceWindowMedianMeanCm
11. movingEnergyWindowMedianMean
12. stationaryEnergyWindowMedianMean

### Analysis Objective

Use repeated completed episodes to characterize descriptive physical behavior
within the authoritative resident/location context.

The analysis may calculate descriptive statistics such as:

- observation count
- temporal coverage
- per-dimension minimum
- per-dimension maximum
- per-dimension mean
- per-dimension median
- dispersion
- recent-versus-history descriptive comparison
- recurring physical profile similarity
- physical profile variation
- directional descriptive change
- within-location episode clustering or grouping when empirically justified

### Architectural Boundary

Firmware generates evidence.

Episode Profile Analysis interprets physical episode-profile evidence.

This layer is descriptive only.

Operational policy remains outside this layer.

### Explicitly Allowed

- Read persisted Schema 1.1 evidence
- Parse the 12 validated episodeProfile fields
- Aggregate repeated episode profiles
- Calculate descriptive statistics
- Compare recent profiles with historical profiles
- Persist observer-only analytical output
- Associate analysis with authoritative resident/location resolution
- Produce evidence suitable for later empirical calibration

### Explicitly Prohibited

Episode Profile Analysis v1 MUST NOT:

- change firmware
- change candidate-learning math
- change behavioral thresholds
- change trusted-baseline logic
- change promotion logic
- classify a fall
- classify an emergency
- make medical inferences
- create an alert level
- create a monitoring action
- create caregiver intervention policy
- create dispatch policy
- create operational classifications
- automatically alter resident baselines
- reinterpret the 12 fields as validated safety indicators

### Compatibility

Schema 1.0 evidence remains valid for the existing pipeline.

Episode Profile Analysis v1 operates only when Schema 1.1 episodeProfile
evidence is present.

Existing Interpretation v1 and Decision Readiness v1 contracts remain
unchanged.

### Initial Validation Subject

Sensor 9

Node:
esp32-a02dbcabc31c

Authoritative resident:
Good shepherd office

Authoritative location:
mmWave prototype

### Parent Firmware Checkpoint

Firmware:
v2.4.2 Episode Feature Evidence v1

Git checkpoint:
da1590b

Validated source SHA-256:
654c0f4a11379850022d6bec05b5a2643fbd95bb347d4820562716f70e839137

Validated application SHA-256:
6deb698b579f3c16a9af284ddef9d83d7846d0ca595c3adfbe313f47bab65d0a

Firmware status:
FROZEN

### Server Compatibility Dependency

Schema 1.1 compatibility commit:
693a0ba

### Development Rule

Before implementing production analytics code:

1. Audit existing Human Presence analytics architecture.
2. Audit available Schema 1.1 production evidence.
3. Define the minimum useful descriptive analysis contract.
4. Validate it against real production evidence.
5. Only then implement the production analytics layer.

No firmware flash or physical sensor test is required for this phase.
