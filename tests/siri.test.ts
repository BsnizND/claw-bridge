import { describe, expect, it } from 'vitest';
import { normalizeShortcutMessage } from '../src/siri.js';
import type { BridgeConfig } from '../src/types.js';

function config(): BridgeConfig {
  return {
    assistantId: 'jay',
    maxMessageChars: 120,
    allowedSources: new Set(['siri_watch', 'siri_iphone', 'shortcuts'])
  } as BridgeConfig;
}

describe('Siri shortcut normalization', () => {
  it('normalizes a valid shortcut message', () => {
    const event = normalizeShortcutMessage(config(), {
      message: ' remind me about the passport ',
      source: 'siri_watch',
      captured_at: '2026-06-13T16:00:00.000Z',
      device_name: 'Apple Watch',
      shortcut_name: 'Tell Jay',
      location: {
        latitude: '33.6001',
        longitude: '-111.9002',
        horizontal_accuracy: '12',
        maps_url: 'https://maps.apple.com/?ll=33.6001,-111.9002'
      },
      voice_memo: {
        transcript: 'memo transcript',
        filename: 'New Recording.m4a',
        duration_seconds: '42',
        recorded_at: '2026-06-13T15:58:00.000Z'
      }
    });

    expect(event).toMatchObject({
      source: 'siri_watch',
      assistant: 'jay',
      raw_text: 'remind me about the passport',
      captured_at: '2026-06-13T16:00:00.000Z',
      device_name: 'Apple Watch',
      shortcut_name: 'Tell Jay',
      location: {
        latitude: 33.6001,
        longitude: -111.9002,
        horizontal_accuracy: 12,
        maps_url: 'https://maps.apple.com/?ll=33.6001,-111.9002'
      },
      voice_memo: {
        transcript: 'memo transcript',
        filename: 'New Recording.m4a',
        duration_seconds: 42,
        recorded_at: '2026-06-13T15:58:00.000Z'
      }
    });
    expect(event.request_id).toBeTruthy();
  });

  it('rejects empty messages', () => {
    expect(() => normalizeShortcutMessage(config(), { message: '   ', source: 'siri_watch' })).toThrow(
      'message is required'
    );
  });

  it('rejects overlong messages', () => {
    expect(() => normalizeShortcutMessage(config(), { message: 'x'.repeat(121), source: 'siri_watch' })).toThrow(
      'message exceeds 120 characters'
    );
  });

  it('rejects unapproved sources', () => {
    expect(() => normalizeShortcutMessage(config(), { message: 'hello', source: 'unknown' })).toThrow(
      'source is not allowed'
    );
  });

  it('rejects partial or impossible coordinates', () => {
    expect(() =>
      normalizeShortcutMessage(config(), { message: 'hello', source: 'siri_watch', location: { latitude: 33 } })
    ).toThrow('location requires both latitude and longitude');

    expect(() =>
      normalizeShortcutMessage(config(), {
        message: 'hello',
        source: 'siri_watch',
        location: { latitude: 133, longitude: -111 }
      })
    ).toThrow('location.latitude must be between -90 and 90');
  });
});
