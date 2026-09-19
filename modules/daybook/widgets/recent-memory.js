const API = '/api/extensions/daybook';
const STYLE_MARKER = 'daybook-recent-memory-widget-style';

export async function renderWidget(container, context = {}) {
  ensureStyles();
  if (canWrite(context.user)) installFabAction();

  const root = document.createElement('a');
  root.className = 'daybook-widget';
  root.href = '/m/daybook';
  root.dataset.route = '/m/daybook';
  root.innerHTML = `
    <div class="daybook-widget__header">
      <span><i data-lucide="book-heart" aria-hidden="true"></i> Familientagebuch</span>
      <i data-lucide="chevron-right" aria-hidden="true"></i>
    </div>
    <div class="daybook-widget__body" data-widget-body>
      <span class="daybook-widget__muted">Letzte Erinnerung wird geladen …</span>
    </div>
  `;
  container.replaceChildren(root);
  window.lucide?.createIcons?.({ el: root });

  try {
    const response = await fetch(`${API}/entries?limit=1`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error();
    const entries = (await response.json())?.data;
    const entry = Array.isArray(entries) ? entries[0] : null;
    renderEntry(root.querySelector('[data-widget-body]'), entry);
  } catch {
    root.querySelector('[data-widget-body]').innerHTML = '<span class="daybook-widget__muted">Noch keine Erinnerungen.</span>';
  }
}

function renderEntry(host, entry) {
  host.replaceChildren();
  if (!entry) {
    const empty = document.createElement('div');
    empty.className = 'daybook-widget__empty';
    empty.innerHTML = '<strong>Der erste Moment wartet.</strong><span>Über + eine Erinnerung festhalten.</span>';
    host.append(empty);
    return;
  }

  const image = Array.isArray(entry.media) ? entry.media.find((item) => item.kind === 'image') : null;
  if (image) {
    const picture = document.createElement('img');
    picture.className = 'daybook-widget__image';
    picture.src = image.url || `${API}/media/${encodeURIComponent(image.id)}/file`;
    picture.alt = '';
    picture.loading = 'lazy';
    host.append(picture);
  }
  const copy = document.createElement('div');
  copy.className = 'daybook-widget__copy';
  const title = document.createElement('strong');
  title.textContent = entry.title || 'Erinnerung';
  const meta = document.createElement('span');
  meta.textContent = formatDate(entry.occurred_at);
  copy.append(title, meta);
  host.append(copy);
}

function installFabAction() {
  const install = () => {
    const actions = document.querySelector('#fab-actions');
    if (!actions || actions.querySelector('[data-daybook-fab-action]')) return Boolean(actions);
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'fab-action';
    action.dataset.daybookFabAction = '';
    action.dataset.route = '/m/daybook?new=1';
    action.tabIndex = -1;
    action.setAttribute('aria-label', 'Erinnerung');
    action.innerHTML = `
      <span class="fab-action__label">Erinnerung</span>
      <span class="fab-action__btn" aria-hidden="true"><i data-lucide="book-heart"></i></span>
    `;
    action.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (window.yuvomi?.navigate) await window.yuvomi.navigate('/m/daybook?new=1');
      else window.location.assign('/m/daybook?new=1');
    });
    actions.append(action);
    window.lucide?.createIcons?.({ el: action });
    return true;
  };

  if (install()) return;
  const observer = new MutationObserver(() => {
    if (install()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 5000);
}

function canWrite(user) {
  const modules = user?.permissions?.modules;
  const explicit = modules?.['ext:daybook'];
  return explicit === undefined || explicit === 'write';
}

function ensureStyles() {
  if (document.head.querySelector(`link[data-widget-style="${STYLE_MARKER}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./recent-memory.css', import.meta.url).href;
  link.dataset.widgetStyle = STYLE_MARKER;
  document.head.append(link);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'long', year: 'numeric' }).format(date);
}
