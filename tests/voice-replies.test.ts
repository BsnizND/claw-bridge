import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppResponseStore } from '../src/app-response-store.js';
import { synthesizeSpeechViaOpenClawGateway } from '../src/openclaw-gateway.js';
import { failAppVoiceReply, renderAppVoiceReply } from '../src/voice-replies.js';
import type { BridgeConfig, NormalizedSiriEvent } from '../src/types.js';

vi.mock('../src/openclaw-gateway.js', () => ({
  synthesizeSpeechViaOpenClawGateway: vi.fn()
}));

const synthesizeSpeech = vi.mocked(synthesizeSpeechViaOpenClawGateway);

beforeEach(() => {
  synthesizeSpeech.mockReset();
  synthesizeSpeech.mockResolvedValue({
    audio: Buffer.from('audio'),
    provider: 'openai',
    mimeType: 'audio/mpeg',
    fileExtension: 'mp3'
  });
});

function baseConfig(): BridgeConfig {
  return {
    openclawGatewayUrl: 'ws://127.0.0.1:18789',
    openclawDeviceIdentityPath: '/tmp/device.json',
    openclawDeviceAuthPath: '/tmp/device-auth.json',
    openclawCliDrainTimeoutMs: 120000
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

describe('OpenClaw-native voice replies', () => {
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
    await renderAppVoiceReply(baseConfig(), store, event(pending.id), { ok: true, replyText: 'Jay reply' });

    const ready = await store.get(pending.id);
    expect(ready).toMatchObject({
      status: 'ready',
      reply_text: 'Jay reply',
      audio_mime_type: 'audio/mpeg',
      audio_size_bytes: 5
    });
    expect(await readFile(store.audioPath(pending.id, 'mp3'), 'utf8')).toBe('audio');
    expect(synthesizeSpeech).toHaveBeenCalledWith({
      gatewayUrl: 'ws://127.0.0.1:18789',
      deviceIdentityPath: '/tmp/device.json',
      deviceAuthPath: '/tmp/device-auth.json',
      timeoutMs: 120000,
      text: 'Jay reply'
    });
  });

  it('keeps ready audio playable when APNs is not configured', async () => {
    const dir = join(tmpdir(), `claw-bridge-render-notification-test-${Date.now()}`);
    const store = new AppResponseStore(dir, 60000);
    const pending = await store.createPending({
      source: 'watch_app',
      assistant: 'openclaw',
      raw_text: 'hello',
      captured_at: new Date().toISOString(),
      request_id: 'voice-reply-request',
      app_response: { id: 'pending', mode: 'voice', app_device_id: 'ios-test-device', app_platform: 'ios' }
    });
    await renderAppVoiceReply(baseConfig(), store, event(pending.id), { ok: true, replyText: 'Jay reply' });

    const ready = await store.get(pending.id);
    expect(ready).toMatchObject({
      status: 'ready',
      notification_status: 'not_configured',
      notification_error: 'APNs is not configured'
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

  it('marks app response records failed when OpenClaw delivery fails', async () => {
    const dir = join(tmpdir(), `claw-bridge-render-delivery-fail-test-${Date.now()}`);
    const store = new AppResponseStore(dir, 60000);
    const pending = await store.createPending({
      source: 'watch_app',
      assistant: 'openclaw',
      raw_text: 'hello',
      captured_at: new Date().toISOString(),
      request_id: 'voice-reply-request'
    });

    await failAppVoiceReply(store, event(pending.id), new Error('openclaw delivery exceeded 360000ms'));

    const failed = await store.get(pending.id);
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'openclaw delivery exceeded 360000ms'
    });
  });
});
