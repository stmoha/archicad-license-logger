// Tests for the alert functions in Code.gs, with mocked Apps Script services.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const GS = require('path').join(__dirname, '..', 'apps-script', 'Code.gs');
const TZ = 'America/Los_Angeles';
let passed = 0;
const allMail = [];
const ok = (n) => { passed++; console.log('  ok  ' + n); };

function formatDate(d, tz, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  const H = Number(parts.hour), m = parts.minute;
  const h12 = ((H + 11) % 12) + 1, a = H < 12 ? 'AM' : 'PM';
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  const mon = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' }).format(d);
  switch (pattern) {
    case 'u': return String(dow);
    case 'H': return String(H);
    case 'm': return m;
    case 'yyyy-MM-dd': return `${parts.year}-${parts.month}-${parts.day}`;
    case 'h:mm a': return `${h12}:${m} ${a}`;
    case 'EEE MMM d, h:mm a': return `${parts.weekday} ${mon} ${Number(parts.day)}, ${h12}:${m} ${a}`;
    default: throw new Error('pattern ' + pattern);
  }
}

function make(settingsRows) {
  const log = [['Timestamp', 'Licenses', 'In use', 'Available', 'Users in use', 'Status']];
  const settings = [['Setting', 'Value'], ['Sample interval (minutes)', 10]].concat(settingsRows || []);
  const props = {};
  const mail = [];
  const triggers = [];
  let now = 0;
  const sheet = (data) => ({
    getLastRow: () => data.length,
    getRange: (r, c, nr, nc) => ({ getValues: () => data.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)) }),
    getDataRange: () => ({ getValues: () => data.map((r) => r.slice()) }),
  });
  const FakeDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
  const ctx = {
    Date: FakeDate, JSON, Math, Number, String, Array, isFinite, Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheetByName: (n) => ({ Log: sheet(log), Settings: sheet(settings), Dashboard: { getSheetId: () => 6 } }[n] || null),
      getSpreadsheetTimeZone: () => TZ, getUrl: () => 'https://docs.google.com/spreadsheets/d/1nROsAZEzEGxq7OcOxnr9EhyYCyJ8wSNlp1RjzcdQfiA/edit' }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    MailApp: { sendEmail: (to, subject, body) => { const e = { to, subject, body, at: new Date(now) }; mail.push(e); allMail.push(e); } },
    Utilities: { formatDate, getUuid: () => 'u' },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.split('@')[0] })),
      deleteTrigger: () => { triggers.length = 0; },
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (m) => ({ create: () => triggers.push(fn + '@' + m) }) }) }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(GS, 'utf8'), ctx);
  const at = (iso) => { now = Date.parse(iso); };
  // Log rows hold real Dates, like the sheet returns. Use the sandbox Date so instanceof works.
  const reading = (iso, inUse, total) => log.push([new FakeDate(iso), total || 12, inUse, (total || 12) - inUse, inUse ? 'Anna Post, Will Prescott' : '', 'OK']);
  const status = (iso, msg) => log.push([new FakeDate(iso), '', '', '', '', msg]);
  const check = (iso) => { at(iso); ctx.checkAlerts(); };
  return { ctx, log, mail, props, triggers, at, reading, status, check };
}

console.log('alerts');
{
  const t = make([['Alert emails to', 'a@example.com, b@example.com']]);
  t.at('2026-10-21T14:45:00-07:00');
  t.ctx.setupAlerts(); t.ctx.setupAlerts();
  assert.deepStrictEqual(t.triggers, ['checkAlerts@10']);
  assert.strictEqual(t.mail.length, 2);
  assert.strictEqual(t.mail[0].to, 'a@example.com, b@example.com');
  assert.match(t.mail[0].body, /no reading has arrived for 30 minutes between 6:00 and 20:00/);
  ok('setupAlerts makes one 10-minute trigger (no duplicates on rerun) and emails the Settings recipients');
}
{
  const t = make();
  for (let m = 0; m <= 30; m += 10) t.reading(`2026-10-21T13:${String(m).padStart(2, '0')}:00-07:00`, 9);
  t.check('2026-10-21T13:35:00-07:00');
  assert.strictEqual(t.mail.length, 0);
  t.check('2026-10-21T14:01:00-07:00');  // 31 min since 13:30
  assert.strictEqual(t.mail.length, 1);
  assert.strictEqual(t.mail[0].to, 'owner@example.com');
  assert.strictEqual(t.mail[0].subject, 'Archicad license logger: no readings since 1:30 PM');
  t.check('2026-10-21T14:11:00-07:00'); t.check('2026-10-21T17:51:00-07:00');
  assert.strictEqual(t.mail.length, 1);
  t.check('2026-10-21T18:02:00-07:00');  // 4 h after first alert
  assert.strictEqual(t.mail.length, 2);
  t.reading('2026-10-21T18:10:00-07:00', 7);
  t.check('2026-10-21T18:12:00-07:00');
  assert.strictEqual(t.mail[2].subject, 'Archicad license logger: readings resumed');
  assert.match(t.mail[2].body, /6:10 PM, 7 of 12 licenses in use/);
  t.check('2026-10-21T18:22:00-07:00');
  assert.strictEqual(t.mail.length, 3);
  ok('no-reading alert after 30 min, quiet in between, reminder at 4 h, one "resumed" email');
}
{
  const t = make();
  t.reading('2026-10-21T13:30:00-07:00', 9);
  t.status('2026-10-21T13:40:00-07:00', 'Signed out of Graphisoft');
  t.check('2026-10-21T14:05:00-07:00');
  assert.match(t.mail[0].body, /Last message from the logger: Signed out of Graphisoft\./);
  ok('the alert includes the logger\'s last error, such as being signed out');
}
{
  const t = make();
  t.reading('2026-10-21T19:50:00-07:00', 3);
  t.check('2026-10-21T21:00:00-07:00'); // after hours
  t.check('2026-10-22T06:10:00-07:00'); // window open, but first reading still has time
  assert.strictEqual(t.mail.length, 0);
  t.check('2026-10-22T06:31:00-07:00');
  assert.strictEqual(t.mail.length, 1);
  assert.strictEqual(t.mail[0].subject, 'Archicad license logger: no readings since Wed Oct 21, 7:50 PM');
  ok('silent overnight and for the first 30 min of the day; then names yesterday\'s last reading');
}
{
  const t = make([['Alerts on weekends', false]]);
  t.reading('2026-10-23T19:50:00-07:00', 3); // Friday
  t.check('2026-10-24T12:00:00-07:00');       // Saturday
  assert.strictEqual(t.mail.length, 0);
  ok('"Alerts on weekends" = FALSE skips Saturday');
}
{
  const t = make();
  t.reading('2026-10-21T13:00:00-07:00', 11);
  t.reading('2026-10-21T13:10:00-07:00', 12);
  t.check('2026-10-21T13:12:00-07:00');
  assert.strictEqual(t.mail.length, 1);
  assert.strictEqual(t.mail[0].subject, 'Archicad licenses: none available (12 of 12 in use)');
  assert.match(t.mail[0].body, /in use at 1:10 PM\./);
  assert.match(t.mail[0].body, /In use by:\n  Anna Post\n  Will Prescott/);
  for (let m = 20; m <= 50; m += 10) { t.reading(`2026-10-21T13:${m}:00-07:00`, 12); t.check(`2026-10-21T13:${m + 2}:00-07:00`); }
  assert.strictEqual(t.mail.length, 1);
  t.reading('2026-10-21T14:00:00-07:00', 12); t.check('2026-10-21T14:02:00-07:00'); // 50 min since email
  assert.strictEqual(t.mail.length, 1);
  t.reading('2026-10-21T14:10:00-07:00', 12); t.check('2026-10-21T14:12:00-07:00'); // 60 min
  assert.strictEqual(t.mail.length, 2);
  assert.match(t.mail[1].body, /in use at 2:10 PM, and have been since 1:10 PM\./);
  for (const tm of ['14:20', '14:30', '14:40', '14:50', '15:00', '15:10']) {
    t.reading(`2026-10-21T${tm}:00-07:00`, 11); t.check(`2026-10-21T${tm.replace(/0$/, '2')}:00-07:00`);
  }
  assert.strictEqual(t.mail.length, 2);
  t.reading('2026-10-21T15:20:00-07:00', 12); t.check('2026-10-21T15:22:00-07:00');
  assert.strictEqual(t.mail.length, 3);
  assert.match(t.mail[2].body, /in use at 3:20 PM\./);
  ok('full-capacity email right away, then once an hour while it lasts, with "since" time');
}
{
  const t = make();
  t.reading('2026-10-21T13:00:00-07:00', 12);
  t.check('2026-10-21T13:25:00-07:00'); // last reading 25 min old: stale data, not a capacity alert
  assert.strictEqual(t.mail.length, 0);
  ok('no capacity email from an old reading');
}
{
  const SHEET = 'Archicad License Usage sheet: https://docs.google.com/spreadsheets/d/1nROsAZEzEGxq7OcOxnr9EhyYCyJ8wSNlp1RjzcdQfiA/edit?gid=6#gid=6';
  const GSL = 'Graphisoft cloud license management: https://licensemanagement.graphisoft.com/cloud-licenses';
  const kinds = new Set();
  for (const e of allMail) {
    assert.ok(e.body.includes(SHEET), 'sheet link missing in: ' + e.subject);
    assert.ok(e.body.includes(GSL), 'Graphisoft link missing in: ' + e.subject);
    kinds.add(e.subject.replace(/since .*|\(.*\)/, '').trim());
  }
  assert.strictEqual(kinds.size, 4);
  ok(`all ${allMail.length} emails (setup, no readings, resumed, none available) end with both links`);
  console.log('\n--- sample "none available" email ---\n' + allMail.find((e) => /none available/.test(e.subject)).body);
}
console.log(`\n${passed} checks passed`);
