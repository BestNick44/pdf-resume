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
  let completionHandler;
  let renameHandler;
  let switchBooksHandler;
  let untrackHandler;
  return {
    calls,
    changeCompletion() {
      return completionHandler?.();
    },
    rename(customTitle) {
      return renameHandler?.(customTitle);
    },
    setActivationHandler() {},
    setCompletionHandler(handler) {
      completionHandler = handler;
    },
    setOpenBookHandler() {},
    setRenameHandler(handler) {
      renameHandler = handler;
    },
    setSwitchBooksHandler(handler) {
      switchBooksHandler = handler;
    },
    setUntrackHandler(handler) {
      untrackHandler = handler;
    },
    switchBooks() {
      return switchBooksHandler?.();
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
    showLibrary(details) {
      calls.push(["library", details]);
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
  completedAt,
  fileSchemeAccessAllowed = true,
  tabUrl = VIEWER_URL,
  view = createViewSpy(),
} = {}) {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage: {
      books: { [BOOK_URL]: book },
      ...(completedAt === undefined
        ? {}
        : { completedBooks: { [BOOK_URL]: completedAt } }),
    },
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
    completeBook: books.completeBook,
    getBookWithCompletion: books.getBookWithCompletion,
    listBooksWithCompletion: books.listBooksWithCompletion,
    markBookReading: books.markBookReading,
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

test("tracked dashboard treats a stale-low total as unavailable", async () => {
  const { elements, hostDocument } = createPopupDocumentFake();
  const harness = createHarness({
    book: canonicalRecord({ currentPage: 12, totalPages: 7 }),
    view: createPopupView({ hostDocument }),
  });

  await harness.app.start();

  assert.equal(elements["#pageSummary"].textContent, "Page 12 of —");
  assert.equal(elements["#pagesRemaining"].textContent, "Page count unavailable");
  assert.equal(elements["#progressBar"].hidden, true);
  assert.equal(elements["#progressPercent"].textContent, "Progress unavailable");
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

test("reopening a completed book preserves completion until it is moved to reading", async () => {
  const harness = createHarness({ completedAt: 1_800_000_150 });

  await harness.app.start();

  assert.equal(harness.view.calls.at(-1)[1].completionAction, "reading");
  assert.equal(harness.fake.storageFake.snapshot().completedBooks[BOOK_URL], 1_800_000_150);
});

test("switching books from a tracked dashboard displays the existing library", async () => {
  const harness = createHarness({ book: canonicalRecord({ customTitle: "Reader name" }) });
  await harness.app.start();

  await harness.view.switchBooks();

  assert.deepEqual(harness.view.calls.at(-1), [
    "library",
    {
      books: [
        {
          fileUrl: BOOK_URL,
          title: "Reader name",
          currentPage: 45,
          totalPages: 123,
          progressPercent: 37,
        },
      ],
    },
  ]);
});

test("a final-page book can move to completed and back to reading", async () => {
  const harness = createHarness({ book: canonicalRecord({ currentPage: 123 }) });
  await harness.app.start();

  assert.equal(harness.view.calls.at(-1)[1].completionAction, "complete");
  await harness.view.changeCompletion();

  assert.deepEqual(harness.fake.storageFake.snapshot().completedBooks, {
    [BOOK_URL]: 1_800_000_200,
  });
  assert.deepEqual(harness.view.calls.at(-1), [
    "tracked",
    {
      title: "Metadata title",
      customTitle: null,
      currentPage: 123,
      totalPages: 123,
      pagesRemaining: 0,
      progressPercent: 100,
      completionAction: "reading",
      status: "Book completed.",
    },
  ]);

  await harness.view.changeCompletion();

  assert.deepEqual(harness.fake.storageFake.snapshot().completedBooks, {});
  assert.equal(harness.view.calls.at(-1)[1].completionAction, "complete");
  assert.equal(harness.view.calls.at(-1)[1].status, "Moved to reading.");
});

test("failed completion stays visible and retryable", async () => {
  const harness = createHarness({ book: canonicalRecord({ currentPage: 123 }) });
  await harness.app.start();
  harness.fake.storageFake.failNext("set", new Error("quota exceeded"));

  await harness.view.changeCompletion();

  assert.equal(harness.fake.storageFake.snapshot().completedBooks, undefined);
  assert.equal(harness.view.calls.at(-1)[1].completionAction, "complete");
  assert.equal(
    harness.view.calls.at(-1)[1].error,
    "This book could not be completed. Try again.",
  );

  await harness.view.changeCompletion();
  assert.equal(
    harness.fake.storageFake.snapshot().completedBooks[BOOK_URL],
    1_800_000_200,
  );
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

test("failed rename keeps the entered title visible and retryable without retyping", async () => {
  const existing = canonicalRecord();
  const { elements, hostDocument } = createPopupDocumentFake();
  const harness = createHarness({
    book: existing,
    view: createPopupView({ hostDocument }),
  });
  await harness.app.start();
  harness.fake.storageFake.failNext("set", new Error("quota exceeded"));

  elements["#customTitle"].value = "  Reader name  ";
  assert.equal(elements["#renameForm"].submit(), true);
  assert.equal(elements["#customTitle"].value, "  Reader name  ");
  assert.equal(elements["#customTitle"].disabled, true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.fake.storageFake.snapshot().books[BOOK_URL], existing);
  assert.equal(elements["#popupStatus"].textContent, "Unable to save title");
  assert.equal(elements["#popupError"].textContent, "The title could not be saved. Try again.");
  assert.equal(elements["#customTitle"].value, "  Reader name  ");
  assert.equal(elements["#customTitle"].disabled, false);

  assert.equal(elements["#renameForm"].submit(), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.fake.storageFake.snapshot().books[BOOK_URL].customTitle, "Reader name");
  assert.equal(elements["#popupStatus"].textContent, "Title saved.");
  assert.equal(elements["#customTitle"].value, "Reader name");
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
  let completions = 0;
  let switches = 0;
  let untracks = 0;
  view.setCompletionHandler(() => {
    completions += 1;
  });
  view.setRenameHandler((customTitle) => renames.push(customTitle));
  view.setSwitchBooksHandler(() => {
    switches += 1;
  });
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
    completionAction: "complete",
  });

  assert.equal(elements["#bookFilename"].textContent, "Reader name");
  assert.equal(elements["#pageSummary"].textContent, "Page 45 of 123");
  assert.equal(elements["#pagesRemaining"].textContent, "78 pages remaining");
  assert.equal(elements["#progressBar"].value, 37);
  assert.equal(elements["#progressBar"].max, 100);
  assert.equal(elements["#progressPercent"].textContent, "37%");
  assert.equal(elements["#customTitle"].value, "Reader name");
  assert.equal(elements["#completionButton"].hidden, false);
  assert.equal(elements["#completionButton"].textContent, "Complete book");
  elements["#customTitle"].value = "New name";
  assert.equal(elements["#renameForm"].submit(), true);
  elements["#completionButton"].click();
  elements["#switchBooksButton"].click();
  elements["#untrackButton"].click();
  assert.deepEqual(renames, ["New name"]);
  assert.equal(completions, 1);
  assert.equal(switches, 1);
  assert.equal(untracks, 1);

  view.showTracked({
    title: "Reader name",
    customTitle: "Reader name",
    currentPage: 45,
    totalPages: 123,
    pagesRemaining: 78,
    progressPercent: 37,
    completionAction: "reading",
  });
  assert.equal(elements["#completionButton"].textContent, "Move to reading");

  const popupHtml = await readFile(new URL("../popup/popup.html", import.meta.url), "utf8");
  assert.match(popupHtml, /<progress id="progressBar"[^>]+max="100"/);
  assert.match(popupHtml, /<label for="customTitle">Change title<\/label>/);
  assert.match(popupHtml, /<button id="completionButton"[^>]+type="button"/);
  assert.match(popupHtml, /<button id="switchBooksButton"[^>]+type="button"/);
  assert.match(popupHtml, /<button id="untrackButton"[^>]+type="button"/);
});
