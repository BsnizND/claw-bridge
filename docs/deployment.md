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
GET /healthz
```

Do not expose queue files, logs, OpenClaw admin routes, shell access, or local runtime dashboards.

For a Tailscale deployment, see [Tailscale Serve and Funnel](tailscale.md).

## Delivery modes

The default CLI delivery path queues Shortcut requests immediately and drains them through `openclaw agent` in the background. This gives Siri/Shortcuts a fast `202 Accepted` response even when the agent turn takes longer.

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
SIRI_MESSAGE_PREFIX=Sent via Apple Watch voice message:
```

That mode does not send a Telegram message as the human user. It injects the
transcript into the OpenClaw session that backs the Telegram chat, then delivers
OpenClaw's response to the configured Telegram target.

## Share Sheet uploads

`POST /shortcuts/share` accepts multipart form data from an iOS/iPadOS share-sheet Shortcut. It can receive text, URLs, and a single uploaded file. Keep `SHARE_MAX_UPLOAD_BYTES` bounded and store uploads outside public web roots.

For server-side Voice Memo transcription, enable:

```text
AUDIO_TRANSCRIBE_ENABLED=true
AUDIO_TRANSCRIBE_CLI_BIN=openclaw
AUDIO_TRANSCRIBE_TIMEOUT_MS=300000
```

The default transcription command is:

```bash
openclaw infer audio transcribe --file <uploaded-audio> --json
```

## Systemd example

```ini
[Unit]
Description=OpenClaw Siri Bridge
After=network-online.target

[Service]
WorkingDirectory=/opt/openclaw-siri-bridge
EnvironmentFile=/opt/openclaw-siri-bridge/.env
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=5
User=openclaw
Group=openclaw

[Install]
WantedBy=multi-user.target
```
