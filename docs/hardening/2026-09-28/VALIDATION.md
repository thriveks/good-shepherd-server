# Good Shepherd server.js — Enterprise Hardening Pass

Date: 2026-09-28

## Validation completed

- `node --check server.js`: PASS
- Mocked module-load smoke test: PASS
- Sensitive-read authorization static audit: PASS
- Unified patch dry-run against uploaded original: PASS
- Unified patch applied to a fresh copy and byte-compared with hardened server: PASS
- Diff whitespace check: PASS

## Major changes

- Added explicit authorization to sensitive legacy/global read endpoints.
- Reworked customer bootstrap event ownership to resolve through resident-owned sensors/cameras rather than resident display name.
- Prevented ambiguous same-name resident matching from silently mutating the first matching resident.
- Added HMAC/timestamp webhook verification while preserving the legacy shared-secret path for deployed compatibility.
- Made critical Monitoring Center case state transitions transactional and row-locked.
- Converted PBKDF2 password work to asynchronous crypto calls.
- Hardened firmware download proxy redirect destinations against SSRF-style arbitrary-host redirects.
- Added request IDs, security headers, bounded JSON body configuration, PostgreSQL pool controls, readiness/liveness endpoints, and graceful shutdown.
- Reduced first-sensor commissioning database polling pressure while preserving the existing synchronous API contract.
- Removed raw internal 500-level exception text from client responses in the reviewed routes.
- Stopped unconditional production startup insertion of the demo `Mary Thompson` device mapping; it now requires `SEED_DEMO_DEVICE_MAPPING=true`.
- Default node offline threshold is now 900 seconds when `NODE_OFFLINE_AFTER_SECONDS` is not explicitly configured.

## Not claimed as validated

This artifact was validated as a standalone uploaded server file. It has **not** been run against the full Good Shepherd repository, production PostgreSQL schema/data, Render environment, iOS client, ESP32 devices, MQTT broker, APNs, or live Monitoring Center. Deploy through the normal rollback-safe release path and run the existing integration/regression checks before closing the milestone.
