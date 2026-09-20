import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { config } from './config.js';
import { daybookPermission, resolveYuvomiUser, type PermissionLevel, type YuvomiUser } from './auth/yuvomi-session.js';
import {
  addMedia,
  createEntry,
  deleteMedia,
  entryExists,
  findMedia,
  listEntries,
  openDatabase,
  updateEntry,
  updateMediaTranscript,
} from './db/database-v2.js';
import { transcribeAudio } from './openai/transcription.js';
import { loadFamilyMembers } from './yuvomi/family.js';

export function createApp(): Express {
  const database = openDatabase();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  const prefix = '/api/extensions/daybook';
  const rawMedia = express.raw({ type: () => true, limit: config.maxMediaBytes });

  app.get(`${prefix}/health`, (_request, response) => {
    response.json({ ok: true, service: 'yuvomi-daybook', version: '0.2.0' });
  });

  app.get(`${prefix}/people`, authorize('read'), asyncRoute(async (request, response) => {
    const people = await loadFamilyMembers(request.headers.cookie);
    response.json({ data: people });
  }));

  app.get(`${prefix}/entries`, authorize('read'), (request, response) => {
    const limit = clampInteger(request.query.limit, 1, 200, 100);
    response.json({ data: listEntries(database, limit) });
  });

  app.post(`${prefix}/entries`, authorize('write'), (request, response) => {
    const user = response.locals.daybookUser as YuvomiUser;
    const input = validateEntryInput(request.body);
    const id = createEntry(database, {
      authorUserId: user.id,
      title: input.title,
      body: input.body,
      occurredAt: input.occurredOn,
      people: input.people,
      locationLabel: input.locationLabel,
      latitude: input.latitude,
      longitude: input.longitude,
      now: new Date(),
    });
    response.status(201).json({ data: { id } });
  });

  app.patch(`${prefix}/entries/:entryId`, authorize('write'), (request, response) => {
    const entryId = positiveInteger(request.params.entryId);
    if (!entryId || !entryExists(database, entryId)) {
      response.status(404).json({ error: 'Erinnerung wurde nicht gefunden.' });
      return;
    }
    const input = validateEntryInput(request.body);
    const changed = updateEntry(database, entryId, {
      title: input.title,
      body: input.body,
      occurredAt: input.occurredOn,
      people: input.people,
      locationLabel: input.locationLabel,
      latitude: input.latitude,
      longitude: input.longitude,
      now: new Date(),
    });
    if (!changed) {
      response.status(404).json({ error: 'Erinnerung wurde nicht gefunden.' });
      return;
    }
    response.json({ data: { id: entryId } });
  });

  app.post(`${prefix}/entries/:entryId/media`, authorize('write'), rawMedia, asyncRoute(async (request, response) => {
    const entryId = positiveInteger(request.params.entryId);
    if (!entryId || !entryExists(database, entryId)) {
      response.status(404).json({ error: 'Erinnerung wurde nicht gefunden.' });
      return;
    }
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      response.status(400).json({ error: 'Leere Mediendatei.' });
      return;
    }
    const kind = request.query.kind === 'audio' ? 'audio' : request.query.kind === 'image' ? 'image' : null;
    if (!kind) {
      response.status(400).json({ error: 'Medientyp muss image oder audio sein.' });
      return;
    }
    const mimeType = String(request.headers['content-type'] || 'application/octet-stream').split(';')[0]!.trim();
    if (!allowedMime(kind, mimeType)) {
      response.status(415).json({ error: 'Dieser Medientyp wird im Prototyp nicht unterstützt.' });
      return;
    }
    const fileName = cleanFileName(request.headers['x-file-name'], kind === 'image' ? 'foto.jpg' : 'aufnahme.webm');
    const extension = extensionFor(fileName, mimeType, kind);
    const storageName = `${crypto.randomUUID()}${extension}`;
    const filePath = path.join(config.mediaDir, storageName);
    await fs.mkdir(config.mediaDir, { recursive: true });
    await fs.writeFile(filePath, request.body);
    try {
      const id = addMedia(database, {
        entryId,
        kind,
        fileName,
        mimeType,
        storageName,
        sizeBytes: request.body.length,
        now: new Date(),
      });
      response.status(201).json({ data: { id, url: `${prefix}/media/${id}/file` } });
    } catch (error) {
      await fs.unlink(filePath).catch(() => {});
      throw error;
    }
  }));

  app.patch(`${prefix}/media/:mediaId`, authorize('write'), (request, response) => {
    const mediaId = positiveInteger(request.params.mediaId);
    const transcript = typeof request.body?.transcript === 'string' ? request.body.transcript.trim().slice(0, 20_000) : '';
    if (!mediaId || !transcript) {
      response.status(400).json({ error: 'Ungültige Transkription.' });
      return;
    }
    if (!updateMediaTranscript(database, mediaId, transcript)) {
      response.status(404).json({ error: 'Audio wurde nicht gefunden.' });
      return;
    }
    response.json({ data: { id: mediaId, transcript } });
  });

  app.delete(`${prefix}/media/:mediaId`, authorize('write'), asyncRoute(async (request, response) => {
    const mediaId = positiveInteger(request.params.mediaId);
    const media = mediaId ? deleteMedia(database, mediaId) : null;
    if (!media) {
      response.status(404).json({ error: 'Medium wurde nicht gefunden.' });
      return;
    }
    await fs.unlink(path.join(config.mediaDir, media.storage_name)).catch(() => {});
    response.status(204).end();
  }));

  app.get(`${prefix}/media/:mediaId/file`, authorize('read'), asyncRoute(async (request, response) => {
    const mediaId = positiveInteger(request.params.mediaId);
    const media = mediaId ? findMedia(database, mediaId) : null;
    if (!media) {
      response.status(404).json({ error: 'Medium wurde nicht gefunden.' });
      return;
    }
    const filePath = path.join(config.mediaDir, media.storage_name);
    try {
      const bytes = await fs.readFile(filePath);
      response.setHeader('content-type', media.mime_type);
      response.setHeader('content-length', String(bytes.length));
      response.setHeader('cache-control', 'private, max-age=3600');
      response.setHeader('content-disposition', `inline; filename="${asciiFileName(media.file_name)}"`);
      response.send(bytes);
    } catch {
      response.status(404).json({ error: 'Mediendatei fehlt.' });
    }
  }));

  app.post(`${prefix}/transcribe`, authorize('write'), rawMedia, asyncRoute(async (request, response) => {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      response.status(400).json({ error: 'Keine Audiodaten empfangen.' });
      return;
    }
    const mimeType = String(request.headers['content-type'] || 'audio/webm').split(';')[0]!.trim();
    if (!allowedMime('audio', mimeType)) {
      response.status(415).json({ error: 'Audioformat wird nicht unterstützt.' });
      return;
    }
    const fileName = cleanFileName(request.headers['x-file-name'], 'aufnahme.webm');
    const text = await transcribeAudio({ bytes: request.body, mimeType, fileName });
    response.json({ data: { text } });
  }));

  app.use((_request, response) => response.status(404).json({ error: 'Not found.' }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : 'Internal error.';
    const tooLarge = typeof error === 'object' && error !== null && 'type' in error && (error as { type?: unknown }).type === 'entity.too.large';
    response.status(tooLarge ? 413 : 500).json({ error: tooLarge ? 'Datei ist zu groß.' : message });
  });

  return app;
}

function authorize(required: PermissionLevel): RequestHandler {
  return async (request, response, next) => {
    try {
      const user = await resolveYuvomiUser(request.headers.cookie);
      if (!user) {
        response.status(401).json({ error: 'Nicht angemeldet.' });
        return;
      }
      const permission = daybookPermission(user);
      if (permission === 'none' || (required === 'write' && permission !== 'write')) {
        response.status(403).json({ error: 'Keine Berechtigung für das Familientagebuch.' });
        return;
      }
      response.locals.daybookUser = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => { void handler(request, response).catch(next); };
}

function validateEntryInput(value: unknown): {
  title: string;
  body: string;
  occurredOn: string;
  people: unknown[];
  locationLabel: string | null;
  latitude: number | null;
  longitude: number | null;
} {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const title = String(record.title || '').trim().slice(0, 140);
  const body = String(record.body || '').trim().slice(0, 12_000);
  const occurredOn = normalizeDateOnly(record.occurred_on ?? record.occurred_at);
  if (!title) throw new Error('Titel fehlt.');
  if (!occurredOn) throw new Error('Datum ist ungültig.');
  const people = Array.isArray(record.people) ? record.people.slice(0, 30) : [];
  const latitude = finiteCoordinate(record.latitude, -90, 90);
  const longitude = finiteCoordinate(record.longitude, -180, 180);
  if ((latitude === null) !== (longitude === null)) throw new Error('Ort benötigt Breiten- und Längengrad.');
  const locationLabel = typeof record.location_label === 'string' && record.location_label.trim()
    ? record.location_label.trim().slice(0, 180)
    : null;
  return { title, body, occurredOn, people, locationLabel, latitude, longitude };
}

function normalizeDateOnly(value: unknown): string | null {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function finiteCoordinate(value: unknown, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error('GPS-Koordinate ist ungültig.');
  return number;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function cleanFileName(value: unknown, fallback: string): string {
  const raw = Array.isArray(value) ? value[0] : typeof value === 'string' ? value : fallback;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* use raw */ }
  const cleaned = path.basename(decoded).replace(/[^\p{L}\p{N}._ -]+/gu, '-').trim();
  return cleaned.slice(0, 140) || fallback;
}

function asciiFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'media';
}

function allowedMime(kind: 'image' | 'audio', mime: string): boolean {
  if (kind === 'image') return ['image/jpeg', 'image/png', 'image/webp'].includes(mime);
  return ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav'].includes(mime);
}

function extensionFor(fileName: string, mimeType: string, kind: 'image' | 'audio'): string {
  const existing = path.extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, '');
  if (existing && existing.length <= 8) return existing;
  const byMime: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  };
  return byMime[mimeType] || (kind === 'image' ? '.img' : '.audio');
}
