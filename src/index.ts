import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { drainOpenClawQueue } from './openclaw.js';

const config = loadConfig();
const app = createApp(config);
let draining = false;

async function drainOnce() {
  if (draining) return;
  draining = true;
  try {
    const result = await drainOpenClawQueue(config);
    if (result.delivered > 0 || result.failed > 0) {
      console.log(`openclaw queue drain delivered=${result.delivered} failed=${result.failed} pending=${result.pending}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`openclaw queue drain failed: ${message}`);
  } finally {
    draining = false;
  }
}

app.listen(config.port, config.host, () => {
  console.log(`openclaw-siri-bridge listening on http://${config.host}:${config.port}`);
  if (config.queueDrainIntervalMs > 0) {
    void drainOnce();
    setInterval(() => {
      void drainOnce();
    }, config.queueDrainIntervalMs);
  }
});
