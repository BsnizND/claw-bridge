import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeConfig } from './types.js';

interface WorkerReadyMessage {
  type: 'ready';
  model: string;
  device: string;
  load_ms: number;
}

interface WorkerResultMessage {
  type: 'result';
  id: string;
  text: string;
  duration_ms: number;
}

interface WorkerErrorMessage {
  type: 'error';
  id: string;
  error: string;
}

type WorkerMessage = WorkerReadyMessage | WorkerResultMessage | WorkerErrorMessage;

interface PendingTranscription {
  resolve: (text: string | undefined) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

function defaultWorkerPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, '../scripts/whisper-worker.py'),
    resolve(moduleDir, '../../scripts/whisper-worker.py')
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`persistent Whisper worker not found; checked ${candidates.join(', ')}`);
  return found;
}

class PersistentWhisperClient {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<WorkerReadyMessage>;
  private readonly pending = new Map<string, PendingTranscription>();
  private stderrTail = '';
  private stopping = false;

  constructor(private readonly config: BridgeConfig) {}

  async warm(): Promise<WorkerReadyMessage> {
    return this.start();
  }

  async transcribe(filePath: string): Promise<string | undefined> {
    await this.start();
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error('persistent Whisper worker is not available');
    }

    const id = randomUUID();
    return new Promise<string | undefined>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`audio transcription exceeded ${this.config.audioTranscribeTimeoutMs}ms`));
        child.kill('SIGTERM');
      }, this.config.audioTranscribeTimeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout });
      child.stdin.write(
        `${JSON.stringify({ id, file_path: filePath, language: this.config.audioTranscribeLanguage })}\n`,
        (error) => {
          if (!error) return;
          clearTimeout(timeout);
          this.pending.delete(id);
          rejectPromise(error);
        }
      );
    });
  }

  shutdown(): void {
    this.stopping = true;
    const error = new Error('persistent Whisper worker stopped');
    this.rejectPending(error);
    this.child?.stdin.end();
    this.child?.kill('SIGTERM');
    this.child = undefined;
    this.startPromise = undefined;
  }

  private start(): Promise<WorkerReadyMessage> {
    if (this.startPromise) return this.startPromise;
    if (!this.config.audioTranscribePythonBin) {
      return Promise.reject(
        new Error('AUDIO_TRANSCRIBE_PYTHON_BIN is required when AUDIO_TRANSCRIBE_PERSISTENT=true')
      );
    }

    this.stopping = false;
    this.stderrTail = '';
    const workerPath = this.config.audioTranscribeWorkerPath ?? defaultWorkerPath();
    const model = this.config.audioTranscribeModel ?? 'small.en';
    const device = this.config.audioTranscribeDevice ?? 'cpu';
    const child = spawn(
      this.config.audioTranscribePythonBin,
      [workerPath, '--model', model, '--device', device],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    this.child = child;

    this.startPromise = new Promise<WorkerReadyMessage>((resolvePromise, rejectPromise) => {
      let ready = false;
      const startupTimeout = setTimeout(() => {
        rejectPromise(new Error(`persistent Whisper startup exceeded ${this.config.audioTranscribeTimeoutMs}ms`));
        child.kill('SIGTERM');
      }, this.config.audioTranscribeTimeoutMs);
      startupTimeout.unref();

      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let message: WorkerMessage;
        try {
          message = JSON.parse(line) as WorkerMessage;
        } catch {
          return;
        }
        if (message.type === 'ready') {
          ready = true;
          clearTimeout(startupTimeout);
          resolvePromise(message);
          return;
        }
        this.handleResult(message);
      });

      child.stderr.on('data', (chunk) => {
        this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4096);
      });
      child.on('error', (error) => {
        if (!ready) {
          clearTimeout(startupTimeout);
          rejectPromise(error);
        }
      });
      child.on('close', (code, signal) => {
        clearTimeout(startupTimeout);
        lines.close();
        if (this.child === child) {
          this.child = undefined;
          this.startPromise = undefined;
        }
        const detail = this.stderrTail.trim();
        const error = new Error(
          `persistent Whisper worker exited code=${code ?? 'null'} signal=${signal ?? 'none'}${
            detail ? `: ${detail}` : ''
          }`
        );
        if (!ready && !this.stopping) rejectPromise(error);
        this.rejectPending(error);
      });
    });

    return this.startPromise;
  }

  private handleResult(message: WorkerResultMessage | WorkerErrorMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.type === 'error') {
      pending.reject(new Error(message.error));
      return;
    }
    const text = message.text.trim();
    if (!text) {
      // Match the non-persistent and native OpenClaw media paths: silence is
      // an empty transcription outcome, not a transport failure worth retrying.
      pending.resolve(undefined);
      return;
    }
    console.log(`local Whisper transcribed in ${message.duration_ms}ms`);
    pending.resolve(text);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

let singleton: { signature: string; client: PersistentWhisperClient } | undefined;

function clientFor(config: BridgeConfig): PersistentWhisperClient {
  const signature = JSON.stringify({
    python: config.audioTranscribePythonBin,
    worker: config.audioTranscribeWorkerPath,
    model: config.audioTranscribeModel,
    device: config.audioTranscribeDevice,
    timeout: config.audioTranscribeTimeoutMs
  });
  if (singleton?.signature === signature) return singleton.client;
  singleton?.client.shutdown();
  const client = new PersistentWhisperClient(config);
  singleton = { signature, client };
  return client;
}

export async function warmPersistentWhisper(config: BridgeConfig): Promise<WorkerReadyMessage | undefined> {
  if (
    !config.audioTranscribeEnabled ||
    config.audioTranscribeEngine !== 'local_whisper' ||
    !config.audioTranscribePersistent
  ) {
    return undefined;
  }
  return clientFor(config).warm();
}

export async function transcribeWithPersistentWhisper(
  config: BridgeConfig,
  filePath: string
): Promise<string | undefined> {
  return clientFor(config).transcribe(filePath);
}

export function shutdownPersistentWhisper(): void {
  singleton?.client.shutdown();
  singleton = undefined;
}
