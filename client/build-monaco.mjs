// Builds the Monaco editor bundle the UI loads lazily from /vendor/monaco/.
// Output is generated (gitignored): run `npm run build:monaco`.
import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";

const out = "public/vendor/monaco";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, minify: true, target: "es2022", legalComments: "none", logLevel: "info" };

await build({
  ...common,
  entryPoints: { monaco: "client/monaco-entry.js" },
  outdir: out,
  format: "iife",
  loader: { ".ttf": "file" },
  assetNames: "[name]-[hash]",
});
await build({
  ...common,
  entryPoints: { "editor.worker": "node_modules/monaco-editor/esm/vs/editor/editor.worker.js" },
  outdir: out,
  format: "iife",
});
