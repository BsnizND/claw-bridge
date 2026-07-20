import { randomUUID } from 'node:crypto';
import type { BridgeConfig, CaptureSurface, NormalizedSiriEvent, SharedItemMetadata, ShortcutMessageRequest } from './types.js';
import { normalizeShortcutMessage } from './siri.js';
import { optionalLifeOSHomeSessionKey } from './session.js';

export interface UploadedShareFile {
  path: string;
  originalname: string;
  mimetype?: string;
  size: number;
}

function asOptionalString(value: unknown): string | undefined {
  if (Array.isArray(value)) return asOptionalString(value[0]);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseBoolean(value: unknown): boolean {
  const normalized = asOptionalString(value)?.toLowerCase();
  return normalized === 'true' || normalized === '1';
}

function parseCaptureSurface(value: unknown): CaptureSurface | undefined {
  const normalized = asOptionalString(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'iphone' || normalized === 'watch' || normalized === 'mac' || normalized === 'web') {
    return normalized;
  }
  throw new Error(`unsupported capture_surface: ${normalized}`);
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

function inferSharedKind(file: UploadedShareFile | undefined, url: string | undefined, text: string | undefined): SharedItemMetadata['kind'] {
  if (file?.mimetype?.toLowerCase().startsWith('audio/')) return 'audio';
  if (file?.mimetype?.toLowerCase().startsWith('image/')) return 'image';
  if (file) return 'file';
  if (url) return 'url';
  if (text) return 'text';
  return 'unknown';
}

function buildSharedText(
  body: Record<string, unknown>,
  file: UploadedShareFile | undefined,
  transcript: string | undefined,
  source: string
): string {
  const message = asOptionalString(body.message);
  if (message) return message;
  const sharedText = asOptionalString(body.shared_text);
  const sharedUrl = asOptionalString(body.shared_url);
  if (source === 'macos_app' && sharedText) return sharedText;
  if (transcript) return 'Shared audio from iOS share sheet.';
  if (sharedText) return `Shared from iOS share sheet: ${sharedText}`;
  if (sharedUrl) return `Shared URL from iOS share sheet: ${sharedUrl}`;
  if (file) return `Shared file from iOS share sheet: ${file.originalname}`;
  throw new Error('shared_text, shared_url, message, or file is required');
}

export function normalizeShareSheetRequest(
  config: BridgeConfig,
  body: Record<string, unknown>,
  file: UploadedShareFile | undefined,
  transcript: string | undefined
): NormalizedSiriEvent {
  const sharedText = asOptionalString(body.shared_text);
  const sharedUrl = asOptionalString(body.shared_url);
  const title = asOptionalString(body.shared_title) ?? asOptionalString(body.title);
  const location = buildLocation(body);
  const source = asOptionalString(body.source) ?? 'ios_share_sheet';
  const kind = inferSharedKind(file, sharedUrl, sharedText);
  if (source === 'lifeos_app_voice' && kind !== 'audio') {
    throw new Error('lifeos_app_voice requires an audio file');
  }
  if (source === 'lifeos_app_voice' && !transcript) {
    throw new Error('lifeos_app_voice requires an audio transcript');
  }
  const rawText = source === 'lifeos_app_voice' ? transcript : buildSharedText(body, file, transcript, source);
  const sessionKey = optionalLifeOSHomeSessionKey(body.session_key);

  const shortcutBody: ShortcutMessageRequest = {
    message: rawText,
    source,
    assistant: asOptionalString(body.assistant),
    captured_at: asOptionalString(body.captured_at),
    device_name: asOptionalString(body.device_name) ?? 'iPhone',
    shortcut_name: asOptionalString(body.shortcut_name) ?? 'Share with OpenClaw',
    request_id: asOptionalString(body.request_id) ?? randomUUID(),
    locale: asOptionalString(body.locale),
    location
  };

  const event = normalizeShortcutMessage(config, shortcutBody);
  if (sessionKey) event.session_key = sessionKey;
  if (source === 'lifeos_app_voice') {
    event.capture_surface = parseCaptureSurface(body.capture_surface) ?? 'iphone';
    event.talk_back = parseBoolean(body.talk_back);
    const sourceContext = asOptionalString(body.source_context);
    if (sourceContext && sourceContext !== 'golf_mode') {
      throw new Error(`unsupported source_context: ${sourceContext}`);
    }
    if (sourceContext === 'golf_mode' || parseBoolean(body.active_mode)) {
      event.source_context = 'golf_mode';
    }
  }
  const noLocationReason = asOptionalString(body.no_location_reason);
  if (source === 'lifeos_app_voice' && !event.location && noLocationReason) {
    event.capture_receipt = { no_location_reason: noLocationReason };
  }
  event.shared_item = {
    kind,
    text: sharedText,
    url: sharedUrl,
    title,
    filename: file?.originalname,
    mime_type: file?.mimetype,
    file_path: file?.path,
    size_bytes: file?.size
  };

  if (file && kind === 'audio') {
    const durationSeconds = Number(asOptionalString(body.recording_duration_seconds) ?? asOptionalString(body.duration_seconds));
    event.voice_memo = {
      transcript,
      filename: file.originalname,
      mime_type: file.mimetype,
      file_path: file.path,
      size_bytes: file.size,
      duration_seconds: Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : undefined
    };
  }

  return event;
}
