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
        audioTranscribeEngine: 'openclaw',
        audioTranscribeCliBin: binPath,
        audioTranscribeTimeoutMs: 1000
      } as BridgeConfig,
      '/tmp/example.m4a'
    );

    expect(transcript).toBe('transcribed memo text');
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts local Whisper JSON without sending audio through OpenClaw', async () => {
    const dir = join(tmpdir(), `claw-bridge-local-whisper-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const binPath = join(dir, 'fake-whisper');
    await writeFile(
      binPath,
      '#!/bin/sh\ninput="$1"\nshift\nout=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output_dir" ]; then out="$2"; shift 2; else shift; fi\ndone\nbase=$(basename "$input" .m4a)\nprintf \'{"text":"local whisper memo"}\\n\' > "$out/$base.json"\n',
      'utf8'
    );
    await chmod(binPath, 0o755);
    const audioPath = join(dir, 'watch.m4a');
    await writeFile(audioPath, 'audio', 'utf8');

    const transcript = await transcribeAudioFile(
      {
        audioTranscribeEnabled: true,
        audioTranscribeEngine: 'local_whisper',
        audioTranscribeCliBin: binPath,
        audioTranscribeTimeoutMs: 1000,
        audioTranscribeModel: 'large-v3-turbo',
        audioTranscribeLanguage: 'en'
      } as BridgeConfig,
      audioPath
    );

    expect(transcript).toBe('local whisper memo');
    await rm(dir, { recursive: true, force: true });
  });
});
