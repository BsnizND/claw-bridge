function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('CLAW_BRIDGE_BASE_URL or CLAW_BRIDGE_URL is required');
  const url = new URL(trimmed.replace('/$()/', '//'));
  if (url.pathname !== '/' && url.pathname !== '') {
    for (const suffix of ['/shortcuts/message', '/shortcuts/share', '/shortcuts/share-file']) {
      if (url.pathname.endsWith(suffix)) {
        url.pathname = url.pathname.slice(0, -suffix.length) || '/';
      }
    }
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function requestJson(url: string, token?: string) {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  });
  const contentType = res.headers.get('content-type') ?? '';
  const bodyText = await res.text();
  let body: unknown = bodyText;
  if (contentType.includes('application/json')) {
    body = JSON.parse(bodyText) as unknown;
  }
  return { status: res.status, contentType, body };
}

const baseUrl = normalizeBaseUrl(process.env.CLAW_BRIDGE_BASE_URL ?? process.env.CLAW_BRIDGE_URL ?? '');
const token = process.env.CLAW_BRIDGE_TOKEN ?? process.env.CLAW_BRIDGE_BEARER_TOKEN;

const health = await requestJson(`${baseUrl}/healthz`);
if (health.status !== 200 || typeof health.body !== 'object' || health.body === null || (health.body as { ok?: unknown }).ok !== true) {
  throw new Error(`healthz failed: HTTP ${health.status} ${JSON.stringify(health.body)}`);
}

const checks: Record<string, unknown> = {
  ok: true,
  base_url: baseUrl,
  healthz: health.status
};

if (token) {
  const missingResponse = await requestJson(`${baseUrl}/app/responses/not-found`, token);
  if (
    missingResponse.status !== 404 ||
    typeof missingResponse.body !== 'object' ||
    missingResponse.body === null ||
    (missingResponse.body as { error?: unknown }).error !== 'response not found'
  ) {
    throw new Error(`app response route failed: HTTP ${missingResponse.status} ${JSON.stringify(missingResponse.body)}`);
  }
  checks.app_responses = missingResponse.status;
} else {
  checks.app_responses = 'skipped: set CLAW_BRIDGE_TOKEN to verify authenticated response routes';
}

console.log(JSON.stringify(checks, null, 2));
