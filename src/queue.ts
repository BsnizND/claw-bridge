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

async function writeQueue(queuePath: string, records: QueueRecord[]): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  const tmpPath = `${queuePath}.tmp`;
  const body = records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n` : '';
  await writeFile(tmpPath, body, 'utf8');
  await rename(tmpPath, queuePath);
}

export interface DrainQueueResult {
  delivered: number;
  failed: number;
  pending: number;
}

export async function drainQueue(
  queuePath: string,
  maxAttempts: number,
  deliver: (event: NormalizedSiriEvent) => Promise<void>
): Promise<DrainQueueResult> {
  const records = await readQueue(queuePath);
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
      record.last_error = error instanceof Error ? error.message : String(error);
      if (record.attempts >= maxAttempts) {
        record.status = 'failed';
        failed += 1;
      }
    }
  }

  if (changed) {
    await writeQueue(queuePath, records);
  }

  return {
    delivered,
    failed,
    pending: records.filter((record) => record.status === 'pending').length
  };
}
