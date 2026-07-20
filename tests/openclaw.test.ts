import { chmod, mkdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  acceptForOpenClaw,
  drainOpenClawQueue,
  extractMostRecentLifeOSHomeSessionKeyFromOpenClawOutput,
  extractReplyTextFromOpenClawOutput,
  resolveMostRecentDirectLifeOSHomeSessionKeyFromStorePath
} from '../src/openclaw.js';
import { recoverFreshOrphanedDrainLockForExclusiveOwner } from '../src/queue.js';
import type { BridgeConfig, NormalizedSiriEvent } from '../src/types.js';

async function exitedProcessPid(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid;
    child.once('error', reject);
    child.once('exit', () => {
      if (pid === undefined) reject(new Error('child process did not expose a pid'));
      else resolve(pid);
    });
  });
}

function event(text = 'remember dog food'): NormalizedSiriEvent {
  return {
    source: 'siri_watch',
    assistant: 'openclaw',
    raw_text: text,
    captured_at: new Date().toISOString(),
    request_id: 'test-request-id',
    device_name: 'Apple Watch',
    shortcut_name: 'Talk to OpenClaw'
  };
}

function eventWithLocationAndMemo(text = 'find burritos near me'): NormalizedSiriEvent {
  return {
    ...event(text),
    location: {
      latitude: 33.6001,
      longitude: -111.9002,
      horizontal_accuracy: 8,
      location_timestamp: '2026-06-13T15:59:55.000Z',
      location_age_seconds: 5,
      maps_url: 'https://maps.apple.com/?ll=33.6001,-111.9002'
    },
    voice_memo: {
      transcript: 'this is the voice memo transcript',
      filename: 'Latest memo.m4a',
      duration_seconds: 90,
      recorded_at: '2026-06-13T16:00:00.000Z'
    },
    shared_item: {
      kind: 'audio',
      filename: 'Latest memo.m4a',
      mime_type: 'audio/mp4',
      file_path: '/tmp/Latest memo.m4a',
      size_bytes: 1234
    }
  };
}

function shareEvent(text = 'Shared from iOS share sheet: screenshot OCR text'): NormalizedSiriEvent {
  return {
    source: 'ios_share_sheet',
    assistant: 'openclaw',
    raw_text: text,
    captured_at: new Date().toISOString(),
    request_id: 'share-request-id',
    device_name: 'iPhone',
    shortcut_name: 'Share with OpenClaw',
    shared_item: {
      kind: 'text',
      text: 'screenshot OCR text',
      title: 'IMG_8055'
    }
  };
}

function lifeOSSaveUrlEvent(text = 'Why should I care about this?'): NormalizedSiriEvent {
  return {
    source: 'ios_share_sheet',
    assistant: 'jay',
    raw_text: text,
    captured_at: '2026-07-13T19:44:17.466Z',
    request_id: 'lifeos-save-request-id',
    session_key: 'agent:jay:lifeos-home:current-conversation',
    device_name: 'Brian’s iPhone',
    shortcut_name: 'LifeOS Share Extension',
    shared_item: {
      kind: 'url',
      url: 'https://x.com/example/status/123?s=12&t=tracking'
    }
  };
}

function lifeOSAppVoiceEvent(text = 'Remind me to order coffee filters'): NormalizedSiriEvent {
  return {
    source: 'lifeos_app_voice',
    assistant: 'jay',
    raw_text: text,
    captured_at: '2026-07-13T20:12:00.000Z',
    request_id: 'lifeos-app-voice-request-id',
    session_key: 'agent:jay:lifeos-home:current-conversation',
    device_name: 'Brian\u2019s iPhone',
    shortcut_name: 'LifeOS Voice Capture',
    capture_surface: 'iphone',
    talk_back: true,
    location: {
      latitude: 33.6001,
      longitude: -111.9002,
      altitude: 420.5,
      horizontal_accuracy: 7.5,
      location_timestamp: '2026-07-13T20:11:58.000Z',
      location_age_seconds: 2,
      maps_url: 'https://maps.apple.com/?ll=33.6001,-111.9002'
    },
    shared_item: {
      kind: 'audio',
      filename: 'lifeos-capture.m4a',
      mime_type: 'audio/mp4',
      file_path: '/private/lifeos/audio/lifeos-capture.m4a',
      size_bytes: 4321
    },
    voice_memo: {
      transcript: text,
      filename: 'lifeos-capture.m4a',
      mime_type: 'audio/mp4',
      duration_seconds: 12.4,
      file_path: '/private/lifeos/audio/lifeos-capture.m4a',
      size_bytes: 4321
    }
  };
}

function lifeOSMacTextEvent(text = 'Turn on the living room lamp please.'): NormalizedSiriEvent {
  return {
    source: 'macos_app',
    assistant: 'jay',
    raw_text: text,
    captured_at: '2026-07-20T22:02:15.000Z',
    request_id: 'lifeos-mac-text-request-id',
    session_key: 'agent:jay:lifeos-home:current-conversation',
    device_name: 'Brian\u2019s Mac',
    shortcut_name: 'LifeOS for Mac',
    location: {
      latitude: 33.61028667343154,
      longitude: -111.85901093046989,
      horizontal_accuracy: 35,
      location_timestamp: '2026-07-20T22:02:15.000Z',
      location_age_seconds: 0.647,
      maps_url: 'https://maps.apple.com/?ll=33.61028667343154,-111.85901093046989'
    },
    shared_item: {
      kind: 'text',
      text
    }
  };
}

function parseNativeVoiceDelivery(message: string): {
  transcript: string;
  context: Record<string, unknown>;
} {
  const match = message.match(
    /^([\s\S]*?)\n\n<lifeos_client_context_envelope>\n([\s\S]*?)\n<\/lifeos_client_context_envelope>$/,
  );
  if (!match) throw new Error(`Missing native voice context envelope: ${message}`);
  return {
    transcript: match[1],
    context: JSON.parse(match[2]) as Record<string, unknown>,
  };
}

async function writeMessageCapturingOpenClaw(binPath: string, messagePath: string): Promise<void> {
  const sessionStorePath = `${messagePath}.sessions.json`;
  const sessionTranscriptPath = `${messagePath}.session.jsonl`;
  await writeFile(
    sessionTranscriptPath,
    `${directLifeOSUserMessage('2026-07-19T19:00:00Z', 'Existing direct LifeOS turn')}\n`,
    'utf8'
  );
  await writeFile(
    sessionStorePath,
    JSON.stringify({
      'agent:jay:lifeos-home:current-conversation': {
        updatedAt: 100,
        sessionFile: sessionTranscriptPath
      }
    }),
    'utf8'
  );
  await writeFile(
    binPath,
    `#!/bin/sh
if [ "$1" = "sessions" ]; then
  printf '%s\n' '{"path":"${sessionStorePath}","sessions":[]}'
  exit 0
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--message" ]; then
    shift
    printf '%s' "$1" > '${messagePath}'
    exit 0
  fi
  shift
done
exit 2
`,
    'utf8'
  );
  await chmod(binPath, 0o755);
}

function directLifeOSUserMessage(timestamp: string, text: string): string {
  return JSON.stringify({
    type: 'message',
    timestamp,
    message: {
      role: 'user',
      content: `${text}\n\n<lifeos_client_context_envelope>\n{}\n</lifeos_client_context_envelope>`
    }
  });
}

function watchEventWithoutLocation(text = 'voice note without gps'): NormalizedSiriEvent {
  return {
    ...event(text),
    source: 'watch_app',
    session_key: 'agent:jay:lifeos-home:existing-watch-thread',
    raw_text: `Apple Watch voice message: ${text}`,
    capture_receipt: {
      no_location_reason: 'location_timeout'
    },
    voice_memo: {
      filename: 'Latest memo.m4a',
      mime_type: 'audio/mp4',
      file_path: '/tmp/Latest memo.m4a',
      size_bytes: 1234
    },
    shared_item: {
      kind: 'audio',
      filename: 'Latest memo.m4a',
      mime_type: 'audio/mp4',
      file_path: '/tmp/Latest memo.m4a',
      size_bytes: 1234
    }
  };
}

function golfWatchEvent(text = 'hitting 7 iron from here'): NormalizedSiriEvent {
  return {
    ...watchEventWithoutLocation(text),
    raw_text: `Apple Watch voice message: ${text}`,
    source_context: 'golf_mode',
    location: {
      latitude: 33.5979,
      longitude: -111.7581,
      horizontal_accuracy: 4,
      maps_url: 'https://maps.apple.com/?ll=33.5979,-111.7581'
    },
    capture_receipt: undefined
  };
}

describe('OpenClaw delivery', () => {
  it('extracts assistant reply text from common OpenClaw JSON shapes', () => {
    expect(extractReplyTextFromOpenClawOutput(JSON.stringify({ reply: 'hello from reply' }))).toBe('hello from reply');
    expect(extractReplyTextFromOpenClawOutput(JSON.stringify({ result: { text: 'hello from result text' } }))).toBe(
      'hello from result text'
    );
    expect(
      extractReplyTextFromOpenClawOutput(
        JSON.stringify({
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: [{ type: 'text', text: 'hello from content array' }] }
          ]
        })
      )
    ).toBe('hello from content array');
    expect(
      extractReplyTextFromOpenClawOutput(
        JSON.stringify({
          runId: 'test-run',
          status: 'ok',
          result: {
            payloads: [
              {
                text: 'hello from OpenClaw payloads',
                mediaUrl: null
              }
            ],
            finalAssistantVisibleText: 'hello from visible text'
          }
        })
      )
    ).toBe('hello from OpenClaw payloads');
  });

  it('selects the most recently updated LifeOS Home session from native OpenClaw output', () => {
    expect(
      extractMostRecentLifeOSHomeSessionKeyFromOpenClawOutput(
        JSON.stringify({
          sessions: [
            { key: 'agent:jay:lifeos-home:older', updatedAt: 100 },
            { key: 'agent:jay:telegram:default:direct:brian', updatedAt: 900 },
            { key: 'agent:jay:lifeos-home:archived', updatedAt: 400, archivedAt: '2026-07-14T00:00:00Z' },
            { key: 'agent:jay:lifeos-home:newest', updatedAt: 300 },
            { key: 'agent:jay:lifeos-home:middle', updatedAt: 200 }
          ]
        })
      )
    ).toBe('agent:jay:lifeos-home:newest');
  });

  it('never treats QA or internal LifeOS sessions as the current user conversation', () => {
    expect(
      extractMostRecentLifeOSHomeSessionKeyFromOpenClawOutput(
        JSON.stringify({
          sessions: [
            { key: 'agent:jay:lifeos-home:user-conversation', updatedAt: 100 },
            { key: 'agent:jay:lifeos-home:qa:expertise-phoenix', updatedAt: 500 },
            { key: 'agent:jay:lifeos-home:qa-trip-proof', updatedAt: 450 },
            { key: 'agent:jay:lifeos-home:surface-now:daily', updatedAt: 400 },
            { key: 'agent:jay:lifeos-home:surface-now-daily', updatedAt: 350 },
            { key: 'agent:jay:lifeos-home:user-conversation:heartbeat', updatedAt: 600 },
            { key: 'agent:jay:lifeos-home:stream-proof-latest', updatedAt: 700 },
            { key: 'agent:jay:lifeos-home:internal-delivery-check', updatedAt: 800 }
          ]
        })
      )
    ).toBe('agent:jay:lifeos-home:user-conversation');
  });

  it('routes current by the freshest direct Brian-authored LifeOS message, not session activity', async () => {
    const dir = join(tmpdir(), `claw-bridge-current-thread-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const storePath = join(dir, 'sessions.json');
    const olderDirectPath = join(dir, 'older-direct.jsonl');
    const newestDirectPath = join(dir, 'newest-direct.jsonl');
    const internalPath = join(dir, 'internal.jsonl');
    await writeFile(olderDirectPath, `${directLifeOSUserMessage('2026-07-19T18:00:00Z', 'Older direct message')}\n`, 'utf8');
    await writeFile(newestDirectPath, `${directLifeOSUserMessage('2026-07-19T19:00:00Z', 'Newest direct message')}\n`, 'utf8');
    await writeFile(internalPath, `${JSON.stringify({
      type: 'message',
      timestamp: '2026-07-19T20:00:00Z',
      message: { role: 'user', content: '[Inter-session message] internal handoff' }
    })}\n`, 'utf8');
    await writeFile(storePath, JSON.stringify({
      'agent:jay:lifeos-home:older-direct': {
        updatedAt: 900,
        sessionFile: olderDirectPath
      },
      'agent:jay:lifeos-home:newest-direct': {
        updatedAt: 100,
        sessionFile: newestDirectPath
      },
      'agent:jay:lifeos-home:background-only': {
        updatedAt: 1000,
        sessionFile: internalPath
      },
      'agent:jay:lifeos-home:newest-direct:heartbeat': {
        updatedAt: 1100,
        sessionFile: newestDirectPath
      }
    }), 'utf8');

    await expect(resolveMostRecentDirectLifeOSHomeSessionKeyFromStorePath(storePath))
      .resolves.toBe('agent:jay:lifeos-home:newest-direct');
    await rm(dir, { recursive: true, force: true });
  });

  it('fails closed when no LifeOS session contains a direct client message', async () => {
    const dir = join(tmpdir(), `claw-bridge-current-thread-empty-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const storePath = join(dir, 'sessions.json');
    const transcriptPath = join(dir, 'internal.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'message',
      timestamp: '2026-07-19T20:00:00Z',
      message: { role: 'user', content: 'Internal request without LifeOS client context' }
    })}\n`, 'utf8');
    await writeFile(storePath, JSON.stringify({
      'agent:jay:lifeos-home:internal': { updatedAt: 1000, sessionFile: transcriptPath }
    }), 'utf8');

    await expect(resolveMostRecentDirectLifeOSHomeSessionKeyFromStorePath(storePath))
      .rejects.toThrow(/direct Brian-authored LifeOS Home conversation/u);
    await rm(dir, { recursive: true, force: true });
  });

  it('queues inbound Siri events immediately instead of blocking the request', async () => {
    const dir = join(tmpdir(), `claw-bridge-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');

    const result = await acceptForOpenClaw(
      {
        openclawAdapter: 'cli',
        openclawCliBin: '/missing/openclaw',
        openclawCliDrainTimeoutMs: 120000,
        assistantId: 'openclaw',
        openclawSessionKey: 'agent:openclaw:main',
        queuePath,
        queueArchivePath: archivePath,
        queueMaxAttempts: 3
      } as BridgeConfig,
      event()
    );

    expect(result).toEqual({ ok: true, queued: true, id: 'test-request-id' });
    const queued = await readFile(queuePath, 'utf8');
    expect(queued).toContain('remember dog food');
    expect(queued).toContain('"status":"pending"');
    expect(queued).toContain('queued for asynchronous OpenClaw delivery');
    await rm(dir, { recursive: true, force: true });
  });

  it('does not queue the same request id twice', async () => {
    const dir = join(tmpdir(), `claw-bridge-dedupe-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: '/missing/openclaw',
      openclawCliDrainTimeoutMs: 120000,
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, event('first copy'));
    await acceptForOpenClaw(config, event('duplicate copy'));

    const queued = await readFile(queuePath, 'utf8');
    const lines = queued.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(queued).toContain('first copy');
    expect(queued).not.toContain('duplicate copy');
    await rm(dir, { recursive: true, force: true });
  });

  it('drains queued events through the OpenClaw CLI and marks them delivered', async () => {
    const dir = join(tmpdir(), `claw-bridge-drain-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const argsPath = join(dir, 'args.txt');
    const cwdPath = join(dir, 'cwd.txt');
    await writeFile(
      binPath,
      `#!/bin/sh\npwd > '${cwdPath}'\nprintf '%s\\n' "$@" > '${argsPath}'\nprintf '{"reply":"delivered reply text"}\\n'\n`,
      'utf8'
    );
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawCliThinking: 'minimal',
      openclawWorkdir: dir,
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, event('drain this message'));
    let capturedReplyText: string | undefined;
    const drain = await drainOpenClawQueue(config, {
      afterDelivered: async (_event, result) => {
        capturedReplyText = result.replyText;
      }
    });

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    expect(capturedReplyText).toBe('delivered reply text');
    const queue = await readFile(queuePath, 'utf8');
    expect(queue).toBe('');
    const archive = await readFile(archivePath, 'utf8');
    expect(archive).toContain('"status":"delivered"');
    expect(archive).toContain('"attempts":1');
    const args = await readFile(argsPath, 'utf8');
    const cwd = await readFile(cwdPath, 'utf8');
    expect(args).toContain('--message');
    expect(args).toContain('agent:openclaw:main');
    expect(args).toContain('voice message for openclaw');
    expect(args).toContain('drain this message');
    expect(args).toContain('--thinking');
    expect(args).toContain('minimal');
    expect(await realpath(cwd.trim())).toBe(await realpath(dir));
    await rm(dir, { recursive: true, force: true });
  });

  it('delivers through the already-running OpenClaw Gateway with native session ownership', async () => {
    const dir = join(tmpdir(), `claw-bridge-gateway-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const identityPath = join(dir, 'device.json');
    const authPath = join(dir, 'device-auth.json');
    const keys = generateKeyPairSync('ed25519');
    await writeFile(identityPath, JSON.stringify({
      deviceId: 'test-device',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
      privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
    }));
    await writeFile(authPath, JSON.stringify({
      tokens: { operator: { token: 'paired-device-token', scopes: ['operator.read', 'operator.write'] } }
    }));

    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const originalWebSocket = globalThis.WebSocket;
    class FakeWebSocket {
      private listeners = new Map<string, Array<(event: { data?: string; code?: number; reason?: string }) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test-nonce' } })
        }));
      }

      addEventListener(type: string, listener: (event: { data?: string; code?: number; reason?: string }) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      send(raw: string) {
        const frame = JSON.parse(raw) as { id: string; method: string; params: Record<string, unknown> };
        sent.push({ method: frame.method, params: frame.params });
        const payload = frame.method === 'chat.send'
          ? { runId: 'gateway-run-1', status: 'started' }
          : frame.method === 'chat.history'
              ? { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'gateway reply text' }] }] }
              : { ok: true };
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({ type: 'res', id: frame.id, ok: true, payload })
        }));
        if (frame.method === 'chat.send') {
          queueMicrotask(() => this.emit('message', {
            data: JSON.stringify({
              type: 'event',
              event: 'chat',
              payload: {
                runId: 'gateway-run-1',
                sessionKey: 'agent:jay:lifeos-home:current-thread',
                seq: 1,
                state: 'final'
              }
            })
          }));
        }
      }

      close() {}

      private emit(type: string, event: { data?: string; code?: number; reason?: string }) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const config = {
      openclawAdapter: 'gateway',
      openclawCliDrainTimeoutMs: 1000,
      openclawGatewayUrl: 'ws://127.0.0.1:18789',
      openclawDeviceIdentityPath: identityPath,
      openclawDeviceAuthPath: authPath,
      openclawDeliverReply: true,
      openclawReplyChannel: 'telegram',
      openclawReplyTo: 'telegram:1234',
      assistantId: 'jay',
      openclawSessionKey: 'agent:jay:telegram:default:direct:brian',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;
    const lifeOSEvent = {
      ...shareEvent(),
      assistant: 'jay',
      request_id: 'gateway-idempotency-key',
      session_key: 'agent:jay:lifeos-home:current-thread'
    };

    try {
      await acceptForOpenClaw(config, lifeOSEvent);
      let replyText: string | undefined;
      expect(
        await drainOpenClawQueue(config, {
          afterDelivered: async (_event, result) => {
            replyText = result.replyText;
          }
        })
      ).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
      expect(replyText).toBe('gateway reply text');
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }

    const chatRequest = sent.find((item) => item.method === 'chat.send');
    expect(chatRequest?.params).toMatchObject({
      agentId: 'jay',
      sessionKey: 'agent:jay:lifeos-home:current-thread',
      deliver: false,
      idempotencyKey: 'gateway-idempotency-key'
    });
    expect(chatRequest?.params).not.toHaveProperty('model');
    expect(chatRequest?.params).not.toHaveProperty('replyChannel');
    expect(chatRequest?.params).not.toHaveProperty('replyTo');
    expect(sent.map((item) => item.method)).toEqual(['connect', 'chat.send', 'chat.history']);
    await rm(dir, { recursive: true, force: true });
  });

  it('delivers a LifeOS capture to its captured conversation session', async () => {
    const dir = join(tmpdir(), `claw-bridge-lifeos-session-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const argsPath = join(dir, 'args.txt');
    await writeFile(binPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\n`, 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;
    const lifeOSEvent = {
      ...shareEvent(),
      session_key: 'agent:jay:lifeos-home:thread-1'
    };

    await acceptForOpenClaw(config, lifeOSEvent);
    const queued = await readFile(queuePath, 'utf8');
    expect(queued).toContain('"session_key":"agent:jay:lifeos-home:thread-1"');

    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    const args = await readFile(argsPath, 'utf8');
    expect(args).toContain('--session-key');
    expect(args).toContain('agent:jay:lifeos-home:thread-1');
    expect(args).not.toContain('agent:openclaw:main');
    await rm(dir, { recursive: true, force: true });
  });

  it('preserves events accepted while a drain is rewriting the queue', async () => {
    const dir = join(tmpdir(), `claw-bridge-drain-race-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    await writeFile(binPath, `#!/bin/sh\nprintf '{"reply":"delivered reply text"}\\n'\n`, 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawWorkdir: dir,
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, event('first accepted message'));
    const secondEvent = {
      ...event('second accepted message'),
      request_id: 'second-request-id'
    };

    const drain = await drainOpenClawQueue(config, {
      afterDelivered: async () => {
        await acceptForOpenClaw(config, secondEvent);
      }
    });

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 1, archived: 1 });
    const queue = await readFile(queuePath, 'utf8');
    expect(queue).toContain('second accepted message');
    expect(queue).not.toContain('first accepted message');
    const archive = await readFile(archivePath, 'utf8');
    expect(archive).toContain('first accepted message');
    await rm(dir, { recursive: true, force: true });
  });

  it('does not double-deliver when two drain processes overlap', async () => {
    const dir = join(tmpdir(), `claw-bridge-drain-lock-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const deliveredPath = join(dir, 'delivered.txt');
    await writeFile(
      binPath,
      `#!/bin/sh\nprintf 'delivered\\n' >> '${deliveredPath}'\nsleep 0.2\nprintf '{"reply":"delivered reply text"}\\n'\n`,
      'utf8'
    );
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawWorkdir: dir,
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, event('deliver exactly once'));
    const results = await Promise.all([drainOpenClawQueue(config), drainOpenClawQueue(config)]);

    expect(results.reduce((sum, result) => sum + result.delivered, 0)).toBe(1);
    expect(results.filter((result) => result.skipped).length).toBe(1);
    const deliveredLines = (await readFile(deliveredPath, 'utf8')).split('\n').filter(Boolean);
    expect(deliveredLines).toHaveLength(1);
    const archiveLines = (await readFile(archivePath, 'utf8')).split('\n').filter(Boolean);
    expect(archiveLines).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('recovers a fresh orphan before concurrent startup drains without double-delivery', async () => {
    const dir = join(tmpdir(), `claw-bridge-dead-drain-lock-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const deliveredPath = join(dir, 'delivered.txt');
    await writeFile(binPath, `#!/bin/sh\nprintf 'delivered\\n' >> '${deliveredPath}'\nsleep 0.2\n`, 'utf8');
    await chmod(binPath, 0o755);

    const exitedPid = await exitedProcessPid();

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawWorkdir: dir,
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, event('recover after process exit'));
    await writeFile(`${queuePath}.drain.lock`, `${exitedPid} ${new Date().toISOString()}\n`, 'utf8');

    expect(await recoverFreshOrphanedDrainLockForExclusiveOwner(queuePath)).toBe(true);
    const results = await Promise.all([drainOpenClawQueue(config), drainOpenClawQueue(config)]);

    expect(results.reduce((sum, result) => sum + result.delivered, 0)).toBe(1);
    expect(results.filter((result) => result.skipped)).toHaveLength(1);
    expect((await readFile(deliveredPath, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);
    expect((await readFile(archivePath, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves old orphaned locks to the ordinary stale-lock recovery path', async () => {
    const dir = join(tmpdir(), `claw-bridge-old-drain-lock-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const deliveredPath = join(dir, 'delivered.txt');
    const lockPath = `${queuePath}.drain.lock`;
    await writeFile(binPath, `#!/bin/sh\nprintf 'delivered\\n' >> '${deliveredPath}'\n`, 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawWorkdir: dir,
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, event('recover through ordinary stale path'));
    const exitedPid = await exitedProcessPid();
    await writeFile(lockPath, `${exitedPid} ${new Date().toISOString()}\n`, 'utf8');
    const oldTimestamp = new Date(Date.now() - 31 * 60 * 1000);
    await utimes(lockPath, oldTimestamp, oldTimestamp);

    expect(await recoverFreshOrphanedDrainLockForExclusiveOwner(queuePath)).toBe(false);
    expect(await readFile(lockPath, 'utf8')).toContain(String(exitedPid));
    expect(await drainOpenClawQueue(config)).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    expect((await readFile(deliveredPath, 'utf8')).trim()).toBe('delivered');
    await rm(dir, { recursive: true, force: true });
  });

  it('can deliver queued events through the Telegram direct session', async () => {
    const dir = join(tmpdir(), `claw-bridge-telegram-drain-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const argsPath = join(dir, 'args.txt');
    await writeFile(binPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\n`, 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawCliThinking: 'minimal',
      openclawDeliverReply: true,
      openclawReplyChannel: 'telegram',
      openclawReplyTo: 'telegram:1234',
      openclawMessageStyle: 'compact',
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:telegram:default:direct:user',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, eventWithLocationAndMemo('please find a burrito place nearby'));
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    const args = await readFile(argsPath, 'utf8');
    expect(args).toContain('--session-key');
    expect(args).toContain('agent:openclaw:telegram:default:direct:user');
    expect(args).toContain('--message');
    expect(args).toContain('Sent via voice message: please find a burrito place nearby');
    expect(args).toContain('Shared item:');
    expect(args).toContain('Kind: audio');
    expect(args).toContain('File path: /tmp/Latest memo.m4a');
    expect(args).toContain('Location: 33.6001, -111.9002');
    expect(args).toContain('Accuracy: 8m');
    expect(args).toContain('Location timestamp: 2026-06-13T15:59:55.000Z');
    expect(args).toContain('Location age: 5s');
    expect(args).toContain('Map: https://maps.apple.com/?ll=33.6001,-111.9002');
    expect(args).toContain('Voice memo attached:');
    expect(args).toContain('Transcript: this is the voice memo transcript');
    expect(args).toContain('--deliver');
    expect(args).toContain('--reply-channel');
    expect(args).toContain('telegram');
    expect(args).toContain('--reply-to');
    expect(args).toContain('telegram:1234');
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps replies for LifeOS captures in their originating LifeOS session', async () => {
    const dir = join(tmpdir(), `claw-bridge-lifeos-session-reply-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const argsPath = join(dir, 'args.txt');
    await writeFile(binPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\n`, 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawDeliverReply: true,
      openclawReplyChannel: 'telegram',
      openclawReplyTo: 'telegram:1234',
      openclawMessageStyle: 'compact',
      assistantId: 'jay',
      openclawSessionKey: 'agent:jay:telegram:default:direct:brian',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, lifeOSAppVoiceEvent());
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    const args = await readFile(argsPath, 'utf8');
    expect(args).toContain('agent:jay:lifeos-home:current-conversation');
    expect(args).not.toContain('--deliver');
    expect(args).not.toContain('--reply-channel');
    expect(args).not.toContain('--reply-to');
    expect(args).not.toContain('telegram:1234');
    await rm(dir, { recursive: true, force: true });
  });

  it('routes a delayed Watch capture to the most recent LifeOS Home thread', async () => {
    const dir = join(tmpdir(), `claw-bridge-watch-recent-lifeos-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const argsPath = join(dir, 'args.txt');
    const sessionStorePath = join(dir, 'sessions.json');
    const olderTranscriptPath = join(dir, 'older.jsonl');
    const currentTranscriptPath = join(dir, 'current.jsonl');
    await writeFile(olderTranscriptPath, `${directLifeOSUserMessage('2026-07-19T18:00:00Z', 'Older')}\n`, 'utf8');
    await writeFile(currentTranscriptPath, `${directLifeOSUserMessage('2026-07-19T19:00:00Z', 'Current')}\n`, 'utf8');
    await writeFile(
      sessionStorePath,
      JSON.stringify({
        'agent:jay:lifeos-home:older': { updatedAt: 100, sessionFile: olderTranscriptPath },
        'agent:jay:telegram:default:direct:brian': { updatedAt: 900 },
        'agent:jay:lifeos-home:archived': { updatedAt: 500, archivedAt: '2026-07-14T00:00:00Z' },
        'agent:jay:lifeos-home:current': { updatedAt: 300, sessionFile: currentTranscriptPath }
      }),
      'utf8'
    );
    await writeFile(
      binPath,
      `#!/bin/sh
if [ "$1" = "sessions" ]; then
  exit 41
fi
printf '%s\n' "$@" > '${argsPath}'
`,
      'utf8'
    );
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawDeliverReply: true,
      openclawReplyChannel: 'telegram',
      openclawReplyTo: 'telegram:1234',
      openclawMessageStyle: 'compact',
      assistantId: 'jay',
      openclawSessionStorePath: sessionStorePath,
      openclawSessionKey: 'agent:jay:telegram:default:direct:brian',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;
    const watchEvent = {
      ...watchEventWithoutLocation('keep this in the current thread'),
      request_id: 'watch-recent-lifeos-request-id',
      session_key: 'agent:jay:lifeos-home:stale-captured-thread'
    };

    await acceptForOpenClaw(config, watchEvent);
    expect(await drainOpenClawQueue(config)).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });

    const args = await readFile(argsPath, 'utf8');
    expect(args).toContain('--session-key');
    expect(args).toContain('agent:jay:lifeos-home:current');
    expect(args).not.toContain('agent:jay:lifeos-home:older');
    expect(args).not.toContain('agent:jay:lifeos-home:stale-captured-thread');
    expect(args).not.toContain('--deliver');
    expect(args).not.toContain('telegram:1234');
    const archiveRecord = JSON.parse((await readFile(archivePath, 'utf8')).trim()) as {
      event: NormalizedSiriEvent;
    };
    expect(archiveRecord.event.session_key).toBe('agent:jay:lifeos-home:current');
    await rm(dir, { recursive: true, force: true });
  });

  it('routes a delayed share-sheet capture away from a stale QA thread', async () => {
    const dir = join(tmpdir(), `claw-bridge-share-current-lifeos-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const argsPath = join(dir, 'args.txt');
    const sessionStorePath = join(dir, 'sessions.json');
    const currentTranscriptPath = join(dir, 'current.jsonl');
    await writeFile(
      currentTranscriptPath,
      `${directLifeOSUserMessage('2026-07-19T19:00:00Z', 'Current')}\n`,
      'utf8'
    );
    await writeFile(
      sessionStorePath,
      JSON.stringify({
        'agent:jay:lifeos-home:current': { updatedAt: 300, sessionFile: currentTranscriptPath },
        'agent:jay:lifeos-home:qa:expertise-phoenix': { updatedAt: 900 }
      }),
      'utf8'
    );
    await writeFile(binPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\n`, 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawDeliverReply: true,
      assistantId: 'jay',
      openclawSessionStorePath: sessionStorePath,
      openclawSessionKey: 'agent:jay:telegram:default:direct:brian',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;
    const delayedShare = {
      ...lifeOSSaveUrlEvent(),
      request_id: 'share-current-lifeos-request-id',
      session_key: 'agent:jay:lifeos-home:qa:expertise-phoenix'
    };

    await acceptForOpenClaw(config, delayedShare);
    expect(await drainOpenClawQueue(config)).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });

    const args = await readFile(argsPath, 'utf8');
    expect(args).toContain('agent:jay:lifeos-home:current');
    expect(args).not.toContain('agent:jay:lifeos-home:qa:expertise-phoenix');
    const archiveRecord = JSON.parse((await readFile(archivePath, 'utf8')).trim()) as {
      event: NormalizedSiriEvent;
    };
    expect(archiveRecord.event.session_key).toBe('agent:jay:lifeos-home:current');
    await rm(dir, { recursive: true, force: true });
  });

  it('routes iPhone LifeOS voice to the most recent LifeOS Home thread instead of Telegram', async () => {
    const dir = join(tmpdir(), `claw-bridge-iphone-recent-lifeos-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const argsPath = join(dir, 'args.txt');
    const sessionStorePath = join(dir, 'sessions.json');
    const olderTranscriptPath = join(dir, 'older.jsonl');
    const currentTranscriptPath = join(dir, 'current.jsonl');
    await writeFile(olderTranscriptPath, `${directLifeOSUserMessage('2026-07-19T18:00:00Z', 'Older')}\n`, 'utf8');
    await writeFile(currentTranscriptPath, `${directLifeOSUserMessage('2026-07-19T19:00:00Z', 'Current')}\n`, 'utf8');
    await writeFile(
      sessionStorePath,
      JSON.stringify({
        'agent:jay:lifeos-home:older': { updatedAt: 100, sessionFile: olderTranscriptPath },
        'agent:jay:telegram:default:direct:brian': { updatedAt: 900 },
        'agent:jay:lifeos-home:current': { updatedAt: 300, sessionFile: currentTranscriptPath }
      }),
      'utf8'
    );
    await writeFile(
      binPath,
      `#!/bin/sh
printf '%s\n' "$@" > '${argsPath}'
`,
      'utf8'
    );
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawDeliverReply: true,
      openclawReplyChannel: 'telegram',
      openclawReplyTo: 'telegram:1234',
      openclawMessageStyle: 'compact',
      assistantId: 'jay',
      openclawSessionStorePath: sessionStorePath,
      openclawSessionKey: 'agent:jay:telegram:default:direct:brian',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;
    const event = {
      ...lifeOSAppVoiceEvent(),
      request_id: 'iphone-recent-lifeos-request-id',
      session_key: undefined
    };

    await acceptForOpenClaw(config, event);
    expect(await drainOpenClawQueue(config)).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });

    const args = await readFile(argsPath, 'utf8');
    expect(args).toContain('--session-key');
    expect(args).toContain('agent:jay:lifeos-home:current');
    expect(args).not.toContain('agent:jay:telegram:default:direct:brian');
    expect(args).not.toContain('--deliver');
    expect(args).not.toContain('telegram:1234');
    const archiveRecord = JSON.parse((await readFile(archivePath, 'utf8')).trim()) as {
      event: NormalizedSiriEvent;
    };
    expect(archiveRecord.event.session_key).toBe('agent:jay:lifeos-home:current');
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps a Watch capture queued rather than falling back when no LifeOS Home thread exists', async () => {
    const dir = join(tmpdir(), `claw-bridge-watch-no-lifeos-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const agentAttemptPath = join(dir, 'agent-attempted.txt');
    const sessionStorePath = join(dir, 'sessions.json');
    await writeFile(
      sessionStorePath,
      JSON.stringify({
        'agent:jay:telegram:default:direct:brian': { updatedAt: 900 },
        'agent:jay:lifeos-home:archived': { updatedAt: 800, archivedAt: '2026-07-14T00:00:00Z' }
      }),
      'utf8'
    );
    await writeFile(
      binPath,
      `#!/bin/sh
if [ "$1" = "sessions" ]; then
  printf '%s\n' '{"path":"${sessionStorePath}","sessions":[]}'
  exit 0
fi
printf 'unexpected' > '${agentAttemptPath}'
`,
      'utf8'
    );
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      assistantId: 'jay',
      openclawSessionKey: 'agent:jay:telegram:default:direct:brian',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;
    const watchEvent = {
      ...watchEventWithoutLocation('do not create a fallback thread'),
      request_id: 'watch-no-lifeos-request-id',
      session_key: undefined
    };

    await acceptForOpenClaw(config, watchEvent);
    expect(await drainOpenClawQueue(config)).toEqual({ delivered: 0, failed: 0, pending: 1, archived: 0 });
    expect(await readFile(queuePath, 'utf8')).toContain(
      'No existing direct Brian-authored LifeOS Home conversation is available'
    );
    await expect(readFile(agentAttemptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps Watch no-location receipts private while delivering only the transcript', async () => {
    const dir = join(tmpdir(), `claw-bridge-watch-receipt-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const messagePath = join(dir, 'message.txt');
    await writeMessageCapturingOpenClaw(binPath, messagePath);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawMessageStyle: 'compact',
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, watchEventWithoutLocation());
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    const delivered = parseNativeVoiceDelivery(await readFile(messagePath, 'utf8'));
    expect(delivered.transcript).toBe('voice note without gps');
    expect(delivered.context).toMatchObject({
      schemaVersion: 'lifeos_model_context.v1',
      appSurface: 'ios_lifeos',
      source: { kind: 'voice', captureSurface: 'watch', transcript: 'voice note without gps' },
      location: { status: 'unavailable', reason: 'location_timeout' }
    });
    const archiveRecord = JSON.parse((await readFile(archivePath, 'utf8')).trim()) as {
      event: NormalizedSiriEvent;
    };
    expect(archiveRecord.event).toMatchObject({
      capture_receipt: { no_location_reason: 'location_timeout' },
      shared_item: {
        kind: 'audio',
        filename: 'Latest memo.m4a',
        mime_type: 'audio/mp4',
        file_path: '/tmp/Latest memo.m4a',
        size_bytes: 1234
      },
      voice_memo: {
        filename: 'Latest memo.m4a',
        mime_type: 'audio/mp4',
        file_path: '/tmp/Latest memo.m4a',
        size_bytes: 1234
      }
    });
    await rm(dir, { recursive: true, force: true });
  });

  it('delivers ordinary Watch voice with one compact current-location line', async () => {
    const dir = join(tmpdir(), `claw-bridge-watch-location-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const messagePath = join(dir, 'message.txt');
    await writeMessageCapturingOpenClaw(binPath, messagePath);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawMessageStyle: 'compact',
      assistantId: 'jay',
      openclawSessionKey: 'agent:jay:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;
    const event = {
      ...watchEventWithoutLocation('Find coffee near me'),
      location: {
        latitude: 33.6001,
        longitude: -111.9002,
        altitude: 420.5,
        horizontal_accuracy: 8,
        location_timestamp: '2026-07-13T20:11:57.000Z',
        location_age_seconds: 3,
        maps_url: 'https://maps.apple.com/?ll=33.6001,-111.9002'
      },
      capture_receipt: { audio_duration_seconds: 2.4 }
    } satisfies NormalizedSiriEvent;

    await acceptForOpenClaw(config, event);
    expect(await drainOpenClawQueue(config)).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    const delivered = parseNativeVoiceDelivery(await readFile(messagePath, 'utf8'));
    expect(delivered.transcript).toBe('Find coffee near me');
    expect(delivered.context).toMatchObject({
      source: { kind: 'voice', durationMs: 2400, captureSurface: 'watch' },
      location: {
        status: 'present',
        latitude: 33.6001,
        longitude: -111.9002,
        accuracyMeters: 8,
        mapsUrl: 'https://maps.apple.com/?ll=33.6001,-111.9002'
      }
    });

    const archiveRecord = JSON.parse((await readFile(archivePath, 'utf8')).trim()) as {
      event: NormalizedSiriEvent;
    };
    expect(archiveRecord.event).toMatchObject({
      source: 'watch_app',
      location: event.location,
      capture_receipt: { audio_duration_seconds: 2.4 },
      shared_item: { file_path: '/tmp/Latest memo.m4a' },
      voice_memo: { file_path: '/tmp/Latest memo.m4a' }
    });
    await rm(dir, { recursive: true, force: true });
  });

  it('passes Golf Mode as source context without classifying the shot', async () => {
    const dir = join(tmpdir(), `claw-bridge-golf-context-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const messagePath = join(dir, 'message.txt');
    await writeMessageCapturingOpenClaw(binPath, messagePath);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawMessageStyle: 'compact',
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, golfWatchEvent());
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    const delivered = parseNativeVoiceDelivery(await readFile(messagePath, 'utf8'));
    expect(delivered.transcript).toBe('hitting 7 iron from here');
    expect(delivered.context).toMatchObject({
      source: { kind: 'voice', captureSurface: 'watch', context: 'golf_mode' },
      location: { status: 'present', latitude: 33.5979, longitude: -111.7581, accuracyMeters: 4 }
    });
    await rm(dir, { recursive: true, force: true });
  });

  it('uses the iOS share sheet prefix for compact shared items', async () => {
    const dir = join(tmpdir(), `claw-bridge-share-prefix-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const argsPath = join(dir, 'args.txt');
    await writeFile(binPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\n`, 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawMessageStyle: 'compact',
      voiceMessagePrefix: 'Wrong voice prefix:',
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:telegram:default:direct:user',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, shareEvent());
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    const args = await readFile(argsPath, 'utf8');
    expect(args).toContain('Sent via iOS share sheet: screenshot OCR text');
    expect(args).not.toContain('Wrong voice prefix:');
    expect(args).not.toContain('Sent via iOS share sheet: Shared from iOS share sheet:');
    expect(args).toContain('Shared item:');
    expect(args).toContain('Title: IMG_8055');
    await rm(dir, { recursive: true, force: true });
  });

  it('strips generated iPhone share sheet prose in compact shared messages', async () => {
    const dir = join(tmpdir(), `claw-bridge-share-prose-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const argsPath = join(dir, 'args.txt');
    await writeFile(binPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\n`, 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawMessageStyle: 'compact',
      voiceMessagePrefix: 'Wrong voice prefix:',
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:telegram:default:direct:user',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, shareEvent('Shared via iPhone share sheet: https://example.com/post'));
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    const args = await readFile(argsPath, 'utf8');
    expect(args).toContain('Sent via iOS share sheet: https://example.com/post');
    expect(args).not.toContain('Sent via iOS share sheet: Shared via iPhone share sheet:');
    expect(args).not.toContain('Wrong voice prefix:');
    await rm(dir, { recursive: true, force: true });
  });

  it('delivers native LifeOS iPhone voice as transcript only while archiving private audio provenance', async () => {
    for (const style of ['compact', 'detailed'] as const) {
      const dir = join(tmpdir(), `claw-bridge-lifeos-app-voice-${style}-test-${Date.now()}`);
      await mkdir(dir, { recursive: true });
      const queuePath = join(dir, 'queue.jsonl');
      const archivePath = join(dir, 'queue.archive.jsonl');
      const binPath = join(dir, 'fake-openclaw');
      const messagePath = join(dir, 'message.txt');
      await writeMessageCapturingOpenClaw(binPath, messagePath);

      const config = {
        openclawAdapter: 'cli',
        openclawCliBin: binPath,
        openclawCliDrainTimeoutMs: 1000,
        openclawMessageStyle: style,
        assistantId: 'jay',
        openclawSessionKey: 'agent:jay:main',
        queuePath,
        queueArchivePath: archivePath,
        queueMaxAttempts: 3
      } as BridgeConfig;

      await acceptForOpenClaw(config, lifeOSAppVoiceEvent());
      expect(await drainOpenClawQueue(config)).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });

      const delivered = parseNativeVoiceDelivery(await readFile(messagePath, 'utf8'));
      expect(delivered.transcript).toBe('Remind me to order coffee filters');
      expect(delivered.context).toMatchObject({
        schemaVersion: 'lifeos_model_context.v1',
        createdAt: '2026-07-13T20:12:00.000Z',
        appSurface: 'ios_lifeos',
        source: {
          kind: 'voice',
          durationMs: 12400,
          transcript: 'Remind me to order coffee filters',
          captureId: 'lifeos-app-voice-request-id',
          captureSurface: 'iphone',
          talkBack: true,
          activeMode: false
        },
        location: {
          status: 'present',
          latitude: 33.6001,
          longitude: -111.9002,
          accuracyMeters: 7.5
        },
        attachments: [{ kind: 'audio', mimeType: 'audio/mp4', durationMs: 12400 }]
      });
      expect(await readFile(messagePath, 'utf8')).not.toContain('Current location:');

      const archiveRecord = JSON.parse((await readFile(archivePath, 'utf8')).trim()) as {
        event: NormalizedSiriEvent;
      };
      expect(archiveRecord.event).toMatchObject({
        source: 'lifeos_app_voice',
        raw_text: 'Remind me to order coffee filters',
        location: {
          latitude: 33.6001,
          longitude: -111.9002,
          altitude: 420.5,
          horizontal_accuracy: 7.5,
          location_timestamp: '2026-07-13T20:11:58.000Z',
          location_age_seconds: 2,
          maps_url: 'https://maps.apple.com/?ll=33.6001,-111.9002'
        },
        shared_item: {
          kind: 'audio',
          filename: 'lifeos-capture.m4a',
          mime_type: 'audio/mp4',
          file_path: '/private/lifeos/audio/lifeos-capture.m4a',
          size_bytes: 4321
        },
        voice_memo: {
          transcript: 'Remind me to order coffee filters',
          filename: 'lifeos-capture.m4a',
          mime_type: 'audio/mp4',
          file_path: '/private/lifeos/audio/lifeos-capture.m4a',
          size_bytes: 4321
        }
      });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('delivers native LifeOS Mac text without visible transport scaffolding', async () => {
    for (const style of ['compact', 'detailed'] as const) {
      const dir = join(tmpdir(), `claw-bridge-lifeos-mac-text-${style}-test-${Date.now()}`);
      await mkdir(dir, { recursive: true });
      const queuePath = join(dir, 'queue.jsonl');
      const archivePath = join(dir, 'queue.archive.jsonl');
      const binPath = join(dir, 'fake-openclaw');
      const messagePath = join(dir, 'message.txt');
      await writeMessageCapturingOpenClaw(binPath, messagePath);

      const config = {
        openclawAdapter: 'cli',
        openclawCliBin: binPath,
        openclawCliDrainTimeoutMs: 1000,
        openclawMessageStyle: style,
        assistantId: 'jay',
        openclawSessionKey: 'agent:jay:main',
        queuePath,
        queueArchivePath: archivePath,
        queueMaxAttempts: 3
      } as BridgeConfig;

      await acceptForOpenClaw(config, lifeOSMacTextEvent());
      expect(await drainOpenClawQueue(config)).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });

      const delivered = parseNativeVoiceDelivery(await readFile(messagePath, 'utf8'));
      expect(delivered.transcript).toBe('Turn on the living room lamp please.');
      expect(delivered.context).toMatchObject({
        schemaVersion: 'lifeos_model_context.v1',
        createdAt: '2026-07-20T22:02:15.000Z',
        appSurface: 'ios_lifeos',
        source: { kind: 'typed_text' },
        location: {
          status: 'present',
          latitude: 33.61028667343154,
          longitude: -111.85901093046989,
          accuracyMeters: 35
        },
        attachments: []
      });
      const message = await readFile(messagePath, 'utf8');
      expect(message).not.toContain('Sent via Siri voice message:');
      expect(message).not.toContain('Shared from iOS share sheet:');
      expect(message).not.toContain('Shared item:');
      expect(message).not.toContain('Location:');
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves the explicit LifeOS URL save action and provenance in compact messages', async () => {
    const dir = join(tmpdir(), `claw-bridge-lifeos-save-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const argsPath = join(dir, 'args.txt');
    await writeFile(binPath, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\n`, 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawMessageStyle: 'compact',
      assistantId: 'jay',
      openclawSessionKey: 'agent:jay:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, lifeOSSaveUrlEvent());
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    let args = await readFile(argsPath, 'utf8');
    expect(args).toContain('LifeOS save request via iOS share sheet: Why should I care about this?');
    expect(args).toContain('Capture action: Save to LifeOS');
    expect(args).toContain('Captured at: 2026-07-13T19:44:17.466Z');
    expect(args).toContain('Request id: lifeos-save-request-id');
    expect(args).toContain('URL: https://x.com/example/status/123?s=12&t=tracking');
    expect(args).not.toContain('Sent via iOS share sheet:');

    await acceptForOpenClaw(config, {
      ...lifeOSSaveUrlEvent('Direct Jay fallback'),
      request_id: 'direct-jay-request-id',
      session_key: undefined
    });
    const fallbackDrain = await drainOpenClawQueue(config);
    expect(fallbackDrain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    args = await readFile(argsPath, 'utf8');
    expect(args).toContain('Sent via iOS share sheet: Direct Jay fallback');
    expect(args).not.toContain('LifeOS save request via iOS share sheet:');
    expect(args).not.toContain('Capture action: Save to LifeOS');
    await rm(dir, { recursive: true, force: true });
  });

  it('marks queued events failed after the configured attempt limit', async () => {
    const dir = join(tmpdir(), `claw-bridge-failed-drain-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'failing-openclaw');
    await writeFile(binPath, '#!/bin/sh\necho nope >&2\nexit 2\n', 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 1
    } as BridgeConfig;

    await acceptForOpenClaw(config, event('this should fail visibly'));
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 0, failed: 1, pending: 0, archived: 1 });
    const queue = await readFile(queuePath, 'utf8');
    expect(queue).toBe('');
    const archive = await readFile(archivePath, 'utf8');
    expect(archive).toContain('"status":"failed"');
    expect(archive).toContain('openclaw exited 2');
    await rm(dir, { recursive: true, force: true });
  });

  it('does not retry OpenClaw delivery when the app response hook fails', async () => {
    const dir = join(tmpdir(), `claw-bridge-hook-failure-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const attemptsPath = join(dir, 'attempts.txt');
    await writeFile(
      binPath,
      `#!/bin/sh\necho attempt >> '${attemptsPath}'\nprintf '{"reply":"delivered reply text"}\\n'\n`,
      'utf8'
    );
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, event('this should reach OpenClaw once'));
    const drain = await drainOpenClawQueue(config, {
      afterDelivered: async () => {
        throw new Error('voice rendering failed');
      }
    });

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    const attempts = await readFile(attemptsPath, 'utf8');
    expect(attempts.trim().split('\n')).toHaveLength(1);
    const archive = await readFile(archivePath, 'utf8');
    expect(archive).toContain('"status":"delivered"');
    expect(archive).toContain('"attempts":1');
    await rm(dir, { recursive: true, force: true });
  });

  it('marks OpenClaw CLI timeouts failed without retrying side-effecting delivery', async () => {
    const dir = join(tmpdir(), `claw-bridge-timeout-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const archivePath = join(dir, 'queue.archive.jsonl');
    const binPath = join(dir, 'slow-openclaw');
    const attemptsPath = join(dir, 'attempts.txt');
    await writeFile(
      binPath,
      `#!/bin/sh\necho attempt >> '${attemptsPath}'\ntrap 'exit 143' TERM\nwhile true; do sleep 1; done\n`,
      'utf8'
    );
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 500,
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    let failedMessage = '';
    await acceptForOpenClaw(config, event('this should not retry after timeout'));
    const drain = await drainOpenClawQueue(config, {
      afterFailed: async (_event, error) => {
        failedMessage = error instanceof Error ? error.message : String(error);
      }
    });

    expect(drain).toEqual({ delivered: 0, failed: 1, pending: 0, archived: 1 });
    expect(failedMessage).toContain('openclaw delivery exceeded 500ms');
    const attempts = await readFile(attemptsPath, 'utf8');
    expect(attempts.trim().split('\n')).toHaveLength(1);
    const queue = await readFile(queuePath, 'utf8');
    expect(queue).toBe('');
    const archive = await readFile(archivePath, 'utf8');
    expect(archive).toContain('"status":"failed"');
    expect(archive).toContain('"attempts":1');
    expect(archive).toContain('not retrying because the agent attempt may have side effects');
    await rm(dir, { recursive: true, force: true });
  });
});
