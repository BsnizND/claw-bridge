import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { shutdownPersistentWhisper } from '../src/persistent-whisper.js';
import { transcribeAudioFile } from '../src/transcribe.js';
import type { BridgeConfig } from '../src/types.js';

describe('audio transcription', () => {
  afterEach(() => {
    shutdownPersistentWhisper();
  });

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

  it('keeps a local Whisper worker warm across recordings', async () => {
    const dir = join(tmpdir(), `claw-bridge-persistent-whisper-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const workerPath = join(dir, 'fake-worker.mjs');
    await writeFile(
      workerPath,
      `import readline from 'node:readline';
process.stdout.write(JSON.stringify({type:'ready', model:'small.en', device:'mps', load_ms:12}) + '\\n');
const lines = readline.createInterface({input: process.stdin});
lines.on('line', (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({type:'result', id:request.id, text:'warm local transcript', duration_ms:42}) + '\\n');
});
lines.on('close', () => process.exit(0));
`,
      'utf8'
    );

    const config = {
      audioTranscribeEnabled: true,
      audioTranscribeEngine: 'local_whisper',
      audioTranscribeCliBin: '/unused/whisper',
      audioTranscribeTimeoutMs: 1000,
      audioTranscribeModel: 'small.en',
      audioTranscribeLanguage: 'en',
      audioTranscribePersistent: true,
      audioTranscribePythonBin: process.execPath,
      audioTranscribeDevice: 'mps',
      audioTranscribeWorkerPath: workerPath
    } as BridgeConfig;

    expect(await transcribeAudioFile(config, '/tmp/first.m4a')).toBe('warm local transcript');
    expect(await transcribeAudioFile(config, '/tmp/second.m4a')).toBe('warm local transcript');
    await rm(dir, { recursive: true, force: true });
  });
});
