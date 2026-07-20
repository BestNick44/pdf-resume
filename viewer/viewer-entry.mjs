import { startViewerApp } from "./viewer-app.mjs";

if (globalThis.window && globalThis.document) {
  await startViewerApp();
}
