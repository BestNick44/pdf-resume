import assert from "node:assert/strict";
import test from "node:test";

import { createBooksStorage } from "../storage/books.mjs";
import { createPdfJsPositionTracking } from "../viewer/pdfjs-position-tracking.mjs";
import { createPositionSaveController } from "../viewer/position-save-controller.mjs";
import { createChromeStorageFake } from "./support/chrome-storage-fake.mjs";
import { createFakeScheduler } from "./support/fake-scheduler.mjs";

const BOOK_URL = "file:///Users/reader/Books/A%20Book.pdf";
const BLOB_URL = "blob:chrome-extension://abcdefghijkl/document-id";

function canonicalRecord(overrides = {}) {
  return {
    title: "A Book",
    customTitle: "Keep me",
    totalPages: 20,
    currentPage: 1,
    scrollTop: 0,
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

function createController({ initialPosition = { currentPage: 1, scrollTop: 0 }, update } = {}) {
  const time = createFakeScheduler();
  const calls = [];
  const controller = createPositionSaveController({
    fileUrl: BOOK_URL,
    initialPosition,
    updatePosition:
      update ??
      (async (fileUrl, position) => {
        calls.push({ fileUrl, position });
        return { ...canonicalRecord(), ...position };
      }),
    scheduler: time.scheduler,
    clock: time.clock,
  });
  return { calls, controller, time };
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

class FakeEventBus {
  listeners = new Map();

  on(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  off(type, listener) {
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

function createPdfJsHarness({ getBook = async () => canonicalRecord(), updatePosition } = {}) {
  const time = createFakeScheduler();
  const hostDocument = new FakeEventTarget();
  hostDocument.visibilityState = "visible";
  const hostWindow = new FakeEventTarget();
  const container = new FakeEventTarget();
  container.scrollTop = 0;
  const eventBus = new FakeEventBus();
  const initialized = deferred();
  const firstDocument = { id: "first" };
  const application = {
    appConfig: { mainContainer: container },
    eventBus,
    initializedPromise: initialized.promise,
    pdfDocument: null,
    pdfViewer: { currentPageNumber: 1, pagesCount: 0 },
  };
  const frame = new FakeEventTarget();
  frame.contentWindow = { PDFViewerApplication: application };
  const calls = [];
  const tracking = createPdfJsPositionTracking({
    fileUrl: BOOK_URL,
    frame,
    hostDocument,
    hostWindow,
    getBook,
    updatePosition:
      updatePosition ??
      (async (fileUrl, position) => {
        calls.push({ fileUrl, position });
        return { ...canonicalRecord(), ...position };
      }),
    scheduler: time.scheduler,
    clock: time.clock,
  });

  async function ready(documentIdentity = firstDocument) {
    frame.dispatch("load");
    initialized.resolve();
    await Promise.resolve();
    application.pdfDocument = documentIdentity;
    application.pdfViewer.pagesCount = 20;
    eventBus.dispatch("pagesinit", { source: application.pdfViewer });
    await Promise.resolve();
    await Promise.resolve();
  }

  return {
    application,
    calls,
    container,
    eventBus,
    firstDocument,
    frame,
    hostDocument,
    hostWindow,
    ready,
    time,
    tracking,
  };
}

test("page-only and scroll-only changes save the complete current position", async () => {
  const { calls, controller, time } = createController();

  controller.observe({ currentPage: 2, scrollTop: 0 });
  time.advanceBy(1_000);
  await controller.settled();
  controller.observe({ currentPage: 2, scrollTop: 325.5 });
  time.advanceBy(1_000);
  await controller.settled();

  assert.deepEqual(calls, [
    {
      fileUrl: BOOK_URL,
      position: { currentPage: 2, scrollTop: 0 },
    },
    {
      fileUrl: BOOK_URL,
      position: { currentPage: 2, scrollTop: 325.5 },
    },
  ]);
});

test("trailing debounce coalesces bursts and honors the exact deadline", async () => {
  const { calls, controller, time } = createController();

  controller.observe({ currentPage: 2, scrollTop: 10 });
  time.advanceBy(999);
  assert.equal(calls.length, 0);
  controller.observe({ currentPage: 3, scrollTop: 20 });
  time.advanceBy(999);
  assert.equal(calls.length, 0);
  time.advanceBy(1);
  await controller.settled();

  assert.deepEqual(calls, [
    {
      fileUrl: BOOK_URL,
      position: { currentPage: 3, scrollTop: 20 },
    },
  ]);
});

test("duplicate events and already persisted positions do not write", async () => {
  const { calls, controller, time } = createController({
    initialPosition: { currentPage: 4, scrollTop: 90 },
  });

  controller.observe({ currentPage: 4, scrollTop: 90 });
  controller.observe({ currentPage: 5, scrollTop: 100 });
  controller.observe({ currentPage: 5, scrollTop: 100 });
  time.advanceBy(1_000);
  await controller.settled();
  controller.observe({ currentPage: 5, scrollTop: 100 });
  time.advanceBy(2_000);
  await controller.settled();

  assert.equal(calls.length, 1);
});

test("overlapping saves are serialized and the newest snapshot wins", async () => {
  const firstWrite = deferred();
  const calls = [];
  const { controller, time } = createController({
    update: async (fileUrl, position) => {
      calls.push({ fileUrl, position });
      if (calls.length === 1) {
        await firstWrite.promise;
      }
      return { ...canonicalRecord(), ...position };
    },
  });

  controller.observe({ currentPage: 2, scrollTop: 10 });
  time.advanceBy(1_000);
  await Promise.resolve();
  controller.observe({ currentPage: 7, scrollTop: 700 });
  time.advanceBy(1_000);
  assert.equal(calls.length, 1);
  firstWrite.resolve();
  await controller.settled();

  assert.deepEqual(calls.map(({ position }) => position), [
    { currentPage: 2, scrollTop: 10 },
    { currentPage: 7, scrollTop: 700 },
  ]);
});

test("a failed snapshot is retained and retried without an unhandled rejection", async () => {
  const calls = [];
  let shouldFail = true;
  const { controller, time } = createController({
    update: async (fileUrl, position) => {
      calls.push({ fileUrl, position });
      if (shouldFail) {
        shouldFail = false;
        throw new Error("storage unavailable");
      }
      return { ...canonicalRecord(), ...position };
    },
  });

  controller.observe({ currentPage: 6, scrollTop: 60 });
  time.advanceBy(1_000);
  await controller.settled();
  assert.equal(calls.length, 1);
  controller.observe({ currentPage: 6, scrollTop: 60 });
  time.advanceBy(1_000);
  await controller.settled();

  assert.deepEqual(calls.map(({ position }) => position), [
    { currentPage: 6, scrollTop: 60 },
    { currentPage: 6, scrollTop: 60 },
  ]);
});

test("flush cancels debounce and immediately enters the ordered save path", async () => {
  const { calls, controller, time } = createController();

  controller.observe({ currentPage: 9, scrollTop: 900 });
  assert.equal(time.pendingCount(), 1);
  await controller.flush();

  assert.equal(time.pendingCount(), 0);
  assert.deepEqual(calls[0].position, { currentPage: 9, scrollTop: 900 });
});

test("PDF.js tracking waits for iframe, application, viewer, and tracked-book readiness", async () => {
  const bookRead = deferred();
  const harness = createPdfJsHarness({ getBook: () => bookRead.promise });

  harness.frame.dispatch("load");
  harness.application.pdfDocument = harness.firstDocument;
  harness.application.pdfViewer.pagesCount = 20;
  harness.eventBus.dispatch("pagesinit", { source: harness.application.pdfViewer });
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  harness.application.initializedPromise.then(() => {});
  bookRead.resolve(canonicalRecord());
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);

  harness.application.pdfDocument = null;
  harness.frame.contentWindow.PDFViewerApplication._testReady = true;
  // Resolve initialization only after the early viewer event has been ignored.
  const initializedApplication = harness.application;
  Object.defineProperty(initializedApplication, "initializedPromise", {
    configurable: true,
    value: Promise.resolve(),
  });
  harness.frame.dispatch("load");
  await Promise.resolve();
  initializedApplication.pdfDocument = harness.firstDocument;
  harness.eventBus.dispatch("pagesinit", { source: initializedApplication.pdfViewer });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  assert.equal(harness.eventBus.listenerCount("updateviewarea"), 1);
  harness.tracking.destroy();
});

test("real PDF.js page and canonical container scroll events are coalesced", async () => {
  const harness = createPdfJsHarness();
  await harness.ready();

  harness.application.pdfViewer.currentPageNumber = 3;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.container.scrollTop = 480;
  harness.container.dispatch("scroll");
  harness.eventBus.dispatch("updateviewarea", { source: harness.application.pdfViewer });
  harness.time.advanceBy(1_000);
  await harness.tracking.settled();

  assert.deepEqual(harness.calls, [
    {
      fileUrl: BOOK_URL,
      position: { currentPage: 3, scrollTop: 480 },
    },
  ]);
  assert.notEqual(harness.calls[0].fileUrl, BLOB_URL);
  harness.tracking.destroy();
});

test("untracked and missing records never register position listeners or create records", async () => {
  const harness = createPdfJsHarness({ getBook: async () => undefined });
  await harness.ready();

  harness.application.pdfViewer.currentPageNumber = 4;
  harness.container.scrollTop = 200;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.container.dispatch("scroll");
  harness.time.advanceBy(1_000);
  await harness.tracking.settled();

  assert.deepEqual(harness.calls, []);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  harness.tracking.destroy();
});

test("pagehide and hidden visibility flush the latest live PDF.js position", async () => {
  const harness = createPdfJsHarness();
  await harness.ready();

  harness.application.pdfViewer.currentPageNumber = 8;
  harness.container.scrollTop = 810;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.hostWindow.dispatch("pagehide");
  await harness.tracking.settled();
  harness.application.pdfViewer.currentPageNumber = 9;
  harness.container.scrollTop = 920;
  harness.eventBus.dispatch("updateviewarea", { source: harness.application.pdfViewer });
  harness.hostDocument.visibilityState = "hidden";
  harness.hostDocument.dispatch("visibilitychange");
  await harness.tracking.settled();

  assert.deepEqual(harness.calls.map(({ position }) => position), [
    { currentPage: 8, scrollTop: 810 },
    { currentPage: 9, scrollTop: 920 },
  ]);
  harness.tracking.destroy();
});

test("listeners are registered once and removed on teardown or document replacement", async () => {
  const harness = createPdfJsHarness();
  await harness.ready();

  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  assert.equal(harness.container.listenerCount("scroll"), 1);
  const replacement = { id: "replacement" };
  harness.application.pdfDocument = replacement;
  harness.eventBus.dispatch("pagesinit", { source: harness.application.pdfViewer });
  await Promise.resolve();
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  assert.equal(harness.container.listenerCount("scroll"), 0);
  harness.application.pdfViewer.currentPageNumber = 11;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.time.advanceBy(1_000);
  await harness.tracking.settled();
  assert.deepEqual(harness.calls, []);

  harness.tracking.destroy();
  assert.equal(harness.frame.listenerCount("load"), 0);
  assert.equal(harness.hostWindow.listenerCount("pagehide"), 0);
  assert.equal(harness.hostDocument.listenerCount("visibilitychange"), 0);
  assert.equal(harness.eventBus.listenerCount("pagesinit"), 0);
});

test("actual storage update preserves metadata and advances its module-managed timestamp", async () => {
  const existing = canonicalRecord();
  const fake = createChromeStorageFake({ books: { [BOOK_URL]: existing } });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => 1_800_000_000,
  });
  const { controller } = createController({
    initialPosition: existing,
    update: storage.updatePosition,
  });

  controller.observe({ currentPage: 10, scrollTop: 1_010 });
  await controller.flush();

  assert.deepEqual(fake.snapshot().books[BOOK_URL], {
    ...existing,
    currentPage: 10,
    scrollTop: 1_010,
    lastReadAt: 1_800_000_000,
  });
});
