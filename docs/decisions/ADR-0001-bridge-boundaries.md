# ADR-0001: Bridge boundaries

## Status

Accepted

## Context

Apple Shortcuts and Siri are good at capturing quick dictated text, especially from Apple Watch. OpenClaw is better suited to durable assistant handling, tool choice, memory, and follow-up work.

## Decision

`claw-bridge` is a narrow authenticated ingress bridge:

- it accepts JSON and file uploads from Apple Shortcuts and the iOS share sheet;
- it accepts native watchOS push-to-talk audio uploads;
- it validates and normalizes captured input;
- it queues immediately for a fast Siri/Shortcuts response;
- it drains to OpenClaw asynchronously through either CLI or HTTP ingest;
- it does not create or manage OpenClaw agents.

## Consequences

The public surface stays tiny and reusable. Deployments choose their own
OpenClaw assistant, session key, and reply channel through configuration.
