import assert from "node:assert/strict";
import test from "node:test";

import {
  BooksStorageDataError,
  createBooksStorage,
} from "../storage/books.mjs";
import {
  createPositionObservationSource,
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
const OBSERVATION_START = 1_750_000_000_000;
const TEST_TRACKING_GENERATION = "0".repeat(32);

function registeredObservation(
  observation,
  trackingGeneration = TEST_TRACKING_GENERATION,
) {
  return { ...observation, intent: "registered", trackingGeneration };
}

function pendingObservation(observation) {
  return { ...observation, intent: "pending" };
}

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
  for (let turn = 0; turn < 10; turn += 1) {
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
  observationSource,
  retryDelaysMilliseconds,
  startTime = OBSERVATION_START,
  trackingGeneration = TEST_TRACKING_GENERATION,
  update,
} = {}) {
  const time = createFakeScheduler(startTime);
  const calls = [];
  const updateOperation =
    update ??
    (async (fileUrl, position) => {
      calls.push({ fileUrl, position });
      return { ...canonicalRecord(), ...position };
    });
  const controller = createPositionSaveController({
    fileUrl: BOOK_URL,
    initialPosition,
    recordObservation(fileUrl, position, observation) {
      return updateOperation(
        fileUrl,
        position,
        registeredObservation(observation, trackingGeneration),
      );
    },
    scheduler: time.scheduler,
    clock: time.clock,
    observationSource,
    retryDelaysMilliseconds,
  });
  return { calls, controller, time };
}

function createMessageBridge(handler, extensionId = "abcdefghijkl") {
  const keptAlive = [];
  const messages = [];
  const responses = [];
  return {
    keptAlive,
    messages,
    responses,
    sendMessage(message) {
      messages.push(structuredClone(message));
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
  clock,
  createRestoreLifecycle,
  createSaveController,
  getBook = async () => canonicalRecord(),
  getPositionTrackingState,
  initialReadRetryDelays,
  recordObservation,
  reportError,
  restorePosition,
} = {}) {
  const time = createFakeScheduler(OBSERVATION_START);
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
  const readPositionState =
    getPositionTrackingState ??
    (async (fileUrl) => {
      const book = await getBook(fileUrl);
      return book
        ? { book, trackingGeneration: TEST_TRACKING_GENERATION }
        : undefined;
    });
  const tracking = createPdfJsPositionTracking({
    fileUrl: BOOK_URL,
    frame,
    hostDocument,
    createRestoreLifecycle,
    createSaveController,
    getPositionTrackingState: readPositionState,
    initialReadRetryDelays,
    recordObservation:
      recordObservation ??
      (async (fileUrl, position) => {
        calls.push({ fileUrl, position });
        return { ...canonicalRecord(), ...position };
      }),
    reportError: reportError ?? ((error) => errors.push(error)),
    restorePosition,
    scheduler: time.scheduler,
    clock: clock ?? time.clock,
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

test("target page render failure warns and falls back to live position saving", async () => {
  const renderError = new Error("target canvas failed");
  const controllerBaselines = [];
  const harness = createPdfJsHarness({
    createSaveController(options) {
      controllerBaselines.push(options.initialPosition);
      return createPositionSaveController(options);
    },
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
  assert.deepEqual(controllerBaselines, [{ currentPage: 6, scrollTop: 0 }]);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  assert.equal(harness.hostDocument.listenerCount("visibilitychange"), 1);
  harness.time.advanceBy(1_000);
  await harness.tracking.settled();
  assert.deepEqual(harness.calls, [], "restore failure alone must not overwrite storage");

  harness.application.pdfViewer.currentPageNumber = 7;
  harness.container.scrollTop = 700;
  harness.container.dispatch("scroll");
  harness.time.advanceBy(1_000);
  await harness.tracking.settled();
  harness.application.pdfViewer.currentPageNumber = 8;
  harness.container.scrollTop = 810;
  harness.eventBus.dispatch("updateviewarea", {
    source: harness.application.pdfViewer,
  });
  harness.hostDocument.visibilityState = "hidden";
  harness.hostDocument.dispatch("visibilitychange");
  await harness.tracking.settled();

  assert.deepEqual(harness.calls.map(({ position }) => position), [
    { currentPage: 7, scrollTop: 700 },
    { currentPage: 8, scrollTop: 810 },
  ]);
  assert.equal(controllerBaselines.length, 1, "fallback tracking must arm once");
  harness.tracking.destroy();
});

test("a cached FINISHED target render error warns and falls back to tracking", async () => {
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
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);
  assert.equal(harness.hostDocument.listenerCount("visibilitychange"), 1);
  harness.time.advanceBy(1_000);
  await harness.tracking.settled();
  assert.deepEqual(harness.calls, [], "fallback arming must preserve the saved record");
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
    recordObservation(fileUrl, position) {
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
      recordObservation(fileUrl, position, observation) {
        handoffs.push({ fileUrl, observation, position });
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
    const observedAt = harness.time.clock.now();
    harness.time.advanceBy(500);

    harness.tracking.handoff();
    harness.tracking.handoff();
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].fileUrl, BOOK_URL);
    assert.deepEqual(handoffs[0].position, {
      currentPage: 5,
      scrollTop: 550,
    });
    assert.match(handoffs[0].observation.viewerId, /^[0-9a-f]{32}$/);
    assert.equal(handoffs[0].observation.sequence, 2);
    assert.equal(
      handoffs[0].observation.observedAt,
      observedAt,
      "pagehide must retain interaction time rather than assign teardown time",
    );
    harness.tracking.destroy();
  });

  await t.test("programmatic default change", async () => {
    const handoffs = [];
    const harness = createPdfJsHarness({
      getBook: async () => canonicalRecord({ currentPage: 4, scrollTop: 400 }),
      recordObservation(...args) {
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
      recordObservation(...args) {
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

test("pagehide pending handoff is restricted to an in-flight viewer registration", async (t) => {
  await t.test("deferred successful registration retains one genuine snapshot", async () => {
    const existing = canonicalRecord();
    const fake = createChromeStorageFake({
      books: { [BOOK_URL]: existing },
      positionOrder: {
        [BOOK_URL]: {
          version: 2,
          generation: TEST_TRACKING_GENERATION,
          winner: null,
          viewers: {},
        },
      },
    });
    const registrationWrite = fake.holdNext("set", { after: true });
    const storage = createBooksStorage({
      storageArea: fake.local,
      lockManager: fake.locks,
    });
    const handler = createPositionUpdateMessageHandler({
      extensionId: "abcdefghijkl",
      recordObservation: storage.recordObservation,
    });
    const bridge = createMessageBridge(handler);
    const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });
    const harness = createPdfJsHarness({
      getPositionTrackingState: storage.getPositionTrackingState,
      recordObservation: client.recordObservation,
    });
    await harness.begin();
    await registrationWrite.started;
    const registeredViewer = Object.keys(
      fake.snapshot().positionOrder[BOOK_URL].viewers,
    )[0];

    harness.frameWindow.dispatch("keydown", { isTrusted: true });
    harness.application.pdfViewer.currentPageNumber = 5;
    harness.container.scrollTop = 550;
    harness.eventBus.dispatch("pagechanging", {
      source: harness.application.pdfViewer,
    });
    harness.tracking.handoff();
    harness.tracking.handoff();
    await drainMicrotasks();
    const responsesBeforeRelease = bridge.responses.length;
    const messagesBeforeRelease = structuredClone(bridge.messages);
    const bookBeforeRelease = fake.snapshot().books[BOOK_URL];
    harness.tracking.destroy();

    registrationWrite.release();
    const responses = await Promise.all(bridge.responses);
    await harness.tracking.settled();

    assert.equal(responsesBeforeRelease, 1, "pagehide must synchronously reach the worker");
    assert.equal(messagesBeforeRelease.length, 1, "the snapshot must be handed off exactly once");
    assert.deepEqual(bookBeforeRelease, existing, "the handoff must queue behind registration");
    assert.equal(
      messagesBeforeRelease[0].type,
      "pdf-resume/private/record-observation",
    );
    assert.equal(messagesBeforeRelease[0].observation.intent, "pending");
    assert.equal(messagesBeforeRelease[0].observation.viewerId, registeredViewer);
    assert.equal(
      Object.hasOwn(messagesBeforeRelease[0].observation, "trackingGeneration"),
      false,
    );
    assert.deepEqual(responses, [
      {
        type: "pdf-resume/private/update-position-result",
        status: "updated",
      },
    ]);
    assert.deepEqual(fake.snapshot().books[BOOK_URL], {
      ...existing,
      currentPage: 5,
      scrollTop: 550,
      lastReadAt: Math.floor(OBSERVATION_START / 1_000),
    });
    assert.equal(harness.frameWindow.listenerCount("keydown"), 0);
  });

  await t.test("genuine activity during a scheduled read retry sends nothing", async () => {
    const handoffs = [];
    const recordHandoff = (fileUrl, position) => {
      handoffs.push({ fileUrl, position });
    };
    const harness = createPdfJsHarness({
      getBook: async () => {
        throw new Error("storage temporarily unavailable");
      },
      recordObservation: recordHandoff,
      initialReadRetryDelays: [1_000],
    });
    await harness.begin();
    assert.equal(harness.time.pendingCount(), 1);

    harness.frameWindow.dispatch("wheel", { isTrusted: true });
    harness.application.pdfViewer.currentPageNumber = 6;
    harness.container.scrollTop = 660;
    harness.tracking.handoff();
    harness.tracking.handoff();

    assert.deepEqual(handoffs, []);
    harness.tracking.destroy();
    assert.equal(harness.time.pendingCount(), 0);
  });

  await t.test("no intent or a programmatic default change sends nothing", async () => {
    for (const programmaticChange of [false, true]) {
      const bookRead = deferred();
      const handoffs = [];
      const recordHandoff = (...args) => handoffs.push(args);
      const harness = createPdfJsHarness({
        getBook: () => bookRead.promise,
        recordObservation: recordHandoff,
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
    const recordHandoff = (...args) => handoffs.push(args);
    const harness = createPdfJsHarness({
      getBook: async () => undefined,
      recordObservation: recordHandoff,
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
    recordObservation(...args) {
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

test("a stale restore rejection cannot arm fallback tracking", async () => {
  const restore = deferred();
  let controllerCreations = 0;
  const harness = createPdfJsHarness({
    createSaveController(options) {
      controllerCreations += 1;
      return createPositionSaveController(options);
    },
    restorePosition: () => restore.promise,
  });
  await harness.begin();
  harness.application.pdfDocument = { id: "replacement", numPages: 2 };
  harness.eventBus.dispatch("pagesdestroy", { source: harness.application.pdfViewer });
  restore.reject(new Error("retired restore failed"));
  await harness.tracking.settled();

  assert.deepEqual(harness.errors, []);
  assert.equal(controllerCreations, 0);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  assert.equal(harness.hostDocument.listenerCount("visibilitychange"), 0);
  harness.tracking.destroy();
});

test("restore rejection preserves boundary activity for immediate pagehide handoff", async () => {
  const restoreError = new Error("restore failed after user navigation");
  const controllerBaselines = [];
  const handoffs = [];
  let harness;
  harness = createPdfJsHarness({
    createSaveController(options) {
      controllerBaselines.push(options.initialPosition);
      return createPositionSaveController(options);
    },
    getBook: async () => canonicalRecord({ currentPage: 4, scrollTop: 400 }),
    recordObservation(fileUrl, position, observation) {
      handoffs.push({ fileUrl, observation, position });
    },
    async restorePosition({ application, container, eventBus }) {
      harness.frameWindow.dispatch("wheel", { isTrusted: true });
      application.pdfViewer.currentPageNumber = 5;
      container.scrollTop = 550;
      eventBus.dispatch("updateviewarea", { source: application.pdfViewer });
      throw restoreError;
    },
  });

  await harness.begin();
  await harness.tracking.settled();
  harness.tracking.handoff();
  harness.tracking.destroy();

  assert.deepEqual(harness.errors, [restoreError]);
  assert.deepEqual(controllerBaselines, [{ currentPage: 4, scrollTop: 400 }]);
  assert.deepEqual(
    handoffs.map(({ fileUrl, position }) => ({ fileUrl, position })),
    [
      {
        fileUrl: BOOK_URL,
        position: { currentPage: 5, scrollTop: 550 },
      },
    ],
  );
  assert.equal(handoffs[0].observation.sequence, 2);
  assert.deepEqual(harness.calls, []);
});

test("restore rejection flushes boundary activity once on immediate replacement", async () => {
  const restoreError = new Error("restore failed after user scroll");
  let harness;
  harness = createPdfJsHarness({
    getBook: async () => canonicalRecord({ currentPage: 4, scrollTop: 400 }),
    async restorePosition({ application, container, eventBus }) {
      harness.frameWindow.dispatch("wheel", { isTrusted: true });
      application.pdfViewer.currentPageNumber = 5;
      container.scrollTop = 550;
      eventBus.dispatch("updateviewarea", { source: application.pdfViewer });
      throw restoreError;
    },
  });

  await harness.begin();
  await harness.tracking.settled();
  harness.eventBus.dispatch("pagesdestroy", {
    source: harness.application.pdfViewer,
  });
  await harness.tracking.settled();

  assert.deepEqual(harness.errors, [restoreError]);
  assert.deepEqual(harness.calls.map(({ position }) => position), [
    { currentPage: 5, scrollTop: 550 },
  ]);
  assert.equal(harness.time.pendingCount(), 0);
  harness.tracking.destroy();
});

test("restore rejection does not persist restore-owned movement", async () => {
  const restoreError = new Error("restore failed after programmatic movement");
  const handoffs = [];
  const harness = createPdfJsHarness({
    getBook: async () => canonicalRecord({ currentPage: 4, scrollTop: 400 }),
    recordObservation(...args) {
      handoffs.push(args);
    },
    async restorePosition({ application, container, eventBus }) {
      application.pdfViewer.currentPageNumber = 6;
      container.scrollTop = 660;
      eventBus.dispatch("pagechanging", { source: application.pdfViewer });
      container.dispatch("scroll");
      eventBus.dispatch("updateviewarea", { source: application.pdfViewer });
      throw restoreError;
    },
  });

  await harness.begin();
  await harness.tracking.settled();
  harness.tracking.handoff();
  harness.eventBus.dispatch("pagesdestroy", {
    source: harness.application.pdfViewer,
  });
  await harness.tracking.settled();

  assert.deepEqual(harness.errors, [restoreError]);
  assert.deepEqual(handoffs, []);
  assert.deepEqual(harness.calls, []);
  assert.equal(harness.time.pendingCount(), 0);
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
  const saves = [];
  const harness = createPdfJsHarness({
    recordObservation(fileUrl, position, observation, { handoff = false } = {}) {
      (handoff ? handoffs : saves).push({ fileUrl, observation, position });
      return handoff ? undefined : Promise.resolve(position);
    },
  });
  await harness.ready();

  harness.application.pdfViewer.currentPageNumber = 8;
  harness.container.scrollTop = 810;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.tracking.handoff();
  assert.deepEqual(
    handoffs.map(({ fileUrl, position }) => ({ fileUrl, position })),
    [
      {
        fileUrl: BOOK_URL,
        position: { currentPage: 8, scrollTop: 810 },
      },
    ],
  );
  assert.deepEqual(harness.calls, []);

  harness.application.pdfViewer.currentPageNumber = 9;
  harness.container.scrollTop = 920;
  harness.eventBus.dispatch("updateviewarea", { source: harness.application.pdfViewer });
  harness.hostDocument.visibilityState = "hidden";
  harness.hostDocument.dispatch("visibilitychange");
  await harness.tracking.settled();

  assert.deepEqual(handoffs.map(({ position }) => position), [
    { currentPage: 8, scrollTop: 810 },
  ]);
  assert.deepEqual(saves.map(({ position }) => position), [
    { currentPage: 9, scrollTop: 920 },
  ]);
  harness.tracking.destroy();
});

test("pagesdestroy retirement preserves a failed flush through its scheduled retry", async () => {
  const attempts = [];
  const harness = createPdfJsHarness({
    async recordObservation(fileUrl, position, observation) {
      attempts.push({ fileUrl, observation, position });
      if (attempts.length === 1) {
        throw new Error("storage temporarily unavailable");
      }
      return { ...canonicalRecord(), ...position };
    },
  });
  await harness.ready();

  harness.application.pdfViewer.currentPageNumber = 10;
  harness.container.scrollTop = 1_000;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.eventBus.dispatch("pagesdestroy", { source: harness.application.pdfViewer });
  await drainMicrotasks();

  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  assert.equal(harness.eventBus.listenerCount("updateviewarea"), 0);
  assert.equal(harness.container.listenerCount("scroll"), 0);
  assert.equal(harness.hostDocument.listenerCount("visibilitychange"), 0);
  assert.equal(attempts.length, 1);
  assert.equal(harness.time.pendingCount(), 1);

  harness.time.advanceBy(249);
  assert.equal(attempts.length, 1, "retirement must honor the configured delay");
  harness.time.advanceBy(1);
  await harness.tracking.settled();

  assert.deepEqual(
    attempts.map(({ position }) => position),
    [
      { currentPage: 10, scrollTop: 1_000 },
      { currentPage: 10, scrollTop: 1_000 },
    ],
  );
  assert.deepEqual(
    attempts[0].observation,
    attempts[1].observation,
    "the scheduled retry must retain the original observation order",
  );
  assert.equal(harness.time.pendingCount(), 0);
  harness.tracking.destroy();
});

test(
  "pagesdestroy retirement remains bounded across wall-clock rollback",
  { timeout: 1_000 },
  async () => {
    const attempts = [];
    let controllerDestroys = 0;
    let wallTime = OBSERVATION_START;
    const harness = createPdfJsHarness({
      clock: { now: () => wallTime },
      createSaveController(options) {
        const controller = createPositionSaveController(options);
        return Object.freeze({
          ...controller,
          destroy() {
            controllerDestroys += 1;
            controller.destroy();
          },
        });
      },
      async recordObservation(fileUrl, position, observation) {
        attempts.push({ fileUrl, observation, position });
        throw new Error("storage unavailable");
      },
    });
    await harness.ready();

    harness.application.pdfViewer.currentPageNumber = 10;
    harness.container.scrollTop = 1_000;
    harness.eventBus.dispatch("updateviewarea", {
      source: harness.application.pdfViewer,
    });
    harness.eventBus.dispatch("pagesdestroy", {
      source: harness.application.pdfViewer,
    });
    await drainMicrotasks();
    assert.equal(attempts.length, 1);

    wallTime -= 60_000;
    for (const [index, delay] of [250, 1_000, 4_000].entries()) {
      harness.time.advanceBy(delay);
      await drainMicrotasks();
      assert.equal(
        attempts.length,
        index + 2,
        `retry ${index + 1} must run after its scheduler delay`,
      );
    }
    await harness.tracking.settled();

    assert.equal(controllerDestroys, 1);
    assert.equal(harness.time.pendingCount(), 0);
    assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
    assert.equal(harness.container.listenerCount("scroll"), 0);
    assert.equal(
      attempts.every(
        ({ observation }) => observation.observedAt === OBSERVATION_START,
      ),
      true,
      "retry timing must not replace the original observation timestamp",
    );
    assert.deepEqual(
      attempts.map(({ observation }) => observation),
      Array.from({ length: 4 }, () => attempts[0].observation),
    );

    harness.tracking.destroy();
    assert.equal(controllerDestroys, 1);
  },
);

test("pagesdestroy retirement exhausts bounded retries and releases its controller", async () => {
  const attempts = [];
  let controllerCreations = 0;
  let controllerDestroys = 0;
  const harness = createPdfJsHarness({
    createSaveController(options) {
      controllerCreations += 1;
      const controller = createPositionSaveController(options);
      return Object.freeze({
        ...controller,
        destroy() {
          controllerDestroys += 1;
          controller.destroy();
        },
      });
    },
    async recordObservation(fileUrl, position, observation) {
      attempts.push({ fileUrl, observation, position });
      throw new Error("storage unavailable");
    },
  });
  await harness.ready();

  harness.application.pdfViewer.currentPageNumber = 10;
  harness.container.scrollTop = 1_000;
  harness.eventBus.dispatch("updateviewarea", {
    source: harness.application.pdfViewer,
  });
  harness.eventBus.dispatch("pagesdestroy", { source: harness.application.pdfViewer });
  await drainMicrotasks();

  assert.equal(attempts.length, 1);
  for (const delay of [250, 1_000, 4_000]) {
    harness.time.advanceBy(delay);
    await drainMicrotasks();
  }
  await harness.tracking.settled();

  assert.equal(attempts.length, 4);
  assert.equal(harness.time.pendingCount(), 0);
  assert.equal(controllerCreations, 1);
  assert.equal(controllerDestroys, 1, "the exhausted controller must leave retirement");
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  assert.equal(harness.container.listenerCount("scroll"), 0);

  harness.tracking.destroy();
  assert.equal(controllerDestroys, 1, "full destroy must not retain or destroy it twice");
});

test(
  "full destroy bounds an in-flight pagesdestroy retirement",
  { timeout: 1_000 },
  async () => {
    const retirementWrite = deferred();
    const harness = createPdfJsHarness({
      recordObservation: () => retirementWrite.promise,
    });
    await harness.ready();

    harness.application.pdfViewer.currentPageNumber = 10;
    harness.container.scrollTop = 1_000;
    harness.eventBus.dispatch("pagechanging", {
      source: harness.application.pdfViewer,
    });
    harness.eventBus.dispatch("pagesdestroy", {
      source: harness.application.pdfViewer,
    });
    await drainMicrotasks();

    let didSettle = false;
    const settlement = harness.tracking.settled().then(() => {
      didSettle = true;
    });
    await drainMicrotasks();
    assert.equal(didSettle, false);

    harness.tracking.destroy();
    await settlement;
    assert.equal(didSettle, true, "full destroy must bound retirement settlement");
    assert.equal(harness.time.pendingCount(), 0);
    assert.equal(harness.frame.listenerCount("load"), 0);
    assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
    assert.equal(harness.container.listenerCount("scroll"), 0);

    retirementWrite.reject(new Error("late storage failure"));
    await settlement;
    await drainMicrotasks();
    assert.equal(
      harness.time.pendingCount(),
      0,
      "a late failure must not restart retries",
    );
  },
);

test("replacement events enter only the new controller while the old controller retires", async () => {
  const attempts = [];
  let controllerCreations = 0;
  const harness = createPdfJsHarness({
    createSaveController(options) {
      controllerCreations += 1;
      return createPositionSaveController(options);
    },
    async restorePosition({ application, container, startTracking }) {
      const currentPosition = {
        currentPage: application.pdfViewer.currentPageNumber,
        scrollTop: container.scrollTop,
      };
      startTracking(currentPosition, currentPosition);
    },
    async recordObservation(fileUrl, position, observation) {
      attempts.push({ fileUrl, observation, position });
      if (attempts.length === 1) {
        throw new Error("storage temporarily unavailable");
      }
      return { ...canonicalRecord(), ...position };
    },
  });
  await harness.ready();

  harness.application.pdfViewer.currentPageNumber = 10;
  harness.container.scrollTop = 1_000;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.eventBus.dispatch("pagesdestroy", { source: harness.application.pdfViewer });
  await drainMicrotasks();
  assert.equal(attempts.length, 1);
  assert.equal(harness.time.pendingCount(), 1);

  harness.application.pdfViewer.currentPageNumber = 11;
  harness.container.scrollTop = 1_100;
  harness.eventBus.dispatch("pagechanging", { source: harness.application.pdfViewer });
  harness.eventBus.dispatch("updateviewarea", { source: harness.application.pdfViewer });
  harness.container.dispatch("scroll");
  harness.hostDocument.visibilityState = "hidden";
  harness.hostDocument.dispatch("visibilitychange");
  await drainMicrotasks();
  assert.equal(attempts.length, 1, "retired-document events must not be observed");

  const replacement = { id: "replacement", numPages: 2 };
  harness.application.pdfDocument = replacement;
  harness.application.pdfViewer.pagesCount = 2;
  harness.hostDocument.visibilityState = "visible";
  harness.frame.dispatch("load");
  await drainMicrotasks();
  await harness.finishRestore();
  assert.equal(controllerCreations, 2);
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 1);

  harness.application.pdfViewer.currentPageNumber = 2;
  harness.container.scrollTop = 200;
  harness.eventBus.dispatch("updateviewarea", {
    source: harness.application.pdfViewer,
  });
  harness.hostDocument.visibilityState = "hidden";
  harness.hostDocument.dispatch("visibilitychange");
  await drainMicrotasks();
  assert.deepEqual(
    attempts.map(({ position }) => position),
    [
      { currentPage: 10, scrollTop: 1_000 },
      { currentPage: 2, scrollTop: 200 },
    ],
  );

  harness.time.advanceBy(250);
  await harness.tracking.settled();
  assert.deepEqual(
    attempts.map(({ position }) => position),
    [
      { currentPage: 10, scrollTop: 1_000 },
      { currentPage: 2, scrollTop: 200 },
      { currentPage: 10, scrollTop: 1_000 },
    ],
  );
  assert.deepEqual(attempts[0].observation, attempts[2].observation);
  assert.notDeepEqual(
    attempts[1].observation,
    attempts[0].observation,
    "the replacement controller must own an independent observation",
  );
  assert.equal(harness.time.pendingCount(), 0);

  harness.tracking.destroy();
  assert.equal(harness.eventBus.listenerCount("pagechanging"), 0);
  assert.equal(harness.container.listenerCount("scroll"), 0);
});

test("an older observation delayed in one viewer cannot overwrite a newer viewer", async () => {
  const fake = createChromeStorageFake({
    books: { [BOOK_URL]: canonicalRecord() },
  });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => 1_800_000_000,
  });
  const handler = createPositionUpdateMessageHandler({
    extensionId: "abcdefghijkl",
    recordObservation: storage.recordObservation,
  });
  const bridge = createMessageBridge(handler);
  const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });
  const viewerA = createController({ update: client.recordObservation });
  const viewerB = createController({ update: client.recordObservation });

  viewerA.controller.observe({ currentPage: 2, scrollTop: 200 });
  viewerB.time.advanceBy(100);
  viewerB.controller.observe({ currentPage: 3, scrollTop: 300 });
  await viewerB.controller.flush();
  viewerA.time.advanceBy(1_000);
  await viewerA.controller.settled();

  assert.deepEqual(
    {
      currentPage: fake.snapshot().books[BOOK_URL].currentPage,
      scrollTop: fake.snapshot().books[BOOK_URL].scrollTop,
    },
    { currentPage: 3, scrollTop: 300 },
  );

  viewerA.controller.observe({ currentPage: 1, scrollTop: 50 });
  await viewerA.controller.flush();
  assert.deepEqual(
    {
      currentPage: fake.snapshot().books[BOOK_URL].currentPage,
      scrollTop: fake.snapshot().books[BOOK_URL].scrollTop,
    },
    { currentPage: 1, scrollTop: 50 },
    "a chronologically later backward navigation must win",
  );
});

test("an older failed observation keeps its order through retry and cannot regress another viewer", async () => {
  const fake = createChromeStorageFake({
    books: { [BOOK_URL]: canonicalRecord() },
  });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => 1_800_000_000,
  });
  let firstAttempt = true;
  const handler = createPositionUpdateMessageHandler({
    extensionId: "abcdefghijkl",
    async recordObservation(...args) {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("worker write failed");
      }
      return storage.recordObservation(...args);
    },
  });
  const bridge = createMessageBridge(handler);
  const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });
  const viewerA = createController({ update: client.recordObservation });
  const viewerB = createController({ update: client.recordObservation });

  viewerA.controller.observe({ currentPage: 2, scrollTop: 200 });
  viewerA.time.advanceBy(1_000);
  assert.deepEqual(await viewerA.controller.settled(), {
    disabled: false,
    durable: false,
    pending: true,
    retryPending: true,
  });

  viewerB.time.advanceBy(2_000);
  viewerB.controller.observe({ currentPage: 4, scrollTop: 400 });
  await viewerB.controller.flush();
  viewerA.time.advanceBy(250);
  await viewerA.controller.settled();

  assert.deepEqual(
    {
      currentPage: fake.snapshot().books[BOOK_URL].currentPage,
      scrollTop: fake.snapshot().books[BOOK_URL].scrollTop,
    },
    { currentPage: 4, scrollTop: 400 },
  );
  assert.deepEqual(
    bridge.messages[0].observation,
    bridge.messages[2].observation,
    "retry must retain the original observation order",
  );
  assert.equal(
    bridge.messages[0].observation.trackingGeneration,
    bridge.messages[2].observation.trackingGeneration,
    "retry must retain the original tracking generation",
  );
});

test("same-viewer sequence orders equal-time messages independently of receipt", async () => {
  const fake = createChromeStorageFake({
    books: { [BOOK_URL]: canonicalRecord() },
  });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => 1_800_000_000,
  });
  const handler = createPositionUpdateMessageHandler({
    extensionId: "abcdefghijkl",
    recordObservation: storage.recordObservation,
  });
  const viewerId = "a".repeat(32);
  const older = {
    type: "pdf-resume/private/record-observation",
    fileUrl: BOOK_URL,
    position: { currentPage: 4, scrollTop: 400 },
    observation: registeredObservation({
      viewerId,
      sequence: 1,
      observedAt: OBSERVATION_START,
    }),
  };
  const newer = {
    type: "pdf-resume/private/record-observation",
    fileUrl: BOOK_URL,
    position: { currentPage: 5, scrollTop: 500 },
    observation: registeredObservation({
      viewerId,
      sequence: 2,
      observedAt: OBSERVATION_START,
    }),
  };
  const bridge = createMessageBridge(handler);

  await bridge.sendMessage(newer);
  assert.deepEqual(await bridge.sendMessage(older), {
    type: "pdf-resume/private/update-position-result",
    status: "stale",
  });
  assert.deepEqual(
    {
      currentPage: fake.snapshot().books[BOOK_URL].currentPage,
      scrollTop: fake.snapshot().books[BOOK_URL].scrollTop,
    },
    { currentPage: 5, scrollTop: 500 },
  );
});

test("same-viewer sequence wins across wall-clock rollback before and after worker restart", async () => {
  const fake = createChromeStorageFake({
    books: { [BOOK_URL]: canonicalRecord() },
  });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => 1_800_000_000,
  });
  const viewerId = "e".repeat(32);
  const createWorker = () =>
    createMessageBridge(
      createPositionUpdateMessageHandler({
        extensionId: "abcdefghijkl",
        recordObservation: storage.recordObservation,
        now: () => OBSERVATION_START + 10_000,
      }),
    );
  const message = (currentPage, sequence, observedAt) => ({
    type: "pdf-resume/private/record-observation",
    fileUrl: BOOK_URL,
    position: { currentPage, scrollTop: currentPage * 100 },
    observation: registeredObservation({ viewerId, sequence, observedAt }),
  });
  const firstWorker = createWorker();

  assert.equal(
    (await firstWorker.sendMessage(message(4, 10, OBSERVATION_START + 5_000)))
      .status,
    "updated",
  );
  assert.equal(
    (await firstWorker.sendMessage(message(5, 11, OBSERVATION_START + 4_000)))
      .status,
    "updated",
  );
  assert.equal(
    (await firstWorker.sendMessage(message(2, 10, OBSERVATION_START + 6_000)))
      .status,
    "stale",
  );
  assert.equal(fake.snapshot().books[BOOK_URL].lastReadAt, 1_750_000_005);

  const restartedWorker = createWorker();
  assert.equal(
    (await restartedWorker.sendMessage(message(6, 12, OBSERVATION_START + 3_000)))
      .status,
    "updated",
  );
  const afterRollback = fake.snapshot();
  assert.deepEqual(
    {
      currentPage: afterRollback.books[BOOK_URL].currentPage,
      lastReadAt: afterRollback.books[BOOK_URL].lastReadAt,
      scrollTop: afterRollback.books[BOOK_URL].scrollTop,
    },
    { currentPage: 6, lastReadAt: 1_750_000_005, scrollTop: 600 },
  );
  assert.equal(
    (await restartedWorker.sendMessage(message(7, 12, OBSERVATION_START + 7_000)))
      .status,
    "stale",
  );
  assert.equal(
    (await restartedWorker.sendMessage(message(8, 11, OBSERVATION_START + 8_000)))
      .status,
    "stale",
  );
  assert.deepEqual(fake.snapshot(), afterRollback);
});

test("a higher known-viewer sequence survives receiver clock rollback while an unknown future viewer is invalid", async () => {
  let receiverNow = 100_000;
  const fake = createChromeStorageFake({
    books: {
      [BOOK_URL]: canonicalRecord({ addedAt: 0, lastReadAt: 0 }),
    },
  });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => Math.floor(receiverNow / 1_000),
    nowMilliseconds: () => receiverNow,
  });
  const bridge = createMessageBridge(
    createPositionUpdateMessageHandler({
      extensionId: "abcdefghijkl",
      recordObservation: storage.recordObservation,
      now: () => receiverNow,
    }),
  );
  const viewerId = "1".repeat(32);
  const message = (currentPage, sequence, observedAt, messageViewerId = viewerId) => ({
    type: "pdf-resume/private/record-observation",
    fileUrl: BOOK_URL,
    position: { currentPage, scrollTop: currentPage * 100 },
    observation: registeredObservation({
      viewerId: messageViewerId,
      sequence,
      observedAt,
    }),
  });

  assert.equal((await bridge.sendMessage(message(10, 10, 100_000))).status, "updated");
  receiverNow = 40_000;
  assert.equal((await bridge.sendMessage(message(11, 11, 101_000))).status, "updated");
  const afterKnownViewer = fake.snapshot();
  assert.equal(afterKnownViewer.books[BOOK_URL].currentPage, 11);

  assert.equal(
    (await bridge.sendMessage(message(12, 1, 101_000, "2".repeat(32)))).status,
    "invalid",
  );
  assert.deepEqual(fake.snapshot(), afterKnownViewer);
});

test("a fresh registered viewer's first save survives receiver clock rollback", async () => {
  let receiverSeconds = 100;
  const fake = createChromeStorageFake();
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => receiverSeconds,
    nowMilliseconds: () => receiverSeconds * 1_000,
  });
  await storage.trackBook(BOOK_URL, { title: "A Book" });
  const viewerId = "2".repeat(32);
  const trackingState = await storage.getPositionTrackingState(
    BOOK_URL,
    viewerId,
  );
  receiverSeconds = 40;

  const handler = createPositionUpdateMessageHandler({
    extensionId: "abcdefghijkl",
    recordObservation: storage.recordObservation,
  });
  const bridge = createMessageBridge(handler);
  const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });
  const observationSource = createPositionObservationSource({
    clock: { now: () => 40_000 },
    viewerId,
  });
  const { controller } = createController({
    initialPosition: trackingState.book,
    observationSource,
    trackingGeneration: trackingState.trackingGeneration,
    update: client.recordObservation,
  });

  controller.observe({ currentPage: 2, scrollTop: 200 });
  await controller.flush();

  assert.deepEqual(await bridge.responses[0], {
    type: "pdf-resume/private/update-position-result",
    status: "updated",
  });
  assert.deepEqual(
    {
      currentPage: fake.snapshot().books[BOOK_URL].currentPage,
      lastReadAt: fake.snapshot().books[BOOK_URL].lastReadAt,
      scrollTop: fake.snapshot().books[BOOK_URL].scrollTop,
    },
    { currentPage: 2, lastReadAt: 100, scrollTop: 200 },
  );
  controller.destroy();
});

test("durable per-viewer order makes the rollback A/B/A cycle stale after restart", async () => {
  const fake = createChromeStorageFake({
    books: {
      [BOOK_URL]: canonicalRecord({ addedAt: 0, lastReadAt: 0 }),
    },
  });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => 2_000,
  });
  const createWorker = () =>
    createMessageBridge(
      createPositionUpdateMessageHandler({
        extensionId: "abcdefghijkl",
        recordObservation: storage.recordObservation,
        now: () => 2_000_000,
      }),
    );
  const message = (viewerId, sequence, observedAt, currentPage) => ({
    type: "pdf-resume/private/record-observation",
    fileUrl: BOOK_URL,
    position: { currentPage, scrollTop: currentPage * 100 },
    observation: registeredObservation({ viewerId, sequence, observedAt }),
  });
  const viewerA = "a".repeat(32);
  const viewerB = "b".repeat(32);
  const firstWorker = createWorker();

  assert.equal(
    (await firstWorker.sendMessage(message(viewerA, 10, 1_005_000, 10))).status,
    "updated",
  );
  assert.equal(
    (await firstWorker.sendMessage(message(viewerA, 11, 1_004_000, 11))).status,
    "updated",
  );
  assert.equal(
    (await firstWorker.sendMessage(message(viewerB, 1, 1_004_500, 20))).status,
    "stale",
  );
  const beforeDuplicate = fake.snapshot();

  const restartedWorker = createWorker();
  assert.equal(
    (await restartedWorker.sendMessage(message(viewerA, 10, 1_005_000, 2))).status,
    "stale",
  );
  assert.deepEqual(fake.snapshot(), beforeDuplicate);
  assert.equal(fake.snapshot().books[BOOK_URL].currentPage, 11);
});

test("lower and duplicate viewer sequences stay stale after other viewers and restarts", async () => {
  const fake = createChromeStorageFake({
    books: {
      [BOOK_URL]: canonicalRecord({ addedAt: 0, lastReadAt: 0 }),
    },
  });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => 2_000,
    nowMilliseconds: () => 2_000_000,
  });
  const createWorker = () =>
    createMessageBridge(
      createPositionUpdateMessageHandler({
        extensionId: "abcdefghijkl",
        recordObservation: storage.recordObservation,
      }),
    );
  const message = (viewerId, sequence, observedAt, currentPage) => ({
    type: "pdf-resume/private/record-observation",
    fileUrl: BOOK_URL,
    position: { currentPage, scrollTop: currentPage * 100 },
    observation: registeredObservation({ viewerId, sequence, observedAt }),
  });
  const viewerA = "3".repeat(32);
  const firstWorker = createWorker();

  assert.equal(
    (await firstWorker.sendMessage(message(viewerA, 5, 1_000_000, 5))).status,
    "updated",
  );
  assert.equal(
    (
      await firstWorker.sendMessage(
        message("4".repeat(32), 1, 1_001_000, 10),
      )
    ).status,
    "updated",
  );
  assert.equal(
    (
      await firstWorker.sendMessage(
        message("5".repeat(32), 1, 1_002_000, 20),
      )
    ).status,
    "updated",
  );
  const beforeDelayedA = fake.snapshot();
  const writesBeforeDelayedA = fake.operations.filter(
    ({ method, phase }) => method === "set" && phase === "start",
  ).length;

  const restartedWorker = createWorker();
  assert.equal(
    (await restartedWorker.sendMessage(message(viewerA, 5, 1_003_000, 2)))
      .status,
    "stale",
  );
  assert.equal(
    (await restartedWorker.sendMessage(message(viewerA, 4, 1_004_000, 3)))
      .status,
    "stale",
  );
  assert.deepEqual(fake.snapshot(), beforeDelayedA);
  assert.equal(fake.snapshot().books[BOOK_URL].currentPage, 20);
  assert.equal(
    fake.operations.filter(
      ({ method, phase }) => method === "set" && phase === "start",
    ).length,
    writesBeforeDelayedA,
  );
});

test("worker restart retains the full durable observation order within one second", async () => {
  const fake = createChromeStorageFake({
    books: { [BOOK_URL]: canonicalRecord() },
  });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => 1_800_000_000,
  });
  const createHandler = () =>
    createPositionUpdateMessageHandler({
      extensionId: "abcdefghijkl",
      recordObservation: storage.recordObservation,
      now: () => OBSERVATION_START + 10_000,
    });
  const durableObservation = OBSERVATION_START + 2_100;
  const firstWorker = createMessageBridge(createHandler());
  await firstWorker.sendMessage({
    type: "pdf-resume/private/record-observation",
    fileUrl: BOOK_URL,
    position: { currentPage: 8, scrollTop: 800 },
    observation: registeredObservation({
      viewerId: "b".repeat(32),
      sequence: 1,
      observedAt: durableObservation,
    }),
  });

  const writesBeforeRestart = fake.operations.filter(
    ({ method, phase }) => method === "set" && phase === "start",
  ).length;
  const restartedWorker = createMessageBridge(createHandler());
  assert.deepEqual(
    await restartedWorker.sendMessage({
      type: "pdf-resume/private/record-observation",
      fileUrl: BOOK_URL,
      position: { currentPage: 2, scrollTop: 200 },
      observation: registeredObservation({
        viewerId: "a".repeat(32),
        sequence: 1,
        observedAt: OBSERVATION_START + 2_000,
      }),
    }),
    {
      type: "pdf-resume/private/update-position-result",
      status: "stale",
    },
  );
  assert.equal(
    fake.operations.filter(
      ({ method, phase }) => method === "set" && phase === "start",
    ).length,
    writesBeforeRestart + 1,
    "a losing new viewer persists its high-water mark without changing the book",
  );
  assert.equal(fake.snapshot().books[BOOK_URL].currentPage, 8);
  assert.deepEqual(fake.snapshot().positionOrder[BOOK_URL], {
    version: 2,
    generation: TEST_TRACKING_GENERATION,
    winner: {
      effectiveTime: durableObservation,
      viewerId: "b".repeat(32),
      sequence: 1,
    },
    viewers: {
      ["a".repeat(32)]: {
        effectiveTime: OBSERVATION_START + 2_000,
        sequence: 1,
      },
      ["b".repeat(32)]: {
        effectiveTime: durableObservation,
        sequence: 1,
      },
    },
  });

  await restartedWorker.sendMessage({
    type: "pdf-resume/private/record-observation",
    fileUrl: BOOK_URL,
    position: { currentPage: 3, scrollTop: 300 },
    observation: registeredObservation({
      viewerId: "c".repeat(32),
      sequence: 1,
      observedAt: OBSERVATION_START + 2_900,
    }),
  });
  assert.deepEqual(
    {
      currentPage: fake.snapshot().books[BOOK_URL].currentPage,
      lastReadAt: fake.snapshot().books[BOOK_URL].lastReadAt,
      scrollTop: fake.snapshot().books[BOOK_URL].scrollTop,
    },
    {
      currentPage: 3,
      lastReadAt: Math.floor(durableObservation / 1_000),
      scrollTop: 300,
    },
    "a newer same-second observation after restart remains eligible",
  );
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
    recordObservation: async (...args) => {
      const [fileUrl, position, observation] = args;
      workerCalls.push({ fileUrl, observation, position });
      if (workerCalls.length === 1) {
        await firstWrite.promise;
      }
      const status = await storage.recordObservation(...args);
      completedPositions.push(position);
      return status;
    },
  });
  const bridge = createMessageBridge(handler);
  const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });
  const harness = createPdfJsHarness({
    recordObservation: client.recordObservation,
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
  assert.equal(
    bridge.messages[0].observation.viewerId,
    bridge.messages[1].observation.viewerId,
  );
  assert.equal(
    bridge.messages[0].observation.sequence <
      bridge.messages[1].observation.sequence,
    true,
  );
  assert.equal(
    bridge.messages[0].observation.observedAt <
      bridge.messages[1].observation.observedAt,
    true,
  );
  assert.deepEqual(
    {
      currentPage: fake.snapshot().books[BOOK_URL].currentPage,
      scrollTop: fake.snapshot().books[BOOK_URL].scrollTop,
    },
    { currentPage: 3, scrollTop: 300 },
  );
});

test("pagehide hands off a return to the durable baseline over an older in-flight save", async () => {
  const firstWrite = deferred();
  const workerCalls = [];
  const fake = createChromeStorageFake({
    books: { [BOOK_URL]: canonicalRecord() },
  });
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
  });
  const handler = createPositionUpdateMessageHandler({
    extensionId: "abcdefghijkl",
    recordObservation: async (...args) => {
      const [fileUrl, position, observation] = args;
      workerCalls.push({ fileUrl, observation, position });
      if (workerCalls.length === 1) {
        await firstWrite.promise;
      }
      return storage.recordObservation(...args);
    },
  });
  const bridge = createMessageBridge(handler);
  const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });
  const harness = createPdfJsHarness({
    recordObservation: client.recordObservation,
  });
  await harness.ready();

  harness.application.pdfViewer.currentPageNumber = 2;
  harness.container.scrollTop = 200;
  harness.eventBus.dispatch("pagechanging", {
    source: harness.application.pdfViewer,
  });
  harness.time.advanceBy(1_000);
  await drainMicrotasks();
  assert.equal(workerCalls.length, 1);

  harness.application.pdfViewer.currentPageNumber = 1;
  harness.container.scrollTop = 0;
  harness.eventBus.dispatch("pagechanging", {
    source: harness.application.pdfViewer,
  });
  harness.tracking.handoff();
  assert.equal(bridge.responses.length, 2);
  assert.deepEqual(bridge.messages.map(({ position }) => position), [
    { currentPage: 2, scrollTop: 200 },
    { currentPage: 1, scrollTop: 0 },
  ]);
  assert.equal(
    bridge.messages[1].observation.sequence >
      bridge.messages[0].observation.sequence,
    true,
  );
  harness.tracking.destroy();

  firstWrite.resolve();
  await Promise.all(bridge.responses);
  assert.deepEqual(
    {
      currentPage: fake.snapshot().books[BOOK_URL].currentPage,
      scrollTop: fake.snapshot().books[BOOK_URL].scrollTop,
    },
    { currentPage: 1, scrollTop: 0 },
  );
});

test("a durable baseline with no older pending save emits no handoff", async () => {
  const { controller } = createController();

  assert.equal(
    controller.prepareHandoff({ currentPage: 1, scrollTop: 0 }),
    undefined,
  );
  controller.destroy();
});

test("worker messaging rejects missing and unknown observation intents", () => {
  let recordCalls = 0;
  const handler = createPositionUpdateMessageHandler({
    extensionId: "abcdefghijkl",
    async recordObservation() {
      recordCalls += 1;
      return "updated";
    },
  });

  for (const intent of [undefined, "unknown"]) {
    let response;
    assert.equal(
      handler(
        {
          type: "pdf-resume/private/record-observation",
          fileUrl: BOOK_URL,
          position: { currentPage: 2, scrollTop: 20 },
          observation: {
            viewerId: "d".repeat(32),
            sequence: 1,
            observedAt: OBSERVATION_START,
            ...(intent === undefined ? {} : { intent }),
          },
        },
        { id: "abcdefghijkl" },
        (result) => {
          response = result;
        },
      ),
      false,
    );
    assert.deepEqual(response, {
      type: "pdf-resume/private/update-position-result",
      status: "invalid",
    });
  }
  assert.equal(recordCalls, 0);
});

test("worker messaging validates private canonical updates and never creates an untracked book", async () => {
  const fake = createChromeStorageFake();
  const storage = createBooksStorage({
    storageArea: fake.local,
    lockManager: fake.locks,
    now: () => Math.floor(OBSERVATION_START / 1_000),
  });
  let pendingUpdateCalls = 0;
  let updateCalls = 0;
  const handler = createPositionUpdateMessageHandler({
    extensionId: "abcdefghijkl",
    async recordObservation(...args) {
      if (args[2].intent === "pending") {
        pendingUpdateCalls += 1;
      } else {
        updateCalls += 1;
      }
      return storage.recordObservation(...args);
    },
  });
  const bridge = createMessageBridge(handler);
  const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });
  const observations = createPositionObservationSource({
    clock: { now: () => OBSERVATION_START },
    viewerId: "d".repeat(32),
  });
  const firstObservation = observations.next();

  assert.equal(
    await client.recordObservation(
      BOOK_URL,
      { currentPage: 2, scrollTop: 20 },
      registeredObservation(firstObservation),
    ),
    undefined,
  );
  assert.deepEqual(fake.snapshot(), {});
  assert.equal(updateCalls, 1);
  assert.deepEqual(
    await bridge.sendMessage({
      type: "pdf-resume/private/record-observation",
      fileUrl: BOOK_URL,
      position: { currentPage: 2, scrollTop: 20 },
      observation: pendingObservation(firstObservation),
    }),
    {
      type: "pdf-resume/private/update-position-result",
      status: "missing",
    },
  );
  assert.equal(pendingUpdateCalls, 1);
  assert.deepEqual(fake.snapshot(), {});

  let sendCalls = 0;
  const rejectingClient = createPositionUpdateClient({
    sendMessage() {
      sendCalls += 1;
    },
  });
  await assert.rejects(
    rejectingClient.recordObservation(
      BOOK_URL,
      {
        currentPage: 2,
        scrollTop: 20,
        unexpected: true,
      },
      registeredObservation(firstObservation),
    ),
    /exactly the supported fields/i,
  );
  await assert.rejects(
    rejectingClient.recordObservation(
      "file:///Users/reader/Books/A Book.pdf",
      { currentPage: 2, scrollTop: 20 },
      registeredObservation(firstObservation),
    ),
    /canonical/i,
  );
  for (const invalidObservation of [
    undefined,
    {},
    firstObservation,
    registeredObservation({ ...firstObservation, viewerId: "not-an-id" }),
    registeredObservation({ ...firstObservation, sequence: 0 }),
    registeredObservation({ ...firstObservation, observedAt: 1.5 }),
    { ...registeredObservation(firstObservation), extra: true },
    { ...firstObservation, intent: "registered" },
    { ...pendingObservation(firstObservation), trackingGeneration: TEST_TRACKING_GENERATION },
  ]) {
    await assert.rejects(
      rejectingClient.recordObservation(
        BOOK_URL,
        { currentPage: 2, scrollTop: 20 },
        invalidObservation,
      ),
      /position observation|tracking generation/i,
    );
  }
  assert.equal(sendCalls, 0);

  const invalidMessages = [
    {
      type: "pdf-resume/private/record-observation",
      fileUrl: "https://example.test/book.pdf",
      position: { currentPage: 2, scrollTop: 20 },
      observation: registeredObservation(firstObservation),
    },
    {
      type: "pdf-resume/private/record-observation",
      fileUrl: BOOK_URL,
      position: { currentPage: 2, scrollTop: 20 },
      observation: firstObservation,
    },
    {
      type: "pdf-resume/private/record-observation",
      fileUrl: BOOK_URL,
      position: { currentPage: 2, scrollTop: 20 },
      observation: registeredObservation(firstObservation),
      extra: true,
    },
    {
      type: "pdf-resume/private/record-observation",
      fileUrl: BOOK_URL,
      position: { currentPage: 2, scrollTop: 20 },
      observation: registeredObservation(
        firstObservation,
        "not-a-generation",
      ),
    },
    {
      type: "pdf-resume/private/record-observation",
      fileUrl: BOOK_URL,
      position: { currentPage: 2, scrollTop: 20 },
      observation: {
        ...pendingObservation(firstObservation),
        trackingGeneration: TEST_TRACKING_GENERATION,
      },
    },
    {
      type: "pdf-resume/private/record-observation",
      fileUrl: "https://example.test/book.pdf",
      position: { currentPage: 2, scrollTop: 20 },
      observation: pendingObservation(firstObservation),
    },
  ];
  for (const message of invalidMessages) {
    let invalidResponse;
    assert.equal(
      handler(message, { id: "abcdefghijkl" }, (response) => {
        invalidResponse = response;
      }),
      false,
    );
    assert.deepEqual(invalidResponse, {
      type: "pdf-resume/private/update-position-result",
      status: "invalid",
    });
  }
  assert.equal(pendingUpdateCalls, 1);
  assert.equal(updateCalls, 1);
  assert.equal(Object.hasOwn(fake.snapshot(), "positionOrder"), false);

  await storage.trackBook(BOOK_URL, { title: "A Book" });
  const beforeUnregisteredHandoff = fake.snapshot();
  assert.deepEqual(
    await bridge.sendMessage({
      type: "pdf-resume/private/record-observation",
      fileUrl: BOOK_URL,
      position: { currentPage: 9, scrollTop: 90 },
      observation: pendingObservation(firstObservation),
    }),
    {
      type: "pdf-resume/private/update-position-result",
      status: "stale",
    },
  );
  assert.equal(pendingUpdateCalls, 2);
  assert.deepEqual(fake.snapshot(), beforeUnregisteredHandoff);

  const trackingState = await storage.getPositionTrackingState(
    BOOK_URL,
    observations.viewerId,
  );
  assert.deepEqual(
    await client.recordObservation(
      BOOK_URL,
      { currentPage: 3, scrollTop: 30 },
      registeredObservation(
        observations.next(),
        trackingState.trackingGeneration,
      ),
    ),
    { currentPage: 3, scrollTop: 30 },
    "invalid and missing updates must not poison a later retrack",
  );
  assert.equal(updateCalls, 2);
  assert.deepEqual(fake.snapshot().positionOrder[BOOK_URL], {
    version: 2,
    generation: trackingState.trackingGeneration,
    winner: {
      effectiveTime: OBSERVATION_START,
      viewerId: firstObservation.viewerId,
      sequence: 2,
    },
    viewers: {
      [firstObservation.viewerId]: {
        effectiveTime: OBSERVATION_START,
        sequence: 2,
      },
    },
  });

  let privateResponse;
  assert.equal(
    handler(
      {
        type: "pdf-resume/private/record-observation",
        fileUrl: BOOK_URL,
        position: { currentPage: 2, scrollTop: 20 },
        observation: registeredObservation(
          firstObservation,
          trackingState.trackingGeneration,
        ),
      },
      { id: "another-extension" },
      (response) => {
        privateResponse = response;
      },
    ),
    false,
  );
  assert.equal(privateResponse.status, "invalid");
  assert.equal(updateCalls, 2);

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
      failedClient.recordObservation(
        BOOK_URL,
        { currentPage: 2, scrollTop: 20 },
        pendingObservation(firstObservation),
        { handoff: true },
      ),
    );
    assert.doesNotThrow(() =>
      failedClient.recordObservation(
        BOOK_URL,
        { currentPage: 2, scrollTop: 20 },
        registeredObservation(firstObservation),
        { handoff: true },
      ),
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

test("post-boot startup failures clean every acquired viewer resource", async (t) => {
  const startupErrorMessage =
    "The PDF viewer could not be initialized. Reload this page to try again.";
  const stages = [
    {
      expectedMetadataDestroys: 0,
      expectedTrackingDestroys: 0,
      name: "position update client validation",
      configure({ options }) {
        options.sendMessage = null;
      },
    },
    {
      expectedMetadataDestroys: 0,
      expectedTrackingDestroys: 0,
      name: "metadata lifecycle creation",
      configure({ failure, options }) {
        options.createMetadataHydration = () => {
          throw failure;
        };
      },
    },
    {
      expectedMetadataDestroys: 1,
      expectedTrackingDestroys: 0,
      name: "position tracking creation",
      configure({ failure, options }) {
        options.createPositionTracking = () => {
          throw failure;
        };
      },
    },
    {
      expectedMetadataDestroys: 1,
      expectedTrackingDestroys: 1,
      name: "pagehide registration",
      configure({ failure, hostWindow }) {
        const addEventListener = hostWindow.addEventListener.bind(hostWindow);
        hostWindow.addEventListener = (type, listener) => {
          addEventListener(type, listener);
          if (type === "pagehide") {
            throw failure;
          }
        };
      },
    },
  ];

  for (const stage of stages) {
    await t.test(stage.name, async () => {
      const failure = new Error(`${stage.name} failed`);
      const hostWindow = new FakeEventTarget();
      hostWindow.location = { search: "?file=ignored-by-injected-boot" };
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
      let metadataDestroys = 0;
      let trackingDestroys = 0;
      let trackingHandoffs = 0;
      const revoked = [];
      const options = {
        hostDocument,
        hostWindow,
        sendMessage() {},
        async bootViewerOperation({ view }) {
          view.showViewer(
            new URL(
              "chrome-extension://abcdefghijkl/viewer/pdfjs/web/viewer.html?file=blob%3Atest",
            ),
          );
          return { fileUrl: BOOK_URL, objectUrl: BLOB_URL };
        },
        createMetadataHydration() {
          return {
            destroy() {
              metadataDestroys += 1;
            },
          };
        },
        createPositionTracking() {
          return {
            destroy() {
              trackingDestroys += 1;
            },
            handoff() {
              trackingHandoffs += 1;
            },
          };
        },
        revokeObjectUrl(objectUrl) {
          revoked.push(objectUrl);
        },
      };
      stage.configure({ failure, hostWindow, options });

      if (stage.name === "position update client validation") {
        await assert.rejects(() => startViewerApp(options), /sendMessage must be a function/);
      } else {
        await assert.rejects(() => startViewerApp(options), failure);
      }

      assert.equal(metadataDestroys, stage.expectedMetadataDestroys);
      assert.equal(trackingDestroys, stage.expectedTrackingDestroys);
      assert.deepEqual(revoked, [BLOB_URL]);
      assert.equal(hostWindow.listenerCount("pagehide"), 0);
      assert.equal(frame.hidden, true);
      assert.equal(errorPanel.hidden, false);
      assert.equal(errorMessage.textContent, startupErrorMessage);

      hostWindow.dispatch("pagehide");
      assert.equal(metadataDestroys, stage.expectedMetadataDestroys);
      assert.equal(trackingDestroys, stage.expectedTrackingDestroys);
      assert.equal(trackingHandoffs, 0);
      assert.deepEqual(revoked, [BLOB_URL]);
    });
  }
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
    recordObservation: async (fileUrl, position) => {
      workerCalls.push({ fileUrl, position });
      return "updated";
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
    getPositionTrackingStateOperation: async () => {
      getBookCalls += 1;
      return {
        book: canonicalRecord(),
        trackingGeneration: TEST_TRACKING_GENERATION,
      };
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
    recordObservation: storage.recordObservation,
  });
  const bridge = createMessageBridge(handler);
  const client = createPositionUpdateClient({ sendMessage: bridge.sendMessage });
  const { controller } = createController({
    initialPosition: existing,
    update: client.recordObservation,
  });

  controller.observe({ currentPage: 8, scrollTop: 808 });
  await controller.flush();

  assert.deepEqual(bridge.keptAlive, [true]);
  assert.deepEqual(fake.snapshot().books[BOOK_URL], {
    ...existing,
    currentPage: 8,
    scrollTop: 808,
    lastReadAt: Math.floor(OBSERVATION_START / 1_000),
  });
});
