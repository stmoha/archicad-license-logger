'use strict';

const $ = (id) => document.getElementById(id);
const form = $('settings');

function send(type, extra) {
  return chrome.runtime.sendMessage(Object.assign({ type }, extra || {}));
}

function fmtTime(value) {
  if (!value) return '';
  const d = new Date(value);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function show(el, on) { el.classList.toggle('hidden', !on); }

function renderReading(r) {
  const meter = $('meter');
  const list = $('users');
  list.textContent = '';
  if (!r) {
    $('inUse').textContent = '–';
    $('ofTotal').textContent = 'in use';
    $('asOf').textContent = 'No reading yet';
    meter.firstElementChild.style.width = '0';
    return;
  }
  $('inUse').textContent = r.inUse;
  $('ofTotal').textContent = `of ${r.licenses} in use · ${r.available} free`;
  $('asOf').textContent = `As of ${fmtTime(r.time)}`;
  meter.firstElementChild.style.width = r.licenses ? `${(100 * r.inUse) / r.licenses}%` : '0';
  meter.classList.toggle('bad', r.available === 0);
  meter.classList.toggle('warn', r.available > 0 && r.available <= 2);
  for (const u of r.users || []) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = u.name;
    const pc = document.createElement('span');
    pc.className = 'pc';
    pc.textContent = u.computer;
    li.append(name, pc);
    list.append(li);
  }
}

function render(snap) {
  const { settings, state, queueLength, nextReading } = snap;
  renderReading(state.lastOk);

  const err = state.lastError;
  show($('gsNotice'), !!err);
  if (err) {
    $('gsMsg').textContent = `${err.message} (${fmtTime(err.time)})`;
    show($('signIn'), !!state.signedOut);
    show($('signInHelp'), !!state.signedOut);
  }

  const connected = settings.webAppUrl && settings.sharedKey;
  const sheetProblem = !connected
    ? 'Not connected to the sheet yet. Open Settings below.'
    : state.postError ? `Couldn't send to the sheet: ${state.postError.message}` : '';
  show($('sheetNotice'), !!sheetProblem);
  $('sheetMsg').textContent = sheetProblem;

  const parts = [];
  if (state.lastPost) parts.push(`Last sent to sheet ${fmtTime(state.lastPost.time)}`);
  if (queueLength) parts.push(`${queueLength} waiting to send`);
  if (settings.keepAlive && state.lastKeepAlive) parts.push(`Graphisoft tab refreshed ${fmtTime(state.lastKeepAlive)}`);
  $('sheetStatus').textContent = parts.join(' · ');

  const hours = settings.startHour === settings.endHour
    ? 'all day'
    : `${settings.startHour}:00–${settings.endHour}:00${settings.weekends ? '' : ', weekdays'}`;
  $('nextReading').textContent = nextReading
    ? `Next reading ${fmtTime(nextReading)} · every ${settings.intervalMinutes} min, ${hours}`
    : '';

  if (snap.version) {
    const upd = state.updatedAt && state.updatedFrom
      ? ` (updated from ${state.updatedFrom} ${fmtTime(state.updatedAt)})` : '';
    $('version').textContent = `Version ${snap.version}${upd}. Updates install automatically.`;
  }

  $('openSheet').href = settings.sheetUrl || '#';
  show($('openSheet'), !!settings.sheetUrl);
}

function fillForm(s) {
  for (const [k, v] of Object.entries(s)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
}

function readForm() {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const el = form.elements[k];
    if (!el) continue;
    out[k] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

async function refresh(fill) {
  const snap = await send('status');
  render(snap);
  if (fill) {
    fillForm(snap.settings);
    if (!snap.settings.webAppUrl || !snap.settings.sharedKey) $('settingsBox').open = true;
  }
}

$('readNow').addEventListener('click', async () => {
  const btn = $('readNow');
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    render(await send('readNow'));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Read now';
  }
});

$('signIn').addEventListener('click', () => send('openSignIn'));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('formMsg');
  const btn = $('save');
  btn.disabled = true;
  msg.className = 'formmsg';
  msg.textContent = 'Saving…';
  try {
    const res = await send('save', { settings: readForm() });
    msg.className = 'formmsg ' + (res.ok ? 'ok' : 'bad');
    msg.textContent = res.message || res.error || '';
    if (res.settings) {
      fillForm(res.settings);
      render(res);
    }
  } finally {
    btn.disabled = false;
  }
});

refresh(true);
