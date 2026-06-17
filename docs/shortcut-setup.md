# Apple Shortcut setup

You can either create the Shortcut manually on iPhone, or generate a signed `.shortcut` file with Cherri and import it.

Do not commit generated Shortcut artifacts. They contain the bearer token.

## Generate with Cherri

The repo includes token-free Cherri templates and a helper script that generates signed Shortcuts locally.

On macOS:

```bash
export CLAW_BRIDGE_URL='https://your-public-bridge.example.com/shortcuts/message'
export CLAW_BRIDGE_TOKEN='your-long-random-token'
./scripts/build-shortcut.sh
```

By default the script writes:

```text
artifacts/shortcuts/Talk to OpenClaw.shortcut
artifacts/shortcuts/Talk to OpenClaw.cherri
```

The rendered `.cherri` source contains the bearer token. The `.shortcut` file
is signed and ready to import. Both paths are ignored by git.

By default, the script downloads the Cherri release binary for the local Mac architecture. To use an existing Cherri binary:

```bash
CHERRI_BIN=/path/to/cherri ./scripts/build-shortcut.sh
```

Optional settings:

```bash
SHORTCUT_NAME='Talk to OpenClaw' \
SHORTCUT_SIGN_MODE='contacts' \
CHERRI_VERSION='v2.3.0' \
OUTPUT_DIR="$PWD/artifacts/shortcuts" \
./scripts/build-shortcut.sh
```

To generate the share-sheet Shortcut:

```bash
export CLAW_BRIDGE_URL='https://your-public-bridge.example.com/shortcuts/message'
export CLAW_BRIDGE_TOKEN='your-long-random-token'
SHORTCUT_NAME='Share with OpenClaw' \
SOURCE_TEMPLATE="$PWD/examples/share-with-openclaw.cherri.template" \
./scripts/build-shortcut.sh
```

`Share with OpenClaw` handles the common share-sheet paths separately. For
screenshots and images, it sends the image itself to `/shortcuts/share-file`
using Shortcuts `Get Contents of URL` with `Request Body` set to `File`. It does
not base64-encode, resize, or compress the image. Files, audio, PDFs, and Voice
Memos use multipart form data to `/shortcuts/share`. For links, tweets,
webpages, and plain text, it sends JSON to `/shortcuts/message` and does not
include a multipart `file` field. These separate paths avoid iOS trying to turn
webpages or social posts into uploads, while keeping binary payloads out of JSON.

`SHORTCUT_SIGN_MODE=contacts` maps to Cherri's contacts signing mode. Use `SHORTCUT_SIGN_MODE=anyone` only if you are comfortable sharing the Shortcut more broadly. Apple notes that signing validates the Shortcut for sharing.

Send the generated `.shortcut` file to the iPhone through AirDrop, Mail, Messages, or iCloud Drive, then open it on the iPhone and approve the import. Apple requires the user import step.

The generated Shortcut:

1. Uses `Dictate Text`.
2. Gets the current location and extracts latitude, longitude, altitude, and an Apple Maps URL.
3. Checks that a message was captured.
4. Sends a JSON `POST` to `/shortcuts/message`.
5. Adds `Authorization: Bearer <CLAW_BRIDGE_TOKEN>`.
6. Stays silent on success.
7. Shows a notification only when the bridge returns an error.

After import, enable `Show on Apple Watch` in the Shortcut details.

The first time the Shortcut runs on iPhone or Apple Watch, iOS may ask for Location permission. Choose `Always Allow` or the equivalent persistent permission if you want location included every time. If Location Services are unavailable, the generated Shortcut should fail on-device instead of sending an ungrounded message.

## Shortcut actions

Name the shortcut something Siri can hear reliably, for example `Talk to OpenClaw`.

1. Add `Dictate Text`.
2. Add `Set Variable`; name it `message`.
3. Add `If`: `message` has no value.
4. Inside that branch, add `Show Notification` with `No message captured`, then `Stop This Shortcut`.
5. Add `Dictionary` with:
   - `message`: `message`
   - `source`: `siri_watch`
   - `device_name`: `Apple Watch`
   - `shortcut_name`: `Talk to OpenClaw`
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
15. Parse the response dictionary. If `ok` is false, show a notification using
    the `spoken` value. If `ok` is true, do nothing and let OpenClaw's Telegram
    reply be the confirmation.

## Voice memo workflows

Apple Voice Memos can show and copy transcripts on current iOS versions, and Shortcuts has a native `Transcribe Audio` action for audio files. The reliable automation boundary is the audio file, not the Voice Memos app's internal transcript UI.

The best bridge workflow is now the share sheet:

1. Import the generated `Share with OpenClaw.shortcut`.
2. Open the Shortcut details and confirm `Show in Share Sheet` is enabled.
3. In Voice Memos, choose a recording, tap Share, and run `Share with OpenClaw`.
4. The Shortcut uploads the memo as a multipart `file` field to `/shortcuts/share`.
5. If server-side transcription is enabled, the bridge transcribes the audio on the OpenClaw host and includes the transcript in the message to OpenClaw.

Recommended options:

- Share-sheet workflow: in Voice Memos, share a recording to `Share with OpenClaw`. The shortcut uploads the audio file, gets current location, and lets the bridge transcribe it server-side.
- Link/text workflow: for tweets, webpages, URLs, and selected text, share to `Share with OpenClaw`. The shortcut sends a JSON message with current location and does not upload a file.
- Select-file workflow: run `Hey Siri, Send voice memo to OpenClaw`, have the shortcut ask you to choose an audio file, run `Transcribe Audio`, then POST the transcript.
- "Most recent Voice Memo" workflow: only use this if your device exposes a Voice Memos action that can return the latest recording as a file. If it does, sort recordings by creation date, take the newest item, transcribe it, and POST it. If that action is not present, the share-sheet workflow is the safer public setup.

Voice memo JSON shape:

```json
{
  "message": "Sent via iPhone voice memo: <transcript>",
  "source": "siri_iphone",
  "device_name": "iPhone",
  "shortcut_name": "Send Voice Memo to OpenClaw",
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

- Siri: `Hey Siri, Talk to OpenClaw`;
- the Shortcuts app on Apple Watch;
- a watch-face complication;
- the Action Button on Apple Watch Ultra models.

## Siri behavior

Siri generally does not pass arbitrary free-form text after the shortcut name as one clean utterance. The reliable interaction is:

1. Say `Hey Siri, Talk to OpenClaw`.
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
