import {
  getBook,
  removeBook,
  trackBook,
  updateCustomTitle,
} from "../storage/books.mjs";
import { createPopupApp } from "./popup-app.mjs";
import { createPopupView } from "./popup-view.mjs";

const tabs = globalThis.chrome.tabs;
const runtime = globalThis.chrome.runtime;
const app = createPopupApp({
  queryActiveTab: (query) => tabs.query(query),
  getTab: (tabId) => tabs.get(tabId),
  updateTab: (tabId, updateProperties) => tabs.update(tabId, updateProperties),
  getRuntimeUrl: (path) => runtime.getURL(path),
  getBook,
  removeBook,
  trackBook,
  updateCustomTitle,
  view: createPopupView(),
});

void app.start();
globalThis.addEventListener("pagehide", () => app.destroy(), { once: true });
