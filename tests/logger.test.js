// Test harness: lib.js logic, background.js flow with mocked chrome APIs, Code.gs with mocked Apps Script.
process.env.TZ = 'America/Los_Angeles';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const EXT = path.join(__dirname, '..', 'extension') + '/';
const GS = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const lib = require(EXT + 'lib.js');

let passed = 0;
const plain = (x) => JSON.parse(JSON.stringify(x));
const ok = (name) => { passed++; console.log('  ok  ' + name); };

// ---------- fixture shaped like the real API response ----------
function bundle(user, device, extra) {
  return Object.assign({
    productName: 'Archicad Studio, USA', isFloating: true,
    assignedToGroupName: 'CAST bim users', assignedToUserId: user ? 'id-' + user : null,
    assignedToUserName: user,
    licenses: [
      { licensedItemDisplayName: 'Archicad Studio, USA', deviceActivities: device ? [{ deviceName: 'CAST.local\\' + device, lastActivity: '2026-10-21T17:03:31Z' }] : [] },
      { licensedItemDisplayName: 'Subscription Benefits', deviceActivities: [] },
    ],
  }, extra || {});
}
const held = [['Madeline Goryl', 'CAST-madeline'], ['Forrest Murphy', 'ForrestThinkPad'], ['vy nguyen', 'CAST-VY'],
  ['Anna Post', 'CAST-anna-22'], ['Emily Terzic', 'CAST-emily-26'], ['Meredith Kelly', 'CAST-meredith-23'],
  ['Emilio Craddock', 'CAST-emilio'], ['Mallisyn Bruce', 'CAST-mallisyn'], ['Natalie Grimm', 'CAST-NATALIE'], ['Will Prescott', 'CAST-Will-24']];
const FIXTURE = [
  { productName: 'BIMx Pro', isFloating: false, assignedToUserName: 'Stefan Hampden', assignedToUserId: 'x', licenses: [] },
  { productName: 'Archicad Beta', isFloating: false, assignedToUserName: 'Stefan Hampden', assignedToUserId: 'x', licenses: [] },
  ...held.map(([u, d]) => bundle(u, d)), bundle(null, null), bundle(null, null),
];

console.log('lib.js');
{
  const s = lib.summarizeLicenses(FIXTURE, 'CAST bim users');
  assert.strictEqual(s.licenses, 12); assert.strictEqual(s.inUse, 10); assert.strictEqual(s.available, 2);
  assert.deepStrictEqual(s.users.map((u) => u.name), ['Anna Post', 'Emilio Craddock', 'Emily Terzic', 'Forrest Murphy',
    'Madeline Goryl', 'Mallisyn Bruce', 'Meredith Kelly', 'Natalie Grimm', 'vy nguyen', 'Will Prescott']);
  assert.strictEqual(s.users[0].computer, 'CAST-anna-22');
  ok('summarizes the real response shape: 12 licenses, 10 in use, sorted like the seeded row');
  assert.strictEqual(lib.summarizeLicenses(FIXTURE, 'cast BIM users ').inUse, 10);
  ok('group match ignores case and spaces');
  assert.throws(() => lib.summarizeLicenses(FIXTURE, 'Other group'), /No floating licenses found for group/);
  assert.throws(() => lib.summarizeLicenses({ error: 'x' }, 'g'), /Unexpected response/);
  ok('clear errors for a wrong group or non-array response');
  const leaseOnly = lib.summarizeLicenses([bundle(null, 'CAST-x'), bundle(null, null)], '');
  assert.strictEqual(leaseOnly.inUse, 1); assert.strictEqual(leaseOnly.users[0].name, '(unknown)');
  ok('a device lease with no named holder still counts as in use');

  const S = lib.normalizeSettings({ startHour: 6, endHour: 20, weekends: false });
  assert.strictEqual(lib.withinActiveHours(new Date('2026-10-21T13:00:00-07:00'), S), true);
  assert.strictEqual(lib.withinActiveHours(new Date('2026-10-21T05:59:00-07:00'), S), false);
  assert.strictEqual(lib.withinActiveHours(new Date('2026-10-21T20:00:00-07:00'), S), false);
  assert.strictEqual(lib.withinActiveHours(new Date('2026-10-24T13:00:00-07:00'), S), false); // Saturday
  assert.strictEqual(lib.withinActiveHours(new Date('2026-10-24T13:00:00-07:00'), lib.normalizeSettings({})), true);
  assert.strictEqual(lib.withinActiveHours(new Date('2026-10-21T02:00:00-07:00'), lib.normalizeSettings({ startHour: 22, endHour: 6 })), true);
  assert.strictEqual(lib.withinActiveHours(new Date('2026-10-21T02:00:00-07:00'), lib.normalizeSettings({ startHour: 0, endHour: 24 })), true);
  ok('active-hours window, weekends, overnight and all-day cases');

  assert.strictEqual(lib.normalizeSettings({ intervalMinutes: 1 }).intervalMinutes, 5);
  assert.strictEqual(lib.normalizeSettings({ intervalMinutes: 'abc' }).intervalMinutes, 10);
  const t = lib.nextAlignedTime(Date.parse('2026-10-21T20:24:43Z'), 10);
  assert.strictEqual(new Date(t).toISOString(), '2026-10-21T20:30:00.000Z');
  ok('settings clamping and alarm alignment to :00/:10/:20');
}

// ---------- background.js with mocked chrome ----------
function makeBackground(opts) {
  const store = {};
  const badge = {};
  const tabs = { created: [], removed: [], reloaded: [], updated: [], focused: [] };
  const posts = [];
  let clock = Date.parse('2026-10-21T20:30:00Z');
  const listeners = {};
  const ev = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const FakeDate = class extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock); }
    static now() { return clock; }
  };
  const chrome = {
    storage: { local: {
      get: async (k) => (k in store ? { [k]: JSON.parse(JSON.stringify(store[k])) } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) store[k] = JSON.parse(JSON.stringify(v)); },
    } },
    alarms: { _a: null, get: async () => chrome.alarms._a, create: async (n, o) => { chrome.alarms._a = { name: n, scheduledTime: o.when, periodInMinutes: o.periodInMinutes }; }, onAlarm: ev('alarm') },
    runtime: { onInstalled: ev('installed'), onStartup: ev('startup'), onMessage: ev('message'),
      getManifest: () => ({ version: opts.running || '1.2.0' }), getURL: (f) => 'chrome-extension://test/' + f,
      reload: () => { tabs.reloadedSelf = (tabs.reloadedSelf || 0) + 1; } },
    tabs: {
      onUpdated: ev('tabUpdated'),
      query: async (q) => (q && q.pinned ? (opts.pinnedTabs ? opts.pinnedTabs() : []) : (opts.openTabs || [])),
      create: async (o) => { const t = { id: 100 + tabs.created.length, url: undefined, status: 'complete', windowId: 1 }; tabs.created.push(o); return t; },
      get: async (id) => {
        if (tabs.removed.includes(id)) throw new Error('No tab with id: ' + id);
        if (opts.tabState) return Object.assign({ id, status: 'complete', windowId: 1 }, opts.tabState(id));
        return { id, status: 'complete', windowId: 1, url: opts.newTabReachesApp ? 'https://licensemanagement.graphisoft.com/cloud-licenses' : undefined };
      },
      remove: async (id) => { tabs.removed.push(id); },
      reload: async (id) => { tabs.reloaded.push(id); },
      update: async (id, p) => { tabs.updated.push([id, p]); },
    },
    windows: { update: async (id, p) => { tabs.focused.push(id); } },
    idle: { queryState: async () => (opts.idle || 'locked') },
    scripting: { executeScript: async () => [{ result: opts.tabFetch ? opts.tabFetch() : { ok: false, kind: 'auth' } }] },
    action: {
      setBadgeText: async (o) => { badge.text = o.text; }, setBadgeBackgroundColor: async (o) => { badge.color = o.color; },
      setBadgeTextColor: async () => {}, setTitle: async (o) => { badge.title = o.title; },
    },
  };
  const fetch = async (url, init) => {
    if (url.startsWith('chrome-extension://')) return { json: async () => ({ version: opts.onDisk || opts.running || '1.2.0' }) };
    if (url.startsWith('https://licensemanagement.graphisoft.com/')) return opts.gs();
    posts.push(JSON.parse(init.body));
    return opts.sheet(JSON.parse(init.body));
  };
  const ctx = {
    chrome, fetch, console, URL, JSON, Promise, Math, Number, String, Object, Array, Set, Error,
    Date: FakeDate,
    setTimeout: (fn, ms) => { clock += ms; Promise.resolve().then(fn); return 0; },
    importScripts: (f) => vm.runInContext(fs.readFileSync(EXT + f, 'utf8'), ctx, { filename: f }),
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(EXT + 'background.js', 'utf8'), ctx, { filename: 'background.js' });
  const message = (msg) => new Promise((res) => listeners.message(msg, {}, res));
  return { ctx, store, badge, tabs, posts, message, listeners, advance: (ms) => { clock += ms; } };
}
const jsonResp = (data) => ({ ok: true, status: 200, type: 'basic', headers: { get: () => 'application/json; charset=utf-8' }, json: async () => data });
const statusResp = (status) => ({ ok: false, status, type: 'basic', headers: { get: () => 'text/html' }, json: async () => ({}) });
const sheetResp = (obj) => ({ status: 200, text: async () => JSON.stringify(obj) });
const SETTINGS = { webAppUrl: 'https://script.google.com/macros/s/abc/exec', sharedKey: 'k1', startHour: 0, endHour: 24, keepAlive: false };

(async () => {
  console.log('background.js');
  {
    const b = makeBackground({ gs: () => jsonResp(FIXTURE), sheet: () => sheetResp({ ok: true, added: 1, skipped: 0 }) });
    await b.ctx.chrome.storage.local.set({ settings: SETTINGS });
    const snap = await b.message({ type: 'readNow' });
    assert.strictEqual(snap.state.lastOk.inUse, 10);
    assert.strictEqual(snap.queueLength, 0);
    assert.strictEqual(b.posts.length, 1);
    const r = b.posts[0].readings[0];
    assert.strictEqual(b.posts[0].key, 'k1');
    assert.deepStrictEqual([r.licenses, r.inUse, r.available, r.status, r.users.length, r.intervalMinutes], [12, 10, 2, 'OK', 10, 10]);
    assert.strictEqual(b.badge.text, '10'); assert.strictEqual(b.badge.color, '#B26A00');
    assert.strictEqual(b.tabs.created.length, 0);
    ok('reads directly, posts one reading, badge shows 10 in amber (2 free), no tab opened');
  }
  {
    // Session expired: direct 401, new background tab renews it and the read succeeds there.
    const b = makeBackground({ gs: () => statusResp(401), newTabReachesApp: true, tabFetch: () => ({ ok: true, data: FIXTURE }),
      sheet: () => sheetResp({ ok: true, added: 1, skipped: 0 }) });
    await b.ctx.chrome.storage.local.set({ settings: SETTINGS });
    const snap = await b.message({ type: 'readNow' });
    assert.strictEqual(snap.state.lastOk.inUse, 10);
    assert.strictEqual(b.tabs.created.length, 1); assert.strictEqual(b.tabs.created[0].active, false);
    assert.deepStrictEqual(b.tabs.removed, [100]);
    ok('expired session: opens a background tab, reads through it, closes it');
    // Direct reads still failing next time: open one pinned tab and leave it open.
    b.advance(600000);
    await b.message({ type: 'readNow' });
    assert.strictEqual(b.tabs.created.length, 2); assert.strictEqual(b.tabs.created[1].pinned, true);
    assert.deepStrictEqual(b.tabs.removed, [100]);
    ok('if direct reads keep failing, keeps one pinned Graphisoft tab instead of reopening');
  }
  {
    // Fully signed out: one status row, then no repeat rows and no more tabs on scheduled runs.
    const b = makeBackground({ gs: () => statusResp(401), newTabReachesApp: false, sheet: () => sheetResp({ ok: true, added: 1, skipped: 0 }) });
    await b.ctx.chrome.storage.local.set({ settings: SETTINGS });
    await new Promise((res) => { b.listeners.alarm({ name: 'archicad-license-sample' }); setImmediate(res); });
    let snap = await b.message({ type: 'status' });
    // wait for the serialized job
    for (let i = 0; i < 50 && !snap.state.lastError; i++) { await new Promise((r) => setImmediate(r)); snap = await b.message({ type: 'status' }); }
    assert.strictEqual(snap.state.lastError.message, 'Signed out of Graphisoft');
    assert.strictEqual(snap.state.signedOut, true);
    assert.strictEqual(b.tabs.created.length, 1); assert.deepStrictEqual(b.tabs.removed, [100]);
    assert.strictEqual(b.posts.length, 1); assert.strictEqual(b.posts[0].readings[0].status, 'Signed out of Graphisoft');
    assert.strictEqual(b.badge.text, '!');
    b.advance(600000);
    b.listeners.alarm({ name: 'archicad-license-sample' });
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    assert.strictEqual(b.tabs.created.length, 1, 'no new tab while signed out');
    assert.strictEqual(b.posts.length, 1, 'status logged once');
    ok('signed out: logs one status row, shows "!", stops opening tabs until sign-in');
  }
  {
    // Sheet unreachable: readings queue up, then flush together once it works.
    let up = false;
    const b = makeBackground({ gs: () => jsonResp(FIXTURE), sheet: (body) => up ? sheetResp({ ok: true, added: body.readings.length, skipped: 0 }) : { status: 500, text: async () => '<html>error</html>' } });
    await b.ctx.chrome.storage.local.set({ settings: SETTINGS });
    let snap = await b.message({ type: 'readNow' });
    b.advance(600000);
    snap = await b.message({ type: 'readNow' });
    assert.strictEqual(snap.queueLength, 2);
    assert.match(snap.state.postError.message, /Unexpected reply from the sheet/);
    up = true;
    b.advance(600000);
    snap = await b.message({ type: 'readNow' });
    assert.strictEqual(snap.queueLength, 0);
    assert.strictEqual(b.posts[b.posts.length - 1].readings.length, 3);
    assert.strictEqual(snap.state.postError, null);
    ok('sheet down: readings queue locally and are sent together when it recovers');
  }
  {
    // Not configured: keep reading, queue, and Save-and-test connects and flushes.
    const b = makeBackground({ gs: () => jsonResp(FIXTURE), sheet: (body) => body.key === 'good' ? sheetResp({ ok: true, added: body.readings.length, skipped: 0 }) : sheetResp({ ok: false, error: 'Wrong shared key' }) });
    let snap = await b.message({ type: 'readNow' });
    assert.strictEqual(snap.queueLength, 1); assert.strictEqual(b.posts.length, 0);
    let res = await b.message({ type: 'save', settings: { webAppUrl: SETTINGS.webAppUrl, sharedKey: 'bad', intervalMinutes: 15 } });
    assert.strictEqual(res.ok, false); assert.strictEqual(res.message, 'Wrong shared key');
    res = await b.message({ type: 'save', settings: { webAppUrl: SETTINGS.webAppUrl, sharedKey: 'good', intervalMinutes: 15 } });
    assert.strictEqual(res.ok, true); assert.match(res.message, /Sent 1 waiting reading\./);
    assert.strictEqual(res.queueLength, 0);
    assert.strictEqual(b.ctx.chrome.alarms._a.periodInMinutes, 15);
    ok('before setup readings queue; Save and test reports a wrong key, then connects and flushes');
  }
  {
    const b = makeBackground({ gs: () => jsonResp(FIXTURE), sheet: () => sheetResp({ ok: true, added: 1, skipped: 0 }) });
    await b.ctx.chrome.storage.local.set({ settings: Object.assign({}, SETTINGS, { startHour: 6, endHour: 7 }) });
    b.listeners.alarm({ name: 'archicad-license-sample' }); // 1:30 pm local, outside 6–7
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    const snap = await b.message({ type: 'status' });
    assert.ok(snap.state.lastSkipped); assert.strictEqual(snap.state.lastOk, undefined);
    ok('scheduled readings outside active hours are skipped');
  }


  console.log('keep-alive');
  const tick = async (b) => { b.listeners.alarm({ name: 'archicad-license-sample' }); for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };
  {
    const APP = 'https://licensemanagement.graphisoft.com/cloud-licenses';
    let url = APP;
    const b = makeBackground({ gs: () => jsonResp(FIXTURE), sheet: () => sheetResp({ ok: true, added: 1, skipped: 0 }),
      tabState: () => ({ url, pinned: true, active: false }) });
    await b.ctx.chrome.storage.local.set({ settings: Object.assign({}, SETTINGS, { keepAlive: true, startHour: 6, endHour: 7 }) });
    await tick(b);  // 1:30 pm, outside 6–7: no reading, but keep-alive still runs
    assert.strictEqual(b.tabs.created.length, 1);
    assert.deepStrictEqual([b.tabs.created[0].pinned, b.tabs.created[0].active, b.tabs.created[0].url], [true, false, APP]);
    assert.strictEqual(b.posts.length, 0);
    ok('first tick opens one pinned background Graphisoft tab, even outside logging hours');
    b.advance(600000); await tick(b);
    b.advance(600000); await tick(b);
    assert.strictEqual(b.tabs.created.length, 1);
    assert.deepStrictEqual(b.tabs.reloaded, [100, 100]);
    ok('later ticks reload that same tab instead of opening new ones');
    url = undefined;  // tab now on the sign-in page (another origin)
    b.advance(600000); await tick(b);
    assert.deepStrictEqual(b.tabs.reloaded, [100, 100]);
    ok('leaves the tab alone while it shows the sign-in page');
  }
  {
    const b = makeBackground({ gs: () => jsonResp(FIXTURE), sheet: () => sheetResp({ ok: true, added: 1, skipped: 0 }), idle: 'active',
      tabState: () => ({ url: 'https://licensemanagement.graphisoft.com/cloud-licenses', pinned: true, active: true }) });
    await b.ctx.chrome.storage.local.set({ settings: Object.assign({}, SETTINGS, { keepAlive: true }), state: { keepAliveTabId: 7 } });
    await tick(b);
    assert.deepStrictEqual(b.tabs.reloaded, []);
    assert.strictEqual(b.tabs.created.length, 0);
    ok('does not reload while someone is actively looking at the tab');
  }
  {
    // After a Chrome restart the old tab id is gone; reuse the restored pinned tab.
    const b = makeBackground({ gs: () => jsonResp(FIXTURE), sheet: () => sheetResp({ ok: true, added: 1, skipped: 0 }),
      pinnedTabs: () => [{ id: 55, pinned: true, url: 'https://licensemanagement.graphisoft.com/cloud-licenses' }],
      tabState: (id) => (id === 55 ? { url: 'https://licensemanagement.graphisoft.com/cloud-licenses', pinned: true, active: false } : null) });
    b.tabs.removed.push(9);
    await b.ctx.chrome.storage.local.set({ settings: Object.assign({}, SETTINGS, { keepAlive: true }), state: { keepAliveTabId: 9 } });
    await tick(b);
    assert.strictEqual(b.tabs.created.length, 0);
    assert.deepStrictEqual(b.tabs.reloaded, [55]);
    const st = (await b.message({ type: 'status' })).state;
    assert.strictEqual(st.keepAliveTabId, 55);
    ok('after a Chrome restart it adopts the restored pinned tab rather than adding another');
  }
  {
    const b = makeBackground({ gs: () => statusResp(401), sheet: () => sheetResp({ ok: true, added: 1, skipped: 0 }),
      tabState: () => ({ url: undefined, pinned: true, active: false }) });
    await b.ctx.chrome.storage.local.set({ settings: Object.assign({}, SETTINGS, { keepAlive: true }), state: { keepAliveTabId: 42, signedOut: true } });
    await b.message({ type: 'openSignIn' });
    assert.deepStrictEqual(plain(b.tabs.updated), [[42, { active: true }]]);
    assert.deepStrictEqual(b.tabs.focused, [1]);
    assert.strictEqual(b.tabs.created.length, 0);
    ok('"Open Graphisoft to sign in" brings the pinned tab forward instead of opening another');
  }
  {
    const b = makeBackground({ gs: () => jsonResp(FIXTURE), sheet: () => sheetResp({ ok: true, added: 1, skipped: 0 }) });
    await b.ctx.chrome.storage.local.set({ settings: SETTINGS });
    await tick(b);
    assert.strictEqual(b.tabs.created.length, 0); assert.deepStrictEqual(b.tabs.reloaded, []);
    ok('turning the setting off stops the pinned tab');
  }


  console.log('self-update');
  {
    const b = makeBackground({ gs: () => jsonResp(FIXTURE), sheet: () => sheetResp({ ok: true, added: 1, skipped: 0 }), running: '1.2.0', onDisk: '1.2.1' });
    await b.ctx.chrome.storage.local.set({ settings: SETTINGS });
    await tick(b);
    assert.strictEqual(b.tabs.reloadedSelf, 1);
    assert.strictEqual(b.posts.length, 0, 'no reading from the old code once an update is waiting');
    const st = (await b.message({ type: 'status' })).state;
    assert.deepStrictEqual([st.updatedFrom, st.reloadTarget], ['1.2.0', '1.2.1']);
    await tick(b);
    assert.strictEqual(b.tabs.reloadedSelf, 1);
    assert.strictEqual(b.posts.length, 1);
    ok('new version on disk: reloads once, and does not loop if the reload did not take');
  }
  {
    const b = makeBackground({ gs: () => jsonResp(FIXTURE), sheet: () => sheetResp({ ok: true, added: 1, skipped: 0 }) });
    await b.ctx.chrome.storage.local.set({ settings: SETTINGS });
    await tick(b);
    assert.strictEqual(b.tabs.reloadedSelf, undefined); assert.strictEqual(b.posts.length, 1);
    const snap = await b.message({ type: 'status' });
    assert.strictEqual(snap.version, '1.2.0');
    ok('same version: no reload, reading goes ahead, popup shows the version');
  }

  // ---------- Code.gs with mocked Apps Script ----------
  console.log('Code.gs');
  function makeSheet(rows) {
    const data = rows.map((r) => r.slice());
    let maxRows = Math.max(data.length, 5);
    return {
      data,
      getLastRow: () => data.length,
      getMaxRows: () => maxRows,
      insertRowsAfter: (after, n) => { maxRows += n; },
      getRange: (r, c, nr, nc) => ({
        getValues: () => data.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
        setValues: (vals) => {
          assert.ok(r - 1 + nr <= maxRows, 'write past grid');
          vals.forEach((v, i) => { data[r - 1 + i] = v.slice(); });
        },
      }),
    };
  }
  function makeGs(seedLog) {
    const props = { SHARED_KEY: 'secret' };
    const log = makeSheet(seedLog);
    const userLog = makeSheet([['Timestamp', 'User', 'Computer']]);
    const ctx = {
      PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k], setProperty: (k, v) => { props[k] = v; } }) },
      LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
      SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => ({ Log: log, 'User log': userLog }[n]) }) },
      ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => JSON.parse(s) }) },
      Utilities: { getUuid: () => '1234-abcd' }, Logger: { log: () => {} },
      Date, JSON, Math, Number, String, Array,
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(GS, 'utf8'), ctx);
    const post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
    return { ctx, log, userLog, post, props };
  }
  const seedTime = new Date('2026-10-21T20:24:43Z');
  const g = makeGs([['Timestamp', 'Licenses', 'In use', 'Available', 'Users in use', 'Status'], [seedTime, 12, 10, 2, 'x', 'OK']]);
  const reading = (iso, extra) => Object.assign({ time: iso, intervalMinutes: 10, licenses: 12, inUse: 2, available: 10, status: 'OK',
    users: [{ name: 'Anna Post', computer: 'CAST-anna-22' }, { name: 'Will Prescott', computer: 'CAST-Will-24' }] }, extra || {});

  assert.deepStrictEqual(g.post({ key: 'nope', readings: [reading('2026-10-21T20:40:00Z')] }), { ok: false, error: 'Wrong shared key' });
  assert.deepStrictEqual(g.post({ key: 'secret', readings: [] }), { ok: true, added: 0, skipped: 0 });
  assert.strictEqual(g.log.data.length, 2);
  ok('rejects a wrong key; an empty test post writes nothing');

  let res = g.post({ key: 'secret', readings: [reading('2026-10-21T20:40:00Z')] });
  assert.deepStrictEqual(res, { ok: true, added: 1, skipped: 0 });
  assert.deepStrictEqual(plain(g.log.data[2].slice(1)), [12, 2, 10, 'Anna Post, Will Prescott', 'OK']);
  assert.ok(g.log.data[2][0] instanceof Date);
  assert.deepStrictEqual(plain(g.userLog.data.slice(1).map((r) => r.slice(1))), [['Anna Post', 'CAST-anna-22'], ['Will Prescott', 'CAST-Will-24']]);
  ok('appends one Log row (real Date) and one User log row per person');

  res = g.post({ key: 'secret', readings: [reading('2026-10-21T20:45:00Z')] });
  assert.deepStrictEqual(res, { ok: true, added: 0, skipped: 1 });
  res = g.post({ key: 'secret', readings: [reading('2026-10-21T20:49:00Z')] });
  assert.deepStrictEqual(res, { ok: true, added: 1, skipped: 0 });
  ok('drops a second computer\'s reading 5 min later, keeps one 9 min later');

  res = g.post({ key: 'secret', readings: [
    { time: '2026-10-21T21:20:00Z', intervalMinutes: 10, status: 'Signed out of Graphisoft' },
    reading('2026-10-21T21:00:00Z'), reading('2026-10-21T21:10:00Z'), { time: 'garbage', status: 'OK' }] });
  assert.deepStrictEqual(res, { ok: true, added: 3, skipped: 1 });
  const tail = g.log.data.slice(-3);
  assert.deepStrictEqual(tail.map((r) => r[0].toISOString()), ['2026-10-21T21:00:00.000Z', '2026-10-21T21:10:00.000Z', '2026-10-21T21:20:00.000Z']);
  assert.deepStrictEqual(plain(tail[2].slice(1)), ['', '', '', '', 'Signed out of Graphisoft']);
  ok('a queued batch is sorted by time; status rows have blank counts; bad timestamps skipped');

  const big = makeGs([['h']]);
  const many = Array.from({ length: 12 }, (_, i) => reading(new Date(Date.parse('2026-10-22T15:00:00Z') + i * 600000).toISOString()));
  assert.deepStrictEqual(big.post({ key: 'secret', readings: many }), { ok: true, added: 12, skipped: 0 });
  ok('grows the tab when the grid runs out of rows');

  big.ctx.setupKey();
  assert.strictEqual(big.props.SHARED_KEY, '1234abcd');
  ok('setupKey stores a new key');

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
