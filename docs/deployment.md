# Deployment

The bridge should run close to OpenClaw and should expose only the Shortcut webhook route through HTTPS.

## Minimal deployment

```bash
npm ci
npm run build
cp examples/env.example .env
```

Edit `.env`, then start:

```bash
node dist/src/index.js
```

## macOS launchd note

LaunchAgents often start with a minimal `PATH`. If `OPENCLAW_CLI_BIN` points at an OpenClaw shim that uses `/usr/bin/env node`, include Homebrew in the service environment:

```text
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

## Reverse proxy

Expose:

```text
POST /shortcuts/message
POST /shortcuts/share
POST /shortcuts/share-file
POST /watch/voice
GET /healthz
```

Do not expose queue files, logs, OpenClaw admin routes, shell access, or local runtime dashboards.

For a Tailscale deployment, see [Tailscale Serve and Funnel](tailscale.md).

## Delivery modes

The default CLI delivery path queues Shortcut requests immediately and drains them through `openclaw agent` in the background. This gives Siri/Shortcuts a fast `202 Accepted` response even when the agent turn takes longer.

Set `OPENCLAW_CLI_DRAIN_TIMEOUT_MS` long enough for the assistant to reason and use tools. When the CLI timeout is reached, the bridge archives that queue record as failed instead of retrying it, because an interrupted agent run may already have affected the chat route or other tools.

For a Telegram chat experience, point `OPENCLAW_SESSION_KEY` at the OpenClaw
session that backs the Telegram conversation and ask OpenClaw to deliver the
assistant response back to Telegram:

```text
OPENCLAW_ADAPTER=cli
OPENCLAW_SESSION_KEY=agent:openclaw:telegram:default:direct:user
OPENCLAW_DELIVER_REPLY=true
OPENCLAW_REPLY_CHANNEL=telegram
OPENCLAW_REPLY_TO=telegram:1234567890
OPENCLAW_MESSAGE_STYLE=compact
VOICE_MESSAGE_PREFIX=Sent via voice message:
```

That mode does not send a Telegram message as the human user. It injects the
transcript into the OpenClaw session that backs the Telegram chat, then delivers
OpenClaw's response to the configured Telegram target.

## Share Sheet uploads

`POST /shortcuts/share` accepts multipart form data from an iOS/iPadOS share-sheet Shortcut. It can receive text, URLs, and a single uploaded file. `POST /shortcuts/share-file` accepts a raw file body for screenshots/images from Shortcuts `Request Body: File`. Keep `SHARE_MAX_UPLOAD_BYTES` bounded and store uploads outside public web roots.

For server-side Voice Memo transcription, enable:

```text
AUDIO_TRANSCRIBE_ENABLED=true
AUDIO_TRANSCRIBE_ENGINE=local_whisper
AUDIO_TRANSCRIBE_CLI_BIN=/opt/homebrew/bin/whisper
AUDIO_TRANSCRIBE_TIMEOUT_MS=25000
AUDIO_TRANSCRIBE_MODEL=small.en
AUDIO_TRANSCRIBE_LANGUAGE=en
AUDIO_TRANSCRIBE_PERSISTENT=true
AUDIO_TRANSCRIBE_PYTHON_BIN=/opt/homebrew/opt/openai-whisper/libexec/bin/python
AUDIO_TRANSCRIBE_DEVICE=mps
```

The default transcription command is:

```bash
openclaw infer audio transcribe --file <uploaded-audio> --json
```

## Native Apple Watch voice uploads

`POST /watch/voice` accepts multipart form data from the native watchOS app.
Use the same bearer token as the Shortcut routes.

Headers:

```text
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

Form fields:

- `audio`: required audio file field.
- `source`: optional; defaults to `watch_app`.
- `device_name`: optional device label, such as `Apple Watch`.
- `app_name`: optional app label.
- `captured_at`: optional ISO-compatible capture timestamp.
- `location_json`: optional JSON object with latitude, longitude, altitude,
  accuracy fields, and map URL.
- `latitude`, `longitude`, `altitude`, `horizontal_accuracy`,
  `vertical_accuracy`, `maps_url`: optional plain form fields when
  `location_json` is not used.

The endpoint queues immediately and returns `202 Accepted` when the upload is
valid. When `AUDIO_TRANSCRIBE_ENABLED=true`, audio is transcribed before the
event is queued so OpenClaw receives the transcript plus audio metadata. If
transcription is disabled, OpenClaw receives an attached audio item with the
stored file path and metadata.

Include `watch_app` in `ALLOWED_SOURCES` when using the native Watch app.

## Systemd example

```ini
[Unit]
Description=Claw Bridge
After=network-online.target

[Service]
WorkingDirectory=/opt/claw-bridge
EnvironmentFile=/opt/claw-bridge/.env
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=5
User=openclaw
Group=openclaw

[Install]
WantedBy=multi-user.target
```
