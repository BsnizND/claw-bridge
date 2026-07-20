import { generateKeyPairSync } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  injectAssistantMessageIntoOpenClawSession,
  synthesizeSpeechViaOpenClawGateway
} from '../src/openclaw-gateway.js';

describe('OpenClaw Gateway native services', () => {
	 it('injects the exact LifeOS text without a transcript-visible label', async () => {
		const dir = join(tmpdir(), `claw-bridge-gateway-inject-${Date.now()}`);
		await mkdir(dir, { recursive: true });
		const identityPath = join(dir, 'device.json');
		const authPath = join(dir, 'device-auth.json');
		const keys = generateKeyPairSync('ed25519');
		await writeFile(identityPath, JSON.stringify({
			deviceId: 'test-device',
			publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
			privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
		}));
		await writeFile(authPath, JSON.stringify({
			tokens: { operator: { token: 'paired-device-token', scopes: ['operator.read', 'operator.write'] } }
		}));

		let injectParams: Record<string, unknown> | undefined;
		const originalWebSocket = globalThis.WebSocket;
		class FakeWebSocket {
			private listeners = new Map<string, Array<(event: { data?: string }) => void>>();

			constructor() {
				queueMicrotask(() => this.emit('message', {
					data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test-nonce' } })
				}));
			}

			addEventListener(type: string, listener: (event: { data?: string }) => void) {
				this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
			}

			send(raw: string) {
				const frame = JSON.parse(raw) as { id: string; method: string; params: Record<string, unknown> };
				if (frame.method === 'chat.inject') injectParams = frame.params;
				const payload = frame.method === 'chat.inject' ? { ok: true, messageId: 'injected-1' } : { ok: true };
				queueMicrotask(() => this.emit('message', {
					data: JSON.stringify({ type: 'res', id: frame.id, ok: true, payload })
				}));
			}

			close() {}

			private emit(type: string, event: { data?: string }) {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
		}

		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		try {
			const messageId = await injectAssistantMessageIntoOpenClawSession({
				gatewayUrl: 'ws://127.0.0.1:18789',
				deviceIdentityPath: identityPath,
				deviceAuthPath: authPath,
				timeoutMs: 1000,
				sessionKey: 'agent:jay:lifeos-home:thread-1',
				message: 'A proactive update.'
			});
			expect(messageId).toBe('injected-1');
			expect(injectParams).toEqual({
				sessionKey: 'agent:jay:lifeos-home:thread-1',
				agentId: 'jay',
				message: 'A proactive update.'
			});
		} finally {
			globalThis.WebSocket = originalWebSocket;
			await rm(dir, { recursive: true, force: true });
		}
	});

  it('uses tts.speak and returns the Gateway provider audio metadata', async () => {
    const dir = join(tmpdir(), `claw-bridge-gateway-tts-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const identityPath = join(dir, 'device.json');
    const authPath = join(dir, 'device-auth.json');
    const keys = generateKeyPairSync('ed25519');
    await writeFile(identityPath, JSON.stringify({
      deviceId: 'test-device',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
      privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
    }));
    await writeFile(authPath, JSON.stringify({
      tokens: { operator: { token: 'paired-device-token', scopes: ['operator.read', 'operator.write'] } }
    }));

    const methods: string[] = [];
    const originalWebSocket = globalThis.WebSocket;
    class FakeWebSocket {
      private listeners = new Map<string, Array<(event: { data?: string }) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test-nonce' } })
        }));
      }

      addEventListener(type: string, listener: (event: { data?: string }) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      send(raw: string) {
        const frame = JSON.parse(raw) as { id: string; method: string; params: Record<string, unknown> };
        methods.push(frame.method);
        const payload = frame.method === 'tts.speak'
          ? {
              audioBase64: Buffer.from('gateway-audio').toString('base64'),
              provider: 'openai',
              outputFormat: 'mp3',
              mimeType: 'audio/mpeg',
              fileExtension: '.mp3'
            }
          : { ok: true };
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({ type: 'res', id: frame.id, ok: true, payload })
        }));
      }

      close() {}

      private emit(type: string, event: { data?: string }) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const speech = await synthesizeSpeechViaOpenClawGateway({
        gatewayUrl: 'ws://127.0.0.1:18789',
        deviceIdentityPath: identityPath,
        deviceAuthPath: authPath,
        timeoutMs: 1000,
        text: 'Hello from Jay'
      });
      expect(speech).toMatchObject({
        provider: 'openai',
        mimeType: 'audio/mpeg',
        fileExtension: 'mp3'
      });
      expect(speech.audio.toString('utf8')).toBe('gateway-audio');
      expect(methods).toEqual(['connect', 'tts.speak']);
    } finally {
      globalThis.WebSocket = originalWebSocket;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
