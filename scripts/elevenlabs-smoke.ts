import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BridgeConfig } from '../src/types.js';
import { synthesizeElevenLabsSpeech } from '../src/elevenlabs.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function redact(message: string): string {
  let output = message;
  for (const secret of [process.env.ELEVENLABS_API_KEY, process.env.ELEVENLABS_VOICE_ID]) {
    if (secret) {
      output = output.split(secret).join('[redacted]');
    }
  }
  return output;
}

async function main() {
  const startedAt = Date.now();
  const workDir = await mkdtemp(join(tmpdir(), 'claw-bridge-elevenlabs-smoke-'));
  const audioPath = join(workDir, 'reply.mp3');
  const keepAudio = process.env.ELEVENLABS_SMOKE_KEEP_AUDIO === '1';
  try {
    const config = {
      elevenLabsApiKey: requiredEnv('ELEVENLABS_API_KEY'),
      elevenLabsVoiceId: requiredEnv('ELEVENLABS_VOICE_ID'),
      elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
      elevenLabsOutputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128',
      elevenLabsBaseUrl: process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io'
    } as BridgeConfig;
    const text = process.env.ELEVENLABS_SMOKE_TEXT || 'Claw Bridge walkie talkie voice reply smoke test.';
    const speech = await synthesizeElevenLabsSpeech(config, text, audioPath);
    const bytes = await readFile(speech.audioPath);
    const result = {
      ok: true,
      provider: 'elevenlabs',
      mime_type: speech.mimeType,
      byte_length: speech.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      model_id: config.elevenLabsModelId,
      output_format: config.elevenLabsOutputFormat,
      elapsed_ms: Date.now() - startedAt,
      audio_path: keepAudio ? speech.audioPath : undefined
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (!keepAudio) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: redact(message) }, null, 2));
  process.exit(1);
});
