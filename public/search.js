"use strict";

/* ============================ Global Search ================================= */
// Full-text search across the modules. Each module has to be indexed once (the
// server does it in small batches); new uploads are indexed in the background.
//
// Loaded after insights.js.

const gs = { busy: new Set() };

// Index one module, batch by batch, until the server says it is done.
async function indexBook(bookId, onProgress) {
  if (gs.busy.has(bookId)) return false;
  gs.busy.add(bookId);
  try {
    for (let guard = 0; guard < 2000; guard++) {
      let res = null;
      for (let attempt = 0; attempt < 4 && !res; attempt++) {
        res = await api(`/api/books/${bookId}/search-index`, { method: "POST" }).catch(() => null);
        if (!res) await sleep(800 * (attempt + 1));
      }
      if (!res) return false;
      if (res.status === 409) { await sleep(1000); continue; } // the book is busy (being indexed by upload); try again shortly
      if (!res.ok) return false;
      const d = await res.json();
      if (onProgress) onProgress(d.indexed, d.total);
      if (d.done) return true;
    }
    return false;
  } finally {
    gs.busy.delete(bookId);
  }
}
// After an upload: make the new module searchable without being asked.
function autoIndexNewBook(bookId) {
  if (extEnabled("global-search")) indexBook(bookId).catch(() => {});
}

function renderSearch(body) {
  const statusEl = el("div", "gs-status", "Checking the index…");
  const bar = el("div", "gs-bar");
  const input = el("input", "sv-input gs-input");
  input.placeholder = "Search all modules";
  input.spellcheck = false;
  input.autocomplete = "off";
  const scope = el("select", "lib-sort");
  bar.appendChild(input);
  bar.appendChild(scope);
  const results = el("div", "gs-results");
  body.appendChild(bar);
  body.appendChild(statusEl);
  body.appendChild(results);

  const allOpt = el("option", null, "All modules");
  allOpt.value = "";
  scope.appendChild(allOpt);
  for (const b of state.books) { const o = el("option", null, bookLabel(b)); o.value = b.id; scope.appendChild(o); }

  async function refreshStatus() {
    const res = await api("/api/search/status").catch(() => null);
    if (!res || !res.ok) { statusEl.textContent = "Could not reach the search index."; return; }
    const st = await res.json();
    statusEl.innerHTML = "";
    if (!st.available) { statusEl.textContent = "Search is not available on this server."; input.disabled = true; return; }
    const todo = st.books.filter((b) => b.indexed < b.total);
    if (!todo.length) { statusEl.textContent = `${st.books.length} module${st.books.length === 1 ? "" : "s"} indexed.`; return; }
    statusEl.appendChild(el("span", null, `${st.books.length - todo.length} of ${st.books.length} modules indexed. `));
    const btn = el("button", "xp-btn", "Index now");
    btn.type = "button";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      for (const t of todo) {
        const book = bookById(t.book_id);
        const name = book ? bookLabel(book) : "module";
        const ok = await indexBook(t.book_id, (i, total) => { statusEl.firstChild.textContent = `Indexing ${name} … ${i}/${total} `; });
        if (!ok) { statusEl.textContent = `Could not index ${name}; try again.`; return; }
      }
      refreshStatus();
      if (input.value.trim()) run();
    });
    statusEl.appendChild(btn);
  }

  let seq = 0;
  async function run() {
    const q = input.value.trim();
    const mine = ++seq;
    results.innerHTML = "";
    if (!q) return;
    const res = await api(`/api/search?q=${encodeURIComponent(q)}${scope.value ? `&book=${scope.value}` : ""}`).catch(() => null);
    if (mine !== seq) return; // a newer search is already running
    if (!res || !res.ok) { results.appendChild(el("p", "xp-off", res && res.status === 400 ? "Type at least one word." : "The search failed.")); return; }
    const data = await res.json();
    for (const id of new Set(data.results.map((r) => r.book_id))) { const b = bookById(id); if (b) await loadBookIndex(b); }
    if (mine !== seq) return;
    if (!data.results.length) { results.appendChild(el("p", "xp-off", "No results found. Modules that are not indexed yet are not searched.")); return; }
    results.appendChild(el("div", "gs-count", `${data.results.length} result${data.results.length === 1 ? "" : "s"}`));
    for (const r of data.results) {
      const book = bookById(r.book_id);
      if (!book) continue;
      const ch = book._chapters && book._chapters[r.idx];
      const row = el("div", "gs-row");
      row.appendChild(el("div", "gs-where", `${bookLabel(book)}  ›  ${ch ? displayName(ch) : "file " + r.idx}`));
      const snip = el("div", "gs-snip");
      snip.appendChild(document.createTextNode(r.snippet.slice(0, r.from)));
      snip.appendChild(el("mark", "gs-mark", r.snippet.slice(r.from, r.to)));
      snip.appendChild(document.createTextNode(r.snippet.slice(r.to)));
      row.appendChild(snip);
      row.addEventListener("click", () => {
        state.reveal = { key: tabKey(book.id, r.idx), p: r.p };
        state.expanded.add(book.id);
        renderTree();
        openTab(book.id, r.idx);
      });
      results.appendChild(row);
    }
  }
  let timer = 0;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); run(); } });
  scope.addEventListener("change", run);
  refreshStatus();
  setTimeout(() => input.focus(), 50);
}

registerExtension({
  id: "global-search",
  name: "Global Search",
  version: "1.0.0",
  icon: "search",
  description: "Find text across every module, with or without accents.",
  defaultEnabled: true,
  render: renderSearch,
});
