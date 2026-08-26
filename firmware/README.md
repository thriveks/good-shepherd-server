# Good Shepherd Firmware

This directory is the repository source of truth for Good Shepherd device firmware organization.

## Current Production Firmware

### Motion Sensor

Current verified production version:

`esp32-good-shepherd-v2.0.13-power-recovery`

Location:

`firmware/production/motion/v2.0.13-power-recovery/`

The production source stored here is a verified reference copy of the firmware currently used in the active Arduino development workflow.

## Device Families

Firmware is organized by physical device family:

- `motion`
- `human-presence`
- `thermal`
- `camera`

A device-family directory does not mean production firmware currently exists for that device type.

Future firmware should remain separated by device family rather than combining unrelated sensor platforms into one development directory.

## Directory Structure

### `production/`

Verified production firmware releases.

Production firmware should not be edited in place.

A new firmware revision should receive a new version directory.

### `devices/`

Development areas for individual hardware families.

### `releases/`

Future packaged firmware release artifacts and release metadata.

### `archive/`

Retired firmware references retained for historical or recovery purposes.

## Important

The Arduino IDE working directory is separate from this repository reference structure.

Organizing firmware in Git must not modify, relocate, compile, flash, or otherwise change an active Arduino sketch unless a firmware-development task specifically requires it.
