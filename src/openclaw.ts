import { spawn } from 'node:child_process';
import type { BridgeConfig, DeliveryResult, NormalizedSiriEvent } from './types.js';
import { drainQueue, queueEvent } from './queue.js';

function buildAssistantMessage(event: NormalizedSiriEvent): string {
  return [
    `Voice message from Siri/Shortcuts for ${event.assistant}:`,
    '',
    event.raw_text,
    '',
    `Captured at: ${event.captured_at}`,
    `Source: ${event.source}`,
    event.device_name ? `Device: ${event.device_name}` : undefined,
    event.shortcut_name ? `Shortcut: ${event.shortcut_name}` : undefined,
    `Request id: ${event.request_id}`
  ]
    .filter(Boolean)
    .join('\n');
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
    buildAssistantMessage(event),
    '--json',
    '--timeout',
    String(Math.ceil(timeoutMs / 1000))
  ];
  if (config.openclawCliThinking) {
    args.push('--thinking', config.openclawCliThinking);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(config.openclawCliBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
        resolve({ ok: true });
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
  return { ok: true };
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

export async function drainOpenClawQueue(config: BridgeConfig) {
  return drainQueue(config.queuePath, config.queueMaxAttempts, async (event) => {
    await deliverQueuedEventToOpenClaw(config, event);
  });
}
