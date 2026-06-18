# Native Apple Watch App

The native Watch app is the reliable wrist-capture lane for users whose Apple
Watch does not consistently run voice Shortcuts. It does not replace the iOS
Shortcuts/share-sheet lane. It adds a push-to-talk Watch interface that uploads
audio and optional location to the bridge, then lets OpenClaw reply through the
configured chat channel.

It also includes an optional Walkie mode. In Walkie mode the Watch or iPhone
still sends through the same bridge/OpenClaw path, but asks the bridge to return
the assistant reply as ElevenLabs-rendered audio. The bridge must still deliver
the text reply through the configured chat route; the app response is an
additional playback surface, not a replacement for the chat thread.

## What it does

1. Open the Watch app.
2. Tap the microphone button.
3. Speak.
4. Tap again to send.
5. The app uploads the audio to `POST /watch/voice`.
6. The bridge transcribes when server-side transcription is enabled.
7. OpenClaw responds through the configured delivery route.
8. In Walkie mode, the app waits for the bridge response job and plays the
   generated reply audio when it is ready.

The Watch app is intentionally not a chat UI. It is a capture control plus a
short-lived reply player.

## Watch face complication

The watchOS app includes a WidgetKit complication named `Record Message`.
Add it to a watch face to open Claw Bridge directly into recording. The
complication uses the deep link `clawbridge://record`; when the Watch app
receives that URL, it starts the same push-to-talk recording flow as tapping the
microphone button in the app.

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

- `OpenClawCompanion`: iOS companion target. The installed app is named `Claw Bridge`.
- `OpenClawWatchApp`: watchOS target. The installed Watch app is named `Claw Bridge`.
- `ClawBridgeComplicationExtension`: watchOS WidgetKit complication target.

## Local setup

1. Open `apps/OpenClawWatch/OpenClawWatch.xcodeproj` in Xcode.
2. Select a Development Team for both app targets, or create the ignored local
   signing config described below.
3. Connect or pair the iPhone and Apple Watch.
4. Enable Developer Mode and trust prompts if Xcode asks.
5. Run `OpenClawCompanion` on the iPhone. Xcode should install `Claw Bridge` on
   the phone and the paired Watch.
6. Enter the bridge base URL and bearer token in the companion app.

Use the bridge base URL, not the endpoint URL. For example:

```text
https://your-node.your-tailnet.ts.net
```

The app appends `/watch/voice` internally.

## Optional local signing config

If you prefer not to set the team manually in Xcode each time, create an ignored
local signing file:

```bash
cp apps/OpenClawWatch/Config/Signing.local.example.xcconfig \
  apps/OpenClawWatch/Config/Signing.local.xcconfig
```

Then edit `Signing.local.xcconfig`:

```text
DEVELOPMENT_TEAM = ABCDE12345
CLAW_BRIDGE_BUNDLE_ID_PREFIX = com.example.yourname
```

The bundle ID prefix must be unique to your Apple Developer account. The public
project defaults to `com.example` so no private team or personal bundle IDs are
committed.

Regenerate the Xcode project after changing the local signing file:

```bash
xcodegen --spec apps/OpenClawWatch/project.yml --project apps/OpenClawWatch
```

`Signing.local.xcconfig` is ignored by git. Do not commit team identifiers to
the public repo.

## Optional private bridge defaults

Personal builds can prefill the companion and Watch apps with a private bridge
base URL and bearer token:

```bash
cp apps/OpenClawWatch/Config/Bridge.local.example.xcconfig \
  apps/OpenClawWatch/Config/Bridge.local.xcconfig
```

Then edit `Bridge.local.xcconfig`:

```text
CLAW_BRIDGE_DEFAULT_BASE_URL = https:/$()/your-public-bridge.example.com
CLAW_BRIDGE_DEFAULT_BEARER_TOKEN = replace-with-private-token
```

Use the bridge base URL, not `/watch/voice`; the app appends `/watch/voice`
internally. `Bridge.local.xcconfig` is ignored by git. Do not commit private
hostnames or tokens.

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

For Walkie voice replies, also configure:

```text
APP_RESPONSE_DIR=./data/app-responses
ELEVENLABS_API_KEY=replace-with-elevenlabs-api-key
ELEVENLABS_VOICE_ID=replace-with-elevenlabs-voice-id
```

The bridge fails closed if Walkie mode is requested and no final OpenClaw reply
text or ElevenLabs configuration is available.

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

Walkie mode metadata is included in the relay transfer, so a direct Watch
network failure should not silently downgrade a requested voice reply.

If both direct upload and relay fail, the Watch app shows an error and does not
claim success.

## Notifications

The iOS companion can request notification permission so the app is ready for a
tap-to-play notification flow. A real closed-app notification path still
requires APNs/device-token plumbing and device evidence; simulator foreground
polling is not proof that background notification delivery works.

## Private local branding

The public repo ships the Claw Bridge icon and a generic waveform fallback in
the Watch UI. Local builds can still add a private portrait or alternate app
icon without committing them:

```text
apps/OpenClawWatch/Sources/Watch/Resources/AssistantPortrait.jpg
apps/OpenClawWatch/Sources/Shared/PrivateAssets.xcassets/
```

`AssistantPortrait.*` and `PrivateAssets.xcassets` are ignored by git. If an
`AssistantPortrait.*` file is present at runtime, the Watch UI uses it;
otherwise it shows the generic waveform. Keep generated portrait or private icon
files out of commits.

## Troubleshooting

### Xcode says a development team is required

Open the project in Xcode, select each target, and choose a Development Team in
Signing & Capabilities. As an alternative, use the ignored
`apps/OpenClawWatch/Config/Signing.local.xcconfig` file described above. Do not
commit team-specific signing files to the public repo.

### The Watch app does not install

Confirm the Watch is paired to the iPhone, Developer Mode is enabled when
required, and Xcode can see both devices. Rebuild the `OpenClawCompanion` scheme
for the physical iPhone.

### Upload returns unauthorized

Re-enter the bearer token in the companion app and confirm it matches
`CLAW_BRIDGE_TOKEN` on the bridge.

### The app sends without location

Check Location permission on the Watch. Approximate or denied location is a
valid degraded state; the app should not fake coordinates.

### OpenClaw does not answer in chat

Check bridge logs, queue status, and OpenClaw delivery settings. For chat
responses, `OPENCLAW_DELIVER_REPLY`, `OPENCLAW_REPLY_CHANNEL`, and
`OPENCLAW_REPLY_TO` must match your deployment.
