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
- `POST /shortcuts/share` for iOS/iPadOS share-sheet text, URLs, files, images, PDFs, and audio.
- Bearer-token authentication.
- Source allowlist for `siri_watch`, `siri_iphone`, and custom Shortcut clients.
- Message length limits and payload validation.
- Fast `202 Accepted` response for Siri/Shortcuts.
- Durable JSONL queue for pending work, with delivered/failed outcomes archived separately.
- Background delivery to OpenClaw through CLI or HTTP ingest.
- Optional OpenClaw reply delivery back to a messaging channel, such as an existing Telegram direct session.
- Optional structured location context, including latitude, longitude, altitude, accuracy, and a map URL.
- Optional voice memo metadata/transcript context for Shortcuts that can provide an audio transcript.
- Optional server-side audio transcription for shared Voice Memos/audio files.
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
  "captured_at": "2026-06-13T16:00:00.000Z",
  "location": {
    "latitude": 33.6001,
    "longitude": -111.9002,
    "altitude": 510,
    "horizontal_accuracy": 12,
    "maps_url": "https://maps.apple.com/?ll=33.6001,-111.9002"
  }
}
```

### `POST /shortcuts/share`

Headers:

```text
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

Form fields:

- `file`: optional shared file/audio/image/PDF.
- `shared_text`: optional text extracted from the share-sheet input.
- `shared_url`: optional shared URL.
- `shared_title`: optional shared title.
- `location_json`: optional JSON object with `latitude`, `longitude`, `altitude`, and `maps_url`.
- `latitude`, `longitude`, `altitude`, `maps_url`: optional plain form-field alternative to `location_json`.
- `source`: defaults to `ios_share_sheet`.

When `AUDIO_TRANSCRIBE_ENABLED=true`, audio uploads are transcribed server-side before the event is queued for OpenClaw.

For voice memo workflows, send a transcript as either the main `message` or as `voice_memo.transcript`:

```json
{
  "message": "Send Jay this voice memo transcript",
  "source": "siri_iphone",
  "voice_memo": {
    "transcript": "Full transcript text here",
    "filename": "New Recording.m4a",
    "duration_seconds": 74,
    "recorded_at": "2026-06-13T16:00:00.000Z"
  }
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
- `OPENCLAW_WORKDIR`: optional directory to use when spawning the OpenClaw CLI.
- `OPENCLAW_ADAPTER`: `cli` or `http`.
- `OPENCLAW_DELIVER_REPLY`: set to `true` when OpenClaw should deliver the assistant reply back to a channel.
- `OPENCLAW_REPLY_CHANNEL` / `OPENCLAW_REPLY_TO`: reply route for `OPENCLAW_DELIVER_REPLY`.
- `OPENCLAW_MESSAGE_STYLE`: `detailed` metadata payload or `compact` user-facing transcript.
- `SIRI_MESSAGE_PREFIX`: optional prefix for compact messages, for example `Sent via Apple Watch voice message:`.
- `QUEUE_PATH`: JSONL queue path.
- `QUEUE_ARCHIVE_PATH`: JSONL archive path for delivered/failed queue records. Defaults to `QUEUE_PATH + ".archive"`.
- `MAX_MESSAGE_CHARS`: maximum accepted dictated text length.
- `ALLOWED_SOURCES`: comma-separated source allowlist.
- `SHARE_UPLOAD_DIR`: directory where share-sheet uploads are stored.
- `SHARE_MAX_UPLOAD_BYTES`: maximum accepted upload size.
- `AUDIO_TRANSCRIBE_ENABLED`: when `true`, transcribe shared audio before delivery.
- `AUDIO_TRANSCRIBE_CLI_BIN`: CLI used for transcription; defaults to `openclaw`.
- `AUDIO_TRANSCRIBE_MODEL` / `AUDIO_TRANSCRIBE_LANGUAGE`: optional transcription hints.

## Shortcut setup

See [docs/shortcut-setup.md](docs/shortcut-setup.md).

## Deployment

See [docs/deployment.md](docs/deployment.md).

Brian's live `snizserver` deployment notes are in [docs/snizserver-deployment.md](docs/snizserver-deployment.md).

## Security

See [docs/security.md](docs/security.md).
