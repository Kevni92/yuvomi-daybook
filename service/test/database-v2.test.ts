import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  addMedia,
  createEntry,
  deleteMedia,
  listEntries,
  openDatabase,
  updateEntry,
} from '../src/db/database-v2.js';

test('updates day-only entries and removes attached media metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daybook-v2-'));
  const database = openDatabase(path.join(dir, 'test.db'));
  try {
    const id = createEntry(database, {
      authorUserId: 1,
      title: 'Alter Titel',
      body: 'Alter Text',
      occurredAt: '2026-09-18',
      people: [{ id: 3, display_name: 'Marie', color: '#38BDF8' }],
      locationLabel: 'Foto-Ort',
      latitude: 49.35,
      longitude: 8.08,
      now: new Date('2026-09-18T10:00:00Z'),
    });

    const mediaId = addMedia(database, {
      entryId: id,
      kind: 'image',
      fileName: 'foto.jpg',
      mimeType: 'image/jpeg',
      storageName: 'foto-test.jpg',
      sizeBytes: 123,
      now: new Date('2026-09-18T10:00:00Z'),
    });

    assert.equal(updateEntry(database, id, {
      title: 'Neuer Titel',
      body: 'Neuer Text',
      occurredAt: '2026-09-19',
      people: [{ id: 4, display_name: 'Nicolas', color: '#34D399' }],
      locationLabel: null,
      latitude: null,
      longitude: null,
      now: new Date('2026-09-20T08:00:00Z'),
    }), true);

    let entry = listEntries(database)[0];
    assert.equal(entry?.title, 'Neuer Titel');
    assert.equal(entry?.occurred_on, '2026-09-19');
    assert.equal(entry?.latitude, null);
    assert.deepEqual(entry?.people, [{ id: 4, display_name: 'Nicolas', color: '#34D399' }]);
    assert.equal(Array.isArray(entry?.media) ? entry.media.length : 0, 1);

    const removed = deleteMedia(database, mediaId);
    assert.equal(removed?.file_name, 'foto.jpg');
    entry = listEntries(database)[0];
    assert.equal(Array.isArray(entry?.media) ? entry.media.length : 0, 0);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
