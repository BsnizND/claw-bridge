import type { BridgeConfig, DeliveryResult, NormalizedSiriEvent } from './types.js';
import { AppDeviceStore } from './app-device-store.js';
import { AppResponseStore } from './app-response-store.js';
import { apnsConfigured, sendAppResponseNotification } from './apns.js';
import { synthesizeElevenLabsSpeech } from './elevenlabs.js';

export async function renderAppVoiceReply(
  config: BridgeConfig,
  store: AppResponseStore,
  event: NormalizedSiriEvent,
  result: DeliveryResult,
  deviceStore?: AppDeviceStore
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
  let ready;
  try {
    const speech = await synthesizeElevenLabsSpeech(config, replyText, audioPath);
    ready = await store.completeVoice(responseId, replyText, speech.audioPath, speech.mimeType);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.fail(responseId, message);
    throw error;
  }
  if (!ready.app_device_id) return;
  try {
    if (!deviceStore || !apnsConfigured(config)) {
      await store.markNotification(responseId, 'not_configured', 'APNs is not configured');
      return;
    }
    const device = await deviceStore.get(ready.app_device_id);
    if (!device) {
      await store.markNotification(responseId, 'failed', 'app device registration not found');
      return;
    }
    const notification = await sendAppResponseNotification(config, device, ready);
    await store.markNotification(
      responseId,
      notification.ok ? 'sent' : 'failed',
      notification.ok ? undefined : notification.reason ?? `APNs returned HTTP ${notification.statusCode}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.markNotification(responseId, 'failed', message);
  }
}
