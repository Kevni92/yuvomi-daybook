import fs from 'node:fs';
import path from 'node:path';

function optional(name: string, fallback = ''): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  const filePath = process.env[`${name}_FILE`]?.trim();
  if (!filePath) return fallback;
  return fs.readFileSync(filePath, 'utf8').trim() || fallback;
}

function port(): number {
  const value = Number(optional('PORT', '3200'));
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('PORT is invalid.');
  return value;
}

export const config = {
  host: optional('HOST', '127.0.0.1'),
  port: port(),
  yuvomiInternalUrl: optional('YUVOMI_INTERNAL_URL', 'http://127.0.0.1:3000'),
  dbPath: path.resolve(optional('DAYBOOK_DB_PATH', '../data/daybook.db')),
  mediaDir: path.resolve(optional('DAYBOOK_MEDIA_DIR', '../data/media')),
  maxMediaBytes: 25 * 1024 * 1024,
  bankingDbPath: optional('BANKING_DB_PATH'),
  bankingDataEncryptionKey: optional('BANKING_DATA_ENCRYPTION_KEY'),
  openAiApiKey: optional('OPENAI_API_KEY'),
  transcriptionModel: optional('DAYBOOK_TRANSCRIPTION_MODEL', 'gpt-4o-mini-transcribe'),
};
