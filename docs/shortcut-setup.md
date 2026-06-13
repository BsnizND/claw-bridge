# Apple Shortcut setup

You can either create the Shortcut manually on iPhone, or generate a signed `.shortcut` file with Cherri and import it.

Do not commit generated Shortcut artifacts. They contain the bearer token.

## Generate with Cherri

The repo includes a token-free Cherri template at `examples/tell-jay.cherri.template` and a helper script that generates a signed Shortcut locally.

On macOS:

```bash
export SIRI_BRIDGE_URL='https://your-public-bridge.example.com/shortcuts/message'
export SIRI_BRIDGE_TOKEN='your-long-random-token'
./scripts/build-shortcut.sh
```

The script writes:

```text
artifacts/shortcuts/Tell Jay.shortcut
artifacts/shortcuts/Tell Jay.cherri
```

`Tell Jay.cherri` is the rendered source and contains the bearer token. `Tell Jay.shortcut` is signed and ready to import. Both paths are ignored by git.

By default, the script downloads the Cherri release binary for the local Mac architecture. To use an existing Cherri binary:

```bash
CHERRI_BIN=/path/to/cherri ./scripts/build-shortcut.sh
```

Optional settings:

```bash
SHORTCUT_NAME='Tell Jay' \
SHORTCUT_SIGN_MODE='contacts' \
CHERRI_VERSION='v2.3.0' \
OUTPUT_DIR="$PWD/artifacts/shortcuts" \
./scripts/build-shortcut.sh
```

To generate the share-sheet Shortcut:

```bash
export SIRI_BRIDGE_URL='https://your-public-bridge.example.com/shortcuts/message'
export SIRI_BRIDGE_TOKEN='your-long-random-token'
SHORTCUT_NAME='Share with Jay' \
SOURCE_TEMPLATE="$PWD/examples/share-with-jay.cherri.template" \
./scripts/build-shortcut.sh
```

`SHORTCUT_SIGN_MODE=contacts` maps to Cherri's contacts signing mode. Use `SHORTCUT_SIGN_MODE=anyone` only if you are comfortable sharing the Shortcut more broadly. Apple notes that signing validates the Shortcut for sharing.

Send the generated `.shortcut` file to the iPhone through AirDrop, Mail, Messages, or iCloud Drive, then open it on the iPhone and approve the import. Apple requires the user import step.

The generated Shortcut:

1. Uses `Dictate Text`.
2. Gets the current location and extracts latitude, longitude, altitude, and an Apple Maps URL.
3. Checks that a message was captured.
4. Sends a JSON `POST` to `/shortcuts/message`.
5. Adds `Authorization: Bearer <SIRI_BRIDGE_TOKEN>`.
6. Speaks `Sent to Jay` after the request.

After import, enable `Show on Apple Watch` in the Shortcut details.

The first time the Shortcut runs on iPhone or Apple Watch, iOS may ask for Location permission. Choose `Always Allow` or the equivalent persistent permission if you want location included every time. If Location Services are unavailable, the generated Shortcut should fail on-device instead of sending an ungrounded message.

## Manual Shortcut actions

## Shortcut actions

Name the shortcut something Siri can hear reliably, for example `Tell Jay`.

1. Add `Dictate Text`.
2. Add `Set Variable`; name it `message`.
3. Add `If`: `message` has no value.
4. Inside that branch, add `Speak Text` with `No message captured`, then `Stop This Shortcut`.
5. Add `Dictionary` with:
   - `message`: `message`
   - `source`: `siri_watch`
   - `device_name`: `Apple Watch`
   - `shortcut_name`: `Tell Jay`
   - `captured_at`: current date formatted as ISO 8601
6. Add `Get Current Location`.
7. Add `Get Details of Location` for:
   - `Latitude`
   - `Longitude`
   - `Altitude`
8. Add `Get Maps Link` for the current location.
9. Add a nested `location` dictionary with:
   - `latitude`
   - `longitude`
   - `altitude`
   - `maps_url`
10. Add `Get Contents of URL`.
11. Set URL to `https://your-public-bridge.example.com/shortcuts/message`.
12. Set Method to `POST`.
13. Add headers:
   - `Authorization`: `Bearer your-long-random-token`
   - `Content-Type`: `application/json`
14. Set Request Body to `JSON` and pass the dictionary.
15. Parse the response dictionary and `Speak Text` using the `spoken` value.

## Voice memo workflows

Apple Voice Memos can show and copy transcripts on current iOS versions, and Shortcuts has a native `Transcribe Audio` action for audio files. The reliable automation boundary is the audio file, not the Voice Memos app's internal transcript UI.

The best bridge workflow is now the share sheet:

1. Import the generated `Share with Jay.shortcut`.
2. Open the Shortcut details and confirm `Show in Share Sheet` is enabled.
3. In Voice Memos, choose a recording, tap Share, and run `Share with Jay`.
4. The Shortcut uploads the memo as a multipart `file` field to `/shortcuts/share`.
5. If server-side transcription is enabled, the bridge transcribes the audio on the OpenClaw host and includes the transcript in the message to Jay.

Recommended options:

- Share-sheet workflow: in Voice Memos, share a recording to `Share with Jay`. The shortcut uploads the audio file, gets current location, and lets the bridge transcribe it server-side.
- Select-file workflow: run `Hey Siri, Send voice memo to Jay`, have the shortcut ask you to choose an audio file, run `Transcribe Audio`, then POST the transcript.
- "Most recent Voice Memo" workflow: only use this if your device exposes a Voice Memos action that can return the latest recording as a file. If it does, sort recordings by creation date, take the newest item, transcribe it, and POST it. If that action is not present, the share-sheet workflow is the safer public setup.

Voice memo JSON shape:

```json
{
  "message": "Sent via iPhone voice memo: <transcript>",
  "source": "siri_iphone",
  "device_name": "iPhone",
  "shortcut_name": "Send Voice Memo to Jay",
  "location": {
    "latitude": 33.6001,
    "longitude": -111.9002,
    "maps_url": "https://maps.apple.com/?ll=33.6001,-111.9002"
  },
  "voice_memo": {
    "transcript": "<transcript>",
    "filename": "New Recording.m4a",
    "duration_seconds": 74
  }
}
```

## Apple Watch

In the Shortcut details on iPhone, turn on `Show on Apple Watch`.

You can then run it from:

- Siri: `Hey Siri, Tell Jay`;
- the Shortcuts app on Apple Watch;
- a watch-face complication;
- the Action Button on Apple Watch Ultra models.

## Siri behavior

Siri generally does not pass arbitrary free-form text after the shortcut name as one clean utterance. The reliable interaction is:

1. Say `Hey Siri, Tell Jay`.
2. Wait for dictation.
3. Speak the message.
4. Let the shortcut POST the transcript.

## Sharing and device sync

Apple supports sharing shortcuts through iCloud links or as `.shortcut` files, and it supports syncing shortcuts across Apple devices when iCloud Sync is enabled. The practical install flow is:

1. Create or import the shortcut on iPhone or Mac.
2. Confirm the URL and bearer token during import/setup.
3. Enable `Show on Apple Watch`.
4. Let iCloud Sync copy it to the watch.

The macOS `shortcuts` command can run, view, and sign shortcut files, but it does not provide a supported command to generate and install a new multi-action shortcut directly onto an iPhone. If you create a shareable shortcut template, the bridge repo can host the signed `.shortcut` file and users can import it with Apple's normal approval flow.

## Brian's live route

Brian's current deployment URL is:

```text
https://snizserver.barred-komodo.ts.net:8443/shortcuts/message
```

The bearer token is intentionally not stored in this repository.
