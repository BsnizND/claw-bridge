import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppResponseRecord, NormalizedSiriEvent } from './types.js';

function safeResponseId(id: string): string {
  if (!/^[A-Za-z0-9._-]{8,120}$/.test(id)) {
    throw new Error('invalid response id');
  }
  return id;
}

export class AppResponseStore {
  constructor(
    private readonly responseDir: string,
    private readonly ttlMs: number
  ) {}

  async createPending(event: NormalizedSiriEvent): Promise<AppResponseRecord> {
    const now = new Date();
    const id = randomUUID();
    const record: AppResponseRecord = {
      id,
      request_id: event.request_id,
      mode: 'voice',
      status: 'pending',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
      source: event.source,
      assistant: event.assistant,
      device_name: event.device_name,
      app_device_id: event.app_response?.app_device_id,
      app_platform: event.app_response?.app_platform,
      notification_status: event.app_response?.app_device_id ? 'not_requested' : undefined
    };
    await this.writeRecord(record);
    return record;
  }

  async get(id: string): Promise<AppResponseRecord | undefined> {
    const record = await this.readRecord(id);
    if (!record) return undefined;
    if (record.status !== 'ready' && Date.parse(record.expires_at) <= Date.now()) {
      const expired: AppResponseRecord = {
        ...record,
        status: 'expired',
        error: 'response expired',
        updated_at: new Date().toISOString()
      };
      await this.writeRecord(expired);
      return expired;
    }
    return record;
  }

  async markRendering(id: string): Promise<AppResponseRecord> {
    return await this.update(id, { status: 'rendering', error: undefined });
  }

  async completeVoice(id: string, replyText: string, audioPath: string, audioMimeType: string): Promise<AppResponseRecord> {
    const audioStats = await stat(audioPath);
    return await this.update(id, {
      status: 'ready',
      reply_text: replyText,
      audio_path: audioPath,
      audio_mime_type: audioMimeType,
      audio_size_bytes: audioStats.size,
      error: undefined
    });
  }

  async fail(id: string, error: string): Promise<AppResponseRecord> {
    return await this.update(id, { status: 'failed', error });
  }

  async markNotification(
    id: string,
    notification_status: AppResponseRecord['notification_status'],
    notification_error?: string
  ): Promise<AppResponseRecord> {
    return await this.update(id, { notification_status, notification_error });
  }

  audioPath(id: string, extension = 'mp3'): string {
    return join(this.responseDir, `${safeResponseId(id)}.${extension}`);
  }

  private recordPath(id: string): string {
    return join(this.responseDir, `${safeResponseId(id)}.json`);
  }

  private async update(id: string, patch: Partial<AppResponseRecord>): Promise<AppResponseRecord> {
    const existing = await this.readRecord(id);
    if (!existing) {
      throw new Error('response not found');
    }
    const record: AppResponseRecord = {
      ...existing,
      ...patch,
      updated_at: new Date().toISOString()
    };
    await this.writeRecord(record);
    return record;
  }

  private async readRecord(id: string): Promise<AppResponseRecord | undefined> {
    const path = this.recordPath(safeResponseId(id));
    let raw = '';
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return JSON.parse(raw) as AppResponseRecord;
  }

  private async writeRecord(record: AppResponseRecord): Promise<void> {
    await mkdir(this.responseDir, { recursive: true });
    const path = this.recordPath(record.id);
    const tmpPath = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmpPath, path);
  }
}
