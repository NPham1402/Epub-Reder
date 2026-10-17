"use strict";
// Offline reading. Two caches:
//   SHELL — the app's own files. The page itself (navigations) is
//     network-first, so an online load always gets the current build; its
//     asset URLs carry the build id (?v=..., stamped by the server), so the
//     JS/CSS they point at are new URLs too and can be served cache-first
//     (stale-while-revalidate) without ever showing an old build. Offline,
//     the last cached page and its assets are used.
//   DATA  — the three GET endpoints that make up "a book" (list, a book's
//     index, one chapter's text): network-first, falling back to the last
//     good copy when there is no network. Every other endpoint (settings,
//     highlights, bookmarks, search, stats, uploads, auth, export, ...) is
//     left alone — some already have their own offline retry queue
//     (sync.js), and caching a write or a stale search result would be
//     actively misleading rather than helpful.
//
// Bumping is no longer needed per deploy (asset URLs are versioned); only if
// the cache layout itself changes.
const SHELL_CACHE = "epub-reader-shell-v10";
const DATA_CACHE = "epub-reader-data-v1";
const KEEP = new Set([SHELL_CACHE, DATA_CACHE]);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) if (!KEEP.has(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

// A logged-out reader must not still be able to read cached book text: the
// page clears both caches directly (Cache Storage is available to the page,
// not just to us) on "Sign out" / "Sign out everywhere" — see app.js.

function cacheableApiGet(pathname) {
  if (pathname === "/api/books") return true;
  return /^\/api\/books\/[^/]+\/(index|chapters\/\d+)$/.test(pathname);
}

async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (!cached) throw err;
    // Same body, marked so the page can tell the reader this is an offline copy.
    const headers = new Headers(cached.headers);
    headers.set("x-from-cache", "1");
    return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
  }
}

// Keeps one copy per file: storing /app.js?v=NEW drops /app.js?v=OLD.
async function putShell(cache, req, res) {
  await cache.put(req, res);
  const url = new URL(req.url);
  if (!url.search) return;
  for (const key of await cache.keys()) {
    const k = new URL(key.url);
    if (k.pathname === url.pathname && k.search !== url.search) await cache.delete(key);
  }
}

async function networkFirstPage(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put("/", res.clone());
    return res;
  } catch {
    return (await cache.match("/")) || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const url = new URL(req.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(req, res.clone());
        return res;
      }
    } catch {}
  }
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res.ok) putShell(cache, req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // never intercept writes — let them fail loudly if offline
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) {
    if (cacheableApiGet(url.pathname)) e.respondWith(networkFirst(req));
    return;
  }
  e.respondWith(req.mode === "navigate" ? networkFirstPage(req) : staleWhileRevalidate(req));
});
