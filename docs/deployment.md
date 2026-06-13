# Deployment

The bridge should run close to OpenClaw and should expose only the Shortcut webhook route through HTTPS.

## Minimal deployment

```bash
npm ci
npm run build
cp examples/env.example .env
```

Edit `.env`, then start:

```bash
node dist/src/index.js
```

## Reverse proxy

Expose:

```text
POST /shortcuts/message
GET /healthz
```

Do not expose queue files, logs, OpenClaw admin routes, shell access, or local runtime dashboards.

## Systemd example

```ini
[Unit]
Description=OpenClaw Siri Bridge
After=network-online.target

[Service]
WorkingDirectory=/opt/openclaw-siri-bridge
EnvironmentFile=/opt/openclaw-siri-bridge/.env
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=5
User=openclaw
Group=openclaw

[Install]
WantedBy=multi-user.target
```
