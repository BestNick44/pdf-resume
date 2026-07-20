import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createPopupApp } from "../popup/popup-app.mjs";
import { createPopupView } from "../popup/popup-view.mjs";
import { createBooksStorage } from "../storage/books.mjs";
import { createChromeExtensionFake } from "./support/chrome-extension-fake.mjs";

const BOOK_URL = "file:///Users/reader/Books/A%20Book.pdf";
const TAB_ID = 7;

function canonicalRecord(overrides = {}) {
  return {
    title: "A Book",
    customTitle: null,
    totalPages: 0,
    currentPage: 1,
    scrollTop: 0,
    addedAt: 1_800_000_000,
    lastReadAt: 1_800_000_000,
    ...overrides,
  };
}

function createViewSpy() {
  const calls = [];
  let activationHandler;
  let destroyed = false;
  return {
    calls,
    get destroyed() {
      return destroyed;
    },
    destroy() {
      destroyed = true;
      activationHandler = undefined;
    },
    setActivationHandler(handler) {
      activationHandler = handler;
    },
    activate() {
      return activationHandler?.();
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
    showPending(details) {
      calls.push(["pending", details]);
    },
    showSuccess(details) {
      calls.push(["success", details]);
    },
    showTracked(details) {
      calls.push(["tracked", details]);
    },
    showUntracked(details) {
      calls.push(["untracked", details]);
    },
  };
}

function createHarness({
  activeTab = { id: TAB_ID, url: BOOK_URL },
  initialStorage = {},
  now = 1_800_000_000,
} = {}) {
  const fake = createChromeExtensionFake({
    activeTabId: activeTab?.id,
    storage: initialStorage,
    tabs: activeTab ? [activeTab] : [],
  });
  const books = createBooksStorage({
    storageArea: fake.chrome.storage.local,
    lockManager: fake.locks,
    now: () => now,
  });
  const view = createViewSpy();
  let trackCalls = 0;
  const app = createPopupApp({
    view,
    queryActiveTab: (query) => fake.chrome.tabs.query(query),
    getTab: (tabId) => fake.chrome.tabs.get(tabId),
    updateTab: (tabId, properties) => fake.chrome.tabs.update(tabId, properties),
    getRuntimeUrl: (path) => fake.chrome.runtime.getURL(path),
    getBook: books.getBook,
    async trackBook(...args) {
      trackCalls += 1;
      return books.trackBook(...args);
    },
  });
  return { app, books, fake, get trackCalls() { return trackCalls; }, view };
}

function startedTabOperations(fake, method) {
  return fake.tabOperations.filter(
    (operation) => operation.method === method && operation.phase === "start",
  );
}

function startedStorageOperations(fake, method) {
  return fake.storageFake.operations.filter(
    (operation) => operation.method === method && operation.phase === "start",
  );
}

test("popup open queries the actual active tab and presents an untracked local PDF without side effects", async () => {
  const harness = createHarness();

  await harness.app.start();

  assert.deepEqual(startedTabOperations(harness.fake, "query"), [
    {
      method: "query",
      phase: "start",
      queryInfo: { active: true, currentWindow: true },
    },
  ]);
  assert.deepEqual(harness.view.calls, [
    ["loading"],
    ["untracked", { filename: "A Book", actionLabel: "Track this book" }],
  ]);
  assert.equal(startedStorageOperations(harness.fake, "set").length, 0);
  assert.equal(startedTabOperations(harness.fake, "update").length, 0);
});

test("only canonical local PDF tabs are eligible and unrelated tabs remain stable", async (t) => {
  const cases = [
    ["no active tab", null],
    ["inaccessible URL", { id: TAB_ID }],
    ["inaccessible id", { url: BOOK_URL }],
    ["remote PDF", { id: TAB_ID, url: "https://example.test/book.pdf" }],
    ["HTTP PDF", { id: TAB_ID, url: "http://example.test/book.pdf" }],
    ["extension viewer", { id: TAB_ID, url: "chrome-extension://id/viewer.html?file=x" }],
    ["data URL", { id: TAB_ID, url: "data:application/pdf;base64,JVBERi0=" }],
    ["blob URL", { id: TAB_ID, url: "blob:https://example.test/id" }],
    ["directory", { id: TAB_ID, url: "file:///tmp/book.pdf/" }],
    ["malformed", { id: TAB_ID, url: "file:///tmp/book%ZZ.pdf" }],
    ["non-PDF", { id: TAB_ID, url: "file:///tmp/book.txt" }],
  ];

  for (const [name, activeTab] of cases) {
    await t.test(name, async () => {
      const harness = createHarness({ activeTab });
      const originalUrl = activeTab?.url;

      await harness.app.start();
      await harness.view.activate();

      assert.deepEqual(harness.view.calls, [["loading"], ["ineligible"]]);
      assert.equal(startedStorageOperations(harness.fake, "get").length, 0);
      assert.equal(startedStorageOperations(harness.fake, "set").length, 0);
      assert.equal(startedTabOperations(harness.fake, "update").length, 0);
      if (activeTab?.id) {
        assert.equal(harness.fake.snapshotTab(activeTab.id)?.url, originalUrl);
      }
    });
  }
});

test("canonical encoded filenames use the shared cleaner and hostile text stays data", async () => {
  const hostileUrl =
    "file:///tmp/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E_%E6%97%A5%E6%9C%AC%E8%AA%9E%0A---Final%2Epdf";
  const harness = createHarness({ activeTab: { id: TAB_ID, url: hostileUrl } });

  await harness.app.start();

  assert.deepEqual(harness.view.calls.at(-1), [
    "untracked",
    {
      filename: "<img src=x onerror=alert(1)> 日本語 Final",
      actionLabel: "Track this book",
    },
  ]);
  assert.doesNotMatch(harness.view.calls.at(-1)[1].filename, /[\p{Cc}\p{Cf}]/u);
});

test("already tracked PDFs show a bounded truthful state without writing or navigating", async () => {
  const existing = canonicalRecord({ title: "Hydrated title", totalPages: 30 });
  const harness = createHarness({ initialStorage: { books: { [BOOK_URL]: existing } } });

  await harness.app.start();
  await harness.app.activate();

  assert.deepEqual(harness.view.calls, [
    ["loading"],
    ["tracked", { filename: "A Book", message: "This book is already tracked." }],
  ]);
  assert.equal(startedStorageOperations(harness.fake, "set").length, 0);
  assert.equal(startedTabOperations(harness.fake, "update").length, 0);
  assert.deepEqual(harness.fake.storageFake.snapshot().books[BOOK_URL], existing);
});

test("activation durably creates the canonical record before redirecting that exact tab", async () => {
  const harness = createHarness();
  await harness.app.start();
  const heldWrite = harness.fake.storageFake.holdNext("set");

  const activation = harness.view.activate();
  await heldWrite.started;

  assert.equal(startedTabOperations(harness.fake, "update").length, 0);
  assert.equal(harness.fake.snapshotTab(TAB_ID).url, BOOK_URL);
  heldWrite.release();
  await activation;

  assert.deepEqual(harness.fake.storageFake.snapshot(), {
    books: { [BOOK_URL]: canonicalRecord() },
  });
  const expectedViewerUrl =
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html?file=file%3A%2F%2F%2FUsers%2Freader%2FBooks%2FA%2520Book.pdf";
  assert.equal(startedTabOperations(harness.fake, "get").length, 2);
  assert.deepEqual(startedTabOperations(harness.fake, "update"), [
    {
      method: "update",
      phase: "start",
      tabId: TAB_ID,
      updateProperties: { url: expectedViewerUrl },
    },
  ]);
  assert.equal(harness.fake.snapshotTab(TAB_ID).url, expectedViewerUrl);
  assert.deepEqual(harness.view.calls.at(-1), [
    "success",
    { filename: "A Book", message: "Book tracked. Opening the viewer…" },
  ]);
});

test("same-tab revalidation rejects committed or pending navigation before any write", async (t) => {
  const assertRejectedBeforeWrite = async (harness) => {
    await harness.app.start();
    await harness.view.activate();

    assert.equal(startedStorageOperations(harness.fake, "set").length, 0);
    assert.equal(startedTabOperations(harness.fake, "update").length, 0);
    assert.deepEqual(harness.fake.storageFake.snapshot(), {});
    assert.match(harness.view.calls.at(-1)[1].message, /no longer shows.*No book was tracked/i);
  };

  await t.test("tab committed a different PDF", async () => {
    const harness = createHarness();
    await harness.app.start();
    harness.fake.setTabUrl(TAB_ID, "file:///Users/reader/Books/Other.pdf");

    await harness.view.activate();

    assert.equal(startedStorageOperations(harness.fake, "set").length, 0);
    assert.equal(startedTabOperations(harness.fake, "update").length, 0);
    assert.deepEqual(harness.fake.storageFake.snapshot(), {});
    assert.match(harness.view.calls.at(-1)[1].message, /no longer shows.*No book was tracked/i);
  });

  for (const [name, pendingUrl] of [
    ["tab is pending navigation to another local PDF", "file:///Users/reader/Books/Other.pdf"],
    ["tab is pending navigation to a remote PDF", "https://example.test/Other.pdf"],
    ["tab has a malformed pending URL", "file:///Users/reader/Books/Other%ZZ.pdf"],
  ]) {
    await t.test(name, () =>
      assertRejectedBeforeWrite(
        createHarness({ activeTab: { id: TAB_ID, url: BOOK_URL, pendingUrl } }),
      ),
    );
  }

  await t.test("tab closed", async () => {
    const harness = createHarness();
    await harness.app.start();
    harness.fake.closeTab(TAB_ID);

    await harness.view.activate();

    assert.equal(startedStorageOperations(harness.fake, "set").length, 0);
    assert.equal(startedTabOperations(harness.fake, "update").length, 0);
    assert.deepEqual(harness.fake.storageFake.snapshot(), {});
  });
});

test("post-persistence revalidation preserves the record without overwriting newer tab navigation", async (t) => {
  const cases = [
    {
      name: "tab commits a different PDF while storage is blocked",
      mutateTab: (fake) => fake.setTabUrl(TAB_ID, "file:///Users/reader/Books/Other.pdf"),
    },
    {
      name: "tab gains remote pending navigation while storage is blocked",
      mutateTab: (fake) => fake.setTabPendingUrl(TAB_ID, "https://example.test/Other.pdf"),
    },
    {
      name: "tab gains malformed pending navigation while storage is blocked",
      mutateTab: (fake) => fake.setTabPendingUrl(TAB_ID, "file:///Users/reader/Books/Other%ZZ.pdf"),
    },
    {
      name: "tab closes while storage is blocked",
      mutateTab: (fake) => fake.closeTab(TAB_ID),
    },
  ];

  for (const { name, mutateTab } of cases) {
    await t.test(name, async () => {
      const harness = createHarness();
      await harness.app.start();
      const heldWrite = harness.fake.storageFake.holdNext("set");

      const activation = harness.view.activate();
      await heldWrite.started;
      mutateTab(harness.fake);
      heldWrite.release();
      await activation;

      assert.deepEqual(harness.fake.storageFake.snapshot().books[BOOK_URL], canonicalRecord());
      assert.equal(startedStorageOperations(harness.fake, "set").length, 1);
      assert.equal(startedTabOperations(harness.fake, "get").length, 2);
      assert.equal(startedTabOperations(harness.fake, "update").length, 0);
      assert.deepEqual(harness.view.calls.at(-1), [
        "error",
        {
          filename: "A Book",
          actionLabel: "Retry opening viewer",
          message:
            "This book is tracked, but the original PDF tab could not be opened in the viewer. Return that tab to the same PDF and retry.",
          persisted: true,
        },
      ]);
    });
  }
});

test("canonically equivalent pending navigation may track and open the captured PDF", async () => {
  const harness = createHarness({
    activeTab: {
      id: TAB_ID,
      url: BOOK_URL,
      pendingUrl: "file:///Users/reader/Books/A Book.pdf",
    },
  });

  await harness.app.start();
  await harness.view.activate();

  assert.deepEqual(harness.fake.storageFake.snapshot().books[BOOK_URL], canonicalRecord());
  assert.equal(startedTabOperations(harness.fake, "update").length, 1);
  assert.equal(harness.view.calls.at(-1)[0], "success");
});

test("a concurrent tracker wins without its record being patched or duplicated", async () => {
  const harness = createHarness();
  await harness.app.start();
  const concurrent = createBooksStorage({
    storageArea: harness.fake.chrome.storage.local,
    lockManager: harness.fake.locks,
    now: () => 1_800_000_001,
  });
  const existing = await concurrent.trackBook(BOOK_URL, { title: "Concurrent title" });
  const writesBeforeActivation = startedStorageOperations(harness.fake, "set").length;

  await harness.view.activate();

  assert.deepEqual(harness.fake.storageFake.snapshot().books[BOOK_URL], existing);
  assert.equal(harness.fake.storageFake.snapshot().books[BOOK_URL].title, "Concurrent title");
  assert.equal(startedStorageOperations(harness.fake, "set").length, writesBeforeActivation);
  assert.equal(startedTabOperations(harness.fake, "update").length, 1);
});

test("storage failure is retryable and never redirects before a durable record", async () => {
  const harness = createHarness();
  await harness.app.start();
  harness.fake.storageFake.failNext("set", new Error("quota exceeded"));

  await harness.view.activate();

  assert.deepEqual(harness.fake.storageFake.snapshot(), {});
  assert.equal(startedTabOperations(harness.fake, "update").length, 0);
  assert.deepEqual(harness.view.calls.at(-1), [
    "error",
    {
      filename: "A Book",
      actionLabel: "Track this book",
      message: "This book could not be tracked. No changes were made. Try again.",
      persisted: false,
    },
  ]);

  await harness.view.activate();
  assert.deepEqual(harness.fake.storageFake.snapshot().books[BOOK_URL], canonicalRecord());
  assert.equal(startedTabOperations(harness.fake, "update").length, 1);
});

test("redirect failure preserves the authorized record and retries navigation without rewriting", async (t) => {
  for (const [name, arrangeFailure] of [
    ["rejected update", (fake) => fake.failNext("update", new Error("navigation denied"))],
    ["fulfilled undefined update", (fake) => fake.returnUndefinedNext("update")],
  ]) {
    await t.test(name, async () => {
      const harness = createHarness();
      await harness.app.start();
      arrangeFailure(harness.fake);

      await harness.view.activate();

      assert.deepEqual(harness.fake.storageFake.snapshot().books[BOOK_URL], canonicalRecord());
      assert.equal(startedStorageOperations(harness.fake, "set").length, 1);
      assert.deepEqual(harness.view.calls.at(-1), [
        "error",
        {
          filename: "A Book",
          actionLabel: "Retry opening viewer",
          message:
            "This book is tracked, but the original PDF tab could not be opened in the viewer. Return that tab to the same PDF and retry.",
          persisted: true,
        },
      ]);

      await harness.view.activate();
      assert.equal(startedStorageOperations(harness.fake, "set").length, 1);
      assert.equal(startedTabOperations(harness.fake, "update").length, 2);
      assert.deepEqual(harness.fake.storageFake.snapshot().books[BOOK_URL], canonicalRecord());
      assert.equal(harness.view.calls.at(-1)[0], "success");
    });
  }
});

test("double pointer or keyboard activation is serialized into one track and redirect", async () => {
  const harness = createHarness();
  await harness.app.start();
  const heldWrite = harness.fake.storageFake.holdNext("set");

  const first = harness.view.activate();
  const second = harness.view.activate();
  await heldWrite.started;

  assert.equal(first, second);
  assert.equal(harness.trackCalls, 1);
  assert.equal(startedStorageOperations(harness.fake, "set").length, 1);
  heldWrite.release();
  await Promise.all([first, second]);
  assert.equal(startedTabOperations(harness.fake, "update").length, 1);
});

test("popup teardown suppresses stale rendering while an authorized durable flow finishes", async () => {
  const harness = createHarness();
  await harness.app.start();
  const heldWrite = harness.fake.storageFake.holdNext("set");
  const activation = harness.view.activate();
  await heldWrite.started;
  const callCountBeforeDestroy = harness.view.calls.length;

  harness.app.destroy();
  heldWrite.release();
  await activation;

  assert.equal(harness.view.destroyed, true);
  assert.equal(harness.view.calls.length, callCountBeforeDestroy);
  assert.deepEqual(harness.fake.storageFake.snapshot().books[BOOK_URL], canonicalRecord());
  assert.equal(startedTabOperations(harness.fake, "update").length, 1);
});

class FakeElement {
  constructor() {
    this.attributes = {};
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.textContent = "";
  }

  set innerHTML(_value) {
    assert.fail("popup rendering must not use HTML parsing");
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) {
      this.listeners.delete(type);
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  click() {
    if (!this.disabled && !this.hidden) {
      this.listeners.get("click")?.({ type: "click" });
    }
  }
}

test("popup view uses native button semantics, accessible state, and text-only hostile filename rendering", async () => {
  const selectors = [
    "#popupMain",
    "#popupStatus",
    "#popupBook",
    "#bookFilename",
    "#popupMessage",
    "#popupError",
    "#trackButton",
  ];
  const elements = Object.fromEntries(selectors.map((selector) => [selector, new FakeElement()]));
  const view = createPopupView({
    hostDocument: { querySelector: (selector) => elements[selector] },
  });
  let activations = 0;
  view.setActivationHandler(() => {
    activations += 1;
  });

  view.showUntracked({
    filename: '<svg onload="alert(1)">\u0000\u202E',
    actionLabel: "Track this book",
  });
  elements["#trackButton"].click();

  assert.equal(elements["#bookFilename"].textContent, '<svg onload="alert(1)">\u0000\u202E');
  assert.equal(elements["#trackButton"].textContent, "Track this book");
  assert.equal(elements["#popupMain"].attributes["aria-busy"], "false");
  assert.equal(activations, 1);
  view.showPending({ filename: "A Book", message: "Tracking this book…" });
  elements["#trackButton"].click();
  assert.equal(elements["#popupMain"].attributes["aria-busy"], "true");
  assert.equal(activations, 1, "pending state disables native activation");

  const popupHtml = await readFile(new URL("../popup/popup.html", import.meta.url), "utf8");
  assert.match(popupHtml, /<button id="trackButton" type="button" hidden>/);
  assert.match(popupHtml, /id="popupStatus"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(popupHtml, /id="popupError" role="alert"/);
});
