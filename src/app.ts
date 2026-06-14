import { mkdirSync, writeFileSync } from 'node:fs';
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
import { normalizeWatchVoiceRequest } from './watch.js';

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

function queryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return queryValue(value[0]);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function queryBody(query: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query)
      .map(([key, value]) => [key, queryValue(value)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  );
}

function sniffImageMimeType(buffer: Buffer): string | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  const ascii = buffer.subarray(0, 16).toString('ascii');
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
    return 'image/gif';
  }
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
  }
  return undefined;
}

function rawMimeType(contentType: string | undefined, buffer: Buffer): string {
  const headerMimeType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (headerMimeType && headerMimeType !== 'application/octet-stream') {
    return headerMimeType;
  }
  return sniffImageMimeType(buffer) ?? headerMimeType ?? 'application/octet-stream';
}

function defaultRawFileName(mimetype: string): string {
  switch (mimetype) {
    case 'image/jpeg':
      return 'shared-image.jpg';
    case 'image/gif':
      return 'shared-image.gif';
    case 'image/webp':
      return 'shared-image.webp';
    case 'image/heic':
      return 'shared-image.heic';
    case 'image/heif':
      return 'shared-image.heif';
    case 'image/png':
      return 'shared-image.png';
    default:
      return 'shared-file.bin';
  }
}

function rawShareFileName(body: Record<string, unknown>, mimetype: string): string {
  return queryValue(body.filename) ?? queryValue(body.shared_title) ?? defaultRawFileName(mimetype);
}

function shareMissingPayloadMessage(contentType: string | undefined): string {
  if (contentType?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return 'no shareable input captured; rebuild the Shortcut so images/screenshots are sent as raw file uploads';
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
    if (req.path.startsWith('/shortcuts/') || req.path.startsWith('/watch/')) {
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

  app.post('/shortcuts/share-file', express.raw({ type: '*/*', limit: config.shareMaxUploadBytes }), async (req, res) => {
    if (!isAuthorized(config, req.header('authorization'))) {
      res.status(401).json({ ok: false, error: 'unauthorized', spoken: 'Not sent: unauthorized' });
      return;
    }

    try {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
      if (!buffer.length) {
        throw new Error('file body is required');
      }
      const body = queryBody(req.query as Record<string, unknown>);
      const mimetype = rawMimeType(req.header('content-type'), buffer);
      const originalname = rawShareFileName(body, mimetype);
      const filePath = `${config.shareUploadDir}/${safeUploadName(originalname)}`;
      writeFileSync(filePath, buffer, { mode: 0o600 });
      const file: UploadedShareFile = {
        path: filePath,
        originalname,
        mimetype,
        size: buffer.length
      };
      const transcript = isAudioMimeType(file.mimetype) ? await transcribeAudioFile(config, file.path) : undefined;
      const event = normalizeShareSheetRequest(config, body, file, transcript);
      const result = await acceptEvent(event);
      logger.info(
        {
          requestId: event.request_id,
          source: event.source,
          assistant: event.assistant,
          sharedKind: event.shared_item?.kind
        },
        'share file accepted'
      );
      afterAccepted?.(event);
      res.status(202).json({
        ok: true,
        queued: Boolean(result.queued),
        id: result.id ?? event.request_id,
        spoken: `Shared with ${event.assistant}`
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'share file rejected';
      logger.warn({ error: message, queryKeys: Object.keys(req.query ?? {}) }, 'share file rejected');
      res.status(400).json({ ok: false, error: message, spoken: `Not sent: ${message}` });
    }
  });

  app.post('/watch/voice', (req, res) => {
    if (!isAuthorized(config, req.header('authorization'))) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }

    upload.single('audio')(req, res, async (uploadError) => {
      if (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : 'upload rejected';
        logger.warn({ error: message }, 'watch voice upload rejected');
        res.status(400).json({ ok: false, error: message });
        return;
      }

      try {
        const body = req.body as Record<string, unknown>;
        const file = req.file as UploadedShareFile | undefined;
        const transcript =
          file && isAudioMimeType(file.mimetype) ? await transcribeAudioFile(config, file.path) : undefined;
        const event = normalizeWatchVoiceRequest(config, body, file, transcript);
        const result = await acceptEvent(event);
        logger.info(
          {
            requestId: event.request_id,
            source: event.source,
            assistant: event.assistant,
            deviceName: event.device_name
          },
          'watch voice accepted'
        );
        afterAccepted?.(event);
        res.status(202).json({
          ok: true,
          queued: Boolean(result.queued),
          id: result.id ?? event.request_id
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'watch voice rejected';
        logger.warn({ error: message, bodyKeys: Object.keys(req.body ?? {}) }, 'watch voice rejected');
        res.status(400).json({ ok: false, error: message });
      }
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'not found' });
  });

  return app;
}
