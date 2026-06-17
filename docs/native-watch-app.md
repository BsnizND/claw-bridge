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

- `OpenClawCompanion`: iOS companion target. The installed app is named `Claw Bridge`.
- `OpenClawWatchApp`: watchOS target. The installed Watch app is named `Claw Bridge`.

## Local setup

1. Open `apps/OpenClawWatch/OpenClawWatch.xcodeproj` in Xcode.
2. Select a Development Team for both app targets.
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
```

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
`SIRI_BRIDGE_TOKEN` on the bridge.

### The app sends without location

Check Location permission on the Watch. Approximate or denied location is a
valid degraded state; the app should not fake coordinates.

### OpenClaw does not answer in chat

Check bridge logs, queue status, and OpenClaw delivery settings. For chat
responses, `OPENCLAW_DELIVER_REPLY`, `OPENCLAW_REPLY_CHANNEL`, and
`OPENCLAW_REPLY_TO` must match your deployment.
