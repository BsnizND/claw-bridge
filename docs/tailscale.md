# Tailscale Serve and Funnel

This bridge works well behind Tailscale because the Node app can stay bound to
`127.0.0.1` while Tailscale provides HTTPS at the public or tailnet URL that
Apple Shortcuts calls.

Use one of two modes:

- **Tailscale Serve**: private to devices and users in your tailnet.
- **Tailscale Funnel**: public internet HTTPS URL for phones, watches, or share
  flows that might not be connected to your tailnet.

For Apple Watch reliability, Funnel is usually the simplest setup because the
Shortcut URL is reachable even when the watch or phone is not actively using
Tailscale.

## Start the bridge locally

Keep the bridge local-only:

```text
HOST=127.0.0.1
PORT=8788
```

Then build and start:

```bash
npm ci
npm run build
node dist/src/index.js
```

Check the local app first:

```bash
curl -i http://127.0.0.1:8788/healthz
```

## Private tailnet URL with Serve

Use Serve when the iPhone running the Shortcut is on the same tailnet:

```bash
tailscale serve --bg --https=443 localhost:8788
tailscale serve status
```

Use the HTTPS URL reported by `tailscale serve status`:

```text
https://your-node.your-tailnet.ts.net/shortcuts/message
```

## Public HTTPS URL with Funnel

Use Funnel when the Shortcut must work from outside your tailnet:

```bash
tailscale funnel --bg --https=443 localhost:8788
tailscale funnel status
```

Use the HTTPS URL reported by `tailscale funnel status`:

```text
https://your-node.your-tailnet.ts.net/shortcuts/message
```

To listen on a non-default public HTTPS port, use only a port supported by
Tailscale Funnel:

```bash
tailscale funnel --bg --https=8443 localhost:8788
tailscale funnel status
```

Then include that public port in the Shortcut URL:

```text
https://your-node.your-tailnet.ts.net:8443/shortcuts/message
```

Do not put the local app port, such as `8788`, in the Shortcut URL unless that
is the public Tailscale HTTPS port you configured. The local app port is only
the backend target that Tailscale proxies to.

## Shortcut URLs

Set `SIRI_BRIDGE_URL` to the Tailscale HTTPS URL ending in
`/shortcuts/message`:

```bash
export SIRI_BRIDGE_URL='https://your-node.your-tailnet.ts.net/shortcuts/message'
export SIRI_BRIDGE_TOKEN='your-long-random-token'
./scripts/build-shortcut.sh
```

The build script derives `/shortcuts/share` and `/shortcuts/share-file` from
that URL for the share-sheet Shortcut.

## Verification

Check local health:

```bash
curl -i http://127.0.0.1:8788/healthz
```

Check the Tailscale URL:

```bash
curl -i https://your-node.your-tailnet.ts.net/healthz
```

Check that unauthenticated Shortcut calls fail closed:

```bash
curl -i -X POST https://your-node.your-tailnet.ts.net/shortcuts/message \
  -H 'Content-Type: application/json' \
  -d '{"message":"unauthorized probe","source":"shortcuts"}'
```

Expected result: `401` with `{"ok":false,"error":"unauthorized",...}`.

Check an authenticated smoke only after confirming your token is private:

```bash
curl -i -X POST https://your-node.your-tailnet.ts.net/shortcuts/message \
  -H "Authorization: Bearer $SIRI_BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"OpenClaw Siri bridge smoke test","source":"shortcuts"}'
```

Expected result: `202 Accepted`.

## Operational notes

- Funnel exposes the bridge to the public internet, so keep
  `SIRI_BRIDGE_TOKEN` long and private.
- Keep `HOST=127.0.0.1`; Tailscale should be the HTTPS edge.
- Keep only bridge routes exposed. Do not proxy OpenClaw admin routes, logs,
  queue files, shell access, or local dashboards.
- If you switch the same HTTPS port between Serve and Funnel, check status
  before rebuilding Shortcuts. Serve is tailnet-only; Funnel is public.
- If DNS has just been enabled, the public Funnel hostname can take a few
  minutes to become reachable.
