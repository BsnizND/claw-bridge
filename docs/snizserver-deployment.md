# snizserver deployment notes

This is a sanitized reference for Brian's live deployment. It intentionally omits bearer tokens and other secrets.

## Runtime layout

- Durable checkout: `/Volumes/LaCie_6big/briansnyder/repos/openclaw-siri-bridge`
- Runtime env: `/Volumes/LaCie_6big/briansnyder/repos/openclaw-siri-bridge/.env.runtime`
- LaunchAgent: `/Users/briansnyder/Library/LaunchAgents/ai.openclaw.siri-bridge.plist`
- Launch helper: `/Users/briansnyder/Library/Application Support/openclaw-siri-bridge/launchd-run.mjs`
- Logs: `/Users/briansnyder/Library/Logs/openclaw-siri-bridge/`
- Local listen address: `127.0.0.1:18788`

The launch helper parses `.env.runtime` as key/value data and imports `dist/src/index.js`. It avoids shell-sourcing the env file because macOS launchd/zsh can treat sourced files on external volumes as executable content and fail with permission errors.

## Tailscale Funnel surface

Public HTTPS route:

```text
https://snizserver.barred-komodo.ts.net:8443/shortcuts/message
```

Expected Tailscale handler:

```text
/shortcuts/message -> http://127.0.0.1:18788/shortcuts/message
/shortcuts/share -> http://127.0.0.1:18788/shortcuts/share
```

The route is intentionally path-scoped. Do not expose the whole service root. These public probes should remain closed:

```text
https://snizserver.barred-komodo.ts.net:8443/
https://snizserver.barred-komodo.ts.net:8443/healthz
https://snizserver.barred-komodo.ts.net:8443/internal/announce
```

Unauthenticated `POST /shortcuts/message` should return `401`.

## Runtime env shape

Required live settings include:

```text
NODE_ENV=production
HOST=127.0.0.1
PORT=18788
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
SIRI_BRIDGE_TOKEN=<secret>
OPENCLAW_ADAPTER=cli
OPENCLAW_ASSISTANT_ID=jay
OPENCLAW_SESSION_KEY=agent:jay:telegram:default:direct:brian
OPENCLAW_CLI_BIN=/opt/homebrew/bin/openclaw
OPENCLAW_CLI_DRAIN_TIMEOUT_MS=120000
OPENCLAW_CLI_THINKING=minimal
OPENCLAW_DELIVER_REPLY=true
OPENCLAW_REPLY_CHANNEL=telegram
OPENCLAW_REPLY_TO=telegram:8380430855
OPENCLAW_MESSAGE_STYLE=compact
SIRI_MESSAGE_PREFIX=Sent via Apple Watch voice message:
OPENCLAW_WORKDIR=/Users/briansnyder/.openclaw/workspace-main
QUEUE_PATH=/Volumes/LaCie_6big/briansnyder/repos/openclaw-siri-bridge/data/siri-queue.jsonl
QUEUE_DRAIN_INTERVAL_MS=30000
QUEUE_MAX_ATTEMPTS=3
SHARE_UPLOAD_DIR=/Volumes/LaCie_6big/briansnyder/repos/openclaw-siri-bridge/data/uploads
SHARE_MAX_UPLOAD_BYTES=52428800
AUDIO_TRANSCRIBE_ENABLED=true
AUDIO_TRANSCRIBE_CLI_BIN=/opt/homebrew/bin/openclaw
AUDIO_TRANSCRIBE_TIMEOUT_MS=300000
AUDIO_TRANSCRIBE_MODEL=openai-whisper/whisper-1
AUDIO_TRANSCRIBE_LANGUAGE=en
```

Keep `.env.runtime` at mode `0600`.

## Verification commands

```bash
ssh snizserver 'curl -fsS http://127.0.0.1:18788/healthz'
ssh snizserver 'launchctl print gui/$(id -u)/ai.openclaw.siri-bridge | sed -n "1,100p"'
ssh snizserver 'tailscale funnel status'
ssh snizserver 'openclaw gateway health --json'
ssh snizserver 'openclaw tasks list --json --status running'
```

Public route checks:

```bash
curl -i https://snizserver.barred-komodo.ts.net:8443/
curl -i https://snizserver.barred-komodo.ts.net:8443/healthz
curl -i -X POST https://snizserver.barred-komodo.ts.net:8443/shortcuts/message \
  -H 'Content-Type: application/json' \
  -d '{"message":"no auth probe","source":"shortcuts"}'
```

Expected: root and health are Tailscale handler misses; unauthenticated Shortcut route returns `401`.

## Apple Shortcut

The iPhone/Watch shortcut should:

1. Dictate text.
2. Get current location.
3. Stop if no text was captured.
4. POST JSON to `/shortcuts/message`.
5. Send `Authorization: Bearer <SIRI_BRIDGE_TOKEN>`.
6. Speak the response field `spoken`.

Example body:

```json
{
  "message": "Dictated Text",
  "source": "siri_watch",
  "device_name": "Apple Watch",
  "shortcut_name": "Tell Jay",
  "location": {
    "latitude": 33.6001,
    "longitude": -111.9002,
    "maps_url": "https://maps.apple.com/?ll=33.6001,-111.9002"
  }
}
```

## Share with Jay Shortcut

The iPhone share-sheet shortcut should:

1. Receive `file`, `media`, `url`, `text`, `webpage`, `image`, or `pdf` input from the share sheet.
2. Get current location.
3. Send a multipart form `POST` to `/shortcuts/share`.
4. Include the shared input as form field `file` when it is a file/media item.
5. Include `shared_text`, `latitude`, `longitude`, `altitude`, and `maps_url`.
6. Send `Authorization: Bearer <SIRI_BRIDGE_TOKEN>`.
7. Speak `Shared with Jay`.

For Voice Memos, the memo recording should upload as the form file. The deployed bridge transcribes audio server-side with `openclaw infer audio transcribe --file <path> --json` before sending the transcript to Jay.

## Known deployment findings

- The initial service start failed when `.env.runtime` was shell-sourced from the LaCie checkout. The current Node launch helper is the fix.
- The first authenticated public smoke failed before the service `PATH` included Homebrew, because the OpenClaw shim uses `/usr/bin/env node`. The env now includes Homebrew in `PATH`.
- A later authenticated public smoke delivered successfully to Jay; Jay replied: `Received. No tasks or reminders created.`
- Tailscale Funnel only allows public listeners on `443`, `8443`, and `10000`. The live deployment uses `8443` because that listener is already public for the Alexa bridge; the Siri bridge is added as a separate path handler on the same listener.
- Brian's deployment uses the Telegram direct session key plus `OPENCLAW_DELIVER_REPLY=true`, so dictated messages enter Jay's Telegram continuity lane and Jay's response is delivered back to Brian in Telegram.
