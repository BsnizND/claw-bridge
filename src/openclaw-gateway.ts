import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

interface GatewayIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface GatewayDeviceAuth {
  token: string;
  scopes: string[];
}

interface GatewayResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
}

interface GatewayEvent {
  type: 'event';
  event: string;
  payload?: unknown;
}

export interface OpenClawGatewayDeliveryParams {
  gatewayUrl: string;
  deviceIdentityPath: string;
  deviceAuthPath: string;
  timeoutMs: number;
  agentParams: Record<string, unknown>;
  sessionKey: string;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value as string[];
}

async function loadGatewayIdentity(identityPath: string, authPath: string): Promise<{
  identity: GatewayIdentity;
  auth: GatewayDeviceAuth;
}> {
  const identityValue = JSON.parse(await readFile(identityPath, 'utf8')) as Record<string, unknown>;
  const authValue = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>;
  const tokens = authValue.tokens as Record<string, unknown> | undefined;
  const operator = tokens?.operator as Record<string, unknown> | undefined;
  return {
    identity: {
      deviceId: requireString(identityValue.deviceId, 'OpenClaw device id'),
      publicKeyPem: requireString(identityValue.publicKeyPem, 'OpenClaw device public key'),
      privateKeyPem: requireString(identityValue.privateKeyPem, 'OpenClaw device private key')
    },
    auth: {
      token: requireString(operator?.token, 'OpenClaw operator device token'),
      scopes: requireStringArray(operator?.scopes, 'OpenClaw operator scopes')
    }
  };
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return der.subarray(-32).toString('base64url');
}

function buildConnectParams(identity: GatewayIdentity, auth: GatewayDeviceAuth, nonce: string) {
  const clientId = 'cli';
  const clientMode = 'cli';
  const role = 'operator';
  const platform = process.platform;
  const signedAt = Date.now();
  const payload = [
    'v3',
    identity.deviceId,
    clientId,
    clientMode,
    role,
    auth.scopes.join(','),
    String(signedAt),
    auth.token,
    nonce,
    platform,
    ''
  ].join('|');
  const signature = sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(identity.privateKeyPem)).toString('base64url');
  return {
    minProtocol: 4,
    maxProtocol: 4,
    client: { id: clientId, version: 'claw-bridge', platform, mode: clientMode },
    role,
    scopes: auth.scopes,
    caps: [],
    auth: { token: auth.token, deviceToken: auth.token },
    device: {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
      signature,
      signedAt,
      nonce
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function deliverViaOpenClawGateway(params: OpenClawGatewayDeliveryParams): Promise<unknown> {
  const { identity, auth } = await loadGatewayIdentity(params.deviceIdentityPath, params.deviceAuthPath);
  const socket = new WebSocket(params.gatewayUrl);
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  let connectedResolve!: () => void;
  let connectedReject!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => {
    connectedResolve = resolve;
    connectedReject = reject;
  });
  const connectTimeout = setTimeout(
    () => connectedReject(new Error('OpenClaw Gateway connect exceeded 5000ms')),
    5000
  );

  const request = (method: string, requestParams: Record<string, unknown>, timeoutMs = params.timeoutMs): Promise<unknown> => {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`OpenClaw Gateway ${method} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: 'req', id, method, params: requestParams }));
    });
  };

  const failAll = (error: Error) => {
    connectedReject(error);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };

  socket.addEventListener('message', (event) => {
    let frame: GatewayResponse | GatewayEvent;
    try {
      frame = JSON.parse(String(event.data)) as GatewayResponse | GatewayEvent;
    } catch {
      return;
    }
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      const nonce = requireString(asRecord(frame.payload).nonce, 'OpenClaw Gateway challenge nonce');
      void request('connect', buildConnectParams(identity, auth, nonce), 5000).then(() => connectedResolve(), connectedReject);
      return;
    }
    if (frame.type !== 'res') return;
    const item = pending.get(frame.id);
    if (!item) return;
    pending.delete(frame.id);
    clearTimeout(item.timer);
    if (frame.ok) item.resolve(frame.payload);
    else item.reject(new Error(`OpenClaw Gateway ${frame.error?.code ?? 'error'}: ${frame.error?.message ?? 'request failed'}`));
  });
  socket.addEventListener('error', () => failAll(new Error('OpenClaw Gateway WebSocket failed')));
  socket.addEventListener('close', (event) => failAll(new Error(`OpenClaw Gateway closed (${event.code}): ${event.reason}`)));

  try {
    await connected;
    clearTimeout(connectTimeout);
    const accepted = asRecord(await request('agent', params.agentParams));
    const runId = requireString(accepted.runId, 'OpenClaw Gateway agent run id');
    const wait = asRecord(await request('agent.wait', { runId, timeoutMs: params.timeoutMs }, params.timeoutMs + 2000));
    const status = typeof wait.status === 'string' ? wait.status : 'ok';
    if (status === 'timeout' || status === 'pending' || status === 'error') {
      throw new Error(`OpenClaw Gateway agent run ended with status ${status}${wait.error ? `: ${String(wait.error)}` : ''}`);
    }
    return await request('chat.history', { sessionKey: params.sessionKey, limit: 50 }, 5000);
  } finally {
    clearTimeout(connectTimeout);
    socket.close();
  }
}
