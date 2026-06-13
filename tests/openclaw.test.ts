import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { acceptForOpenClaw, drainOpenClawQueue } from '../src/openclaw.js';
import type { BridgeConfig, NormalizedSiriEvent } from '../src/types.js';

function event(text = 'remember dog food'): NormalizedSiriEvent {
  return {
    source: 'siri_watch',
    assistant: 'jay',
    raw_text: text,
    captured_at: new Date().toISOString(),
    request_id: 'test-request-id',
    device_name: 'Apple Watch',
    shortcut_name: 'Tell Jay'
  };
}

describe('OpenClaw delivery', () => {
  it('queues inbound Siri events immediately instead of blocking the request', async () => {
    const dir = join(tmpdir(), `openclaw-siri-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');

    const result = await acceptForOpenClaw(
      {
        openclawAdapter: 'cli',
        openclawCliBin: '/missing/openclaw',
        openclawCliDrainTimeoutMs: 120000,
        assistantId: 'jay',
        openclawSessionKey: 'agent:jay:main',
        queuePath,
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

  it('drains queued events through the OpenClaw CLI and marks them delivered', async () => {
    const dir = join(tmpdir(), `openclaw-siri-drain-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const binPath = join(dir, 'fake-openclaw');
    const argsPath = join(dir, 'args.txt');
    const cwdPath = join(dir, 'cwd.txt');
    await writeFile(binPath, `#!/bin/sh\npwd > '${cwdPath}'\nprintf '%s\\n' "$@" > '${argsPath}'\n`, 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      openclawCliThinking: 'minimal',
      openclawWorkdir: dir,
      assistantId: 'jay',
      openclawSessionKey: 'agent:jay:main',
      queuePath,
      queueMaxAttempts: 3
    } as BridgeConfig;

    await acceptForOpenClaw(config, event('drain this message'));
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 1, failed: 0, pending: 0 });
    const queue = await readFile(queuePath, 'utf8');
    expect(queue).toContain('"status":"delivered"');
    expect(queue).toContain('"attempts":1');
    const args = await readFile(argsPath, 'utf8');
    const cwd = await readFile(cwdPath, 'utf8');
    expect(args).toContain('--message');
    expect(args).toContain('Voice message from Siri/Shortcuts for jay');
    expect(args).toContain('drain this message');
    expect(args).toContain('--thinking');
    expect(args).toContain('minimal');
    expect(await realpath(cwd.trim())).toBe(await realpath(dir));
    await rm(dir, { recursive: true, force: true });
  });

  it('marks queued events failed after the configured attempt limit', async () => {
    const dir = join(tmpdir(), `openclaw-siri-failed-drain-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const queuePath = join(dir, 'queue.jsonl');
    const binPath = join(dir, 'failing-openclaw');
    await writeFile(binPath, '#!/bin/sh\necho nope >&2\nexit 2\n', 'utf8');
    await chmod(binPath, 0o755);

    const config = {
      openclawAdapter: 'cli',
      openclawCliBin: binPath,
      openclawCliDrainTimeoutMs: 1000,
      assistantId: 'jay',
      openclawSessionKey: 'agent:jay:main',
      queuePath,
      queueMaxAttempts: 1
    } as BridgeConfig;

    await acceptForOpenClaw(config, event('this should fail visibly'));
    const drain = await drainOpenClawQueue(config);

    expect(drain).toEqual({ delivered: 0, failed: 1, pending: 0 });
    const queue = await readFile(queuePath, 'utf8');
    expect(queue).toContain('"status":"failed"');
    expect(queue).toContain('openclaw exited 2');
    await rm(dir, { recursive: true, force: true });
  });
});
