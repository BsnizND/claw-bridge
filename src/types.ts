export type OpenClawAdapter = 'cli' | 'http';
export type OpenClawMessageStyle = 'detailed' | 'compact';

export interface BridgeConfig {
  port: number;
  host: string;
  logLevel: string;
  nodeEnv: string;
  siriBridgeToken: string;
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
  siriMessagePrefix?: string;
  openclawIngestUrl?: string;
  openclawIngestToken?: string;
  queuePath: string;
  queueDrainIntervalMs: number;
  queueMaxAttempts: number;
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
}
