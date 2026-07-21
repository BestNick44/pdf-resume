import assert from "node:assert/strict";
import test from "node:test";

import {
  BooksStorageDataError,
  createBooksStorage,
} from "../storage/books.mjs";
import {
  createPositionUpdateClient,
  createPositionUpdateMessageHandler,
} from "../shared/position-update-messaging.mjs";
import { createPdfJsPositionTracking } from "../viewer/pdfjs-position-tracking.mjs";
import { createPositionSaveController } from "../viewer/position-save-controller.mjs";
import { startViewerApp } from "../viewer/viewer-app.mjs";
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

async function drainMicrotasks() {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
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

function createController({
  initialPosition = { currentPage: 1, scrollTop: 0 },
  retryDelaysMilliseconds,
  update,
} = {}) {
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
    retryDelaysMilliseconds,
  });
  return { calls, controller, time };
}

function createMessageBridge(handler, extensionId = "abcdefghijkl") {
  const keptAlive = [];
  const responses = [];
  return {
    keptAlive,
    responses,
    sendMessage(message) {
      const response = new Promise((resolve) => {
        keptAlive.push(handler(message, { id: extensionId }, resolve));
      });
      responses.push(response);
      return response;
    },
  };
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

function createPdfJsHarness({
  createRestoreLifecycle,
  createSaveController,
  getBook = async () => canonicalRecord(),
  handoffPosition = () => {},
  initialReadRetryDelays,
  reportError,
  restorePosition,
  updatePosition,
} = {}) {
  const time = createFakeScheduler();
  const hostDocument = new FakeEventTarget();
  hostDocument.visibilityState = "visible";
  const container = new FakeEventTarget();
  container.clientHeight = 600;
  container.scrollHeight = 4_000;
  container.scrollTop = 0;
  const eventBus = new FakeEventBus();
  const initialized = deferred();
  const firstDocument = { id: "first", numPages: 20 };
  const pageViews = Array.from({ length: 20 }, () => ({ renderingState: 0 }));
  let currentPageNumber = 1;
  const application = {
    appConfig: { mainContainer: container },
    eventBus,
    initializedPromise: initialized.promise,
    isInitialViewSet: true,
    pdfDocument: null,
    pdfViewer: {
      get currentPageNumber() {
        return currentPageNumber;
      },
      set currentPageNumber(value) {
        currentPageNumber = value;
        eventBus.dispatch("pagechanging", { source: application.pdfViewer });
      },
      getPageView(index) {
        return pageViews[index];
      },
      pagesCount: 0,
      pagesPromise: Promise.resolve(),
    },
  };
  const frame = new FakeEventTarget();
  const frameWindow = new FakeEventTarget();
  frameWindow.PDFViewerApplication = application;
  frame.contentWindow = frameWindow;
  const calls = [];
  const errors = [];
  const tracking = createPdfJsPositionTracking({
    fileUrl: BOOK_URL,
    frame,
    hostDocument,
    createRestoreLifecycle,
    createSaveController,
    getBook,
    handoffPosition,
    initialReadRetryDelays,
    reportError: reportError ?? ((error) => errors.push(error)),
    restorePosition,
    updatePosition:
      updatePosition ??
      (async (fileUrl, position) => {
        calls.push({ fileUrl, position });
        return { ...canonicalRecord(), ...position };
      }),
    scheduler: time.scheduler,
    clock: time.clock,
  });

  async function finishRestore() {
    time.advanceBy(16);
    await drainMicrotasks();
    const pageNumber = application.pdfViewer.currentPageNumber;
    pageViews[pageNumber - 1].renderingState = 3;
    eventBus.dispatch("pagerendered", {
      pageNumber,
      source: pageViews[pageNumber - 1],
    });
    await drainMicrotasks();
    time.advanceBy(16);
    await drainMicrotasks();
    time.advanceBy(16);
    await drainMicrotasks();
  }

  async function begin(documentIdentity = firstDocument) {
    frame.dispatch("load");
    initialized.resolve();
    await Promise.resolve();
    application.pdfDocument = documentIdentity;
    application.pdfViewer.pagesCount = documentIdentity.numPages ?? 20;
    eventBus.dispatch("pagesinit", { source: application.pdfViewer });
    await drainMicrotasks();
  }

  async function ready(documentIdentity = firstDocument) {
    await begin(documentIdentity);
    await finishRestore();
  }

  return {
    application,
    begin,
    calls,
    container,
    errors,
    eventBus,
    finishRestore,
    firstDocument,
    frame,
    frameWindow,
    hostDocument,
    initialized,
    pageViews,
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

test("a failed snapshot retries automatically without an unhandled rejection", async () => {
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
  assert.equal(time.pendingCount(), 1);
  time.advanceBy(250);
  await controller.settled();

  assert.deepEqual(calls.map(({ position }) => position), [
    { currentPage: 6, scrollTop: 60 },
    { currentPage: 6, scrollTop: 60 },
  ]);
});

test("automatic save retries are bounded and settled reports pending durability", async () => {
  const calls = [];
  const { controller, time } = createController({
    retryDelaysMilliseconds: [100, 200],
    update: async (fileUrl, position) => {
      calls.push({ fileUrl, position });
      throw new Error("storage unavailable");
    },
  });

  controller.observe({ currentPage: 6, scrollTop: 60 });
  time.advanceBy(1_000);
  assert.deepEqual(await controller.settled(), {
    disabled: false,
    durable: false,
    pending: true,
    retryPending: true,
  });
  time.advanceBy(99);
  assert.equal(calls.length, 1);
  time.advanceBy(1);
  await controller.settled();
  time.advanceBy(199);
  assert.equal(calls.length, 2);
  time.advanceBy(1);
  assert.deepEqual(await controller.settled(), {
    disabled: false,
    durable: false,
    pending: true,
    retryPending: false,
  });
  assert.equal(calls.length, 3);
  time.advanceBy(10_000);
  assert.equal(calls.length, 3, "terminal attempts must not spin forever");

  await controller.flush();
  assert.equal(calls.length, 4, "a later lifecycle flush retries the retained snapshot");
  controller.destroy();
});

test("a newer observation replaces a failed in-flight snapshot before retry", async () => {
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

  controller.observe({ currentPage: 2, scrollTop: 20 });
  time.advanceBy(1_000);
  await Promise.resolve();
  controller.observe({ currentPage: 7, scrollTop: 700 });
  firstWrite.reject(new Error("old write failed"));
  await controller.settled();
  time.advanceBy(1_000);
  await controller.settled();

  assert.deepEqual(calls.map(({ position }) => position), [
    { currentPage: 2, scrollTop: 20 },
    { currentPage: 7, scrollTop: 700 },
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
  await drainMicrotasks();
  await harness.finishRestore(1);

  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  assert.equal(harness.eventBus.listenerCount("updateviewarea"), 1);
  harness.tracking.destroy();
});

test("a transient initial tracked-book read retries while the document remains active", async () => {
  let reads = 0;
  const harness = createPdfJsHarness({
    getBook: async () => {
      reads += 1;
      if (reads === 1) {
        throw new Error("storage temporarily unavailable");
      }
      return canonicalRecord();
    },
    initialReadRetryDelays: [250],
  });

  await harness.ready();
  assert.equal(reads, 1);
  assert.equal(
    harness.eventBus.listenerCount("pagechanging"),
    1,
    "the pre-read interaction monitor is already active",
  );
  assert.equal(harness.time.pendingCount(), 1);
  harness.time.advanceBy(250);
  await drainMicrotasks();
  await harness.finishRestore(1);
  await harness.tracking.settled();

  assert.equal(reads, 2);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  harness.tracking.destroy();
});

test("initial tracked-book retries are bounded, cancellable, and terminal for malformed state", async (t) => {
  await t.test("bounded transient failures", async () => {
    let reads = 0;
    const harness = createPdfJsHarness({
      getBook: async () => {
        reads += 1;
        throw new Error("storage unavailable");
      },
      initialReadRetryDelays: [100, 200],
    });

    await harness.ready();
    harness.time.advanceBy(100);
    await drainMicrotasks();
    harness.time.advanceBy(200);
    await harness.tracking.settled();
    assert.equal(reads, 3);
    assert.deepEqual(harness.errors.map((error) => error.message), ["storage unavailable"]);
    assert.equal(harness.time.pendingCount(), 0);
    assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
    harness.tracking.destroy();
  });

  await t.test("teardown cancellation", async () => {
    let reads = 0;
    const harness = createPdfJsHarness({
      getBook: async () => {
        reads += 1;
        throw new Error("storage unavailable");
      },
      initialReadRetryDelays: [100],
    });

    await harness.ready();
    assert.equal(harness.time.pendingCount(), 1);
    harness.tracking.destroy();
    assert.equal(harness.time.pendingCount(), 0);
    harness.time.advanceBy(100);
    assert.equal(reads, 1);
  });

  await t.test("document replacement cancellation", async () => {
    let reads = 0;
    const harness = createPdfJsHarness({
      getBook: async () => {
        reads += 1;
        throw new Error("storage unavailable");
      },
      initialReadRetryDelays: [100],
    });

    await harness.ready();
    assert.equal(harness.time.pendingCount(), 1);
    harness.application.pdfDocument = { id: "replacement", numPages: 2 };
    harness.eventBus.dispatch("pagesdestroy", { source: harness.application.pdfViewer });
    assert.equal(harness.time.pendingCount(), 0);
    harness.time.advanceBy(100);
    assert.equal(reads, 1);
    harness.tracking.destroy();
  });

  await t.test("malformed persisted state", async () => {
    let reads = 0;
    const harness = createPdfJsHarness({
      getBook: async () => {
        reads += 1;
        throw new BooksStorageDataError("stored books are malformed");
      },
      initialReadRetryDelays: [100, 200],
    });

    await harness.ready();
    await harness.tracking.settled();
    assert.equal(reads, 1);
    assert.deepEqual(harness.errors.map((error) => error.message), [
      "stored books are malformed",
    ]);
    assert.equal(harness.time.pendingCount(), 0);
    assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
    harness.tracking.destroy();
  });
});

test("target page render failure is reported and never arms tracking", async () => {
  const renderError = new Error("target canvas failed");
  const harness = createPdfJsHarness({
    getBook: async () => canonicalRecord({ currentPage: 6, scrollTop: 600 }),
  });
  await harness.begin();
  harness.time.advanceBy(16);
  await drainMicrotasks();
  const targetView = harness.application.pdfViewer.getPageView(5);
  targetView.renderingState = 3;
  harness.eventBus.dispatch("pagerendered", {
    error: renderError,
    pageNumber: 6,
    source: targetView,
  });
  await harness.tracking.settled();

  assert.deepEqual(harness.errors, [renderError]);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  assert.equal(harness.hostDocument.listenerCount("visibilitychange"), 0);
  harness.tracking.destroy();
});

test("a cached FINISHED target render error is retained across the tracked-book read", async () => {
  const bookRead = deferred();
  const renderError = new Error("cached target canvas failed");
  const harness = createPdfJsHarness({ getBook: () => bookRead.promise });
  await harness.begin();

  assert.equal(harness.eventBus.listenerCount("pagerendered"), 1);
  const targetView = harness.application.pdfViewer.getPageView(5);
  targetView.renderingState = 3;
  harness.eventBus.dispatch("pagerendered", {
    error: renderError,
    pageNumber: 6,
    source: targetView,
  });
  bookRead.resolve(canonicalRecord({ currentPage: 6, scrollTop: 600 }));
  await drainMicrotasks();
  harness.time.advanceBy(16);
  await harness.tracking.settled();

  assert.deepEqual(harness.errors, [renderError]);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  assert.equal(
    harness.eventBus.listenerCount("pagerendered"),
    1,
    "the document-scoped outcome listener remains available until retirement",
  );
  harness.tracking.destroy();
  assert.equal(harness.eventBus.listenerCount("pagerendered"), 0);
});

test("render outcomes are keyed by exact page view and replaced by the latest result", async () => {
  const bookRead = deferred();
  const staleError = new Error("stale canvas failure");
  const harness = createPdfJsHarness({ getBook: () => bookRead.promise });
  await harness.begin();
  const targetView = harness.application.pdfViewer.getPageView(5);
  targetView.renderingState = 3;

  harness.eventBus.dispatch("pagerendered", {
    error: staleError,
    pageNumber: 6,
    source: harness.application.pdfViewer.getPageView(4),
  });
  harness.eventBus.dispatch("pagerendered", {
    error: staleError,
    pageNumber: 6,
    source: targetView,
  });
  harness.eventBus.dispatch("pagerendered", {
    error: null,
    pageNumber: 6,
    source: targetView,
  });
  bookRead.resolve(canonicalRecord({ currentPage: 6, scrollTop: 600 }));
  await drainMicrotasks();
  harness.time.advanceBy(16);
  await drainMicrotasks();
  harness.time.advanceBy(16);
  await drainMicrotasks();
  harness.time.advanceBy(16);
  await harness.tracking.settled();

  assert.deepEqual(harness.errors, []);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  harness.tracking.destroy();
});

test("tracked canonical position restores without an initialization write or handoff", async () => {
  const reads = [];
  const handoffs = [];
  const saved = canonicalRecord({ currentPage: 3, scrollTop: 480 });
  const harness = createPdfJsHarness({
    async getBook(fileUrl) {
      reads.push(fileUrl);
      return saved;
    },
    handoffPosition(fileUrl, position) {
      handoffs.push({ fileUrl, position });
    },
  });

  await harness.ready();
  harness.time.advanceBy(5_000);
  await harness.tracking.settled();
  harness.tracking.handoff();

  assert.deepEqual(reads, [BOOK_URL]);
  assert.equal(harness.application.pdfViewer.currentPageNumber, 3);
  assert.equal(harness.container.scrollTop, 480);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(handoffs, [], "restoration alone must not advance lastReadAt");
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  harness.tracking.destroy();
});

test("reopening the same canonical URL restores independently and cleans each listener set", async () => {
  const reads = [];
  const savedPositions = [
    canonicalRecord({ currentPage: 2, scrollTop: 220 }),
    canonicalRecord({ currentPage: 6, scrollTop: 660 }),
  ];

  for (const saved of savedPositions) {
    const harness = createPdfJsHarness({
      async getBook(fileUrl) {
        reads.push(fileUrl);
        return saved;
      },
    });
    await harness.ready();
    assert.equal(harness.application.pdfViewer.currentPageNumber, saved.currentPage);
    assert.equal(harness.container.scrollTop, saved.scrollTop);
    assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
    harness.tracking.destroy();
    assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  }

  assert.deepEqual(reads, [BOOK_URL, BOOK_URL]);
});

test("programmatic restore events cannot clobber the saved baseline before the handoff", async () => {
  let starts = 0;
  const harness = createPdfJsHarness({
    getBook: async () => canonicalRecord({ currentPage: 8, scrollTop: 800 }),
    async restorePosition({ application, container, eventBus, startTracking }) {
      application.pdfViewer.currentPageNumber = 1;
      container.scrollTop = 0;
      eventBus.dispatch("pagechanging", { source: application.pdfViewer });
      container.dispatch("scroll");
      eventBus.dispatch("updateviewarea", { source: application.pdfViewer });
      await drainMicrotasks();
      application.pdfViewer.currentPageNumber = 8;
      container.scrollTop = 800;
      starts += 1;
      startTracking(
        { currentPage: 8, scrollTop: 800 },
        { currentPage: 8, scrollTop: 800 },
      );
    },
  });

  await harness.ready();
  harness.time.advanceBy(5_000);
  await harness.tracking.settled();

  assert.equal(starts, 1);
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  harness.tracking.destroy();
});

test("a genuine interaction before saved scroll application is saved exactly once", async () => {
  const harness = createPdfJsHarness({
    getBook: async () => canonicalRecord({ currentPage: 4, scrollTop: 400 }),
  });
  await harness.begin();
  harness.time.advanceBy(16);
  await drainMicrotasks();
  assert.equal(harness.application.pdfViewer.currentPageNumber, 4);

  harness.frameWindow.dispatch("wheel", { isTrusted: true });
  harness.application.pdfViewer.currentPageNumber = 5;
  harness.container.scrollTop = 550;
  const targetView = harness.application.pdfViewer.getPageView(3);
  targetView.renderingState = 3;
  harness.eventBus.dispatch("pagerendered", {
    pageNumber: 4,
    source: targetView,
  });
  await drainMicrotasks();
  harness.time.advanceBy(16);
  await harness.tracking.settled();
  assert.equal(harness.container.scrollTop, 550, "saved scroll must not overwrite the user");

  harness.time.advanceBy(1_000);
  await harness.tracking.settled();
  assert.deepEqual(harness.calls.map(({ position }) => position), [
    { currentPage: 5, scrollTop: 550 },
  ]);
  harness.time.advanceBy(5_000);
  await harness.tracking.settled();
  assert.equal(harness.calls.length, 1);
  harness.tracking.destroy();
});

test("trusted actions correlate delayed canonical movement and hand it to one tracker", async () => {
  const bookRead = deferred();
  let controllerCreations = 0;
  const harness = createPdfJsHarness({
    createSaveController(options) {
      controllerCreations += 1;
      return createPositionSaveController(options);
    },
    getBook: () => bookRead.promise,
  });
  await harness.begin();

  harness.frameWindow.dispatch("wheel", { isTrusted: true });
  for (let frame = 0; frame < 4; frame += 1) {
    harness.time.advanceBy(16);
  }
  harness.application.pdfViewer.currentPageNumber = 5;
  harness.container.scrollTop = 550;
  harness.eventBus.dispatch("pagechanging", {
    source: harness.application.pdfViewer,
  });
  bookRead.resolve(canonicalRecord({ currentPage: 4, scrollTop: 400 }));
  await drainMicrotasks();
  harness.time.advanceBy(16);
  await drainMicrotasks();

  assert.equal(controllerCreations, 1);
  assert.equal(harness.application.pdfViewer.currentPageNumber, 5);
  assert.equal(harness.container.scrollTop, 550);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  assert.equal(harness.container.listenerCount("scroll"), 1);
  assert.equal(harness.frameWindow.listenerCount("wheel"), 0);

  harness.time.advanceBy(1_000);
  await harness.tracking.settled();
  assert.deepEqual(harness.calls.map(({ position }) => position), [
    { currentPage: 5, scrollTop: 550 },
  ]);
  harness.tracking.destroy();
});

test("pointer and touch drags remain genuine through completion across many frames", async (t) => {
  for (const gesture of [
    { end: "pointerup", name: "pointer", start: "pointerdown" },
    { end: "touchend", name: "touch", start: "touchstart" },
  ]) {
    await t.test(gesture.name, async () => {
      const bookRead = deferred();
      const harness = createPdfJsHarness({ getBook: () => bookRead.promise });
      await harness.begin();

      harness.frameWindow.dispatch(gesture.start, {
        isTrusted: true,
        type: gesture.start,
      });
      harness.time.advanceBy(1_000);
      harness.frameWindow.dispatch(gesture.end, {
        isTrusted: true,
        type: gesture.end,
      });
      harness.time.advanceBy(100);
      harness.application.pdfViewer.currentPageNumber = 7;
      harness.container.scrollTop = 770;
      harness.container.dispatch("scroll");
      bookRead.resolve(canonicalRecord({ currentPage: 4, scrollTop: 400 }));
      await drainMicrotasks();
      harness.time.advanceBy(16);
      await drainMicrotasks();

      assert.equal(harness.application.pdfViewer.currentPageNumber, 7);
      assert.equal(harness.container.scrollTop, 770);
      assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
      assert.equal(harness.frameWindow.listenerCount(gesture.start), 0);
      harness.tracking.destroy();
    });
  }
});

test("pure clicks, expired intent, and programmatic changes do not clobber restore", async (t) => {
  await t.test("an active pure click does not claim restore-owned navigation", async () => {
    const bookRead = deferred();
    const harness = createPdfJsHarness({ getBook: () => bookRead.promise });
    await harness.begin();

    harness.frameWindow.dispatch("click", { isTrusted: true });
    bookRead.resolve(canonicalRecord({ currentPage: 4, scrollTop: 400 }));
    await drainMicrotasks();
    await harness.finishRestore();
    await harness.tracking.settled();

    assert.equal(harness.application.pdfViewer.currentPageNumber, 4);
    assert.equal(harness.container.scrollTop, 400);
    assert.deepEqual(harness.calls, []);
    harness.tracking.destroy();
  });

  await t.test("expired intent does not claim a later programmatic change", async () => {
    const bookRead = deferred();
    const harness = createPdfJsHarness({ getBook: () => bookRead.promise });
    await harness.begin();

    harness.frameWindow.dispatch("click", { isTrusted: true });
    harness.time.advanceBy(1_000);
    harness.application.pdfViewer.currentPageNumber = 9;
    harness.container.scrollTop = 990;
    harness.eventBus.dispatch("updateviewarea", {
      source: harness.application.pdfViewer,
    });
    bookRead.resolve(canonicalRecord({ currentPage: 4, scrollTop: 400 }));
    await drainMicrotasks();
    await harness.finishRestore();
    await harness.tracking.settled();

    assert.equal(harness.application.pdfViewer.currentPageNumber, 4);
    assert.equal(harness.container.scrollTop, 400);
    harness.time.advanceBy(5_000);
    await harness.tracking.settled();
    assert.deepEqual(harness.calls, []);
    harness.tracking.destroy();
  });
});

test("pagehide during restore hands off only a genuine changed position", async (t) => {
  await t.test("genuine changed position", async () => {
    const handoffs = [];
    const harness = createPdfJsHarness({
      getBook: async () => canonicalRecord({ currentPage: 4, scrollTop: 400 }),
      handoffPosition(fileUrl, position) {
        handoffs.push({ fileUrl, position });
      },
    });
    await harness.begin();
    harness.time.advanceBy(16);
    await drainMicrotasks();
    harness.frameWindow.dispatch("keydown", { isTrusted: true });
    harness.application.pdfViewer.currentPageNumber = 5;
    harness.container.scrollTop = 550;
    harness.eventBus.dispatch("pagechanging", {
      source: harness.application.pdfViewer,
    });

    harness.tracking.handoff();
    harness.tracking.handoff();
    assert.deepEqual(handoffs, [
      {
        fileUrl: BOOK_URL,
        position: { currentPage: 5, scrollTop: 550 },
      },
    ]);
    harness.tracking.destroy();
  });

  await t.test("programmatic default change", async () => {
    const handoffs = [];
    const harness = createPdfJsHarness({
      getBook: async () => canonicalRecord({ currentPage: 4, scrollTop: 400 }),
      handoffPosition(...args) {
        handoffs.push(args);
      },
    });
    await harness.begin();
    harness.application.pdfViewer.currentPageNumber = 1;
    harness.container.scrollTop = 0;

    harness.tracking.handoff();
    assert.deepEqual(handoffs, []);
    harness.tracking.destroy();
  });

  await t.test("trusted interaction without a position change", async () => {
    const handoffs = [];
    const harness = createPdfJsHarness({
      getBook: async () => canonicalRecord({ currentPage: 4, scrollTop: 400 }),
      handoffPosition(...args) {
        handoffs.push(args);
      },
    });
    await harness.begin();
    harness.frameWindow.dispatch("click", { isTrusted: true });
    await harness.finishRestore();
    harness.time.advanceBy(5_000);
    await harness.tracking.settled();

    harness.tracking.handoff();
    assert.deepEqual(handoffs, []);
    assert.deepEqual(harness.calls, []);
    harness.tracking.destroy();
  });
});

test("pagehide during a pending tracked-book read hands off only genuine position activity", async (t) => {
  await t.test("genuine activity sends one snapshot and missing storage safely no-ops", async () => {
    const bookRead = deferred();
    const fake = createChromeStorageFake();
    const storage = createBooksStorage({
      storageArea: fake.local,
      lockManager: fake.locks,
    });
    let workerCalls = 0;
    const handler = createPositionUpdateMessageHandler({
      extensionId: "abcdefghijkl",
      updatePosition(...args) {
        workerCalls += 1;
        return storage.updatePosition(...args);
      },
    });
    const bridge = createMessageBridge(handler);
    const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });
    const harness = createPdfJsHarness({
      getBook: () => bookRead.promise,
      handoffPosition: client.handoffPosition,
    });
    await harness.begin();

    harness.frameWindow.dispatch("keydown", { isTrusted: true });
    harness.application.pdfViewer.currentPageNumber = 5;
    harness.container.scrollTop = 550;
    harness.eventBus.dispatch("pagechanging", {
      source: harness.application.pdfViewer,
    });
    harness.tracking.handoff();
    harness.tracking.handoff();
    harness.tracking.destroy();
    await Promise.all(bridge.responses);

    assert.equal(workerCalls, 1);
    assert.deepEqual(fake.snapshot(), {}, "the worker must not create an untracked book");
    assert.equal(harness.frameWindow.listenerCount("keydown"), 0);
    bookRead.resolve(undefined);
  });

  await t.test("genuine activity during a scheduled read retry sends one snapshot", async () => {
    const handoffs = [];
    const harness = createPdfJsHarness({
      getBook: async () => {
        throw new Error("storage temporarily unavailable");
      },
      handoffPosition(fileUrl, position) {
        handoffs.push({ fileUrl, position });
      },
      initialReadRetryDelays: [1_000],
    });
    await harness.begin();
    assert.equal(harness.time.pendingCount(), 1);

    harness.frameWindow.dispatch("wheel", { isTrusted: true });
    harness.application.pdfViewer.currentPageNumber = 6;
    harness.container.scrollTop = 660;
    harness.tracking.handoff();
    harness.tracking.handoff();

    assert.deepEqual(handoffs, [
      {
        fileUrl: BOOK_URL,
        position: { currentPage: 6, scrollTop: 660 },
      },
    ]);
    harness.tracking.destroy();
    assert.equal(harness.time.pendingCount(), 0);
  });

  await t.test("no intent or a programmatic default change sends nothing", async () => {
    for (const programmaticChange of [false, true]) {
      const bookRead = deferred();
      const handoffs = [];
      const harness = createPdfJsHarness({
        getBook: () => bookRead.promise,
        handoffPosition(...args) {
          handoffs.push(args);
        },
      });
      await harness.begin();
      if (programmaticChange) {
        harness.application.pdfViewer.currentPageNumber = 3;
        harness.container.scrollTop = 330;
        harness.eventBus.dispatch("pagechanging", {
          source: harness.application.pdfViewer,
        });
      }

      harness.tracking.handoff();
      harness.tracking.destroy();
      assert.deepEqual(handoffs, []);
      bookRead.resolve(undefined);
    }
  });

  await t.test("a resolved missing record retires intent without a handoff", async () => {
    const handoffs = [];
    const harness = createPdfJsHarness({
      getBook: async () => undefined,
      handoffPosition(...args) {
        handoffs.push(args);
      },
    });
    await harness.begin();
    await harness.tracking.settled();
    harness.frameWindow.dispatch("wheel", { isTrusted: true });
    harness.application.pdfViewer.currentPageNumber = 5;
    harness.container.scrollTop = 550;
    harness.eventBus.dispatch("pagechanging", {
      source: harness.application.pdfViewer,
    });

    harness.tracking.handoff();
    assert.deepEqual(handoffs, []);
    harness.tracking.destroy();
  });
});

test("restore lifecycle is retired on replacement without arming or handing off", async () => {
  const handoffs = [];
  const harness = createPdfJsHarness({
    handoffPosition(...args) {
      handoffs.push(args);
    },
  });
  await harness.begin();
  assert.equal(harness.frameWindow.listenerCount("wheel"), 1);
  harness.frameWindow.dispatch("wheel", { isTrusted: true });
  harness.application.pdfDocument = { id: "replacement", numPages: 2 };
  harness.eventBus.dispatch("pagesdestroy", { source: harness.application.pdfViewer });

  assert.equal(harness.frameWindow.listenerCount("wheel"), 0);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  assert.equal(harness.eventBus.listenerCount("pagerendered"), 0);
  harness.tracking.handoff();
  assert.deepEqual(handoffs, []);
  harness.tracking.destroy();
});

test("tracker arm is exact-once even if restore reports the handoff twice", async () => {
  let controllerCreations = 0;
  const harness = createPdfJsHarness({
    createSaveController(options) {
      controllerCreations += 1;
      return createPositionSaveController(options);
    },
    async restorePosition({ startTracking }) {
      const baseline = { currentPage: 1, scrollTop: 0 };
      startTracking(baseline, baseline);
      startTracking(baseline, baseline);
    },
  });

  await harness.ready();
  assert.equal(controllerCreations, 1);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  harness.tracking.destroy();
});

test("an early user action at tracker handoff is saved exactly once", async () => {
  const harness = createPdfJsHarness({
    getBook: async () => canonicalRecord({ currentPage: 4, scrollTop: 400 }),
    async restorePosition({ startTracking }) {
      startTracking(
        { currentPage: 4, scrollTop: 400 },
        { currentPage: 5, scrollTop: 550 },
      );
    },
  });

  await harness.ready();
  harness.time.advanceBy(951);
  assert.deepEqual(harness.calls, []);
  harness.time.advanceBy(1);
  await harness.tracking.settled();

  assert.deepEqual(harness.calls.map(({ position }) => position), [
    { currentPage: 5, scrollTop: 550 },
  ]);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  harness.tracking.destroy();
});

test("iframe initialization rejection is reported through the app-owned callback", async () => {
  const initializationError = new Error("PDF.js initialization failed");
  const harness = createPdfJsHarness();
  harness.frame.dispatch("load");
  harness.initialized.reject(initializationError);
  await harness.tracking.settled();

  assert.deepEqual(harness.errors, [initializationError]);
  harness.tracking.destroy();
});

test("a pending official PDF.js initialization capability times out visibly", async () => {
  const harness = createPdfJsHarness();
  harness.frame.dispatch("load");

  assert.equal(harness.time.pendingCount(), 1, "initialization must have an app-owned bound");
  harness.time.advanceBy(9_999);
  await drainMicrotasks();
  assert.deepEqual(harness.errors, []);
  harness.time.advanceBy(1);
  await harness.tracking.settled();

  assert.deepEqual(harness.errors.map((error) => error.message), [
    "PDF.js application initialization timed out.",
  ]);
  assert.equal(harness.time.pendingCount(), 0);
  assert.equal(harness.eventBus.listenerCount("pagesinit"), 0);
  assert.equal(harness.eventBus.listenerCount("pagerendered"), 0);
  harness.tracking.destroy();
});

test("pending initialization is cancelled safely on frame replacement and destroy", async () => {
  const harness = createPdfJsHarness();
  const staleInitialized = harness.initialized;
  const replacementInitialized = deferred();
  const replacementBus = new FakeEventBus();
  const replacementApplication = {
    ...harness.application,
    eventBus: replacementBus,
    initializedPromise: replacementInitialized.promise,
  };

  harness.frame.dispatch("load");
  assert.equal(harness.time.pendingCount(), 1);
  harness.frameWindow.PDFViewerApplication = replacementApplication;
  harness.frame.dispatch("load");
  assert.equal(harness.time.pendingCount(), 1, "replacement must cancel the stale timer");
  staleInitialized.resolve();
  await drainMicrotasks();
  assert.equal(harness.eventBus.listenerCount("pagesinit"), 0);
  assert.equal(replacementBus.listenerCount("pagesinit"), 0);

  harness.tracking.destroy();
  await harness.tracking.settled();
  assert.equal(harness.time.pendingCount(), 0);
  assert.equal(replacementBus.listenerCount("pagesinit"), 0);
  assert.deepEqual(harness.errors, []);
  replacementInitialized.resolve();
  await drainMicrotasks();
  assert.equal(replacementBus.listenerCount("pagesinit"), 0);
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
  assert.equal(harness.hostDocument.listenerCount("visibilitychange"), 0);
  harness.tracking.destroy();
});

test("pagehide hands off synchronously while hidden visibility uses the ordered save path", async () => {
  const handoffs = [];
  const harness = createPdfJsHarness({
    handoffPosition(fileUrl, position) {
      handoffs.push({ fileUrl, position });
    },
  });
  await harness.ready();

  harness.application.pdfViewer.currentPageNumber = 8;
  harness.container.scrollTop = 810;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.tracking.handoff();
  assert.deepEqual(handoffs, [
    {
      fileUrl: BOOK_URL,
      position: { currentPage: 8, scrollTop: 810 },
    },
  ]);
  assert.deepEqual(harness.calls, []);

  harness.application.pdfViewer.currentPageNumber = 9;
  harness.container.scrollTop = 920;
  harness.eventBus.dispatch("updateviewarea", { source: harness.application.pdfViewer });
  harness.hostDocument.visibilityState = "hidden";
  harness.hostDocument.dispatch("visibilitychange");
  await harness.tracking.settled();

  assert.deepEqual(harness.calls.map(({ position }) => position), [
    { currentPage: 9, scrollTop: 920 },
  ]);
  harness.tracking.destroy();
});

test("listeners are registered once and removed on teardown or document replacement", async () => {
  const harness = createPdfJsHarness();
  await harness.ready();

  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  assert.equal(harness.container.listenerCount("scroll"), 1);
  harness.application.pdfViewer.currentPageNumber = 10;
  harness.container.scrollTop = 1_000;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  const replacement = { id: "replacement", numPages: 2 };
  harness.application.pdfDocument = replacement;
  harness.eventBus.dispatch("pagesdestroy", { source: harness.application.pdfViewer });
  await Promise.resolve();
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  assert.equal(harness.container.listenerCount("scroll"), 0);
  assert.equal(harness.eventBus.listenerCount("pagesinit"), 0);
  harness.application.pdfViewer.currentPageNumber = 11;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.time.advanceBy(1_000);
  await harness.tracking.settled();
  assert.deepEqual(harness.calls, [], "document replacement must not save");

  harness.tracking.destroy();
  assert.equal(harness.frame.listenerCount("load"), 0);
  assert.equal(harness.hostDocument.listenerCount("visibilitychange"), 0);
});

test("pagehide handoff queues behind an older worker write and wins without a duplicate viewer writer", async () => {
  const firstWrite = deferred();
  const workerCalls = [];
  const completedPositions = [];
  const fake = createChromeStorageFake({
    books: { [BOOK_URL]: canonicalRecord() },
  });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
  });
  const handler = createPositionUpdateMessageHandler({
    extensionId: "abcdefghijkl",
    updatePosition: async (fileUrl, position) => {
      workerCalls.push({ fileUrl, position });
      if (workerCalls.length === 1) {
        await firstWrite.promise;
      }
      const updated = await storage.updatePosition(fileUrl, position);
      completedPositions.push(position);
      return updated;
    },
  });
  const bridge = createMessageBridge(handler);
  const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });
  const harness = createPdfJsHarness({
    handoffPosition: client.handoffPosition,
    updatePosition: client.updatePosition,
  });
  await harness.ready();

  harness.application.pdfViewer.currentPageNumber = 2;
  harness.container.scrollTop = 200;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.time.advanceBy(1_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(workerCalls.length, 1);

  harness.application.pdfViewer.currentPageNumber = 3;
  harness.container.scrollTop = 300;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.tracking.handoff();
  assert.equal(bridge.responses.length, 2, "handoff must call sendMessage before teardown");
  assert.deepEqual(bridge.keptAlive, [true, true]);
  harness.tracking.destroy();

  await drainMicrotasks();
  const positionsEnteredBeforeRelease = workerCalls.map(({ position }) => position);

  firstWrite.resolve();
  await Promise.all(bridge.responses);
  assert.deepEqual(
    positionsEnteredBeforeRelease,
    [{ currentPage: 2, scrollTop: 200 }],
    "the handoff must not enter storage while the older write is in flight",
  );
  assert.deepEqual(workerCalls.map(({ position }) => position), [
    { currentPage: 2, scrollTop: 200 },
    { currentPage: 3, scrollTop: 300 },
  ]);
  assert.deepEqual(completedPositions, [
    { currentPage: 2, scrollTop: 200 },
    { currentPage: 3, scrollTop: 300 },
  ]);
  assert.deepEqual(
    {
      currentPage: fake.snapshot().books[BOOK_URL].currentPage,
      scrollTop: fake.snapshot().books[BOOK_URL].scrollTop,
    },
    { currentPage: 3, scrollTop: 300 },
  );
});

test("worker messaging validates private canonical updates and never creates an untracked book", async () => {
  const fake = createChromeStorageFake();
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
  });
  let updateCalls = 0;
  const handler = createPositionUpdateMessageHandler({
    extensionId: "abcdefghijkl",
    updatePosition: async (...args) => {
      updateCalls += 1;
      return storage.updatePosition(...args);
    },
  });
  const bridge = createMessageBridge(handler);
  const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });

  assert.equal(
    await client.updatePosition(BOOK_URL, { currentPage: 2, scrollTop: 20 }),
    undefined,
  );
  assert.deepEqual(fake.snapshot(), {});
  assert.equal(updateCalls, 1);

  let sendCalls = 0;
  const rejectingClient = createPositionUpdateClient({
    sendMessage() {
      sendCalls += 1;
    },
  });
  await assert.rejects(
    rejectingClient.updatePosition(BOOK_URL, {
      currentPage: 2,
      scrollTop: 20,
      unexpected: true,
    }),
    /exactly the supported fields/i,
  );
  await assert.rejects(
    rejectingClient.updatePosition("file:///Users/reader/Books/A Book.pdf", {
      currentPage: 2,
      scrollTop: 20,
    }),
    /canonical/i,
  );
  assert.equal(sendCalls, 0);

  let invalidResponse;
  const keptInvalidChannel = handler(
    {
      type: "pdf-resume/private/update-position",
      fileUrl: "https://example.test/book.pdf",
      position: { currentPage: 2, scrollTop: 20 },
    },
    { id: "abcdefghijkl" },
    (response) => {
      invalidResponse = response;
    },
  );
  assert.equal(keptInvalidChannel, false);
  assert.deepEqual(invalidResponse, {
    type: "pdf-resume/private/update-position-result",
    status: "invalid",
  });
  assert.equal(updateCalls, 1);

  let privateResponse;
  assert.equal(
    handler(
      {
        type: "pdf-resume/private/update-position",
        fileUrl: BOOK_URL,
        position: { currentPage: 2, scrollTop: 20 },
      },
      { id: "another-extension" },
      (response) => {
        privateResponse = response;
      },
    ),
    false,
  );
  assert.equal(privateResponse.status, "invalid");
  assert.equal(updateCalls, 1);

  let unknownResponse = false;
  assert.equal(
    handler({ type: "other" }, { id: "abcdefghijkl" }, () => {
      unknownResponse = true;
    }),
    false,
  );
  assert.equal(unknownResponse, false);

  const failedHandoffs = [
    createPositionUpdateClient({
      sendMessage() {
        throw new Error("worker unavailable");
      },
    }),
    createPositionUpdateClient({
      async sendMessage() {
        throw new Error("worker stopped");
      },
    }),
  ];
  for (const failedClient of failedHandoffs) {
    assert.doesNotThrow(() =>
      failedClient.handoffPosition(BOOK_URL, {
        currentPage: 2,
        scrollTop: 20,
      }),
    );
  }
  await drainMicrotasks();
});

test("viewer rejects invalid input before checking local file access", async (t) => {
  const invalidInputs = [
    ["missing", ""],
    ["malformed", "?file=file:///tmp/book.pdf"],
    [
      "extra",
      `?file=${encodeURIComponent("file:///tmp/book.pdf")}&extra=1`,
    ],
    ["remote", `?file=${encodeURIComponent("https://example.test/book.pdf")}`],
    ["non-PDF", `?file=${encodeURIComponent("file:///tmp/book.txt")}`],
  ];

  for (const [name, search] of invalidInputs) {
    await t.test(name, async () => {
      const hostWindow = new FakeEventTarget();
      hostWindow.location = { search };
      const frame = new FakeEventTarget();
      frame.hidden = true;
      frame.src = "";
      const errorPanel = { hidden: true };
      const errorMessage = { textContent: "" };
      const fileAccessInstructions = { hidden: true };
      const warningPanel = { hidden: true };
      const warningMessage = { textContent: "" };
      const elements = new Map([
        ["#pdfViewer", frame],
        ["#viewerError", errorPanel],
        ["#viewerErrorMessage", errorMessage],
        ["#viewerFileAccessInstructions", fileAccessInstructions],
        ["#viewerWarning", warningPanel],
        ["#viewerWarningMessage", warningMessage],
      ]);
      const hostDocument = {
        querySelector: (selector) => elements.get(selector),
      };
      let fileSchemeAccessChecks = 0;

      const app = await startViewerApp({
        hostDocument,
        hostWindow,
        async isFileSchemeAccessAllowed() {
          fileSchemeAccessChecks += 1;
          return false;
        },
        fetchPdf: async () => assert.fail("invalid input must not be fetched"),
        createObjectUrl: () => assert.fail("invalid input must not create an object URL"),
        pdfJsViewerUrl: new URL(
          "chrome-extension://abcdefghijkl/viewer/pdfjs/web/viewer.html",
        ),
      });

      assert.equal(app, undefined);
      assert.equal(fileSchemeAccessChecks, 0);
      assert.equal(errorPanel.hidden, false);
      assert.equal(
        errorMessage.textContent,
        "Provide exactly one encoded local PDF URL as ?file=<encoded file:// URL>.",
      );
      assert.equal(fileAccessInstructions.hidden, true);
      assert.equal(frame.hidden, true);
      assert.equal(frame.src, "");
    });
  }
});

test("viewer explains how to enable local file access without starting the PDF", async () => {
  const hostWindow = new FakeEventTarget();
  hostWindow.location = { search: `?file=${encodeURIComponent(BOOK_URL)}` };
  const frame = new FakeEventTarget();
  frame.hidden = true;
  frame.src = "";
  const errorPanel = { hidden: true };
  const errorMessage = { textContent: "" };
  const fileAccessInstructions = { hidden: true };
  const warningPanel = { hidden: true };
  const warningMessage = { textContent: "" };
  const elements = new Map([
    ["#pdfViewer", frame],
    ["#viewerError", errorPanel],
    ["#viewerErrorMessage", errorMessage],
    ["#viewerFileAccessInstructions", fileAccessInstructions],
    ["#viewerWarning", warningPanel],
    ["#viewerWarningMessage", warningMessage],
  ]);
  const hostDocument = {
    querySelector: (selector) => elements.get(selector),
  };
  let fileSchemeAccessChecks = 0;

  const app = await startViewerApp({
    hostDocument,
    hostWindow,
    async isFileSchemeAccessAllowed() {
      fileSchemeAccessChecks += 1;
      return false;
    },
    fetchPdf: async () => assert.fail("a denied local PDF must not be fetched"),
    createObjectUrl: () =>
      assert.fail("a denied local PDF must not create an object URL"),
    pdfJsViewerUrl: new URL(
      "chrome-extension://abcdefghijkl/viewer/pdfjs/web/viewer.html",
    ),
  });

  assert.equal(app, undefined);
  assert.equal(fileSchemeAccessChecks, 1);
  assert.equal(fileAccessInstructions.hidden, false);
  assert.equal(errorPanel.hidden, true);
  assert.equal(errorMessage.textContent, "");
  assert.equal(frame.hidden, true);
  assert.equal(frame.src, "");
  assert.equal(frame.listenerCount("load"), 0);
});

test("production composition wires canonical boot, actual tracking, worker handoff, and teardown", async () => {
  const time = createFakeScheduler();
  const hostWindow = new FakeEventTarget();
  hostWindow.location = { search: "?file=ignored-by-injected-boot" };
  const hostDocument = new FakeEventTarget();
  hostDocument.visibilityState = "visible";
  const container = new FakeEventTarget();
  container.clientHeight = 600;
  container.scrollHeight = 4_000;
  container.scrollTop = 0;
  const eventBus = new FakeEventBus();
  const application = {
    appConfig: { mainContainer: container },
    eventBus,
    initializedPromise: Promise.resolve(),
    isInitialViewSet: true,
    pdfDocument: { id: "production-document", numPages: 20 },
    pdfViewer: {
      currentPageNumber: 1,
      getPageView() {
        return { renderingState: 3 };
      },
      pagesCount: 20,
      pagesPromise: Promise.resolve(),
    },
  };
  const frame = new FakeEventTarget();
  const frameWindow = new FakeEventTarget();
  frameWindow.PDFViewerApplication = application;
  frame.contentWindow = frameWindow;
  const errorPanel = {};
  const errorMessage = {};
  const fileAccessInstructions = {};
  const warningPanel = {};
  const warningMessage = {};
  hostDocument.querySelector = (selector) =>
    new Map([
      ["#pdfViewer", frame],
      ["#viewerError", errorPanel],
      ["#viewerErrorMessage", errorMessage],
      ["#viewerFileAccessInstructions", fileAccessInstructions],
      ["#viewerWarning", warningPanel],
      ["#viewerWarningMessage", warningMessage],
    ]).get(selector);
  const workerCalls = [];
  const handler = createPositionUpdateMessageHandler({
    extensionId: "abcdefghijkl",
    updatePosition: async (fileUrl, position) => {
      workerCalls.push({ fileUrl, position });
      return { ...canonicalRecord(), ...position };
    },
  });
  const bridge = createMessageBridge(handler);
  const revoked = [];
  const bootCalls = [];
  let getBookCalls = 0;

  const app = await startViewerApp({
    hostDocument,
    hostWindow,
    fetchPdf: async () => {},
    createObjectUrl: () => "unused",
    revokeObjectUrl(objectUrl) {
      revoked.push(objectUrl);
    },
    sendMessage: bridge.sendMessage,
    isFileSchemeAccessAllowed: async () => true,
    getBookOperation: async () => {
      getBookCalls += 1;
      return canonicalRecord();
    },
    bootViewerOperation: async (options) => {
      bootCalls.push(options);
      return { fileUrl: BOOK_URL, objectUrl: BLOB_URL };
    },
    createView: (elements) => elements,
    positionTrackingClock: time.clock,
    positionTrackingScheduler: time.scheduler,
  });

  assert.equal(bootCalls.length, 1);
  assert.equal(bootCalls[0].search, hostWindow.location.search);
  assert.deepEqual(bootCalls[0].view, {
    errorPanel,
    errorMessage,
    fileAccessInstructions,
    frame,
    warningPanel,
    warningMessage,
  });
  assert.equal(app.viewer.fileUrl, BOOK_URL);
  frame.dispatch("load");
  await drainMicrotasks();
  for (let turn = 0; turn < 5; turn += 1) {
    time.advanceBy(16);
    await drainMicrotasks();
  }
  assert.equal(getBookCalls, 2, "metadata and position lifecycles each verify tracking");
  assert.equal(eventBus.listenerCount("pagechanging"), 1);

  application.pdfViewer.currentPageNumber = 2;
  container.scrollTop = 200;
  hostDocument.visibilityState = "hidden";
  hostDocument.dispatch("visibilitychange");
  await app.positionTracking.settled();

  application.pdfViewer.currentPageNumber = 3;
  container.scrollTop = 300;
  hostWindow.dispatch("pagehide");
  await Promise.all(bridge.responses);
  assert.deepEqual(workerCalls.map(({ fileUrl, position }) => ({ fileUrl, position })), [
    { fileUrl: BOOK_URL, position: { currentPage: 2, scrollTop: 200 } },
    { fileUrl: BOOK_URL, position: { currentPage: 3, scrollTop: 300 } },
  ]);
  assert.deepEqual(revoked, [BLOB_URL]);
  assert.equal(frame.listenerCount("load"), 0);
  assert.equal(hostDocument.listenerCount("visibilitychange"), 0);
  assert.equal(hostWindow.listenerCount("pagehide"), 0);
  app.destroy();
  assert.deepEqual(revoked, [BLOB_URL]);
});

test("production composition reports metadata and restore failures independently", async () => {
  const metadataError = new Error("metadata write failed");
  const trackingError = new BooksStorageDataError("stored books are malformed");
  const warnings = [];
  const hostWindow = new FakeEventTarget();
  hostWindow.location = { search: "?file=ignored" };
  const hostDocument = new FakeEventTarget();
  const frame = new FakeEventTarget();
  const elements = new Map([
    ["#pdfViewer", frame],
    ["#viewerError", {}],
    ["#viewerErrorMessage", {}],
    ["#viewerWarning", {}],
    ["#viewerWarningMessage", {}],
  ]);
  hostDocument.querySelector = (selector) => elements.get(selector);
  let reportMetadataError;
  let reportTrackingError;

  const app = await startViewerApp({
    hostDocument,
    hostWindow,
    isFileSchemeAccessAllowed: async () => true,
    bootViewerOperation: async () => ({ fileUrl: BOOK_URL, objectUrl: BLOB_URL }),
    createMetadataHydration(options) {
      reportMetadataError = options.reportError;
      return { destroy() {} };
    },
    createPositionTracking(options) {
      reportTrackingError = options.reportError;
      return { destroy() {}, handoff() {} };
    },
    createView() {
      return {
        showWarning(message, error) {
          warnings.push({ error, message });
        },
      };
    },
    revokeObjectUrl() {},
  });

  reportMetadataError(metadataError);
  reportTrackingError(trackingError);
  assert.deepEqual(warnings, [
    {
      error: metadataError,
      message: "The book title and page count could not be saved. You can keep reading this PDF.",
    },
    {
      error: trackingError,
      message: "The saved reading position could not be restored. You can keep reading this PDF.",
    },
  ]);
  assert.equal(frame.hidden, undefined, "warning reporting must not hide the loaded PDF");
  app.destroy();
});

test("viewer entry can be imported without extension globals", async () => {
  await import(`../viewer/viewer-entry.mjs?test=${Date.now()}`);
});

test("actual tracking saves page 8 against stale total 7 without clobbering book state", async () => {
  const existing = canonicalRecord({ currentPage: 7, totalPages: 7 });
  const fake = createChromeStorageFake({ books: { [BOOK_URL]: existing } });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => 1_800_000_000,
  });
  const handler = createPositionUpdateMessageHandler({
    extensionId: "abcdefghijkl",
    updatePosition: storage.updatePosition,
  });
  const bridge = createMessageBridge(handler);
  const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });
  const { controller } = createController({
    initialPosition: existing,
    update: client.updatePosition,
  });

  controller.observe({ currentPage: 8, scrollTop: 808 });
  await controller.flush();

  assert.deepEqual(bridge.keptAlive, [true]);
  assert.deepEqual(fake.snapshot().books[BOOK_URL], {
    ...existing,
    currentPage: 8,
    scrollTop: 808,
    lastReadAt: 1_800_000_000,
  });
});
