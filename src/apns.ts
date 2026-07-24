import { connect } from 'node:http2';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID, sign } from 'node:crypto';
import type { AppDeviceRegistration, AppResponseRecord, BridgeConfig } from './types.js';
import { buildLifeOSNotificationPreview } from './notification-preview.js';

export interface ApnsSendResult {
  ok: boolean;
  statusCode: number;
  apnsId?: string;
  routeId?: string;
  reason?: string;
}

export interface LifeOSNotificationRoute {
  schema: 'lifeos_notification_route.v1';
  route_id: string;
  session_key: string;
  message_id?: string;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function apnsHost(environment: 'development' | 'production'): string {
  return environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
}

export function apnsConfigured(config: BridgeConfig): boolean {
  return Boolean(config.apnsTeamId && config.apnsKeyId && config.apnsPrivateKeyPath && config.apnsBundleId);
}

async function providerToken(config: BridgeConfig): Promise<string> {
  if (!config.apnsTeamId || !config.apnsKeyId || !config.apnsPrivateKeyPath) {
    throw new Error('APNs team id, key id, and private key path are required');
  }
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.apnsKeyId }));
  const claims = base64url(JSON.stringify({ iss: config.apnsTeamId, iat: Math.floor(Date.now() / 1000) }));
  const unsigned = `${header}.${claims}`;
  const key = await readFile(config.apnsPrivateKeyPath, 'utf8');
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${base64url(signature)}`;
}

export async function sendAppResponseNotification(
  config: BridgeConfig,
  device: AppDeviceRegistration,
  response: AppResponseRecord
): Promise<ApnsSendResult> {
  return sendNotification(config, device, {
    aps: {
      alert: {
        title: 'Jay replied',
        body: 'Tap to play the voice reply.'
      },
      sound: 'default'
    },
    response_id: response.id
  });
}

export async function sendLifeOSReplyNotification(
  config: BridgeConfig,
  device: AppDeviceRegistration,
  sessionKey: string,
  replyText: string,
  messageId?: string
): Promise<ApnsSendResult> {
  const normalizedMessageId = messageId?.trim() || undefined;
  const routeId = normalizedMessageId
    ? deterministicNotificationUuid(sessionKey, normalizedMessageId)
    : randomUUID();
  const result = await sendNotification(
    config,
    device,
    buildLifeOSReplyNotificationPayload(
      sessionKey,
      replyText,
      routeId,
      normalizedMessageId
    ),
    routeId
  );
  return { ...result, routeId };
}

export function buildLifeOSReplyNotificationPayload(
  sessionKey: string,
  replyText: string,
  routeId: string,
  messageId?: string
): Record<string, unknown> {
  const body = buildLifeOSNotificationPreview(replyText);
  const route: LifeOSNotificationRoute = {
    schema: 'lifeos_notification_route.v1',
    route_id: routeId,
    session_key: sessionKey,
    ...(messageId ? { message_id: messageId } : {})
  };
  return {
    aps: {
      alert: {
        title: 'Jay',
        body: body.length > 180 ? `${body.slice(0, 177).trimEnd()}...` : body
      },
      sound: 'default'
    },
    lifeos_route: route,
    // Kept for one release so already-installed clients can route the same
    // exact conversation while the versioned envelope rolls out.
    session_key: sessionKey
  };
}

export function deterministicNotificationUuid(
  sessionKey: string,
  messageId: string
): string {
  const hex = createHash('sha256')
    .update('lifeos-notification-route-v1\0')
    .update(sessionKey)
    .update('\0')
    .update(messageId)
    .digest('hex')
    .slice(0, 32)
    .split('');
  // APNs expects the apns-id header to be a UUID. Mark this stable digest as a
  // version-5, RFC-4122 variant UUID without changing its dedupe semantics.
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32)
  ].join('-');
}

async function sendNotification(
  config: BridgeConfig,
  device: AppDeviceRegistration,
  payloadValue: Record<string, unknown>,
  apnsId?: string
): Promise<ApnsSendResult> {
  if (!apnsConfigured(config)) {
    throw new Error('APNs is not configured');
  }
  if (!config.apnsBundleId) {
    throw new Error('APNs bundle id is required');
  }
  const token = await providerToken(config);
  const client = connect(apnsHost(config.apnsEnvironment));
  try {
    const payload = JSON.stringify(payloadValue);
    return await new Promise<ApnsSendResult>((resolve, reject) => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${device.push_token}`,
        authorization: `bearer ${token}`,
        'apns-topic': config.apnsBundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        ...(apnsId ? { 'apns-id': apnsId } : {}),
        'content-type': 'application/json'
      });
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('error', reject);
      req.on('response', (headers) => {
        const statusCode = Number(headers[':status'] ?? 0);
        const apnsId = Array.isArray(headers['apns-id']) ? headers['apns-id'][0] : headers['apns-id'];
        req.on('end', () => {
          let reason: string | undefined;
          if (body) {
            try {
              reason = (JSON.parse(body) as { reason?: string }).reason;
            } catch {
              reason = body;
            }
          }
          resolve({ ok: statusCode >= 200 && statusCode < 300, statusCode, apnsId, reason });
        });
      });
      req.end(payload);
    });
  } finally {
    client.close();
  }
}
