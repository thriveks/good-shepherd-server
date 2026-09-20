# Customer Onboarding — Completed

**Date:** September 20, 2026
**Status:** COMPLETE

## Objective

Create a highly user-friendly first-customer setup workflow that allows a new
Good Shepherd customer to commission their first sensor and establish their
household without using the administrator BLE interface or administrator PIN.

## Completed

- Added guided first-customer onboarding workflow.
- Customer setup remains resident/customer-facing.
- Administrator BLE setup interface is not exposed.
- First sensor is commissioned and assigned during onboarding.
- Resident record is created as part of activation.
- Four-digit customer access PIN is generated and presented.
- Customer session is established automatically.
- Existing customer dashboard loads after activation.
- Existing add-sensor workflow remains intact.
- First-home setup only selects unassigned sensors.
- Redundant sensor setup prompt after first activation was eliminated.
- Initial transient "No Household Available" state was eliminated.

## BLE / Firmware Improvement

The production motion firmware already supported configuring the sensor without
restarting after BLE setup.

The first-home onboarding flow was changed to use:

`restartAfterSave = false`

This allows the ESP32 to save its configuration and connect to Wi-Fi
immediately instead of rebooting into the 60-second BLE startup window.

Existing administrative and add-sensor workflows continue using the existing
restart behavior.

No firmware modification was required.

## Activation Performance

Earlier first-home verification:

- Approximately 73 seconds from HTTP activation request to successful response.

Final first-home verification:

- Approximately 7 seconds from HTTP activation request to successful response.
- Activate button to successful PIN screen approximately 12 seconds.

This represented an approximately 87% reduction in first-sensor verification
time during measured development testing.

## Dashboard Bootstrap Performance

Investigation showed the customer bootstrap endpoint was spending most of its
time querying `webhook_events` by normalized resident name.

Measured before database optimization:

- Approximately 17 seconds for the resident event query.
- Customer bootstrap could reach the 20-second application timeout.

A production expression index was added:

`webhook_events_resident_norm_timestamp_idx`

The index supports:

`LOWER(TRIM(resident_name)), timestamp DESC`

Measured after optimization:

- Resident event lookup approximately 9 ms during diagnostic testing.
- Final customer bootstrap approximately 0.1 seconds.

## Server Changes

The first-sensor activation verification logic was corrected so that a stale,
nonmatching setup ID does not prematurely terminate verification.

Registration wait was extended to allow the newly commissioned ESP32 time to
report its current setup identity.

Commit:

`0c12d99 — Fix first-home sensor verification wait`

## Database Migration

The proven production database optimization was subsequently codified as a
versioned migration so future deployments and database rebuilds reproduce the
same index.

Commit:

`55c0380 — Codify customer bootstrap resident event index`

Production verification confirmed:

- Render deployed commit `55c0380`.
- Migration record exists in `schema_migrations`.
- `webhook_events_resident_norm_timestamp_idx` exists in production.

## iOS Cleanup

Temporary onboarding trace instrumentation used during diagnosis was removed
after successful end-to-end validation.

Final iOS behavior retains:

- Guided first-home onboarding.
- First-home `restartAfterSave = false`.
- Existing workflow compatibility.
- Unassigned-sensor guard.
- Dashboard initial-loading protection.
- Post-activation sensor welcome suppression.
- 120-second activation HTTP safety timeout.

## End-to-End Validation

Final physical-device validation confirmed:

- Sensor discovery works.
- BLE commissioning works.
- Wi-Fi configuration works.
- First-sensor server verification works.
- Resident creation works.
- PIN generation works.
- Customer authentication/session establishment works.
- Household loads correctly.
- Dashboard loads correctly.
- No transient "No Household Available" screen.
- No redundant sensor onboarding prompt.
- Production database migration is present and reproducible.

Final measured workflow from pressing **Activate My Home** to a functioning
customer dashboard was approximately 15 seconds.

## Result

New-customer onboarding is functionally complete.

## Future Polish

A nearby disconnected or unsuitable BLE sensor can briefly appear during
scanning before the correct fresh unassigned sensor is discovered.

This is nonblocking and may be improved later as a BLE scanning UX refinement.
