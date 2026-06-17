export type OpenClawAdapter = 'cli' | 'http';
export type OpenClawMessageStyle = 'detailed' | 'compact';

export interface BridgeConfig {
  port: number;
  host: string;
  logLevel: string;
  nodeEnv: string;
  bridgeToken: string;
  assistantId: string;
  maxMessageChars: number;
  allowedSources: Set<string>;
  openclawAdapter: OpenClawAdapter;
  openclawCliBin: string;
  openclawCliDrainTimeoutMs: number;
  openclawCliThinking?: string;
  openclawDeliverReply: boolean;
  openclawReplyChannel?: string;
  openclawReplyTo?: string;
  openclawWorkdir?: string;
  openclawSessionKey: string;
  openclawMessageStyle: OpenClawMessageStyle;
  voiceMessagePrefix?: string;
  openclawIngestUrl?: string;
  openclawIngestToken?: string;
  queuePath: string;
  queueArchivePath: string;
  queueDrainIntervalMs: number;
  queueMaxAttempts: number;
  shareUploadDir: string;
  shareMaxUploadBytes: number;
  audioTranscribeEnabled: boolean;
  audioTranscribeCliBin: string;
  audioTranscribeTimeoutMs: number;
  audioTranscribeModel?: string;
  audioTranscribeLanguage?: string;
}

export interface ShortcutMessageRequest {
  message?: unknown;
  source?: unknown;
  assistant?: unknown;
  captured_at?: unknown;
  device_name?: unknown;
  shortcut_name?: unknown;
  request_id?: unknown;
  locale?: unknown;
  location?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  voice_memo?: unknown;
}

export interface SiriLocation {
  latitude: number;
  longitude: number;
  altitude?: number;
  horizontal_accuracy?: number;
  vertical_accuracy?: number;
  maps_url?: string;
  name?: string;
  address?: string;
}

export interface VoiceMemoMetadata {
  transcript?: string;
  filename?: string;
  mime_type?: string;
  duration_seconds?: number;
  recorded_at?: string;
  file_path?: string;
  size_bytes?: number;
}

export interface SharedItemMetadata {
  kind: 'text' | 'url' | 'file' | 'audio' | 'image' | 'unknown';
  text?: string;
  url?: string;
  title?: string;
  filename?: string;
  mime_type?: string;
  file_path?: string;
  size_bytes?: number;
}

export interface NormalizedSiriEvent {
  source: string;
  assistant: string;
  raw_text: string;
  captured_at: string;
  request_id: string;
  locale?: string;
  device_name?: string;
  shortcut_name?: string;
  location?: SiriLocation;
  voice_memo?: VoiceMemoMetadata;
  shared_item?: SharedItemMetadata;
}

export interface DeliveryResult {
  ok: boolean;
  id?: string;
  queued?: boolean;
}

export interface QueueRecord {
  status: 'pending' | 'delivered' | 'failed';
  created_at: string;
  attempts: number;
  event: NormalizedSiriEvent;
  last_error?: string;
  last_attempt_at?: string;
  delivered_at?: string;
  archived_at?: string;
}
