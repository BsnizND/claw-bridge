import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeWithPersistentWhisper } from './persistent-whisper.js';
import type { BridgeConfig } from './types.js';

interface OpenClawTranscription {
  text?: unknown;
  transcript?: unknown;
  outputs?: Array<{
    text?: unknown;
  }>;
}

function parseTranscript(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as OpenClawTranscription;
    if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text.trim();
    if (typeof parsed.transcript === 'string' && parsed.transcript.trim()) return parsed.transcript.trim();
    const outputText = parsed.outputs?.find((output) => typeof output.text === 'string' && output.text.trim())?.text;
    if (typeof outputText === 'string') return outputText.trim();
  } catch {
    return trimmed;
  }
  return undefined;
}

export function isAudioMimeType(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.toLowerCase().startsWith('audio/'));
}

async function runTranscriber(
  config: BridgeConfig,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.audioTranscribeCliBin, args, {
      cwd: config.openclawWorkdir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
      reject(new Error(`audio transcription exceeded ${config.audioTranscribeTimeoutMs}ms`));
    }, config.audioTranscribeTimeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`audio transcription exited ${code}: ${stderr || stdout}`.trim()));
      }
    });
  });
}

async function transcribeWithOpenClaw(config: BridgeConfig, filePath: string): Promise<string | undefined> {
  const args = ['infer', 'audio', 'transcribe', '--file', filePath, '--json'];
  if (config.audioTranscribeModel) args.push('--model', config.audioTranscribeModel);
  if (config.audioTranscribeLanguage) args.push('--language', config.audioTranscribeLanguage);
  const { stdout } = await runTranscriber(config, args);
  return parseTranscript(stdout);
}

async function transcribeWithLocalWhisper(config: BridgeConfig, filePath: string): Promise<string | undefined> {
  if (config.audioTranscribePersistent) {
    return transcribeWithPersistentWhisper(config, filePath);
  }
  const outputDirectory = await mkdtemp(join(tmpdir(), 'claw-bridge-whisper-'));
  try {
    const args = [
      filePath,
      '--model',
      config.audioTranscribeModel ?? 'turbo',
      '--output_format',
      'json',
      '--output_dir',
      outputDirectory,
      '--verbose',
      'False'
    ];
    if (config.audioTranscribeLanguage) args.push('--language', config.audioTranscribeLanguage);
    await runTranscriber(config, args);
    const outputName = (await readdir(outputDirectory)).find((name) => name.endsWith('.json'));
    if (!outputName) return undefined;
    const output = JSON.parse(await readFile(join(outputDirectory, outputName), 'utf8')) as OpenClawTranscription;
    return typeof output.text === 'string' && output.text.trim() ? output.text.trim() : undefined;
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

export async function transcribeAudioFile(config: BridgeConfig, filePath: string): Promise<string | undefined> {
  if (!config.audioTranscribeEnabled) return undefined;
  if (config.audioTranscribeEngine === 'local_whisper') {
    return transcribeWithLocalWhisper(config, filePath);
  }
  return transcribeWithOpenClaw(config, filePath);
}
