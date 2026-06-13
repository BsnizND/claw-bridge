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
      shortcut_name: 'Tell Jay'
    });

    expect(event).toMatchObject({
      source: 'siri_watch',
      assistant: 'jay',
      raw_text: 'remind me about the passport',
      captured_at: '2026-06-13T16:00:00.000Z',
      device_name: 'Apple Watch',
      shortcut_name: 'Tell Jay'
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
});
