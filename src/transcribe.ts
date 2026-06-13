import { spawn } from 'node:child_process';
import type { BridgeConfig } from './types.js';

interface OpenClawTranscription {
  text?: unknown;
  transcript?: unknown;
}

function parseTranscript(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as OpenClawTranscription;
    if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text.trim();
    if (typeof parsed.transcript === 'string' && parsed.transcript.trim()) return parsed.transcript.trim();
  } catch {
    return trimmed;
  }
  return undefined;
}

export function isAudioMimeType(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.toLowerCase().startsWith('audio/'));
}

export async function transcribeAudioFile(config: BridgeConfig, filePath: string): Promise<string | undefined> {
  if (!config.audioTranscribeEnabled) {
    return undefined;
  }

  const args = ['infer', 'audio', 'transcribe', '--file', filePath, '--json'];
  if (config.audioTranscribeModel) {
    args.push('--model', config.audioTranscribeModel);
  }
  if (config.audioTranscribeLanguage) {
    args.push('--language', config.audioTranscribeLanguage);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(config.audioTranscribeCliBin, args, {
      cwd: config.openclawWorkdir,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
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
        resolve(parseTranscript(stdout));
      } else {
        reject(new Error(`audio transcription exited ${code}: ${stderr || stdout}`.trim()));
      }
    });
  });
}
