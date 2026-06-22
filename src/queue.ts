import { mkdir, appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NormalizedSiriEvent, QueueRecord } from './types.js';

export async function queueEvent(queuePath: string, event: NormalizedSiriEvent, reason: unknown): Promise<void> {
  const record: QueueRecord = {
    status: 'pending',
    created_at: new Date().toISOString(),
    attempts: 0,
    event,
    last_error: reason instanceof Error ? reason.message : String(reason)
  };
  await mkdir(dirname(queuePath), { recursive: true });
  await appendFile(queuePath, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readQueue(queuePath: string): Promise<QueueRecord[]> {
  let raw = '';
  try {
    raw = await readFile(queuePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as QueueRecord);
}

export async function hasQueuedOrArchivedRequest(
  queuePath: string,
  archivePath: string,
  requestId: string
): Promise<boolean> {
  for (const path of [queuePath, archivePath]) {
    const records = await readQueue(path);
    if (records.some((record) => record.event.request_id === requestId)) {
      return true;
    }
  }
  return false;
}

async function writeQueue(queuePath: string, records: QueueRecord[]): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  const tmpPath = `${queuePath}.tmp`;
  const body = records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '';
  await writeFile(tmpPath, body, 'utf8');
  await rename(tmpPath, queuePath);
}

async function appendQueueArchive(archivePath: string, records: QueueRecord[]): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dirname(archivePath), { recursive: true });
  const archivedAt = new Date().toISOString();
  const body = records.map((record) => JSON.stringify({ ...record, archived_at: archivedAt })).join('\n');
  await appendFile(archivePath, `${body}\n`, 'utf8');
}

export interface DrainQueueResult {
  delivered: number;
  failed: number;
  pending: number;
  archived: number;
}

export interface DrainQueueHooks {
  afterFailed?: (event: NormalizedSiriEvent, error: unknown) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const retryable = (error as { retryable?: unknown }).retryable;
  return retryable !== false;
}

export async function drainQueue(
  queuePath: string,
  archivePath: string,
  maxAttempts: number,
  deliver: (event: NormalizedSiriEvent) => Promise<void>,
  hooks: DrainQueueHooks = {}
): Promise<DrainQueueResult> {
  const records = await readQueue(queuePath);
  const initialRequestIds = new Set(records.map((record) => record.event.request_id));
  let delivered = 0;
  let failed = 0;
  let changed = false;

  for (const record of records) {
    if (record.status !== 'pending') continue;
    if (record.attempts >= maxAttempts) {
      record.status = 'failed';
      record.last_error = record.last_error || `exceeded ${maxAttempts} delivery attempts`;
      failed += 1;
      changed = true;
      continue;
    }

    record.attempts += 1;
    record.last_attempt_at = new Date().toISOString();
    changed = true;
    try {
      await deliver(record.event);
      record.status = 'delivered';
      record.delivered_at = new Date().toISOString();
      record.last_error = undefined;
      delivered += 1;
    } catch (error) {
      record.last_error = errorMessage(error);
      if (!isRetryableError(error) || record.attempts >= maxAttempts) {
        record.status = 'failed';
        failed += 1;
        try {
          await hooks.afterFailed?.(record.event, error);
        } catch (hookError) {
          record.last_error = `${record.last_error}; failure hook failed: ${errorMessage(hookError)}`;
        }
      }
    }
  }

  const terminalRecords = records.filter((record) => record.status !== 'pending');
  const pendingRecords = records.filter((record) => record.status === 'pending');
  if (terminalRecords.length > 0) {
    await appendQueueArchive(archivePath, terminalRecords);
  }

  let finalPendingRecords = pendingRecords;
  if (changed || terminalRecords.length > 0) {
    const latestRecords = await readQueue(queuePath);
    const appendedDuringDrain = latestRecords.filter((record) => !initialRequestIds.has(record.event.request_id));
    finalPendingRecords = [...pendingRecords, ...appendedDuringDrain];
    await writeQueue(queuePath, finalPendingRecords);
  }

  return {
    delivered,
    failed,
    pending: finalPendingRecords.length,
    archived: terminalRecords.length
  };
}
