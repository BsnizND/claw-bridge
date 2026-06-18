import { spawn } from 'node:child_process';
import type { BridgeConfig, DeliveryResult, NormalizedSiriEvent } from './types.js';
import { drainQueue, queueEvent } from './queue.js';

export interface OpenClawDrainHooks {
  afterDelivered?: (event: NormalizedSiriEvent, result: DeliveryResult) => Promise<void>;
}

function formatLocation(event: NormalizedSiriEvent): string[] {
  if (!event.location) {
    return [];
  }
  const parts = [
    `Location: ${event.location.latitude}, ${event.location.longitude}`,
    event.location.horizontal_accuracy !== undefined ? `Accuracy: ${event.location.horizontal_accuracy}m` : undefined,
    event.location.altitude !== undefined ? `Altitude: ${event.location.altitude}m` : undefined,
    event.location.name ? `Place: ${event.location.name}` : undefined,
    event.location.address ? `Address: ${event.location.address}` : undefined,
    event.location.maps_url ? `Map: ${event.location.maps_url}` : undefined
  ];
  return parts.filter((part): part is string => Boolean(part));
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

function buildAssistantMessage(event: NormalizedSiriEvent): string {
  const heading = event.source === 'ios_share_sheet'
    ? `iOS share sheet item for ${event.assistant}:`
    : event.source === 'watch_app'
      ? `Apple Watch voice message for ${event.assistant}:`
    : `Shortcut voice message for ${event.assistant}:`;
  return [
    heading,
    '',
    event.raw_text,
    '',
    ...formatSharedItem(event),
    ...(event.shared_item ? [''] : []),
    ...formatLocation(event),
    ...(event.location ? [''] : []),
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
  if (event.source === 'ios_share_sheet') return 'Sent via iOS share sheet:';
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

function buildCompactMessage(config: BridgeConfig, event: NormalizedSiriEvent): string {
  const prefix = compactPrefix(config, event);
  const text = compactText(event);
  const message = prefix ? `${prefix} ${text}` : text;
  const context = [...formatSharedItem(event), ...formatLocation(event), ...formatVoiceMemo(event)];
  return context.length ? [message, '', ...context].join('\n') : message;
}

function buildOpenClawMessage(config: BridgeConfig, event: NormalizedSiriEvent): string {
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

async function deliverViaCli(config: BridgeConfig, event: NormalizedSiriEvent): Promise<DeliveryResult> {
  const timeoutMs = config.openclawCliDrainTimeoutMs;
  const args = [
    'agent',
    '--agent',
    event.assistant || config.assistantId,
    '--session-key',
    config.openclawSessionKey,
    '--message',
    buildOpenClawMessage(config, event),
    '--json',
    '--timeout',
    String(Math.ceil(timeoutMs / 1000))
  ];
  if (config.openclawCliThinking) {
    args.push('--thinking', config.openclawCliThinking);
  }
  if (config.openclawDeliverReply) {
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
      reject(new Error(`openclaw delivery exceeded ${timeoutMs}ms`));
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
  await queueEvent(config.queuePath, event, new Error('queued for asynchronous OpenClaw delivery'));
  return { ok: true, queued: true, id: event.request_id };
}

export async function deliverQueuedEventToOpenClaw(
  config: BridgeConfig,
  event: NormalizedSiriEvent
): Promise<DeliveryResult> {
  return config.openclawAdapter === 'http' ? await deliverViaHttp(config, event) : await deliverViaCli(config, event);
}

export async function drainOpenClawQueue(config: BridgeConfig, hooks: OpenClawDrainHooks = {}) {
  return drainQueue(config.queuePath, config.queueArchivePath, config.queueMaxAttempts, async (event) => {
    const result = await deliverQueuedEventToOpenClaw(config, event);
    await hooks.afterDelivered?.(event, result);
  });
}
