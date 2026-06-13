import { describe, expect, it } from 'vitest';
import { loadConfig, parseAllowedSources } from '../src/config.js';

describe('config', () => {
  it('parses allowed sources', () => {
    expect([...parseAllowedSources('siri_watch, siri_iphone,,shortcuts')]).toEqual([
      'siri_watch',
      'siri_iphone',
      'shortcuts'
    ]);
  });

  it('requires a long bridge token', () => {
    expect(() => loadConfig({ SIRI_BRIDGE_TOKEN: 'short' })).toThrow('SIRI_BRIDGE_TOKEN');
  });

  it('requires HTTP ingest credentials when HTTP adapter is selected', () => {
    expect(() =>
      loadConfig({
        SIRI_BRIDGE_TOKEN: '0123456789abcdef01234567',
        OPENCLAW_ADAPTER: 'http'
      })
    ).toThrow('OPENCLAW_INGEST_URL and OPENCLAW_INGEST_TOKEN');
  });

  it('loads defaults for a CLI deployment', () => {
    const config = loadConfig({ SIRI_BRIDGE_TOKEN: '0123456789abcdef01234567' });
    expect(config.port).toBe(8788);
    expect(config.assistantId).toBe('jay');
    expect(config.allowedSources.has('siri_watch')).toBe(true);
    expect(config.openclawAdapter).toBe('cli');
    expect(config.openclawDeliverReply).toBe(false);
    expect(config.openclawMessageStyle).toBe('detailed');
    expect(config.queueArchivePath).toBe('./data/siri-queue.jsonl.archive');
    expect(config.allowedSources.has('ios_share_sheet')).toBe(true);
    expect(config.shareUploadDir).toBe('./data/uploads');
    expect(config.shareMaxUploadBytes).toBe(50 * 1024 * 1024);
    expect(config.audioTranscribeEnabled).toBe(false);
  });

  it('requires reply routing when OpenClaw delivery is enabled', () => {
    expect(() =>
      loadConfig({
        SIRI_BRIDGE_TOKEN: '0123456789abcdef01234567',
        OPENCLAW_DELIVER_REPLY: 'true'
      })
    ).toThrow('OPENCLAW_REPLY_CHANNEL and OPENCLAW_REPLY_TO');
  });

  it('loads Telegram direct reply routing', () => {
    const config = loadConfig({
      SIRI_BRIDGE_TOKEN: '0123456789abcdef01234567',
      OPENCLAW_DELIVER_REPLY: 'true',
      OPENCLAW_REPLY_CHANNEL: 'telegram',
      OPENCLAW_REPLY_TO: 'telegram:1234',
      OPENCLAW_MESSAGE_STYLE: 'compact',
      SIRI_MESSAGE_PREFIX: 'Sent via Apple Watch voice message:'
    });
    expect(config.openclawDeliverReply).toBe(true);
    expect(config.openclawReplyChannel).toBe('telegram');
    expect(config.openclawReplyTo).toBe('telegram:1234');
    expect(config.openclawMessageStyle).toBe('compact');
    expect(config.siriMessagePrefix).toBe('Sent via Apple Watch voice message:');
  });

  it('loads share upload and audio transcription settings', () => {
    const config = loadConfig({
      SIRI_BRIDGE_TOKEN: '0123456789abcdef01234567',
      SHARE_UPLOAD_DIR: '/tmp/share-uploads',
      SHARE_MAX_UPLOAD_BYTES: '1048576',
      AUDIO_TRANSCRIBE_ENABLED: 'true',
      AUDIO_TRANSCRIBE_CLI_BIN: '/opt/homebrew/bin/openclaw',
      AUDIO_TRANSCRIBE_TIMEOUT_MS: '600000',
      AUDIO_TRANSCRIBE_MODEL: 'openai-whisper/whisper-1',
      AUDIO_TRANSCRIBE_LANGUAGE: 'en'
    });
    expect(config.shareUploadDir).toBe('/tmp/share-uploads');
    expect(config.shareMaxUploadBytes).toBe(1048576);
    expect(config.audioTranscribeEnabled).toBe(true);
    expect(config.audioTranscribeCliBin).toBe('/opt/homebrew/bin/openclaw');
    expect(config.audioTranscribeTimeoutMs).toBe(600000);
    expect(config.audioTranscribeModel).toBe('openai-whisper/whisper-1');
    expect(config.audioTranscribeLanguage).toBe('en');
  });

  it('loads an explicit queue archive path', () => {
    const config = loadConfig({
      SIRI_BRIDGE_TOKEN: '0123456789abcdef01234567',
      QUEUE_PATH: '/tmp/siri-queue.jsonl',
      QUEUE_ARCHIVE_PATH: '/tmp/siri-queue.archive.jsonl'
    });
    expect(config.queuePath).toBe('/tmp/siri-queue.jsonl');
    expect(config.queueArchivePath).toBe('/tmp/siri-queue.archive.jsonl');
  });
});
