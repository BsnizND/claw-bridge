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
    assistantId: 'openclaw',
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
    const afterAccepted = vi.fn();
    const res = await request(createApp(config(), { acceptEvent, afterAccepted }))
      .post('/shortcuts/message')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .send({ message: 'hello OpenClaw', source: 'siri_watch', device_name: 'Apple Watch' });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, queued: true, id: 'accepted-id', spoken: 'Sent to openclaw' });
    expect(acceptEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'siri_watch',
        raw_text: 'hello OpenClaw',
        device_name: 'Apple Watch'
      })
    );
    expect(afterAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: expect.any(String),
        raw_text: 'hello OpenClaw'
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
    const afterAccepted = vi.fn();
    const res = await request(createApp(config(), { acceptEvent, afterAccepted }))
      .post('/shortcuts/share')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('shared_text', 'This is worth remembering')
      .field('shared_url', 'https://example.com/article')
      .field('shared_title', 'Example Article')
      .field('location_json', '{"latitude":33.6,"longitude":-111.9}');

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, queued: true, id: 'share-id', spoken: 'Shared with openclaw' });
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
    expect(afterAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'ios_share_sheet',
        raw_text: 'Shared from iOS share sheet: This is worth remembering'
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

  it('accepts raw share sheet file body uploads', async () => {
    const acceptEvent = vi.fn().mockResolvedValue({ ok: true, queued: true, id: 'raw-file-share-id' });
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/shortcuts/share-file')
      .query({
        source: 'ios_share_sheet',
        shared_title: 'monarch-screenshot.png',
        shared_text: 'OCR text from screenshot',
        latitude: '33.6',
        longitude: '-111.9'
      })
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .set('Content-Type', 'image/png')
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, queued: true, id: 'raw-file-share-id' });
    expect(acceptEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        raw_text: 'Shared from iOS share sheet: OCR text from screenshot',
        location: expect.objectContaining({ latitude: 33.6, longitude: -111.9 }),
        shared_item: expect.objectContaining({
          kind: 'image',
          text: 'OCR text from screenshot',
          title: 'monarch-screenshot.png',
          filename: 'monarch-screenshot.png',
          mime_type: 'image/png',
          size_bytes: 4,
          file_path: expect.stringContaining('monarch-screenshot.png')
        })
      })
    );
  });

  it('sniffs raw image uploads when iOS sends an octet-stream content type', async () => {
    const acceptEvent = vi.fn().mockResolvedValue({ ok: true, queued: true, id: 'sniffed-image-id' });
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/shortcuts/share-file')
      .query({ source: 'ios_share_sheet', latitude: '33.6', longitude: '-111.9' })
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    expect(res.status).toBe(202);
    expect(acceptEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        raw_text: 'Shared file from iOS share sheet: shared-image.png',
        shared_item: expect.objectContaining({
          kind: 'image',
          filename: 'shared-image.png',
          mime_type: 'image/png',
          size_bytes: 8,
          file_path: expect.stringContaining('shared-image.png')
        })
      })
    );
  });

  it('returns a diagnostic error when a form-encoded share has no payload', async () => {
    const acceptEvent = vi.fn();
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/shortcuts/share')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .type('form')
      .send({ source: 'ios_share_sheet' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('rebuild the Shortcut');
    expect(acceptEvent).not.toHaveBeenCalled();
  });

  it('does not expose unknown routes', async () => {
    const res = await request(createApp(config())).get('/logs');
    expect(res.status).toBe(404);
  });
});
