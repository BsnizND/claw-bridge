import { randomUUID } from 'node:crypto';
import type { BridgeConfig, NormalizedSiriEvent, ShortcutMessageRequest } from './types.js';

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeShortcutMessage(config: BridgeConfig, body: ShortcutMessageRequest): NormalizedSiriEvent {
  const rawText = asOptionalString(body.message);
  if (!rawText) {
    throw new Error('message is required');
  }
  if (rawText.length > config.maxMessageChars) {
    throw new Error(`message exceeds ${config.maxMessageChars} characters`);
  }

  const source = asOptionalString(body.source) ?? 'shortcuts';
  if (!config.allowedSources.has(source)) {
    throw new Error(`source is not allowed: ${source}`);
  }

  const capturedAt = asOptionalString(body.captured_at) ?? new Date().toISOString();
  const capturedDate = new Date(capturedAt);
  if (Number.isNaN(capturedDate.getTime())) {
    throw new Error('captured_at must be an ISO-compatible date string');
  }

  return {
    source,
    assistant: asOptionalString(body.assistant) ?? config.assistantId,
    raw_text: rawText,
    captured_at: capturedDate.toISOString(),
    request_id: asOptionalString(body.request_id) ?? randomUUID(),
    locale: asOptionalString(body.locale),
    device_name: asOptionalString(body.device_name),
    shortcut_name: asOptionalString(body.shortcut_name)
  };
}
