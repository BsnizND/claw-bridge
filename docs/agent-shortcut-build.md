# Agent Shortcut Build Guide

This guide is for Codex or another agentic coding partner helping a user create
the two Apple Shortcuts for this bridge.

## Goal

Build two local `.shortcut` files from the token-free Cherri templates:

1. `Talk to OpenClaw.shortcut`: Siri dictation from iPhone or Apple Watch to OpenClaw.
2. `Share with OpenClaw.shortcut`: iOS/iPadOS share-sheet input to OpenClaw.

Do not commit generated `.shortcut` files or rendered `.cherri` files. They
contain the user's bearer token.

## Required Inputs

Ask the user for these values, or read them from their private deployment
environment if they explicitly authorize that:

- `SIRI_BRIDGE_URL`: public HTTPS URL ending in `/shortcuts/message`.
- `SIRI_BRIDGE_TOKEN`: bearer token for the bridge.
- Optional `OUTPUT_DIR`: where generated local artifacts should be written.
- Optional `CHERRI_BIN`: path to an already-installed Cherri binary.

Never print the full bearer token back to the user. Showing a short prefix or
suffix for confirmation is enough.

## Build Commands

From the repo root:

```bash
export SIRI_BRIDGE_URL='https://example.com/shortcuts/message'
export SIRI_BRIDGE_TOKEN='replace-with-private-token'
./scripts/build-shortcut.sh
```

Then build the share-sheet shortcut:

```bash
export SIRI_BRIDGE_URL='https://example.com/shortcuts/message'
export SIRI_BRIDGE_TOKEN='replace-with-private-token'
SHORTCUT_NAME='Share with OpenClaw' \
SOURCE_TEMPLATE="$PWD/examples/share-with-openclaw.cherri.template" \
./scripts/build-shortcut.sh
```

Expected outputs:

```text
artifacts/shortcuts/Talk to OpenClaw.shortcut
artifacts/shortcuts/Talk to OpenClaw.cherri
artifacts/shortcuts/Share with OpenClaw.shortcut
artifacts/shortcuts/Share with OpenClaw.cherri
```

Only the `.shortcut` files should be sent to the user's phone. The `.cherri`
files are useful for debugging but contain secrets.

## Behavior To Preserve

`Talk to OpenClaw` should:

- capture dictated text;
- get the current location;
- send JSON to `/shortcuts/message`;
- include `Authorization: Bearer <token>`;
- stay silent on success;
- show a notification only on error.

`Share with OpenClaw` should:

- appear in the iOS/iPadOS share sheet;
- upload screenshots/images to `/shortcuts/share-file` with `Request Body: File`;
- upload files, PDFs, audio, and Voice Memos to `/shortcuts/share` as multipart form data;
- send links, webpages, tweets, and selected text as JSON to `/shortcuts/message`;
- include current location;
- stay silent on success;
- show a notification only on error.

For screenshot/image uploads, inspect the compiled unsigned Shortcut before
handoff. The generated `.shortcut` file is signed, but the build script keeps an
unsigned plist next to it for inspection. In that plist, the image branch's
`Get Contents of URL` action pointing at `/shortcuts/share-file` must have:

- `WFHTTPBodyType` set to `File`;
- `WFRequestVariable` set to the `firstImage` Shortcuts variable;
- no `WFFormValues`;
- no `WFJSONValues`;
- an `Authorization` header.

Do not base64-encode images. Do not resize or compress them in the Shortcut.
The bridge accepts the image bytes directly.

For non-image file uploads, the Form request to `/shortcuts/share` should have
`WFHTTPBodyType` set to `Form`, no explicit `Content-Type` header, and a `file`
field whose value is only the Shortcuts variable token, not a text value with a
literal `$` prefix. A bad compiled value usually means the template used
`${variable}` instead of `{@variable}` inside the Form dictionary.

## Install Handoff

The user must import the shortcuts on iPhone. Send or place the generated
`.shortcut` files where the user can open them from AirDrop, Mail, Messages, or
iCloud Drive. Apple requires user approval during import.

After import, the user should enable `Show on Apple Watch` for `Talk to OpenClaw`.
