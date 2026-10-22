/*
 * Shared helpers for the Archicad License Logger.
 * Loaded by background.js (importScripts) and popup.html (<script>).
 */
'use strict';

const GS_ORIGIN = 'https://licensemanagement.graphisoft.com';
const GS_PAGE_URL = GS_ORIGIN + '/cloud-licenses';
const GS_ID_ORIGIN = 'https://id.graphisoft.com';
const SIGNED_OUT = 'Signed out of Graphisoft';

const DEFAULT_SETTINGS = {
  webAppUrl: '',
  sharedKey: '',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/1nROsAZEzEGxq7OcOxnr9EhyYCyJ8wSNlp1RjzcdQfiA/edit',
  orgId: '7beac5d6-8154-4b0a-9e7a-6d09971012dc',
  groupName: 'CAST bim users',
  intervalMinutes: 10,
  startHour: 6,
  endHour: 20,
  weekends: true,
  keepAlive: true,
};

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function normalizeSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  return {
    webAppUrl: String(s.webAppUrl || '').trim(),
    sharedKey: String(s.sharedKey || '').trim(),
    sheetUrl: String(s.sheetUrl || '').trim(),
    orgId: String(s.orgId || '').trim(),
    groupName: String(s.groupName || '').trim(),
    intervalMinutes: clampInt(s.intervalMinutes, 5, 120, DEFAULT_SETTINGS.intervalMinutes),
    startHour: clampInt(s.startHour, 0, 24, DEFAULT_SETTINGS.startHour),
    endHour: clampInt(s.endHour, 0, 24, DEFAULT_SETTINGS.endHour),
    weekends: s.weekends !== false,
    keepAlive: s.keepAlive !== false,
  };
}

/** True when a scheduled reading should be taken at this local time. */
function withinActiveHours(date, s) {
  const day = date.getDay();
  if (!s.weekends && (day === 0 || day === 6)) return false;
  const start = Number(s.startHour);
  const end = Number(s.endHour);
  if (start === end) return true; // same start and end means all day
  const h = date.getHours() + date.getMinutes() / 60;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

function shortDeviceName(name) {
  if (!name) return '';
  const s = String(name);
  const i = s.lastIndexOf('\\');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Turns the GetLicensesOfOrganization response into counts for one floating group.
 * A license counts as in use when Graphisoft shows a holder or an active device lease.
 */
function summarizeLicenses(bundles, groupName) {
  if (!Array.isArray(bundles)) throw new Error('Unexpected response from Graphisoft');
  const g = String(groupName || '').trim().toLowerCase();
  const floating = bundles.filter((b) =>
    b && b.isFloating && (!g || String(b.assignedToGroupName || '').trim().toLowerCase() === g));
  if (!floating.length) {
    throw new Error(g ? `No floating licenses found for group "${groupName}"` : 'No floating licenses found');
  }

  const users = [];
  for (const b of floating) {
    const leases = (b.licenses || []).flatMap((l) => l.deviceActivities || []);
    if (!b.assignedToUserId && !leases.length) continue;
    const computers = [...new Set(leases.map((d) => shortDeviceName(d.deviceName)).filter(Boolean))];
    users.push({ name: b.assignedToUserName || '(unknown)', computer: computers.join(', ') });
  }
  users.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return {
    licenses: floating.length,
    inUse: users.length,
    available: floating.length - users.length,
    users,
    products: [...new Set(floating.map((b) => b.productName))],
  };
}

/** First alarm time on a clean multiple of the interval (e.g. :00, :10, :20). */
function nextAlignedTime(nowMs, intervalMinutes) {
  const step = intervalMinutes * 60000;
  return Math.ceil((nowMs + 30000) / step) * step;
}

if (typeof module !== 'undefined') {
  module.exports = {
    GS_ORIGIN, GS_PAGE_URL, GS_ID_ORIGIN, SIGNED_OUT, DEFAULT_SETTINGS,
    normalizeSettings, withinActiveHours, shortDeviceName, summarizeLicenses, nextAlignedTime,
  };
}
