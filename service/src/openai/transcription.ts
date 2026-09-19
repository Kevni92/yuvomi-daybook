import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

const KEY_SETTING = 'openai.api_key_encrypted';

export async function transcribeAudio(input: {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<string> {
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) throw new Error('OpenAI ist nicht konfiguriert. Banking-Einstellung oder OPENAI_API_KEY prüfen.');

  const form = new FormData();
  form.append('model', config.transcriptionModel);
  form.append('language', 'de');
  form.append(
    'file',
    new Blob([new Uint8Array(input.bytes)], { type: input.mimeType || 'audio/webm' }),
    safeFileName(input.fileName, 'aufnahme.webm'),
  );

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  const payload = await response.json().catch(() => ({})) as { text?: unknown; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `OpenAI Transkription fehlgeschlagen (HTTP ${response.status}).`);
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) throw new Error('OpenAI hat keine Transkription zurückgegeben.');
  return text;
}

export function resolveOpenAiApiKey(): string {
  const bankingKey = readBankingStoredApiKey();
  return bankingKey || config.openAiApiKey.trim();
}

function readBankingStoredApiKey(): string {
  if (!config.bankingDbPath || !config.bankingDataEncryptionKey) return '';
  if (!fs.existsSync(config.bankingDbPath)) return '';
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(config.bankingDbPath, { readOnly: true });
    const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(KEY_SETTING) as { value?: string } | undefined;
    if (!row?.value) return '';
    return decryptBankingValue(row.value, config.bankingDataEncryptionKey).trim();
  } catch {
    return '';
  } finally {
    database?.close();
  }
}

function decryptBankingValue(payload: string, secret: string): string {
  const key = bankingKey(secret);
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported Banking secret format.');
  const iv = Buffer.from(parts[1]!, 'base64url');
  const authTag = Buffer.from(parts[2]!, 'base64url');
  const ciphertext = Buffer.from(parts[3]!, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function bankingKey(secret: string): Buffer {
  const normalized = secret.trim();
  if (/^[0-9a-f]{64}$/i.test(normalized)) return Buffer.from(normalized, 'hex');
  const decoded = Buffer.from(normalized, 'base64url');
  if (decoded.length !== 32) throw new Error('BANKING_DATA_ENCRYPTION_KEY must contain 32 bytes.');
  return decoded;
}

function safeFileName(value: string, fallback: string): string {
  const decoded = decodeURIComponentSafely(value);
  const clean = decoded.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean.slice(0, 120) || fallback;
}

function decodeURIComponentSafely(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
