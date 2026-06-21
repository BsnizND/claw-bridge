import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { BridgeConfig, NormalizedSiriEvent, ShortcutMessageRequest } from './types.js';
import { normalizeShortcutMessage } from './siri.js';
import type { UploadedShareFile } from './share.js';

function asOptionalString(value: unknown): string | undefined {
  if (Array.isArray(value)) return asOptionalString(value[0]);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('location_json must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function buildLocation(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const locationJson = parseJsonObject(asOptionalString(body.location_json));
  if (locationJson) return locationJson;
  const latitude = asOptionalString(body.latitude);
  const longitude = asOptionalString(body.longitude);
  if (!latitude && !longitude) return undefined;
  return {
    latitude,
    longitude,
    altitude: asOptionalString(body.altitude),
    horizontal_accuracy: asOptionalString(body.horizontal_accuracy),
    vertical_accuracy: asOptionalString(body.vertical_accuracy),
    location_timestamp: asOptionalString(body.location_timestamp),
    location_age_seconds: asOptionalString(body.location_age_seconds),
    maps_url: asOptionalString(body.maps_url)
  };
}

function isLikelyAudioFile(file: UploadedShareFile): boolean {
  const mimetype = file.mimetype?.toLowerCase();
  if (mimetype?.startsWith('audio/')) return true;
  if (mimetype === 'application/octet-stream') return true;
  const extension = extname(file.originalname).toLowerCase();
  return ['.m4a', '.aac', '.caf', '.wav', '.mp3', '.mp4'].includes(extension);
}

export function normalizeWatchVoiceRequest(
  config: BridgeConfig,
  body: Record<string, unknown>,
  file: UploadedShareFile | undefined,
  transcript: string | undefined
): NormalizedSiriEvent {
  if (!file) {
    throw new Error('audio file is required');
  }
  if (!isLikelyAudioFile(file)) {
    throw new Error('audio upload must use an audio MIME type');
  }

  const location = buildLocation(body);
  const message =
    asOptionalString(body.message) ??
    (transcript ? `Apple Watch voice message: ${transcript}` : 'Apple Watch voice message attached.');

  const shortcutBody: ShortcutMessageRequest = {
    message,
    source: asOptionalString(body.source) ?? 'watch_app',
    assistant: asOptionalString(body.assistant),
    captured_at: asOptionalString(body.captured_at),
    device_name: asOptionalString(body.device_name) ?? 'Apple Watch',
    shortcut_name: asOptionalString(body.app_name) ?? asOptionalString(body.shortcut_name) ?? 'OpenClaw Watch',
    request_id: asOptionalString(body.request_id) ?? randomUUID(),
    locale: asOptionalString(body.locale),
    location
  };

  const event = normalizeShortcutMessage(config, shortcutBody);
  event.shared_item = {
    kind: 'audio',
    title: asOptionalString(body.title),
    filename: file.originalname,
    mime_type: file.mimetype,
    file_path: file.path,
    size_bytes: file.size
  };
  event.voice_memo = {
    transcript,
    filename: file.originalname,
    mime_type: file.mimetype,
    file_path: file.path,
    size_bytes: file.size,
    recorded_at: asOptionalString(body.recorded_at)
  };
  const noLocationReason = asOptionalString(body.no_location_reason);
  if (!event.location && noLocationReason) {
    event.capture_receipt = {
      no_location_reason: noLocationReason
    };
  }

  return event;
}
