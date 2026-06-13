# Security notes

- Use a long random `SIRI_BRIDGE_TOKEN`.
- Serve the bridge only over HTTPS.
- Keep OpenClaw, queue files, logs, and admin surfaces private.
- Keep `MAX_MESSAGE_CHARS` bounded.
- Use `ALLOWED_SOURCES` to reject unexpected clients.
- Prefer local binding (`HOST=127.0.0.1`) behind a reverse proxy.
- Treat Apple Shortcut URLs and bearer tokens as secrets.
- Rotate the token immediately if a shared Shortcut exposes it.

The bridge intentionally returns a short `spoken` field so Siri can confirm success without exposing logs or internal runtime details.
