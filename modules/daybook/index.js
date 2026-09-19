const API = '/api/extensions/daybook';
const CORE_FAMILY_API = '/api/v1/family/members';
const MAX_IMAGES = 12;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export async function render(container, context = {}) {
  const state = {
    entries: [],
    people: [],
    filterPersonId: null,
    composer: null,
    objectUrls: new Set(),
  };

  container.replaceChildren(buildShell());
  const root = container.querySelector('.daybook');
  const timeline = root.querySelector('[data-daybook-timeline]');
  const filters = root.querySelector('[data-daybook-filters]');
  const count = root.querySelector('[data-daybook-count]');
  const addButton = root.querySelector('[data-daybook-add]');

  const cleanup = () => {
    closeComposer(state);
    for (const url of state.objectUrls) URL.revokeObjectURL(url);
    state.objectUrls.clear();
  };
  context.signal?.addEventListener('abort', cleanup, { once: true });

  addButton?.addEventListener('click', () => openComposer(root, state, reload));
  filters?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-person-filter]');
    if (!button) return;
    const raw = button.dataset.personFilter;
    state.filterPersonId = raw === 'all' ? null : Number(raw);
    renderFilters(filters, state.people, state.filterPersonId);
    renderTimeline(timeline, count, state);
  });

  async function reload() {
    setBusy(root, true);
    const [peopleResult, entriesResult] = await Promise.allSettled([
      loadPeople(),
      loadEntries(),
    ]);
    state.people = peopleResult.status === 'fulfilled' ? peopleResult.value : [];
    state.entries = entriesResult.status === 'fulfilled' ? entriesResult.value : [];
    renderFilters(filters, state.people, state.filterPersonId);
    renderTimeline(timeline, count, state);
    setBusy(root, false);
  }

  await reload();

  const query = new URLSearchParams(window.location.search);
  if (query.get('new') === '1') {
    queueMicrotask(() => openComposer(root, state, reload));
  }
}

function buildShell() {
  const root = document.createElement('main');
  root.className = 'daybook';

  const header = document.createElement('header');
  header.className = 'daybook__header';
  header.innerHTML = `
    <div>
      <span class="daybook__eyebrow">Unsere Geschichte</span>
      <h1>Familientagebuch</h1>
      <p>Große Meilensteine und kleine Momente – an einem Ort.</p>
    </div>
    <button class="daybook__add" type="button" data-daybook-add>
      <i data-lucide="plus" aria-hidden="true"></i>
      <span>Erinnerung</span>
    </button>
  `;

  const toolbar = document.createElement('section');
  toolbar.className = 'daybook__toolbar';
  toolbar.innerHTML = `
    <div class="daybook__filters" data-daybook-filters aria-label="Nach Person filtern"></div>
    <span class="daybook__count" data-daybook-count></span>
  `;

  const timeline = document.createElement('section');
  timeline.className = 'daybook__timeline-host';
  timeline.dataset.daybookTimeline = '';
  timeline.innerHTML = '<div class="daybook__loading">Erinnerungen werden geladen …</div>';

  root.append(header, toolbar, timeline);
  queueMicrotask(() => window.lucide?.createIcons?.({ el: root }));
  return root;
}

async function loadPeople() {
  for (const url of [CORE_FAMILY_API, `${API}/people`]) {
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) continue;
      const payload = await response.json();
      const raw = Array.isArray(payload?.data) ? payload.data : [];
      return raw.map(normalizePerson).filter(Boolean);
    } catch {
      // Try the next source.
    }
  }
  return [];
}

function normalizePerson(person) {
  const id = Number(person?.id);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const name = String(person?.display_name || person?.name || `Person ${id}`);
  const color = validColor(person?.color) || validColor(person?.avatar_color) || colorForPerson(id, name);
  return { id, display_name: name, color };
}

async function loadEntries() {
  const response = await fetch(`${API}/entries`, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    if (response.status === 404 || response.status === 503) return [];
    throw new Error(`Daybook API HTTP ${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

function renderFilters(host, people, selectedId) {
  host.replaceChildren();
  host.append(filterButton('all', 'Alle', '#A78BFA', selectedId === null));
  for (const person of people) {
    host.append(filterButton(String(person.id), person.display_name, person.color, selectedId === person.id));
  }
}

function filterButton(id, label, color, active) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `daybook-filter${active ? ' is-active' : ''}`;
  button.dataset.personFilter = id;
  button.style.setProperty('--person-color', color);
  button.innerHTML = `<span class="daybook-filter__dot" aria-hidden="true"></span><span></span>`;
  button.lastElementChild.textContent = label;
  return button;
}

function renderTimeline(host, countHost, state) {
  const filtered = state.filterPersonId === null
    ? state.entries
    : state.entries.filter((entry) => entryPeople(entry).some((person) => Number(person.id) === state.filterPersonId));
  filtered.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
  countHost.textContent = `${filtered.length} ${filtered.length === 1 ? 'Erinnerung' : 'Erinnerungen'}`;
  host.replaceChildren();

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'daybook-empty';
    empty.innerHTML = `
      <div class="daybook-empty__icon"><i data-lucide="book-heart" aria-hidden="true"></i></div>
      <h2>Noch keine Erinnerung</h2>
      <p>Halte den ersten kleinen oder großen Familienmoment fest.</p>
      <button type="button" class="daybook-empty__button" data-empty-add>Erste Erinnerung anlegen</button>
    `;
    empty.querySelector('[data-empty-add]').addEventListener('click', () => {
      document.querySelector('[data-daybook-add]')?.click();
    });
    host.append(empty);
    window.lucide?.createIcons?.({ el: empty });
    return;
  }

  host.append(buildHero(filtered[0]));
  if (filtered.length > 1) {
    const rail = document.createElement('div');
    rail.className = 'daybook-timeline';
    filtered.slice(1).forEach((entry, index) => rail.append(buildTimelineItem(entry, index)));
    host.append(rail);
  }
  window.lucide?.createIcons?.({ el: host });
}

function buildHero(entry) {
  const card = document.createElement('article');
  card.className = 'daybook-hero';
  const images = entryMedia(entry, 'image');
  const people = entryPeople(entry);
  const primary = people[0];
  const accent = primary?.color || '#D88AA2';
  card.style.setProperty('--entry-accent', accent);

  if (images.length) {
    const media = document.createElement('div');
    media.className = 'daybook-hero__media';
    const img = document.createElement('img');
    img.src = mediaUrl(images[0]);
    img.alt = '';
    img.loading = 'lazy';
    media.append(img);
    card.append(media);
  }

  const content = document.createElement('div');
  content.className = 'daybook-hero__content';
  const label = document.createElement('div');
  label.className = 'daybook-hero__label';
  label.innerHTML = '<span>Neueste Erinnerung</span><i data-lucide="sparkles" aria-hidden="true"></i>';
  content.append(label, buildEntryContent(entry, { hero: true }));
  card.append(content);
  return card;
}

function buildTimelineItem(entry, index) {
  const wrapper = document.createElement('div');
  wrapper.className = `daybook-timeline__item ${index % 2 === 0 ? 'is-left' : 'is-right'}`;
  const people = entryPeople(entry);
  wrapper.style.setProperty('--entry-accent', people[0]?.color || '#D88AA2');

  const node = document.createElement('div');
  node.className = 'daybook-timeline__node';
  node.innerHTML = '<span></span>';

  const card = document.createElement('article');
  card.className = 'daybook-card';
  card.append(buildEntryContent(entry, { hero: false }));
  wrapper.append(node, card);
  return wrapper;
}

function buildEntryContent(entry, { hero }) {
  const fragment = document.createDocumentFragment();
  const top = document.createElement('div');
  top.className = 'daybook-entry__top';

  const date = document.createElement('time');
  date.className = 'daybook-entry__date';
  date.dateTime = entry.occurred_at;
  date.textContent = formatEntryDate(entry.occurred_at);
  top.append(date);

  const peopleHost = document.createElement('div');
  peopleHost.className = 'daybook-entry__people';
  for (const person of entryPeople(entry)) peopleHost.append(personBadge(person, hero));
  top.append(peopleHost);
  fragment.append(top);

  const title = document.createElement(hero ? 'h2' : 'h3');
  title.className = 'daybook-entry__title';
  title.textContent = entry.title || 'Erinnerung';
  fragment.append(title);

  if (entry.body) {
    const body = document.createElement('p');
    body.className = 'daybook-entry__body';
    body.textContent = entry.body;
    fragment.append(body);
  }

  const images = entryMedia(entry, 'image');
  if (images.length) fragment.append(buildGallery(images, hero));

  const audio = entryMedia(entry, 'audio');
  for (const item of audio) fragment.append(buildAudio(item));

  if (hasLocation(entry)) fragment.append(buildLocation(entry));
  return fragment;
}

function personBadge(person, hero = false) {
  const chip = document.createElement('span');
  chip.className = `daybook-person${hero ? ' daybook-person--hero' : ''}`;
  chip.style.setProperty('--person-color', person.color || colorForPerson(person.id, person.display_name));
  chip.innerHTML = '<span class="daybook-person__dot"></span><span></span>';
  chip.lastElementChild.textContent = person.display_name;
  return chip;
}

function buildGallery(images, hero) {
  const gallery = document.createElement('div');
  gallery.className = `daybook-gallery${hero ? ' daybook-gallery--hero' : ''}`;
  images.slice(0, 4).forEach((media, index) => {
    const frame = document.createElement('button');
    frame.type = 'button';
    frame.className = 'daybook-gallery__frame';
    const img = document.createElement('img');
    img.src = mediaUrl(media);
    img.alt = media.file_name || 'Tagebuchfoto';
    img.loading = 'lazy';
    frame.append(img);
    if (index === 3 && images.length > 4) {
      const more = document.createElement('span');
      more.className = 'daybook-gallery__more';
      more.textContent = `+${images.length - 4}`;
      frame.append(more);
    }
    frame.addEventListener('click', () => window.open(img.src, '_blank', 'noopener'));
    gallery.append(frame);
  });
  return gallery;
}

function buildAudio(media) {
  const box = document.createElement('div');
  box.className = 'daybook-audio';
  const icon = document.createElement('div');
  icon.className = 'daybook-audio__icon';
  icon.innerHTML = '<i data-lucide="audio-lines" aria-hidden="true"></i>';
  const body = document.createElement('div');
  body.className = 'daybook-audio__body';
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = mediaUrl(media);
  body.append(audio);
  if (media.transcript) {
    const transcript = document.createElement('p');
    transcript.textContent = media.transcript;
    body.append(transcript);
  }
  box.append(icon, body);
  return box;
}

function buildLocation(entry) {
  const section = document.createElement('section');
  section.className = 'daybook-location';
  const header = document.createElement('div');
  header.className = 'daybook-location__header';
  header.innerHTML = '<i data-lucide="map-pin" aria-hidden="true"></i><span></span>';
  header.lastElementChild.textContent = entry.location_label || 'Aufnahmeort';
  section.append(header);
  const frame = document.createElement('iframe');
  frame.loading = 'lazy';
  frame.referrerPolicy = 'no-referrer-when-downgrade';
  frame.title = `Karte: ${entry.location_label || 'Aufnahmeort'}`;
  frame.src = googleMapsEmbed(entry.latitude, entry.longitude);
  section.append(frame);
  return section;
}

function openComposer(root, state, reload) {
  if (state.composer) return;
  const overlay = document.createElement('div');
  overlay.className = 'daybook-composer-backdrop';
  overlay.innerHTML = `
    <section class="daybook-composer" role="dialog" aria-modal="true" aria-labelledby="daybook-composer-title">
      <header class="daybook-composer__header">
        <div>
          <span class="daybook__eyebrow">Neue Erinnerung</span>
          <h2 id="daybook-composer-title">Was ist passiert?</h2>
        </div>
        <button type="button" class="daybook-icon-button" data-composer-close aria-label="Schließen"><i data-lucide="x"></i></button>
      </header>
      <div class="daybook-composer__body">
        <label class="daybook-field"><span>Titel</span><input type="text" maxlength="140" data-entry-title placeholder="z. B. Maries erster Schultag"></label>
        <label class="daybook-field"><span>Zeitpunkt</span><input type="datetime-local" data-entry-date></label>
        <div class="daybook-field"><span>Wer war dabei?</span><div class="daybook-person-picker" data-entry-people></div></div>
        <label class="daybook-field"><span>Erinnerung</span><textarea rows="6" maxlength="12000" data-entry-body placeholder="Erzähl, was diesen Moment besonders gemacht hat …"></textarea></label>

        <div class="daybook-composer__capture-grid">
          <button type="button" class="daybook-capture" data-audio-record><i data-lucide="mic"></i><span>Sprachnachricht</span><small>Aufnehmen & transkribieren</small></button>
          <label class="daybook-capture daybook-capture--file"><i data-lucide="images"></i><span>Fotos</span><small>GPS wird aus EXIF gelesen</small><input type="file" accept="image/jpeg,image/png,image/webp" multiple data-image-input></label>
        </div>

        <div class="daybook-draft-media" data-draft-media hidden></div>
        <div class="daybook-transcription" data-transcription-status hidden></div>
        <div class="daybook-location-editor" data-location-editor hidden>
          <div><i data-lucide="map-pin"></i><strong>Ort aus Foto erkannt</strong><span data-location-copy></span></div>
          <iframe loading="lazy" title="Karten-Vorschau" data-location-map></iframe>
        </div>
        <div class="daybook-composer__feedback" data-composer-feedback aria-live="polite"></div>
      </div>
      <footer class="daybook-composer__footer">
        <button type="button" class="daybook-button daybook-button--ghost" data-composer-cancel>Abbrechen</button>
        <button type="button" class="daybook-button daybook-button--primary" data-composer-save><i data-lucide="check"></i> Erinnerung speichern</button>
      </footer>
    </section>
  `;

  const draft = {
    overlay,
    pending: [],
    selectedPeople: new Set(),
    recording: null,
    location: null,
  };
  state.composer = draft;
  root.append(overlay);
  window.lucide?.createIcons?.({ el: overlay });

  const dateInput = overlay.querySelector('[data-entry-date]');
  dateInput.value = localDateTimeValue(new Date());
  renderPersonPicker(overlay.querySelector('[data-entry-people]'), state.people, draft.selectedPeople);

  const close = () => closeComposer(state);
  overlay.querySelector('[data-composer-close]').addEventListener('click', close);
  overlay.querySelector('[data-composer-cancel]').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('[data-entry-people]').addEventListener('click', (event) => {
    const button = event.target.closest('[data-person-id]');
    if (!button) return;
    const id = Number(button.dataset.personId);
    if (draft.selectedPeople.has(id)) draft.selectedPeople.delete(id);
    else draft.selectedPeople.add(id);
    renderPersonPicker(overlay.querySelector('[data-entry-people]'), state.people, draft.selectedPeople);
  });

  overlay.querySelector('[data-image-input]').addEventListener('change', async (event) => {
    const files = [...event.target.files].slice(0, MAX_IMAGES - draft.pending.filter((item) => item.kind === 'image').length);
    for (const file of files) {
      if (file.size > MAX_MEDIA_BYTES) continue;
      const url = URL.createObjectURL(file);
      state.objectUrls.add(url);
      const gps = await extractGpsFromJpeg(file).catch(() => null);
      draft.pending.push({ kind: 'image', file, url, gps });
      if (!draft.location && gps) {
        draft.location = { latitude: gps.latitude, longitude: gps.longitude, label: 'Aus Foto übernommen' };
        renderDraftLocation(overlay, draft.location);
      }
    }
    renderDraftMedia(overlay, draft);
    event.target.value = '';
  });

  overlay.querySelector('[data-audio-record]').addEventListener('click', () => toggleRecording(overlay, draft, state));
  overlay.querySelector('[data-composer-save]').addEventListener('click', () => saveDraft(overlay, draft, state, reload));
  setTimeout(() => overlay.querySelector('[data-entry-title]')?.focus(), 30);
}

function renderPersonPicker(host, people, selected) {
  host.replaceChildren();
  for (const person of people) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.personId = String(person.id);
    button.className = `daybook-person-choice${selected.has(person.id) ? ' is-selected' : ''}`;
    button.style.setProperty('--person-color', person.color);
    button.innerHTML = '<span class="daybook-person-choice__dot"></span><span></span><i data-lucide="check"></i>';
    button.children[1].textContent = person.display_name;
    host.append(button);
  }
  window.lucide?.createIcons?.({ el: host });
}

async function toggleRecording(overlay, draft, state) {
  const button = overlay.querySelector('[data-audio-record]');
  const status = overlay.querySelector('[data-transcription-status]');
  if (draft.recording) {
    draft.recording.recorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showFeedback(overlay, 'Audioaufnahme wird von diesem Browser nicht unterstützt.', true);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    draft.recording = { recorder, stream };
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener('stop', async () => {
      stream.getTracks().forEach((track) => track.stop());
      draft.recording = null;
      button.classList.remove('is-recording');
      button.querySelector('span').textContent = 'Sprachnachricht';
      const mime = recorder.mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      const file = new File([blob], `erinnerung-${Date.now()}.webm`, { type: mime });
      const url = URL.createObjectURL(file);
      state.objectUrls.add(url);
      const audioDraft = { kind: 'audio', file, url, transcript: '' };
      draft.pending.push(audioDraft);
      renderDraftMedia(overlay, draft);
      status.hidden = false;
      status.className = 'daybook-transcription is-working';
      status.textContent = 'Sprachnachricht wird transkribiert …';
      try {
        const transcript = await transcribe(file);
        audioDraft.transcript = transcript;
        status.className = 'daybook-transcription is-done';
        status.textContent = 'Transkription fertig.';
        const body = overlay.querySelector('[data-entry-body]');
        body.value = body.value.trim() ? `${body.value.trim()}\n\n${transcript}` : transcript;
      } catch (error) {
        status.className = 'daybook-transcription is-error';
        status.textContent = error?.message || 'Transkription fehlgeschlagen. Audio bleibt erhalten.';
      }
    }, { once: true });
    recorder.start();
    button.classList.add('is-recording');
    button.querySelector('span').textContent = 'Aufnahme stoppen';
    status.hidden = false;
    status.className = 'daybook-transcription is-recording';
    status.textContent = 'Aufnahme läuft …';
  } catch {
    showFeedback(overlay, 'Mikrofonzugriff wurde nicht erlaubt.', true);
  }
}

async function transcribe(file) {
  const response = await fetch(`${API}/transcribe`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': file.type || 'audio/webm',
      'x-file-name': encodeURIComponent(file.name),
    },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || 'Speech-to-Text ist derzeit nicht verfügbar.');
  return String(payload?.data?.text || '').trim();
}

function renderDraftMedia(overlay, draft) {
  const host = overlay.querySelector('[data-draft-media]');
  host.hidden = draft.pending.length === 0;
  host.replaceChildren();
  draft.pending.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = `daybook-draft-media__item is-${item.kind}`;
    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = '';
      card.append(img);
    } else {
      card.innerHTML = '<i data-lucide="audio-lines"></i><span>Sprachnachricht</span>';
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'daybook-draft-media__remove';
    remove.setAttribute('aria-label', 'Medium entfernen');
    remove.innerHTML = '<i data-lucide="x"></i>';
    remove.addEventListener('click', () => {
      draft.pending.splice(index, 1);
      renderDraftMedia(overlay, draft);
    });
    card.append(remove);
    host.append(card);
  });
  window.lucide?.createIcons?.({ el: host });
}

function renderDraftLocation(overlay, location) {
  const host = overlay.querySelector('[data-location-editor]');
  host.hidden = false;
  host.querySelector('[data-location-copy]').textContent = `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
  host.querySelector('[data-location-map]').src = googleMapsEmbed(location.latitude, location.longitude);
}

async function saveDraft(overlay, draft, state, reload) {
  const button = overlay.querySelector('[data-composer-save]');
  const title = overlay.querySelector('[data-entry-title]').value.trim();
  const body = overlay.querySelector('[data-entry-body]').value.trim();
  const occurredAt = localInputToIso(overlay.querySelector('[data-entry-date]').value);
  if (!title && !body && !draft.pending.length) {
    showFeedback(overlay, 'Schreib etwas oder füge ein Foto bzw. Audio hinzu.', true);
    return;
  }
  button.disabled = true;
  showFeedback(overlay, 'Erinnerung wird gespeichert …');
  try {
    const selected = state.people.filter((person) => draft.selectedPeople.has(person.id));
    const response = await fetch(`${API}/entries`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: title || fallbackTitle(occurredAt),
        body,
        occurred_at: occurredAt,
        people: selected,
        location_label: draft.location?.label || null,
        latitude: draft.location?.latitude ?? null,
        longitude: draft.location?.longitude ?? null,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || 'Erinnerung konnte nicht gespeichert werden.');
    const id = Number(payload?.data?.id);
    if (!Number.isSafeInteger(id)) throw new Error('Ungültige Antwort beim Speichern.');

    for (const item of draft.pending) {
      const mediaResponse = await fetch(`${API}/entries/${id}/media?kind=${encodeURIComponent(item.kind)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': item.file.type || 'application/octet-stream',
          'x-file-name': encodeURIComponent(item.file.name || `${item.kind}-${Date.now()}`),
        },
        body: item.file,
      });
      const mediaPayload = await mediaResponse.json().catch(() => ({}));
      if (!mediaResponse.ok) throw new Error(mediaPayload?.error || 'Medium konnte nicht gespeichert werden.');
      if (item.kind === 'audio' && item.transcript && mediaPayload?.data?.id) {
        await fetch(`${API}/media/${mediaPayload.data.id}`, {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ transcript: item.transcript }),
        });
      }
    }

    closeComposer(state);
    await reload();
  } catch (error) {
    button.disabled = false;
    showFeedback(overlay, error?.message || 'Speichern fehlgeschlagen.', true);
  }
}

function closeComposer(state) {
  const draft = state.composer;
  if (!draft) return;
  try {
    if (draft.recording?.recorder?.state !== 'inactive') draft.recording.recorder.stop();
    draft.recording?.stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    // Ignore recorder cleanup errors.
  }
  draft.overlay.remove();
  state.composer = null;
}

function showFeedback(overlay, text, error = false) {
  const host = overlay.querySelector('[data-composer-feedback]');
  host.textContent = text;
  host.classList.toggle('is-error', error);
}

function setBusy(root, busy) {
  root.toggleAttribute('aria-busy', busy);
}

function entryPeople(entry) {
  return Array.isArray(entry?.people) ? entry.people.map((person) => ({
    ...person,
    color: validColor(person?.color) || colorForPerson(person?.id, person?.display_name),
  })) : [];
}

function entryMedia(entry, kind) {
  return Array.isArray(entry?.media) ? entry.media.filter((media) => media?.kind === kind) : [];
}

function mediaUrl(media) {
  return media?.url || `${API}/media/${encodeURIComponent(media?.id)}/file`;
}

function hasLocation(entry) {
  return Number.isFinite(Number(entry?.latitude)) && Number.isFinite(Number(entry?.longitude));
}

function googleMapsEmbed(latitude, longitude) {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${latitude},${longitude}`)}&z=14&output=embed`;
}

function formatEntryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('de-DE', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function localDateTimeValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToIso(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function fallbackTitle(occurredAt) {
  return `Erinnerung vom ${new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(occurredAt))}`;
}

function validColor(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^#[0-9a-f]{6}$/i.test(text) ? text : null;
}

function colorForPerson(id, name = '') {
  const palette = ['#A78BFA', '#38BDF8', '#34D399', '#FB7185', '#F59E0B', '#F472B6', '#22D3EE', '#C084FC'];
  let hash = Number(id) || 0;
  for (const char of String(name)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

export async function extractGpsFromJpeg(file) {
  if (!file || !/^image\/jpeg$/i.test(file.type)) return null;
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 < view.byteLength) {
    const marker = view.getUint16(offset, false);
    offset += 2;
    if ((marker & 0xff00) !== 0xff00) break;
    const size = view.getUint16(offset, false);
    if (marker === 0xffe1 && size >= 10 && ascii(view, offset + 2, 4) === 'Exif') {
      return readExifGps(view, offset + 8);
    }
    if (size < 2) break;
    offset += size;
  }
  return null;
}

function readExifGps(view, tiff) {
  if (tiff + 8 > view.byteLength) return null;
  const order = view.getUint16(tiff, false);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return null;
  const u16 = (offset) => view.getUint16(offset, little);
  const u32 = (offset) => view.getUint32(offset, little);
  if (u16(tiff + 2) !== 42) return null;
  const ifd0 = tiff + u32(tiff + 4);
  const entries = u16(ifd0);
  let gpsOffset = null;
  for (let i = 0; i < entries; i += 1) {
    const row = ifd0 + 2 + i * 12;
    if (row + 12 > view.byteLength) break;
    if (u16(row) === 0x8825) gpsOffset = tiff + u32(row + 8);
  }
  if (!gpsOffset || gpsOffset + 2 > view.byteLength) return null;
  const gpsCount = u16(gpsOffset);
  const values = new Map();
  for (let i = 0; i < gpsCount; i += 1) {
    const row = gpsOffset + 2 + i * 12;
    if (row + 12 > view.byteLength) break;
    const tag = u16(row);
    const type = u16(row + 2);
    const count = u32(row + 4);
    const bytes = type === 5 ? count * 8 : count;
    const dataOffset = bytes <= 4 ? row + 8 : tiff + u32(row + 8);
    values.set(tag, { type, count, dataOffset });
  }
  const latRef = readAsciiTag(view, values.get(1));
  const lonRef = readAsciiTag(view, values.get(3));
  const lat = readGpsCoordinate(view, values.get(2), little);
  const lon = readGpsCoordinate(view, values.get(4), little);
  if (!latRef || !lonRef || lat === null || lon === null) return null;
  return {
    latitude: latRef.toUpperCase() === 'S' ? -lat : lat,
    longitude: lonRef.toUpperCase() === 'W' ? -lon : lon,
  };
}

function readAsciiTag(view, tag) {
  if (!tag || tag.dataOffset >= view.byteLength) return '';
  return String.fromCharCode(view.getUint8(tag.dataOffset)).replace(/\0/g, '');
}

function readGpsCoordinate(view, tag, little) {
  if (!tag || tag.type !== 5 || tag.count < 3) return null;
  const rational = (offset) => {
    const numerator = view.getUint32(offset, little);
    const denominator = view.getUint32(offset + 4, little);
    return denominator ? numerator / denominator : 0;
  };
  const base = tag.dataOffset;
  if (base + 24 > view.byteLength) return null;
  return rational(base) + rational(base + 8) / 60 + rational(base + 16) / 3600;
}

function ascii(view, offset, length) {
  let result = '';
  for (let i = 0; i < length && offset + i < view.byteLength; i += 1) result += String.fromCharCode(view.getUint8(offset + i));
  return result;
}
