const { db } = require('./db');

// ---------- Business calendar (BRD 7.4: business hours + holiday calendar) ----------
// Business hours live in settings key 'business_hours' as JSON:
//   { days: [1,2,3,4,5], start: '09:00', end: '18:00' }  (days: 0=Sun .. 6=Sat, UTC-naive)
// Defaults are admin-editable; values pending formal customer approval.

const DEFAULT_HOURS = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };

function getBusinessHours() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'business_hours'").get();
  if (!row) return DEFAULT_HOURS;
  try {
    const parsed = JSON.parse(row.value);
    if (Array.isArray(parsed.days) && parsed.start && parsed.end) return parsed;
  } catch { /* fall through to default */ }
  return DEFAULT_HOURS;
}

function setBusinessHours(hours) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('business_hours', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(JSON.stringify(hours));
}

// ---------- SQLite timestamp helpers ----------
// DB stores UTC 'YYYY-MM-DD HH:MM:SS' (no timezone suffix).
function fromSql(text) {
  if (!text) return null;
  return new Date(`${text.replace(' ', 'T')}Z`);
}

function toSql(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function nowSql() { return toSql(new Date()); }

function dateKey(date) { return date.toISOString().slice(0, 10); }

function isHoliday(date) {
  return !!db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(dateKey(date));
}

function parseHm(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Minutes-into-day for a UTC date.
function minuteOfDay(date) { return date.getUTCHours() * 60 + date.getUTCMinutes(); }

function isBusinessDay(date, hours) {
  return hours.days.includes(date.getUTCDay()) && !isHoliday(date);
}

// Advance `minutes` of business time from `start`, skipping non-business
// days/holidays and out-of-hours periods. Iterates day by day.
function addBusinessMinutes(start, minutes) {
  const hours = getBusinessHours();
  const dayStart = parseHm(hours.start);
  const dayEnd = parseHm(hours.end);
  const perDay = Math.max(dayEnd - dayStart, 1);

  let remaining = minutes;
  let cursor = new Date(start.getTime());

  for (let guard = 0; guard < 3660; guard++) {
    if (isBusinessDay(cursor, hours)) {
      let mod = minuteOfDay(cursor);
      if (mod < dayStart) mod = dayStart;
      if (mod < dayEnd) {
        const available = dayEnd - mod;
        if (remaining <= available) {
          const result = new Date(cursor.getTime());
          result.setUTCHours(0, 0, 0, 0);
          result.setUTCMinutes(mod + remaining);
          return result;
        }
        remaining -= available;
      }
    }
    // jump to start of next day
    cursor = new Date(cursor.getTime());
    cursor.setUTCHours(0, 0, 0, 0);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCMinutes(parseHm(getBusinessHours().start) - 1); // positioned before opening
  }
  // Guard bail-out (~10 years of days): fall back to plain time
  return new Date(start.getTime() + minutes * 60000);
}

function addPlainMinutes(start, minutes) {
  return new Date(start.getTime() + minutes * 60000);
}

module.exports = {
  getBusinessHours, setBusinessHours, addBusinessMinutes, addPlainMinutes,
  fromSql, toSql, nowSql, dateKey, DEFAULT_HOURS,
};
