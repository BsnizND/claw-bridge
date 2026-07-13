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
        request_id: 'native-voice-id'
      },
      audioFile,
      'Pick up oat milk after work'
    );

    expect(event).toMatchObject({
      source: 'lifeos_app_voice',
      raw_text: 'Pick up oat milk after work',
      shortcut_name: 'LifeOS Voice Capture',
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
        size_bytes: 2048
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
});
