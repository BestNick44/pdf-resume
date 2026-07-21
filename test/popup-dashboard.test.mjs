import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createPopupApp } from "../popup/popup-app.mjs";
import { createPopupView } from "../popup/popup-view.mjs";
import { createBooksStorage } from "../storage/books.mjs";
import { createChromeExtensionFake } from "./support/chrome-extension-fake.mjs";
import { createPopupDocumentFake } from "./support/popup-dom-fake.mjs";

const BOOK_URL = "file:///Users/reader/Books/A%20Book.pdf";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const TAB_ID = 7;
const VIEWER_URL = `chrome-extension://${EXTENSION_ID}/viewer.html?file=${encodeURIComponent(BOOK_URL)}`;

function canonicalRecord(overrides = {}) {
  return {
    title: "Metadata title",
    customTitle: null,
    totalPages: 123,
    currentPage: 45,
    scrollTop: 6789,
    addedAt: 1_800_000_000,
    lastReadAt: 1_800_000_100,
    ...overrides,
  };
}

function createViewSpy() {
  const calls = [];
  let renameHandler;
  let untrackHandler;
  return {
    calls,
    rename(customTitle) {
      return renameHandler?.(customTitle);
    },
    setActivationHandler() {},
    setOpenBookHandler() {},
    setRenameHandler(handler) {
      renameHandler = handler;
    },
    setUntrackHandler(handler) {
      untrackHandler = handler;
    },
    untrack() {
      return untrackHandler?.();
    },
    showError(details) {
      calls.push(["error", details]);
    },
    showIneligible() {
      calls.push(["ineligible"]);
    },
    showLoading() {
      calls.push(["loading"]);
    },
    showRemoved(details) {
      calls.push(["removed", details]);
    },
    showTracked(details) {
      calls.push(["tracked", details]);
    },
  };
}

function createHarness({
  book = canonicalRecord(),
  fileSchemeAccessAllowed = true,
  tabUrl = VIEWER_URL,
  view = createViewSpy(),
} = {}) {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: { books: { [BOOK_URL]: book } },
    tabs: [{ id: TAB_ID, url: tabUrl }],
  });
  const books = createBooksStorage({
    storageArea: fake.chrome.storage.local,
    lockManager: fake.locks,
    now: () => 1_800_000_200,
  });
  let fileSchemeAccessChecks = 0;
  const app = createPopupApp({
    view,
    async isFileSchemeAccessAllowed() {
      fileSchemeAccessChecks += 1;
      return fileSchemeAccessAllowed;
    },
    queryActiveTab: (query) => fake.chrome.tabs.query(query),
    getTab: (tabId) => fake.chrome.tabs.get(tabId),
    updateTab: (tabId, properties) => fake.chrome.tabs.update(tabId, properties),
    getRuntimeUrl: (path) => fake.chrome.runtime.getURL(path),
    getBook: books.getBook,
    listBooks: books.listBooks,
    removeBook: books.removeBook,
    trackBook: books.trackBook,
    updateCustomTitle: books.updateCustomTitle,
  });
  return {
    app,
    books,
    fake,
    get fileSchemeAccessChecks() {
      return fileSchemeAccessChecks;
    },
    view,
  };
}

test("tracked local PDF and viewer popups preserve the dashboard while requesting file access", async (t) => {
  for (const [name, tabUrl] of [
    ["local PDF", BOOK_URL],
    ["extension viewer", VIEWER_URL],
  ]) {
    await t.test(name, async () => {
      const { elements, hostDocument } = createPopupDocumentFake();
      const harness = createHarness({
        book: canonicalRecord({ customTitle: "Reader name" }),
        fileSchemeAccessAllowed: false,
        tabUrl,
        view: createPopupView({ hostDocument }),
      });

      await harness.app.start();

      assert.equal(harness.fileSchemeAccessChecks, 1);
      assert.equal(elements["#popupStatus"].textContent, "File access required");
      assert.equal(elements["#bookFilename"].textContent, "Reader name");
      assert.equal(elements["#trackedDashboard"].hidden, false);
      assert.equal(elements["#pageSummary"].textContent, "Page 45 of 123");
      assert.equal(elements["#pagesRemaining"].textContent, "78 pages remaining");
      assert.equal(elements["#progressPercent"].textContent, "37%");
      assert.equal(elements["#customTitle"].value, "Reader name");
      assert.equal(elements["#untrackButton"].disabled, false);
      assert.equal(elements["#fileAccessInstructions"].hidden, false);
      assert.equal(elements["#trackButton"].hidden, true);
    });
  }
});

test("tracked viewer tab shows its title and reading progress", async () => {
  const harness = createHarness({ book: canonicalRecord({ customTitle: "Reader name" }) });

  await harness.app.start();

  assert.deepEqual(harness.view.calls, [
    ["loading"],
    [
      "tracked",
      {
        title: "Reader name",
        customTitle: "Reader name",
        currentPage: 45,
        totalPages: 123,
        pagesRemaining: 78,
        progressPercent: 37,
      },
    ],
  ]);
});

test("renaming a tracked book durably saves and displays its custom title", async () => {
  const harness = createHarness();
  await harness.app.start();

  await harness.view.rename("  Reader name  ");

  assert.equal(harness.fake.storageFake.snapshot().books[BOOK_URL].customTitle, "Reader name");
  assert.deepEqual(harness.view.calls.at(-1), [
    "tracked",
    {
      title: "Reader name",
      customTitle: "Reader name",
      currentPage: 45,
      totalPages: 123,
      pagesRemaining: 78,
      progressPercent: 37,
      status: "Title saved.",
    },
  ]);
});

test("failed rename remains tracked and can be retried", async () => {
  const existing = canonicalRecord();
  const harness = createHarness({ book: existing });
  await harness.app.start();
  harness.fake.storageFake.failNext("set", new Error("quota exceeded"));

  await harness.view.rename("Reader name");

  assert.deepEqual(harness.fake.storageFake.snapshot().books[BOOK_URL], existing);
  assert.deepEqual(harness.view.calls.at(-1), [
    "tracked",
    {
      title: "Metadata title",
      customTitle: null,
      currentPage: 45,
      totalPages: 123,
      pagesRemaining: 78,
      progressPercent: 37,
      error: "The title could not be saved. Try again.",
      status: "Unable to save title",
    },
  ]);

  await harness.view.rename("Reader name");
  assert.equal(harness.fake.storageFake.snapshot().books[BOOK_URL].customTitle, "Reader name");
  assert.equal(harness.view.calls.at(-1)[1].status, "Title saved.");
});

test("rename after another context untracks the book never recreates it or claims success", async () => {
  const harness = createHarness();
  await harness.app.start();
  await harness.books.removeBook(BOOK_URL);
  const writesAfterUntrack = harness.fake.storageFake.operations.filter(
    ({ method, phase }) => method === "set" && phase === "start",
  ).length;

  await harness.view.rename("Reader name");

  assert.deepEqual(harness.fake.storageFake.snapshot(), { books: {} });
  assert.equal(
    harness.fake.storageFake.operations.filter(
      ({ method, phase }) => method === "set" && phase === "start",
    ).length,
    writesAfterUntrack,
  );
  assert.deepEqual(harness.view.calls.at(-1), [
    "removed",
    { title: "Metadata title", message: "This book is no longer tracked." },
  ]);
});

test("untracking durably removes the book without navigating the active tab", async () => {
  const harness = createHarness({ book: canonicalRecord({ customTitle: "Reader name" }) });
  await harness.app.start();

  await harness.view.untrack();

  assert.equal(Object.hasOwn(harness.fake.storageFake.snapshot().books, BOOK_URL), false);
  assert.equal(harness.fake.snapshotTab(TAB_ID).url, VIEWER_URL);
  assert.deepEqual(harness.view.calls.at(-1), [
    "removed",
    { title: "Reader name", message: "This book is no longer tracked." },
  ]);
});

test("tracked dashboard renders accessible progress, rename, and Untrack controls", async () => {
  const { elements, hostDocument } = createPopupDocumentFake();
  const view = createPopupView({ hostDocument });
  const renames = [];
  let untracks = 0;
  view.setRenameHandler((customTitle) => renames.push(customTitle));
  view.setUntrackHandler(() => {
    untracks += 1;
  });

  view.showTracked({
    title: "Reader name",
    customTitle: "Reader name",
    currentPage: 45,
    totalPages: 123,
    pagesRemaining: 78,
    progressPercent: 37,
  });

  assert.equal(elements["#bookFilename"].textContent, "Reader name");
  assert.equal(elements["#pageSummary"].textContent, "Page 45 of 123");
  assert.equal(elements["#pagesRemaining"].textContent, "78 pages remaining");
  assert.equal(elements["#progressBar"].value, 37);
  assert.equal(elements["#progressBar"].max, 100);
  assert.equal(elements["#progressPercent"].textContent, "37%");
  assert.equal(elements["#customTitle"].value, "Reader name");
  elements["#customTitle"].value = "New name";
  assert.equal(elements["#renameForm"].submit(), true);
  elements["#untrackButton"].click();
  assert.deepEqual(renames, ["New name"]);
  assert.equal(untracks, 1);

  const popupHtml = await readFile(new URL("../popup/popup.html", import.meta.url), "utf8");
  assert.match(popupHtml, /<progress id="progressBar"[^>]+max="100"/);
  assert.match(popupHtml, /<label for="customTitle">Custom title<\/label>/);
  assert.match(popupHtml, /<button id="untrackButton"[^>]+type="button"/);
});
