import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import express, { type RequestHandler } from 'express';
import { config } from '../config.js';
import { daybookPermission, resolveYuvomiUser, type PermissionLevel, type YuvomiUser } from '../auth/yuvomi-session.js';

const PREFIX = '/api/extensions/daybook';
const DEFAULT_TIME = '20:00';
const DEFAULT_TIMEZONE = 'Europe/Berlin';

export interface ReminderSetting {
  enabled: boolean;
  time: string;
  timezone: string;
  last_sent_date: string | null;
}

export function createReminderRouter(): express.Router {
  const database = openReminderDatabase();
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));

  router.get(`${PREFIX}/reminder-settings`, authorize('read'), (request, response) => {
    const user = response.locals.daybookUser as YuvomiUser;
    response.setHeader('cache-control', 'no-store');
    response.json({
      data: {
        ...getReminderSetting(database, user.id),
        push_backend_available: bankingPushAvailable(),
      },
    });
  });

  router.put(`${PREFIX}/reminder-settings`, authorize('write'), (request, response) => {
    const user = response.locals.daybookUser as YuvomiUser;
    const enabled = request.body?.enabled === true;
    const time = normalizeTime(request.body?.time);
    const timezone = normalizeTimezone(request.body?.timezone);
    if (!time) {
      response.status(400).json({ error: 'Die Erinnerungszeit ist ungültig.' });
      return;
    }
    if (!timezone) {
      response.status(400).json({ error: 'Die Zeitzone ist ungültig.' });
      return;
    }
    const setting = saveReminderSetting(database, {
      yuvomiUserId: user.id,
      enabled,
      time,
      timezone,
      now: new Date(),
    });
    response.setHeader('cache-control', 'no-store');
    response.json({ data: { ...setting, push_backend_available: bankingPushAvailable() } });
  });

  return router;
}

export function startDaybookReminderScheduler(options: {
  intervalMs?: number;
  clock?: () => Date;
} = {}): () => void {
  const database = openReminderDatabase();
  const intervalMs = Math.max(15_000, options.intervalMs ?? 30_000);
  const clock = options.clock ?? (() => new Date());
  let running = false;

  const tick = () => {
    if (running) return;
    running = true;
    try {
      runDueDaybookReminders(database, clock());
    } catch (error) {
      console.error('daybook reminder scheduler failed', error);
    } finally {
      running = false;
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    database.close();
  };
}

export function runDueDaybookReminders(database: DatabaseSync, now: Date): number {
  if (!bankingPushAvailable()) return 0;
  const rows = database.prepare(`
    SELECT yuvomi_user_id, enabled, reminder_time, timezone, last_sent_date
      FROM daybook_reminder_settings
     WHERE enabled = 1
     ORDER BY yuvomi_user_id
  `).all() as Array<{
    yuvomi_user_id: number;
    enabled: number;
    reminder_time: string;
    timezone: string;
    last_sent_date: string | null;
  }>;

  let queued = 0;
  for (const row of rows) {
    const local = localClock(now, row.timezone);
    if (!local || local.time !== row.reminder_time || row.last_sent_date === local.date) continue;
    const count = enqueueBankingPushReminder(Number(row.yuvomi_user_id), local.date, now);
    if (count > 0) {
      database.prepare(`
        UPDATE daybook_reminder_settings
           SET last_sent_date = ?, updated_at = ?
         WHERE yuvomi_user_id = ?
      `).run(local.date, now.toISOString(), Number(row.yuvomi_user_id));
      queued += count;
    }
  }
  return queued;
}

export function getReminderSetting(database: DatabaseSync, yuvomiUserId: number): ReminderSetting {
  const row = database.prepare(`
    SELECT enabled, reminder_time, timezone, last_sent_date
      FROM daybook_reminder_settings
     WHERE yuvomi_user_id = ?
  `).get(yuvomiUserId) as {
    enabled: number;
    reminder_time: string;
    timezone: string;
    last_sent_date: string | null;
  } | undefined;
  return {
    enabled: row?.enabled === 1,
    time: row?.reminder_time || DEFAULT_TIME,
    timezone: row?.timezone || DEFAULT_TIMEZONE,
    last_sent_date: row?.last_sent_date ?? null,
  };
}

function saveReminderSetting(database: DatabaseSync, input: {
  yuvomiUserId: number;
  enabled: boolean;
  time: string;
  timezone: string;
  now: Date;
}): ReminderSetting {
  const now = input.now.toISOString();
  database.prepare(`
    INSERT INTO daybook_reminder_settings (
      yuvomi_user_id, enabled, reminder_time, timezone, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(yuvomi_user_id) DO UPDATE SET
      enabled = excluded.enabled,
      reminder_time = excluded.reminder_time,
      timezone = excluded.timezone,
      updated_at = excluded.updated_at
  `).run(input.yuvomiUserId, input.enabled ? 1 : 0, input.time, input.timezone, now, now);
  return getReminderSetting(database, input.yuvomiUserId);
}

function openReminderDatabase(): DatabaseSync {
  const database = new DatabaseSync(config.dbPath);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS daybook_reminder_settings (
      yuvomi_user_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
      reminder_time TEXT NOT NULL DEFAULT '20:00',
      timezone TEXT NOT NULL DEFAULT 'Europe/Berlin',
      last_sent_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return database;
}

function bankingPushAvailable(): boolean {
  return Boolean(
    config.bankingDbPath
    && config.bankingDataEncryptionKey
    && fs.existsSync(config.bankingDbPath)
  );
}

function enqueueBankingPushReminder(yuvomiUserId: number, localDate: string, now: Date): number {
  const banking = new DatabaseSync(config.bankingDbPath);
  try {
    const subscriptions = banking.prepare(`
      SELECT id
        FROM banking_push_subscriptions
       WHERE yuvomi_user_id = ? AND status = 'active'
       ORDER BY id
    `).all(yuvomiUserId) as Array<{ id: number }>;
    if (!subscriptions.length) return 0;

    const payload = encryptBankingValue(JSON.stringify({
      title: 'Familientagebuch',
      body: 'Was war heute besonders? Halte eine Erinnerung im Familientagebuch fest.',
      url: '/m/daybook?new=1',
      tag: `daybook-daily-reminder-${yuvomiUserId}`,
    }), config.bankingDataEncryptionKey);
    let queued = 0;
    for (const subscription of subscriptions) {
      const key = `daybook-reminder:${yuvomiUserId}:${localDate}:subscription:${subscription.id}`;
      const iso = now.toISOString();
      const result = banking.prepare(`
        INSERT INTO weekly_budget_notification_deliveries (
          suggestion_id, subscription_id, recipient_yuvomi_user_id,
          idempotency_key, notification_type, payload_encrypted,
          status, attempt_count, next_attempt_at, created_at, updated_at
        ) VALUES (NULL, ?, ?, ?, 'test', ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
      `).run(subscription.id, yuvomiUserId, key, payload, iso, iso, iso);
      if (Number(result.changes) === 1) queued += 1;
    }
    return queued;
  } finally {
    banking.close();
  }
}

function encryptBankingValue(value: string, secret: string): string {
  const normalized = secret.trim();
  const key = /^[0-9a-f]{64}$/i.test(normalized)
    ? Buffer.from(normalized, 'hex')
    : Buffer.from(normalized, 'base64url');
  if (key.length !== 32) throw new Error('BANKING_DATA_ENCRYPTION_KEY must contain 32 bytes.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function localClock(now: Date, timezone: string): { date: string; time: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '';
    const year = get('year');
    const month = get('month');
    const day = get('day');
    const hour = get('hour');
    const minute = get('minute');
    if (!year || !month || !day || !hour || !minute) return null;
    return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
  } catch {
    return null;
  }
}

function normalizeTime(value: unknown): string | null {
  const text = String(value || '').trim();
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${match[1]}:${match[2]}`;
}

function normalizeTimezone(value: unknown): string | null {
  const timezone = String(value || '').trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return null;
  }
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
