// Trading sessions in each centre's local time, so daylight saving is handled
// by the browser's time-zone data rather than fixed UTC offsets.

const SESSIONS = [
  { id: 'syd', name: 'Sydney', tz: 'Australia/Sydney', open: 7 * 60, close: 16 * 60 },
  { id: 'tok', name: 'Tokyo', tz: 'Asia/Tokyo', open: 9 * 60, close: 18 * 60 },
  { id: 'ldn', name: 'London', tz: 'Europe/London', open: 8 * 60, close: 17 * 60, kill: [8 * 60, 11 * 60] },
  { id: 'ny', name: 'New York', tz: 'America/New_York', open: 8 * 60, close: 17 * 60, kill: [8 * 60 + 30, 11 * 60 + 30] },
];

const DAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
const formatters = new Map();

function local(tz, date) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return { day: DAYS[parts.weekday], min: (+parts.hour % 24) * 60 + +parts.minute };
}

// Spot gold: Sunday 18:00 to Friday 17:00 New York time, with a daily 17:00-18:00 break.
export function goldOpen(date = new Date()) {
  const { day, min } = local('America/New_York', date);
  if (day === 6) return false;
  if (day === 0) return min >= 18 * 60;
  if (day === 5) return min < 17 * 60;
  return min < 17 * 60 || min >= 18 * 60;
}

// [{ id, name, open, killzone }]: killzone = the first hours of London or New York.
export function sessionsNow(date = new Date()) {
  return SESSIONS.map((s) => {
    const { day, min } = local(s.tz, date);
    const weekday = day >= 1 && day <= 5;
    const open = weekday && min >= s.open && min < s.close;
    const killzone = !!(open && s.kill && min >= s.kill[0] && min < s.kill[1]);
    return { id: s.id, name: s.name, open, killzone };
  });
}
