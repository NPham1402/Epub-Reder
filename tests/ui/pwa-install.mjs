// Manifest + icons that let Edge/Chrome offer "Install app" on Windows. Checked
// via the same CDP call Chrome itself uses to read a page's manifest, plus the
// asset responses the browser would fetch.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, cleanup, PASSCODE } from "../helpers.ts";

const SHOTS = join(tmpdir(), "epub-ui-shots");
mkdirSync(SHOTS, { recursive: true });
const srv = await startServer();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e));
page.on("dialog", (d) => d.accept());
let failed = 0;
const check = (label, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra !== "" ? "  -> " + extra : ""}`); };

try {
  await page.goto(srv.base);
  await page.fill("#login-pass", PASSCODE);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#app:not([hidden])");

  // The link tag Chrome/Edge look for to find the manifest at all.
  const href = await page.getAttribute('link[rel="manifest"]', "href");
  check("index.html links a manifest", href === "/manifest.webmanifest", href);
  check("theme-color meta tag is present", (await page.getAttribute('meta[name="theme-color"]', "content")) !== null);

  // Fetch and validate the manifest exactly like a browser would.
  const res = await page.request.get(`${srv.base}/manifest.webmanifest`);
  check("manifest.webmanifest is served with the right content type", (res.headers()["content-type"] || "").includes("manifest+json"), res.headers()["content-type"]);
  const manifest = await res.json();
  check("name/short_name/description stay in character (no book/reader/EPUB wording)",
    !/epub|ebook|sách|truyện|reader/i.test(JSON.stringify([manifest.name, manifest.short_name, manifest.description])),
    JSON.stringify([manifest.name, manifest.short_name, manifest.description]));
  check("display is standalone (opens as its own window, no address bar)", manifest.display === "standalone");
  check("start_url and scope are set", manifest.start_url === "/" && manifest.scope === "/");
  const sizes = (manifest.icons || []).map((i) => i.sizes);
  check("a 192x192 and a 512x512 icon are declared (Chrome's installability minimum)", sizes.includes("192x192") && sizes.includes("512x512"), sizes.join(","));
  check("a maskable icon is offered for platforms that need one", (manifest.icons || []).some((i) => i.purpose === "maskable"));

  check("window-controls-overlay is requested, with standalone as the fallback",
    Array.isArray(manifest.display_override) && manifest.display_override[0] === "window-controls-overlay" && manifest.display === "standalone",
    JSON.stringify(manifest.display_override));

  // Overlay mode itself can't be entered headlessly, so check what it would do:
  // without the mode nothing changes; with it (real env() values stood in for
  // by a 138px native-buttons strip and a 33px OS bar) the shared bar keeps
  // clear of the real buttons and drops its look-alike ones.
  const css = await (await page.request.get(`${srv.base}/styles.css`)).text();
  const at = css.indexOf("@media (display-mode: window-controls-overlay)");
  let block = "";
  if (at >= 0) {
    let depth = 0, i = css.indexOf("{", at);
    const start = i + 1;
    for (; i < css.length; i++) { if (css[i] === "{") depth++; else if (css[i] === "}" && --depth === 0) break; }
    block = css.slice(start, i);
  }
  check("stylesheet has an overlay-mode block", block.includes(".tb-win"), block.length + " chars");
  const bar = () => page.evaluate(() => {
    const t = document.querySelector(".titlebar"), r = t.getBoundingClientRect();
    const s = getComputedStyle(t);
    const win = getComputedStyle(document.querySelector(".tb-win")).display;
    const gear = document.querySelector("#btn-settings").getBoundingClientRect();
    return { h: Math.round(r.height), pr: parseFloat(s.paddingRight), win, gearRight: Math.round(gear.right), overflow: t.scrollWidth > t.clientWidth, w: innerWidth };
  });
  const normal = await bar();
  check("outside overlay mode the title bar is unchanged", normal.h === 30 && normal.win !== "none" && normal.pr === 8, JSON.stringify(normal));
  const sim = block.replace(/env\(titlebar-area-height,[^)]*\)/, "33px")
    .replace(/env\(titlebar-area-x,[^)]*\)/g, "0px")
    .replace(/env\(titlebar-area-width,[^)]*\)/, "calc(100vw - 138px)");
  await page.addStyleTag({ content: sim });
  const wco = await bar();
  check("overlay mode: bar takes the OS bar's height", wco.h === 33, JSON.stringify(wco));
  check("overlay mode: our look-alike min/max/close are gone", wco.win === "none");
  check("overlay mode: our buttons stay clear of the real ones", wco.gearRight <= wco.w - 138 && wco.pr >= 138, `gearRight=${wco.gearRight} of ${wco.w}`);
  check("overlay mode: nothing overflows the bar", !wco.overflow);
  await page.screenshot({ path: join(SHOTS, "wco-sim.png"), clip: { x: 0, y: 0, width: 1366, height: 60 } });
  await page.reload();
  await page.waitForSelector("#app:not([hidden])");

  // Chrome parses the manifest through this exact call; a non-empty errors[]
  // means Chrome itself would reject or warn about it.
  const cdp = await page.context().newCDPSession(page);
  const parsed = await cdp.send("Page.getAppManifest");
  check("Chrome's own manifest parser reports no errors", (parsed.errors || []).length === 0, JSON.stringify(parsed.errors));

  // Every declared icon file actually exists and is a real PNG of a sane size.
  for (const icon of manifest.icons) {
    const r = await page.request.get(`${srv.base}${icon.src}`);
    const buf = Buffer.from(await r.body());
    const isPng = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    check(`${icon.src} is a real PNG of a sane size`, r.status() === 200 && isPng && buf.length > 500 && buf.length < 200_000, `status=${r.status()} png=${isPng} bytes=${buf.length}`);
  }

  // Switching color theme keeps the installed-app title-bar color in sync.
  await page.click('.ab-icon[data-view="extensions"]');
  await page.locator("#ext-list .ext-item", { hasText: "Color Themes" }).click();
  const before = await page.getAttribute('meta[name="theme-color"]', "content");
  await page.locator(".theme-row", { hasText: "Light+" }).click();
  const after = await page.getAttribute('meta[name="theme-color"]', "content");
  check("theme-color follows the color theme", after !== before, `${before} -> ${after}`);
} catch (e) {
  failed++;
  console.log("FAIL  exception: " + e);
}
console.log("\nconsole problems:", problems.length ? "\n  " + problems.slice(0, 10).join("\n  ") : "none");
await browser.close(); await srv.stop(); cleanup(srv.dataDir);
process.exit(failed ? 1 : 0);
