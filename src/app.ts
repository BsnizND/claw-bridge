import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import express from 'express';
import multer from 'multer';
import pino from 'pino';
import type { BridgeConfig, DeliveryResult, NormalizedSiriEvent, ShortcutMessageRequest } from './types.js';
import { acceptForOpenClaw } from './openclaw.js';
import { normalizeShortcutMessage } from './siri.js';
import { normalizeShareSheetRequest, type UploadedShareFile } from './share.js';
import { isAudioMimeType, transcribeAudioFile } from './transcribe.js';

export interface AppDependencies {
  acceptEvent?: (event: NormalizedSiriEvent) => Promise<DeliveryResult>;
  afterAccepted?: (event: NormalizedSiriEvent) => void;
}

function isAuthorized(config: BridgeConfig, header: string | undefined): boolean {
  return header === `Bearer ${config.siriBridgeToken}`;
}

function safeUploadName(originalName: string): string {
  const base = originalName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'shared-file';
  const suffix = extname(base) ? '' : '.bin';
  return `${Date.now()}-${randomUUID()}-${base}${suffix}`;
}

function shareMissingPayloadMessage(contentType: string | undefined): string {
  if (contentType?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return 'no shareable input captured; rebuild the Shortcut so images/screenshots are sent as multipart file uploads';
  }
  return 'shared_text, shared_url, message, or file is required';
}

export function createApp(config: BridgeConfig, deps: AppDependencies = {}) {
  const app = express();
  const logger = pino({ level: config.logLevel });
  const acceptEvent = deps.acceptEvent ?? ((event) => acceptForOpenClaw(config, event));
  const afterAccepted = deps.afterAccepted;
  mkdirSync(config.shareUploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.shareUploadDir,
      filename: (_req, file, cb) => cb(null, safeUploadName(file.originalname))
    }),
    limits: {
      fileSize: config.shareMaxUploadBytes,
      files: 1
    }
  });

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.path.startsWith('/shortcuts/')) {
      const startedAt = Date.now();
      res.on('finish', () => {
        logger.info(
          {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
            contentType: req.header('content-type')
          },
          'shortcut request completed'
        );
      });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: true, limit: '64kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/shortcuts/message', async (req, res) => {
    if (!isAuthorized(config, req.header('authorization'))) {
      res.status(401).json({ ok: false, error: 'unauthorized', spoken: 'Not sent: unauthorized' });
      return;
    }

    try {
      const event = normalizeShortcutMessage(config, req.body as ShortcutMessageRequest);
      const result = await acceptEvent(event);
      logger.info({ requestId: event.request_id, source: event.source, assistant: event.assistant }, 'message accepted');
      afterAccepted?.(event);
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

  app.post('/shortcuts/share', (req, res) => {
    if (!isAuthorized(config, req.header('authorization'))) {
      res.status(401).json({ ok: false, error: 'unauthorized', spoken: 'Not sent: unauthorized' });
      return;
    }

    upload.single('file')(req, res, async (uploadError) => {
      if (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : 'upload rejected';
        logger.warn({ error: message }, 'share upload rejected');
        res.status(400).json({ ok: false, error: message, spoken: `Not sent: ${message}` });
        return;
      }

      try {
        const body = req.body as Record<string, unknown>;
        const file = req.file as UploadedShareFile | undefined;
        const transcript =
          file && isAudioMimeType(file.mimetype) ? await transcribeAudioFile(config, file.path) : undefined;
        const event = normalizeShareSheetRequest(config, body, file, transcript);
        const result = await acceptEvent(event);
        logger.info(
          {
            requestId: event.request_id,
            source: event.source,
            assistant: event.assistant,
            sharedKind: event.shared_item?.kind
          },
          'share accepted'
        );
        afterAccepted?.(event);
        res.status(202).json({
          ok: true,
          queued: Boolean(result.queued),
          id: result.id ?? event.request_id,
          spoken: `Shared with ${event.assistant}`
        });
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'share rejected';
        const message =
          rawMessage === 'shared_text, shared_url, message, or file is required'
            ? shareMissingPayloadMessage(req.header('content-type'))
            : rawMessage;
        logger.warn({ error: message, bodyKeys: Object.keys(req.body ?? {}) }, 'share rejected');
        res.status(400).json({ ok: false, error: message, spoken: `Not sent: ${message}` });
      }
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'not found' });
  });

  return app;
}
