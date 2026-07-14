import { createApp } from './app.js';
import { AppDeviceStore } from './app-device-store.js';
import { AppResponseStore } from './app-response-store.js';
import { loadConfig } from './config.js';
import { drainOpenClawQueue } from './openclaw.js';
import { recoverFreshOrphanedDrainLockForExclusiveOwner } from './queue.js';
import { failAppVoiceReply, notifyLifeOSReply, renderAppVoiceReply } from './voice-replies.js';

const config = loadConfig();
const appDeviceStore = new AppDeviceStore(config.appDeviceDir);
const appResponseStore = new AppResponseStore(config.appResponseDir, config.appResponseTtlMs);
let draining = false;
let drainStartedAt = 0;
let markStartupRecoveryFinished: (() => void) | undefined;
const startupRecoveryFinished = new Promise<void>((resolve) => {
  markStartupRecoveryFinished = resolve;
});

const staleDrainAfterMs = Math.max(
  config.openclawCliDrainTimeoutMs + 10_000,
  config.queueDrainIntervalMs > 0 ? config.queueDrainIntervalMs * 2 : 0,
  60_000
);

function scheduleDrain(reason: string) {
  const timeout = setTimeout(() => {
    void drainOnce(reason);
  }, 0);
  timeout.unref();
}

async function drainOnce(reason: string) {
  await startupRecoveryFinished;
  if (draining) {
    const ageMs = Date.now() - drainStartedAt;
    if (ageMs <= staleDrainAfterMs) return;
    console.error(`openclaw queue drain appears stuck after ${ageMs}ms; skipping overlapping drain reason=${reason}`);
    return;
  }
  draining = true;
  drainStartedAt = Date.now();
  try {
    const result = await drainOpenClawQueue(config, {
      afterDelivered: async (event, delivery) => {
        await renderAppVoiceReply(config, appResponseStore, event, delivery, appDeviceStore);
        await notifyLifeOSReply(config, event, delivery, appDeviceStore);
      },
      afterFailed: async (event, error) => {
        await failAppVoiceReply(appResponseStore, event, error);
      }
    });
    if (result.delivered > 0 || result.failed > 0 || result.archived > 0) {
      console.log(
        `openclaw queue drain delivered=${result.delivered} failed=${result.failed} archived=${result.archived} pending=${result.pending} reason=${reason}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`openclaw queue drain failed: ${message}`);
  } finally {
    draining = false;
    drainStartedAt = 0;
  }
}

const app = createApp(config, {
  appDeviceStore,
  appResponseStore,
  afterAccepted: (event) => {
    scheduleDrain(`accepted:${event.request_id}`);
  }
});

app.listen(config.port, config.host, () => {
  console.log(`claw-bridge listening on http://${config.host}:${config.port}`);
  void (async () => {
    try {
      const recovered = await recoverFreshOrphanedDrainLockForExclusiveOwner(config.queuePath);
      if (recovered) {
        console.log('recovered fresh orphaned openclaw queue drain lock');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`openclaw queue drain lock recovery failed: ${message}`);
    } finally {
      markStartupRecoveryFinished?.();
      markStartupRecoveryFinished = undefined;
    }

    if (config.queueDrainIntervalMs > 0) {
      scheduleDrain('startup');
      setInterval(() => {
        scheduleDrain('interval');
      }, config.queueDrainIntervalMs);
    }
  })();
});
