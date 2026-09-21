"use strict";

/* ============================ Activity Insights ============================= */
// Records how long the window is actively in front of the reader (durations
// only, never any text) and shows it as a contribution-style heat map.
// "Actively" = tab visible, cover screen off, and input within the last minute.
//
// Loaded after sync.js.

const act = { pending: new Map(), tickId: 0, flushId: 0 };
const pad2 = (n) => String(n).padStart(2, "0");
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function actTick() {
  if (document.hidden || panicVisible || !state.current) return;
  if (Date.now() - timer.lastActive > 60000) return; // no input for a minute: not reading right now
  const now = new Date();
  const key = `${localDay(now)}|${now.getHours()}|${state.current.bookId}`;
  act.pending.set(key, (act.pending.get(key) || 0) + 1);
}
function pendingPings() {
  return [...act.pending].map(([k, seconds]) => {
    const [day, hour, book_id] = k.split("|");
    return { day, hour: Number(hour), book_id, seconds };
  });
}
async function actFlush() {
  const pings = pendingPings().slice(0, 200);
  if (!pings.length) return;
  const res = await syncFetch("/api/stats/ping", { method: "POST", body: JSON.stringify({ pings }) });
  if (res && (res.ok || res.status === 400)) for (const p of pings) act.pending.delete(`${p.day}|${p.hour}|${p.book_id}`);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden" || !extEnabled("insights")) return;
  const pings = pendingPings().slice(0, 200);
  if (!pings.length) return;
  try {
    if (navigator.sendBeacon("/api/stats/ping", new Blob([JSON.stringify({ pings })], { type: "application/json" }))) {
      for (const p of pings) act.pending.delete(`${p.day}|${p.hour}|${p.book_id}`);
    }
  } catch { /* keep them for the next flush */ }
});
function insightsStart() {
  if (act.tickId) return;
  act.tickId = setInterval(actTick, 1000);
  act.flushId = setInterval(actFlush, 60000);
}
function insightsStop() {
  clearInterval(act.tickId);
  clearInterval(act.flushId);
  act.tickId = act.flushId = 0;
  act.pending.clear();
}

/* ---- Page -------------------------------------------------------------------- */
function fmtDuration(sec) {
  if (sec < 60) return sec > 0 ? "<1 min" : "0 min";
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad2(m % 60)} min`;
}
const levelOf = (sec) => { const m = sec / 60; return m <= 0 ? 0 : m < 10 ? 1 : m < 30 ? 2 : m < 60 ? 3 : 4; };

// Consecutive days with at least a minute of activity. `current` may end today
// or yesterday (today isn't over yet).
function computeStreaks(byDay, today) {
  const has = (d) => (byDay.get(localDay(d)) || 0) >= 60;
  let current = 0;
  const d = new Date(today);
  if (!has(d)) d.setDate(d.getDate() - 1);
  while (has(d)) { current++; d.setDate(d.getDate() - 1); }
  let longest = 0, run = 0;
  const days = [...byDay.keys()].sort();
  let prev = null;
  for (const k of days) {
    if ((byDay.get(k) || 0) < 60) { run = 0; prev = null; continue; }
    const t = new Date(k + "T00:00:00");
    run = prev && Math.round((t - prev) / 86400000) === 1 ? run + 1 : 1;
    prev = t;
    longest = Math.max(longest, run);
  }
  return { current, longest };
}

async function renderInsights(body) {
  body.appendChild(el("p", "xp-off", "Loading…"));
  const res = await syncFetch("/api/stats?days=371");
  body.innerHTML = "";
  if (!res || !res.ok) { body.appendChild(el("p", "xp-off", "Could not load the activity data.")); return; }
  const stats = await res.json();
  const byDay = new Map(stats.daily.map((d) => [d.day, d.seconds]));
  const today = new Date();
  const sumBack = (n) => { let s = 0; const d = new Date(today); for (let i = 0; i < n; i++) { s += byDay.get(localDay(d)) || 0; d.setDate(d.getDate() - 1); } return s; };
  const total = stats.daily.reduce((s, d) => s + d.seconds, 0);
  const { current, longest } = computeStreaks(byDay, today);
  let busiest = null;
  for (const d of stats.daily) if (!busiest || d.seconds > busiest.seconds) busiest = d;

  body.appendChild(el("div", "in-total", `${fmtDuration(total)} of focused time in the last year`));

  // Heat map: 53 week-columns, Sunday on top, the last column ends today.
  const grid = el("div", "hm-grid");
  const start = new Date(today);
  start.setDate(start.getDate() - (52 * 7 + today.getDay()));
  const months = el("div", "hm-months");
  let lastMonth = -1;
  for (let w = 0; w < 53; w++) {
    const first = new Date(start);
    first.setDate(first.getDate() + w * 7);
    const label = el("span", null, first.getMonth() !== lastMonth && first.getDate() <= 7 ? first.toLocaleString("en", { month: "short" }) : "");
    if (label.textContent) lastMonth = first.getMonth();
    months.appendChild(label);
  }
  for (let w = 0; w < 53; w++) for (let dow = 0; dow < 7; dow++) {
    const d = new Date(start);
    d.setDate(d.getDate() + w * 7 + dow);
    if (d > today) { grid.appendChild(el("span", "hm-cell hm-none")); continue; }
    const sec = byDay.get(localDay(d)) || 0;
    const cell = el("span", "hm-cell hm-" + levelOf(sec));
    cell.title = `${localDay(d)}: ${sec ? fmtDuration(sec) : "no activity"}`;
    grid.appendChild(cell);
  }
  const wrap = el("div", "hm-wrap");
  wrap.appendChild(months);
  wrap.appendChild(grid);
  body.appendChild(wrap);
  const legend = el("div", "hm-legend");
  legend.appendChild(el("span", null, "Less"));
  for (let l = 0; l <= 4; l++) legend.appendChild(el("span", "hm-cell hm-" + l));
  legend.appendChild(el("span", null, "More"));
  body.appendChild(legend);

  const cards = el("div", "in-cards");
  const card = (label, value) => { const c = el("div", "in-card"); c.appendChild(el("div", "in-val", value)); c.appendChild(el("div", "in-lab", label)); cards.appendChild(c); };
  card("Today", fmtDuration(byDay.get(localDay(today)) || 0));
  card("Last 7 days", fmtDuration(sumBack(7)));
  card("Last 30 days", fmtDuration(sumBack(30)));
  card("Current streak", `${current} day${current === 1 ? "" : "s"}`);
  card("Longest streak", `${longest} day${longest === 1 ? "" : "s"}`);
  card("Busiest day", busiest ? `${busiest.day} · ${fmtDuration(busiest.seconds)}` : "—");
  body.appendChild(cards);

  // Hours of the day
  const perHour = Array.from({ length: 24 }, (_, h) => (stats.hourly.find((x) => x.hour === h) || { seconds: 0 }).seconds);
  const max = Math.max(1, ...perHour);
  const hist = el("div", "hr-hist");
  perHour.forEach((s, h) => {
    const col = el("div", "hr-col");
    const bar = el("div", "hr-bar");
    bar.style.height = Math.round((s / max) * 100) + "%";
    bar.title = `${pad2(h)}:00  ·  ${fmtDuration(s)}`;
    col.appendChild(bar);
    col.appendChild(el("span", "hr-lab", h % 3 === 0 ? String(h) : ""));
    hist.appendChild(col);
  });
  body.appendChild(el("h3", "in-h", "Peak hours"));
  const peak = perHour.map((s, h) => [s, h]).sort((a, b) => b[0] - a[0]).filter((x) => x[0] > 0).slice(0, 3).map((x) => `${pad2(x[1])}:00`);
  body.appendChild(el("div", "in-sub", peak.length ? `Most active around ${peak.join(", ")}` : "Not enough activity yet."));
  body.appendChild(hist);

  // Modules by time
  body.appendChild(el("h3", "in-h", "Modules by time"));
  const list = el("div", "in-books");
  for (const b of stats.per_book.slice(0, 5)) {
    const book = bookById(b.book_id);
    const row = el("div", "in-book");
    row.appendChild(el("span", "in-book-name", book ? bookLabel(book) : "(removed module)"));
    row.appendChild(el("span", "in-book-time", fmtDuration(b.seconds)));
    list.appendChild(row);
  }
  if (!stats.per_book.length) list.appendChild(el("div", "in-sub", "Nothing recorded yet."));
  body.appendChild(list);
}

registerExtension({
  id: "insights",
  name: "Activity Insights",
  version: "1.0.0",
  icon: "graph",
  description: "Shows when and for how long you have been working, as a contribution graph.",
  defaultEnabled: true,
  onEnable: insightsStart,
  onDisable: insightsStop,
  render: renderInsights,
});
if (extEnabled("insights")) insightsStart();
