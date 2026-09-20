import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

export interface DaybookEntryInput {
  authorUserId: number;
  title: string;
  body: string;
  occurredAt: string;
  people: unknown[];
  locationLabel: string | null;
  latitude: number | null;
  longitude: number | null;
  now: Date;
}

export interface DaybookEntryUpdateInput {
  title: string;
  body: string;
  occurredAt: string;
  people: unknown[];
  locationLabel: string | null;
  latitude: number | null;
  longitude: number | null;
  now: Date;
}

export interface MediaRow {
  id: number;
  entry_id: number;
  kind: 'image' | 'audio';
  file_name: string;
  mime_type: string;
  storage_name: string;
  size_bytes: number;
  transcript: string | null;
  created_at: string;
}

export function openDatabase(dbPath = config.dbPath): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(config.mediaDir, { recursive: true });
  const database = new DatabaseSync(dbPath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS daybook_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      occurred_at TEXT NOT NULL,
      people_json TEXT NOT NULL DEFAULT '[]',
      location_label TEXT,
      latitude REAL,
      longitude REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_daybook_entries_occurred_at
      ON daybook_entries(occurred_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS daybook_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES daybook_entries(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('image', 'audio')),
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      storage_name TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL,
      transcript TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_daybook_media_entry ON daybook_media(entry_id, id);
  `);
  return database;
}

export function createEntry(database: DatabaseSync, input: DaybookEntryInput): number {
  const now = input.now.toISOString();
  const result = database.prepare(`
    INSERT INTO daybook_entries (
      author_user_id, title, body, occurred_at, people_json,
      location_label, latitude, longitude, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.authorUserId,
    input.title,
    input.body,
    input.occurredAt,
    JSON.stringify(input.people),
    input.locationLabel,
    input.latitude,
    input.longitude,
    now,
    now,
  );
  return Number(result.lastInsertRowid);
}

export function updateEntry(database: DatabaseSync, id: number, input: DaybookEntryUpdateInput): boolean {
  const result = database.prepare(`
    UPDATE daybook_entries
       SET title = ?, body = ?, occurred_at = ?, people_json = ?,
           location_label = ?, latitude = ?, longitude = ?, updated_at = ?
     WHERE id = ?
  `).run(
    input.title,
    input.body,
    input.occurredAt,
    JSON.stringify(input.people),
    input.locationLabel,
    input.latitude,
    input.longitude,
    input.now.toISOString(),
    id,
  );
  return Number(result.changes) === 1;
}

export function entryExists(database: DatabaseSync, id: number): boolean {
  return Boolean(database.prepare('SELECT 1 FROM daybook_entries WHERE id = ?').get(id));
}

export function listEntries(database: DatabaseSync, limit = 100): Array<Record<string, unknown>> {
  const rows = database.prepare(`
    SELECT id, author_user_id, title, body, occurred_at, people_json,
           location_label, latitude, longitude, created_at, updated_at
    FROM daybook_entries
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  const media = database.prepare(`
    SELECT id, entry_id, kind, file_name, mime_type, size_bytes, transcript, created_at
    FROM daybook_media
    ORDER BY entry_id, id
  `).all() as Array<Record<string, unknown>>;
  const byEntry = new Map<number, Array<Record<string, unknown>>>();
  for (const item of media) {
    const entryId = Number(item.entry_id);
    const list = byEntry.get(entryId) ?? [];
    list.push({
      id: Number(item.id),
      kind: item.kind,
      file_name: item.file_name,
      mime_type: item.mime_type,
      size_bytes: Number(item.size_bytes),
      transcript: item.transcript,
      created_at: item.created_at,
      url: `/api/extensions/daybook/media/${Number(item.id)}/file`,
    });
    byEntry.set(entryId, list);
  }

  return rows.map((row) => ({
    id: Number(row.id),
    author_user_id: Number(row.author_user_id),
    title: row.title,
    body: row.body,
    occurred_at: row.occurred_at,
    occurred_on: dateKey(row.occurred_at),
    people: parsePeople(row.people_json),
    location_label: row.location_label,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    created_at: row.created_at,
    updated_at: row.updated_at,
    media: byEntry.get(Number(row.id)) ?? [],
  }));
}

export function addMedia(database: DatabaseSync, input: {
  entryId: number;
  kind: 'image' | 'audio';
  fileName: string;
  mimeType: string;
  storageName: string;
  sizeBytes: number;
  now: Date;
}): number {
  const result = database.prepare(`
    INSERT INTO daybook_media (
      entry_id, kind, file_name, mime_type, storage_name, size_bytes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.entryId,
    input.kind,
    input.fileName,
    input.mimeType,
    input.storageName,
    input.sizeBytes,
    input.now.toISOString(),
  );
  return Number(result.lastInsertRowid);
}

export function updateMediaTranscript(database: DatabaseSync, id: number, transcript: string): boolean {
  const result = database.prepare('UPDATE daybook_media SET transcript = ? WHERE id = ?').run(transcript, id);
  return Number(result.changes) === 1;
}

export function findMedia(database: DatabaseSync, id: number): MediaRow | null {
  const row = database.prepare(`
    SELECT id, entry_id, kind, file_name, mime_type, storage_name, size_bytes, transcript, created_at
    FROM daybook_media WHERE id = ?
  `).get(id) as MediaRow | undefined;
  return row ?? null;
}

export function deleteMedia(database: DatabaseSync, id: number): MediaRow | null {
  const media = findMedia(database, id);
  if (!media) return null;
  const result = database.prepare('DELETE FROM daybook_media WHERE id = ?').run(id);
  return Number(result.changes) === 1 ? media : null;
}

function dateKey(value: unknown): string {
  const text = String(value || '');
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (match) return match[1]!;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function parsePeople(value: unknown): unknown[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
