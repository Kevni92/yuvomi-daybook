const DAYBOOK_API = '/api/extensions/daybook';
const BANKING_API = '/api/extensions/banking';
const BANKING_WORKER = '/modules/banking/push-worker.js';
const BANKING_WORKER_SCOPE = '/modules/banking/';

export async function renderDaybookSettings(container, context = {}) {
  const signal = context.signal ?? new AbortController().signal;
  container.replaceChildren();
  const root = document.createElement('main');
  root.className = 'daybook daybook-settings';
  root.innerHTML = `
    <header class="daybook__header daybook-settings__header">
      <div>
        <span class="daybook__eyebrow">Familientagebuch</span>
        <h1>Einstellungen</h1>
        <p>Erinnerungen und Benachrichtigungen für dein Familientagebuch.</p>
      </div>
      <a class="daybook-settings__back" href="/m/daybook" data-route="/m/daybook"><i data-lucide="arrow-left"></i><span>Zurück</span></a>
    </header>

    <section class="daybook-settings__panel">
      <div class="daybook-settings__panel-head">
        <div><h2>Benachrichtigungen</h2><p>Aktiviere Push-Benachrichtigungen auf diesem Gerät.</p></div>
        <button type="button" class="daybook-button daybook-button--primary" data-enable-device><i data-lucide="bell-ring"></i> Dieses Gerät aktivieren</button>
      </div>
      <div class="daybook-settings__status" data-device-status>Gerätestatus wird geladen …</div>
      <div class="daybook-settings__devices" data-device-list></div>
    </section>

    <section class="daybook-settings__panel">
      <div class="daybook-settings__panel-head">
        <div><h2>Tägliche Erinnerung</h2><p>Yuvomi erinnert dich einmal pro Tag daran, einen Tagebucheintrag festzuhalten.</p></div>
      </div>
      <form class="daybook-settings__form" data-reminder-form>
        <label class="daybook-settings__toggle">
          <input type="checkbox" data-reminder-enabled>
          <span><strong>Tägliche Erinnerung aktiv</strong><small>Die Erinnerung wird an deine aktivierten Geräte geschickt.</small></span>
        </label>
        <label class="daybook-field"><span>Uhrzeit</span><input type="time" step="60" data-reminder-time value="20:00"></label>
        <label class="daybook-field"><span>Zeitzone</span><input type="text" data-reminder-timezone readonly></label>
        <p class="daybook-settings__hint"><i data-lucide="mouse-pointer-click"></i> Ein Tipp auf die Benachrichtigung öffnet direkt das Formular für eine neue Erinnerung.</p>
        <div class="daybook-settings__actions">
          <button type="submit" class="daybook-button daybook-button--primary"><i data-lucide="check"></i> Einstellungen speichern</button>
        </div>
        <p class="daybook-composer__feedback" data-reminder-feedback aria-live="polite"></p>
      </form>
    </section>
  `;
  container.append(root);
  window.lucide?.createIcons?.({ el: root });

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
  root.querySelector('[data-reminder-timezone]').value = timezone;

  root.querySelector('[data-enable-device]').addEventListener('click', () => {
    void enableCurrentDevice(root, signal);
  }, { signal });
  root.querySelector('[data-reminder-form]').addEventListener('submit', (event) => {
    event.preventDefault();
    void saveReminderSettings(root, signal);
  }, { signal });

  await Promise.allSettled([
    loadReminderSettings(root, signal),
    loadDeviceState(root, signal),
  ]);
}

async function loadReminderSettings(root, signal) {
  const response = await fetch(`${DAYBOOK_API}/reminder-settings`, {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  const data = payload?.data || {};
  root.querySelector('[data-reminder-enabled]').checked = data.enabled === true;
  root.querySelector('[data-reminder-time]').value = /^\d{2}:\d{2}$/.test(data.time || '') ? data.time : '20:00';
  root.querySelector('[data-reminder-timezone]').value = data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin';
  if (data.push_backend_available === false) {
    setDeviceStatus(root, 'Push ist serverseitig noch nicht verfügbar. BANKING_DB_PATH und BANKING_DATA_ENCRYPTION_KEY prüfen.', true);
  }
}

async function saveReminderSettings(root, signal) {
  const feedback = root.querySelector('[data-reminder-feedback]');
  const submit = root.querySelector('[data-reminder-form] button[type="submit"]');
  submit.disabled = true;
  feedback.classList.remove('is-error');
  feedback.textContent = 'Einstellungen werden gespeichert …';
  try {
    const response = await fetch(`${DAYBOOK_API}/reminder-settings`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: root.querySelector('[data-reminder-enabled]').checked,
        time: root.querySelector('[data-reminder-time]').value,
        timezone: root.querySelector('[data-reminder-timezone]').value,
      }),
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || 'Einstellungen konnten nicht gespeichert werden.');
    feedback.textContent = payload?.data?.enabled
      ? `Tägliche Erinnerung um ${payload.data.time} Uhr aktiviert.`
      : 'Tägliche Erinnerung deaktiviert.';
  } catch (error) {
    feedback.classList.add('is-error');
    feedback.textContent = error?.message || 'Speichern fehlgeschlagen.';
  } finally {
    if (!signal.aborted) submit.disabled = false;
  }
}

async function loadDeviceState(root, signal) {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    setDeviceStatus(root, 'Push-Benachrichtigungen werden von diesem Browser nicht unterstützt.', true);
    root.querySelector('[data-enable-device]').disabled = true;
    return;
  }

  const permission = Notification.permission;
  const registration = await navigator.serviceWorker.getRegistration(BANKING_WORKER_SCOPE).catch(() => null);
  const localSubscription = registration ? await registration.pushManager.getSubscription().catch(() => null) : null;
  if (permission === 'denied') setDeviceStatus(root, 'Benachrichtigungen sind im Browser blockiert.', true);
  else if (localSubscription) setDeviceStatus(root, 'Dieses Gerät ist für Push-Benachrichtigungen eingerichtet.');
  else setDeviceStatus(root, permission === 'granted' ? 'Benachrichtigungen sind erlaubt, dieses Gerät ist aber noch nicht registriert.' : 'Dieses Gerät ist noch nicht aktiviert.');

  try {
    const response = await fetch(`${BANKING_API}/push/subscriptions`, { credentials: 'same-origin', cache: 'no-store', signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    renderDevices(root, Array.isArray(payload?.data) ? payload.data : []);
  } catch (error) {
    const host = root.querySelector('[data-device-list]');
    host.textContent = 'Aktivierte Geräte konnten nicht geladen werden.';
    host.dataset.error = 'true';
  }
}

async function enableCurrentDevice(root, signal) {
  const button = root.querySelector('[data-enable-device]');
  button.disabled = true;
  setDeviceStatus(root, 'Gerät wird aktiviert …');
  try {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error('Push-Benachrichtigungen werden von diesem Browser nicht unterstützt.');
    }
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt.');

    const keyResponse = await fetch(`${BANKING_API}/push/vapid-public-key`, { credentials: 'same-origin', cache: 'no-store', signal });
    const keyPayload = await keyResponse.json().catch(() => ({}));
    if (!keyResponse.ok) throw new Error(keyPayload?.error || 'Push ist auf dem Server nicht konfiguriert.');
    const publicKey = keyPayload?.data?.public_key;
    if (typeof publicKey !== 'string' || !publicKey) throw new Error('VAPID-Schlüssel fehlt.');

    let registration = await navigator.serviceWorker.getRegistration(BANKING_WORKER_SCOPE);
    if (!registration) {
      registration = await navigator.serviceWorker.register(BANKING_WORKER, { scope: BANKING_WORKER_SCOPE });
    }
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey),
      });
    }

    const csrfResponse = await fetch(`${BANKING_API}/csrf`, { credentials: 'same-origin', cache: 'no-store', signal });
    const csrfPayload = await csrfResponse.json().catch(() => ({}));
    if (!csrfResponse.ok) throw new Error(csrfPayload?.error || 'CSRF-Token konnte nicht geladen werden.');
    const csrf = csrfPayload?.csrf_token || csrfPayload?.data?.csrf_token || '';

    const storeResponse = await fetch(`${BANKING_API}/push/subscriptions`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-banking-csrf': csrf },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        device_name: deviceName(),
      }),
      signal,
    });
    const storePayload = await storeResponse.json().catch(() => ({}));
    if (!storeResponse.ok) throw new Error(storePayload?.error || 'Gerät konnte nicht registriert werden.');
    setDeviceStatus(root, 'Dieses Gerät ist jetzt für Benachrichtigungen aktiviert.');
    await loadDeviceState(root, signal);
  } catch (error) {
    setDeviceStatus(root, error?.message || 'Gerät konnte nicht aktiviert werden.', true);
  } finally {
    if (!signal.aborted) button.disabled = false;
  }
}

function renderDevices(root, subscriptions) {
  const host = root.querySelector('[data-device-list]');
  host.replaceChildren();
  const active = subscriptions.filter((item) => item?.status === 'active');
  if (!active.length) {
    host.textContent = 'Noch kein Gerät registriert.';
    return;
  }
  const title = document.createElement('strong');
  title.textContent = active.length === 1 ? '1 aktives Gerät' : `${active.length} aktive Geräte`;
  host.append(title);
  const list = document.createElement('div');
  list.className = 'daybook-settings__device-list';
  active.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'daybook-settings__device';
    row.innerHTML = '<i data-lucide="smartphone"></i><span></span>';
    row.querySelector('span').textContent = item.device_name || `Gerät ${item.id}`;
    list.append(row);
  });
  host.append(list);
  window.lucide?.createIcons?.({ el: host });
}

function setDeviceStatus(root, text, error = false) {
  const host = root.querySelector('[data-device-status]');
  host.textContent = text;
  host.classList.toggle('is-error', error);
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function deviceName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || 'Gerät';
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return `${platform} · Android`;
  if (/iPhone|iPad/i.test(ua)) return `${platform} · iOS`;
  return `${platform} · Browser`;
}
