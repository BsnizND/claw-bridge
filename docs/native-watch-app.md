# Native Apple Watch App

The native Watch app is the reliable wrist-capture lane for users whose Apple
Watch does not consistently run voice Shortcuts. It does not replace the iOS
Shortcuts/share-sheet lane. It adds a push-to-talk Watch interface that uploads
audio and optional location to the bridge, then lets OpenClaw reply through the
configured chat channel.

## What it does

1. Open the Watch app.
2. Tap the microphone button.
3. Speak.
4. Tap again to send.
5. The app uploads the audio to `POST /watch/voice`.
6. The bridge transcribes when server-side transcription is enabled.
7. OpenClaw responds through the configured delivery route.

The Watch app is intentionally not a chat UI. It is a capture control.

## Project layout

```text
apps/OpenClawWatch/
  project.yml
  OpenClawWatch.xcodeproj
  Sources/
    Shared/
    iOS/
    Watch/
```

The Xcode project is generated with XcodeGen:

```bash
xcodegen --spec apps/OpenClawWatch/project.yml --project apps/OpenClawWatch
```

Schemes:

- `OpenClawCompanion`: iOS companion app.
- `OpenClawWatchApp`: watchOS app.

## Local setup

1. Open `apps/OpenClawWatch/OpenClawWatch.xcodeproj` in Xcode.
2. Select a Development Team for both app targets.
3. Connect or pair the iPhone and Apple Watch.
4. Enable Developer Mode and trust prompts if Xcode asks.
5. Run `OpenClawCompanion` on the iPhone. Xcode should install the Watch app on
   the paired Watch.
6. Enter the bridge base URL and bearer token in the companion app.

Use the bridge base URL, not the endpoint URL. For example:

```text
https://your-node.your-tailnet.ts.net
```

The app appends `/watch/voice` internally.

## Server configuration

Include `watch_app` in `ALLOWED_SOURCES`:

```text
ALLOWED_SOURCES=siri_watch,siri_iphone,shortcuts,ios_share_sheet,watch_app
```

If you want OpenClaw to receive a transcript instead of only audio metadata,
enable server-side transcription:

```text
AUDIO_TRANSCRIBE_ENABLED=true
AUDIO_TRANSCRIBE_CLI_BIN=openclaw
AUDIO_TRANSCRIBE_TIMEOUT_MS=300000
```

The bridge must be reachable from the Watch or from the iPhone companion relay.
For Tailscale deployments, expose only the bridge routes described in
[Tailscale setup](tailscale.md).

## Permissions

The Watch app asks for microphone access when recording starts. It asks for
location access only when recording starts and includes location only when a
valid location is available.

If location is denied, the app can still send audio. It should label the send as
missing location instead of pretending location was attached.

## iPhone relay fallback

The Watch app first tries to upload directly to the bridge. If direct upload
fails, it transfers the audio file and metadata to the iPhone companion through
WatchConnectivity. The companion then uploads to the same `/watch/voice`
contract using the bridge URL and token saved on the phone.

If both direct upload and relay fail, the Watch app shows an error and does not
claim success.

## Assistant portrait

The public repo ships a generic placeholder avatar. Local builds can add a
private portrait without committing it:

```text
apps/OpenClawWatch/Sources/Watch/Resources/AssistantPortrait.jpg
```

`AssistantPortrait.*` is ignored by git. The Watch UI uses a focus crop centered
around `x=0.50, y=0.25`, which works well for portrait images where the face is
higher than the square center.

## Troubleshooting

### Xcode says a development team is required

Open the project in Xcode, select each target, and choose a Development Team in
Signing & Capabilities. Do not commit team-specific signing files to the public
repo.

### The Watch app does not install

Confirm the Watch is paired to the iPhone, Developer Mode is enabled when
required, and Xcode can see both devices. Rebuild the `OpenClawCompanion` scheme
for the physical iPhone.

### Upload returns unauthorized

Re-enter the bearer token in the companion app and confirm it matches
`SIRI_BRIDGE_TOKEN` on the bridge.

### The app sends without location

Check Location permission on the Watch. Approximate or denied location is a
valid degraded state; the app should not fake coordinates.

### OpenClaw does not answer in chat

Check bridge logs, queue status, and OpenClaw delivery settings. For chat
responses, `OPENCLAW_DELIVER_REPLY`, `OPENCLAW_REPLY_CHANNEL`, and
`OPENCLAW_REPLY_TO` must match your deployment.
