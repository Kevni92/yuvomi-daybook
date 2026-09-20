import { render as renderDaybookV2 } from './entry-v2.js';
import { renderDaybookSettings } from './notification-settings.js';

const API = '/api/extensions/daybook';
const DAY_MS = 86_400_000;

export async function render(container, context = {}) {
  const query = new URLSearchParams(window.location.search);
  if (query.get('view') === 'settings') {
    await renderDaybookSettings(container, context);
    return;
  }

  await renderDaybookV2(container, context);
  if (context.signal?.aborted) return;

  const root = container.querySelector('.daybook');
  if (!root) return;
  installHeaderActions(root);

  let entries = await loadEntries(context.signal).catch(() => []);
  enhance(root, entries);

  let scheduled = false;
  const scheduleEnhance = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(async () => {
      scheduled = false;
      if (context.signal?.aborted) return;
      const fresh = await loadEntries(context.signal).catch(() => entries);
      entries = fresh;
      enhance(root, entries);
    });
  };
  const observer = new MutationObserver(scheduleEnhance);
  observer.observe(root, { childList: true, subtree: true });
  context.signal?.addEventListener('abort', () => observer.disconnect(), { once: true });
}

function enhance(root, entries) {
  installHeaderActions(root);
  replaceGoogleMapsWithOpenStreetMap(root);
  addEntryThumbnails(root, entries);
  addTimelineGaps(root);
}

function installHeaderActions(root) {
  const header = root.querySelector('.daybook__header');
  const add = header?.querySelector('[data-daybook-add]');
  if (!header || !add || header.querySelector('[data-daybook-settings]')) return;
  const actions = document.createElement('div');
  actions.className = 'daybook__header-actions';
  const settings = document.createElement('a');
  settings.className = 'daybook__settings-button';
  settings.href = '/m/daybook?view=settings';
  settings.dataset.route = '/m/daybook?view=settings';
  settings.dataset.daybookSettings = '';
  settings.setAttribute('aria-label', 'Familientagebuch-Einstellungen');
  settings.innerHTML = '<i data-lucide="settings-2"></i><span>Einstellungen</span>';
  add.before(actions);
  actions.append(settings, add);
  window.lucide?.createIcons?.({ el: actions });
}

async function loadEntries(signal) {
  const response = await fetch(`${API}/entries`, {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  if (!response.ok) throw new Error(`Daybook API HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

function addEntryThumbnails(root, entries) {
  const queues = new Map();
  for (const entry of entries) {
    const image = Array.isArray(entry?.media) ? entry.media.find((item) => item?.kind === 'image') : null;
    if (!image) continue;
    const key = entryKey(entryDate(entry), String(entry?.title || 'Erinnerung'));
    const list = queues.get(key) || [];
    list.push(image);
    queues.set(key, list);
  }

  for (const card of root.querySelectorAll('.daybook-day-group .daybook-entry-summary:not(.has-daybook-thumb)')) {
    const date = card.querySelector('time')?.dateTime || card.closest('.daybook-day-group')?.querySelector('time')?.dateTime || '';
    const title = card.querySelector('.daybook-entry__title')?.textContent?.trim() || 'Erinnerung';
    const queue = queues.get(entryKey(date, title));
    const image = queue?.shift();
    if (!image) continue;

    const copy = document.createElement('div');
    copy.className = 'daybook-entry-summary__copy';
    while (card.firstChild) copy.append(card.firstChild);
    const thumb = document.createElement('img');
    thumb.className = 'daybook-entry-summary__thumb';
    thumb.src = image.url || `${API}/media/${encodeURIComponent(image.id)}/file`;
    thumb.alt = '';
    thumb.loading = 'lazy';
    card.append(thumb, copy);
    card.classList.add('has-daybook-thumb');
  }
}

function addTimelineGaps(root) {
  const rail = root.querySelector('.daybook-timeline--groups');
  const hero = root.querySelector('.daybook-entry-summary--hero');
  if (!rail || !hero) return;
  rail.querySelectorAll('.daybook-gap').forEach((item) => item.remove());

  const groups = [...rail.querySelectorAll(':scope > .daybook-day-group')];
  let newerDate = hero.querySelector('time')?.dateTime || '';
  for (const group of groups) {
    const olderDate = group.querySelector('time')?.dateTime || '';
    const days = missingDaysBetween(newerDate, olderDate);
    if (days > 0) {
      const gap = buildGap(days, previousDay(newerDate), root);
      rail.insertBefore(gap, group);
    }
    newerDate = olderDate;
  }
  window.lucide?.createIcons?.({ el: rail });
}

function buildGap(days, defaultDate, root) {
  const gap = document.createElement('div');
  gap.className = 'daybook-gap';
  const label = days === 1 ? '1 Tag ohne Eintrag' : `${days} Tage ohne Eintrag`;
  gap.innerHTML = `
    <span class="daybook-gap__line" aria-hidden="true"></span>
    <div class="daybook-gap__content"><i data-lucide="calendar-clock"></i><span>${escapeHtml(label)}</span></div>
    <button type="button" class="daybook-gap__add" aria-label="Erinnerung in dieser Lücke hinzufügen"><i data-lucide="plus"></i></button>
  `;
  gap.querySelector('button').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const add = root.querySelector('[data-daybook-add]');
    add?.click();
    setTimeout(() => {
      const input = root.querySelector('.daybook-composer [data-entry-date]');
      if (input && defaultDate) input.value = defaultDate;
    }, 0);
  });
  return gap;
}

function replaceGoogleMapsWithOpenStreetMap(root) {
  const frames = root.querySelectorAll('.daybook-location iframe, [data-location-map]');
  for (const frame of frames) {
    if (frame.dataset.openStreetMap === 'true') continue;
    const coordinates = coordinatesFromMapFrame(frame);
    if (!coordinates) continue;
    const { latitude, longitude } = coordinates;
    frame.src = openStreetMapEmbed(latitude, longitude);
    frame.referrerPolicy = 'no-referrer';
    frame.dataset.openStreetMap = 'true';
    frame.title = 'OpenStreetMap – Aufnahmeort';

    const location = frame.closest('.daybook-location');
    if (location && !location.querySelector('.daybook-location__osm-link')) {
      const link = document.createElement('a');
      link.className = 'daybook-location__osm-link';
      link.href = openStreetMapLink(latitude, longitude);
      link.target = '_blank';
      link.rel = 'noopener';
      link.innerHTML = '<i data-lucide="external-link"></i><span>In OpenStreetMap öffnen</span>';
      location.append(link);
      window.lucide?.createIcons?.({ el: link });
    }
  }
}

function coordinatesFromMapFrame(frame) {
  const src = frame.getAttribute('src') || '';
  if (!src) return null;
  try {
    const url = new URL(src, window.location.origin);
    if (url.hostname.includes('openstreetmap.org')) {
      const marker = url.searchParams.get('marker');
      return parseCoordinates(marker);
    }
    const query = url.searchParams.get('q');
    return parseCoordinates(query);
  } catch {
    return null;
  }
}

function parseCoordinates(value) {
  if (typeof value !== 'string') return null;
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

function openStreetMapEmbed(latitude, longitude) {
  const latSpan = 0.012;
  const lonSpan = 0.018;
  const bbox = [longitude - lonSpan, latitude - latSpan, longitude + lonSpan, latitude + latSpan].join(',');
  const params = new URLSearchParams({
    bbox,
    layer: 'mapnik',
    marker: `${latitude},${longitude}`,
  });
  return `https://www.openstreetmap.org/export/embed.html?${params.toString()}`;
}

function openStreetMapLink(latitude, longitude) {
  return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(latitude)}&mlon=${encodeURIComponent(longitude)}#map=16/${encodeURIComponent(latitude)}/${encodeURIComponent(longitude)}`;
}

function missingDaysBetween(newer, older) {
  const newerMs = dateKeyMs(newer);
  const olderMs = dateKeyMs(older);
  if (newerMs === null || olderMs === null || newerMs <= olderMs) return 0;
  return Math.max(0, Math.round((newerMs - olderMs) / DAY_MS) - 1);
}

function previousDay(value) {
  const ms = dateKeyMs(value);
  if (ms === null) return '';
  return new Date(ms - DAY_MS).toISOString().slice(0, 10);
}

function dateKeyMs(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function entryDate(entry) {
  const raw = String(entry?.occurred_on || entry?.occurred_at || '');
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match?.[1] || '';
}

function entryKey(date, title) {
  return `${date}\u0000${title}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}
