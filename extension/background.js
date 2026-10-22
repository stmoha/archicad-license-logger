/*
 * Archicad License Logger: background service worker.
 *
 * Every few minutes it reads CAST's floating Archicad licenses from Graphisoft
 * License Management, using this Chrome profile's existing Graphisoft sign-in,
 * and posts the reading to the Google Sheet's Apps Script web app.
 * Readings that can't be sent are queued and retried on the next run.
 */
importScripts('lib.js');

const ALARM = 'archicad-license-sample';
const MAX_QUEUE = 2000;
const POST_BATCH = 200;
const NEW_TAB_WAIT_MS = 45000;

// Run one job at a time so the queue and state are never written concurrently.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- storage ----------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return normalizeSettings(settings);
}

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return state || {};
}

async function setState(patch) {
  const state = await getState();
  await chrome.storage.local.set({ state: Object.assign(state, patch) });
}

async function enqueue(reading) {
  const { queue = [] } = await chrome.storage.local.get('queue');
  queue.push(reading);
  while (queue.length > MAX_QUEUE) queue.shift();
  await chrome.storage.local.set({ queue });
}

// ---------- schedule ----------

async function ensureAlarm(reset) {
  const s = await getSettings();
  const existing = await chrome.alarms.get(ALARM);
  if (reset || !existing || existing.periodInMinutes !== s.intervalMinutes) {
    await chrome.alarms.create(ALARM, {
      when: nextAlignedTime(Date.now(), s.intervalMinutes),
      periodInMinutes: s.intervalMinutes,
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm(true).then(() => serial(() => takeReading('startup'))).then(() => serial(keepAlive));
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm(false).then(() => serial(() => takeReading('startup'))).then(() => serial(keepAlive));
});

// Every tick, day and night: pick up any new version, take a reading (inside
// active hours only), then keep the Graphisoft sign-in active.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  serial(async () => {
    if (await checkForUpdate()) return;
    await takeReading('scheduled');
    await keepAlive();
  });
});

// ---------- self-update ----------

/**
 * The server pulls approved changes from GitHub into this folder, but Chrome keeps
 * running the old code until the extension reloads. Each tick, compare the version
 * in manifest.json on disk with the running one, and reload when they differ.
 */
async function checkForUpdate() {
  let onDisk;
  try {
    const r = await fetch(chrome.runtime.getURL('manifest.json') + '?t=' + Date.now(), { cache: 'no-store' });
    onDisk = (await r.json()).version;
  } catch (e) {
    return false; // file mid-update; try again next tick
  }
  const running = chrome.runtime.getManifest().version;
  if (!onDisk || onDisk === running) return false;
  const st = await getState();
  // Don't loop if a reload didn't take effect: try each new version once.
  if (st.reloadTarget === onDisk) return false;
  await setState({ reloadTarget: onDisk, updatedFrom: running, updatedAt: new Date().toISOString() });
  chrome.runtime.reload();
  return true;
}

// After someone signs back in to Graphisoft, take a reading as soon as the page loads.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url || !tab.url.startsWith(GS_ORIGIN)) return;
  getState().then((st) => {
    if (st.signedOut) serial(() => takeReading('signin'));
  });
});

ensureAlarm(false);

// ---------- keeping the Graphisoft sign-in alive ----------

/**
 * Graphisoft ID signs you out after a period without activity, and signing in
 * again needs a password and an authenticator code, so it can't be automated.
 * Instead, keep one pinned Graphisoft tab open and reload it every tick, around
 * the clock, so the session always looks active, like a page someone left open.
 */
async function findKeepAliveTab() {
  const st = await getState();
  if (st.keepAliveTabId != null) {
    const t = await chrome.tabs.get(st.keepAliveTabId).catch(() => null);
    if (t) return t;
  }
  // After a Chrome restart the tab may come back with a new id.
  const pinned = await chrome.tabs.query({ pinned: true, url: [GS_ORIGIN + '/*', GS_ID_ORIGIN + '/*'] });
  if (pinned.length) {
    await setState({ keepAliveTabId: pinned[0].id });
    return pinned[0];
  }
  return null;
}

async function keepAlive() {
  const s = await getSettings();
  if (!s.keepAlive) return { skipped: 'off' };
  const tab = await findKeepAliveTab();
  if (!tab) {
    const created = await chrome.tabs.create({ url: GS_PAGE_URL, active: false, pinned: true });
    await setState({ keepAliveTabId: created.id, lastKeepAlive: new Date().toISOString() });
    return { created: true };
  }
  // On the sign-in page: leave it alone so a person can sign in without it reloading.
  if (!tab.url || !tab.url.startsWith(GS_ORIGIN)) return { skipped: 'signin page' };
  // Someone is looking at it right now.
  if (tab.active && (await chrome.idle.queryState(300)) === 'active') return { skipped: 'in use' };
  await chrome.tabs.reload(tab.id);
  await setState({ lastKeepAlive: new Date().toISOString() });
  return { reloaded: true };
}

async function openSignIn() {
  const tab = await findKeepAliveTab();
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    if (!tab.url || tab.url.startsWith(GS_ORIGIN)) await chrome.tabs.reload(tab.id);
    return;
  }
  const created = await chrome.tabs.create({ url: GS_PAGE_URL, active: true, pinned: true });
  await setState({ keepAliveTabId: created.id });
}

// ---------- reading Graphisoft ----------

/**
 * Self-contained so it can also be injected into a Graphisoft tab.
 * Returns { ok, data } or { ok: false, kind: 'auth' | 'http' | 'network', status }.
 */
async function fetchLicenseJson(url) {
  try {
    const r = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'manual' });
    if (r.type === 'opaqueredirect') return { ok: false, kind: 'auth', status: 0 };
    const type = r.headers.get('content-type') || '';
    if (r.ok && type.indexOf('json') !== -1) return { ok: true, data: await r.json() };
    const auth = r.status === 401 || r.status === 403 || (r.ok && type.indexOf('json') === -1);
    return { ok: false, kind: auth ? 'auth' : 'http', status: r.status };
  } catch (e) {
    return { ok: false, kind: 'network', error: String((e && e.message) || e) };
  }
}

async function fetchInTab(tabId, url) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fetchLicenseJson,
      args: [url],
    });
    return (res && res.result) || { ok: false, kind: 'auth' };
  } catch (e) {
    return { ok: false, kind: 'auth', error: e.message };
  }
}

/**
 * Opens the license page in a background tab so Graphisoft can renew the
 * session through its normal sign-in redirect, reads the data from that tab,
 * then closes it. If the page never comes back from the sign-in screen, the
 * Graphisoft ID session itself has expired.
 */
async function fetchViaNewTab(url, keepOpen) {
  const tab = await chrome.tabs.create({ url: GS_PAGE_URL, active: false, pinned: !!keepOpen });
  let result = { ok: false, kind: 'auth' };
  try {
    const deadline = Date.now() + NEW_TAB_WAIT_MS;
    await sleep(4000);
    while (Date.now() < deadline) {
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) break;
      if (t.status === 'complete' && t.url && t.url.startsWith(GS_ORIGIN)) {
        const r = await fetchInTab(tab.id, url);
        if (r.ok) { result = r; break; }
      }
      await sleep(3000);
    }
    return result;
  } finally {
    // Normally the tab is closed. If direct reads keep failing (Chrome not sending the
    // Graphisoft session to the extension), leave one pinned tab open to read through
    // instead of opening a new tab every interval.
    if (!(keepOpen && result.ok)) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function readLicenses(s, allowNewTab) {
  if (!s.orgId) throw new Error('Organization ID is not set');
  const url = `${GS_ORIGIN}/api/License/GetLicensesOfOrganization?organizationId=${encodeURIComponent(s.orgId)}`;

  const st = await getState();
  const direct = await fetchLicenseJson(url);
  if (direct.ok) {
    if (st.newTabReads) await setState({ newTabReads: 0 });
    return direct.data;
  }

  // Fall back to any Graphisoft tab that is already open.
  const open = await chrome.tabs.query({ url: GS_ORIGIN + '/*' });
  for (const t of open) {
    const r = await fetchInTab(t.id, url);
    if (r.ok) return r.data;
  }

  if (direct.kind !== 'network' && allowNewTab) {
    const count = st.newTabReads || 0;
    const r = await fetchViaNewTab(url, count >= 1);
    if (r.ok) {
      await setState({ newTabReads: count + 1 });
      return r.data;
    }
  }

  if (direct.kind === 'network') throw new Error('Could not reach Graphisoft (offline?)');
  if (direct.kind === 'http') throw new Error(`Graphisoft error (HTTP ${direct.status})`);
  throw new Error(SIGNED_OUT);
}

// ---------- one reading ----------

async function takeReading(reason) {
  const s = await getSettings();
  const st = await getState();
  const now = new Date();
  const manual = reason === 'manual';

  if (!manual && !withinActiveHours(now, s)) {
    await setState({ lastSkipped: now.toISOString() });
    return { skipped: true, post: await flushQueue(s) };
  }

  let reading = null;
  try {
    // When already signed out, only a manual reading opens a tab, so a lapsed
    // session doesn't pop a tab open every interval.
    const bundles = await readLicenses(s, manual || !st.signedOut);
    const sum = summarizeLicenses(bundles, s.groupName);
    reading = {
      time: now.toISOString(),
      intervalMinutes: s.intervalMinutes,
      licenses: sum.licenses,
      inUse: sum.inUse,
      available: sum.available,
      users: sum.users,
      status: 'OK',
    };
    await setState({ lastOk: reading, lastError: null, signedOut: false, lastPostedStatus: 'OK' });
    await showCounts(sum, now);
  } catch (err) {
    const message = (err && err.message) || String(err);
    // Log a problem once when it starts, not every interval while it lasts.
    if (st.lastPostedStatus !== message) {
      reading = { time: now.toISOString(), intervalMinutes: s.intervalMinutes, status: message };
    }
    await setState({
      lastError: { time: now.toISOString(), message },
      signedOut: message === SIGNED_OUT,
      lastPostedStatus: message,
    });
    await showError(message);
  }

  if (reading) await enqueue(reading);
  return { reading, post: await flushQueue(s) };
}

// ---------- sending to the sheet ----------

async function postToSheet(s, readings) {
  const r = await fetch(s.webAppUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ key: s.sharedKey, readings }),
    credentials: 'omit',
    redirect: 'follow',
  });
  const text = await r.text();
  let res;
  try {
    res = JSON.parse(text);
  } catch (e) {
    throw new Error(`Unexpected reply from the sheet (HTTP ${r.status}). Check the web app URL and that access is set to "Anyone".`);
  }
  if (!res.ok) throw new Error(res.error || 'The sheet rejected the reading');
  return res;
}

async function flushQueue(s) {
  if (!s.webAppUrl || !s.sharedKey) return { ok: false, error: 'Sheet not connected yet' };
  let sent = 0;
  for (let i = 0; i < 10; i++) {
    const { queue = [] } = await chrome.storage.local.get('queue');
    if (!queue.length) break;
    const batch = queue.slice(0, POST_BATCH);
    try {
      const res = await postToSheet(s, batch);
      await chrome.storage.local.set({ queue: queue.slice(batch.length) });
      sent += batch.length;
      await setState({
        lastPost: { time: new Date().toISOString(), added: res.added, skipped: res.skipped },
        postError: null,
      });
    } catch (e) {
      await setState({ postError: { time: new Date().toISOString(), message: e.message } });
      return { ok: false, error: e.message, sent };
    }
  }
  return { ok: true, sent };
}

async function saveAndTest(raw) {
  const s = normalizeSettings(raw);
  await chrome.storage.local.set({ settings: s });
  await ensureAlarm(true);
  if (!s.webAppUrl || !s.sharedKey) return { ok: false, message: 'Saved. Add the web app URL and key to start sending readings.' };
  try {
    await postToSheet(s, []);
  } catch (e) {
    await setState({ postError: { time: new Date().toISOString(), message: e.message } });
    return { ok: false, message: e.message };
  }
  await setState({ postError: null });
  const flush = await flushQueue(s);
  const queued = flush.sent ? ` Sent ${flush.sent} waiting reading${flush.sent === 1 ? '' : 's'}.` : '';
  return { ok: true, message: 'Saved. Connected to the sheet.' + queued };
}

// ---------- toolbar badge ----------

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  await chrome.action.setTitle({ title });
}

async function showCounts(sum, when) {
  const color = sum.available === 0 ? '#C62828' : sum.available <= 2 ? '#B26A00' : '#2E7D32';
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  await setBadge(String(sum.inUse), color,
    `Archicad: ${sum.inUse} of ${sum.licenses} licenses in use (as of ${time})`);
}

async function showError(message) {
  await setBadge('!', '#6B7280', `Archicad License Logger: ${message}`);
}

// ---------- popup messages ----------

async function snapshot() {
  const version = chrome.runtime.getManifest().version;
  const [settings, state, store, alarm] = await Promise.all([
    getSettings(),
    getState(),
    chrome.storage.local.get('queue'),
    chrome.alarms.get(ALARM),
  ]);
  return {
    version,
    settings,
    state,
    queueLength: (store.queue || []).length,
    nextReading: alarm ? alarm.scheduledTime : null,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const run = async () => {
    switch (msg && msg.type) {
      case 'status':
        return snapshot();
      case 'readNow':
        await serial(() => takeReading('manual'));
        return snapshot();
      case 'save': {
        const res = await serial(() => saveAndTest(msg.settings));
        await serial(keepAlive);
        return Object.assign(res, await snapshot());
      }
      case 'openSignIn':
        await openSignIn();
        return { ok: true };
      default:
        return { ok: false, error: 'Unknown request' };
    }
  };
  run().then(reply, (e) => reply({ ok: false, error: e.message }));
  return true;
});
