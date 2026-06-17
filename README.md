# claw-bridge

Authenticated Apple capture bridge for sending Siri, Shortcuts, share-sheet, and Apple Watch voice input to OpenClaw.

![Claw Bridge lobster mascot looking at a watch with a voice waveform](docs/assets/claw-bridge-hero.png)

`claw-bridge` is the capture layer between Apple devices and a self-hosted
OpenClaw assistant. It accepts dictated messages from Siri/Shortcuts, rich
content from the iOS share sheet, and push-to-talk audio from a native watchOS
app, then queues the work for OpenClaw and lets the assistant reply in the chat
you already use, such as Telegram.

The phone or watch is just the capture device. The assistant thread stays the place where the work happens.

Claw Bridge gives OpenClaw three Apple-native capture lanes:

1. **Voice Shortcut:** dictate a thought from iPhone, AirPods, or Apple Watch and send it straight into your OpenClaw thread.
2. **Watch push-to-talk:** tap the Claw Bridge watchOS app or complication, record a message, and upload it with optional location context.
3. **Share sheet:** send a voice memo, link, tweet, photo, PDF, file, selected text, or webpage from iPhone or iPad and receive the response in your configured chat.

The bridge is assistant-agnostic. Configure the OpenClaw session and Telegram reply route for your own deployment.

This project is an independent integration. It is not affiliated with Apple, Telegram, or OpenClaw maintainers unless stated otherwise.

## What makes it different

- **Hands-free capture:** invoke Siri through AirPods, dictate the request, and let OpenClaw reply in the chat thread where the assistant already lives.
- **Apple Watch capture:** send quick thoughts, errands, reminders, and location-aware questions without taking out your phone.
- **Native Watch push-to-talk:** use the watchOS app and complication as a one-button wrist microphone for fast capture.
- **Share sheet capture:** send links, tweets, screenshots, photos, PDFs, files, selected text, webpages, and voice memos to OpenClaw from almost any iOS app.
- **One conversation loop:** Shortcuts stays quiet on success. The assistant response in Telegram or your configured channel is the confirmation.
- **Agent-buildable setup:** token-free Cherri templates and docs let Codex or another coding agent generate the local `.shortcut` files for you.

## Building Your Personal Context Layer

The share sheet turns this from a voice shortcut into a way to collect useful context as you move through the day. Pair this bridge with a second-brain system, LLM wiki, personal knowledge base, or OpenClaw memory pipeline, and the things you send can become reusable material for the assistant.

The loop becomes:

1. Notice something worth keeping.
2. Share it from the app you are already using.
3. Let OpenClaw respond now.
4. Let your memory layer keep it around for later.

Over time, the assistant has more of your actual context: the links you saved, the screenshots you sent, the notes you dictated, the places you asked about, and the projects you keep returning to. The base model is not changing. The context layer around it is.

## Features

- `POST /shortcuts/message` for Apple Shortcuts.
- `POST /shortcuts/share` for iOS/iPadOS share-sheet files, PDFs, audio, and Voice Memos as multipart form data.
- `POST /shortcuts/share-file` for screenshots/images as a raw Shortcuts `Request Body: File` upload.
- `POST /watch/voice` for native Apple Watch app audio uploads.
- Bearer-token authentication.
- Source allowlist for `siri_watch`, `siri_iphone`, and custom Shortcut clients.
- Message length limits and payload validation.
- Fast `202 Accepted` response for Siri/Shortcuts.
- Durable JSONL queue for pending work, with delivered/failed outcomes archived separately.
- Background delivery to OpenClaw through CLI or HTTP ingest.
- Optional OpenClaw reply delivery back to a messaging channel, such as an existing Telegram chat.
- Optional structured location context, including latitude, longitude, altitude, accuracy, and a map URL.
- Optional voice memo metadata/transcript context for Shortcuts that can provide an audio transcript.
- Optional server-side audio transcription for shared Voice Memos/audio files.
- Shortcut-friendly `spoken` response field for error notifications.

## Non-goals

- Replacing Siri, Apple Shortcuts, or OpenClaw.
- Public exposure of OpenClaw admin/runtime surfaces.
- Creating or changing OpenClaw worker-agent topology.
- One-shot Siri phrases like `Hey Siri, Talk to OpenClaw remember dog food`.

Voice capture uses a simple two-step flow: invoke the shortcut, then dictate.

## Quick start

```bash
npm install
cp examples/env.example .env
npm run build
npm start
```

For the native Watch app, see [Native Apple Watch App](docs/native-watch-app.md).

## Release artifacts

This repo releases the bridge server source/package, token-free Shortcut
templates, and the native Claw Bridge Watch/iPhone source project. It does not
publish pre-signed iOS or watchOS binaries. Apple device builds must be signed
locally with the user's Apple Developer team and unique bundle identifier prefix
through Xcode or Codex-driven Xcode commands. See
[Native Apple Watch App](docs/native-watch-app.md) and
[Shortcut Setup](docs/shortcut-setup.md).

Generate a token:

```bash
openssl rand -base64 32
```

Set that value as `CLAW_BRIDGE_TOKEN` in `.env` and in the Apple Shortcut `Authorization` header:

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
  "shortcut_name": "Talk to OpenClaw",
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

- `file`: optional shared file/audio/PDF.
- `shared_text`: optional text extracted from the share-sheet input.
- `shared_url`: optional shared URL.
- `shared_title`: optional shared title.
- `location_json`: optional JSON object with `latitude`, `longitude`, `altitude`, and `maps_url`.
- `latitude`, `longitude`, `altitude`, `maps_url`: optional plain form-field alternative to `location_json`.
- `source`: defaults to `ios_share_sheet`.

When `AUDIO_TRANSCRIBE_ENABLED=true`, audio uploads are transcribed server-side before the event is queued for OpenClaw.

### `POST /shortcuts/share-file`

Headers:

```text
Authorization: Bearer <token>
Content-Type: image/png
```

Body:

```text
<raw image bytes>
```

Query parameters:

- `source`: defaults to `ios_share_sheet`.
- `device_name`: optional device label.
- `shortcut_name`: optional Shortcut label.
- `latitude`, `longitude`, `altitude`: optional location fields.

The generated share-sheet Shortcut uses this endpoint for screenshots/images
with Shortcuts `Get Contents of URL` set to `Request Body: File`. The image is
not base64-encoded, resized, or compressed by the bridge. If iOS sends
`application/octet-stream`, the bridge sniffs common image signatures so the
assistant still receives the upload as an image.

### `POST /watch/voice`

Headers:

```text
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

Form fields:

- `audio`: required audio file.
- `source`: optional; defaults to `watch_app`.
- `device_name`: optional device label.
- `app_name`: optional app label.
- `captured_at`: optional ISO-compatible timestamp.
- `location_json`: optional JSON object with latitude, longitude, altitude,
  accuracy fields, and map URL.
- `latitude`, `longitude`, `altitude`, `horizontal_accuracy`,
  `vertical_accuracy`, `maps_url`: optional plain form fields.

This endpoint is for the native Watch app lane. It accepts the recording,
attaches location when available, optionally transcribes the audio server-side,
and queues the event for OpenClaw through the same delivery path as the
Shortcut routes.

For voice memo workflows, send a transcript as either the main `message` or as `voice_memo.transcript`:

```json
{
  "message": "Shared via iPhone voice memo: <transcript>",
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
  "spoken": "Sent to openclaw"
}
```

The generated Shortcuts are silent on success. They read `spoken` only when
the bridge returns an error, so a normal send is confirmed by the assistant's
reply in the destination channel instead of by Siri or an iOS notification.

## Configuration

See [examples/env.example](examples/env.example).

Important settings:

- `CLAW_BRIDGE_TOKEN`: long random shared secret used by the Shortcut.
- `OPENCLAW_ASSISTANT_ID`: assistant id to receive messages.
- `OPENCLAW_SESSION_KEY`: OpenClaw session key for CLI delivery.
- `OPENCLAW_WORKDIR`: optional directory to use when spawning the OpenClaw CLI.
- `OPENCLAW_ADAPTER`: `cli` or `http`.
- `OPENCLAW_DELIVER_REPLY`: set to `true` when OpenClaw should deliver the assistant reply back to a channel.
- `OPENCLAW_REPLY_CHANNEL` / `OPENCLAW_REPLY_TO`: reply route for `OPENCLAW_DELIVER_REPLY`.
- `OPENCLAW_MESSAGE_STYLE`: `detailed` metadata payload or `compact` user-facing transcript.
- `VOICE_MESSAGE_PREFIX`: optional prefix for compact voice messages, for example `Sent via voice message:`.
- `QUEUE_PATH`: JSONL queue path.
- `QUEUE_ARCHIVE_PATH`: JSONL archive path for delivered/failed queue records. Defaults to `QUEUE_PATH + ".archive"`.
- `MAX_MESSAGE_CHARS`: maximum accepted dictated text length.
- `ALLOWED_SOURCES`: comma-separated source allowlist.
- `SHARE_UPLOAD_DIR`: directory where share-sheet uploads are stored.
- `SHARE_MAX_UPLOAD_BYTES`: maximum accepted upload size.
- `AUDIO_TRANSCRIBE_ENABLED`: when `true`, transcribe shared audio before delivery.
- `AUDIO_TRANSCRIBE_CLI_BIN`: CLI used for transcription; defaults to `openclaw`.
- `AUDIO_TRANSCRIBE_MODEL` / `AUDIO_TRANSCRIBE_LANGUAGE`: optional transcription hints.

Legacy `SIRI_BRIDGE_TOKEN`, `SIRI_BRIDGE_URL`, and `SIRI_MESSAGE_PREFIX`
names are still accepted where they existed before, but new installs should use
the `CLAW_BRIDGE_*` and `VOICE_MESSAGE_PREFIX` names.

## Shortcut setup

See [docs/shortcut-setup.md](docs/shortcut-setup.md).

If you are using Codex or another agentic coding partner to generate the
Shortcut files for you, see [docs/agent-shortcut-build.md](docs/agent-shortcut-build.md).

## Deployment

See [docs/deployment.md](docs/deployment.md).

For Tailscale Serve or Funnel setup, see [docs/tailscale.md](docs/tailscale.md).

## Security

See [docs/security.md](docs/security.md).
