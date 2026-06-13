import express from 'express';
import pino from 'pino';
import type { BridgeConfig, DeliveryResult, NormalizedSiriEvent, ShortcutMessageRequest } from './types.js';
import { acceptForOpenClaw } from './openclaw.js';
import { normalizeShortcutMessage } from './siri.js';

export interface AppDependencies {
  acceptEvent?: (event: NormalizedSiriEvent) => Promise<DeliveryResult>;
}

function isAuthorized(config: BridgeConfig, header: string | undefined): boolean {
  return header === `Bearer ${config.siriBridgeToken}`;
}

export function createApp(config: BridgeConfig, deps: AppDependencies = {}) {
  const app = express();
  const logger = pino({ level: config.logLevel });
  const acceptEvent = deps.acceptEvent ?? ((event) => acceptForOpenClaw(config, event));

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/shortcuts/message', async (req, res) => {
    if (!isAuthorized(config, req.header('authorization'))) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }

    try {
      const event = normalizeShortcutMessage(config, req.body as ShortcutMessageRequest);
      const result = await acceptEvent(event);
      logger.info({ requestId: event.request_id, source: event.source, assistant: event.assistant }, 'message accepted');
      res.status(202).json({
        ok: true,
        queued: Boolean(result.queued),
        id: result.id ?? event.request_id,
        spoken: `Sent to ${event.assistant}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'message rejected';
      logger.warn({ error: message }, 'message rejected');
      res.status(400).json({ ok: false, error: message, spoken: `Not sent: ${message}` });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'not found' });
  });

  return app;
}
