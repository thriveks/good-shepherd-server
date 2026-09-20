# Good Shepherd Development Workflow

## Purpose

Maintain a reliable, meeting-ready record of meaningful Good Shepherd
development work without requiring a separate manual documentation process.

## Definition of Done

A Good Shepherd development task is not considered complete until:

1. The technical work has been validated.
2. Production or real-device behavior has been verified when applicable.
3. Temporary diagnostic work has been cleaned up when appropriate.
4. Any production-only database or server changes have been codified.
5. A milestone record has been created or updated in `docs/milestones/`.

## Milestone Documentation Rule

Create a milestone record whenever a meaningful feature, fix, investigation,
performance improvement, production deployment, or technical decision reaches
a verified endpoint.

Do not create a separate file for every small code change or command.

Milestone files should record:

- Date
- Status
- Objective
- What was completed
- Important technical changes
- Measurable improvements when available
- Production/device validation
- Relevant commits
- Remaining polish or follow-up work
- Final result

Recommended filename format:

`YYYY-MM-DD-short-description.md`

## Meeting Briefs

Before each Good Shepherd meeting, summarize milestone records created since
the previous meeting into `docs/meeting-briefs/`.

Meeting briefs should emphasize:

- Completed accomplishments
- Measurable improvements
- Problems solved
- Work currently in progress
- Remaining risks or blockers
- Next priorities

Technical details should be included only when they help explain the
significance of the work.

## iOS / Xcode Development Workflow

For Good Shepherd iOS work:

- Inspect before changing.
- Use evidence before implementation.
- Do not require partial Swift edits.
- Provide complete replacement Swift files.
- Do not directly modify the Xcode source tree programmatically.
- Validate replacement Swift files before delivery.
- Preserve known-good architecture.
- Maintain meaningful rollback checkpoints.
- Protect unrelated or untracked work.
- Change one system layer at a time when practical.
- Instrument difficult bugs instead of guessing.
- Measure performance before and after.
- Validate on the real device.
- Do not declare completion until the real workflow succeeds.

Default iOS completion sequence:

`inspect → diagnose → replace complete file → build → device test → verify → cleanup → milestone record → done`

## Server / Database / Firmware Workflow

Use:

`inspect → diagnose → targeted change → validate → deploy → production verify`

Prefer read-only diagnostics before changes.

Database optimizations proven directly in production must subsequently be
codified through the project's migration system.

Firmware should only be changed or reflashed when evidence shows that a
firmware change is necessary.

## Documentation Ownership

Documentation is part of task closure.

When a Good Shepherd task is declared complete, the milestone record should be
created before moving on to the next major development task.
