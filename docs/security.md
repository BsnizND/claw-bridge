# Security notes

- Use a long random `CLAW_BRIDGE_TOKEN`.
- Serve the bridge only over HTTPS.
- Keep OpenClaw, queue files, logs, and admin surfaces private.
- Keep `MAX_MESSAGE_CHARS` bounded.
- Keep `SHARE_MAX_UPLOAD_BYTES` bounded.
- Use `ALLOWED_SOURCES` to reject unexpected clients.
- Prefer local binding (`HOST=127.0.0.1`) behind a reverse proxy.
- Treat Apple Shortcut URLs and bearer tokens as secrets.
- Enter native-app bearer tokens through the companion UI. They are persisted
  in device-only Keychain on both iPhone and Watch, not UserDefaults.
- A personal install that previously compiled `CLAW_BRIDGE_DEFAULT_BEARER_TOKEN`
  needs one explicit migration build before removing that setting. Launch both
  apps, remove the local build setting for the next build, verify Keychain-backed
  operation, and rotate the token that appeared in the migration binary.
- Rotate the token immediately if a shared Shortcut exposes it.
- Store share-sheet uploads outside any public web root and avoid logging bearer tokens or transcript text.

The bridge intentionally returns a short `spoken` field so Shortcuts can show
clear error notifications without exposing logs or internal runtime details.
Generated shortcuts stay silent on success.
