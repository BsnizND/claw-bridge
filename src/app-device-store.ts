import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppDeviceRegistration, AppPlatform } from './types.js';

function safeDeviceId(id: string): string {
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(id)) {
    throw new Error('invalid app device id');
  }
  return id;
}

function safePushToken(token: string): string {
  const trimmed = token.trim();
  if (!/^[A-Fa-f0-9]{32,512}$/.test(trimmed)) {
    throw new Error('invalid push token');
  }
  return trimmed.toLowerCase();
}

function safePlatform(platform: string): AppPlatform {
  if (platform === 'ios' || platform === 'watchos') return platform;
  throw new Error('invalid app platform');
}

export interface UpsertAppDeviceInput {
  id: string;
  platform: string;
  push_token: string;
  app_version?: string;
  device_name?: string;
}

export class AppDeviceStore {
  constructor(private readonly deviceDir: string) {}

  async upsert(input: UpsertAppDeviceInput): Promise<AppDeviceRegistration> {
    const now = new Date().toISOString();
    const existing = await this.get(input.id);
    const record: AppDeviceRegistration = {
      id: safeDeviceId(input.id),
      platform: safePlatform(input.platform),
      push_token: safePushToken(input.push_token),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      app_version: input.app_version?.trim() || undefined,
      device_name: input.device_name?.trim() || undefined
    };
    await this.writeRecord(record);
    return record;
  }

  async get(id: string): Promise<AppDeviceRegistration | undefined> {
    const path = this.recordPath(safeDeviceId(id));
    let raw = '';
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return JSON.parse(raw) as AppDeviceRegistration;
  }

  async list(platform?: AppPlatform): Promise<AppDeviceRegistration[]> {
    let names: string[];
    try {
      names = await readdir(this.deviceDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const raw = await readFile(join(this.deviceDir, name), 'utf8');
          return JSON.parse(raw) as AppDeviceRegistration;
        })
    );
    return records
      .filter((record) => !platform || record.platform === platform)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  private recordPath(id: string): string {
    return join(this.deviceDir, `${safeDeviceId(id)}.json`);
  }

  private async writeRecord(record: AppDeviceRegistration): Promise<void> {
    await mkdir(this.deviceDir, { recursive: true });
    const path = this.recordPath(record.id);
    const tmpPath = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmpPath, path);
  }
}
