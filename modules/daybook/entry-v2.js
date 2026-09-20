import { extractGpsFromJpeg } from './index.js';

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
    detail: null,
    objectUrls: new Set(),
  };

  container.replaceChildren(buildShell());
  const root = container.querySelector('.daybook');
  const timeline = root.querySelector('[data-daybook-timeline]');
  const filters = root.querySelector('[data-daybook-filters]');
  const count = root.querySelector('[data-daybook-count]');

  const cleanup = () => {
    closeComposer(state);
    closeDetail(state);
    for (const url of state.objectUrls) URL.revokeObjectURL(url);
    state.objectUrls.clear();
  };
  context.signal?.addEventListener('abort', cleanup, { once: true });

  root.querySelector('[data-daybook-add]')?.addEventListener('click', () => openComposer(root, state, reload));
  filters?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-person-filter]');
    if (!button) return;
    const raw = button.dataset.personFilter;
    state.filterPersonId = raw === 'all' ? null : Number(raw);
    renderFilters(filters, state.people, state.filterPersonId);
    renderTimeline(timeline, count, root, state, reload);
  });

  async function reload() {
    root.setAttribute('aria-busy', 'true');
    const [peopleResult, entriesResult] = await Promise.allSettled([loadPeople(), loadEntries()]);
    state.people = peopleResult.status === 'fulfilled' ? peopleResult.value : [];
    state.entries = entriesResult.status === 'fulfilled' ? entriesResult.value : [];
    renderFilters(filters, state.people, state.filterPersonId);
    renderTimeline(timeline, count, root, state, reload);
    root.removeAttribute('aria-busy');
  }

  await reload();

  const query = new URLSearchParams(window.location.search);
  if (query.get('new') === '1') queueMicrotask(() => openComposer(root, state, reload));
}

function buildShell() {
  const root = document.createElement('main');
  root.className = 'daybook';
  root.innerHTML = `
    <header class="daybook__header">
      <div>
        <span class="daybook__eyebrow">Unsere Geschichte</span>
        <h1>Familientagebuch</h1>
        <p>Große Meilensteine und kleine Momente – an einem Ort.</p>
      </div>
      <button class="daybook__add" type="button" data-daybook-add>
        <i data-lucide="plus" aria-hidden="true"></i><span>Erinnerung</span>
      </button>
    </header>
    <section class="daybook__toolbar">
      <div class="daybook__filters" data-daybook-filters aria-label="Nach Person filtern"></div>
      <span class="daybook__count" data-daybook-count></span>
    </section>
    <section class="daybook__timeline-host" data-daybook-timeline>
      <div class="daybook__loading">Erinnerungen werden geladen …</div>
    </section>
  `;
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
      // Try fallback endpoint.
    }
  }
  return [];
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

function normalizePerson(person) {
  const id = Number(person?.id);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const display_name = String(person?.display_name || person?.name || `Person ${id}`);
  const color = validColor(person?.color) || validColor(person?.avatar_color) || colorForPerson(id, display_name);
  return { id, display_name, color };
}

function renderFilters(host, people, selectedId) {
  host.replaceChildren();
  host.append(filterButton('all', 'Alle', '#A78BFA', selectedId === null));
  for (const person of people) host.append(filterButton(String(person.id), person.display_name, person.color, selectedId === person.id));
}

function filterButton(id, label, color, active) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `daybook-filter${active ? ' is-active' : ''}`;
  button.dataset.personFilter = id;
  button.style.setProperty('--person-color', color);
  button.innerHTML = '<span class="daybook-filter__dot" aria-hidden="true"></span><span></span>';
  button.lastElementChild.textContent = label;
  return button;
}

function renderTimeline(host, countHost, root, state, reload) {
  const filtered = (state.filterPersonId === null
    ? [...state.entries]
    : state.entries.filter((entry) => entryPeople(entry).some((person) => Number(person.id) === state.filterPersonId)))
    .sort(compareEntries);

  countHost.textContent = `${filtered.length} ${filtered.length === 1 ? 'Erinnerung' : 'Erinnerungen'}`;
  host.replaceChildren();

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'daybook-empty';
    empty.innerHTML = `
      <div class="daybook-empty__icon"><i data-lucide="book-heart" aria-hidden="true"></i></div>
      <h2>Noch keine Erinnerung</h2>
      <p>Halte den ersten kleinen oder großen Familienmoment fest.</p>
      <button type="button" class="daybook-empty__button">Erste Erinnerung anlegen</button>
    `;
    empty.querySelector('button').addEventListener('click', () => openComposer(root, state, reload));
    host.append(empty);
    window.lucide?.createIcons?.({ el: empty });
    return;
  }

  const newest = filtered[0];
  host.append(buildHeroSummary(newest, () => openDetail(root, state, newest, reload)));

  const groups = groupByDate(filtered.slice(1));
  if (groups.length) {
    const rail = document.createElement('div');
    rail.className = 'daybook-timeline daybook-timeline--groups';
    groups.forEach((group, index) => rail.append(buildDayGroup(group, index, (entry) => openDetail(root, state, entry, reload))));
    host.append(rail);
  }
  window.lucide?.createIcons?.({ el: host });
}

function buildHeroSummary(entry, onOpen) {
  const card = document.createElement('article');
  card.className = 'daybook-hero daybook-entry-summary daybook-entry-summary--hero';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Erinnerung öffnen: ${entry.title || 'Erinnerung'}`);
  card.style.setProperty('--entry-accent', entryPeople(entry)[0]?.color || '#D88AA2');

  const images = entryMedia(entry, 'image');
  if (images.length) {
    const media = document.createElement('div');
    media.className = 'daybook-hero__media daybook-entry-summary__cover';
    const img = document.createElement('img');
    img.src = mediaUrl(images[0]);
    img.alt = '';
    img.loading = 'lazy';
    media.append(img);
    card.append(media);
  }

  const content = document.createElement('div');
  content.className = 'daybook-hero__content';
  content.innerHTML = '<div class="daybook-hero__label"><span>Neueste Erinnerung</span><i data-lucide="sparkles"></i></div>';
  content.append(buildSummaryContent(entry, true));
  card.append(content);
  wireOpen(card, onOpen);
  return card;
}

function buildDayGroup(group, index, onOpen) {
  const wrapper = document.createElement('section');
  wrapper.className = `daybook-timeline__item daybook-day-group ${index % 2 === 0 ? 'is-left' : 'is-right'}`;
  wrapper.style.setProperty('--entry-accent', entryPeople(group.entries[0])[0]?.color || '#D88AA2');

  const node = document.createElement('div');
  node.className = 'daybook-timeline__node';
  node.innerHTML = '<span></span>';

  const groupCard = document.createElement('div');
  groupCard.className = 'daybook-day-group__panel';
  const header = document.createElement('header');
  header.className = 'daybook-day-group__header';
  const countText = group.entries.length === 1 ? '1 Erinnerung' : `${group.entries.length} Erinnerungen`;
  header.innerHTML = `<strong>${escapeHtml(formatDateKey(group.date))}</strong><span>${countText}</span>`;
  groupCard.append(header);

  const list = document.createElement('div');
  list.className = 'daybook-day-group__list';
  group.entries.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'daybook-card daybook-entry-summary';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.style.setProperty('--entry-accent', entryPeople(entry)[0]?.color || '#D88AA2');
    card.append(buildSummaryContent(entry, false));
    wireOpen(card, () => onOpen(entry));
    list.append(card);
  });
  groupCard.append(list);
  wrapper.append(node, groupCard);
  return wrapper;
}

function buildSummaryContent(entry, hero) {
  const fragment = document.createDocumentFragment();
  const top = document.createElement('div');
  top.className = 'daybook-entry__top';
  const date = document.createElement('time');
  date.className = 'daybook-entry__date';
  date.dateTime = dateKey(entry);
  date.textContent = formatDateKey(dateKey(entry));
  top.append(date);
  const people = document.createElement('div');
  people.className = 'daybook-entry__people';
  entryPeople(entry).forEach((person) => people.append(personBadge(person, hero)));
  top.append(people);
  fragment.append(top);

  const title = document.createElement(hero ? 'h2' : 'h3');
  title.className = 'daybook-entry__title';
  title.textContent = entry.title || 'Erinnerung';
  fragment.append(title);

  const images = entryMedia(entry, 'image').length;
  const audios = entryMedia(entry, 'audio').length;
  const meta = document.createElement('div');
  meta.className = 'daybook-entry-summary__meta';
  if (images) meta.append(metaBadge('image', `${images} ${images === 1 ? 'Foto' : 'Fotos'}`));
  if (audios) meta.append(metaBadge('audio-lines', `${audios} ${audios === 1 ? 'Audio' : 'Audios'}`));
  meta.append(metaBadge('chevron-right', 'Details'));
  fragment.append(meta);
  return fragment;
}

function metaBadge(icon, text) {
  const span = document.createElement('span');
  span.innerHTML = `<i data-lucide="${icon}"></i><span></span>`;
  span.lastElementChild.textContent = text;
  return span;
}

function wireOpen(element, callback) {
  element.addEventListener('click', callback);
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      callback();
    }
  });
}

function openDetail(root, state, entry, reload) {
  closeDetail(state);
  const overlay = document.createElement('div');
  overlay.className = 'daybook-detail-backdrop';
  const panel = document.createElement('section');
  panel.className = 'daybook-detail';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const header = document.createElement('header');
  header.className = 'daybook-detail__header';
  header.innerHTML = `
    <div><span class="daybook__eyebrow">${escapeHtml(formatDateKey(dateKey(entry)))}</span><h2>${escapeHtml(entry.title || 'Erinnerung')}</h2></div>
    <button type="button" class="daybook-icon-button" data-detail-close aria-label="Schließen"><i data-lucide="x"></i></button>
  `;
  panel.append(header);

  const body = document.createElement('div');
  body.className = 'daybook-detail__body';
  const people = document.createElement('div');
  people.className = 'daybook-entry__people daybook-detail__people';
  entryPeople(entry).forEach((person) => people.append(personBadge(person, true)));
  if (people.childElementCount) body.append(people);

  if (entry.body) {
    const text = document.createElement('p');
    text.className = 'daybook-detail__text';
    text.textContent = entry.body;
    body.append(text);
  }

  const images = entryMedia(entry, 'image');
  if (images.length) body.append(buildDetailGallery(images));
  const audios = entryMedia(entry, 'audio');
  audios.forEach((audio) => body.append(buildAudio(audio)));

  if (hasLocation(entry)) body.append(buildLocation(entry));
  else {
    const noLocation = document.createElement('div');
    noLocation.className = 'daybook-no-location';
    noLocation.innerHTML = '<i data-lucide="map-pin-off"></i><div><strong>Kein Aufnahmeort erkannt</strong><span>In den angehängten Bildern wurden keine GPS-Daten gefunden.</span></div>';
    body.append(noLocation);
  }
  panel.append(body);

  const footer = document.createElement('footer');
  footer.className = 'daybook-detail__footer';
  footer.innerHTML = '<button type="button" class="daybook-button daybook-button--primary" data-detail-edit><i data-lucide="pencil"></i> Bearbeiten</button>';
  panel.append(footer);
  overlay.append(panel);
  root.append(overlay);
  state.detail = overlay;
  window.lucide?.createIcons?.({ el: overlay });

  const close = () => closeDetail(state);
  overlay.querySelector('[data-detail-close]').addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('[data-detail-edit]').addEventListener('click', () => {
    close();
    const fresh = state.entries.find((candidate) => Number(candidate.id) === Number(entry.id)) || entry;
    openComposer(root, state, reload, fresh);
  });
}

function closeDetail(state) {
  state.detail?.remove();
  state.detail = null;
}

function buildDetailGallery(images) {
  const gallery = document.createElement('div');
  gallery.className = 'daybook-gallery daybook-gallery--detail';
  images.forEach((media) => {
    const frame = document.createElement('button');
    frame.type = 'button';
    frame.className = 'daybook-gallery__frame';
    const img = document.createElement('img');
    img.src = mediaUrl(media);
    img.alt = media.file_name || 'Tagebuchfoto';
    img.loading = 'lazy';
    frame.append(img);
    frame.addEventListener('click', () => window.open(img.src, '_blank', 'noopener'));
    gallery.append(frame);
  });
  return gallery;
}

function buildAudio(media) {
  const box = document.createElement('div');
  box.className = 'daybook-audio';
  box.innerHTML = '<div class="daybook-audio__icon"><i data-lucide="audio-lines"></i></div>';
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
  box.append(body);
  return box;
}

function buildLocation(entry) {
  const section = document.createElement('section');
  section.className = 'daybook-location';
  const header = document.createElement('div');
  header.className = 'daybook-location__header';
  header.innerHTML = '<i data-lucide="map-pin"></i><span></span>';
  header.lastElementChild.textContent = entry.location_label || 'Aufnahmeort aus Foto';
  section.append(header);
  const frame = document.createElement('iframe');
  frame.loading = 'lazy';
  frame.referrerPolicy = 'no-referrer-when-downgrade';
  frame.title = 'Karte des Aufnahmeorts';
  frame.src = googleMapsEmbed(entry.latitude, entry.longitude);
  section.append(frame);
  return section;
}

function openComposer(root, state, reload, entry = null) {
  if (state.composer) return;
  const editing = Boolean(entry?.id);
  const overlay = document.createElement('div');
  overlay.className = 'daybook-composer-backdrop';
  overlay.innerHTML = `
    <section class="daybook-composer" role="dialog" aria-modal="true" aria-labelledby="daybook-composer-title">
      <header class="daybook-composer__header">
        <div>
          <span class="daybook__eyebrow">${editing ? 'Erinnerung bearbeiten' : 'Neue Erinnerung'}</span>
          <h2 id="daybook-composer-title">${editing ? 'Erinnerung anpassen' : 'Was ist passiert?'}</h2>
        </div>
        <button type="button" class="daybook-icon-button" data-composer-close aria-label="Schließen"><i data-lucide="x"></i></button>
      </header>
      <div class="daybook-composer__body">
        <label class="daybook-field"><span>Titel</span><input type="text" maxlength="140" data-entry-title placeholder="z. B. Maries erster Schultag"></label>
        <label class="daybook-field"><span>Tag der Erinnerung</span><input type="date" data-entry-date></label>
        <p class="daybook-field-hint"><i data-lucide="calendar-days"></i> Erinnerungen gelten immer für den ganzen Tag – Uhrzeiten werden nicht gespeichert.</p>
        <div class="daybook-field"><span>Wer war dabei?</span><div class="daybook-person-picker" data-entry-people></div></div>
        <label class="daybook-field"><span>Erinnerung</span><textarea rows="6" maxlength="12000" data-entry-body placeholder="Erzähl, was diesen Moment besonders gemacht hat …"></textarea></label>
        <div class="daybook-composer__capture-grid">
          <button type="button" class="daybook-capture" data-audio-record><i data-lucide="mic"></i><span>Sprachnachricht</span><small>Aufnehmen & transkribieren</small></button>
          <label class="daybook-capture daybook-capture--file"><i data-lucide="images"></i><span>Fotos auswählen</span><small>Vorschau vor dem Speichern · GPS aus EXIF</small><input type="file" accept="image/jpeg,image/png,image/webp" multiple data-image-input></label>
        </div>
        <section class="daybook-media-editor" data-media-editor hidden>
          <div class="daybook-media-editor__heading"><strong>Angehängte Medien</strong><span data-media-count></span></div>
          <div class="daybook-draft-media daybook-draft-media--preview" data-draft-media></div>
        </section>
        <div class="daybook-transcription" data-transcription-status hidden></div>
        <div class="daybook-location-editor" data-location-editor>
          <div data-location-found hidden><i data-lucide="map-pin"></i><strong>GPS aus Foto erkannt</strong><span data-location-copy></span></div>
          <div data-location-missing><i data-lucide="map-pin-off"></i><strong>Kein GPS erkannt</strong><span>Ohne GPS-Daten wird später keine Karte angezeigt.</span></div>
          <iframe loading="lazy" title="Karten-Vorschau" data-location-map hidden></iframe>
        </div>
        <div class="daybook-composer__feedback" data-composer-feedback aria-live="polite"></div>
      </div>
      <footer class="daybook-composer__footer">
        <button type="button" class="daybook-button daybook-button--ghost" data-composer-cancel>Abbrechen</button>
        <button type="button" class="daybook-button daybook-button--primary" data-composer-save><i data-lucide="check"></i> ${editing ? 'Änderungen speichern' : 'Erinnerung speichern'}</button>
      </footer>
    </section>
  `;

  const existingMedia = Array.isArray(entry?.media) ? entry.media : [];
  const selectedPeople = new Set(entryPeople(entry).map((person) => Number(person.id)));
  const draft = {
    overlay,
    entry,
    pending: [],
    existingMedia,
    removedMediaIds: new Set(),
    selectedPeople,
    recording: null,
    location: hasLocation(entry)
      ? { latitude: Number(entry.latitude), longitude: Number(entry.longitude), label: entry.location_label || 'Aus Foto übernommen' }
      : null,
  };
  state.composer = draft;
  root.append(overlay);
  window.lucide?.createIcons?.({ el: overlay });

  overlay.querySelector('[data-entry-title]').value = entry?.title || '';
  overlay.querySelector('[data-entry-body]').value = entry?.body || '';
  overlay.querySelector('[data-entry-date]').value = entry ? dateKey(entry) : todayKey();
  renderPersonPicker(overlay.querySelector('[data-entry-people]'), state.people, draft.selectedPeople);
  renderDraftMedia(overlay, draft);
  renderDraftLocation(overlay, draft.location);

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
    const existingImageCount = draft.existingMedia.filter((item) => item.kind === 'image' && !draft.removedMediaIds.has(Number(item.id))).length;
    const pendingImageCount = draft.pending.filter((item) => item.kind === 'image').length;
    const files = [...event.target.files].slice(0, Math.max(0, MAX_IMAGES - existingImageCount - pendingImageCount));
    for (const file of files) {
      if (file.size > MAX_MEDIA_BYTES) continue;
      const url = URL.createObjectURL(file);
      state.objectUrls.add(url);
      const gps = await extractGpsFromJpeg(file).catch(() => null);
      draft.pending.push({ kind: 'image', file, url, gps });
      if (gps) draft.location = { latitude: gps.latitude, longitude: gps.longitude, label: 'Aus Foto übernommen' };
    }
    renderDraftMedia(overlay, draft);
    renderDraftLocation(overlay, draft.location);
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

function renderDraftMedia(overlay, draft) {
  const section = overlay.querySelector('[data-media-editor]');
  const host = overlay.querySelector('[data-draft-media]');
  const existing = draft.existingMedia.filter((item) => !draft.removedMediaIds.has(Number(item.id)));
  const all = [
    ...existing.map((item) => ({ ...item, existing: true, url: mediaUrl(item) })),
    ...draft.pending.map((item, pendingIndex) => ({ ...item, existing: false, pendingIndex })),
  ];
  section.hidden = all.length === 0;
  overlay.querySelector('[data-media-count]').textContent = all.length ? `${all.length} ausgewählt` : '';
  host.replaceChildren();

  all.forEach((item) => {
    const card = document.createElement('div');
    card.className = `daybook-draft-media__item is-${item.kind}`;
    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = item.file_name || item.file?.name || 'Ausgewähltes Foto';
      card.append(img);
      const badge = document.createElement('span');
      badge.className = 'daybook-draft-media__badge';
      badge.textContent = item.existing ? 'Gespeichert' : 'Neu';
      card.append(badge);
    } else {
      card.innerHTML = '<i data-lucide="audio-lines"></i><span>Sprachnachricht</span>';
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'daybook-draft-media__remove';
    remove.setAttribute('aria-label', 'Medium entfernen');
    remove.innerHTML = '<i data-lucide="x"></i>';
    remove.addEventListener('click', () => {
      if (item.existing) draft.removedMediaIds.add(Number(item.id));
      else {
        const pending = draft.pending[item.pendingIndex];
        if (pending?.url) URL.revokeObjectURL(pending.url);
        draft.pending.splice(item.pendingIndex, 1);
      }
      reconcileLocationAfterMediaChange(draft);
      renderDraftMedia(overlay, draft);
      renderDraftLocation(overlay, draft.location);
    });
    card.append(remove);
    host.append(card);
  });
  window.lucide?.createIcons?.({ el: host });
}

function reconcileLocationAfterMediaChange(draft) {
  const pendingGps = [...draft.pending].reverse().find((item) => item.kind === 'image' && item.gps)?.gps;
  if (pendingGps) {
    draft.location = { latitude: pendingGps.latitude, longitude: pendingGps.longitude, label: 'Aus Foto übernommen' };
    return;
  }
  if (draft.entry && hasLocation(draft.entry)) {
    const existingImagesRemain = draft.existingMedia.some((item) => item.kind === 'image' && !draft.removedMediaIds.has(Number(item.id)));
    draft.location = existingImagesRemain
      ? { latitude: Number(draft.entry.latitude), longitude: Number(draft.entry.longitude), label: draft.entry.location_label || 'Aus Foto übernommen' }
      : null;
    return;
  }
  draft.location = null;
}

function renderDraftLocation(overlay, location) {
  const found = overlay.querySelector('[data-location-found]');
  const missing = overlay.querySelector('[data-location-missing]');
  const map = overlay.querySelector('[data-location-map]');
  found.hidden = !location;
  missing.hidden = Boolean(location);
  map.hidden = !location;
  if (location) {
    found.querySelector('[data-location-copy]').textContent = `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
    map.src = googleMapsEmbed(location.latitude, location.longitude);
  } else {
    map.removeAttribute('src');
  }
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
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': file.type || 'audio/webm', 'x-file-name': encodeURIComponent(file.name) },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || 'Speech-to-Text ist derzeit nicht verfügbar.');
  return String(payload?.data?.text || '').trim();
}

async function saveDraft(overlay, draft, state, reload) {
  const button = overlay.querySelector('[data-composer-save]');
  const title = overlay.querySelector('[data-entry-title]').value.trim();
  const body = overlay.querySelector('[data-entry-body]').value.trim();
  const occurredOn = overlay.querySelector('[data-entry-date]').value || todayKey();
  const remainingExisting = draft.existingMedia.filter((item) => !draft.removedMediaIds.has(Number(item.id)));
  if (!title && !body && !draft.pending.length && !remainingExisting.length) {
    showFeedback(overlay, 'Schreib etwas oder füge ein Foto bzw. Audio hinzu.', true);
    return;
  }
  button.disabled = true;
  showFeedback(overlay, draft.entry ? 'Änderungen werden gespeichert …' : 'Erinnerung wird gespeichert …');

  try {
    const selected = state.people.filter((person) => draft.selectedPeople.has(person.id));
    const method = draft.entry ? 'PATCH' : 'POST';
    const url = draft.entry ? `${API}/entries/${draft.entry.id}` : `${API}/entries`;
    const response = await fetch(url, {
      method, credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: title || fallbackTitle(occurredOn),
        body,
        occurred_on: occurredOn,
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

    for (const mediaId of draft.removedMediaIds) {
      const removeResponse = await fetch(`${API}/media/${mediaId}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!removeResponse.ok && removeResponse.status !== 404) throw new Error('Ein Medium konnte nicht entfernt werden.');
    }

    for (const item of draft.pending) {
      const mediaResponse = await fetch(`${API}/entries/${id}/media?kind=${encodeURIComponent(item.kind)}`, {
        method: 'POST', credentials: 'same-origin',
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
          method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
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

function groupByDate(entries) {
  const groups = [];
  const byDate = new Map();
  for (const entry of entries) {
    const key = dateKey(entry);
    let group = byDate.get(key);
    if (!group) {
      group = { date: key, entries: [] };
      byDate.set(key, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

function compareEntries(a, b) {
  const day = dateKey(b).localeCompare(dateKey(a));
  if (day) return day;
  return Number(b.id || 0) - Number(a.id || 0);
}

function entryPeople(entry) {
  return Array.isArray(entry?.people) ? entry.people.map((person) => ({
    ...person,
    color: validColor(person?.color) || colorForPerson(person?.id, person?.display_name),
  })) : [];
}

function personBadge(person, hero = false) {
  const chip = document.createElement('span');
  chip.className = `daybook-person${hero ? ' daybook-person--hero' : ''}`;
  chip.style.setProperty('--person-color', person.color || colorForPerson(person.id, person.display_name));
  chip.innerHTML = '<span class="daybook-person__dot"></span><span></span>';
  chip.lastElementChild.textContent = person.display_name;
  return chip;
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

function dateKey(entryOrValue) {
  const value = typeof entryOrValue === 'object' && entryOrValue !== null
    ? entryOrValue.occurred_on || entryOrValue.occurred_at
    : entryOrValue;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  if (match) return match[1];
  return todayKey();
}

function todayKey() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  return new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).format(date);
}

function fallbackTitle(key) {
  return `Erinnerung vom ${new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(dateFromKey(key))}`;
}

function dateFromKey(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
