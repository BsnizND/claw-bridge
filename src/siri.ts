import { randomUUID } from 'node:crypto';
import type { BridgeConfig, NormalizedSiriEvent, ShortcutMessageRequest, SiriLocation, VoiceMemoMetadata } from './types.js';

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeLocation(body: ShortcutMessageRequest): SiriLocation | undefined {
  const location = asRecord(body.location) ?? {};
  const latitude = asOptionalNumber(location.latitude) ?? asOptionalNumber(body.latitude);
  const longitude = asOptionalNumber(location.longitude) ?? asOptionalNumber(body.longitude);
  if (latitude === undefined && longitude === undefined) {
    return undefined;
  }
  if (latitude === undefined || longitude === undefined) {
    throw new Error('location requires both latitude and longitude');
  }
  if (latitude < -90 || latitude > 90) {
    throw new Error('location.latitude must be between -90 and 90');
  }
  if (longitude < -180 || longitude > 180) {
    throw new Error('location.longitude must be between -180 and 180');
  }

  return {
    latitude,
    longitude,
    altitude: asOptionalNumber(location.altitude),
    horizontal_accuracy: asOptionalNumber(location.horizontal_accuracy),
    vertical_accuracy: asOptionalNumber(location.vertical_accuracy),
    location_timestamp: asOptionalString(location.location_timestamp),
    location_age_seconds: asOptionalNumber(location.location_age_seconds),
    maps_url: asOptionalString(location.maps_url),
    name: asOptionalString(location.name),
    address: asOptionalString(location.address)
  };
}

function normalizeVoiceMemo(value: unknown): VoiceMemoMetadata | undefined {
  const voiceMemo = asRecord(value);
  if (!voiceMemo) {
    return undefined;
  }
  const recordedAt = asOptionalString(voiceMemo.recorded_at);
  if (recordedAt && Number.isNaN(new Date(recordedAt).getTime())) {
    throw new Error('voice_memo.recorded_at must be an ISO-compatible date string');
  }
  return {
    transcript: asOptionalString(voiceMemo.transcript),
    filename: asOptionalString(voiceMemo.filename),
    mime_type: asOptionalString(voiceMemo.mime_type),
    duration_seconds: asOptionalNumber(voiceMemo.duration_seconds),
    recorded_at: recordedAt ? new Date(recordedAt).toISOString() : undefined
  };
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
    shortcut_name: asOptionalString(body.shortcut_name),
    location: normalizeLocation(body),
    voice_memo: normalizeVoiceMemo(body.voice_memo)
  };
}
