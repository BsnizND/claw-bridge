# openclaw-siri-bridge

Authenticated Apple Shortcuts/Siri webhook bridge for sending dictated messages into OpenClaw.

The common use case is an Apple Watch shortcut:

1. Say `Hey Siri, Tell Jay`.
2. Dictate a quick message.
3. The Shortcut POSTs the transcript to this bridge.
4. The bridge queues the event and delivers it to OpenClaw in the background.

The bridge is assistant-agnostic. `jay` is only the default example assistant id.

## Features

- `POST /shortcuts/message` for Apple Shortcuts.
- Bearer-token authentication.
- Source allowlist for `siri_watch`, `siri_iphone`, and custom Shortcut clients.
- Message length limits and payload validation.
- Fast `202 Accepted` response for Siri/Shortcuts.
- Durable JSONL queue with delivered/failed status.
- Background delivery to OpenClaw through CLI or HTTP ingest.
- Shortcut-friendly `spoken` response field for confirmation.

## Non-goals

- Replacing Siri, Apple Shortcuts, or OpenClaw.
- Public exposure of OpenClaw admin/runtime surfaces.
- Creating or changing OpenClaw worker-agent topology.
- One-shot Siri phrases like `Hey Siri, Tell Jay remember dog food`.

For arbitrary text, Siri/Shortcuts is most reliable as a two-step interaction: invoke the shortcut, then dictate.

## Quick start

```bash
npm install
cp examples/env.example .env
npm run build
npm start
```

Generate a token:

```bash
openssl rand -base64 32
```

Set that value as `SIRI_BRIDGE_TOKEN` in `.env` and in the Apple Shortcut `Authorization` header:

```text
Authorization: Bearer <token>
```

## API

### `GET /healthz`

Returns:

```json
{ "ok": true }
```

### `POST /shortcuts/message`

Headers:

```text
Authorization: Bearer <token>
Content-Type: application/json
```

Body:

```json
{
  "message": "Remind me to send the draft tomorrow",
  "source": "siri_watch",
  "device_name": "Apple Watch",
  "shortcut_name": "Tell Jay",
  "captured_at": "2026-06-13T16:00:00.000Z"
}
```

Success:

```json
{
  "ok": true,
  "queued": true,
  "id": "request-id",
  "spoken": "Sent to jay"
}
```

## Configuration

See [examples/env.example](examples/env.example).

Important settings:

- `SIRI_BRIDGE_TOKEN`: long random shared secret used by the Shortcut.
- `OPENCLAW_ASSISTANT_ID`: assistant id to receive messages.
- `OPENCLAW_SESSION_KEY`: OpenClaw session key for CLI delivery.
- `OPENCLAW_ADAPTER`: `cli` or `http`.
- `QUEUE_PATH`: JSONL queue path.
- `MAX_MESSAGE_CHARS`: maximum accepted dictated text length.
- `ALLOWED_SOURCES`: comma-separated source allowlist.

## Shortcut setup

See [docs/shortcut-setup.md](docs/shortcut-setup.md).

## Deployment

See [docs/deployment.md](docs/deployment.md).

## Security

See [docs/security.md](docs/security.md).
