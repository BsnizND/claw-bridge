import { z } from 'zod';
import type { BridgeConfig } from './types.js';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8788),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.string().default('info'),
  SIRI_BRIDGE_TOKEN: z.string().min(24),
  OPENCLAW_ASSISTANT_ID: z.string().min(1).default('jay'),
  MAX_MESSAGE_CHARS: z.coerce.number().int().positive().max(10000).default(1200),
  ALLOWED_SOURCES: z.string().default('siri_watch,siri_iphone,shortcuts'),
  OPENCLAW_ADAPTER: z.enum(['cli', 'http']).default('cli'),
  OPENCLAW_CLI_BIN: z.string().min(1).default('openclaw'),
  OPENCLAW_CLI_DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  OPENCLAW_CLI_THINKING: z.string().optional(),
  OPENCLAW_SESSION_KEY: z.string().min(1).default('agent:jay:main'),
  OPENCLAW_INGEST_URL: z.string().url().optional(),
  OPENCLAW_INGEST_TOKEN: z.string().optional(),
  QUEUE_PATH: z.string().min(1).default('./data/siri-queue.jsonl'),
  QUEUE_DRAIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(30000),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3)
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
  if (raw.OPENCLAW_ADAPTER === 'http' && (!raw.OPENCLAW_INGEST_URL || !raw.OPENCLAW_INGEST_TOKEN)) {
    throw new Error('OPENCLAW_INGEST_URL and OPENCLAW_INGEST_TOKEN are required for OPENCLAW_ADAPTER=http');
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
    siriBridgeToken: raw.SIRI_BRIDGE_TOKEN,
    assistantId: raw.OPENCLAW_ASSISTANT_ID,
    maxMessageChars: raw.MAX_MESSAGE_CHARS,
    allowedSources,
    openclawAdapter: raw.OPENCLAW_ADAPTER,
    openclawCliBin: raw.OPENCLAW_CLI_BIN,
    openclawCliDrainTimeoutMs: raw.OPENCLAW_CLI_DRAIN_TIMEOUT_MS,
    openclawCliThinking: raw.OPENCLAW_CLI_THINKING,
    openclawSessionKey: raw.OPENCLAW_SESSION_KEY,
    openclawIngestUrl: raw.OPENCLAW_INGEST_URL,
    openclawIngestToken: raw.OPENCLAW_INGEST_TOKEN,
    queuePath: raw.QUEUE_PATH,
    queueDrainIntervalMs: raw.QUEUE_DRAIN_INTERVAL_MS,
    queueMaxAttempts: raw.QUEUE_MAX_ATTEMPTS
  };
}
