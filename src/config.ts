import { z } from 'zod';
import type { BridgeConfig } from './types.js';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8788),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.string().default('info'),
  CLAW_BRIDGE_TOKEN: z.string().optional(),
  SIRI_BRIDGE_TOKEN: z.string().optional(),
  OPENCLAW_ASSISTANT_ID: z.string().min(1).default('openclaw'),
  MAX_MESSAGE_CHARS: z.coerce.number().int().positive().max(10000).default(1200),
  ALLOWED_SOURCES: z.string().default('siri_watch,siri_iphone,shortcuts,ios_share_sheet,lifeos_app_voice,watch_app'),
  OPENCLAW_ADAPTER: z.enum(['cli', 'gateway', 'http']).default('cli'),
  OPENCLAW_CLI_BIN: z.string().min(1).default('openclaw'),
  OPENCLAW_CLI_DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(360000),
  OPENCLAW_CLI_THINKING: z.string().optional(),
  OPENCLAW_DELIVER_REPLY: z.coerce.boolean().default(false),
  OPENCLAW_REPLY_CHANNEL: z.string().min(1).optional(),
  OPENCLAW_REPLY_TO: z.string().min(1).optional(),
  OPENCLAW_WORKDIR: z.string().min(1).optional(),
  OPENCLAW_SESSION_STORE_PATH: z.string().min(1).optional(),
  OPENCLAW_SESSION_KEY: z.string().min(1).default('agent:openclaw:main'),
  OPENCLAW_MESSAGE_STYLE: z.enum(['detailed', 'compact']).default('detailed'),
  VOICE_MESSAGE_PREFIX: z.string().min(1).optional(),
  SIRI_MESSAGE_PREFIX: z.string().min(1).optional(),
  OPENCLAW_INGEST_URL: z.string().url().optional(),
  OPENCLAW_INGEST_TOKEN: z.string().optional(),
  QUEUE_PATH: z.string().min(1).default('./data/claw-bridge-queue.jsonl'),
  QUEUE_ARCHIVE_PATH: z.string().min(1).optional(),
  QUEUE_DRAIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(30000),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  SHARE_UPLOAD_DIR: z.string().min(1).default('./data/uploads'),
  SHARE_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  WATCH_MIN_AUDIO_SECONDS: z.coerce.number().positive().default(1.5),
  WATCH_MAX_AUDIO_SECONDS: z.coerce.number().positive().default(120),
  APP_RESPONSE_DIR: z.string().min(1).default('./data/app-responses'),
  APP_RESPONSE_TTL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  ELEVENLABS_VOICE_ID: z.string().min(1).optional(),
  ELEVENLABS_MODEL_ID: z.string().min(1).default('eleven_v3'),
  ELEVENLABS_OUTPUT_FORMAT: z.string().min(1).default('mp3_44100_128'),
  ELEVENLABS_BASE_URL: z.string().url().default('https://api.elevenlabs.io'),
  APP_DEVICE_DIR: z.string().min(1).default('./data/app-devices'),
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional(),
  APNS_ENVIRONMENT: z.enum(['development', 'production']).default('development'),
  AUDIO_TRANSCRIBE_ENABLED: z.coerce.boolean().default(false),
  AUDIO_TRANSCRIBE_ENGINE: z.enum(['openclaw', 'local_whisper']).default('openclaw'),
  AUDIO_TRANSCRIBE_CLI_BIN: z.string().min(1).default('openclaw'),
  AUDIO_TRANSCRIBE_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  AUDIO_TRANSCRIBE_MODEL: z.string().min(1).optional(),
  AUDIO_TRANSCRIBE_LANGUAGE: z.string().min(1).optional()
});

export function parseAllowedSources(value: string): Set<string> {
  return new Set(
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid bridge configuration: ${missing}`);
  }

  const raw = parsed.data;
  const bridgeToken = raw.CLAW_BRIDGE_TOKEN ?? raw.SIRI_BRIDGE_TOKEN;
  if (!bridgeToken || bridgeToken.length < 24) {
    throw new Error(
      'Invalid bridge configuration: CLAW_BRIDGE_TOKEN must contain at least 24 characters; legacy SIRI_BRIDGE_TOKEN is also supported'
    );
  }

  if (raw.OPENCLAW_ADAPTER === 'http' && (!raw.OPENCLAW_INGEST_URL || !raw.OPENCLAW_INGEST_TOKEN)) {
    throw new Error('OPENCLAW_INGEST_URL and OPENCLAW_INGEST_TOKEN are required for OPENCLAW_ADAPTER=http');
  }
  if (raw.OPENCLAW_DELIVER_REPLY && (!raw.OPENCLAW_REPLY_CHANNEL || !raw.OPENCLAW_REPLY_TO)) {
    throw new Error('OPENCLAW_REPLY_CHANNEL and OPENCLAW_REPLY_TO are required when OPENCLAW_DELIVER_REPLY=true');
  }

  const allowedSources = parseAllowedSources(raw.ALLOWED_SOURCES);
  if (allowedSources.size === 0) {
    throw new Error('ALLOWED_SOURCES must include at least one source');
  }

  return {
    port: raw.PORT,
    host: raw.HOST,
    logLevel: raw.LOG_LEVEL,
    nodeEnv: raw.NODE_ENV,
    bridgeToken,
    assistantId: raw.OPENCLAW_ASSISTANT_ID,
    maxMessageChars: raw.MAX_MESSAGE_CHARS,
    allowedSources,
    openclawAdapter: raw.OPENCLAW_ADAPTER,
    openclawCliBin: raw.OPENCLAW_CLI_BIN,
    openclawCliDrainTimeoutMs: raw.OPENCLAW_CLI_DRAIN_TIMEOUT_MS,
    openclawCliThinking: raw.OPENCLAW_CLI_THINKING,
    openclawDeliverReply: raw.OPENCLAW_DELIVER_REPLY,
    openclawReplyChannel: raw.OPENCLAW_REPLY_CHANNEL,
    openclawReplyTo: raw.OPENCLAW_REPLY_TO,
    openclawWorkdir: raw.OPENCLAW_WORKDIR,
    openclawSessionStorePath: raw.OPENCLAW_SESSION_STORE_PATH,
    openclawSessionKey: raw.OPENCLAW_SESSION_KEY,
    openclawMessageStyle: raw.OPENCLAW_MESSAGE_STYLE,
    voiceMessagePrefix: raw.VOICE_MESSAGE_PREFIX ?? raw.SIRI_MESSAGE_PREFIX,
    openclawIngestUrl: raw.OPENCLAW_INGEST_URL,
    openclawIngestToken: raw.OPENCLAW_INGEST_TOKEN,
    queuePath: raw.QUEUE_PATH,
    queueArchivePath: raw.QUEUE_ARCHIVE_PATH ?? `${raw.QUEUE_PATH}.archive`,
    queueDrainIntervalMs: raw.QUEUE_DRAIN_INTERVAL_MS,
    queueMaxAttempts: raw.QUEUE_MAX_ATTEMPTS,
    shareUploadDir: raw.SHARE_UPLOAD_DIR,
    shareMaxUploadBytes: raw.SHARE_MAX_UPLOAD_BYTES,
    watchMinAudioSeconds: raw.WATCH_MIN_AUDIO_SECONDS,
    watchMaxAudioSeconds: raw.WATCH_MAX_AUDIO_SECONDS,
    appResponseDir: raw.APP_RESPONSE_DIR,
    appResponseTtlMs: raw.APP_RESPONSE_TTL_MS,
    elevenLabsApiKey: raw.ELEVENLABS_API_KEY,
    elevenLabsVoiceId: raw.ELEVENLABS_VOICE_ID,
    elevenLabsModelId: raw.ELEVENLABS_MODEL_ID,
    elevenLabsOutputFormat: raw.ELEVENLABS_OUTPUT_FORMAT,
    elevenLabsBaseUrl: raw.ELEVENLABS_BASE_URL,
    appDeviceDir: raw.APP_DEVICE_DIR,
    apnsTeamId: raw.APNS_TEAM_ID,
    apnsKeyId: raw.APNS_KEY_ID,
    apnsPrivateKeyPath: raw.APNS_PRIVATE_KEY_PATH,
    apnsBundleId: raw.APNS_BUNDLE_ID,
    apnsEnvironment: raw.APNS_ENVIRONMENT,
    audioTranscribeEnabled: raw.AUDIO_TRANSCRIBE_ENABLED,
    audioTranscribeEngine: raw.AUDIO_TRANSCRIBE_ENGINE,
    audioTranscribeCliBin: raw.AUDIO_TRANSCRIBE_CLI_BIN,
    audioTranscribeTimeoutMs: raw.AUDIO_TRANSCRIBE_TIMEOUT_MS,
    audioTranscribeModel: raw.AUDIO_TRANSCRIBE_MODEL,
    audioTranscribeLanguage: raw.AUDIO_TRANSCRIBE_LANGUAGE
  };
}
