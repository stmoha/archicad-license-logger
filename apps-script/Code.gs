/**
 * Archicad License Logger: receiver for the Chrome extension.
 *
 * Paste this into Extensions > Apps Script in the "Archicad License Usage"
 * spreadsheet, run setupKey() once, then deploy as a web app
 * (Execute as: Me, Who has access: Anyone). See README.md.
 *
 * The extension POSTs JSON like:
 *   { "key": "...", "readings": [
 *       { "time": "2026-10-21T20:30:00.000Z", "intervalMinutes": 10,
 *         "licenses": 12, "inUse": 10, "available": 2, "status": "OK",
 *         "users": [ { "name": "Anna Post", "computer": "CAST-anna-22" } ] },
 *       { "time": "...", "intervalMinutes": 10, "status": "Signed out of Graphisoft" } ] }
 *
 * Each OK reading adds one row to "Log" and one row per person to "User log".
 * A status-only reading adds a Log row with blank counts, so gaps are explained.
 *
 * Email alerts: run setupAlerts() once. Every 10 minutes checkAlerts() emails
 * the addresses on the Settings tab when no reading has arrived for a while,
 * and at most once an hour while no licenses are available.
 */

const LOG_SHEET = 'Log';
const USER_SHEET = 'User log';
const DEDUPE_LOOKBACK_ROWS = 200;

/** Run once from the editor. Creates the shared key and prints it to the execution log. */
function setupKey() {
  const key = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('SHARED_KEY', key);
  Logger.log('Shared key for the extension: ' + key);
}

/** Lets you open the web app URL in a browser to confirm the deployment works. */
function doGet() {
  return json_({ ok: true, service: 'archicad-license-logger' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Request was not valid JSON' });
  }

  const key = PropertiesService.getScriptProperties().getProperty('SHARED_KEY');
  if (!key) return json_({ ok: false, error: 'No shared key yet. Run setupKey() in the script editor.' });
  if (!body || body.key !== key) return json_({ ok: false, error: 'Wrong shared key' });

  const readings = Array.isArray(body.readings) ? body.readings : [];
  if (!readings.length) return json_({ ok: true, added: 0, skipped: 0 });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const log = ss.getSheetByName(LOG_SHEET);
    const userLog = ss.getSheetByName(USER_SHEET);
    if (!log || !userLog) return json_({ ok: false, error: 'Missing "Log" or "User log" tab' });

    const recent = recentTimes_(log, DEDUPE_LOOKBACK_ROWS);
    const logRows = [];
    const userRows = [];
    let skipped = 0;

    readings
      .slice()
      .sort((a, b) => new Date(a.time) - new Date(b.time))
      .forEach((r) => {
        const when = new Date(r.time);
        if (isNaN(when.getTime())) { skipped++; return; }

        // Several computers can run the extension. Keep one reading per interval:
        // drop any reading within 80% of the interval of one already logged.
        const interval = Math.max(1, Number(r.intervalMinutes) || 10);
        const minGapMs = interval * 0.8 * 60000;
        if (recent.some((t) => Math.abs(t - when.getTime()) < minGapMs)) { skipped++; return; }
        recent.push(when.getTime());

        if (r.status === 'OK') {
          const users = Array.isArray(r.users) ? r.users : [];
          logRows.push([when, num_(r.licenses), num_(r.inUse), num_(r.available),
            users.map((u) => String(u.name || '')).join(', '), 'OK']);
          users.forEach((u) => userRows.push([when, String(u.name || ''), String(u.computer || '')]));
        } else {
          logRows.push([when, '', '', '', '', String(r.status || 'Unknown error').slice(0, 200)]);
        }
      });

    append_(log, logRows);
    append_(userLog, userRows);
    return json_({ ok: true, added: logRows.length, skipped: skipped });
  } finally {
    lock.releaseLock();
  }
}

function recentTimes_(sheet, n) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const start = Math.max(2, last - n + 1);
  return sheet.getRange(start, 1, last - start + 1, 1).getValues()
    .map((row) => row[0])
    .filter((v) => v instanceof Date)
    .map((d) => d.getTime());
}

function append_(sheet, rows) {
  if (!rows.length) return;
  const start = sheet.getLastRow() + 1;
  const shortBy = start + rows.length - 1 - sheet.getMaxRows();
  if (shortBy > 0) sheet.insertRowsAfter(sheet.getMaxRows(), shortBy);
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}

function num_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// Email alerts
// ---------------------------------------------------------------------------

const ALERT_CHECK_MINUTES = 10;
const STALE_REMINDER_HOURS = 4;
const CAPACITY_REPEAT_MINUTES = 55; // about once an hour, allowing for trigger timing

/** Run once from the editor. Starts the 10-minute check and sends a confirmation email. */
function setupAlerts() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'checkAlerts')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkAlerts').timeBased().everyMinutes(ALERT_CHECK_MINUTES).create();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = alertSettings_(ss);
  send_(cfg, 'Archicad license alerts are on', [
    'This sheet now checks the license log every ' + ALERT_CHECK_MINUTES + ' minutes and emails:',
    '',
    '- when no reading has arrived for ' + cfg.staleMinutes + ' minutes between ' +
      cfg.startHour + ':00 and ' + cfg.endHour + ':00' + (cfg.weekends ? '' : ' on weekdays') +
      ' (with a reminder every ' + STALE_REMINDER_HOURS + ' hours, and a note when readings resume)',
    '- at most once an hour while no Archicad licenses are available',
    '',
    'Recipients and times are on the Settings tab.',
    '',
    ...links_(cfg),
  ]);
  Logger.log('Alerts are on. Emails go to: ' + cfg.to);
}

/** Run by the time trigger. Can also be run by hand to check. */
function checkAlerts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfg = alertSettings_(ss);
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const rows = recentLogRows_(ss.getSheetByName(LOG_SHEET), 300);
  const ok = rows.filter((r) => r.status === 'OK' && typeof r.inUse === 'number');
  const lastOk = ok.length ? ok[ok.length - 1] : null;
  const lastRow = rows.length ? rows[rows.length - 1] : null;

  checkStale_(cfg, props, now, lastOk, lastRow);
  checkCapacity_(cfg, props, now, ok);
}

function checkStale_(cfg, props, now, lastOk, lastRow) {
  const alertedAt = Number(props.getProperty('STALE_ALERTED_AT') || 0);
  const stale = !lastOk || now.getTime() - lastOk.time.getTime() > cfg.staleMinutes * 60000;

  if (!stale) {
    if (alertedAt) {
      props.deleteProperty('STALE_ALERTED_AT');
      send_(cfg, 'Archicad license logger: readings resumed', [
        'Readings are reaching the sheet again. Latest: ' + fmt_(lastOk.time, cfg, now) + ', ' +
          lastOk.inUse + ' of ' + lastOk.licenses + ' licenses in use.',
        '',
        ...links_(cfg),
      ]);
    }
    return;
  }

  if (!inAlertWindow_(now, cfg)) return;
  if (alertedAt && now.getTime() - alertedAt < STALE_REMINDER_HOURS * 3600000) return;
  props.setProperty('STALE_ALERTED_AT', String(now.getTime()));

  const lastMessage = lastRow && lastRow.status !== 'OK' && (!lastOk || lastRow.time > lastOk.time)
    ? lastRow.status : '';
  const since = lastOk ? fmt_(lastOk.time, cfg, now) : 'the log started';
  const lines = ['No Archicad license reading has reached the sheet since ' + since + '.'];
  if (lastMessage) lines.push('', 'Last message from the logger: ' + lastMessage + '.');
  lines.push(
    '',
    'Things to check on the server:',
    '- Is the server on, with the logger\'s Windows account signed in?',
    '- Is Chrome running? Its icon should be in the system tray.',
    '- Is that Chrome still signed in to Graphisoft? Open licensemanagement.graphisoft.com there and sign in if asked.',
    '- Click the extension icon in Chrome: it shows the last error.',
    '',
    ...links_(cfg)
  );
  send_(cfg, 'Archicad license logger: no readings since ' + since, lines);
}

function checkCapacity_(cfg, props, now, ok) {
  const last = ok.length ? ok[ok.length - 1] : null;
  if (!last || last.available !== 0) return;
  const fresh = now.getTime() - last.time.getTime() <= (cfg.interval * 2 + 2) * 60000;
  if (!fresh) return;
  const sentAt = Number(props.getProperty('CAPACITY_EMAILED_AT') || 0);
  if (now.getTime() - sentAt < CAPACITY_REPEAT_MINUTES * 60000) return;
  props.setProperty('CAPACITY_EMAILED_AT', String(now.getTime()));

  let since = last.time;
  for (let i = ok.length - 1; i >= 0 && ok[i].available === 0; i--) since = ok[i].time;
  const users = String(last.users || '').split(', ').filter(Boolean);

  send_(cfg, 'Archicad licenses: none available (' + last.inUse + ' of ' + last.licenses + ' in use)', [
    'All ' + last.licenses + ' Archicad licenses were in use at ' + fmt_(last.time, cfg, now) +
      (since < last.time ? ', and have been since ' + fmt_(since, cfg, now) + '.' : '.'),
    '',
    'In use by:',
  ].concat(users.map((u) => '  ' + u), [
    '',
    'This email repeats at most once an hour while no licenses are free.',
    '',
    ...links_(cfg),
  ]));
}

function recentLogRows_(sheet, n) {
  if (!sheet) return [];
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const start = Math.max(2, last - n + 1);
  return sheet.getRange(start, 1, last - start + 1, 6).getValues()
    .filter((r) => r[0] instanceof Date)
    .map((r) => ({
      time: r[0],
      licenses: r[1],
      inUse: r[2],
      available: r[3],
      users: r[4],
      status: String(r[5] || ''),
    }));
}

/** Reads the alert settings from the Settings tab by their labels in column A. */
function alertSettings_(ss) {
  const map = {};
  const sh = ss.getSheetByName('Settings');
  if (sh) sh.getDataRange().getValues().forEach((r) => { if (r[0] !== '') map[String(r[0]).trim()] = r[1]; });
  const blank = (v) => v === '' || v === null || v === undefined;
  const num = (label, d) => (blank(map[label]) || !isFinite(Number(map[label])) ? d : Number(map[label]));
  const wk = map['Alerts on weekends'];
  return {
    to: String(map['Alert emails to'] || '').trim() || Session.getEffectiveUser().getEmail(),
    interval: num('Sample interval (minutes)', 10),
    staleMinutes: num('No-reading alert after (minutes)', 30),
    startHour: num('Alerts from (hour)', 6),
    endHour: num('Alerts until (hour)', 20),
    weekends: blank(wk) ? true : wk === true || String(wk).toUpperCase() === 'TRUE',
    tz: ss.getSpreadsheetTimeZone(),
    dashboardUrl: dashboardUrl_(ss),
  };
}

/** Link to the sheet's Dashboard tab (falls back to the sheet itself). */
function dashboardUrl_(ss) {
  const dash = ss.getSheetByName('Dashboard');
  const base = ss.getUrl();
  return dash ? base + '?gid=' + dash.getSheetId() + '#gid=' + dash.getSheetId() : base;
}

/** Footer lines for every alert email. */
function links_(cfg) {
  return [
    'Archicad License Usage sheet: ' + cfg.dashboardUrl,
    'Graphisoft cloud license management: https://licensemanagement.graphisoft.com/cloud-licenses',
  ];
}

/** True during alert hours, once the window has been open long enough for a first reading. */
function inAlertWindow_(now, cfg) {
  const dow = Number(Utilities.formatDate(now, cfg.tz, 'u')); // 1 = Monday ... 7 = Sunday
  if (!cfg.weekends && dow >= 6) return false;
  const h = Number(Utilities.formatDate(now, cfg.tz, 'H')) + Number(Utilities.formatDate(now, cfg.tz, 'm')) / 60;
  return h >= cfg.startHour + cfg.staleMinutes / 60 && h < cfg.endHour;
}

function fmt_(d, cfg, now) {
  const sameDay = Utilities.formatDate(d, cfg.tz, 'yyyy-MM-dd') === Utilities.formatDate(now, cfg.tz, 'yyyy-MM-dd');
  return Utilities.formatDate(d, cfg.tz, sameDay ? 'h:mm a' : 'EEE MMM d, h:mm a');
}

function send_(cfg, subject, lines) {
  MailApp.sendEmail(cfg.to, subject, lines.join('\n'));
}
