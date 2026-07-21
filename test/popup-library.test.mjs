import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createPopupApp } from "../popup/popup-app.mjs";
import { createPopupView } from "../popup/popup-view.mjs";
import { createBooksStorage } from "../storage/books.mjs";
import { createChromeExtensionFake } from "./support/chrome-extension-fake.mjs";
import { createPopupDocumentFake } from "./support/popup-dom-fake.mjs";

const BOOK_A_URL = "file:///Users/reader/Books/A.pdf";
const BOOK_B_URL = "file:///Users/reader/Books/B.pdf";
const TAB_ID = 7;

function canonicalRecord(overrides = {}) {
  return {
    title: "Book title",
    customTitle: null,
    totalPages: 100,
    currentPage: 25,
    scrollTop: 1200,
    addedAt: 1_800_000_000,
    lastReadAt: 1_800_000_100,
    ...overrides,
  };
}

function createViewSpy() {
  const calls = [];
  let openBookHandler;
  return {
    calls,
    openBook(fileUrl) {
      return openBookHandler?.(fileUrl);
    },
    setActivationHandler() {},
    setOpenBookHandler(handler) {
      openBookHandler = handler;
    },
    setRenameHandler() {},
    setUntrackHandler() {},
    showIneligible() {
      calls.push(["ineligible"]);
    },
    showLibrary(details) {
      calls.push(["library", details]);
    },
    showLoading() {
      calls.push(["loading"]);
    },
  };
}

function createHarness({ storage = {} } = {}) {
  const fake = createChromeExtensionFake({
    activeTabId: TAB_ID,
    storage,
    tabs: [{ id: TAB_ID, url: "https://example.test/" }],
  });
  const books = createBooksStorage({
    storageArea: fake.chrome.storage.local,
    lockManager: fake.locks,
  });
  const view = createViewSpy();
  const app = createPopupApp({
    view,
    isFileSchemeAccessAllowed: async () => true,
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
  return { app, fake, view };
}

test("non-PDF tabs list every tracked book with title and reading progress", async () => {
  const harness = createHarness({
    storage: {
      books: {
        [BOOK_B_URL]: canonicalRecord({
          title: "Metadata B",
          customTitle: "Reader B",
          totalPages: 0,
          currentPage: 8,
        }),
        [BOOK_A_URL]: canonicalRecord({ title: "Metadata A" }),
      },
    },
  });

  await harness.app.start();

  assert.deepEqual(harness.view.calls, [
    ["loading"],
    [
      "library",
      {
        books: [
          {
            fileUrl: BOOK_A_URL,
            title: "Metadata A",
            currentPage: 25,
            totalPages: 100,
            progressPercent: 25,
          },
          {
            fileUrl: BOOK_B_URL,
            title: "Reader B",
            currentPage: 8,
            totalPages: 0,
            progressPercent: null,
          },
        ],
      },
    ],
  ]);
});

test("clicking a library book opens it in the viewer on the captured active tab", async () => {
  const harness = createHarness({
    storage: { books: { [BOOK_A_URL]: canonicalRecord({ title: "Metadata A" }) } },
  });
  await harness.app.start();

  await harness.view.openBook(BOOK_A_URL);

  const expectedViewerUrl =
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html?file=file%3A%2F%2F%2FUsers%2Freader%2FBooks%2FA.pdf";
  assert.equal(harness.fake.snapshotTab(TAB_ID).url, expectedViewerUrl);
  assert.deepEqual(
    harness.fake.tabOperations.filter(
      ({ method, phase }) => method === "update" && phase === "start",
    ),
    [
      {
        method: "update",
        phase: "start",
        tabId: TAB_ID,
        updateProperties: { url: expectedViewerUrl },
      },
    ],
  );
  assert.deepEqual(harness.view.calls.at(-1), [
    "library",
    {
      books: [
        {
          fileUrl: BOOK_A_URL,
          title: "Metadata A",
          currentPage: 25,
          totalPages: 100,
          progressPercent: 25,
        },
      ],
      status: "Opening Metadata A in the viewer…",
    },
  ]);
});

test("failed library navigation keeps the library visible and retryable", async () => {
  const harness = createHarness({
    storage: { books: { [BOOK_A_URL]: canonicalRecord({ title: "Metadata A" }) } },
  });
  await harness.app.start();
  harness.fake.failNext("update", new Error("navigation denied"));

  await harness.view.openBook(BOOK_A_URL);

  assert.equal(harness.fake.snapshotTab(TAB_ID).url, "https://example.test/");
  assert.deepEqual(harness.view.calls.at(-1), [
    "library",
    {
      books: [
        {
          fileUrl: BOOK_A_URL,
          title: "Metadata A",
          currentPage: 25,
          totalPages: 100,
          progressPercent: 25,
        },
      ],
      error: "Metadata A could not be opened. Try again.",
      status: "Unable to open book",
    },
  ]);

  await harness.view.openBook(BOOK_A_URL);
  assert.match(harness.fake.snapshotTab(TAB_ID).url, /^chrome-extension:/);
});

test("library view renders accessible book buttons and a progress bar for every book", async () => {
  const { elements, hostDocument } = createPopupDocumentFake();
  const view = createPopupView({ hostDocument });
  const opened = [];
  view.setOpenBookHandler((fileUrl) => opened.push(fileUrl));

  view.showLibrary({
    books: [
      {
        fileUrl: BOOK_A_URL,
        title: '<img src=x onerror="alert(1)">',
        currentPage: 25,
        totalPages: 100,
        progressPercent: 25,
      },
      {
        fileUrl: BOOK_B_URL,
        title: "Reader B",
        currentPage: 8,
        totalPages: 0,
        progressPercent: null,
      },
    ],
  });

  assert.equal(elements["#popupLibrary"].hidden, false);
  assert.equal(elements["#libraryList"].children.length, 2);
  const [firstItem, secondItem] = elements["#libraryList"].children;
  const [firstButton, firstProgressRow] = firstItem.children;
  const [firstTitle, firstSummary] = firstButton.children;
  const [firstProgress, firstProgressLabel] = firstProgressRow.children;
  assert.equal(firstButton.tagName, "BUTTON");
  assert.equal(firstButton.type, "button");
  assert.equal(firstTitle.textContent, '<img src=x onerror="alert(1)">');
  assert.equal(firstSummary.textContent, "Page 25 of 100");
  assert.equal(
    firstButton.attributes["aria-label"],
    'Open <img src=x onerror="alert(1)">, Page 25 of 100',
  );
  assert.equal(firstProgress.tagName, "PROGRESS");
  assert.equal(firstProgress.max, 100);
  assert.equal(firstProgress.value, 25);
  assert.equal(firstProgressLabel.textContent, "25%");
  firstButton.click();
  assert.deepEqual(opened, [BOOK_A_URL]);

  const [secondButton, secondProgressRow] = secondItem.children;
  const [, secondSummary] = secondButton.children;
  const [secondProgress, secondProgressLabel] = secondProgressRow.children;
  assert.equal(secondSummary.textContent, "Page 8 of —");
  assert.equal(secondButton.attributes["aria-label"], "Open Reader B, Page 8 of —");
  assert.equal(secondProgress.tagName, "PROGRESS");
  assert.equal(secondProgressLabel.textContent, "Progress unavailable");

  const popupHtml = await readFile(new URL("../popup/popup.html", import.meta.url), "utf8");
  assert.match(popupHtml, /<section id="popupLibrary"[^>]+aria-labelledby="libraryHeading"[^>]+hidden>/);
  assert.match(popupHtml, /<h2 id="libraryHeading">Tracked books<\/h2>/);
  assert.match(popupHtml, /<ul id="libraryList"><\/ul>/);
});
