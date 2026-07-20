# Changelog

All notable changes to Claw Bridge are documented here.

## Unreleased

### Changed

- Walkie voice delivery now uses OpenClaw-native `chat.send` completion events and `tts.speak`; the bridge no longer owns a separate agent-wait or ElevenLabs synthesis lifecycle.

## v0.1.10 - 2026-06-21

### Added

- Native Watch capture now supports Active/Golf context, location receipts, and bounded recording duration.
- Walkie-style voice replies support response polling, ElevenLabs audio rendering, APNs tap-to-play plumbing, and background audio playback.
- The iOS companion has a durable relay outbox for Watch uploads when the bridge is unreachable.
- Bridge health checks and ElevenLabs smoke-test commands are available for deployment verification.

### Changed

- Redesigned the Watch recording controls for a larger recording target, clearer Speak/Active controls, GPS readiness feedback, busy/error states, and fewer on-face status messages.
- Improved Watch send behavior so capture can proceed without GPS while preserving no-location reasons instead of silently dropping the message.
- Made Watch uploads feel immediate while preserving truthful accepted/queued/error states.
- Updated README positioning with a Codex-first quickstart prompt near the top.

### Fixed

- Fixed Watch location capture racing ahead of a fresh GPS fix.
- Rejected too-short Watch voice uploads to avoid accidental empty sends.
- Deduplicated Watch direct-upload and iPhone-relay retries by stable request id.
- Preserved queue records appended while a drain is running, preventing accepted messages from being erased.
- Added a cross-process queue-drain lock so launchd interval drains and manual maintenance drains cannot double-deliver the same message.
- Stabilized Watch walkie audio playback, interrupted playback recovery, and stale complication playback.

### Validation

- `npm test` - 60 passing tests.
- `npm run build`.
- `npm run lint`.
- Live snizserver bridge runtime health checked at `8b3edaf`.
