# Security notes

- Use a long random `CLAW_BRIDGE_TOKEN`.
- Serve the bridge only over HTTPS.
- Keep OpenClaw, queue files, logs, and admin surfaces private.
- Keep `MAX_MESSAGE_CHARS` bounded.
- Keep `SHARE_MAX_UPLOAD_BYTES` bounded.
- Use `ALLOWED_SOURCES` to reject unexpected clients.
- Prefer local binding (`HOST=127.0.0.1`) behind a reverse proxy.
- Treat Apple Shortcut URLs and bearer tokens as secrets.
- Rotate the token immediately if a shared Shortcut exposes it.
- Store share-sheet uploads outside any public web root and avoid logging bearer tokens or transcript text.

The bridge intentionally returns a short `spoken` field so Shortcuts can show
clear error notifications without exposing logs or internal runtime details.
Generated shortcuts stay silent on success.
