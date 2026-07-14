import { describe, expect, it } from 'vitest';
import { normalizeShareSheetRequest } from '../src/share.js';
import type { BridgeConfig } from '../src/types.js';

const config = {
  assistantId: 'jay',
  maxMessageChars: 1200,
  allowedSources: new Set(['ios_share_sheet', 'lifeos_app_voice'])
} as BridgeConfig;

const audioFile = {
  path: '/private/lifeos/audio/native-capture.m4a',
  originalname: 'native-capture.m4a',
  mimetype: 'audio/mp4',
  size: 2048
};

describe('share normalization', () => {
  it('uses the native LifeOS voice transcript as raw text while retaining durable audio metadata', () => {
    const event = normalizeShareSheetRequest(
      config,
      {
        source: 'lifeos_app_voice',
        shortcut_name: 'LifeOS Voice Capture',
        device_name: 'Brian\u2019s iPhone',
        request_id: 'native-voice-id',
        latitude: '33.6001',
        longitude: '-111.9002',
        altitude: '420.5',
        horizontal_accuracy: '7.5',
        vertical_accuracy: '12',
        location_timestamp: '2026-07-13T19:59:58.000Z',
        location_age_seconds: '2',
        recording_duration_seconds: '12.4',
        maps_url: 'https://maps.apple.com/?ll=33.6001,-111.9002'
      },
      audioFile,
      'Pick up oat milk after work'
    );

    expect(event).toMatchObject({
      source: 'lifeos_app_voice',
      raw_text: 'Pick up oat milk after work',
      shortcut_name: 'LifeOS Voice Capture',
      location: {
        latitude: 33.6001,
        longitude: -111.9002,
        altitude: 420.5,
        horizontal_accuracy: 7.5,
        vertical_accuracy: 12,
        location_timestamp: '2026-07-13T19:59:58.000Z',
        location_age_seconds: 2,
        maps_url: 'https://maps.apple.com/?ll=33.6001,-111.9002'
      },
      shared_item: {
        kind: 'audio',
        filename: 'native-capture.m4a',
        mime_type: 'audio/mp4',
        file_path: '/private/lifeos/audio/native-capture.m4a',
        size_bytes: 2048
      },
      voice_memo: {
        transcript: 'Pick up oat milk after work',
        filename: 'native-capture.m4a',
        mime_type: 'audio/mp4',
        file_path: '/private/lifeos/audio/native-capture.m4a',
        size_bytes: 2048,
        duration_seconds: 12.4
      }
    });
  });

  it('fails closed when native LifeOS voice has no transcript', () => {
    expect(() =>
      normalizeShareSheetRequest(
        config,
        { source: 'lifeos_app_voice', shortcut_name: 'LifeOS Voice Capture' },
        audioFile,
        undefined
      )
    ).toThrow('lifeos_app_voice requires an audio transcript');
  });

  it('retains the reason privately when native voice has no location', () => {
    const event = normalizeShareSheetRequest(
      config,
      {
        source: 'lifeos_app_voice',
        shortcut_name: 'LifeOS Voice Capture',
        no_location_reason: 'permission_not_determined'
      },
      audioFile,
      'Where should I stop for groceries?'
    );

    expect(event.location).toBeUndefined();
    expect(event.capture_receipt).toEqual({ no_location_reason: 'permission_not_determined' });
  });

  it('rejects invalid native voice coordinates', () => {
    expect(() =>
      normalizeShareSheetRequest(
        config,
        { source: 'lifeos_app_voice', latitude: '133', longitude: '-111.9' },
        audioFile,
        'This location must not be accepted'
      )
    ).toThrow('location.latitude must be between -90 and 90');
  });
});
