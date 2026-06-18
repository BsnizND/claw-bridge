import { writeFile } from 'node:fs/promises';
import type { BridgeConfig } from './types.js';

export interface ElevenLabsSpeechResult {
  audioPath: string;
  mimeType: string;
  byteLength: number;
}

export async function synthesizeElevenLabsSpeech(
  config: BridgeConfig,
  text: string,
  audioPath: string
): Promise<ElevenLabsSpeechResult> {
  if (!config.elevenLabsApiKey) {
    throw new Error('ELEVENLABS_API_KEY is required for voice replies');
  }
  if (!config.elevenLabsVoiceId) {
    throw new Error('ELEVENLABS_VOICE_ID is required for voice replies');
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('reply text is required for voice synthesis');
  }

  const url = new URL(`/v1/text-to-speech/${encodeURIComponent(config.elevenLabsVoiceId)}/stream`, config.elevenLabsBaseUrl);
  url.searchParams.set('output_format', config.elevenLabsOutputFormat);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': config.elevenLabsApiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      text: trimmed,
      model_id: config.elevenLabsModelId
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 300)}` : '';
    throw new Error(`ElevenLabs TTS failed with HTTP ${response.status}${detail}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error('ElevenLabs TTS returned empty audio');
  }
  await writeFile(audioPath, bytes, { mode: 0o600 });
  return {
    audioPath,
    mimeType: response.headers.get('content-type')?.split(';', 1)[0] || 'audio/mpeg',
    byteLength: bytes.length
  };
}
