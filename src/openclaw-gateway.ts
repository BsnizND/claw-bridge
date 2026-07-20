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
  chatParams: Record<string, unknown>;
  sessionKey: string;
}

export interface OpenClawGatewaySpeechResult {
  audio: Buffer;
  provider: string;
  mimeType: string;
  fileExtension: string;
}

export interface OpenClawGatewaySessionRequestParams {
  gatewayUrl: string;
  deviceIdentityPath: string;
  deviceAuthPath: string;
  timeoutMs: number;
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

async function withOpenClawGateway<T>(
  params: OpenClawGatewaySessionRequestParams,
  operation: (request: (
    method: string,
    requestParams: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<unknown>, waitForEvent: (
    predicate: (event: GatewayEvent) => boolean,
    timeoutMs?: number
  ) => Promise<GatewayEvent>) => Promise<T>
): Promise<T> {
  const { identity, auth } = await loadGatewayIdentity(params.deviceIdentityPath, params.deviceAuthPath);
  const socket = new WebSocket(params.gatewayUrl);
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  const eventBacklog: GatewayEvent[] = [];
  const eventWaiters = new Set<{
    predicate: (event: GatewayEvent) => boolean;
    resolve: (event: GatewayEvent) => void;
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

  const waitForEvent = (
    predicate: (event: GatewayEvent) => boolean,
    timeoutMs = params.timeoutMs
  ): Promise<GatewayEvent> => {
    const existingIndex = eventBacklog.findIndex(predicate);
    if (existingIndex >= 0) {
      return Promise.resolve(eventBacklog.splice(existingIndex, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          eventWaiters.delete(waiter);
          reject(new Error(`OpenClaw Gateway event wait exceeded ${timeoutMs}ms`));
        }, timeoutMs)
      };
      eventWaiters.add(waiter);
    });
  };

  const failAll = (error: Error) => {
    connectedReject(error);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    for (const waiter of eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    eventWaiters.clear();
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
    if (frame.type === 'event') {
      let matched = false;
      for (const waiter of eventWaiters) {
        if (!waiter.predicate(frame)) continue;
        matched = true;
        eventWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
      if (!matched) {
        eventBacklog.push(frame);
        if (eventBacklog.length > 200) eventBacklog.shift();
      }
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
    return await operation(request, waitForEvent);
  } finally {
    clearTimeout(connectTimeout);
    socket.close();
  }
}

export async function injectAssistantMessageIntoOpenClawSession(
  params: OpenClawGatewaySessionRequestParams & {
    sessionKey: string;
    message: string;
  }
): Promise<string> {
  return withOpenClawGateway(params, async (request) => {
    const result = asRecord(await request('chat.inject', {
      sessionKey: params.sessionKey,
      agentId: 'jay',
      message: params.message
    }, 5000));
    return requireString(result.messageId, 'OpenClaw injected message id');
  });
}

export async function deliverViaOpenClawGateway(params: OpenClawGatewayDeliveryParams): Promise<unknown> {
  return withOpenClawGateway(params, async (request, waitForEvent) => {
    const accepted = asRecord(await request('chat.send', params.chatParams));
    const runId = requireString(accepted.runId, 'OpenClaw Gateway chat run id');
    const status = typeof accepted.status === 'string' ? accepted.status.trim().toLowerCase() : 'started';
    if (status === 'timeout' || status === 'error' || status === 'aborted') {
      throw new Error(`OpenClaw Gateway chat.send ended with status ${status}`);
    }
    if (status !== 'ok') {
      const terminal = await waitForEvent((event) => {
        if (event.event !== 'chat') return false;
        const payload = asRecord(event.payload);
        return payload.runId === runId && ['final', 'aborted', 'error'].includes(String(payload.state));
      }, params.timeoutMs);
      const payload = asRecord(terminal.payload);
      const terminalState = String(payload.state);
      if (terminalState !== 'final') {
        throw new Error(
          `OpenClaw Gateway chat run ended with state ${terminalState}${payload.errorMessage ? `: ${String(payload.errorMessage)}` : ''}`
        );
      }
    }
    return await request('chat.history', { sessionKey: params.sessionKey, limit: 50 }, 5000);
  });
}

export async function synthesizeSpeechViaOpenClawGateway(
  params: OpenClawGatewaySessionRequestParams & { text: string }
): Promise<OpenClawGatewaySpeechResult> {
  return withOpenClawGateway(params, async (request) => {
    const result = asRecord(await request('tts.speak', { text: params.text }, Math.max(params.timeoutMs, 60_000)));
    const audioBase64 = requireString(result.audioBase64, 'OpenClaw Gateway TTS audio');
    const provider = requireString(result.provider, 'OpenClaw Gateway TTS provider');
    const mimeType = requireString(result.mimeType, 'OpenClaw Gateway TTS MIME type');
    const audio = Buffer.from(audioBase64, 'base64');
    if (audio.length === 0) throw new Error('OpenClaw Gateway TTS returned empty audio');
    return {
      audio,
      provider,
      mimeType,
      fileExtension: normalizeSpeechFileExtension(result.fileExtension, mimeType)
    };
  });
}

function normalizeSpeechFileExtension(value: unknown, mimeType: string): string {
  if (typeof value === 'string') {
    const extension = value.trim().replace(/^\./, '').toLowerCase();
    if (/^[a-z0-9]{2,8}$/.test(extension)) return extension;
  }
  const byMimeType: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus'
  };
  const extension = byMimeType[mimeType.toLowerCase()];
  if (!extension) throw new Error(`OpenClaw Gateway TTS returned unsupported MIME type ${mimeType}`);
  return extension;
}
