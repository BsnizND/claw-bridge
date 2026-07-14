import request from 'supertest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { AppResponseStore } from '../src/app-response-store.js';
import { AppDeviceStore } from '../src/app-device-store.js';
import { createApp } from '../src/app.js';
import type { BridgeConfig } from '../src/types.js';

function config(): BridgeConfig {
  return {
    logLevel: 'silent',
    bridgeToken: '0123456789abcdef01234567',
    assistantId: 'openclaw',
    maxMessageChars: 1200,
    allowedSources: new Set(['siri_watch', 'siri_iphone', 'shortcuts', 'ios_share_sheet', 'lifeos_app_voice', 'watch_app']),
    shareUploadDir: join(tmpdir(), `claw-bridge-share-test-${Date.now()}`),
    shareMaxUploadBytes: 1024 * 1024,
    watchMinAudioSeconds: 1.5,
    watchMaxAudioSeconds: 120,
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

  it('registers app push devices with bearer auth', async () => {
    const deviceDir = join(tmpdir(), `claw-bridge-device-test-${Date.now()}`);
    const app = createApp(config(), { appDeviceStore: new AppDeviceStore(deviceDir) });
    const res = await request(app)
      .post('/app/devices/register')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .send({
        id: 'ios-test-device',
        platform: 'ios',
        push_token: 'a'.repeat(64),
        app_version: '1.0',
        device_name: 'iPhone'
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, device_id: 'ios-test-device', platform: 'ios' });

    const stored = await new AppDeviceStore(deviceDir).get('ios-test-device');
    expect(stored).toMatchObject({
      id: 'ios-test-device',
      platform: 'ios',
      push_token: 'a'.repeat(64),
      app_version: '1.0',
      device_name: 'iPhone'
    });
    expect(await new AppDeviceStore(deviceDir).list('ios')).toEqual([
      expect.objectContaining({ id: 'ios-test-device', platform: 'ios' })
    ]);
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
      .field('session_key', 'agent:jay:lifeos-home:thread-1')
      .field('location_json', '{"latitude":33.6,"longitude":-111.9}');

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, queued: true, id: 'share-id', spoken: 'Shared with openclaw' });
    expect(acceptEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'ios_share_sheet',
        session_key: 'agent:jay:lifeos-home:thread-1',
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

  it('rejects share session keys outside LifeOS Home before queueing', async () => {
    for (const sessionKey of ['agent:jay:lifeos-home:', 'agent:jay:telegram:default:direct:brian']) {
      const acceptEvent = vi.fn();
      const res = await request(createApp(config(), { acceptEvent }))
        .post('/shortcuts/share')
        .set('Authorization', 'Bearer 0123456789abcdef01234567')
        .field('shared_text', 'Keep this in the active conversation')
        .field('session_key', sessionKey);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('session_key must start with agent:jay:lifeos-home:');
      expect(acceptEvent).not.toHaveBeenCalled();
    }
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

  it('accepts native Watch voice uploads with location metadata', async () => {
    const acceptEvent = vi.fn().mockResolvedValue({ ok: true, queued: true, id: 'watch-voice-id' });
    const afterAccepted = vi.fn();
    const res = await request(createApp(config(), { acceptEvent, afterAccepted }))
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('request_id', 'watch-upload-request-id')
      .field('device_name', 'Apple Watch Ultra')
      .field('app_name', 'OpenClaw Watch')
      .field('session_key', 'agent:jay:lifeos-home:watch-thread-1')
      .field('captured_at', '2026-06-14T20:12:00.000Z')
      .field('recording_duration_seconds', '2.4')
      .field('source_context', 'golf_mode')
      .field('latitude', '33.6001')
      .field('longitude', '-111.9002')
      .field('horizontal_accuracy', '8')
      .field('location_timestamp', '2026-06-14T20:11:57.000Z')
      .field('location_age_seconds', '3')
      .field('maps_url', 'https://maps.apple.com/?ll=33.6001,-111.9002')
      .attach('audio', Buffer.from('audio-ish'), {
        filename: 'watch-message.m4a',
        contentType: 'audio/mp4'
      });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, queued: true, id: 'watch-upload-request-id' });
    expect(acceptEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'watch_app',
        session_key: 'agent:jay:lifeos-home:watch-thread-1',
        raw_text: 'Apple Watch voice message attached.',
        request_id: 'watch-upload-request-id',
        captured_at: '2026-06-14T20:12:00.000Z',
        device_name: 'Apple Watch Ultra',
        shortcut_name: 'OpenClaw Watch',
        source_context: 'golf_mode',
        location: expect.objectContaining({
          latitude: 33.6001,
          longitude: -111.9002,
          horizontal_accuracy: 8,
          location_timestamp: '2026-06-14T20:11:57.000Z',
          location_age_seconds: 3,
          maps_url: 'https://maps.apple.com/?ll=33.6001,-111.9002'
        }),
        shared_item: expect.objectContaining({
          kind: 'audio',
          filename: 'watch-message.m4a',
          mime_type: 'audio/mp4',
          size_bytes: 9,
          file_path: expect.stringContaining('watch-message.m4a')
        }),
        voice_memo: expect.objectContaining({
          filename: 'watch-message.m4a',
          mime_type: 'audio/mp4',
          duration_seconds: 2.4,
          size_bytes: 9,
          file_path: expect.stringContaining('watch-message.m4a')
        }),
        capture_receipt: expect.objectContaining({
          audio_duration_seconds: 2.4
        })
      })
    );
    expect(afterAccepted).toHaveBeenCalledWith(expect.objectContaining({ source: 'watch_app' }));
  });

  it('rejects Watch session keys outside LifeOS Home before queueing', async () => {
    for (const sessionKey of ['agent:jay:lifeos-home:', 'agent:jay:telegram:default:direct:brian']) {
      const acceptEvent = vi.fn();
      const res = await request(createApp(config(), { acceptEvent }))
        .post('/watch/voice')
        .set('Authorization', 'Bearer 0123456789abcdef01234567')
        .field('session_key', sessionKey)
        .field('recording_duration_seconds', '2.0')
        .attach('audio', Buffer.from('audio-ish'), {
          filename: 'watch-message.m4a',
          contentType: 'audio/mp4'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('session_key must start with agent:jay:lifeos-home:');
      expect(acceptEvent).not.toHaveBeenCalled();
    }
  });

  it('rejects unsupported Watch source context values', async () => {
    const acceptEvent = vi.fn();
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('source_context', 'shot_classifier')
      .field('recording_duration_seconds', '2.0')
      .attach('audio', Buffer.from('audio-ish'), {
        filename: 'watch-message.m4a',
        contentType: 'audio/mp4'
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('unsupported source_context');
    expect(acceptEvent).not.toHaveBeenCalled();
  });

  it('preserves Watch no-location reasons without inventing location', async () => {
    const acceptEvent = vi.fn().mockResolvedValue({ ok: true, queued: true, id: 'watch-voice-id' });
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('device_name', 'Apple Watch Ultra')
      .field('app_name', 'OpenClaw Watch')
      .field('captured_at', '2026-06-14T20:12:00.000Z')
      .field('recording_duration_seconds', '2.0')
      .field('no_location_reason', 'location_timeout')
      .attach('audio', Buffer.from('audio-ish'), {
        filename: 'watch-message.m4a',
        contentType: 'audio/mp4'
      });

    expect(res.status).toBe(202);
    const event = acceptEvent.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      source: 'watch_app',
      capture_receipt: {
        no_location_reason: 'location_timeout',
        audio_duration_seconds: 2
      }
    });
    expect(event.location).toBeUndefined();
  });

  it('creates a voice response record for native Watch walkie uploads', async () => {
    const acceptEvent = vi.fn().mockResolvedValue({ ok: true, queued: true, id: 'watch-voice-id' });
    const responseDir = join(tmpdir(), `claw-bridge-response-test-${Date.now()}`);
    const app = createApp(config(), {
      acceptEvent,
      appResponseStore: new AppResponseStore(responseDir, 60000)
    });
    const res = await request(app)
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('walkie_mode', 'true')
      .field('recording_duration_seconds', '2.0')
      .field('app_device_id', 'ios-test-device')
      .field('app_platform', 'ios')
      .attach('audio', Buffer.from('audio-ish'), {
        filename: 'watch-message.m4a',
        contentType: 'audio/mp4'
      });

    expect(res.status).toBe(202);
    expect(res.body.response_id).toEqual(expect.any(String));
    expect(res.body.response_status_url).toContain(`/app/responses/${res.body.response_id}`);
    expect(acceptEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        app_response: expect.objectContaining({ id: res.body.response_id, mode: 'voice', app_device_id: 'ios-test-device' })
      })
    );

    const status = await request(app)
      .get(`/app/responses/${res.body.response_id}`)
      .set('Authorization', 'Bearer 0123456789abcdef01234567');
    expect(status.status).toBe(200);
    expect(status.body.response).toMatchObject({
      id: res.body.response_id,
      status: 'pending',
      mode: 'voice',
      app_device_id: 'ios-test-device',
      app_platform: 'ios',
      notification_status: 'not_requested'
    });
  });

  it('reuses the voice response record for duplicate native Watch request ids', async () => {
    const acceptEvent = vi.fn().mockResolvedValue({ ok: true, queued: true, id: 'watch-voice-id' });
    const responseDir = join(tmpdir(), `claw-bridge-response-dedupe-test-${Date.now()}`);
    const app = createApp(config(), {
      acceptEvent,
      appResponseStore: new AppResponseStore(responseDir, 60000)
    });

    const first = await request(app)
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('request_id', 'same-watch-request')
      .field('walkie_mode', 'true')
      .field('recording_duration_seconds', '2.0')
      .field('app_device_id', 'ios-test-device')
      .field('app_platform', 'ios')
      .attach('audio', Buffer.from('audio-ish'), {
        filename: 'watch-message.m4a',
        contentType: 'audio/mp4'
      });
    const duplicate = await request(app)
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('request_id', 'same-watch-request')
      .field('walkie_mode', 'true')
      .field('recording_duration_seconds', '2.0')
      .field('app_device_id', 'ios-test-device')
      .field('app_platform', 'ios')
      .attach('audio', Buffer.from('audio-ish-again'), {
        filename: 'watch-message-copy.m4a',
        contentType: 'audio/mp4'
      });

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(duplicate.body.response_id).toBe(first.body.response_id);
  });

  it('serves completed app response audio with bearer auth', async () => {
    const responseDir = join(tmpdir(), `claw-bridge-ready-response-test-${Date.now()}`);
    const store = new AppResponseStore(responseDir, 60000);
    const app = createApp(config(), { appResponseStore: store });
    const record = await store.createPending({
      source: 'watch_app',
      assistant: 'openclaw',
      raw_text: 'hello',
      captured_at: new Date().toISOString(),
      request_id: 'ready-response-request'
    });
    const audioPath = store.audioPath(record.id, 'mp3');
    await writeFile(audioPath, Buffer.from('mp3-bytes'), { mode: 0o600 });
    await store.completeVoice(record.id, 'Jay says hello', audioPath, 'audio/mpeg');

    const status = await request(app)
      .get(`/app/responses/${record.id}`)
      .set('Authorization', 'Bearer 0123456789abcdef01234567');
    expect(status.status).toBe(200);
    expect(status.body.response).toMatchObject({
      status: 'ready',
      reply_text: 'Jay says hello',
      audio_mime_type: 'audio/mpeg',
      audio_size_bytes: 9
    });

    const audio = await request(app)
      .get(`/app/responses/${record.id}/audio`)
      .set('Authorization', 'Bearer 0123456789abcdef01234567');
    expect(audio.status).toBe(200);
    expect(audio.header['content-type']).toContain('audio/mpeg');
    expect(audio.body.toString()).toBe('mp3-bytes');
  });

  it('rejects unauthorized native Watch voice uploads', async () => {
    const res = await request(createApp(config()))
      .post('/watch/voice')
      .attach('audio', Buffer.from('audio-ish'), {
        filename: 'watch-message.m4a',
        contentType: 'audio/mp4'
      });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('rejects native Watch voice uploads without audio', async () => {
    const acceptEvent = vi.fn();
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('latitude', '33.6001')
      .field('longitude', '-111.9002');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('audio file is required');
    expect(acceptEvent).not.toHaveBeenCalled();
  });

  it('rejects too-short native Watch voice uploads before delivery', async () => {
    const acceptEvent = vi.fn();
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('recording_duration_seconds', '0.86')
      .attach('audio', Buffer.from('audio-ish'), {
        filename: 'watch-message.m4a',
        contentType: 'audio/mp4'
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('watch voice audio is too short');
    expect(acceptEvent).not.toHaveBeenCalled();
  });

  it('rejects too-long native Watch voice uploads before delivery', async () => {
    const acceptEvent = vi.fn();
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('recording_duration_seconds', '121.5')
      .attach('audio', Buffer.from('audio-ish'), {
        filename: 'watch-message.m4a',
        contentType: 'audio/mp4'
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('watch voice audio is too long');
    expect(acceptEvent).not.toHaveBeenCalled();
  });

  it('rejects native Watch voice uploads when duration is unknown', async () => {
    const acceptEvent = vi.fn();
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .attach('audio', Buffer.from('audio-ish'), {
        filename: 'watch-message.m4a',
        contentType: 'audio/mp4'
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('watch voice audio duration is required');
    expect(acceptEvent).not.toHaveBeenCalled();
  });

  it('rejects native Watch voice uploads with invalid location', async () => {
    const acceptEvent = vi.fn();
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .field('recording_duration_seconds', '2.0')
      .field('latitude', '133')
      .field('longitude', '-111.9002')
      .attach('audio', Buffer.from('audio-ish'), {
        filename: 'watch-message.m4a',
        contentType: 'audio/mp4'
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('location.latitude must be between -90 and 90');
    expect(acceptEvent).not.toHaveBeenCalled();
  });

  it('rejects non-audio native Watch uploads', async () => {
    const acceptEvent = vi.fn();
    const res = await request(createApp(config(), { acceptEvent }))
      .post('/watch/voice')
      .set('Authorization', 'Bearer 0123456789abcdef01234567')
      .attach('audio', Buffer.from('not audio'), {
        filename: 'watch-message.txt',
        contentType: 'text/plain'
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('audio upload must use an audio MIME type');
    expect(acceptEvent).not.toHaveBeenCalled();
  });

  it('does not expose unknown routes', async () => {
    const res = await request(createApp(config())).get('/logs');
    expect(res.status).toBe(404);
  });
});
