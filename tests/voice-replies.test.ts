import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppResponseStore } from '../src/app-response-store.js';
import { synthesizeElevenLabsSpeech } from '../src/elevenlabs.js';
import { renderAppVoiceReply } from '../src/voice-replies.js';
import type { BridgeConfig, NormalizedSiriEvent } from '../src/types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function baseConfig(): BridgeConfig {
  return {
    elevenLabsApiKey: 'test-key',
    elevenLabsVoiceId: 'test-voice',
    elevenLabsModelId: 'eleven_multilingual_v2',
    elevenLabsOutputFormat: 'mp3_44100_128',
    elevenLabsBaseUrl: 'https://example.test'
  } as BridgeConfig;
}

function event(responseId: string): NormalizedSiriEvent {
  return {
    source: 'watch_app',
    assistant: 'openclaw',
    raw_text: 'hello',
    captured_at: new Date().toISOString(),
    request_id: 'voice-reply-request',
    app_response: { id: responseId, mode: 'voice' }
  };
}

describe('ElevenLabs voice replies', () => {
  it('synthesizes speech through the configured ElevenLabs endpoint', async () => {
    const dir = join(tmpdir(), `claw-bridge-tts-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(Buffer.from('audio'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      })
    );

    const result = await synthesizeElevenLabsSpeech(baseConfig(), 'hello Jay', join(dir, 'reply.mp3'));

    expect(result.byteLength).toBe(5);
    expect(await readFile(result.audioPath, 'utf8')).toBe('audio');
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'https://example.test/v1/text-to-speech/test-voice/stream?output_format=mp3_44100_128'
      }),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'xi-api-key': 'test-key'
        }),
        body: expect.stringContaining('hello Jay')
      })
    );
  });

  it('fails closed when ElevenLabs credentials are missing', async () => {
    await expect(synthesizeElevenLabsSpeech({ ...baseConfig(), elevenLabsApiKey: undefined }, 'hello', '/tmp/nope.mp3')).rejects.toThrow(
      'ELEVENLABS_API_KEY'
    );
  });

  it('marks app response records ready after rendering', async () => {
    const dir = join(tmpdir(), `claw-bridge-render-test-${Date.now()}`);
    const store = new AppResponseStore(dir, 60000);
    const pending = await store.createPending({
      source: 'watch_app',
      assistant: 'openclaw',
      raw_text: 'hello',
      captured_at: new Date().toISOString(),
      request_id: 'voice-reply-request'
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(Buffer.from('audio'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' }
      })
    );

    await renderAppVoiceReply(baseConfig(), store, event(pending.id), { ok: true, replyText: 'Jay reply' });

    const ready = await store.get(pending.id);
    expect(ready).toMatchObject({
      status: 'ready',
      reply_text: 'Jay reply',
      audio_mime_type: 'audio/mpeg',
      audio_size_bytes: 5
    });
  });

  it('marks app response records failed when reply text is missing', async () => {
    const dir = join(tmpdir(), `claw-bridge-render-fail-test-${Date.now()}`);
    const store = new AppResponseStore(dir, 60000);
    const pending = await store.createPending({
      source: 'watch_app',
      assistant: 'openclaw',
      raw_text: 'hello',
      captured_at: new Date().toISOString(),
      request_id: 'voice-reply-request'
    });

    await expect(renderAppVoiceReply(baseConfig(), store, event(pending.id), { ok: true })).rejects.toThrow(
      'did not return reply text'
    );
    const failed = await store.get(pending.id);
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'OpenClaw did not return reply text for voice rendering'
    });
  });
});
