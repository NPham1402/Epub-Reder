// Reading-time statistics: durations only, batched by the UI.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, cleanup, login, api, type TestServer } from "./helpers.ts";

type Stats = {
  daily: { day: string; seconds: number }[];
  hourly: { hour: number; seconds: number }[];
  per_book: { book_id: string; seconds: number }[];
};

describe("reading time statistics", () => {
  let srv: TestServer;
  let cookie: string;
  before(async () => { srv = await startServer(); cookie = await login(srv.base); });
  after(async () => { await srv.stop(); cleanup(srv.dataDir); });

  const ping = (pings: unknown) => api(srv.base, cookie, "/api/stats/ping", {
    method: "POST", body: JSON.stringify({ pings }), headers: { "content-type": "application/json" },
  });
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  test("pings add up per day, hour and book", async () => {
    assert.equal((await ping([
      { book_id: "b1", day: day(-1), hour: 21, seconds: 600 },
      { book_id: "b1", day: day(-1), hour: 22, seconds: 300 },
      { book_id: "b2", day: day(0), hour: 9, seconds: 120 },
    ])).status, 200);
    await ping([{ book_id: "b1", day: day(-1), hour: 21, seconds: 60 }]); // same slot again: adds

    const s = (await (await api(srv.base, cookie, "/api/stats")).json()) as Stats;
    assert.deepEqual(s.daily, [{ day: day(-1), seconds: 960 }, { day: day(0), seconds: 120 }]);
    assert.deepEqual(s.hourly, [{ hour: 9, seconds: 120 }, { hour: 21, seconds: 660 }, { hour: 22, seconds: 300 }]);
    assert.deepEqual(s.per_book, [{ book_id: "b1", seconds: 960 }, { book_id: "b2", seconds: 120 }]);
  });

  test("old activity falls outside the requested window", async () => {
    await ping([{ book_id: "b3", day: "2020-01-01", hour: 1, seconds: 500 }]);
    const s = (await (await api(srv.base, cookie, "/api/stats?days=30")).json()) as Stats;
    assert.ok(!s.per_book.some((b) => b.book_id === "b3"));
    const all = (await (await api(srv.base, cookie, "/api/stats?days=732")).json()) as Stats;
    assert.ok(!all.daily.some((d) => d.day === "2020-01-01"), "capped at two years");
  });

  test("bad input is refused; the endpoints need a session", async () => {
    for (const bad of [
      [], "x", [{ book_id: "b", day: "yesterday", hour: 1, seconds: 5 }], [{ book_id: "b", day: day(0), hour: 24, seconds: 5 }],
      [{ book_id: "b", day: day(0), hour: 1, seconds: 0 }], [{ book_id: "b", day: day(0), hour: 1, seconds: 99999 }],
      [{ book_id: "", day: day(0), hour: 1, seconds: 5 }], Array.from({ length: 201 }, () => ({ book_id: "b", day: day(0), hour: 1, seconds: 1 })),
    ]) assert.equal((await ping(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    assert.equal((await fetch(`${srv.base}/api/stats`)).status, 401);
    assert.equal((await fetch(`${srv.base}/api/stats/ping`, { method: "POST" })).status, 401);
  });
});
