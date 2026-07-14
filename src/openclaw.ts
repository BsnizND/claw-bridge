import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { BridgeConfig, DeliveryResult, NormalizedSiriEvent } from './types.js';
import { drainQueue, hasQueuedOrArchivedRequest, queueEvent } from './queue.js';
import { LIFEOS_HOME_SESSION_PREFIX, optionalLifeOSHomeSessionKey } from './session.js';

export interface OpenClawDrainHooks {
  afterDelivered?: (event: NormalizedSiriEvent, result: DeliveryResult) => Promise<void>;
  afterFailed?: (event: NormalizedSiriEvent, error: unknown) => Promise<void>;
}

class OpenClawDeliveryTimeoutError extends Error {
  retryable = false;
}

const OPENCLAW_SESSION_LOOKUP_TIMEOUT_MS = 5_000;

function formatLocation(event: NormalizedSiriEvent): string[] {
  if (!event.location) {
    return [];
  }
  const parts = [
    `Location: ${event.location.latitude}, ${event.location.longitude}`,
    event.location.horizontal_accuracy !== undefined ? `Accuracy: ${event.location.horizontal_accuracy}m` : undefined,
    event.location.altitude !== undefined ? `Altitude: ${event.location.altitude}m` : undefined,
    event.location.location_timestamp ? `Location timestamp: ${event.location.location_timestamp}` : undefined,
    event.location.location_age_seconds !== undefined ? `Location age: ${event.location.location_age_seconds}s` : undefined,
    event.location.name ? `Place: ${event.location.name}` : undefined,
    event.location.address ? `Address: ${event.location.address}` : undefined,
    event.location.maps_url ? `Map: ${event.location.maps_url}` : undefined
  ];
  return parts.filter((part): part is string => Boolean(part));
}

function formatCaptureReceipt(event: NormalizedSiriEvent): string[] {
  if (!event.capture_receipt) {
    return [];
  }
  return [
    'Capture receipt:',
    event.capture_receipt.no_location_reason
      ? `No location reason: ${event.capture_receipt.no_location_reason}`
      : undefined
  ].filter((part): part is string => Boolean(part));
}

function formatSourceContext(event: NormalizedSiriEvent): string[] {
  if (!event.source_context) {
    return [];
  }
  const label = event.source_context === 'golf_mode' ? 'Golf Mode' : event.source_context;
  return [`Source context: ${label}`];
}

function formatVoiceMemo(event: NormalizedSiriEvent): string[] {
  if (!event.voice_memo) {
    return [];
  }
  const parts = [
    'Voice memo attached:',
    event.voice_memo.filename ? `Filename: ${event.voice_memo.filename}` : undefined,
    event.voice_memo.mime_type ? `MIME type: ${event.voice_memo.mime_type}` : undefined,
    event.voice_memo.size_bytes !== undefined ? `Size: ${event.voice_memo.size_bytes} bytes` : undefined,
    event.voice_memo.file_path ? `File path: ${event.voice_memo.file_path}` : undefined,
    event.voice_memo.duration_seconds !== undefined ? `Duration: ${event.voice_memo.duration_seconds}s` : undefined,
    event.voice_memo.recorded_at ? `Recorded at: ${event.voice_memo.recorded_at}` : undefined,
    event.voice_memo.transcript ? `Transcript: ${event.voice_memo.transcript}` : undefined
  ];
  return parts.filter((part): part is string => Boolean(part));
}

function formatSharedItem(event: NormalizedSiriEvent): string[] {
  if (!event.shared_item) {
    return [];
  }
  const parts = [
    'Shared item:',
    `Kind: ${event.shared_item.kind}`,
    event.shared_item.title ? `Title: ${event.shared_item.title}` : undefined,
    event.shared_item.url ? `URL: ${event.shared_item.url}` : undefined,
    event.shared_item.filename ? `Filename: ${event.shared_item.filename}` : undefined,
    event.shared_item.mime_type ? `MIME type: ${event.shared_item.mime_type}` : undefined,
    event.shared_item.size_bytes !== undefined ? `Size: ${event.shared_item.size_bytes} bytes` : undefined,
    event.shared_item.file_path ? `File path: ${event.shared_item.file_path}` : undefined,
    event.shared_item.text ? `Text: ${event.shared_item.text}` : undefined
  ];
  return parts.filter((part): part is string => Boolean(part));
}

function isLifeOSSaveUrl(event: NormalizedSiriEvent): boolean {
  return event.source === 'ios_share_sheet'
    && event.shortcut_name === 'LifeOS Share Extension'
    && Boolean(optionalLifeOSHomeSessionKey(event.session_key))
    && event.shared_item?.kind === 'url'
    && Boolean(event.shared_item.url);
}

function formatCaptureAction(event: NormalizedSiriEvent): string[] {
  return isLifeOSSaveUrl(event) ? ['Capture action: Save to LifeOS'] : [];
}

function buildAssistantMessage(event: NormalizedSiriEvent): string {
  const heading = isLifeOSSaveUrl(event)
    ? `LifeOS save request via iOS share sheet for ${event.assistant}:`
    : event.source === 'ios_share_sheet'
    ? `iOS share sheet item for ${event.assistant}:`
    : event.source === 'watch_app'
      ? `Apple Watch voice message for ${event.assistant}:`
    : `Shortcut voice message for ${event.assistant}:`;
  return [
    heading,
    '',
    event.raw_text,
    '',
    ...formatCaptureAction(event),
    ...(isLifeOSSaveUrl(event) ? [''] : []),
    ...formatSourceContext(event),
    ...(event.source_context ? [''] : []),
    ...formatSharedItem(event),
    ...(event.shared_item ? [''] : []),
    ...formatLocation(event),
    ...(event.location ? [''] : []),
    ...formatCaptureReceipt(event),
    ...(event.capture_receipt ? [''] : []),
    ...formatVoiceMemo(event),
    ...(event.voice_memo ? [''] : []),
    `Captured at: ${event.captured_at}`,
    `Source: ${event.source}`,
    event.device_name ? `Device: ${event.device_name}` : undefined,
    event.shortcut_name ? `Shortcut: ${event.shortcut_name}` : undefined,
    `Request id: ${event.request_id}`
  ]
    .filter(Boolean)
    .join('\n');
}

function compactPrefix(config: BridgeConfig, event: NormalizedSiriEvent): string | undefined {
  if (isLifeOSSaveUrl(event)) return 'LifeOS save request via iOS share sheet:';
  if (event.source === 'ios_share_sheet') return 'Sent via iOS share sheet:';
  if (event.source === 'watch_app' && event.source_context === 'golf_mode') {
    return 'Sent from Golf Mode via Apple Watch voice message:';
  }
  if (event.source === 'watch_app') return 'Sent via Apple Watch voice message:';
  return config.voiceMessagePrefix?.trim() || 'Sent via voice message:';
}

function compactText(event: NormalizedSiriEvent): string {
  if (event.source === 'watch_app') {
    return event.raw_text.replace(/^Apple Watch voice message:\s*/i, '');
  }
  if (event.source !== 'ios_share_sheet') return event.raw_text;
  return event.raw_text
    .replace(/^Shared (?:from|via) (?:iOS|iPhone) share sheet:\s*/i, '')
    .replace(/^Shared from iOS share sheet:\s*/i, '')
    .replace(/^Shared URL from iOS share sheet:\s*/i, '')
    .replace(/^Shared file from iOS share sheet:\s*/i, '')
    .replace(/^Shared audio from iOS share sheet\.\s*/i, '');
}

function buildNativeVoiceMessage(event: NormalizedSiriEvent): string {
  const transcript = event.voice_memo?.transcript?.trim() || compactText(event);
  const durationMs = event.voice_memo?.duration_seconds !== undefined
    ? Math.round(event.voice_memo.duration_seconds * 1000)
    : event.capture_receipt?.audio_duration_seconds !== undefined
      ? Math.round(event.capture_receipt.audio_duration_seconds * 1000)
      : null;
  const contextEnvelope = {
    schemaVersion: 'lifeos_model_context.v1',
    createdAt: event.captured_at,
    appSurface: 'ios_lifeos',
    source: {
      kind: 'voice',
      durationMs,
      transcript,
      captureId: event.request_id,
      captureSurface: event.source === 'watch_app' ? 'watch' : 'iphone',
      context: event.source_context ?? null
    },
    timezone: null,
    localDateTime: null,
    location: event.location
      ? {
          status: 'present',
          latitude: event.location.latitude,
          longitude: event.location.longitude,
          accuracyMeters: event.location.horizontal_accuracy ?? null,
          altitudeMeters: event.location.altitude ?? null,
          capturedAt: event.location.location_timestamp ?? event.captured_at,
          ageMs: event.location.location_age_seconds !== undefined
            ? Math.round(event.location.location_age_seconds * 1000)
            : null,
          mapsUrl: event.location.maps_url ?? null,
          freshness: 'current'
        }
      : {
          status: 'unavailable',
          reason: event.capture_receipt?.no_location_reason ?? null
        },
    thingInView: null,
    attachments: event.voice_memo
      ? [{ kind: 'audio', mimeType: event.voice_memo.mime_type ?? 'audio/mp4', durationMs }]
      : []
  };
  return `${transcript}\n\n<lifeos_client_context_envelope>\n${JSON.stringify(contextEnvelope)}\n</lifeos_client_context_envelope>`;
}

function buildCompactMessage(config: BridgeConfig, event: NormalizedSiriEvent): string {
  const prefix = compactPrefix(config, event);
  const text = compactText(event);
  const message = prefix ? `${prefix} ${text}` : text;
  const context = [
    ...formatCaptureAction(event),
    ...(isLifeOSSaveUrl(event) ? [`Captured at: ${event.captured_at}`, `Request id: ${event.request_id}`] : []),
    ...formatSourceContext(event),
    ...formatSharedItem(event),
    ...formatLocation(event),
    ...formatCaptureReceipt(event),
    ...formatVoiceMemo(event)
  ];
  return context.length ? [message, '', ...context].join('\n') : message;
}

function buildOpenClawMessage(config: BridgeConfig, event: NormalizedSiriEvent): string {
  if (event.source === 'lifeos_app_voice' || event.source === 'watch_app') return buildNativeVoiceMessage(event);
  return config.openclawMessageStyle === 'compact' ? buildCompactMessage(config, event) : buildAssistantMessage(event);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') return stringValue(value);
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const item = part as Record<string, unknown>;
        return stringValue(item.text) ?? stringValue(item.content);
      }
      return undefined;
    })
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join('\n').trim() : undefined;
}

function extractReplyTextFromValue(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const direct =
    stringValue(obj.reply) ??
    stringValue(obj.response) ??
    stringValue(obj.message) ??
    stringValue(obj.text) ??
    stringValue(obj.assistant_message) ??
    stringValue(obj.assistantMessage) ??
    textFromContent(obj.content);
  if (direct) return direct;

  if (Array.isArray(obj.payloads)) {
    const payloadText = obj.payloads
      .map((item) => extractReplyTextFromValue(item))
      .find((text): text is string => Boolean(text));
    if (payloadText) return payloadText;
  }

  const finalText = stringValue(obj.finalAssistantVisibleText) ?? stringValue(obj.finalAssistantRawText);
  if (finalText) return finalText;

  for (const key of ['result', 'data', 'output', 'assistant', 'replyMessage']) {
    const nested = extractReplyTextFromValue(obj[key]);
    if (nested) return nested;
  }

  if (Array.isArray(obj.messages)) {
    const assistantMessage = [...obj.messages].reverse().find((item) => {
      if (!item || typeof item !== 'object') return false;
      const role = (item as Record<string, unknown>).role;
      return role === 'assistant';
    });
    const text = extractReplyTextFromValue(assistantMessage);
    if (text) return text;
  }

  return undefined;
}

function parseJsonCandidates(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed) as unknown];
  } catch {
    // Some OpenClaw commands may print diagnostics before or after JSON.
  }

  const candidates: unknown[] = [];
  for (const line of trimmed.split('\n').map((part) => part.trim()).filter(Boolean).reverse()) {
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      candidates.push(JSON.parse(line) as unknown);
    } catch {
      // Keep scanning.
    }
  }
  return candidates;
}

export function extractReplyTextFromOpenClawOutput(stdout: string): string | undefined {
  for (const candidate of parseJsonCandidates(stdout)) {
    const text = extractReplyTextFromValue(candidate);
    if (text) return text;
  }
  return undefined;
}

export function extractMostRecentLifeOSHomeSessionKeyFromOpenClawOutput(stdout: string): string | undefined {
  for (const candidate of parseJsonCandidates(stdout)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const object = candidate as Record<string, unknown>;
    const sessions = Array.isArray(object.sessions)
      ? object.sessions
      : Object.entries(object).map(([key, value]) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(value as Record<string, unknown>), key }
            : undefined
        );

    const mostRecent = sessions
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
        const session = item as Record<string, unknown>;
        const key = stringValue(session.key) ?? stringValue(session.sessionKey);
        if (!key?.startsWith(LIFEOS_HOME_SESSION_PREFIX)) return undefined;
        if (stringValue(session.archivedAt)) return undefined;
        const updatedAt = typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
          ? session.updatedAt
          : 0;
        return { key, updatedAt };
      })
      .filter((item): item is { key: string; updatedAt: number } => Boolean(item))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (mostRecent) return mostRecent.key;
  }
  return undefined;
}

function extractOpenClawSessionStorePath(stdout: string): string | undefined {
  for (const candidate of parseJsonCandidates(stdout)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const path = stringValue((candidate as Record<string, unknown>).path);
    if (path) return path;
  }
  return undefined;
}

async function resolveMostRecentLifeOSHomeSessionKey(
  config: BridgeConfig,
  assistantId: string
): Promise<string> {
  if (config.openclawSessionStorePath) {
    const store = await readFile(config.openclawSessionStorePath, 'utf8');
    const sessionKey = extractMostRecentLifeOSHomeSessionKeyFromOpenClawOutput(store);
    if (!sessionKey) {
      throw new Error('No existing non-archived LifeOS Home session is available for this Watch capture');
    }
    return sessionKey;
  }
  const args = ['sessions', '--agent', assistantId, '--json', '--limit', 'all'];
  return new Promise((resolve, reject) => {
    const child = spawn(config.openclawCliBin, args, {
      cwd: config.openclawWorkdir,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`OpenClaw LifeOS session lookup exceeded ${OPENCLAW_SESSION_LOOKUP_TIMEOUT_MS}ms`));
    }, OPENCLAW_SESSION_LOOKUP_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`OpenClaw LifeOS session lookup exited ${code}: ${stderr || stdout}`.trim()));
        return;
      }
      const storePath = extractOpenClawSessionStorePath(stdout);
      if (!storePath) {
        reject(new Error('OpenClaw LifeOS session lookup did not report its canonical session store'));
        return;
      }
      void readFile(storePath, 'utf8')
        .then((store) => {
          const sessionKey = extractMostRecentLifeOSHomeSessionKeyFromOpenClawOutput(store);
          if (!sessionKey) {
            reject(new Error('No existing non-archived LifeOS Home session is available for this Watch capture'));
            return;
          }
          resolve(sessionKey);
        })
        .catch(reject);
    });
  });
}

async function attachMostRecentLifeOSSessionToWatchCapture(
  config: BridgeConfig,
  event: NormalizedSiriEvent
): Promise<void> {
  if (event.source !== 'watch_app') return;
  // A Watch recording can sit on-device for hours before the paired iPhone
  // relays it. Route at delivery time so an old captured session key cannot
  // reopen a stale LifeOS conversation.
  event.session_key = await resolveMostRecentLifeOSHomeSessionKey(config, event.assistant || config.assistantId);
}

async function deliverViaCli(config: BridgeConfig, event: NormalizedSiriEvent): Promise<DeliveryResult> {
  const timeoutMs = config.openclawCliDrainTimeoutMs;
  const lifeOSSessionKey = optionalLifeOSHomeSessionKey(event.session_key);
  const args = [
    'agent',
    '--agent',
    event.assistant || config.assistantId,
    '--session-key',
    lifeOSSessionKey ?? config.openclawSessionKey,
    '--message',
    buildOpenClawMessage(config, event),
    '--json',
    '--timeout',
    String(Math.ceil(timeoutMs / 1000))
  ];
  if (config.openclawCliThinking) {
    args.push('--thinking', config.openclawCliThinking);
  }
  // A LifeOS capture already names its originating conversation. Keep Jay's
  // reply in that session so the app can project it instead of also sending it
  // through the bridge's configured fallback channel (currently Telegram).
  if (config.openclawDeliverReply && !lifeOSSessionKey) {
    args.push('--deliver');
    if (config.openclawReplyChannel) {
      args.push('--reply-channel', config.openclawReplyChannel);
    }
    if (config.openclawReplyTo) {
      args.push('--reply-to', config.openclawReplyTo);
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn(config.openclawCliBin, args, {
      cwd: config.openclawWorkdir,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      reject(
        new OpenClawDeliveryTimeoutError(
          `openclaw delivery exceeded ${timeoutMs}ms; not retrying because the agent attempt may have side effects`
        )
      );
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true, replyText: extractReplyTextFromOpenClawOutput(stdout), appResponseId: event.app_response?.id });
      } else {
        reject(new Error(`openclaw exited ${code}: ${stderr || stdout}`.trim()));
      }
    });
  });
}

async function deliverViaGateway(config: BridgeConfig, event: NormalizedSiriEvent): Promise<DeliveryResult> {
  const timeoutMs = config.openclawCliDrainTimeoutMs;
  const lifeOSSessionKey = optionalLifeOSHomeSessionKey(event.session_key);
  const params: Record<string, unknown> = {
    message: buildOpenClawMessage(config, event),
    agentId: event.assistant || config.assistantId,
    sessionKey: lifeOSSessionKey ?? config.openclawSessionKey,
    timeout: Math.ceil(timeoutMs / 1000),
    deliver: Boolean(config.openclawDeliverReply && !lifeOSSessionKey),
    cleanupBundleMcpOnRunEnd: true,
    idempotencyKey: event.request_id
  };
  if (config.openclawCliThinking) params.thinking = config.openclawCliThinking;
  if (params.deliver && config.openclawReplyChannel) params.replyChannel = config.openclawReplyChannel;
  if (params.deliver && config.openclawReplyTo) params.replyTo = config.openclawReplyTo;

  const args = [
    'gateway',
    'call',
    'agent',
    '--params',
    JSON.stringify(params),
    '--expect-final',
    '--json',
    '--timeout',
    String(timeoutMs)
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(config.openclawCliBin, args, {
      cwd: config.openclawWorkdir,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      reject(
        new OpenClawDeliveryTimeoutError(
          `OpenClaw gateway delivery exceeded ${timeoutMs}ms; not retrying because the agent attempt may have side effects`
        )
      );
    }, timeoutMs + 2000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true, replyText: extractReplyTextFromOpenClawOutput(stdout), appResponseId: event.app_response?.id });
      } else {
        reject(new Error(`OpenClaw gateway call exited ${code}: ${stderr || stdout}`.trim()));
      }
    });
  });
}

async function deliverViaHttp(config: BridgeConfig, event: NormalizedSiriEvent): Promise<DeliveryResult> {
  if (!config.openclawIngestUrl || !config.openclawIngestToken) {
    throw new Error('OpenClaw HTTP ingest is not configured');
  }
  const res = await fetch(config.openclawIngestUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openclawIngestToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  });
  if (!res.ok) {
    throw new Error(`OpenClaw ingest failed with HTTP ${res.status}`);
  }
  const body = await res.text();
  return { ok: true, replyText: extractReplyTextFromOpenClawOutput(body), appResponseId: event.app_response?.id };
}

export async function acceptForOpenClaw(config: BridgeConfig, event: NormalizedSiriEvent): Promise<DeliveryResult> {
  if (await hasQueuedOrArchivedRequest(config.queuePath, config.queueArchivePath, event.request_id)) {
    return { ok: true, queued: true, id: event.request_id };
  }
  await queueEvent(config.queuePath, event, new Error('queued for asynchronous OpenClaw delivery'));
  return { ok: true, queued: true, id: event.request_id };
}

export async function deliverQueuedEventToOpenClaw(
  config: BridgeConfig,
  event: NormalizedSiriEvent
): Promise<DeliveryResult> {
  await attachMostRecentLifeOSSessionToWatchCapture(config, event);
  if (config.openclawAdapter === 'http') return deliverViaHttp(config, event);
  if (config.openclawAdapter === 'gateway') return deliverViaGateway(config, event);
  return deliverViaCli(config, event);
}

export async function drainOpenClawQueue(config: BridgeConfig, hooks: OpenClawDrainHooks = {}) {
  return drainQueue(config.queuePath, config.queueArchivePath, config.queueMaxAttempts, async (event) => {
    const result = await deliverQueuedEventToOpenClaw(config, event);
    try {
      await hooks.afterDelivered?.(event, result);
    } catch {
      // App-response fanout must not cause a second OpenClaw/Telegram delivery.
    }
  }, {
    afterFailed: hooks.afterFailed
  });
}
