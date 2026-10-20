// Trading sessions in each centre's local time, so daylight-saving shifts are
// handled by the browser's time-zone data rather than fixed UTC offsets.

const SESSIONS = [
  { name: 'Sydney', tz: 'Australia/Sydney', open: 7 * 60, close: 16 * 60 },
  { name: 'Tokyo', tz: 'Asia/Tokyo', open: 9 * 60, close: 18 * 60 },
  { name: 'London', tz: 'Europe/London', open: 8 * 60, close: 17 * 60 },
  { name: 'New York', tz: 'America/New_York', open: 8 * 60, close: 17 * 60 },
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

function sessionOpen(s, date) {
  const { day, min } = local(s.tz, date);
  return day >= 1 && day <= 5 && min >= s.open && min < s.close;
}

// Spot gold: Sunday 18:00 to Friday 17:00 New York time, with a daily 17:00-18:00 break.
function goldOpen(date) {
  const { day, min } = local('America/New_York', date);
  if (day === 6) return false;
  if (day === 0) return min >= 18 * 60;
  if (day === 5) return min < 17 * 60;
  return min < 17 * 60 || min >= 18 * 60;
}

function untilChange(isOpen, now) {
  const state = isOpen(now);
  const step = 5 * 60000;
  for (let t = now.getTime() + step; t < now.getTime() + 4 * 86400000; t += step) {
    if (isOpen(new Date(t)) !== state) {
      const mins = Math.round((t - now.getTime()) / 60000 / 5) * 5;
      const h = Math.floor(mins / 60);
      return `${state ? 'closes' : 'opens'} in ${h ? `${h}h ` : ''}${mins % 60}m`;
    }
  }
  return '';
}

export function initSessions(el) {
  const rows = [
    { name: 'Gold market', isOpen: goldOpen },
    ...SESSIONS.map((s) => ({ name: s.name, isOpen: (d) => sessionOpen(s, d) })),
  ];
  function render() {
    const now = new Date();
    el.innerHTML = rows.map((r) => {
      const open = r.isOpen(now);
      return `<li><span class="${open ? 'open' : 'closed'}">${r.name}</span><span class="when">${untilChange(r.isOpen, now)}</span></li>`;
    }).join('');
  }
  render();
  setInterval(render, 60000);
}
