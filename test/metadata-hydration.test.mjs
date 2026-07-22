import assert from "node:assert/strict";
import test from "node:test";

import { BooksStorageDataError, createBooksStorage } from "../storage/books.mjs";
import {
  resolveAutomaticBookTitle,
  titleFromLocalPdfFilename,
} from "../shared/book-title.mjs";
import { createPdfJsMetadataHydration } from "../viewer/pdfjs-metadata-hydration.mjs";
import { createChromeStorageFake } from "./support/chrome-storage-fake.mjs";
import { createFakeScheduler } from "./support/fake-scheduler.mjs";

const BOOK_URL = "file:///Users/reader/Books/%E6%97%A5%E6%9C%AC%E8%AA%9E__Notes---Final.pdf";

function canonicalRecord(overrides = {}) {
  return {
    title: "Temporary filename",
    customTitle: "Reader's title",
    totalPages: 0,
    currentPage: 3,
    scrollTop: 450.5,
    addedAt: 1_700_000_000,
    lastReadAt: 1_700_000_100,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function drainMicrotasks() {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

class FakeEventTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeEventBus extends FakeEventTarget {
  on(type, listener) {
    this.addEventListener(type, listener);
  }

  off(type, listener) {
    this.removeEventListener(type, listener);
  }
}

function createHydrationHarness({
  fileUrl = BOOK_URL,
  getBook = async () => canonicalRecord(),
  getMetadata = async () => ({ info: { Title: "PDF metadata title" } }),
  hydrateMetadata = async () => canonicalRecord({
    title: "PDF metadata title",
    totalPages: 7,
  }),
  reportError,
} = {}) {
  const time = createFakeScheduler();
  const eventBus = new FakeEventBus();
  const documentIdentity = { getMetadata, numPages: 7 };
  const application = {
    eventBus,
    initializedPromise: Promise.resolve(),
    pdfDocument: documentIdentity,
    pdfViewer: { pagesCount: 7 },
  };
  const frame = new FakeEventTarget();
  frame.contentWindow = { PDFViewerApplication: application };
  const errors = [];
  const hydration = createPdfJsMetadataHydration({
    fileUrl,
    frame,
    getBook,
    hydrateMetadata,
    reportError: reportError ?? ((error) => errors.push(error)),
    scheduler: time.scheduler,
  });

  async function start() {
    frame.dispatch("load");
    await drainMicrotasks();
    await hydration.settled();
  }

  return {
    application,
    documentIdentity,
    errors,
    eventBus,
    frame,
    hydration,
    start,
    time,
  };
}

test("meaningful PDF Title wins without rewriting Unicode, punctuation, or emoji", () => {
  assert.equal(
    resolveAutomaticBookTitle(
      { info: { Title: "  L’été — 日本語: v1.2  " } },
      BOOK_URL,
    ),
    "L’été — 日本語: v1.2",
  );
  assert.equal(
    resolveAutomaticBookTitle({ info: { Title: "Cafe\u0301" } }, BOOK_URL),
    "Café",
  );
  assert.equal(
    resolveAutomaticBookTitle(
      { info: { Title: "Title: a punctuation test" } },
      BOOK_URL,
    ),
    "Title: a punctuation test",
  );
  assert.equal(
    resolveAutomaticBookTitle(
      { info: { Title: "👩‍💻 — release_v1.2!" } },
      BOOK_URL,
    ),
    "👩‍💻 — release_v1.2!",
  );
});

test("separator-noise, invisible, control, URL, and path metadata titles use the filename", () => {
  const invalidTitles = [
    undefined,
    "   ",
    "---",
    "___–—",
    "\u200B",
    "Hidden\u200Btitle",
    "\u0000\u0007",
    "Unsafe\u202Etitle",
    "file:///Users/reader/secret.pdf",
    "/Users/reader/secret.pdf",
    "C:\\Users\\reader\\secret.pdf",
  ];

  for (const Title of invalidTitles) {
    assert.equal(
      resolveAutomaticBookTitle({ info: { Title } }, BOOK_URL),
      "日本語 Notes Final",
    );
  }
  assert.equal(resolveAutomaticBookTitle(undefined, BOOK_URL), "日本語 Notes Final");
  const malformed = {};
  Object.defineProperty(malformed, "info", {
    get() {
      assert.fail("malformed metadata accessors must not run");
    },
  });
  assert.equal(resolveAutomaticBookTitle(malformed, BOOK_URL), "日本語 Notes Final");
});

test("filename fallback decodes Unicode and removes only separator noise and PDF extension", () => {
  assert.equal(titleFromLocalPdfFilename(BOOK_URL), "日本語 Notes Final");
  assert.equal(
    titleFromLocalPdfFilename("file:///tmp/Jean-Paul_v1.2%20-%20draft.PDF"),
    "Jean-Paul v1.2 draft",
  );
  assert.equal(
    titleFromLocalPdfFilename("file:///tmp/100%25%20%E2%80%94%20caf%C3%A9.pdf"),
    "100% café",
  );
});

test("filename fallback preserves Unicode joiners in emoji and orthographic text", () => {
  assert.equal(
    titleFromLocalPdfFilename(
      "file:///tmp/%F0%9F%91%A9%E2%80%8D%F0%9F%92%BB.pdf",
    ),
    "👩‍💻",
  );
  assert.equal(
    titleFromLocalPdfFilename(
      "file:///tmp/%D9%85%DB%8C%E2%80%8C%D8%B1%D9%88%D9%85.pdf",
    ),
    "می‌روم",
  );
});

test("filename cleanup uses untitled for separator, invisible, bidi, or control-only basenames", () => {
  const untitledUrls = [
    "file:///tmp/---___.pdf",
    "file:///tmp/%20---%20.pdf",
    "file:///tmp/____.pdf",
    "file:///tmp/%E2%80%8B.pdf",
    "file:///tmp/%E2%80%AE.pdf",
    "file:///tmp/%01.pdf",
    "file:///tmp/%E2%80%8C%E2%80%8D.pdf",
    "file:///tmp/.pdf",
  ];

  for (const fileUrl of untitledUrls) {
    assert.equal(titleFromLocalPdfFilename(fileUrl), "untitled");
  }
});

test("an all-separator filename still permits title and page-count hydration", async () => {
  const fileUrl = "file:///tmp/---___.pdf";
  const writes = [];
  const harness = createHydrationHarness({
    fileUrl,
    getMetadata: async () => ({ info: { Title: "  " } }),
    hydrateMetadata: async (...args) => writes.push(args),
  });

  await harness.start();

  assert.deepEqual(writes[0].slice(0, 2), [
    fileUrl,
    { title: "untitled", totalPages: 7 },
  ]);
  assert.deepEqual(harness.errors, []);
  harness.hydration.destroy();
});

test("first hydration stores actual pages below a stale page without disturbing reader state", async () => {
  const existing = canonicalRecord({ currentPage: 12 });
  const fake = createChromeStorageFake({ books: { [BOOK_URL]: existing } });
  const books = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => 1_900_000_000,
  });

  const hydrated = await books.hydrateMetadata(BOOK_URL, {
    title: "PDF metadata title",
    totalPages: 7,
  });

  assert.deepEqual(hydrated, {
    ...existing,
    title: "PDF metadata title",
    totalPages: 7,
  });
  assert.deepEqual(fake.snapshot().books[BOOK_URL], hydrated);
  assert.deepEqual(await books.getBook(BOOK_URL), hydrated);
});

test("hydrated records are a durable no-op and do not churn storage or timestamps", async () => {
  const existing = canonicalRecord({ title: "Already hydrated", totalPages: 7 });
  const fake = createChromeStorageFake({ books: { [BOOK_URL]: existing } });
  const books = createBooksStorage({ storageArea: fake.local, lockManager: fake.locks });

  assert.deepEqual(
    await books.hydrateMetadata(BOOK_URL, { title: "Replacement", totalPages: 9 }),
    existing,
  );
  assert.deepEqual(fake.snapshot().books[BOOK_URL], existing);
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
});

test("metadata lifecycle uses actual numPages and skips PDF metadata on reopen", async () => {
  const writes = [];
  let metadataCalls = 0;
  const first = createHydrationHarness({
    getMetadata: async () => {
      metadataCalls += 1;
      return { info: { Title: "Document title" } };
    },
    hydrateMetadata: async (...args) => {
      writes.push(args);
    },
  });
  await first.start();

  assert.equal(metadataCalls, 1);
  assert.deepEqual(writes[0].slice(0, 2), [
    BOOK_URL,
    { title: "Document title", totalPages: 7 },
  ]);
  first.hydration.destroy();

  const reopened = createHydrationHarness({
    getBook: async () => canonicalRecord({ totalPages: 7 }),
    getMetadata: async () => {
      metadataCalls += 1;
    },
    hydrateMetadata: async (...args) => writes.push(args),
  });
  await reopened.start();

  assert.equal(metadataCalls, 1);
  assert.equal(writes.length, 1);
  reopened.hydration.destroy();
});

test("a failed metadata attempt is nonfatal and retries on a later open", async () => {
  const failure = new Error("PDF.js metadata unavailable");
  const failed = createHydrationHarness({ getMetadata: async () => Promise.reject(failure) });
  await failed.start();
  assert.deepEqual(failed.errors, [failure]);
  failed.hydration.destroy();

  const writes = [];
  const retried = createHydrationHarness({
    hydrateMetadata: async (...args) => writes.push(args),
  });
  await retried.start();
  assert.equal(writes.length, 1);
  assert.deepEqual(retried.errors, []);
  retried.hydration.destroy();
});

test("malformed persisted state rejects getBook nonfatally without metadata or state churn", async () => {
  const malformed = canonicalRecord({ title: 42 });
  const fake = createChromeStorageFake({ books: { [BOOK_URL]: malformed } });
  const books = createBooksStorage({ storageArea: fake.local, lockManager: fake.locks });
  let metadataCalls = 0;
  const harness = createHydrationHarness({
    getBook: books.getBook,
    getMetadata: async () => {
      metadataCalls += 1;
    },
    hydrateMetadata: books.hydrateMetadata,
  });

  await harness.start();

  assert.equal(metadataCalls, 0);
  assert.equal(harness.errors.length, 1);
  assert.ok(harness.errors[0] instanceof BooksStorageDataError);
  assert.deepEqual(fake.snapshot().books[BOOK_URL], malformed);
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
  harness.hydration.destroy();
});

test("a rejected metadata write is nonfatal and leaves state and timestamps unchanged", async () => {
  const existing = canonicalRecord();
  const fake = createChromeStorageFake({ books: { [BOOK_URL]: existing } });
  const books = createBooksStorage({ storageArea: fake.local, lockManager: fake.locks });
  const failure = new Error("metadata quota exceeded");
  fake.failNext("set", failure);
  const harness = createHydrationHarness({
    getBook: books.getBook,
    hydrateMetadata: books.hydrateMetadata,
  });

  await harness.start();

  assert.deepEqual(harness.errors, [failure]);
  assert.deepEqual(fake.snapshot().books[BOOK_URL], existing);
  harness.hydration.destroy();
});

test("untracked direct viewer use never fetches metadata or writes storage", async () => {
  let metadataCalls = 0;
  let writes = 0;
  const harness = createHydrationHarness({
    getBook: async () => undefined,
    getMetadata: async () => {
      metadataCalls += 1;
    },
    hydrateMetadata: async () => {
      writes += 1;
    },
  });
  await harness.start();

  assert.equal(metadataCalls, 0);
  assert.equal(writes, 0);
  harness.hydration.destroy();
});

test("metadata hydration serializes with concurrent position and rename updates", async () => {
  const existing = canonicalRecord({ customTitle: null });
  const fake = createChromeStorageFake({ books: { [BOOK_URL]: existing } });
  const dependencies = {
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => 1_800_000_000,
  };
  const metadataStore = createBooksStorage(dependencies);
  const positionStore = createBooksStorage(dependencies);
  const renameStore = createBooksStorage(dependencies);
  const heldWrite = fake.holdNext("set");

  const metadataWrite = metadataStore.hydrateMetadata(BOOK_URL, {
    title: "Metadata title",
    totalPages: 7,
  });
  await heldWrite.started;
  const positionWrite = positionStore.updatePosition(BOOK_URL, {
    currentPage: 4,
    scrollTop: 700,
  });
  const renameWrite = renameStore.updateCustomTitle(BOOK_URL, "Renamed");
  heldWrite.release();
  await Promise.all([metadataWrite, positionWrite, renameWrite]);

  assert.deepEqual(fake.snapshot().books[BOOK_URL], {
    ...existing,
    title: "Metadata title",
    customTitle: "Renamed",
    totalPages: 7,
    currentPage: 4,
    scrollTop: 700,
    lastReadAt: 1_800_000_000,
  });
});

test("competing hydration attempts write once and preserve the first durable result", async () => {
  const existing = canonicalRecord();
  const fake = createChromeStorageFake({ books: { [BOOK_URL]: existing } });
  const firstStore = createBooksStorage({ storageArea: fake.local, lockManager: fake.locks });
  const secondStore = createBooksStorage({ storageArea: fake.local, lockManager: fake.locks });
  const heldWrite = fake.holdNext("set");

  const firstHydration = firstStore.hydrateMetadata(BOOK_URL, {
    title: "First title",
    totalPages: 7,
  });
  await heldWrite.started;
  const secondHydration = secondStore.hydrateMetadata(BOOK_URL, {
    title: "Competing title",
    totalPages: 9,
  });
  heldWrite.release();

  const expected = { ...existing, title: "First title", totalPages: 7 };
  assert.deepEqual(await firstHydration, expected);
  assert.deepEqual(await secondHydration, expected);
  assert.deepEqual(fake.snapshot().books[BOOK_URL], expected);
  assert.equal(
    fake.operations.filter(({ method, phase }) => method === "set" && phase === "start").length,
    1,
  );
});

test("an untrack queued after hydration still leaves the book absent", async () => {
  const existing = canonicalRecord();
  const fake = createChromeStorageFake({ books: { [BOOK_URL]: existing } });
  const metadataStore = createBooksStorage({ storageArea: fake.local, lockManager: fake.locks });
  const removeStore = createBooksStorage({ storageArea: fake.local, lockManager: fake.locks });
  const heldWrite = fake.holdNext("set");

  const hydration = metadataStore.hydrateMetadata(BOOK_URL, {
    title: "Hydrated title",
    totalPages: 7,
  });
  await heldWrite.started;
  const removal = removeStore.removeBook(BOOK_URL);
  heldWrite.release();

  assert.deepEqual(await hydration, {
    ...existing,
    title: "Hydrated title",
    totalPages: 7,
  });
  assert.equal(await removal, true);
  assert.deepEqual(fake.snapshot().books, {});
});

test("an untrack that wins the lock prevents stale hydration from recreating the record", async () => {
  const fake = createChromeStorageFake({ books: { [BOOK_URL]: canonicalRecord() } });
  const removeStore = createBooksStorage({ storageArea: fake.local, lockManager: fake.locks });
  const metadataStore = createBooksStorage({ storageArea: fake.local, lockManager: fake.locks });
  const heldRead = fake.holdNext("get", { after: true });

  const removal = removeStore.removeBook(BOOK_URL);
  await heldRead.started;
  const hydration = metadataStore.hydrateMetadata(BOOK_URL, {
    title: "Stale title",
    totalPages: 7,
  });
  heldRead.release();

  assert.equal(await removal, true);
  assert.equal(await hydration, undefined);
  assert.deepEqual(fake.snapshot().books, {});
});

test("document replacement aborts a pending result and removes every listener", async () => {
  const metadata = deferred();
  const writes = [];
  const harness = createHydrationHarness({
    getMetadata: () => metadata.promise,
    hydrateMetadata: async (...args) => writes.push(args),
  });
  harness.frame.dispatch("load");
  await drainMicrotasks();

  assert.equal(harness.eventBus.listenerCount("pagesinit"), 1);
  assert.equal(harness.eventBus.listenerCount("pagesdestroy"), 1);
  harness.application.pdfDocument = { numPages: 2 };
  harness.eventBus.dispatch("pagesdestroy", { source: harness.application.pdfViewer });
  metadata.resolve({ info: { Title: "Stale title" } });
  await harness.hydration.settled();

  assert.deepEqual(writes, []);
  assert.equal(harness.eventBus.listenerCount("pagesinit"), 0);
  assert.equal(harness.eventBus.listenerCount("pagesdestroy"), 0);
  harness.hydration.destroy();
  assert.equal(harness.frame.listenerCount("load"), 0);
  assert.equal(harness.time.pendingCount(), 0);
});

test("an aborted storage hydration does not write after its read completes", async () => {
  const fake = createChromeStorageFake({ books: { [BOOK_URL]: canonicalRecord() } });
  const books = createBooksStorage({ storageArea: fake.local, lockManager: fake.locks });
  const heldRead = fake.holdNext("get", { after: true });
  const controller = new AbortController();

  const hydration = books.hydrateMetadata(
    BOOK_URL,
    { title: "Stale title", totalPages: 7 },
    { signal: controller.signal },
  );
  await heldRead.started;
  controller.abort();
  heldRead.release();

  assert.equal(await hydration, undefined);
  assert.deepEqual(fake.snapshot().books[BOOK_URL], canonicalRecord());
  assert.equal(fake.operations.filter(({ method }) => method === "set").length, 0);
});
