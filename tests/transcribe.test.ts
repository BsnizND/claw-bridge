import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { transcribeAudioFile } from '../src/transcribe.js';
import type { BridgeConfig } from '../src/types.js';

describe('audio transcription', () => {
  it('extracts OpenClaw nested transcription output text', async () => {
    const dir = join(tmpdir(), `claw-bridge-transcribe-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const binPath = join(dir, 'fake-openclaw');
    await writeFile(
      binPath,
      '#!/bin/sh\nprintf \'{"ok":true,"outputs":[{"text":"transcribed memo text","kind":"audio.transcription"}]}\\n\'\n',
      'utf8'
    );
    await chmod(binPath, 0o755);

    const transcript = await transcribeAudioFile(
      {
        audioTranscribeEnabled: true,
        audioTranscribeCliBin: binPath,
        audioTranscribeTimeoutMs: 1000
      } as BridgeConfig,
      '/tmp/example.m4a'
    );

    expect(transcript).toBe('transcribed memo text');
    await rm(dir, { recursive: true, force: true });
  });
});
