import request from 'supertest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { BridgeConfig } from '../src/types.js';

function config(): BridgeConfig {
  return {
    logLevel: 'silent',
    siriBridgeToken: '0123456789abcdef01234567',
    assistantId: 'jay',
    maxMessageChars: 1200,
    allowedSources: new Set(['siri_watch', 'siri_iphone', 'shortcuts', 'ios_share_sheet']),
    shareUploadDir: join(tmpdir(), `openclaw-siri-share-test-${Date.now()}`),
    shareMaxUploadBytes: 1024 * 1024,
    audioTranscribeEnabled: false
  } as BridgeConfig;
}

describe('app routes', () => {
  it('serves health without sensitive details', async () => {
    const res = await request(createApp(config())).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects unauthorized shortcut calls', async () => {
    const res = await request(createApp(config())).post('/shortcuts/message').send({ message: 'hello' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(res.body.spoken).toBe('Not sent: unauthorized');
  });

  it('accepts and normalizes authorized shortcut messages', async () => {
    const acceptEvent = vi.fn().mockResolvedValue({ ok: true, queued: true, id: 'accepted-id' });
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/shortcuts/message')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .send({ message: 'hello Jay', source: 'siri_watch', device_name: 'Apple Watch' });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, queued: true, id: 'accepted-id', spoken: 'Sent to jay' });
    expect(acceptEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'siri_watch',
        raw_text: 'hello Jay',
        device_name: 'Apple Watch'
      })
    );
  });

  it('returns Shortcut-friendly spoken errors for invalid payloads', async () => {
    const res = await request(createApp(config()))
      .post('/shortcuts/message')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .send({ message: '', source: 'siri_watch' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'message is required' });
    expect(res.body.spoken).toContain('Not sent');
  });

  it('accepts share sheet text and URL payloads', async () => {
    const acceptEvent = vi.fn().mockResolvedValue({ ok: true, queued: true, id: 'share-id' });
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/shortcuts/share')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('shared_text', 'This is worth remembering')
      .field('shared_url', 'https://example.com/article')
      .field('shared_title', 'Example Article')
      .field('location_json', '{"latitude":33.6,"longitude":-111.9}');

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, queued: true, id: 'share-id', spoken: 'Shared with jay' });
    expect(acceptEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'ios_share_sheet',
        raw_text: 'Shared from iOS share sheet: This is worth remembering',
        location: expect.objectContaining({ latitude: 33.6, longitude: -111.9 }),
        shared_item: expect.objectContaining({
          kind: 'url',
          text: 'This is worth remembering',
          url: 'https://example.com/article',
          title: 'Example Article'
        })
      })
    );
  });

  it('accepts share sheet file uploads', async () => {
    const acceptEvent = vi.fn().mockResolvedValue({ ok: true, queued: true, id: 'file-share-id' });
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/shortcuts/share')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('source', 'ios_share_sheet')
      .attach('file', Buffer.from('audio-ish'), {
        filename: 'memo.m4a',
        contentType: 'audio/mp4'
      });

    expect(res.status).toBe(202);
    expect(acceptEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        shared_item: expect.objectContaining({
          kind: 'audio',
          filename: 'memo.m4a',
          mime_type: 'audio/mp4',
          size_bytes: 9
        }),
        voice_memo: expect.objectContaining({
          filename: 'memo.m4a',
          mime_type: 'audio/mp4',
          size_bytes: 9
        })
      })
    );
  });

  it('does not expose unknown routes', async () => {
    const res = await request(createApp(config())).get('/logs');
    expect(res.status).toBe(404);
  });
});
