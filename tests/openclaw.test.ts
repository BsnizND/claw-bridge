import { chmod, mkdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { acceptForOpenClaw, drainOpenClawQueue, extractReplyTextFromOpenClawOutput } from '../src/openclaw.js';
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

function watchEventWithoutLocation(text = 'voice note without gps'): NormalizedSiriEvent {
  return {
    ...event(text),
    source: 'watch_app',
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

  it('passes Watch no-location capture receipts as metadata', async () => {
    const dir = join(tmpdir(), `claw-bridge-watch-receipt-test-${Date.now()}`);
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
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, watchEventWithoutLocation());
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    const args = await readFile(argsPath, 'utf8');
    expect(args).toContain('Sent via Apple Watch voice message: voice note without gps');
    expect(args).toContain('Capture receipt:');
    expect(args).toContain('No location reason: location_timeout');
    expect(args).not.toContain('Location:');
    await rm(dir, { recursive: true, force: true });
  });

  it('passes Golf Mode as source context without classifying the shot', async () => {
    const dir = join(tmpdir(), `claw-bridge-golf-context-test-${Date.now()}`);
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
      assistantId: 'openclaw',
      openclawSessionKey: 'agent:openclaw:main',
      queuePath,
      queueArchivePath: archivePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, golfWatchEvent());
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0, archived: 1 });
    const args = await readFile(argsPath, 'utf8');
    expect(args).toContain('Sent from Golf Mode via Apple Watch voice message: hitting 7 iron from here');
    expect(args).toContain('Source context: Golf Mode');
    expect(args).toContain('Location: 33.5979, -111.7581');
    expect(args).not.toContain('shot_type');
    expect(args).not.toContain('club_recommendation');
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
