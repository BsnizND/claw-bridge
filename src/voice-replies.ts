import type { BridgeConfig, DeliveryResult, NormalizedSiriEvent } from './types.js';
import { AppResponseStore } from './app-response-store.js';
import { synthesizeElevenLabsSpeech } from './elevenlabs.js';

export async function renderAppVoiceReply(
  config: BridgeConfig,
  store: AppResponseStore,
  event: NormalizedSiriEvent,
  result: DeliveryResult
): Promise<void> {
  const responseId = event.app_response?.id;
  if (!responseId) return;

  const replyText = result.replyText?.trim();
  if (!replyText) {
    await store.fail(responseId, 'OpenClaw did not return reply text for voice rendering');
    throw new Error('OpenClaw did not return reply text for voice rendering');
  }

  await store.markRendering(responseId);
  const audioPath = store.audioPath(responseId, 'mp3');
  try {
    const speech = await synthesizeElevenLabsSpeech(config, replyText, audioPath);
    await store.completeVoice(responseId, replyText, speech.audioPath, speech.mimeType);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.fail(responseId, message);
    throw error;
  }
}
