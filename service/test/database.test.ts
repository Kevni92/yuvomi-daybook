import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createEntry, listEntries, openDatabase } from '../src/db/database.js';

test('stores newest family memory first and preserves people snapshots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-'));
  const database = openDatabase(path.join(dir, 'test.db'));
  try {
    const first = createEntry(database, {
      authorUserId: 1,
      title: 'Erster Eintrag',
      body: 'Text',
      occurredAt: '2026-09-10T10:00:00.000Z',
      people: [{ id: 3, display_name: 'Marie', color: '#A78BFA' }],
      locationLabel: null,
      latitude: null,
      longitude: null,
      now: new Date('2026-09-10T10:00:00.000Z'),
    });
    assert.ok(first > 0);
    createEntry(database, {
      authorUserId: 1,
      title: 'Neuer Eintrag',
      body: '',
      occurredAt: '2026-09-12T10:00:00.000Z',
      people: [],
      locationLabel: 'Foto-Ort',
      latitude: 49.35,
      longitude: 8.08,
      now: new Date('2026-09-12T10:00:00.000Z'),
    });
    const entries = listEntries(database);
    assert.equal(entries[0]?.title, 'Neuer Eintrag');
    assert.deepEqual(entries[1]?.people, [{ id: 3, display_name: 'Marie', color: '#A78BFA' }]);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
