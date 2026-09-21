// Bundled by scripts/build-monaco.mjs into public/vendor/monaco/. Only the
// editor core plus the few features a read-only reader uses (find widget,
// copy, go-to-line): no language packs, no TypeScript/JSON/CSS workers.
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";

self.MonacoEnvironment = { getWorker: () => new Worker("/vendor/monaco/editor.worker.js") };
window.monaco = monaco;
