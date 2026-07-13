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
    expect(() => loadConfig({ CLAW_BRIDGE_TOKEN: 'short' })).toThrow('CLAW_BRIDGE_TOKEN');
  });

  it('requires HTTP ingest credentials when HTTP adapter is selected', () => {
    expect(() =>
      loadConfig({
        CLAW_BRIDGE_TOKEN: '0123456789abcdef01234567',
        OPENCLAW_ADAPTER: 'http'
      })
    ).toThrow('OPENCLAW_INGEST_URL and OPENCLAW_INGEST_TOKEN');
  });

  it('loads defaults for a CLI deployment', () => {
    const config = loadConfig({ CLAW_BRIDGE_TOKEN: '0123456789abcdef01234567' });
    expect(config.port).toBe(8788);
    expect(config.assistantId).toBe('openclaw');
    expect(config.allowedSources.has('siri_watch')).toBe(true);
    expect(config.openclawAdapter).toBe('cli');
    expect(config.openclawCliDrainTimeoutMs).toBe(360000);
    expect(config.openclawDeliverReply).toBe(false);
    expect(config.openclawMessageStyle).toBe('detailed');
    expect(config.queueArchivePath).toBe('./data/claw-bridge-queue.jsonl.archive');
    expect(config.allowedSources.has('ios_share_sheet')).toBe(true);
    expect(config.allowedSources.has('lifeos_app_voice')).toBe(true);
    expect(config.allowedSources.has('watch_app')).toBe(true);
    expect(config.shareUploadDir).toBe('./data/uploads');
    expect(config.shareMaxUploadBytes).toBe(50 * 1024 * 1024);
    expect(config.watchMinAudioSeconds).toBe(1.5);
    expect(config.watchMaxAudioSeconds).toBe(120);
    expect(config.appResponseDir).toBe('./data/app-responses');
    expect(config.appResponseTtlMs).toBe(24 * 60 * 60 * 1000);
    expect(config.elevenLabsModelId).toBe('eleven_v3');
    expect(config.elevenLabsOutputFormat).toBe('mp3_44100_128');
    expect(config.elevenLabsBaseUrl).toBe('https://api.elevenlabs.io');
    expect(config.appDeviceDir).toBe('./data/app-devices');
    expect(config.apnsEnvironment).toBe('development');
    expect(config.audioTranscribeEnabled).toBe(false);
  });

  it('loads app response, ElevenLabs, and APNs settings without requiring secrets by default', () => {
    const config = loadConfig({
      CLAW_BRIDGE_TOKEN: '0123456789abcdef01234567',
      APP_RESPONSE_DIR: '/tmp/claw-bridge-responses',
      APP_RESPONSE_TTL_MS: '60000',
      APP_DEVICE_DIR: '/tmp/claw-bridge-devices',
      ELEVENLABS_API_KEY: 'test-api-key',
      ELEVENLABS_VOICE_ID: 'test-voice-id',
      ELEVENLABS_MODEL_ID: 'eleven_turbo_v2_5',
      ELEVENLABS_OUTPUT_FORMAT: 'mp3_44100_192',
      ELEVENLABS_BASE_URL: 'https://example.test',
      APNS_TEAM_ID: 'TEAMID1234',
      APNS_KEY_ID: 'KEYID12345',
      APNS_PRIVATE_KEY_PATH: '/tmp/AuthKey_KEYID12345.p8',
      APNS_BUNDLE_ID: 'com.example.ClawBridge',
      APNS_ENVIRONMENT: 'production'
    });
    expect(config.appResponseDir).toBe('/tmp/claw-bridge-responses');
    expect(config.appResponseTtlMs).toBe(60000);
    expect(config.appDeviceDir).toBe('/tmp/claw-bridge-devices');
    expect(config.elevenLabsApiKey).toBe('test-api-key');
    expect(config.elevenLabsVoiceId).toBe('test-voice-id');
    expect(config.elevenLabsModelId).toBe('eleven_turbo_v2_5');
    expect(config.elevenLabsOutputFormat).toBe('mp3_44100_192');
    expect(config.elevenLabsBaseUrl).toBe('https://example.test');
    expect(config.apnsTeamId).toBe('TEAMID1234');
    expect(config.apnsKeyId).toBe('KEYID12345');
    expect(config.apnsPrivateKeyPath).toBe('/tmp/AuthKey_KEYID12345.p8');
    expect(config.apnsBundleId).toBe('com.example.ClawBridge');
    expect(config.apnsEnvironment).toBe('production');
  });

  it('requires reply routing when OpenClaw delivery is enabled', () => {
    expect(() =>
      loadConfig({
        CLAW_BRIDGE_TOKEN: '0123456789abcdef01234567',
        OPENCLAW_DELIVER_REPLY: 'true'
      })
    ).toThrow('OPENCLAW_REPLY_CHANNEL and OPENCLAW_REPLY_TO');
  });

  it('loads Telegram direct reply routing', () => {
    const config = loadConfig({
      CLAW_BRIDGE_TOKEN: '0123456789abcdef01234567',
      OPENCLAW_DELIVER_REPLY: 'true',
      OPENCLAW_REPLY_CHANNEL: 'telegram',
      OPENCLAW_REPLY_TO: 'telegram:1234',
      OPENCLAW_MESSAGE_STYLE: 'compact',
      VOICE_MESSAGE_PREFIX: 'Sent via voice message:'
    });
    expect(config.openclawDeliverReply).toBe(true);
    expect(config.openclawReplyChannel).toBe('telegram');
    expect(config.openclawReplyTo).toBe('telegram:1234');
    expect(config.openclawMessageStyle).toBe('compact');
    expect(config.voiceMessagePrefix).toBe('Sent via voice message:');
  });

  it('keeps legacy Siri-named env vars as aliases', () => {
    const config = loadConfig({
      SIRI_BRIDGE_TOKEN: '0123456789abcdef01234567',
      SIRI_MESSAGE_PREFIX: 'Sent via Siri voice message:'
    });
    expect(config.bridgeToken).toBe('0123456789abcdef01234567');
    expect(config.voiceMessagePrefix).toBe('Sent via Siri voice message:');
  });

  it('loads share upload and audio transcription settings', () => {
    const config = loadConfig({
      CLAW_BRIDGE_TOKEN: '0123456789abcdef01234567',
      SHARE_UPLOAD_DIR: '/tmp/share-uploads',
      SHARE_MAX_UPLOAD_BYTES: '1048576',
      WATCH_MIN_AUDIO_SECONDS: '1.75',
      WATCH_MAX_AUDIO_SECONDS: '180',
      AUDIO_TRANSCRIBE_ENABLED: 'true',
      AUDIO_TRANSCRIBE_CLI_BIN: '/opt/homebrew/bin/openclaw',
      AUDIO_TRANSCRIBE_TIMEOUT_MS: '600000',
      AUDIO_TRANSCRIBE_MODEL: 'openai-whisper/whisper-1',
      AUDIO_TRANSCRIBE_LANGUAGE: 'en'
    });
    expect(config.shareUploadDir).toBe('/tmp/share-uploads');
    expect(config.shareMaxUploadBytes).toBe(1048576);
    expect(config.watchMinAudioSeconds).toBe(1.75);
    expect(config.watchMaxAudioSeconds).toBe(180);
    expect(config.audioTranscribeEnabled).toBe(true);
    expect(config.audioTranscribeCliBin).toBe('/opt/homebrew/bin/openclaw');
    expect(config.audioTranscribeTimeoutMs).toBe(600000);
    expect(config.audioTranscribeModel).toBe('openai-whisper/whisper-1');
    expect(config.audioTranscribeLanguage).toBe('en');
  });

  it('loads an explicit queue archive path', () => {
    const config = loadConfig({
      CLAW_BRIDGE_TOKEN: '0123456789abcdef01234567',
      QUEUE_PATH: '/tmp/claw-bridge-queue.jsonl',
      QUEUE_ARCHIVE_PATH: '/tmp/claw-bridge-queue.archive.jsonl'
    });
    expect(config.queuePath).toBe('/tmp/claw-bridge-queue.jsonl');
    expect(config.queueArchivePath).toBe('/tmp/claw-bridge-queue.archive.jsonl');
  });
});
